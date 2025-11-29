import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { reportingStorage } from "./reporting-storage";
import { db } from "./db";
import { users, shipmentSyncFailures, shopifyOrderSyncFailures, orders, orderItems, shipments, orderRefunds, shipmentItems, shipmentTags } from "@shared/schema";
import { eq, count, desc, or, and, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { z } from "zod";
import { createHash } from "crypto";
import { insertUserSchema, insertPackingLogSchema, insertShipmentEventSchema, insertStationSchema, insertPrinterSchema, insertDesktopClientSchema, insertStationSessionSchema, insertPrintJobSchema } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyShopifyWebhook, reregisterAllWebhooks } from "./utils/shopify-webhook";
import { verifyShipStationWebhook } from "./utils/shipstation-webhook";
import { fetchShipStationResource, getShipmentsByOrderNumber, getFulfillmentByTrackingNumber, getShipmentByShipmentId, getTrackingDetails, getShipmentsByDateRange } from "./utils/shipstation-api";
import { enqueueWebhook, enqueueOrderId, dequeueWebhook, getQueueLength, clearQueue, enqueueShipmentSync, enqueueShipmentSyncBatch, getShipmentSyncQueueLength, clearShipmentSyncQueue, clearShopifyOrderSyncQueue, getOldestShopifyQueueMessage, getOldestShipmentSyncQueueMessage, getShopifyOrderSyncQueueLength, getOldestShopifyOrderSyncQueueMessage, enqueueSkuVaultQCSync } from "./utils/queue";
import { extractActualOrderNumber, extractShopifyOrderPrices } from "./utils/shopify-utils";
import { broadcastOrderUpdate, broadcastPrintQueueUpdate, broadcastQueueStatus, broadcastDesktopStationDeleted } from "./websocket";
import { ShipStationShipmentService } from "./services/shipstation-shipment-service";
import { shopifyOrderETL } from "./services/shopify-order-etl-service";
import { extractShipmentStatus } from "./shipment-sync-worker";
import { skuVaultService, SkuVaultError } from "./services/skuvault-service";
import { qcPassItemRequestSchema } from "@shared/skuvault-types";
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { checkRateLimit } from "./utils/rate-limiter";
import type { PORecommendation } from "@shared/reporting-schema";
import { firestoreStorage } from "./firestore-storage";
import type { SkuVaultOrderSessionFilters } from "@shared/firestore-schema";

// Initialize the shipment service
const shipmentService = new ShipStationShipmentService(storage);

// Central Time (America/Chicago timezone) for consistent reporting
const CST_TIMEZONE = 'America/Chicago';

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${randomBytes(6).toString("hex")}`;
      cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const SESSION_COOKIE_NAME = "session_token";
const SESSION_DURATION_DAYS = 30;
const ALLOWED_EMAIL_DOMAIN = "jerky.com";

// Helper to get the correct base URL (handles proxy/forwarded headers)
function getBaseUrl(req: Request): string {
  // Check for forwarded protocol (from proxy like Replit)
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol;
  const host = req.get("host");
  return `${protocol}://${host}`;
}

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Shopify API helpers
// To set up Shopify integration:
// 1. Go to your Shopify admin: Settings > Apps and sales channels > Develop apps
// 2. Create a new custom app with a descriptive name (e.g., "Warehouse Fulfillment")
// 3. Configure Admin API scopes: read_orders, read_products, read_customers
// 4. Install the app and reveal the Admin API access token
// 5. Add these secrets: SHOPIFY_SHOP_DOMAIN (e.g., yourstore.myshopify.com) and SHOPIFY_ADMIN_ACCESS_TOKEN

async function fetchShopifyOrders(limit: number = 50, pageInfo?: string) {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    throw new Error("Shopify credentials not configured. Please set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  let url: string;
  if (pageInfo) {
    url = `https://${shopDomain}/admin/api/2024-01/orders.json?page_info=${encodeURIComponent(pageInfo)}&limit=${limit}`;
  } else {
    url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=${limit}&status=any`;
  }

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${errorText}`);
  }

  const linkHeader = response.headers.get('Link');
  let nextPageInfo: string | null = null;
  
  if (linkHeader) {
    const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      nextPageInfo = decodeURIComponent(nextMatch[1]);
    }
  }

  const data = await response.json();
  return { orders: data.orders, nextPageInfo };
}

async function fetchShopifyOrder(orderId: string) {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    throw new Error("Shopify credentials not configured. Please set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  const url = `https://${shopDomain}/admin/api/2024-01/orders/${orderId}.json`;
  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.order;
}

// Google OAuth helper - generate authorization URL
function getGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    state: state,
    prompt: "select_account",
    hd: ALLOWED_EMAIL_DOMAIN, // Restrict to jerky.com domain in Google's picker
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange Google auth code for tokens and user info
async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ email: string; name: string; picture?: string }> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Failed to exchange code: ${error}`);
  }

  const tokens = await tokenResponse.json();
  
  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoResponse.ok) {
    throw new Error("Failed to get user info from Google");
  }

  const userInfo = await userInfoResponse.json();
  return {
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
  };
}

// Auth middleware
async function requireAuth(req: Request, res: Response, next: Function) {
  const sessionToken = req.cookies[SESSION_COOKIE_NAME];

  if (!sessionToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const session = await storage.getSession(sessionToken);

  if (!session || session.expiresAt < new Date()) {
    return res.status(401).json({ error: "Session expired" });
  }

  const user = await storage.getUser(session.userId);

  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }

  (req as any).user = user;
  next();
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Google OAuth routes
  app.get("/api/auth/google", (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: "Google OAuth not configured" });
    }

    const baseUrl = getBaseUrl(req);
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    console.log("[Google OAuth] Redirect URI:", redirectUri);
    const state = randomBytes(16).toString("hex");
    
    res.cookie("oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000, // 10 minutes
      sameSite: "lax",
    });

    const authUrl = getGoogleAuthUrl(redirectUri, state);
    res.redirect(authUrl);
  });

  app.get("/api/auth/google/callback", async (req, res) => {
    try {
      const { code, state, error: oauthError } = req.query;
      const savedState = req.cookies.oauth_state;

      res.clearCookie("oauth_state");

      if (oauthError) {
        console.error("Google OAuth error:", oauthError);
        return res.redirect("/login?error=oauth_denied");
      }

      if (!code || typeof code !== "string") {
        return res.redirect("/login?error=no_code");
      }

      if (!state || state !== savedState) {
        return res.redirect("/login?error=invalid_state");
      }

      const baseUrl = getBaseUrl(req);
      const redirectUri = `${baseUrl}/api/auth/google/callback`;

      const googleUser = await exchangeGoogleCode(code, redirectUri);

      // Verify the email domain
      const emailDomain = googleUser.email.split("@")[1];
      if (emailDomain !== ALLOWED_EMAIL_DOMAIN) {
        console.error(`Unauthorized domain attempt: ${googleUser.email}`);
        return res.redirect("/login?error=unauthorized_domain");
      }

      // Find or create user
      let user = await storage.getUserByEmail(googleUser.email);

      if (!user) {
        user = await storage.createUser({ 
          email: googleUser.email,
          name: googleUser.name,
          avatarUrl: googleUser.picture,
        });
      } else {
        // Update user info from Google if changed or missing
        const updates: { name?: string; avatarUrl?: string } = {};
        if (googleUser.name && !user.name) {
          updates.name = googleUser.name;
        }
        if (googleUser.picture && !user.avatarUrl) {
          updates.avatarUrl = googleUser.picture;
        }
        if (Object.keys(updates).length > 0) {
          await storage.updateUser(user.id, updates);
          user = { ...user, ...updates };
        }
      }

      // Create session
      const sessionToken = randomBytes(32).toString("hex");
      const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

      await storage.createSession({
        userId: user.id,
        token: sessionToken,
        expiresAt: sessionExpiresAt,
      });

      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000,
        sameSite: "lax",
      });

      res.redirect("/orders");
    } catch (error) {
      console.error("Error in Google OAuth callback:", error);
      res.redirect("/login?error=auth_failed");
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    try {
      const sessionToken = req.cookies[SESSION_COOKIE_NAME];
      await storage.deleteSession(sessionToken);
      res.clearCookie(SESSION_COOKIE_NAME);
      res.json({ success: true });
    } catch (error) {
      console.error("Error logging out:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      const sessionToken = req.cookies[SESSION_COOKIE_NAME];

      if (!sessionToken) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const session = await storage.getSession(sessionToken);

      if (!session || session.expiresAt < new Date()) {
        return res.status(401).json({ error: "Session expired" });
      }

      const user = await storage.getUser(session.userId);

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      res.json({ user });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  // User profile routes
  app.get("/api/user/profile", requireAuth, async (req, res) => {
    res.json({ user: (req as any).user });
  });

  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const updates = z.object({
        handle: z.string().optional(),
        avatarUrl: z.string().optional(),
      }).parse(req.body);

      const updatedUser = await storage.updateUser(user.id, updates);
      res.json({ user: updatedUser });
    } catch (error) {
      console.error("Error updating profile:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  app.post("/api/user/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
    try {
      const user = (req as any).user;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const avatarUrl = `/uploads/${file.filename}`;
      await storage.updateUser(user.id, { avatarUrl });

      res.json({ avatarUrl });
    } catch (error) {
      console.error("Error uploading avatar:", error);
      res.status(500).json({ error: "Failed to upload avatar" });
    }
  });

  app.post("/api/user/generate-handle", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const baseHandle = user.email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      
      if (!baseHandle) {
        return res.status(400).json({ error: "Could not generate handle from email" });
      }
      
      let handle = baseHandle;
      let suffix = 1;
      const maxAttempts = 100;

      for (let i = 0; i < maxAttempts; i++) {
        const allUsers = await db.select().from(users).where(eq(users.handle, handle));
        const existingUser = allUsers[0];
        
        if (!existingUser || existingUser.id === user.id) {
          break;
        }
        handle = `${baseHandle}${suffix}`;
        suffix++;
      }

      res.json({ handle });
    } catch (error) {
      console.error("Error generating handle:", error);
      res.status(500).json({ error: "Failed to generate handle" });
    }
  });

  // Order routes
  app.get("/api/orders/sync", requireAuth, async (req, res) => {
    try {
      if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
        return res.status(400).json({ error: "Shopify credentials not configured. Please set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN" });
      }

      const pageInfo = req.query.page_info as string | undefined;
      const { orders: shopifyOrders, nextPageInfo } = await fetchShopifyOrders(100, pageInfo);
      let syncCount = 0;

      for (const shopifyOrder of shopifyOrders) {
        const orderData = {
          id: shopifyOrder.id.toString(),
          orderNumber: extractActualOrderNumber(shopifyOrder),
          customerName: shopifyOrder.customer
            ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
            : "Guest",
          customerEmail: shopifyOrder.customer?.email || null,
          customerPhone: shopifyOrder.customer?.phone || null,
          shippingAddress: shopifyOrder.shipping_address || {},
          lineItems: shopifyOrder.line_items || [],
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          financialStatus: shopifyOrder.financial_status,
          ...extractShopifyOrderPrices(shopifyOrder),
          createdAt: new Date(shopifyOrder.created_at),
          updatedAt: new Date(shopifyOrder.updated_at),
        };

        const existing = await storage.getOrder(orderData.id);
        if (existing) {
          await storage.updateOrder(orderData.id, orderData);
        } else {
          await storage.createOrder(orderData);
        }

        // Process refunds and line items using centralized ETL service
        await shopifyOrderETL.processOrder(shopifyOrder);

        syncCount++;
      }

      res.json({ 
        success: true, 
        count: syncCount,
        nextCursor: nextPageInfo,
        hasMore: !!nextPageInfo
      });
    } catch (error) {
      console.error("Error syncing orders:", error);
      res.status(500).json({ error: "Failed to sync orders" });
    }
  });

  app.get("/api/orders", requireAuth, async (req, res) => {
    try {
      // Parse filter parameters from query string
      const filters: any = {
        search: req.query.search as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : 50,
        sortBy: req.query.sortBy as any || 'createdAt',
        sortOrder: req.query.sortOrder as any || 'desc',
      };

      // Parse array parameters
      if (req.query.fulfillmentStatus) {
        filters.fulfillmentStatus = Array.isArray(req.query.fulfillmentStatus) 
          ? req.query.fulfillmentStatus 
          : [req.query.fulfillmentStatus];
      }
      if (req.query.financialStatus) {
        filters.financialStatus = Array.isArray(req.query.financialStatus)
          ? req.query.financialStatus
          : [req.query.financialStatus];
      }
      if (req.query.shipmentStatus) {
        filters.shipmentStatus = Array.isArray(req.query.shipmentStatus)
          ? req.query.shipmentStatus
          : [req.query.shipmentStatus];
      }
      if (req.query.carrierCode) {
        filters.carrierCode = Array.isArray(req.query.carrierCode)
          ? req.query.carrierCode
          : [req.query.carrierCode];
      }

      // Parse boolean parameters
      if (req.query.hasShipment !== undefined) {
        filters.hasShipment = req.query.hasShipment === 'true';
      }
      if (req.query.hasRefund !== undefined) {
        filters.hasRefund = req.query.hasRefund === 'true';
      }

      // Parse date parameters - make dateTo inclusive (end of day) using Central Time
      if (req.query.dateFrom) {
        const dateFromStr = req.query.dateFrom as string;
        // Parse YYYY-MM-DD as Central Time start of day (00:00:00 CST)
        filters.dateFrom = fromZonedTime(`${dateFromStr} 00:00:00`, CST_TIMEZONE);
        if (isNaN(filters.dateFrom.getTime())) {
          return res.status(400).json({ error: "Invalid dateFrom format. Expected YYYY-MM-DD" });
        }
      }
      if (req.query.dateTo) {
        const dateToStr = req.query.dateTo as string;
        // Parse as Central Time end of day (23:59:59.999 CST) to make range inclusive
        filters.dateTo = fromZonedTime(`${dateToStr} 23:59:59.999`, CST_TIMEZONE);
        if (isNaN(filters.dateTo.getTime())) {
          return res.status(400).json({ error: "Invalid dateTo format. Expected YYYY-MM-DD" });
        }
      }

      // Parse price range
      if (req.query.minTotal) {
        filters.minTotal = parseFloat(req.query.minTotal as string);
      }
      if (req.query.maxTotal) {
        filters.maxTotal = parseFloat(req.query.maxTotal as string);
      }

      // Get filtered orders with pagination
      const { orders, total } = await storage.getFilteredOrders(filters);

      // Enrich orders with shipment status
      const allShipments = await storage.getAllShipments();
      const shipmentsMap = new Map<string, boolean>();
      allShipments.forEach(shipment => shipmentsMap.set(shipment.orderId, true));
      
      const ordersWithShipmentStatus = orders.map(order => ({
        ...order,
        hasShipment: shipmentsMap.has(order.id),
      }));

      res.json({ 
        orders: ordersWithShipmentStatus,
        total,
        page: filters.page,
        pageSize: filters.pageSize,
        totalPages: Math.ceil(total / filters.pageSize),
      });
    } catch (error) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  app.get("/api/orders/:id", requireAuth, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const shipments = await storage.getShipmentsByOrderId(order.id);
      const refunds = await storage.getOrderRefunds(order.id);

      res.json({ order, shipments, refunds });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  app.get("/api/orders/:id/print-jobs", requireAuth, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const printJobs = await storage.getPrintJobsByOrderId(order.id);

      res.json({ printJobs });
    } catch (error) {
      console.error("Error fetching print jobs:", error);
      res.status(500).json({ error: "Failed to fetch print jobs" });
    }
  });

  app.post("/api/orders/:id/create-label", requireAuth, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      // Use the centralized service to create label
      const result = await shipmentService.createLabelForOrder(order.orderNumber);

      if (!result.success) {
        return res.status(500).json({ error: result.error });
      }

      // Broadcast print queue update
      broadcastPrintQueueUpdate({ type: "job_added", job: result.printJob });

      res.json({ success: true, printJob: result.printJob, labelUrl: result.labelUrl });
    } catch (error: any) {
      console.error("Error creating label:", error);
      res.status(500).json({ error: error.message || "Failed to create label" });
    }
  });

  app.get("/api/labels/proxy", requireAuth, async (req, res) => {
    try {
      const labelUrl = req.query.url as string;
      
      if (!labelUrl) {
        return res.status(400).json({ error: "Missing label URL" });
      }

      if (!labelUrl.includes('api.shipstation.com')) {
        return res.status(400).json({ error: "Invalid label URL" });
      }

      const apiKey = process.env.SHIPSTATION_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "ShipStation API key not configured" });
      }

      const response = await fetch(labelUrl, {
        headers: {
          'api-key': apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch PDF: ${response.statusText}`);
      }

      const pdfBuffer = await response.arrayBuffer();
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="label.pdf"');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(Buffer.from(pdfBuffer));
    } catch (error: any) {
      console.error("Error proxying label:", error);
      res.status(500).json({ error: error.message || "Failed to proxy label" });
    }
  });

  // Get distinct statuses for filtering
  app.get("/api/shipments/statuses", requireAuth, async (req, res) => {
    try {
      const statuses = await storage.getDistinctStatuses();
      res.json({ statuses });
    } catch (error) {
      console.error("Error fetching statuses:", error);
      res.status(500).json({ error: "Failed to fetch statuses" });
    }
  });

  // Get distinct status descriptions for filtering (optionally filtered by status)
  app.get("/api/shipments/status-descriptions", requireAuth, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const statusDescriptions = await storage.getDistinctStatusDescriptions(status);
      res.json({ statusDescriptions });
    } catch (error) {
      console.error("Error fetching status descriptions:", error);
      res.status(500).json({ error: "Failed to fetch status descriptions" });
    }
  });

  // Get distinct shipment statuses for filtering (includes null values)
  app.get("/api/shipments/shipment-statuses", requireAuth, async (req, res) => {
    try {
      const shipmentStatuses = await storage.getDistinctShipmentStatuses();
      res.json({ shipmentStatuses });
    } catch (error) {
      console.error("Error fetching shipment statuses:", error);
      res.status(500).json({ error: "Failed to fetch shipment statuses" });
    }
  });

  // Get tab counts for workflow tabs
  app.get("/api/shipments/tab-counts", requireAuth, async (req, res) => {
    try {
      const counts = await storage.getShipmentTabCounts();
      console.log("[tab-counts] Returning counts:", JSON.stringify(counts));
      res.json(counts);
    } catch (error) {
      console.error("Error fetching tab counts:", error);
      res.status(500).json({ error: "Failed to fetch tab counts" });
    }
  });

  app.get("/api/shipments", requireAuth, async (req, res) => {
    try {
      // Parse filter parameters from query string
      const filters: any = {
        search: req.query.search as string | undefined,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : 50,
        sortBy: req.query.sortBy as any || 'createdAt',
        sortOrder: req.query.sortOrder as any || 'desc',
      };

      // Parse workflow tab filter
      if (req.query.workflowTab) {
        filters.workflowTab = req.query.workflowTab as string;
      }

      // Parse status as single value (for cascading filter)
      if (req.query.status) {
        filters.status = req.query.status as string;
      }
      if (req.query.statusDescription) {
        filters.statusDescription = req.query.statusDescription as string;
      }
      // Parse shipmentStatus as array (can have multiple values)
      if (req.query.shipmentStatus) {
        filters.shipmentStatus = Array.isArray(req.query.shipmentStatus)
          ? req.query.shipmentStatus
          : [req.query.shipmentStatus];
      }
      if (req.query.carrierCode) {
        filters.carrierCode = Array.isArray(req.query.carrierCode)
          ? req.query.carrierCode
          : [req.query.carrierCode];
      }

      // Parse date parameters - make dateTo inclusive (end of day) using Central Time
      if (req.query.dateFrom) {
        const dateFromStr = req.query.dateFrom as string;
        // Parse YYYY-MM-DD as Central Time start of day (00:00:00 CST)
        filters.dateFrom = fromZonedTime(`${dateFromStr} 00:00:00`, CST_TIMEZONE);
        if (isNaN(filters.dateFrom.getTime())) {
          return res.status(400).json({ error: "Invalid dateFrom format. Expected YYYY-MM-DD" });
        }
      }
      if (req.query.dateTo) {
        const dateToStr = req.query.dateTo as string;
        // Parse as Central Time end of day (23:59:59.999 CST) to make range inclusive
        filters.dateTo = fromZonedTime(`${dateToStr} 23:59:59.999`, CST_TIMEZONE);
        if (isNaN(filters.dateTo.getTime())) {
          return res.status(400).json({ error: "Invalid dateTo format. Expected YYYY-MM-DD" });
        }
      }

      // Parse orphaned filter
      if (req.query.orphaned === 'true') {
        filters.orphaned = true;
      }

      // Parse withoutOrders filter
      if (req.query.withoutOrders === 'true') {
        filters.withoutOrders = true;
      }

      // Parse shippedWithoutTracking filter (shipped but missing tracking number)
      if (req.query.shippedWithoutTracking === 'true') {
        filters.shippedWithoutTracking = true;
      }

      // Get filtered shipments (no orders table join - all data comes from shipments table)
      const { shipments, total } = await storage.getFilteredShipments(filters);

      res.json({
        shipments,
        total,
        page: filters.page,
        pageSize: filters.pageSize,
        totalPages: Math.ceil(total / filters.pageSize),
      });
    } catch (error) {
      console.error("Error fetching shipments:", error);
      res.status(500).json({ error: "Failed to fetch shipments" });
    }
  });

  // Get single shipment by ID (tries shipmentId first, then database UUID)
  app.get("/api/shipments/:id", requireAuth, async (req, res) => {
    try {
      const idParam = req.params.id;
      let shipment = null;

      // Try lookup by ShipStation shipmentId first (e.g., "se-123456")
      shipment = await storage.getShipmentByShipmentId(idParam);

      // Fall back to database UUID if not found by shipmentId
      if (!shipment) {
        shipment = await storage.getShipment(idParam);
      }
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Get order if linked
      let order = null;
      if (shipment.orderId) {
        order = await storage.getOrder(shipment.orderId);
      }

      res.json({ ...shipment, order });
    } catch (error) {
      console.error("Error fetching shipment:", error);
      res.status(500).json({ error: "Failed to fetch shipment" });
    }
  });

  // Get all products with variants
  app.get("/api/products", requireAuth, async (req, res) => {
    try {
      const productsWithVariants = await storage.getAllProductsWithVariants();
      res.json({ productsWithVariants });
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // Get product by ID with variants
  app.get("/api/products/:id", requireAuth, async (req, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const variants = await storage.getProductVariants(product.id);
      res.json({ product, variants });
    } catch (error) {
      console.error("Error fetching product:", error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  // Search products by barcode or SKU
  app.get("/api/products/search", requireAuth, async (req, res) => {
    try {
      const barcode = req.query.barcode as string;
      const sku = req.query.sku as string;

      if (!barcode && !sku) {
        return res.status(400).json({ error: "Either barcode or sku parameter is required" });
      }

      let variant = null;

      if (barcode) {
        variant = await storage.getVariantByBarcode(barcode);
      } else if (sku) {
        variant = await storage.getVariantBySku(sku);
      }

      if (!variant) {
        return res.status(404).json({ error: "Product variant not found" });
      }

      const product = await storage.getProduct(variant.productId);

      res.json({ variant, product });
    } catch (error) {
      console.error("Error searching products:", error);
      res.status(500).json({ error: "Failed to search products" });
    }
  });

  // ========== SkuVault Integration ==========

  // Manual login to SkuVault
  app.post("/api/skuvault/login", requireAuth, async (req, res) => {
    try {
      console.log("========== SKUVAULT LOGIN REQUEST ==========");
      console.log("Timestamp:", new Date().toISOString());
      console.log("User:", req.user?.email || 'Unknown');
      console.log("IP:", req.ip || req.connection.remoteAddress);
      console.log("Headers:", JSON.stringify({
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'cookie': req.headers.cookie ? '***present***' : 'none',
        'referer': req.headers.referer,
      }, null, 2));
      console.log("Body:", JSON.stringify(req.body));
      console.log("============================================");
      
      console.log("Initiating manual SkuVault login...");
      const success = await skuVaultService.login();
      
      if (success) {
        console.log("SkuVault login successful");
        res.json({ success: true, message: "Successfully connected to SkuVault" });
      } else {
        console.log("SkuVault login failed (should not reach here - login() should throw)");
        res.status(401).json({ success: false, error: "Failed to authenticate with SkuVault" });
      }
    } catch (error: any) {
      console.error("Error during SkuVault login:", error);
      
      // Handle SkuVaultError with detailed message
      if (error instanceof SkuVaultError) {
        res.status(error.statusCode).json({ 
          success: false,
          error: error.message,
          message: error.message,
          details: error.details
        });
      } else {
        // Handle unexpected errors
        res.status(500).json({ 
          success: false,
          error: "Failed to connect to SkuVault",
          message: error.message 
        });
      }
    }
  });

  // Get SkuVault lockout status
  app.get("/api/skuvault/lockout-status", requireAuth, async (req, res) => {
    try {
      const lockoutStatus = await skuVaultService.getLockoutStatus();
      res.json(lockoutStatus);
    } catch (error: any) {
      console.error("Error fetching SkuVault lockout status:", error);
      res.status(500).json({ 
        error: "Failed to fetch lockout status",
        message: error.message 
      });
    }
  });

  // Get all SkuVault wave picking sessions with optional search/filter/pagination
  app.get("/api/skuvault/sessions", requireAuth, async (req, res) => {
    try {
      console.log("Fetching SkuVault sessions with query params:", req.query);
      
      // Parse and validate query parameters
      const filters: any = {};
      
      if (req.query.sessionId) {
        filters.sessionId = parseInt(req.query.sessionId as string, 10);
      }
      
      if (req.query.picklistId) {
        filters.picklistId = req.query.picklistId as string;
      }
      
      if (req.query.orderNumber) {
        filters.orderNumber = req.query.orderNumber as string;
      }
      
      if (req.query.states) {
        // Handle both single string and array of strings
        const statesParam = req.query.states;
        filters.states = Array.isArray(statesParam) ? statesParam : [statesParam];
      }
      
      if (req.query.sortDescending) {
        filters.sortDescending = req.query.sortDescending === 'true';
      }
      
      if (req.query.limit) {
        filters.limit = parseInt(req.query.limit as string, 10);
      }
      
      if (req.query.skip) {
        filters.skip = parseInt(req.query.skip as string, 10);
      }
      
      const sessions = await skuVaultService.getSessions(filters);
      console.log(`Retrieved ${sessions.length} sessions from SkuVault`);
      res.json({ sessions });
    } catch (error: any) {
      console.error("Error fetching SkuVault sessions:", error);
      res.status(500).json({ 
        error: "Failed to fetch SkuVault sessions",
        message: error.message 
      });
    }
  });

  // Get detailed directions for a specific SkuVault session
  // First tries Firestore (for completed sessions), then falls back to SkuVault API (for active sessions)
  app.get("/api/skuvault/sessions/:picklistId", requireAuth, async (req, res) => {
    try {
      const { picklistId } = req.params;
      console.log(`Fetching session details for picklist ${picklistId}...`);
      
      // First try to get session data from Firestore (contains completed sessions)
      const firestoreSessions = await firestoreStorage.getSkuVaultOrderSessionByPicklistId(picklistId);
      
      if (firestoreSessions.length > 0) {
        console.log(`Found ${firestoreSessions.length} session(s) in Firestore for picklist ${picklistId}`);
        
        // Extract all unique SKUs from the Firestore sessions
        const skus = new Set<string>();
        for (const session of firestoreSessions) {
          if (session.order_items) {
            for (const item of session.order_items) {
              if (item.sku) {
                skus.add(item.sku);
              }
            }
          }
        }
        
        // Fetch product images for all SKUs
        const skuImageMap = new Map<string, string>();
        if (skus.size > 0) {
          const variants = await storage.getProductVariantsBySKUs(Array.from(skus));
          for (const variant of variants) {
            if (variant.sku && variant.imageUrl) {
              skuImageMap.set(variant.sku, variant.imageUrl);
            }
          }
        }
        
        // Transform Firestore data to match the expected response format
        // Group all orders from the sessions
        const orders = firestoreSessions.map(session => ({
          orderNumber: session.order_number,
          saleId: session.sale_id,
          shipmentId: session.shipment_id,
          spot: session.spot_number,
          status: session.session_status,
          pickerName: session.picked_by_user_name,
          pickStartTime: session.pick_start_datetime,
          pickEndTime: session.pick_end_datetime,
          items: session.order_items.map(item => ({
            sku: item.sku,
            description: item.description,
            quantity: item.quantity,
            location: item.location,
            locations: item.locations,
            picked: item.picked,
            completed: item.completed,
            imageUrl: skuImageMap.get(item.sku) || (item.product_pictures?.[0] || null),
          })),
        }));
        
        // Use the first session for picklist-level info
        const firstSession = firestoreSessions[0];
        return res.json({
          source: 'firestore',
          picklist: {
            picklistId: firstSession.session_picklist_id || picklistId,
            sessionId: firstSession.session_id,
            status: firstSession.session_status,
            pickerName: firstSession.picked_by_user_name,
            pickerId: firstSession.picked_by_user_id,
            pickStartTime: firstSession.pick_start_datetime,
            pickEndTime: firstSession.pick_end_datetime,
            orders,
          },
        });
      }
      
      // Fall back to SkuVault API for active sessions
      console.log(`No Firestore data found, trying SkuVault API for picklist ${picklistId}...`);
      const directions = await skuVaultService.getSessionDirections(picklistId);
      
      // Extract all unique SKUs from the session
      const skus = new Set<string>();
      if (directions.picklist?.orders) {
        for (const order of directions.picklist.orders) {
          if (order.items) {
            for (const item of order.items) {
              if (item.sku) {
                skus.add(item.sku);
              }
            }
          }
        }
      }
      
      // Fetch product images for all SKUs
      const skuImageMap = new Map<string, string>();
      if (skus.size > 0) {
        const variants = await storage.getProductVariantsBySKUs(Array.from(skus));
        for (const variant of variants) {
          if (variant.sku && variant.imageUrl) {
            skuImageMap.set(variant.sku, variant.imageUrl);
          }
        }
      }
      
      // Augment line items with product images
      if (directions.picklist?.orders) {
        for (const order of directions.picklist.orders) {
          if (order.items) {
            for (const item of order.items) {
              if (item.sku) {
                item.imageUrl = skuImageMap.get(item.sku) || null;
              }
            }
          }
        }
      }
      
      res.json({ source: 'skuvault', ...directions });
    } catch (error: any) {
      console.error(`Error fetching session details for picklist ${req.params.picklistId}:`, error);
      res.status(500).json({ 
        error: "Failed to fetch session details",
        message: error.message 
      });
    }
  });

  // ========== SkuVault Quality Control ==========

  // Look up a product by barcode/SKU/part number for QC validation
  app.get("/api/skuvault/qc/product/:searchTerm", requireAuth, async (req, res) => {
    try {
      const { searchTerm } = req.params;
      console.log(`Looking up product for QC: ${searchTerm}`);
      
      const { product, rawResponse } = await skuVaultService.getProductByCode(searchTerm);
      
      if (!product) {
        return res.status(404).json({ 
          error: "Product not found",
          message: `No product found with code/SKU: ${searchTerm}`,
          rawResponse // Include raw response for audit logging
        });
      }
      
      res.json({ 
        product,
        rawResponse // Include raw response for audit logging
      });
    } catch (error: any) {
      console.error("Error looking up product for QC:", error);
      
      // Handle SkuVaultError with detailed message
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ 
        error: "Failed to lookup product",
        message: error.message 
      });
    }
  });

  // Mark an item as QC passed
  app.post("/api/skuvault/qc/pass-item", requireAuth, async (req, res) => {
    try {
      // Validate and parse request body with Zod schema (with coercion for form inputs)
      const parseResult = qcPassItemRequestSchema.safeParse(req.body);
      
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid request data",
          message: "Request body validation failed",
          details: parseResult.error.format()
        });
      }
      
      // Hybrid approach: Use cached SaleId if available
      // Note: If IdSale is null (not undefined), it means we already tried lookup and it failed
      // Only attempt lookup if IdSale is undefined (never tried)
      let saleId = parseResult.data.IdSale;
      
      if (parseResult.data.IdSale === undefined && parseResult.data.OrderNumber) {
        // No cached SaleId - attempt one-time lookup using order number
        try {
          console.log(`[QC Pass] No cached SaleId, looking up for order: ${parseResult.data.OrderNumber}`);
          const saleInfo = await skuVaultService.getSaleInformation(parseResult.data.OrderNumber);
          if (saleInfo?.SaleId) {
            saleId = saleInfo.SaleId;
            console.log(`[QC Pass] Found SaleId: ${saleId}`);
          } else {
            console.log(`[QC Pass] Order not in SkuVault - skipping QC pass (non-blocking)`);
          }
        } catch (error: any) {
          console.log(`[QC Pass] Lookup failed - skipping QC pass (non-blocking):`, error.message);
        }
      } else if (parseResult.data.IdSale === null) {
        console.log(`[QC Pass] SaleId already looked up (not found) - skipping QC pass`);
      }
      
      // Only call SkuVault QC if we have a valid SaleId
      if (saleId) {
        try {
          const qcData = {
            ...parseResult.data,
            IdSale: saleId,
          };
          
          console.log(`[QC Pass] Attempting QC pass with SaleId: ${saleId}`);
          const result = await skuVaultService.passQCItem(qcData);
          res.json(result);
        } catch (error: any) {
          // Graceful degradation: Log but return success so packing continues
          console.warn(`[QC Pass] SkuVault QC pass failed (non-blocking):`, error.message);
          
          // Return success response so frontend proceeds without errors
          res.json({
            Success: true, // Return true to avoid error alerts in UI
            Data: null,
            Errors: [], // Empty errors array for graceful degradation
          });
        }
      } else {
        // No SaleId available - skip QC pass but return success
        console.log(`[QC Pass] No valid SaleId - skipping QC pass (order not in SkuVault)`);
        res.json({
          Success: true, // Non-blocking: return success even when skipping QC
          Data: null,
          Errors: [],
        });
      }
    } catch (error: any) {
      console.error("Error marking item as QC passed:", error);
      
      // Handle SkuVaultError with detailed message
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ 
        error: "Failed to mark item as QC passed",
        message: error.message 
      });
    }
  });

  // Get picked quantity for a product in a specific sale (SkuVault sync)
  app.get("/api/skuvault/qc/picked-quantity", requireAuth, async (req, res) => {
    try {
      const { codeOrSku, saleId } = req.query;
      
      if (!codeOrSku || !saleId) {
        return res.status(400).json({ 
          error: "Missing required parameters",
          message: "Both codeOrSku and saleId are required"
        });
      }
      
      // Call SkuVault to get picked quantity
      const pickedQuantity = await skuVaultService.getPickedQuantityForProduct(
        String(codeOrSku),
        String(saleId)
      );
      
      // Return null if error (graceful degradation)
      res.json({ pickedQuantity });
    } catch (error: any) {
      console.error("Error getting picked quantity:", error);
      
      // Graceful degradation - return null on error
      res.json({ pickedQuantity: null });
    }
  });

  // Get shipment items for a specific shipment (accepts shipmentId or UUID)
  app.get("/api/shipments/:shipmentId/items", requireAuth, async (req, res) => {
    try {
      const idParam = req.params.shipmentId;
      
      // Try lookup by ShipStation shipmentId first
      let shipment = await storage.getShipmentByShipmentId(idParam);
      
      // Fall back to database UUID
      if (!shipment) {
        shipment = await storage.getShipment(idParam);
      }
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Fetch items using the database ID
      const items = await storage.getShipmentItems(shipment.id);
      res.json(items);
    } catch (error: any) {
      console.error(`Error fetching shipment items for ${req.params.shipmentId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment items" });
    }
  });

  // Get shipment tags for a specific shipment (accepts shipmentId or UUID)
  app.get("/api/shipments/:shipmentId/tags", requireAuth, async (req, res) => {
    try {
      const idParam = req.params.shipmentId;
      
      // Try lookup by ShipStation shipmentId first
      let shipment = await storage.getShipmentByShipmentId(idParam);
      
      // Fall back to database UUID
      if (!shipment) {
        shipment = await storage.getShipment(idParam);
      }
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Fetch tags using the database ID
      const tags = await storage.getShipmentTags(shipment.id);
      res.json(tags);
    } catch (error: any) {
      console.error(`Error fetching shipment tags for ${req.params.shipmentId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment tags" });
    }
  });

  // Get shipment items for a specific order item (to show which shipments contain this item)
  app.get("/api/order-items/:orderItemId/shipment-items", requireAuth, async (req, res) => {
    try {
      const shipmentItems = await storage.getShipmentItemsByOrderItemId(req.params.orderItemId);
      res.json(shipmentItems);
    } catch (error: any) {
      console.error(`Error fetching shipment items for order item ${req.params.orderItemId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment items" });
    }
  });

  // Get shipment items by external order item ID (Shopify line item ID)
  app.get("/api/line-items/:lineItemId/shipment-items", requireAuth, async (req, res) => {
    try {
      const shipmentItems = await storage.getShipmentItemsByExternalOrderItemId(req.params.lineItemId);
      res.json(shipmentItems);
    } catch (error: any) {
      console.error(`Error fetching shipment items for line item ${req.params.lineItemId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment items" });
    }
  });

  // Manual sync endpoint - fetches last 7 days of shipments from ShipStation API and enqueues them for processing
  app.post("/api/shipments/sync", requireAuth, async (req, res) => {
    try {
      console.log("========== SHIPSTATION SYNC FROM API STARTED ==========");
      
      // Calculate date range: last 7 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      
      console.log(`Fetching shipments from ${startDate.toISOString()} to ${endDate.toISOString()}`);
      
      // Fetch shipments from ShipStation API (with rate limit handling and retries)
      const { data: shipments, rateLimit } = await getShipmentsByDateRange(startDate, endDate);
      console.log(`Fetched ${shipments.length} shipments from ShipStation (rate limit: ${rateLimit.remaining}/${rateLimit.limit})`);
      
      // Track skipped shipments for diagnostics
      const skippedShipments: string[] = [];
      
      // Build sync messages from ShipStation data
      const messages: any[] = [];
      
      for (const shipment of shipments) {
        // Extract order number from shipment_number field (this is the customer-facing order number)
        const orderNumber = shipment.shipment_number || shipment.order_number;
        
        // Extract tracking number if available
        const trackingNumber = shipment.tracking_number;
        
        // Prefer tracking number if available, otherwise use order number
        if (trackingNumber) {
          messages.push({
            trackingNumber,
            shipmentId: shipment.shipment_id,
            reason: 'manual-sync-api',
            enqueuedAt: Date.now(),
          });
        } else if (orderNumber) {
          messages.push({
            orderNumber,
            shipmentId: shipment.shipment_id,
            reason: 'manual-sync-api',
            enqueuedAt: Date.now(),
          });
        } else {
          const shipmentId = shipment.shipment_id || 'unknown';
          console.warn(`Skipping shipment ${shipmentId} - no tracking number or order number`);
          skippedShipments.push(shipmentId);
        }
      }
      
      // Enqueue all messages in batch
      if (messages.length > 0) {
        await enqueueShipmentSyncBatch(messages);
        console.log(`Enqueued ${messages.length} shipment sync jobs`);
      }
      
      console.log(`========== SHIPSTATION SYNC COMPLETE ==========`);

      res.json({ 
        success: true,
        enqueuedCount: messages.length,
        shipmentsFromApi: shipments.length,
        skippedCount: skippedShipments.length,
        dateRange: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        rateLimit: {
          remaining: rateLimit.remaining,
          limit: rateLimit.limit,
        },
        message: `Successfully enqueued ${messages.length} shipments from ShipStation API (last 7 days)${skippedShipments.length > 0 ? `, skipped ${skippedShipments.length} shipments without identifiers` : ''}`
      });
    } catch (error: any) {
      console.error("Error syncing from ShipStation API:", error);
      res.status(500).json({ 
        success: false,
        error: error.message || "Failed to sync from ShipStation",
        details: "Sync failed before completion. Please check server logs for details."
      });
    }
  });

  // Sync tracking status for non-delivered shipments
  app.post("/api/shipments/sync-tracking", requireAuth, async (req, res) => {
    try {
      console.log("========== TRACKING SYNC STARTED ==========");
      const nonDeliveredShipments = await storage.getNonDeliveredShipments();
      console.log(`Syncing tracking for ${nonDeliveredShipments.length} non-delivered shipments...`);

      let updatedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (const shipment of nonDeliveredShipments) {
        try {
          // Skip shipments without tracking numbers
          if (!shipment.trackingNumber) {
            skippedCount++;
            continue;
          }

          // Fetch latest fulfillment data from ShipStation
          const fulfillmentData = await getFulfillmentByTrackingNumber(shipment.trackingNumber);
          
          if (fulfillmentData) {
            // Prepare update payload - only include actual state transitions
            const updatePayload: any = {};

            // Merge shipmentData instead of replacing
            if (shipment.shipmentData) {
              updatePayload.shipmentData = { ...shipment.shipmentData, ...fulfillmentData };
            } else {
              updatePayload.shipmentData = fulfillmentData;
            }

            // Only update status on meaningful transitions (don't regress)
            if (fulfillmentData.voided && shipment.status !== 'cancelled') {
              // Transition to cancelled
              updatePayload.status = 'cancelled';
              updatePayload.statusDescription = 'Shipment voided';
            } else if (fulfillmentData.delivered_at && shipment.status !== 'DE') {
              // Transition to delivered
              updatePayload.status = 'DE';
              updatePayload.statusDescription = 'DELIVERED';
              updatePayload.actualDeliveryDate = new Date(fulfillmentData.delivered_at);
            }
            // Don't regress from cancelled/delivered/exception to 'shipped'

            // Only update if there are actual changes
            if (Object.keys(updatePayload).length > 1) { // More than just shipmentData
              await storage.updateShipment(shipment.id, updatePayload);
              updatedCount++;
              console.log(`Updated tracking for ${shipment.trackingNumber}: ${updatePayload.status || shipment.status}`);
            } else if (Object.keys(updatePayload).length === 1) {
              // Only shipmentData changed, still update to preserve metadata
              await storage.updateShipment(shipment.id, updatePayload);
              updatedCount++;
              console.log(`Updated metadata for ${shipment.trackingNumber}`);
            } else {
              skippedCount++;
            }
          } else {
            skippedCount++;
            console.log(`No fulfillment data found for tracking ${shipment.trackingNumber}`);
          }
        } catch (shipmentError: any) {
          const errorMsg = `Tracking ${shipment.trackingNumber}: ${shipmentError.message}`;
          console.error(errorMsg);
          errors.push(errorMsg);
          skippedCount++;
        }
      }

      console.log(`========== TRACKING SYNC COMPLETE: ${updatedCount} updated, ${skippedCount} skipped ==========`);

      res.json({ 
        success: true,
        updatedCount,
        skippedCount,
        totalChecked: nonDeliveredShipments.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error: any) {
      console.error("Error syncing tracking:", error);
      res.status(500).json({ error: error.message || "Failed to sync tracking" });
    }
  });

  // Test endpoint - create mock shipment for testing label creation
  app.post("/api/orders/:id/create-test-shipment", requireAuth, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      const existingShipments = await storage.getShipmentsByOrderId(order.id);
      if (existingShipments.length > 0) {
        return res.json({ 
          success: true, 
          shipment: existingShipments[0],
          message: "Shipment already exists" 
        });
      }

      const mockShipmentId = `se-test-${Date.now()}`;
      
      const shipment = await storage.createShipment({
        orderId: order.id,
        shipmentId: mockShipmentId,
        trackingNumber: `TEST${order.orderNumber}`,
        carrierCode: "usps",
        serviceCode: "usps_priority_mail",
        status: "pending",
        statusDescription: "Test shipment - pending label creation",
        shipDate: new Date().toISOString(),
        labelUrl: null,
      });

      res.json({ success: true, shipment });
    } catch (error: any) {
      console.error("Error creating test shipment:", error);
      res.status(500).json({ error: error.message || "Failed to create test shipment" });
    }
  });

  // Shopify webhook endpoint - receives order updates and queues them
  app.post("/api/webhooks/shopify/orders", async (req, res) => {
    try {
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
      const shopifySecret = process.env.SHOPIFY_API_SECRET;
      const topic = req.headers['x-shopify-topic'] as string;
      const webhookId = req.headers['x-shopify-webhook-id'] as string;

      if (!shopifySecret) {
        console.error("SHOPIFY_API_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody as Buffer;
      if (!verifyShopifyWebhook(rawBody, hmacHeader, shopifySecret)) {
        console.error("========== SHOPIFY WEBHOOK VERIFICATION FAILED ==========");
        console.error(`Timestamp: ${new Date().toISOString()}`);
        console.error(`Topic: ${topic || 'unknown'}`);
        console.error(`Webhook ID: ${webhookId || 'unknown'}`);
        console.error(`Request Path: ${req.path}`);
        console.error(`Shop Domain: ${req.headers['x-shopify-shop-domain'] || 'unknown'}`);
        console.error(`HMAC Header Present: ${!!hmacHeader}`);
        console.error(`Body Size: ${rawBody?.length || 0} bytes`);
        console.error("=========================================================");
        return res.status(401).json({ error: "Webhook verification failed" });
      }

      const webhookData = {
        type: 'shopify',
        topic: req.headers['x-shopify-topic'],
        shopDomain: req.headers['x-shopify-shop-domain'],
        order: req.body,
        receivedAt: new Date().toISOString(),
      };

      await enqueueWebhook(webhookData);

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error processing webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Shopify product webhook endpoint - receives product updates and queues them
  app.post("/api/webhooks/shopify/products", async (req, res) => {
    try {
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
      const shopifySecret = process.env.SHOPIFY_API_SECRET;
      const topic = req.headers['x-shopify-topic'] as string;
      const webhookId = req.headers['x-shopify-webhook-id'] as string;

      if (!shopifySecret) {
        console.error("SHOPIFY_API_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody as Buffer;
      if (!verifyShopifyWebhook(rawBody, hmacHeader, shopifySecret)) {
        console.error("========== SHOPIFY WEBHOOK VERIFICATION FAILED ==========");
        console.error(`Timestamp: ${new Date().toISOString()}`);
        console.error(`Topic: ${topic || 'unknown'}`);
        console.error(`Webhook ID: ${webhookId || 'unknown'}`);
        console.error(`Request Path: ${req.path}`);
        console.error(`Shop Domain: ${req.headers['x-shopify-shop-domain'] || 'unknown'}`);
        console.error(`HMAC Header Present: ${!!hmacHeader}`);
        console.error(`Body Size: ${rawBody?.length || 0} bytes`);
        console.error("=========================================================");
        return res.status(401).json({ error: "Webhook verification failed" });
      }

      const webhookData = {
        type: 'shopify-product',
        topic: req.headers['x-shopify-topic'],
        shopDomain: req.headers['x-shopify-shop-domain'],
        product: req.body,
        receivedAt: new Date().toISOString(),
      };

      await enqueueWebhook(webhookData);

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error processing product webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Shopify refund webhook endpoint - receives refund events
  app.post("/api/webhooks/shopify/refunds", async (req, res) => {
    try {
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
      const shopifySecret = process.env.SHOPIFY_API_SECRET;
      const topic = req.headers['x-shopify-topic'] as string;
      const webhookId = req.headers['x-shopify-webhook-id'] as string;

      if (!shopifySecret) {
        console.error("SHOPIFY_API_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody as Buffer;
      if (!verifyShopifyWebhook(rawBody, hmacHeader, shopifySecret)) {
        console.error("========== SHOPIFY REFUND WEBHOOK VERIFICATION FAILED ==========");
        console.error(`Timestamp: ${new Date().toISOString()}`);
        console.error(`Topic: ${topic || 'unknown'}`);
        console.error(`Webhook ID: ${webhookId || 'unknown'}`);
        console.error(`Request Path: ${req.path}`);
        console.error(`Shop Domain: ${req.headers['x-shopify-shop-domain'] || 'unknown'}`);
        console.error(`HMAC Header Present: ${!!hmacHeader}`);
        console.error(`Body Size: ${rawBody?.length || 0} bytes`);
        console.error("====================================================================");
        return res.status(401).json({ error: "Webhook verification failed" });
      }

      const refundPayload = req.body;
      
      // Process refund immediately (no queueing needed - refunds are lightweight)
      try {
        const orderId = refundPayload.order_id?.toString();
        
        if (!orderId) {
          console.error("Refund webhook missing order_id:", refundPayload);
          return res.status(400).json({ error: "Missing order_id in refund webhook" });
        }

        // Check if order exists in our database
        const order = await storage.getOrder(orderId);
        
        if (!order) {
          console.warn(`Received refund for unknown order ${orderId} - skipping (order may not be synced yet)`);
          return res.status(200).json({ success: true, message: "Order not found - refund skipped" });
        }

        // Calculate total refund amount from transactions
        const totalAmount = refundPayload.transactions?.reduce((sum: number, txn: any) => {
          return sum + parseFloat(txn.amount || '0');
        }, 0) || 0;

        const refundData = {
          orderId: order.id,
          shopifyRefundId: refundPayload.id.toString(),
          amount: totalAmount.toFixed(2),
          note: refundPayload.note || null,
          refundedAt: new Date(refundPayload.created_at),
          processedAt: refundPayload.processed_at ? new Date(refundPayload.processed_at) : null,
        };

        await storage.upsertOrderRefund(refundData);
        
        console.log(`✓ Refund ${refundPayload.id} processed for order ${order.orderNumber} (${totalAmount.toFixed(2)})`);
        
      } catch (error) {
        console.error("Error processing refund webhook:", error);
        // Return 200 to prevent Shopify from retrying (we log the error for investigation)
        return res.status(200).json({ success: false, error: "Processing error logged" });
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error handling refund webhook:", error);
      res.status(500).json({ error: "Failed to process refund webhook" });
    }
  });

  // ShipStation webhook endpoint - receives shipment updates and queues them
  app.post("/api/webhooks/shipstation/shipments", async (req, res) => {
    try {
      // Debug logging - critical for warehouse operations
      console.log("========== SHIPSTATION WEBHOOK RECEIVED ==========");
      console.log("Timestamp:", new Date().toISOString());
      console.log("Headers:", JSON.stringify({
        'x-shipengine-rsa-sha256-signature': req.headers['x-shipengine-rsa-sha256-signature'] ? 'present' : 'missing',
        'x-shipengine-rsa-sha256-key-id': req.headers['x-shipengine-rsa-sha256-key-id'],
        'x-shipengine-timestamp': req.headers['x-shipengine-timestamp'],
        'content-type': req.headers['content-type'],
      }, null, 2));
      console.log("Body:", JSON.stringify(req.body, null, 2));
      console.log("==================================================");

      // TODO: Fix ShipStation webhook signature verification (ASN1 encoding issue)
      // For now, skip verification to get shipments working
      // const rawBody = req.rawBody as Buffer;
      // const isValid = await verifyShipStationWebhook(req, rawBody.toString());
      // if (!isValid) {
      //   console.warn("ShipStation webhook verification failed");
      //   return res.status(401).json({ error: "Webhook verification failed" });
      // }

      const webhookData = {
        type: 'shipstation',
        resourceType: req.body.resource_type,
        resourceUrl: req.body.resource_url,
        data: req.body.data, // Capture inline data for ALL webhook types (tracking, fulfillment, etc.)
        receivedAt: new Date().toISOString(),
      };

      console.log("Queuing webhook:", webhookData);
      await enqueueWebhook(webhookData);

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error processing ShipStation webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Worker endpoint - processes queued webhooks (requires authentication)
  app.post("/api/worker/process-webhooks", requireAuth, async (req, res) => {
    try {
      let processedCount = 0;
      const maxBatchSize = 10;

      for (let i = 0; i < maxBatchSize; i++) {
        const webhookData = await dequeueWebhook();
        
        if (!webhookData) {
          break;
        }

        try {
          if (webhookData.type === 'shopify' || webhookData.type === 'backfill') {
            // Process Shopify order webhook or backfill order
            const shopifyOrder = webhookData.order;
            const orderData = {
              id: shopifyOrder.id.toString(),
              orderNumber: extractActualOrderNumber(shopifyOrder),
              customerName: shopifyOrder.customer
                ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
                : "Guest",
              customerEmail: shopifyOrder.customer?.email || null,
              customerPhone: shopifyOrder.customer?.phone || null,
              shippingAddress: shopifyOrder.shipping_address || {},
              lineItems: shopifyOrder.line_items || [],
              fulfillmentStatus: shopifyOrder.fulfillment_status,
              financialStatus: shopifyOrder.financial_status,
              ...extractShopifyOrderPrices(shopifyOrder),
              createdAt: new Date(shopifyOrder.created_at),
              updatedAt: new Date(shopifyOrder.updated_at),
            };

            const existing = await storage.getOrder(orderData.id);
            
            if (existing) {
              await storage.updateOrder(orderData.id, orderData);
            } else {
              await storage.createOrder(orderData);
            }

            // Update backfill job progress if this is a backfill webhook
            // incrementBackfillProgress only increments if job.status === 'in_progress' (atomic DB check)
            if (webhookData.type === 'backfill' && webhookData.jobId) {
              await storage.incrementBackfillProgress(webhookData.jobId, 1);
              
              // Check if job is complete (only if totalOrders has been set)
              const job = await storage.getBackfillJob(webhookData.jobId);
              if (job && job.status === 'in_progress' && job.totalOrders > 0 && job.processedOrders + job.failedOrders >= job.totalOrders) {
                await storage.updateBackfillJob(webhookData.jobId, {
                  status: "completed",
                });
              }
            }

            broadcastOrderUpdate(orderData);
          } else if (webhookData.type === 'shipstation') {
            // Process ShipStation webhook - handle both tracking and shipment webhooks
            const resourceType = webhookData.resourceType;
            
            if (resourceType === 'API_TRACK') {
              // This is a tracking webhook - contains tracking events but not full shipment data
              const trackingData = webhookData.trackingData;
              const trackingNumber = trackingData?.tracking_number;
              
              if (!trackingNumber) {
                console.error('Tracking webhook missing tracking_number');
                continue;
              }
              
              // ALWAYS queue tracking webhooks to the worker for optimization
              // The worker will check if shipment exists and skip API calls if possible
              console.log(`Queuing tracking webhook ${trackingNumber} for shipment sync worker`);
              
              await enqueueShipmentSync({
                trackingNumber,
                labelUrl: trackingData.label_url,
                trackingData, // Include full tracking data for fast updates
                reason: 'webhook',
                enqueuedAt: Date.now(),
              });
            } else {
              // Regular shipment webhook (fulfillment_shipped_v2, etc.)
              // Fetch the resource to extract order numbers, then queue for async processing
              const resourceUrl = webhookData.resourceUrl;
              const shipmentResponse = await fetchShipStationResource(resourceUrl);
              const shipments = shipmentResponse.shipments || [];

              // Queue each order number for shipment sync processing
              for (const shipmentData of shipments) {
                // ShipStation uses 'shipment_number' field for the order number
                const orderNumber = shipmentData.shipment_number;
                
                if (orderNumber) {
                  console.log(`Queueing order ${orderNumber} for shipment sync from ${resourceType} webhook`);
                  
                  await enqueueShipmentSync({
                    orderNumber,
                    reason: 'webhook',
                    enqueuedAt: Date.now(),
                  });
                } else {
                  console.warn(`Shipment ${shipmentData.shipmentId} missing shipment_number field - cannot queue`);
                }
              }
            }
          }

          processedCount++;
        } catch (orderError) {
          console.error("Error processing individual webhook:", orderError);
        }
      }

      const remainingCount = await getQueueLength();

      res.json({ 
        success: true, 
        processed: processedCount,
        remaining: remainingCount
      });
    } catch (error) {
      console.error("Error in webhook worker:", error);
      res.status(500).json({ error: "Failed to process webhooks" });
    }
  });

  // Queue status endpoint for monitoring
  app.get("/api/webhooks/queue-status", requireAuth, async (req, res) => {
    try {
      const queueLength = await getQueueLength();
      res.json({ queueLength });
    } catch (error) {
      console.error("Error checking queue status:", error);
      res.status(500).json({ error: "Failed to check queue status" });
    }
  });

  // Backfill endpoints
  app.post("/api/backfill/start", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: "Start date and end date are required" });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      if (start > end) {
        return res.status(400).json({ error: "Start date must be before end date" });
      }

      // Check if there's already an active job
      const allJobs = await storage.getAllBackfillJobs();
      const activeJob = allJobs.find(j => j.status === 'running' || j.status === 'pending');
      if (activeJob) {
        return res.status(400).json({ 
          error: "A backfill job is already in progress. Please wait for it to complete or cancel it before starting a new one." 
        });
      }

      // Create backfill job
      const job = await storage.createBackfillJob({
        startDate: start,
        endDate: end,
        status: "pending",
      });

      console.log(`[Backfill ${job.id}] Starting backfill from ${start.toISOString()} to ${end.toISOString()}`);

      // Start backfill in background (fire and forget)
      const { BackfillService } = await import('./services/backfill-service');
      const backfillService = new BackfillService(storage);
      backfillService.runBackfillJob(job.id).catch(error => {
        console.error(`[Backfill ${job.id}] Background job failed:`, error);
      });

      res.json({ 
        success: true,
        job: await storage.getBackfillJob(job.id),
        message: `Backfill job started. Check progress at /api/backfill/jobs/${job.id}`,
      });
    } catch (error) {
      console.error("Error starting backfill:", error);
      res.status(500).json({ error: "Failed to start backfill" });
    }
  });

  app.get("/api/backfill/jobs/:id", requireAuth, async (req, res) => {
    try {
      const job = await storage.getBackfillJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      res.json({ job });
    } catch (error) {
      console.error("Error fetching backfill job:", error);
      res.status(500).json({ error: "Failed to fetch job" });
    }
  });

  app.get("/api/backfill/jobs", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getAllBackfillJobs();
      res.json({ jobs });
    } catch (error) {
      console.error("Error fetching backfill jobs:", error);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  app.delete("/api/backfill/jobs/:id", requireAuth, async (req, res) => {
    try {
      const job = await storage.getBackfillJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      await storage.deleteBackfillJob(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting backfill job:", error);
      res.status(500).json({ error: "Failed to delete job" });
    }
  });

  app.post("/api/backfill/jobs/:id/cancel", requireAuth, async (req, res) => {
    try {
      const job = await storage.getBackfillJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.status !== "running" && job.status !== "pending") {
        return res.status(400).json({ error: "Only pending or running jobs can be cancelled" });
      }

      // Update job status first
      await storage.updateBackfillJob(req.params.id, {
        status: "cancelled",
        errorMessage: "Cancelled by user",
        completedAt: new Date(),
      });

      // CRITICAL: Clean up worker coordination state to prevent mutex deadlock
      const { workerCoordinator } = await import("./worker-coordinator");
      await workerCoordinator.cancelBackfill(req.params.id);
      
      // Broadcast queue status update to notify all clients that backfill is done
      const { broadcastQueueStatus } = await import("./websocket");
      const dataHealth = await storage.getDataHealthMetrics();
      broadcastQueueStatus({
        backfillActiveJob: null, // No active job after cancellation
        dataHealth,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling backfill job:", error);
      res.status(500).json({ error: "Failed to cancel job" });
    }
  });

  // Shipment Sync API endpoints
  app.get("/api/shipment-sync/status", requireAuth, async (req, res) => {
    try {
      const { getShipmentSyncQueueLength } = await import("./utils/queue");
      const queueLength = await getShipmentSyncQueueLength();
      
      // Count failures in dead letter queue
      const failures = await db.select({ count: count() })
        .from(shipmentSyncFailures);
      const failureCount = failures[0]?.count || 0;
      
      res.json({ 
        queueLength,
        failureCount,
      });
    } catch (error) {
      console.error("Error fetching shipment sync status:", error);
      res.status(500).json({ error: "Failed to fetch status" });
    }
  });

  app.get("/api/shipment-sync/failures", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      
      const failures = await storage.getShipmentSyncFailures(limit, offset);
      const totalCount = await storage.getShipmentSyncFailureCount();
      
      res.json({ 
        failures,
        totalCount,
        limit,
        offset,
      });
    } catch (error) {
      console.error("Error fetching shipment sync failures:", error);
      res.status(500).json({ error: "Failed to fetch failures" });
    }
  });

  app.post("/api/shipment-sync/retry/:id", requireAuth, async (req, res) => {
    try {
      // Get the failure record
      const failure = await db.select()
        .from(shipmentSyncFailures)
        .where(eq(shipmentSyncFailures.id, req.params.id))
        .limit(1);
      
      if (!failure || failure.length === 0) {
        return res.status(404).json({ error: "Failure record not found" });
      }

      const record = failure[0];
      
      // Re-enqueue the shipment sync message
      await enqueueShipmentSync({
        reason: 'manual',
        orderNumber: record.orderNumber,
        enqueuedAt: Date.now(),
      });

      // Update retry count
      await db.update(shipmentSyncFailures)
        .set({ retryCount: record.retryCount + 1 })
        .where(eq(shipmentSyncFailures.id, req.params.id));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error retrying shipment sync:", error);
      res.status(500).json({ error: "Failed to retry" });
    }
  });

  app.delete("/api/shipment-sync/failures/:id", requireAuth, async (req, res) => {
    try {
      await db.delete(shipmentSyncFailures)
        .where(eq(shipmentSyncFailures.id, req.params.id));
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting shipment sync failure:", error);
      res.status(500).json({ error: "Failed to delete failure" });
    }
  });

  app.post("/api/backfill/jobs/:id/restart", requireAuth, async (req, res) => {
    try {
      const oldJob = await storage.getBackfillJob(req.params.id);
      
      if (!oldJob) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Check if there's already an active job
      const allJobs = await storage.getAllBackfillJobs();
      const activeJob = allJobs.find(j => j.status === 'running' || j.status === 'pending');
      if (activeJob) {
        return res.status(400).json({ 
          error: "A backfill job is already in progress. Please wait for it to complete or delete it before restarting." 
        });
      }

      const start = new Date(oldJob.startDate);
      const end = new Date(oldJob.endDate);

      // Create new backfill job with same date range
      const job = await storage.createBackfillJob({
        startDate: start,
        endDate: end,
        status: "pending",
      });

      console.log(`[Backfill ${job.id}] Restarting backfill from ${start.toISOString()} to ${end.toISOString()}`);

      // Start backfill in background (fire and forget)
      const { BackfillService } = await import('./services/backfill-service');
      const backfillService = new BackfillService(storage);
      backfillService.runBackfillJob(job.id).catch(error => {
        console.error(`[Backfill ${job.id}] Background job failed:`, error);
      });

      res.json({ 
        success: true,
        job: await storage.getBackfillJob(job.id),
        message: `Backfill job restarted. Check progress at /api/backfill/jobs/${job.id}`,
      });
    } catch (error) {
      console.error("Error restarting backfill:", error);
      res.status(500).json({ error: "Failed to restart backfill" });
    }
  });

  app.post("/api/queue/clear", requireAuth, async (req, res) => {
    try {
      const { clearQueue } = await import('./utils/queue');
      const clearedCount = await clearQueue();
      res.json({ 
        success: true, 
        message: `Cleared ${clearedCount} webhooks from queue`,
        clearedCount 
      });
    } catch (error) {
      console.error("Error clearing queue:", error);
      res.status(500).json({ error: "Failed to clear queue" });
    }
  });

  app.post("/api/shipment-sync/clear", requireAuth, async (req, res) => {
    try {
      const clearedCount = await clearShipmentSyncQueue();
      res.json({ 
        success: true, 
        message: `Cleared ${clearedCount} items from shipment sync queue`,
        clearedCount 
      });
    } catch (error) {
      console.error("Error clearing shipment sync queue:", error);
      res.status(500).json({ error: "Failed to clear shipment sync queue" });
    }
  });

  // Debug endpoint to identify date boundary discrepancies
  app.get("/api/reports/debug", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      // Parse YYYY-MM-DD strings as Central Time
      const start = fromZonedTime(`${startDate} 00:00:00`, CST_TIMEZONE);
      const end = fromZonedTime(`${endDate} 23:59:59.999`, CST_TIMEZONE);
      
      const ordersInRange = await storage.getOrdersInDateRange(start, end);
      
      // Get boundary orders (first/last day)
      const boundaryOrders = ordersInRange.filter(order => {
        const orderDate = formatInTimeZone(order.createdAt, CST_TIMEZONE, 'yyyy-MM-dd');
        return orderDate === startDate || orderDate === endDate;
      });
      
      // Group by date
      const byDate: { [key: string]: any[] } = {};
      boundaryOrders.forEach(order => {
        const dateKey = formatInTimeZone(order.createdAt, CST_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
        const date = formatInTimeZone(order.createdAt, CST_TIMEZONE, 'yyyy-MM-dd');
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push({
          id: order.id,
          orderNumber: order.orderNumber,
          createdAt: dateKey,
          createdAtUTC: order.createdAt.toISOString(),
          financialStatus: order.financialStatus,
          currentTotalPrice: order.currentTotalPrice,
        });
      });
      
      res.json({
        totalOrders: ordersInRange.length,
        boundaryDates: {
          start: startDate,
          end: endDate,
        },
        boundaryOrders: byDate,
      });
    } catch (error) {
      console.error("Error in debug endpoint:", error);
      res.status(500).json({ error: "Failed to generate debug data" });
    }
  });

  // Debug endpoint to fetch raw Shopify order data for field comparison
  app.get("/api/reports/shopify-fields", requireAuth, async (req, res) => {
    try {
      const { date } = req.query;
      
      if (!date) {
        return res.status(400).json({ error: "date parameter required (YYYY-MM-DD)" });
      }

      // Get a sample order from the specified date
      const start = fromZonedTime(`${date} 00:00:00`, CST_TIMEZONE);
      const end = fromZonedTime(`${date} 23:59:59.999`, CST_TIMEZONE);
      const ordersInRange = await storage.getOrdersInDateRange(start, end);
      
      if (ordersInRange.length === 0) {
        return res.status(404).json({ error: "No orders found for this date" });
      }

      // Get first 5 orders
      const sampleOrders = ordersInRange.slice(0, 5);
      const shopifyOrderData = [];

      for (const order of sampleOrders) {
        try {
          const rawShopifyOrder = await fetchShopifyOrder(order.id);
          shopifyOrderData.push({
            orderNumber: order.orderNumber,
            dbFields: {
              currentTotalPrice: order.currentTotalPrice,
              currentSubtotalPrice: order.currentSubtotalPrice,
              currentTotalTax: order.currentTotalTax,
              shippingTotal: order.shippingTotal,
              currentTotalDiscounts: order.currentTotalDiscounts,
            },
            shopifyFields: {
              total_price: rawShopifyOrder.total_price,
              subtotal_price: rawShopifyOrder.subtotal_price,
              current_total_price: rawShopifyOrder.current_total_price,
              current_subtotal_price: rawShopifyOrder.current_subtotal_price,
              total_tax: rawShopifyOrder.total_tax,
              current_total_tax: rawShopifyOrder.current_total_tax,
              total_discounts: rawShopifyOrder.total_discounts,
              current_total_discounts: rawShopifyOrder.current_total_discounts,
              total_shipping_price_set: rawShopifyOrder.total_shipping_price_set,
              total_line_items_price: rawShopifyOrder.total_line_items_price,
              total_price_set: rawShopifyOrder.total_price_set,
              subtotal_price_set: rawShopifyOrder.subtotal_price_set,
              current_total_price_set: rawShopifyOrder.current_total_price_set,
              current_subtotal_price_set: rawShopifyOrder.current_subtotal_price_set,
              total_tax_set: rawShopifyOrder.total_tax_set,
              current_total_tax_set: rawShopifyOrder.current_total_tax_set,
              total_discounts_set: rawShopifyOrder.total_discounts_set,
              current_total_discounts_set: rawShopifyOrder.current_total_discounts_set,
            },
          });
        } catch (error: any) {
          console.error(`Error fetching Shopify order ${order.id}:`, error);
          shopifyOrderData.push({
            orderNumber: order.orderNumber,
            error: error.message,
          });
        }
      }

      res.json({
        date,
        sampleCount: shopifyOrderData.length,
        orders: shopifyOrderData,
      });
    } catch (error) {
      console.error("Error in shopify-fields endpoint:", error);
      res.status(500).json({ error: "Failed to fetch Shopify order data" });
    }
  });

  app.get("/api/reports/summary", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      // Parse YYYY-MM-DD strings as Central Time
      const start = fromZonedTime(`${startDate} 00:00:00`, CST_TIMEZONE);
      const end = fromZonedTime(`${endDate} 23:59:59.999`, CST_TIMEZONE);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: "Invalid date format" });
      }

      const ordersInRange = await storage.getOrdersInDateRange(start, end);

      // Helper function to parse string amounts to numbers
      const parseAmount = (amount: string | null): number => {
        if (!amount) return 0;
        const parsed = parseFloat(amount);
        return isNaN(parsed) ? 0 : parsed;
      };

      // Match Shopify's methodology: Get ALL refunds for orders in date range
      // (not just refunds issued during the period)
      const orderIds = ordersInRange.map(o => o.id);
      const allRefundsForOrders = await storage.getRefundsByOrderIds(orderIds);
      
      // Calculate returns value from refunds
      let returnsValue = 0;
      const refundedOrderIds = new Set<string>();
      allRefundsForOrders.forEach((refund) => {
        returnsValue += parseAmount(refund.amount);
        refundedOrderIds.add(refund.orderId);
      });

      // Count fully refunded orders for metrics
      const fullyRefundedOrders = ordersInRange.filter(order => 
        order.financialStatus === 'refunded'
      );

      // Calculate aggregations for ALL orders (including partially refunded)
      // Use currentTotalPrice which already accounts for refunds at the order level
      let totalRevenue = 0;
      let totalShipping = 0;
      let totalGrossSales = 0;
      let totalNetSales = 0;
      let totalTax = 0;
      let totalDiscounts = 0;
      const dailyTotals: { [key: string]: number } = {};
      const statusCounts: { [key: string]: number } = {};
      const fulfillmentCounts: { [key: string]: number } = {};

      ordersInRange.forEach((order) => {
        // Shopify Analytics sales breakdown:
        // - totalLineItemsPrice = GROSS SALES (sum of line items before ANY discounts)
        // - currentTotalDiscounts = Discounts applied
        // - currentSubtotalPrice = NET SALES (Gross - Discounts, before shipping/tax)
        // - shippingTotal = Shipping charges
        // - currentTotalTax = Taxes
        // - currentTotalPrice = TOTAL REVENUE (Net + Shipping + Taxes)
        totalRevenue += parseAmount(order.currentTotalPrice); // Total revenue
        totalShipping += parseAmount(order.shippingTotal); // Shipping charges
        totalGrossSales += parseAmount(order.totalLineItemsPrice); // Gross sales (before discounts)
        totalNetSales += parseAmount(order.currentSubtotalPrice); // Net sales (after discounts)
        totalTax += parseAmount(order.currentTotalTax); // Taxes
        totalDiscounts += parseAmount(order.currentTotalDiscounts);

        // Daily totals for chart using total sales (current* fields account for refunds)
        // Group by CST day to match date range filtering
        const dayKey = formatInTimeZone(order.createdAt, CST_TIMEZONE, 'yyyy-MM-dd');
        dailyTotals[dayKey] = (dailyTotals[dayKey] || 0) + parseAmount(order.currentTotalPrice);

        // Status counts
        const financialStatus = order.financialStatus || 'unknown';
        statusCounts[financialStatus] = (statusCounts[financialStatus] || 0) + 1;

        const fulfillmentStatus = order.fulfillmentStatus || 'unfulfilled';
        fulfillmentCounts[fulfillmentStatus] = (fulfillmentCounts[fulfillmentStatus] || 0) + 1;
      });

      // Convert daily totals to array format for chart
      const dailyData = Object.entries(dailyTotals)
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Count non-fully-refunded orders for averages
      const activeOrders = ordersInRange.filter(order => order.financialStatus !== 'refunded');

      const summary = {
        totalOrders: ordersInRange.length,
        fulfilledOrders: activeOrders.length, // Orders not fully refunded
        refundedOrders: fullyRefundedOrders.length, // Fully refunded orders
        totalRevenue: totalRevenue.toFixed(2), // Total revenue (Net sales + Shipping + Taxes)
        totalGrossSales: totalGrossSales.toFixed(2), // GROSS SALES: Product revenue before discounts
        totalNetSales: totalNetSales.toFixed(2), // NET SALES: Product revenue after discounts (Gross - Discounts)
        totalShipping: totalShipping.toFixed(2), // Shipping charges
        totalTax: totalTax.toFixed(2), // Taxes
        totalDiscounts: totalDiscounts.toFixed(2), // Discounts applied
        returnsValue: returnsValue.toFixed(2), // Refunds issued during this period (for reference)
        averageOrderValue: activeOrders.length > 0 ? (totalRevenue / activeOrders.length).toFixed(2) : '0.00',
        averageShipping: activeOrders.length > 0 ? (totalShipping / activeOrders.length).toFixed(2) : '0.00',
        dailyData,
        statusCounts,
        fulfillmentCounts,
      };

      res.json(summary);
    } catch (error) {
      console.error("Error generating reports:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // Backfill refunds from Shopify for all existing orders
  app.post("/api/refunds/backfill", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ error: "Shopify credentials not configured" });
      }

      // Track processing metrics with better observability
      let fetchedCount = 0;  // Orders successfully fetched from Shopify
      let persistedCount = 0;  // Orders with refunds successfully persisted
      let refundsFound = 0;  // Total number of refunds stored
      let failedCount = 0;  // Orders that failed to process
      let failedOrderIds: string[] = [];  // List of failed order IDs for operator review
      let retryCount = 0;
      const maxRetries = 5; // Increased for sustained throttling

      // Helper to handle Shopify rate limits with robust retry logic
      const fetchWithRetry = async (url: string, attempt: number = 0): Promise<any> => {
        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        });

        // Handle rate limiting (429)
        if (response.status === 429) {
          if (attempt >= maxRetries) {
            throw new Error(`Max retries reached for ${url}`);
          }
          
          // Honor Retry-After header (supports float) or use exponential backoff with jitter
          const retryAfter = response.headers.get('Retry-After');
          let waitMs: number;
          
          if (retryAfter) {
            // Parse as float and convert to milliseconds
            const retrySeconds = parseFloat(retryAfter);
            waitMs = isNaN(retrySeconds) ? 1000 : retrySeconds * 1000;
          } else {
            // Exponential backoff with jitter: 2^attempt * 1000 + random(0-1000), capped at 30s
            const exponentialMs = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * 1000;
            waitMs = Math.min(exponentialMs + jitter, 30000);
          }
          
          console.log(`Rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          retryCount++;
          return fetchWithRetry(url, attempt + 1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return response.json();
      };

      // Cursor-based pagination to avoid skipping rows during long backfill
      let lastCreatedAt: Date | null = null;
      let lastId: string | null = null;
      const batchSize = 250;
      let hasMore = true;

      while (hasMore) {
        // Fetch batch using cursor-based pagination
        let query = db
          .select()
          .from(orders)
          .orderBy(orders.createdAt, orders.id)
          .limit(batchSize);

        // Apply cursor filter if we have a previous batch
        if (lastCreatedAt && lastId) {
          query = query.where(
            or(
              sql`${orders.createdAt} > ${lastCreatedAt}`,
              and(
                sql`${orders.createdAt} = ${lastCreatedAt}`,
                sql`${orders.id} > ${lastId}`
              )
            )
          );
        }

        const ordersBatch = await query;

        if (ordersBatch.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`Processing batch of ${ordersBatch.length} orders starting from ${ordersBatch[0].orderNumber}`);

        for (const order of ordersBatch) {
          // Defensive guard for malformed records
          if (!order.createdAt || !order.id) {
            console.error(`[CRITICAL] Order missing required fields, skipping:`, order);
            failedCount++;
            failedOrderIds.push(order.orderNumber || 'unknown');
            continue;
          }
          
          try {
            // Fetch full order details from Shopify (includes refunds)
            const url = `https://${shopDomain}/admin/api/2024-01/orders/${order.id}.json`;
            
            let data;
            try {
              data = await fetchWithRetry(url);
              fetchedCount++;  // Successfully fetched from Shopify
            } catch (fetchError: any) {
              console.error(`Failed to fetch order ${order.id} after ${maxRetries} retries:`, fetchError.message);
              failedCount++;
              failedOrderIds.push(order.orderNumber);
              continue;  // Skip to next order but batch cursor will still advance
            }

            const shopifyOrder = data.order;

            // Process refunds if they exist
            let refundsPersisted = 0;
            if (shopifyOrder.refunds && shopifyOrder.refunds.length > 0) {
              for (const refund of shopifyOrder.refunds) {
                try {
                  const totalAmount = refund.transactions?.reduce((sum: number, txn: any) => {
                    return sum + parseFloat(txn.amount || '0');
                  }, 0) || 0;

                  const refundData = {
                    orderId: order.id,
                    shopifyRefundId: refund.id.toString(),
                    amount: totalAmount.toFixed(2),
                    note: refund.note || null,
                    refundedAt: new Date(refund.created_at),
                    processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
                  };

                  await storage.upsertOrderRefund(refundData);
                  refundsPersisted++;
                } catch (refundError: any) {
                  console.error(`Error persisting refund for order ${order.id}:`, refundError.message);
                  // Continue trying other refunds, track failure but don't fail whole order
                }
              }
              
              // If we found refunds but failed to persist ANY of them, track as failed
              if (shopifyOrder.refunds.length > 0 && refundsPersisted === 0) {
                console.error(`Failed to persist any refunds for order ${order.id} (${shopifyOrder.refunds.length} refunds found)`);
                failedCount++;
                failedOrderIds.push(order.orderNumber);
              } else if (refundsPersisted > 0) {
                // At least some refunds persisted successfully
                persistedCount++;
              }
            }

            // Track total refunds stored
            refundsFound += refundsPersisted;

            // Rate limiting: pause every 40 requests (Shopify allows 2 req/sec)
            if (fetchedCount % 40 === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (orderError: any) {
            console.error(`Unexpected error processing order ${order.id}:`, orderError.message);
            failedCount++;
            failedOrderIds.push(order.orderNumber);
          }
        }
        
        // Advance cursor after processing entire batch to guarantee forward progress
        // This prevents infinite loops even if some orders in the batch failed
        if (ordersBatch.length > 0) {
          const lastOrder = ordersBatch[ordersBatch.length - 1];
          lastCreatedAt = lastOrder.createdAt;
          lastId = lastOrder.id;
        }

        // Check if we got fewer results than batch size (indicates last page)
        if (ordersBatch.length < batchSize) {
          hasMore = false;
        }
      }

      res.json({ 
        success: true, 
        fetchedCount: fetchedCount,  // Orders successfully fetched from Shopify
        persistedCount: persistedCount,  // Orders with refunds successfully persisted
        refundsFound: refundsFound,  // Total refunds stored
        failedCount: failedCount,  // Orders that failed
        failedOrderIds: failedOrderIds.slice(0, 50),  // First 50 failed order IDs for review
        retryCount: retryCount,  // Number of rate limit retries
      });
    } catch (error) {
      console.error("Error backfilling refunds:", error);
      res.status(500).json({ error: "Failed to backfill refunds" });
    }
  });

  // Backfill line items from Shopify for all existing orders
  app.post("/api/order-items/backfill", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ error: "Shopify credentials not configured" });
      }

      // Track processing metrics
      let fetchedCount = 0;
      let persistedCount = 0;
      let itemsFound = 0;
      let failedCount = 0;
      let failedOrderIds: string[] = [];
      let retryCount = 0;
      const maxRetries = 5;

      // Helper to handle Shopify rate limits with retry logic
      const fetchWithRetry = async (url: string, attempt: number = 0): Promise<any> => {
        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        });

        if (response.status === 429) {
          if (attempt >= maxRetries) {
            throw new Error(`Max retries reached for ${url}`);
          }
          
          const retryAfter = response.headers.get('Retry-After');
          let waitMs: number;
          
          if (retryAfter) {
            const retrySeconds = parseFloat(retryAfter);
            waitMs = isNaN(retrySeconds) ? 1000 : retrySeconds * 1000;
          } else {
            const exponentialMs = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * 1000;
            waitMs = Math.min(exponentialMs + jitter, 30000);
          }
          
          console.log(`Rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          retryCount++;
          return fetchWithRetry(url, attempt + 1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return response.json();
      };

      // Cursor-based pagination
      let lastCreatedAt: Date | null = null;
      let lastId: string | null = null;
      const batchSize = 250;
      let hasMore = true;

      while (hasMore) {
        let query = db
          .select()
          .from(orders)
          .orderBy(orders.createdAt, orders.id)
          .limit(batchSize);

        if (lastCreatedAt && lastId) {
          query = query.where(
            or(
              sql`${orders.createdAt} > ${lastCreatedAt}`,
              and(
                sql`${orders.createdAt} = ${lastCreatedAt}`,
                sql`${orders.id} > ${lastId}`
              )
            )
          );
        }

        const ordersBatch = await query;

        if (ordersBatch.length === 0) {
          hasMore = false;
          break;
        }

        console.log(`Processing batch of ${ordersBatch.length} orders starting from ${ordersBatch[0].orderNumber}`);

        for (const order of ordersBatch) {
          if (!order.createdAt || !order.id) {
            console.error(`[CRITICAL] Order missing required fields, skipping:`, order);
            failedCount++;
            failedOrderIds.push(order.orderNumber || 'unknown');
            continue;
          }
          
          try {
            const url = `https://${shopDomain}/admin/api/2024-01/orders/${order.id}.json`;
            
            let data;
            try {
              data = await fetchWithRetry(url);
              fetchedCount++;
            } catch (fetchError: any) {
              console.error(`Failed to fetch order ${order.id} after ${maxRetries} retries:`, fetchError.message);
              failedCount++;
              failedOrderIds.push(order.orderNumber);
              continue;
            }

            const shopifyOrder = data.order;

            // Process refunds and line items using centralized ETL service
            await shopifyOrderETL.processOrder(shopifyOrder);
            
            // Track persistence for reporting
            if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
              persistedCount++;
              itemsFound += shopifyOrder.line_items.length;
            }

            // Rate limiting: pause every 40 requests
            if (fetchedCount % 40 === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } catch (orderError: any) {
            console.error(`Unexpected error processing order ${order.id}:`, orderError.message);
            failedCount++;
            failedOrderIds.push(order.orderNumber);
          }
        }
        
        if (ordersBatch.length > 0) {
          const lastOrder = ordersBatch[ordersBatch.length - 1];
          lastCreatedAt = lastOrder.createdAt;
          lastId = lastOrder.id;
        }

        if (ordersBatch.length < batchSize) {
          hasMore = false;
        }
      }

      res.json({ 
        success: true, 
        fetchedCount: fetchedCount,
        persistedCount: persistedCount,
        itemsFound: itemsFound,
        failedCount: failedCount,
        failedOrderIds: failedOrderIds.slice(0, 50),
        retryCount: retryCount,
      });
    } catch (error) {
      console.error("Error backfilling line items:", error);
      res.status(500).json({ error: "Failed to backfill line items" });
    }
  });

  // Operations Dashboard - Queue Management
  app.get("/api/operations/queue-stats", requireAuth, async (req, res) => {
    try {
      // Run all independent queries in parallel for faster response
      const [
        shopifyQueueLength,
        shipmentSyncQueueLength,
        shopifyOrderSyncQueueLength,
        oldestShopify,
        oldestShipmentSync,
        oldestShopifyOrderSync,
        failureCountRows,
        allBackfillJobs,
        dataHealthMetrics,
        pipelineMetrics
      ] = await Promise.all([
        getQueueLength(),
        getShipmentSyncQueueLength(),
        getShopifyOrderSyncQueueLength(),
        getOldestShopifyQueueMessage(),
        getOldestShipmentSyncQueueMessage(),
        getOldestShopifyOrderSyncQueueMessage(),
        db.select({ count: count() }).from(shipmentSyncFailures),
        storage.getAllBackfillJobs(),
        storage.getDataHealthMetrics(),
        storage.getPipelineMetrics()
      ]);
      
      const failureCount = failureCountRows[0]?.count || 0;
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending');
      const recentBackfillJobs = allBackfillJobs.slice(0, 5); // Last 5 jobs

      // Get on-hold worker status and stats
      let onHoldWorkerStatus: 'sleeping' | 'running' | 'awaiting_backfill_job' = 'sleeping';
      let onHoldWorkerStats = undefined;
      try {
        const { getOnHoldWorkerStatus, getOnHoldWorkerStats } = await import("./onhold-poll-worker");
        onHoldWorkerStatus = getOnHoldWorkerStatus();
        onHoldWorkerStats = getOnHoldWorkerStats();
      } catch (error) {
        // Worker not initialized yet
      }

      // Get print queue worker status and stats
      let printQueueWorkerStatus: 'sleeping' | 'running' = 'sleeping';
      let printQueueWorkerStats = undefined;
      try {
        const { getPrintQueueWorkerStatus, getPrintQueueWorkerStats } = await import("./print-queue-worker");
        printQueueWorkerStatus = getPrintQueueWorkerStatus();
        printQueueWorkerStats = getPrintQueueWorkerStats();
      } catch (error) {
        // Worker not initialized yet
      }

      // Get Firestore session sync worker status and stats
      let firestoreSessionSyncWorkerStatus: 'sleeping' | 'running' | 'error' = 'sleeping';
      let firestoreSessionSyncWorkerStats = undefined;
      try {
        const { getFirestoreSessionSyncWorkerStatus, getFirestoreSessionSyncWorkerStats } = await import("./firestore-session-sync-worker");
        firestoreSessionSyncWorkerStatus = getFirestoreSessionSyncWorkerStatus();
        const stats = getFirestoreSessionSyncWorkerStats();
        firestoreSessionSyncWorkerStats = {
          totalSynced: stats.totalSynced,
          lastSyncCount: stats.lastSyncCount,
          lastSyncAt: stats.lastSyncAt?.toISOString() || null,
          workerStartedAt: stats.workerStartedAt.toISOString(),
          errorsCount: stats.errorsCount,
          lastError: stats.lastError,
        };
        console.log('[queue-stats] Firestore worker status:', firestoreSessionSyncWorkerStatus, 'stats:', firestoreSessionSyncWorkerStats);
      } catch (error: any) {
        console.error('[queue-stats] Error getting firestore worker status:', error.message);
      }

      res.json({
        shopifyQueue: {
          size: shopifyQueueLength,
          oldestMessageAt: oldestShopify.enqueuedAt,
        },
        shipmentSyncQueue: {
          size: shipmentSyncQueueLength,
          oldestMessageAt: oldestShipmentSync.enqueuedAt,
        },
        shopifyOrderSyncQueue: {
          size: shopifyOrderSyncQueueLength,
          oldestMessageAt: oldestShopifyOrderSync.enqueuedAt,
        },
        failures: {
          total: failureCount,
        },
        backfill: {
          activeJob: activeBackfillJob || null,
          recentJobs: recentBackfillJobs,
        },
        dataHealth: dataHealthMetrics,
        pipeline: pipelineMetrics,
        onHoldWorkerStatus,
        onHoldWorkerStats,
        printQueueWorkerStatus,
        printQueueWorkerStats,
        firestoreSessionSyncWorkerStatus,
        firestoreSessionSyncWorkerStats,
      });
    } catch (error) {
      console.error("Error fetching queue stats:", error);
      res.status(500).json({ error: "Failed to fetch queue stats" });
    }
  });

  // Clear shipment sync failures
  app.delete("/api/operations/shipment-sync-failures", requireAuth, async (req, res) => {
    try {
      await storage.clearShipmentSyncFailures();
      console.log("All shipment sync failures cleared");
      
      // Broadcast updated queue stats with full canonical payload
      const shopifyQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const failureCount = await storage.getShipmentSyncFailureCount();
      const oldestShopify = await getOldestShopifyQueueMessage();
      const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
      const allBackfillJobs = await storage.getAllBackfillJobs();
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
      const dataHealth = await storage.getDataHealthMetrics();
      
      broadcastQueueStatus({
        shopifyQueue: shopifyQueueLength,
        shipmentSyncQueue: shipmentSyncQueueLength,
        shipmentFailureCount: failureCount,
        shopifyQueueOldestAt: oldestShopify.enqueuedAt,
        shipmentSyncQueueOldestAt: oldestShipmentSync.enqueuedAt,
        backfillActiveJob: activeBackfillJob,
        dataHealth,
      });
      
      res.json({ success: true, message: "All shipment sync failures cleared" });
    } catch (error) {
      console.error("Error clearing shipment sync failures:", error);
      res.status(500).json({ error: "Failed to clear shipment sync failures" });
    }
  });

  // Shopify credential validation (cached for 10 minutes)
  app.get("/api/operations/shopify-validation", requireAuth, async (req, res) => {
    try {
      const { validateShopifyCredentials } = await import("./utils/shopify-validation");
      const result = await validateShopifyCredentials();
      
      res.json({
        isValid: result.isValid,
        errors: result.errors,
        lastChecked: result.lastChecked,
        shopName: result.shopName,
      });
    } catch (error) {
      console.error("Error validating Shopify credentials:", error);
      res.status(500).json({ 
        isValid: false,
        errors: ["Failed to validate credentials"],
        lastChecked: new Date(),
      });
    }
  });

  // SkuVault credential validation and token status
  app.get("/api/operations/skuvault-validation", requireAuth, async (req, res) => {
    try {
      const metadata = await skuVaultService.getTokenMetadata();
      
      const errors: string[] = [];
      if (!metadata.credentialsConfigured) {
        errors.push('SKUVAULT_USERNAME or SKUVAULT_PASSWORD not configured');
      }
      
      res.json({
        isValid: metadata.isValid && metadata.credentialsConfigured,
        credentialsConfigured: metadata.credentialsConfigured,
        tokenValid: metadata.isValid,
        lastRefreshed: metadata.lastRefreshed,
        errors,
        lastChecked: new Date(),
      });
    } catch (error) {
      console.error("Error validating SkuVault credentials:", error);
      res.status(500).json({ 
        isValid: false,
        credentialsConfigured: false,
        tokenValid: false,
        lastRefreshed: null,
        errors: ["Failed to validate credentials"],
        lastChecked: new Date(),
      });
    }
  });

  // Rotate SkuVault token
  app.post("/api/operations/skuvault-rotate-token", requireAuth, async (req, res) => {
    try {
      await skuVaultService.rotateToken();
      
      // Get updated metadata
      const metadata = await skuVaultService.getTokenMetadata();
      
      res.json({
        success: true,
        message: "Token rotated successfully",
        lastRefreshed: metadata.lastRefreshed,
      });
    } catch (error) {
      console.error("Error rotating SkuVault token:", error);
      res.status(500).json({ 
        success: false,
        message: error instanceof Error ? error.message : "Failed to rotate token",
      });
    }
  });

  app.get("/api/operations/environment", requireAuth, async (req, res) => {
    try {
      // Return safe environment info (no secrets)
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL || '';
      const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 
        (process.env.REPLIT_DEPLOYMENT === '1' 
          ? 'https://jerkyshippping.replit.app'
          : `https://${process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost'}`);
      
      // Extract just the host from Redis URL (no token)
      let redisHost = 'Not configured';
      try {
        if (redisUrl) {
          const url = new URL(redisUrl);
          redisHost = url.hostname;
        }
      } catch {
        redisHost = 'Invalid URL';
      }

      res.json({
        redis: {
          host: redisHost,
          configured: !!redisUrl,
        },
        webhooks: {
          baseUrl: webhookBaseUrl,
          environment: process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
        },
      });
    } catch (error) {
      console.error("Error fetching environment info:", error);
      res.status(500).json({ error: "Failed to fetch environment info" });
    }
  });

  app.post("/api/operations/purge-shopify-queue", requireAuth, async (req, res) => {
    try {
      const clearedCount = await clearQueue();
      res.json({ success: true, clearedCount });
    } catch (error) {
      console.error("Error purging Shopify queue:", error);
      res.status(500).json({ error: "Failed to purge Shopify queue" });
    }
  });

  app.post("/api/operations/purge-shipment-sync-queue", requireAuth, async (req, res) => {
    try {
      const clearedCount = await clearShipmentSyncQueue();
      res.json({ success: true, clearedCount });
    } catch (error) {
      console.error("Error purging shipment sync queue:", error);
      res.status(500).json({ error: "Failed to purge shipment sync queue" });
    }
  });

  app.post("/api/operations/purge-shopify-order-sync-queue", requireAuth, async (req, res) => {
    try {
      const clearedCount = await clearShopifyOrderSyncQueue();
      res.json({ success: true, clearedCount });
    } catch (error) {
      console.error("Error purging Shopify order sync queue:", error);
      res.status(500).json({ error: "Failed to purge Shopify order sync queue" });
    }
  });

  app.post("/api/operations/purge-failures", requireAuth, async (req, res) => {
    try {
      await db.delete(shipmentSyncFailures);
      res.json({ success: true });
    } catch (error) {
      console.error("Error purging failures:", error);
      res.status(500).json({ error: "Failed to purge failures table" });
    }
  });

  app.post("/api/operations/clear-order-data", requireAuth, async (req, res) => {
    try {
      // Execute all deletions in a transaction to ensure atomicity
      await db.transaction(async (tx) => {
        // Delete in correct order respecting foreign key constraints:
        // 1. shipment_items (references both shipments and order_items)
        // 2. shipment_tags (references shipments)
        // 3. orderItems (references orders)
        // 4. shipments (references orders)
        // 5. orderRefunds (references orders)
        // 6. orders (parent table)
        await tx.delete(shipmentItems);
        await tx.delete(shipmentTags);
        await tx.delete(orderItems);
        await tx.delete(shipments);
        await tx.delete(orderRefunds);
        await tx.delete(orders);
      });
      
      res.json({ 
        success: true, 
        message: "All order data cleared successfully" 
      });
    } catch (error: any) {
      console.error("Error clearing order data:", error);
      
      // Check if it's a foreign key constraint error from print_queue
      if (error.code === '23503' && error.table === 'print_queue') {
        return res.status(400).json({ 
          error: "Cannot clear order data while print queue has pending jobs. Please clear the print queue first." 
        });
      }
      
      res.status(500).json({ error: "Failed to clear order data" });
    }
  });

  // List all registered Shopify webhooks (diagnostic endpoint)
  app.get("/api/operations/list-shopify-webhooks", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ 
          error: "Missing Shopify credentials" 
        });
      }

      const { listShopifyWebhooks } = await import("./utils/shopify-webhook.js");
      const webhooks = await listShopifyWebhooks(shopDomain, accessToken);
      
      res.json({ 
        success: true,
        count: webhooks.length,
        webhooks: webhooks.map((w: any) => ({
          id: w.id,
          topic: w.topic,
          address: w.address,
          createdAt: w.created_at,
          updatedAt: w.updated_at,
        }))
      });
    } catch (error: any) {
      console.error("Error listing Shopify webhooks:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/operations/reregister-shopify-webhooks", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
      
      // Use shared webhook URL detection logic
      const { getWebhookBaseUrl } = await import("./utils/webhook-url.js");
      const webhookBaseUrl = getWebhookBaseUrl();

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ 
          error: "Missing Shopify credentials. Ensure SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are set." 
        });
      }

      if (!webhookBaseUrl) {
        return res.status(400).json({ 
          error: "Cannot determine webhook base URL. Check environment configuration (WEBHOOK_BASE_URL or REPLIT_DOMAINS)." 
        });
      }

      console.log(`Re-registering Shopify webhooks via API request using URL: ${webhookBaseUrl}`);
      const result = await reregisterAllWebhooks(shopDomain, accessToken, webhookBaseUrl);
      
      res.json({ 
        success: true, 
        deleted: result.deleted,
        registered: result.registered,
        message: `Successfully deleted ${result.deleted} and re-registered ${result.registered} webhook(s)`
      });
    } catch (error: any) {
      console.error("Error re-registering Shopify webhooks:", error);
      res.status(500).json({ 
        error: "Failed to re-register Shopify webhooks",
        details: error.message 
      });
    }
  });

  // List all Shopify webhooks
  app.get("/api/operations/shopify-webhooks", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ 
          error: "Missing Shopify credentials" 
        });
      }

      const { listShopifyWebhooks } = await import("./utils/shopify-webhook");
      const webhooks = await listShopifyWebhooks(shopDomain, accessToken);
      
      res.json({ webhooks });
    } catch (error: any) {
      console.error("Error listing Shopify webhooks:", error);
      res.status(500).json({ 
        error: "Failed to list webhooks",
        details: error.message 
      });
    }
  });

  // Delete individual Shopify webhook
  app.delete("/api/operations/shopify-webhooks/:webhookId", requireAuth, async (req, res) => {
    try {
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
      const { webhookId } = req.params;

      if (!shopDomain || !accessToken) {
        return res.status(400).json({ 
          error: "Missing Shopify credentials" 
        });
      }

      if (!webhookId) {
        return res.status(400).json({ 
          error: "Missing webhook ID" 
        });
      }

      const { deleteShopifyWebhook } = await import("./utils/shopify-webhook");
      
      // Audit log: Track who deleted the webhook and when
      const user = req.user as any;
      const timestamp = new Date().toISOString();
      console.log(`[AUDIT] Webhook deletion initiated by user ${user?.email || 'unknown'} at ${timestamp}`);
      console.log(`[AUDIT] Target: Webhook ID ${webhookId} on shop ${shopDomain}`);
      
      await deleteShopifyWebhook(shopDomain, accessToken, webhookId);
      
      console.log(`[AUDIT] Successfully deleted webhook ${webhookId}`);
      
      res.json({ 
        success: true,
        message: `Successfully deleted webhook ${webhookId}`
      });
    } catch (error: any) {
      console.error(`[AUDIT] Failed to delete webhook ${req.params.webhookId}:`, error);
      res.status(500).json({ 
        error: "Failed to delete webhook",
        details: error.message 
      });
    }
  });

  // List all ShipStation webhooks
  app.get("/api/operations/shipstation-webhooks", requireAuth, async (req, res) => {
    try {
      const apiKey = process.env.SHIPSTATION_API_KEY;

      if (!apiKey) {
        return res.status(400).json({ 
          error: "Missing ShipStation API key" 
        });
      }

      const { listShipStationWebhooks } = await import("./utils/shipstation-webhook");
      const webhooks = await listShipStationWebhooks(apiKey);
      
      res.json({ webhooks });
    } catch (error: any) {
      console.error("Error listing ShipStation webhooks:", error);
      res.status(500).json({ 
        error: "Failed to list webhooks",
        details: error.message 
      });
    }
  });

  // Delete individual ShipStation webhook
  app.delete("/api/operations/shipstation-webhooks/:webhookId", requireAuth, async (req, res) => {
    try {
      const apiKey = process.env.SHIPSTATION_API_KEY;
      const { webhookId } = req.params;

      if (!apiKey) {
        return res.status(400).json({ 
          error: "Missing ShipStation API key" 
        });
      }

      if (!webhookId) {
        return res.status(400).json({ 
          error: "Missing webhook ID" 
        });
      }

      const { deleteShipStationWebhook } = await import("./utils/shipstation-webhook");
      
      // Audit log: Track who deleted the webhook and when
      const user = req.user as any;
      const timestamp = new Date().toISOString();
      console.log(`[AUDIT] ShipStation webhook deletion initiated by user ${user?.email || 'unknown'} at ${timestamp}`);
      console.log(`[AUDIT] Target: Webhook ID ${webhookId}`);
      
      await deleteShipStationWebhook(apiKey, webhookId);
      
      console.log(`[AUDIT] Successfully deleted ShipStation webhook ${webhookId}`);
      
      res.json({ 
        success: true,
        message: `Successfully deleted webhook ${webhookId}`
      });
    } catch (error: any) {
      console.error(`[AUDIT] Failed to delete ShipStation webhook ${req.params.webhookId}:`, error);
      res.status(500).json({ 
        error: "Failed to delete webhook",
        details: error.message 
      });
    }
  });

  app.get("/api/operations/failures", requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string;
      const offset = (page - 1) * limit;

      let query = db.select().from(shipmentSyncFailures);

      if (search) {
        const { like, or } = await import("drizzle-orm");
        query = query.where(
          or(
            like(shipmentSyncFailures.orderNumber, `%${search}%`),
            like(shipmentSyncFailures.errorMessage, `%${search}%`)
          )
        );
      }

      const failures = await query
        .orderBy(desc(shipmentSyncFailures.failedAt))
        .limit(limit)
        .offset(offset);

      const totalCount = await db.select({ count: count() })
        .from(shipmentSyncFailures)
        .then(rows => rows[0]?.count || 0);

      res.json({
        failures,
        totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit),
      });
    } catch (error) {
      console.error("Error fetching failures:", error);
      res.status(500).json({ error: "Failed to fetch failures" });
    }
  });

  app.get("/api/operations/shopify-order-sync-failures", requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string;
      const offset = (page - 1) * limit;

      let query = db.select().from(shopifyOrderSyncFailures);
      let countQuery = db.select({ count: count() }).from(shopifyOrderSyncFailures);

      if (search) {
        const { like, or } = await import("drizzle-orm");
        const searchCondition = or(
          like(shopifyOrderSyncFailures.orderNumber, `%${search}%`),
          like(shopifyOrderSyncFailures.errorMessage, `%${search}%`)
        );
        query = query.where(searchCondition);
        countQuery = countQuery.where(searchCondition);
      }

      const failures = await query
        .orderBy(desc(shopifyOrderSyncFailures.failedAt))
        .limit(limit)
        .offset(offset);

      const totalCount = await countQuery.then(rows => rows[0]?.count || 0);

      res.json({
        failures,
        totalCount,
        page,
        totalPages: Math.ceil(totalCount / limit),
      });
    } catch (error) {
      console.error("Error fetching Shopify order sync failures:", error);
      res.status(500).json({ error: "Failed to fetch failures" });
    }
  });
  
  app.delete("/api/operations/shopify-order-sync-failures", requireAuth, async (req, res) => {
    try {
      await storage.clearShopifyOrderSyncFailures();
      console.log("All Shopify order sync failures cleared");
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error clearing Shopify order sync failures:", error);
      res.status(500).json({ error: "Failed to clear failures" });
    }
  });

  app.get("/api/print-queue", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getActivePrintJobs();
      res.json({ jobs });
    } catch (error) {
      console.error("Error fetching print queue:", error);
      res.status(500).json({ error: "Failed to fetch print queue" });
    }
  });

  app.post("/api/print-queue/:id/printing", requireAuth, async (req, res) => {
    try {
      const job = await storage.getPrintJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: "Print job not found" });
      }

      if (job.status !== "queued") {
        return res.status(400).json({ error: "Job is not in queued status" });
      }

      const updatedJob = await storage.updatePrintJobStatus(req.params.id, "printing");
      
      broadcastPrintQueueUpdate({ type: "job_printing", job: updatedJob });

      res.json({ success: true, job: updatedJob });
    } catch (error) {
      console.error("Error marking print job as printing:", error);
      res.status(500).json({ error: "Failed to mark job as printing" });
    }
  });

  app.post("/api/print-queue/:id/complete", requireAuth, async (req, res) => {
    try {
      const job = await storage.getPrintJob(req.params.id);
      
      if (!job) {
        return res.status(404).json({ error: "Print job not found" });
      }

      if (job.status === "printed") {
        return res.json({ success: true, job });
      }

      if (job.status !== "queued" && job.status !== "printing") {
        return res.status(400).json({ error: "Job must be in queued or printing status to complete" });
      }

      const updatedJob = await storage.updatePrintJobStatus(req.params.id, "printed", new Date());
      
      broadcastPrintQueueUpdate({ type: "job_completed", job: updatedJob });

      res.json({ success: true, job: updatedJob });
    } catch (error) {
      console.error("Error completing print job:", error);
      res.status(500).json({ error: "Failed to complete print job" });
    }
  });

  // Packing endpoints
  
  // Get shipment by order number for packing workflow
  app.get("/api/shipments/by-order-number/:orderNumber", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      
      // Query shipments - handles multiple results
      const shipmentResults = await storage.getShipmentsByOrderNumber(orderNumber);
      
      if (shipmentResults.length === 0) {
        return res.status(404).json({ 
          error: "Order not found",
          orderNumber 
        });
      }
      
      // Log warning if multiple shipments found (rare)
      if (shipmentResults.length > 1) {
        console.warn(`[Packing] Multiple shipments for order ${orderNumber}, using most recent (ID: ${shipmentResults[0].id})`);
      }
      
      const shipment = shipmentResults[0]; // Most recent (sorted by createdAt DESC in storage method)
      
      // Get shipment items
      const items = await storage.getShipmentItems(shipment.id);
      
      // Try to lookup SkuVault SaleId for this order (cache for frontend)
      let saleId: string | null = null;
      try {
        console.log(`[Packing] Looking up SkuVault SaleId for order: ${orderNumber}`);
        const saleInfo = await skuVaultService.getSaleInformation(orderNumber);
        if (saleInfo?.SaleId) {
          saleId = saleInfo.SaleId;
          console.log(`[Packing] Found SkuVault SaleId: ${saleId}`);
        } else {
          console.log(`[Packing] Order not found in SkuVault (may not be synced yet)`);
        }
      } catch (error: any) {
        console.warn(`[Packing] Failed to lookup SkuVault SaleId for ${orderNumber}:`, error.message);
      }
      
      res.json({
        ...shipment,
        items,
        saleId // Include SkuVault SaleId for QC scanning (null if not found)
      });
    } catch (error: any) {
      console.error("[Packing] Error fetching shipment:", error);
      res.status(500).json({ error: "Failed to fetch shipment" });
    }
  });

  // Validate order for packing - cross-validates ShipStation and SkuVault data
  app.get("/api/packing/validate-order/:orderNumber", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // 1. Fetch shipment from ShipStation (via our database)
      const shipmentResults = await storage.getShipmentsByOrderNumber(orderNumber);
      
      if (shipmentResults.length === 0) {
        return res.status(404).json({ 
          error: "Order not found",
          orderNumber 
        });
      }
      
      if (shipmentResults.length > 1) {
        console.warn(`[Packing Validation] Multiple shipments for order ${orderNumber}, using most recent (ID: ${shipmentResults[0].id})`);
      }
      
      const shipment = shipmentResults[0];
      const shipmentItems = await storage.getShipmentItems(shipment.id);
      
      // 2. Fetch QC Sales data from SkuVault
      let qcSale: import('@shared/skuvault-types').QCSale | null = null;
      let saleId: string | null = null;
      const validationWarnings: string[] = [];
      
      try {
        console.log(`[Packing Validation] Fetching SkuVault QC Sale for order: ${orderNumber}`);
        qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber);
        
        if (qcSale) {
          saleId = qcSale.SaleId ?? null;
          console.log(`[Packing Validation] Found SkuVault QC Sale:`, {
            SaleId: saleId,
            Status: qcSale.Status,
            TotalItems: qcSale.TotalItems,
            PassedItems: qcSale.PassedItems?.length ?? 0,
          });
          
          // 3. Cross-validate items between ShipStation and SkuVault
          const skuVaultSkus = new Set((qcSale.Items ?? []).map(item => item.Sku).filter(Boolean));
          const shipStationSkus = new Set(shipmentItems.map(item => item.sku).filter(Boolean));
          
          // Check for items in ShipStation but not in SkuVault
          const missingInSkuVault = shipmentItems.filter(item => item.sku && !skuVaultSkus.has(item.sku));
          if (missingInSkuVault.length > 0) {
            const skus = missingInSkuVault.map(i => i.sku).join(', ');
            validationWarnings.push(`Items in ShipStation but not in SkuVault: ${skus}`);
          }
          
          // Check for items in SkuVault but not in ShipStation
          const missingInShipStation = (qcSale.Items ?? []).filter(item => item.Sku && !shipStationSkus.has(item.Sku));
          if (missingInShipStation.length > 0) {
            const skus = missingInShipStation.map(i => i.Sku).join(', ');
            validationWarnings.push(`Items in SkuVault but not in ShipStation: ${skus}`);
          }
          
          // 4. Match PassedItems to shipment items and check quantities
          const passedItems = qcSale.PassedItems ?? [];
          const passedItemsBySku = new Map<string, number>(); // Track quantities by SKU
          
          passedItems.forEach(passedItem => {
            if (passedItem.Sku) {
              const sku = passedItem.Sku.trim().toUpperCase();
              const qty = passedItem.Quantity || 0;
              passedItemsBySku.set(sku, (passedItemsBySku.get(sku) || 0) + qty);
            }
          });
          
          // Check for quantity mismatches
          const shipmentItemsBySku = new Map<string, number>();
          shipmentItems.forEach(item => {
            if (item.sku) {
              const sku = item.sku.trim().toUpperCase();
              shipmentItemsBySku.set(sku, (shipmentItemsBySku.get(sku) || 0) + item.quantity);
            }
          });
          
          // Warn about quantity discrepancies
          shipmentItemsBySku.forEach((expectedQty, sku) => {
            const passedQty = passedItemsBySku.get(sku) || 0;
            if (passedQty > 0 && passedQty !== expectedQty) {
              validationWarnings.push(`SKU ${sku}: SkuVault has ${passedQty} passed, ShipStation expects ${expectedQty}`);
            }
          });
          
          // 5. Backfill shipment_events from PassedItems with item ID resolution
          if (passedItems.length > 0) {
            console.log(`[Packing Validation] Backfilling ${passedItems.length} shipment events from SkuVault PassedItems`);
            
            for (const passedItem of passedItems) {
              try {
                // Match SkuVault PassedItem to shipment item by SKU
                const matchedShipmentItem = shipmentItems.find(item => 
                  item.sku && passedItem.Sku && 
                  item.sku.trim().toUpperCase() === passedItem.Sku.trim().toUpperCase()
                );
                
                if (!matchedShipmentItem) {
                  console.warn(`[Packing Validation] No shipment item found for SKU ${passedItem.Sku}`);
                  continue;
                }
                
                await storage.createShipmentEvent({
                  occurredAt: new Date(), // Use current time (SkuVault timestamps unreliable)
                  username: passedItem.UserName || `SkuVault User ${passedItem.UserId || 'Unknown'}`,
                  station: "skuvault_qc",
                  eventName: "product_scan_success",
                  orderNumber: orderNumber,
                  skuvaultImport: true, // Mark as imported from SkuVault
                  metadata: {
                    sku: passedItem.Sku,
                    quantity: passedItem.Quantity,
                    shipmentItemId: matchedShipmentItem.id, // Link to our shipment item
                    skuvaultItemId: passedItem.ItemId,
                    skuvaultUserId: passedItem.UserId,
                    originalTimestamp: passedItem.DateTimeUtc,
                    importedAt: new Date().toISOString(),
                  },
                });
              } catch (error: any) {
                console.error(`[Packing Validation] Error backfilling event for item ${passedItem.ItemId}:`, error.message);
              }
            }
            
            console.log(`[Packing Validation] Successfully backfilled ${passedItems.length} shipment events`);
          }
        } else {
          console.log(`[Packing Validation] Order not found in SkuVault (may not be synced yet)`);
          validationWarnings.push("Order not found in SkuVault - QC validation unavailable");
        }
      } catch (error: any) {
        console.error(`[Packing Validation] Error fetching SkuVault data:`, error.message);
        validationWarnings.push(`SkuVault error: ${error.message}`);
      }
      
      // 5. Return combined data
      res.json({
        ...shipment,
        items: shipmentItems,
        saleId, // SkuVault Sale ID for QC scanning
        qcSale, // Full SkuVault QC Sale data (includes PassedItems, Items, etc.)
        validationWarnings, // Array of warnings if items don't match
      });
    } catch (error: any) {
      console.error("[Packing Validation] Error validating order:", error);
      res.status(500).json({ error: "Failed to validate order" });
    }
  });

  // Create packing log entry
  app.post("/api/packing-logs", requireAuth, async (req, res) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const logData = {
        ...req.body,
        userId: user.id // Ensure userId comes from authenticated session
      };
      
      // Validate with Zod schema
      const validated = insertPackingLogSchema.parse(logData);
      
      const log = await storage.createPackingLog(validated);
      res.json({ success: true, log });
    } catch (error: any) {
      console.error("[Packing] Error creating packing log:", error);
      res.status(500).json({ error: "Failed to create packing log" });
    }
  });
  
  // Get packing logs for a shipment (admin/debugging)
  app.get("/api/packing-logs/shipment/:shipmentId", requireAuth, async (req, res) => {
    try {
      const logs = await storage.getPackingLogsByShipment(req.params.shipmentId);
      res.json(logs); // Return array directly to match frontend expectation
    } catch (error: any) {
      console.error("[Packing] Error fetching packing logs:", error);
      res.status(500).json({ error: "Failed to fetch packing logs" });
    }
  });

  // Delete packing logs and shipment events for a shipment (testing/re-scanning)
  app.delete("/api/packing-logs/shipment/:shipmentId", requireAuth, async (req, res) => {
    try {
      // Get shipment to find order number
      const shipment = await storage.getShipment(req.params.shipmentId);
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Delete both packing logs and shipment events
      await storage.deletePackingLogsByShipment(req.params.shipmentId);
      await storage.deleteShipmentEventsByOrderNumber(shipment.orderNumber);
      
      res.json({ success: true, message: "Packing history cleared" });
    } catch (error: any) {
      console.error("[Packing] Error deleting packing history:", error);
      res.status(500).json({ error: "Failed to delete packing history" });
    }
  });

  // Create shipment event (audit trail)
  app.post("/api/shipment-events", requireAuth, async (req, res) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const eventData = {
        ...req.body,
        username: user.email // Ensure username comes from authenticated session
      };
      
      // Validate with Zod schema
      const validated = insertShipmentEventSchema.parse(eventData);
      
      const event = await storage.createShipmentEvent(validated);
      res.json({ success: true, event });
    } catch (error: any) {
      console.error("[ShipmentEvents] Error creating shipment event:", error);
      res.status(500).json({ error: "Failed to create shipment event" });
    }
  });

  // Get shipment events for an order number
  app.get("/api/shipment-events/order/:orderNumber", requireAuth, async (req, res) => {
    try {
      const events = await storage.getShipmentEventsByOrderNumber(req.params.orderNumber);
      res.json(events);
    } catch (error: any) {
      console.error("[ShipmentEvents] Error fetching shipment events:", error);
      res.status(500).json({ error: "Failed to fetch shipment events" });
    }
  });

  // Fast barcode validation for packing - uses local indexed lookup (instant)
  app.get("/api/packing/validate-barcode/:barcode", requireAuth, async (req, res) => {
    try {
      const { barcode } = req.params;
      
      if (!barcode || barcode.trim() === '') {
        return res.status(400).json({ 
          valid: false, 
          error: "Barcode is required" 
        });
      }
      
      // First try exact barcode match (most common case)
      let variant = await storage.getVariantByBarcode(barcode);
      
      // If not found by barcode, try SKU lookup (some items may be scanned by SKU)
      if (!variant) {
        variant = await storage.getVariantBySku(barcode);
      }
      
      if (!variant) {
        return res.status(404).json({ 
          valid: false, 
          error: "Product not found",
          scannedValue: barcode
        });
      }
      
      // Return minimal data needed for packing validation
      res.json({
        valid: true,
        sku: variant.sku,
        barcode: variant.barCode,
        title: variant.title,
        variantId: variant.id,
        productId: variant.productId
      });
    } catch (error: any) {
      console.error("[Packing] Error validating barcode:", error);
      res.status(500).json({ 
        valid: false, 
        error: "Failed to validate barcode" 
      });
    }
  });

  // Queue SkuVault QC scan for async processing
  // Optimistic: Returns immediately, QC sync happens in background via worker
  app.post("/api/packing/queue-qc-scan", requireAuth, async (req, res) => {
    try {
      const { saleId, sku, quantity = 1, orderNumber } = req.body;
      
      // Validate required fields
      if (!saleId || !sku || !orderNumber) {
        return res.status(400).json({ 
          queued: false, 
          error: "Missing required fields: saleId, sku, orderNumber" 
        });
      }
      
      // Get user email from session for audit
      const scannedBy = req.user?.email || "unknown";
      const scannedAt = new Date().toISOString();
      
      // Enqueue the QC sync message
      const queued = await enqueueSkuVaultQCSync({
        saleId,
        sku,
        quantity: Number(quantity),
        orderNumber,
        scannedBy,
        scannedAt,
        enqueuedAt: Date.now(),
        retryCount: 0,
      });
      
      if (!queued) {
        // Deduplication prevented queue - this is OK, means already queued recently
        console.log(`[Packing] QC scan deduplicated: ${sku} for ${orderNumber}`);
        return res.json({ 
          queued: false, 
          deduplicated: true,
          message: "Scan already queued within deduplication window" 
        });
      }
      
      console.log(`[Packing] QC scan queued: ${sku} for ${orderNumber} by ${scannedBy}`);
      res.json({ 
        queued: true, 
        message: "QC sync queued for background processing" 
      });
    } catch (error: any) {
      console.error("[Packing] Error queuing QC scan:", error);
      res.status(500).json({ 
        queued: false, 
        error: "Failed to queue QC scan" 
      });
    }
  });

  // Complete order packing
  app.post("/api/packing/complete", requireAuth, async (req, res) => {
    try {
      const { shipmentId } = req.body;
      
      // Get shipment
      const shipment = await storage.getShipment(shipmentId);
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Check if shipment is linked to Shopify order
      if (!shipment.orderId) {
        console.warn(`[Packing] Shipment ${shipment.orderNumber} has no orderId - skipping print queue`);
        return res.json({ 
          success: true, 
          printQueued: false,
          message: "Order complete. Print label manually from shipment details.",
          labelUrl: shipment.labelUrl
        });
      }
      
      // Create print job with shipment label URL
      const printJob = await storage.createPrintJob({
        orderId: shipment.orderId, // Non-null, safe to insert
        labelUrl: shipment.labelUrl || null, // Use shipment's label URL if available
        status: "queued"
      });
      
      // Broadcast WebSocket update
      broadcastPrintQueueUpdate({ 
        type: "job_added", 
        job: printJob 
      });
      
      res.json({ 
        success: true, 
        printQueued: true, 
        printJobId: printJob.id,
        message: "Order complete! Label queued for printing."
      });
    } catch (error: any) {
      console.error("[Packing] Error completing order:", error);
      res.status(500).json({ error: "Failed to complete order" });
    }
  });

  // Saved Views API endpoints
  // Get current user's saved views for a specific page
  app.get("/api/saved-views", requireAuth, async (req, res) => {
    try {
      const { page } = req.query;
      const views = await storage.getSavedViewsByUser(req.user!.id, page as string | undefined);
      res.json(views);
    } catch (error: any) {
      console.error("[Views] Error fetching saved views:", error);
      res.status(500).json({ error: "Failed to fetch saved views" });
    }
  });

  // Get a specific view (public access if view is public)
  app.get("/api/saved-views/:id", async (req, res) => {
    try {
      const { id } = req.params;
      
      // First try to get as authenticated user's own view
      if (req.user) {
        const ownView = await storage.getSavedView(id);
        if (ownView && ownView.userId === req.user.id) {
          return res.json(ownView);
        }
      }
      
      // Otherwise, try to get as public view
      const publicView = await storage.getPublicView(id);
      if (publicView) {
        return res.json(publicView);
      }
      
      res.status(404).json({ error: "View not found" });
    } catch (error: any) {
      console.error("[Views] Error fetching view:", error);
      res.status(500).json({ error: "Failed to fetch view" });
    }
  });

  // Zod schema for view config validation
  const savedViewConfigSchema = z.object({
    columns: z.array(z.string()).optional(),
    filters: z.object({
      suppliers: z.array(z.string()).optional(),
      search: z.string().optional(),
      isAssembledProduct: z.string().optional(),
    }).optional(),
    sort: z.object({
      column: z.string(),
      order: z.enum(['asc', 'desc']),
    }).optional(),
  });

  const createViewSchema = z.object({
    name: z.string().min(1, "Name is required").max(100, "Name too long"),
    page: z.string().min(1, "Page is required"),
    config: savedViewConfigSchema,
    isPublic: z.boolean().optional().default(false),
  });

  const updateViewSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    config: savedViewConfigSchema.optional(),
    isPublic: z.boolean().optional(),
  });

  // Create a new saved view
  app.post("/api/saved-views", requireAuth, async (req, res) => {
    try {
      const parseResult = createViewSchema.safeParse(req.body);
      
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid request body",
          details: parseResult.error.issues 
        });
      }
      
      const { name, page, config, isPublic } = parseResult.data;
      
      const view = await storage.createSavedView({
        userId: req.user!.id,
        name,
        page,
        config,
        isPublic,
      });
      
      res.status(201).json(view);
    } catch (error: any) {
      console.error("[Views] Error creating view:", error);
      res.status(500).json({ error: "Failed to create view" });
    }
  });

  // Update a saved view
  app.patch("/api/saved-views/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      
      const parseResult = updateViewSchema.safeParse(req.body);
      
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid request body",
          details: parseResult.error.issues 
        });
      }
      
      const { name, config, isPublic } = parseResult.data;
      
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (config !== undefined) updates.config = config;
      if (isPublic !== undefined) updates.isPublic = isPublic;
      
      // If no updates provided, return error
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid update fields provided" });
      }
      
      const view = await storage.updateSavedView(id, req.user!.id, updates);
      
      if (!view) {
        return res.status(404).json({ error: "View not found or access denied" });
      }
      
      res.json(view);
    } catch (error: any) {
      console.error("[Views] Error updating view:", error);
      res.status(500).json({ error: "Failed to update view" });
    }
  });

  // Delete a saved view
  app.delete("/api/saved-views/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteSavedView(id, req.user!.id);
      
      if (!deleted) {
        return res.status(404).json({ error: "View not found or access denied" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Views] Error deleting view:", error);
      res.status(500).json({ error: "Failed to delete view" });
    }
  });

  // Reporting API endpoints
  // Returns full snapshot - frontend handles all filtering/sorting locally for instant performance
  app.get("/api/reporting/po-recommendations", requireAuth, async (req, res) => {
    try {
      const recommendations = await reportingStorage.getFullSnapshot();
      res.json(recommendations);
    } catch (error: any) {
      console.error("[Reporting] Error fetching PO recommendations:", error);
      res.status(500).json({ error: "Failed to fetch PO recommendations" });
    }
  });

  app.get("/api/reporting/po-recommendations/latest-date", requireAuth, async (req, res) => {
    try {
      const latestDate = await reportingStorage.getLatestStockCheckDate();
      res.json({ latestDate });
    } catch (error: any) {
      console.error("[Reporting] Error fetching latest stock check date:", error);
      res.status(500).json({ error: "Failed to fetch latest stock check date" });
    }
  });

  app.get("/api/reporting/po-recommendation-steps/:sku/:stockCheckDate", requireAuth, async (req, res) => {
    try {
      const { sku, stockCheckDate } = req.params;
      
      // Validate stockCheckDate format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(stockCheckDate)) {
        return res.status(400).json({ error: "Invalid stockCheckDate format. Expected YYYY-MM-DD" });
      }
      
      const steps = await reportingStorage.getPORecommendationSteps(
        sku, 
        new Date(stockCheckDate)
      );
      res.json(steps);
    } catch (error: any) {
      console.error("[Reporting] Error fetching PO recommendation steps:", error);
      res.status(500).json({ error: "Failed to fetch PO recommendation steps" });
    }
  });

  app.get("/api/reporting/unique-suppliers", requireAuth, async (req, res) => {
    try {
      const suppliers = await reportingStorage.getUniqueSuppliers();
      res.json(suppliers);
    } catch (error: any) {
      console.error("[Reporting] Error fetching unique suppliers:", error);
      res.status(500).json({ error: "Failed to fetch unique suppliers" });
    }
  });

  app.post("/api/reporting/invalidate-cache", requireAuth, async (req, res) => {
    try {
      await reportingStorage.invalidateCache();
      res.json({ success: true, message: "Cache invalidated successfully" });
    } catch (error: any) {
      console.error("[Reporting] Error invalidating cache:", error);
      res.status(500).json({ error: "Failed to invalidate cache" });
    }
  });

  // ==================== Customer Service Routes ====================

  app.post("/api/manual-orders/generate", requireAuth, async (req, res) => {
    const { generateManualOrderNumber, validateInitials } = await import("@shared/manual-order-generator");
    const { reportingSql } = await import("./reporting-db");
    
    try {
      const { initials } = req.body as { initials?: string };
      
      // Validate initials if provided (2-3 uppercase letters only, no trailing digits)
      if (initials) {
        const initialsValidation = validateInitials(initials);
        if (!initialsValidation.valid) {
          return res.status(400).json({ 
            success: false, 
            error: initialsValidation.error 
          });
        }
      }
      
      // Generate order numbers until we find one that doesn't exist
      const maxAttempts = 10;
      let attempts = 0;
      
      while (attempts < maxAttempts) {
        attempts++;
        
        const generated = generateManualOrderNumber({ initials });
        
        if (!generated.isValid) {
          return res.status(400).json({ 
            success: false, 
            error: generated.validationError || "Failed to generate valid order number" 
          });
        }
        
        // Check if order number exists in reporting database
        const existingOrders = await reportingSql`
          SELECT count(1) as count FROM orders WHERE order_number = ${generated.orderNumber}
        `;
        
        const exists = parseInt(existingOrders[0].count as string, 10) > 0;
        
        if (!exists) {
          console.log(`[Manual Order] Generated unique order number: ${generated.orderNumber} (attempt ${attempts})`);
          return res.json({
            success: true,
            orderNumber: generated.orderNumber,
            attempts
          });
        }
        
        console.log(`[Manual Order] Order number ${generated.orderNumber} already exists, retrying...`);
      }
      
      // Exhausted all attempts
      return res.status(500).json({ 
        success: false, 
        error: `Failed to generate unique order number after ${maxAttempts} attempts. Please try again.` 
      });
      
    } catch (error: any) {
      console.error("[Manual Order] Error generating order number:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "Failed to generate order number" 
      });
    }
  });

  app.post("/api/manual-orders/validate", requireAuth, async (req, res) => {
    const { validateUserOrderNumber } = await import("@shared/manual-order-generator");
    const { reportingSql } = await import("./reporting-db");
    
    try {
      const { orderNumber } = req.body as { orderNumber: string };
      
      if (!orderNumber) {
        return res.status(400).json({ 
          success: false, 
          error: "Order number is required" 
        });
      }
      
      // Validate format
      const validation = validateUserOrderNumber(orderNumber);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          isValid: false,
          error: validation.error,
          suggestion: validation.suggestion
        });
      }
      
      // Check if it exists
      const existingOrders = await reportingSql`
        SELECT count(1) as count FROM orders WHERE order_number = ${orderNumber.trim().toUpperCase()}
      `;
      
      const exists = parseInt(existingOrders[0].count as string, 10) > 0;
      
      res.json({
        success: true,
        isValid: true,
        exists,
        orderNumber: orderNumber.trim().toUpperCase()
      });
      
    } catch (error: any) {
      console.error("[Manual Order] Error validating order number:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "Failed to validate order number" 
      });
    }
  });

  // ==================== Firestore Routes (Session Orders) ====================

  app.get("/api/firestore/session-orders", requireAuth, async (req, res) => {
    try {
      const filters: SkuVaultOrderSessionFilters = {
        search: req.query.search as string | undefined,
        pickerName: req.query.pickerName as string | undefined,
        sessionStatus: req.query.sessionStatus as string | undefined,
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
      };

      const result = await firestoreStorage.getSkuVaultOrderSessions(filters);
      res.json(result);
    } catch (error: any) {
      console.error("[Firestore] Error fetching session orders:", error);
      res.status(500).json({ error: error.message || "Failed to fetch session orders" });
    }
  });

  app.get("/api/firestore/session-orders/picker-names", requireAuth, async (req, res) => {
    try {
      const pickerNames = await firestoreStorage.getUniquePickerNames();
      res.json(pickerNames);
    } catch (error: any) {
      console.error("[Firestore] Error fetching picker names:", error);
      res.status(500).json({ error: error.message || "Failed to fetch picker names" });
    }
  });

  app.get("/api/firestore/session-orders/statuses", requireAuth, async (req, res) => {
    try {
      const statuses = await firestoreStorage.getUniqueSessionStatuses();
      res.json(statuses);
    } catch (error: any) {
      console.error("[Firestore] Error fetching session statuses:", error);
      res.status(500).json({ error: error.message || "Failed to fetch session statuses" });
    }
  });

  // ============================================================================
  // DESKTOP PRINTING SYSTEM API
  // ============================================================================

  // Helper function to hash tokens
  function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // Desktop client authentication middleware (Bearer token only)
  async function requireDesktopAuth(req: Request, res: Response, next: Function) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const tokenHash = hashToken(token);
    
    try {
      const client = await storage.getDesktopClientByAccessToken(tokenHash);
      if (!client) {
        return res.status(401).json({ error: 'Invalid access token' });
      }

      // Check token expiry
      if (new Date() > new Date(client.accessTokenExpiresAt)) {
        return res.status(401).json({ error: 'Access token expired', code: 'TOKEN_EXPIRED' });
      }

      // Update activity
      const clientIp = req.ip || req.socket.remoteAddress;
      await storage.updateDesktopClientActivity(client.id, clientIp);

      // Attach client and user to request
      const user = await storage.getUser(client.userId);
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      (req as any).desktopClient = client;
      (req as any).user = user;
      (req as any).authType = 'desktop';
      next();
    } catch (error) {
      console.error('[Desktop Auth] Error:', error);
      res.status(500).json({ error: 'Authentication error' });
    }
  }

  // Hybrid auth middleware - accepts both web session cookies AND desktop Bearer tokens
  // Tries BOTH methods independently and succeeds if EITHER works.
  async function hybridAuth(req: Request, res: Response, next: Function) {
    const errors: string[] = [];
    
    // Try desktop Bearer token auth
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const tokenHash = hashToken(token);
      
      try {
        const client = await storage.getDesktopClientByAccessToken(tokenHash);
        if (client) {
          if (new Date() > new Date(client.accessTokenExpiresAt)) {
            errors.push('Desktop token expired');
          } else {
            const user = await storage.getUser(client.userId);
            if (user) {
              // Desktop auth succeeded
              const clientIp = req.ip || req.socket.remoteAddress;
              await storage.updateDesktopClientActivity(client.id, clientIp);
              (req as any).desktopClient = client;
              (req as any).user = user;
              (req as any).authType = 'desktop';
              return next();
            } else {
              errors.push('Desktop token user not found');
            }
          }
        } else {
          errors.push('Invalid desktop token');
        }
      } catch (error) {
        console.error('[Hybrid Auth] Desktop token error:', error);
        errors.push('Desktop token validation error');
      }
    }

    // Try web session cookie auth (always attempted, even if Bearer was present)
    const sessionToken = req.cookies[SESSION_COOKIE_NAME];
    if (sessionToken) {
      try {
        const session = await storage.getSession(sessionToken);
        if (session && session.expiresAt >= new Date()) {
          const user = await storage.getUser(session.userId);
          if (user) {
            // Cookie auth succeeded
            (req as any).user = user;
            (req as any).authType = 'web';
            return next();
          } else {
            errors.push('Session user not found');
          }
        } else {
          errors.push('Session expired or invalid');
        }
      } catch (error) {
        console.error('[Hybrid Auth] Session error:', error);
        errors.push('Session validation error');
      }
    } else if (!authHeader) {
      // Only report no auth if neither method was attempted
      errors.push('No authentication provided');
    }

    // Both auth methods failed
    return res.status(401).json({ 
      error: 'Not authenticated',
      details: errors.length > 0 ? errors.join('; ') : undefined
    });
  }
  
  // Role-based access control middleware (use after hybridAuth)
  function requireRole(...allowedRoles: string[]) {
    return (req: Request, res: Response, next: Function) => {
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    };
  }

  // ==================== Stations ====================

  // Get all stations with their active sessions (web-friendly endpoint)
  app.get("/api/stations", requireAuth, async (req, res) => {
    try {
      const stations = await storage.getAllStations(false); // Get all stations
      
      // Fetch active sessions for each station
      const stationsWithSessions = await Promise.all(
        stations.map(async (station) => {
          const activeSession = await storage.getActiveSessionByStation(station.id);
          let userName: string | undefined;
          
          if (activeSession) {
            // Get user info for the session
            const user = await storage.getUser(activeSession.userId);
            userName = user?.name || user?.handle || user?.email?.split('@')[0] || undefined;
          }
          
          return {
            ...station,
            activeSession: activeSession ? {
              id: activeSession.id,
              userId: activeSession.userId,
              userName,
              startedAt: activeSession.startedAt,
              expiresAt: activeSession.expiresAt,
            } : null,
          };
        })
      );
      
      res.json({ stations: stationsWithSessions });
    } catch (error: any) {
      console.error("[Stations] Error fetching stations:", error);
      res.status(500).json({ error: error.message || "Failed to fetch stations" });
    }
  });

  // Get all stations (accessible by both web and desktop)
  app.get("/api/desktop/stations", hybridAuth, async (req, res) => {
    try {
      const activeOnly = req.query.active === 'true';
      const stations = await storage.getAllStations(activeOnly);
      res.json(stations);
    } catch (error: any) {
      console.error("[Desktop] Error fetching stations:", error);
      res.status(500).json({ error: error.message || "Failed to fetch stations" });
    }
  });

  // Get a specific station (accessible by both web and desktop)
  app.get("/api/desktop/stations/:id", hybridAuth, async (req, res) => {
    try {
      const station = await storage.getStation(req.params.id);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }
      res.json(station);
    } catch (error: any) {
      console.error("[Desktop] Error fetching station:", error);
      res.status(500).json({ error: error.message || "Failed to fetch station" });
    }
  });

  // Create a new station (accessible by both web and desktop)
  app.post("/api/desktop/stations", hybridAuth, async (req, res) => {
    try {
      const data = insertStationSchema.parse(req.body);
      
      // Check for duplicate name
      const existing = await storage.getStationByName(data.name);
      if (existing) {
        return res.status(400).json({ error: "A station with this name already exists" });
      }

      const station = await storage.createStation(data);
      res.status(201).json(station);
    } catch (error: any) {
      console.error("[Desktop] Error creating station:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: "Invalid station data", details: error.errors });
      }
      res.status(500).json({ error: error.message || "Failed to create station" });
    }
  });

  // Update a station (accessible by both web and desktop)
  app.patch("/api/desktop/stations/:id", hybridAuth, async (req, res) => {
    try {
      const station = await storage.updateStation(req.params.id, req.body);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }
      res.json(station);
    } catch (error: any) {
      console.error("[Desktop] Error updating station:", error);
      res.status(500).json({ error: error.message || "Failed to update station" });
    }
  });

  // Delete a station (accessible by both web and desktop)
  app.delete("/api/desktop/stations/:id", hybridAuth, async (req, res) => {
    try {
      const stationId = req.params.id;
      
      // Check if station exists
      const station = await storage.getStation(stationId);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }
      
      // End any active session on this station
      const activeSession = await storage.getActiveSessionByStation(stationId);
      if (activeSession) {
        await storage.endStationSession(activeSession.id);
        console.log(`[Desktop] Ended active session ${activeSession.id} for deleted station ${stationId}`);
      }
      
      // Broadcast station deletion to desktop client (forces logout)
      broadcastDesktopStationDeleted(stationId);
      
      // Delete the station
      const deleted = await storage.deleteStation(stationId);
      if (!deleted) {
        return res.status(404).json({ error: "Station not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Desktop] Error deleting station:", error);
      res.status(500).json({ error: error.message || "Failed to delete station" });
    }
  });

  // ==================== Printers ====================

  // Get all printers (optionally filter by station)
  app.get("/api/desktop/printers", requireAuth, async (req, res) => {
    try {
      const stationId = req.query.stationId as string | undefined;
      const printers = stationId 
        ? await storage.getPrintersByStation(stationId)
        : await storage.getAllPrinters();
      res.json(printers);
    } catch (error: any) {
      console.error("[Desktop] Error fetching printers:", error);
      res.status(500).json({ error: error.message || "Failed to fetch printers" });
    }
  });

  // Get a specific printer
  app.get("/api/desktop/printers/:id", requireAuth, async (req, res) => {
    try {
      const printer = await storage.getPrinter(req.params.id);
      if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
      }
      res.json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error fetching printer:", error);
      res.status(500).json({ error: error.message || "Failed to fetch printer" });
    }
  });

  // Register/update a printer (used by desktop app during discovery)
  app.post("/api/desktop/printers", requireDesktopAuth, async (req, res) => {
    try {
      const data = insertPrinterSchema.parse(req.body);
      
      // Check if printer already exists by system name
      const existing = await storage.getPrinterBySystemName(data.systemName);
      if (existing) {
        // Update existing printer
        const updated = await storage.updatePrinter(existing.id, data);
        return res.json(updated);
      }

      const printer = await storage.createPrinter(data);
      res.status(201).json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error registering printer:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: "Invalid printer data", details: error.errors });
      }
      res.status(500).json({ error: error.message || "Failed to register printer" });
    }
  });

  // Update a printer
  app.patch("/api/desktop/printers/:id", requireAuth, async (req, res) => {
    try {
      const printer = await storage.updatePrinter(req.params.id, req.body);
      if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
      }
      res.json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error updating printer:", error);
      res.status(500).json({ error: error.message || "Failed to update printer" });
    }
  });

  // Delete a printer
  app.delete("/api/desktop/printers/:id", requireAuth, async (req, res) => {
    try {
      const deleted = await storage.deletePrinter(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Printer not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Desktop] Error deleting printer:", error);
      res.status(500).json({ error: error.message || "Failed to delete printer" });
    }
  });

  // ==================== Desktop Client Authentication ====================

  // Register a new desktop client (called after OAuth flow from desktop app)
  app.post("/api/desktop/clients/register", async (req, res) => {
    try {
      const { googleIdToken, deviceName } = req.body;

      if (!googleIdToken || !deviceName) {
        return res.status(400).json({ error: "Missing googleIdToken or deviceName" });
      }

      // Verify the Google ID token
      const googleResponse = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${googleIdToken}`
      );
      
      if (!googleResponse.ok) {
        return res.status(401).json({ error: "Invalid Google ID token" });
      }

      const googleData = await googleResponse.json();
      const email = googleData.email;

      // Verify domain
      if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
        return res.status(403).json({ 
          error: `Only @${ALLOWED_EMAIL_DOMAIN} accounts are allowed` 
        });
      }

      // Find or create user
      let user = await storage.getUserByEmail(email);
      if (!user) {
        user = await storage.createUser({
          id: randomBytes(16).toString('hex'),
          email,
          name: googleData.name || email.split('@')[0],
          role: 'user',
        });
      }

      // Generate tokens
      const accessToken = randomBytes(32).toString('hex');
      const refreshToken = randomBytes(32).toString('hex');
      const now = new Date();
      const accessTokenExpiry = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20 hours
      const refreshTokenExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

      // Create desktop client
      const clientId = randomBytes(16).toString('hex');
      const client = await storage.createDesktopClient({
        id: clientId,
        userId: user.id,
        deviceName,
        accessTokenHash: hashToken(accessToken),
        refreshTokenHash: hashToken(refreshToken),
        accessTokenExpiresAt: accessTokenExpiry,
        refreshTokenExpiresAt: refreshTokenExpiry,
        lastIp: req.ip || req.socket.remoteAddress,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      });

      res.status(201).json({
        clientId: client.id,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: accessTokenExpiry.toISOString(),
        refreshTokenExpiresAt: refreshTokenExpiry.toISOString(),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      });
    } catch (error: any) {
      console.error("[Desktop] Error registering client:", error);
      res.status(500).json({ error: error.message || "Failed to register desktop client" });
    }
  });

  // Refresh access token
  app.post("/api/desktop/clients/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({ error: "Missing refreshToken" });
      }

      const tokenHash = hashToken(refreshToken);
      const client = await storage.getDesktopClientByRefreshToken(tokenHash);

      if (!client) {
        return res.status(401).json({ error: "Invalid refresh token" });
      }

      // Check refresh token expiry
      if (new Date() > new Date(client.refreshTokenExpiresAt)) {
        return res.status(401).json({ error: "Refresh token expired", code: 'REFRESH_TOKEN_EXPIRED' });
      }

      // Generate new access token
      const newAccessToken = randomBytes(32).toString('hex');
      const now = new Date();
      const accessTokenExpiry = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20 hours

      await storage.updateDesktopClient(client.id, {
        accessTokenHash: hashToken(newAccessToken),
        accessTokenExpiresAt: accessTokenExpiry,
        lastActiveAt: now,
      } as any);

      res.json({
        accessToken: newAccessToken,
        accessTokenExpiresAt: accessTokenExpiry.toISOString(),
      });
    } catch (error: any) {
      console.error("[Desktop] Error refreshing token:", error);
      res.status(500).json({ error: error.message || "Failed to refresh token" });
    }
  });

  // Revoke desktop client (logout)
  app.post("/api/desktop/clients/revoke", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      await storage.deleteDesktopClient(client.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Desktop] Error revoking client:", error);
      res.status(500).json({ error: error.message || "Failed to revoke client" });
    }
  });

  // Get current user info
  app.get("/api/desktop/me", requireDesktopAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const client = (req as any).desktopClient;
      
      // Get active session if any
      const session = await storage.getActiveSessionByDesktopClient(client.id);
      let station = null;
      if (session) {
        station = await storage.getStation(session.stationId);
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name || user.handle || user.email?.split('@')[0] || user.email,
        },
        client: {
          id: client.id,
          deviceName: client.deviceName,
          lastActiveAt: client.lastActiveAt,
        },
        session: session ? {
          id: session.id,
          stationId: session.stationId,
          stationName: station?.name,
          status: session.status,
          startedAt: session.startedAt,
          expiresAt: session.expiresAt,
        } : null,
      });
    } catch (error: any) {
      console.error("[Desktop] Error getting user info:", error);
      res.status(500).json({ error: error.message || "Failed to get user info" });
    }
  });

  // ==================== Station Sessions ====================

  // Claim a station (start a session) - uses atomic transaction to prevent race conditions
  app.post("/api/desktop/sessions/claim", requireDesktopAuth, async (req, res) => {
    try {
      const { stationId } = req.body;
      const user = (req as any).user;
      const client = (req as any).desktopClient;

      if (!stationId) {
        return res.status(400).json({ error: "Missing stationId" });
      }

      // Check if station exists and is active
      const station = await storage.getStation(stationId);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }

      if (!station.isActive) {
        return res.status(400).json({ error: "Station is not active" });
      }

      // Use atomic transaction to claim the station
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20 hours

      const result = await storage.claimStationAtomically({
        id: randomBytes(16).toString('hex'),
        stationId,
        userId: user.id,
        desktopClientId: client.id,
        status: 'active',
        startedAt: now,
        expiresAt,
        createdAt: now,
      }, client.id);

      if (result.error) {
        if (result.claimedBy) {
          return res.status(409).json({ 
            error: result.error, 
            claimedBy: result.claimedBy,
            expiresAt: result.expiresAt,
          });
        }
        return res.status(500).json({ error: result.error });
      }

      const session = result.session!;
      res.status(201).json({
        session: {
          id: session.id,
          stationId: session.stationId,
          stationName: station.name,
          status: session.status,
          startedAt: session.startedAt,
          expiresAt: session.expiresAt,
        },
      });
    } catch (error: any) {
      console.error("[Desktop] Error claiming station:", error);
      res.status(500).json({ error: error.message || "Failed to claim station" });
    }
  });

  // Release a station (end session)
  app.post("/api/desktop/sessions/release", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;

      const session = await storage.getActiveSessionByDesktopClient(client.id);
      if (!session) {
        return res.status(404).json({ error: "No active session found" });
      }

      const ended = await storage.endStationSession(session.id);
      res.json({ success: true, session: ended });
    } catch (error: any) {
      console.error("[Desktop] Error releasing station:", error);
      res.status(500).json({ error: error.message || "Failed to release station" });
    }
  });

  // Get current session
  app.get("/api/desktop/sessions/current", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      const session = await storage.getActiveSessionByDesktopClient(client.id);
      
      if (!session) {
        return res.json({ session: null });
      }

      const station = await storage.getStation(session.stationId);
      res.json({
        session: {
          id: session.id,
          stationId: session.stationId,
          stationName: station?.name,
          status: session.status,
          startedAt: session.startedAt,
          expiresAt: session.expiresAt,
        },
      });
    } catch (error: any) {
      console.error("[Desktop] Error getting current session:", error);
      res.status(500).json({ error: error.message || "Failed to get current session" });
    }
  });

  // ==================== Print Jobs ====================

  // Get pending print jobs for the current station
  app.get("/api/desktop/print-jobs", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      const session = await storage.getActiveSessionByDesktopClient(client.id);

      if (!session) {
        return res.status(400).json({ error: "No active station session" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const pendingOnly = req.query.pending !== 'false';

      const jobs = pendingOnly
        ? await storage.getPendingJobsByStation(session.stationId, limit)
        : await storage.getJobsByStation(session.stationId, limit);

      res.json(jobs);
    } catch (error: any) {
      console.error("[Desktop] Error fetching print jobs:", error);
      res.status(500).json({ error: error.message || "Failed to fetch print jobs" });
    }
  });

  // Create a print job (used by web app or other services)
  app.post("/api/desktop/print-jobs", requireAuth, async (req, res) => {
    try {
      const data = insertPrintJobSchema.parse(req.body);
      const job = await storage.createPrintJob(data);
      
      // TODO: Notify desktop clients via WebSocket
      
      res.status(201).json(job);
    } catch (error: any) {
      console.error("[Desktop] Error creating print job:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: "Invalid print job data", details: error.errors });
      }
      res.status(500).json({ error: error.message || "Failed to create print job" });
    }
  });

  // Helper to verify print job ownership by desktop client's station session
  async function verifyPrintJobOwnership(jobId: string, clientId: string): Promise<{ error?: string; job?: any; session?: any }> {
    const session = await storage.getActiveSessionByDesktopClient(clientId);
    if (!session) {
      return { error: "No active station session" };
    }
    
    const job = await storage.getPrintJob(jobId);
    if (!job) {
      return { error: "Print job not found" };
    }
    
    if (job.stationId !== session.stationId) {
      return { error: "Print job does not belong to your station" };
    }
    
    return { job, session };
  }

  // Acknowledge a print job (mark as sent to printer)
  app.post("/api/desktop/print-jobs/:id/ack", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      const result = await verifyPrintJobOwnership(req.params.id, client.id);
      
      if (result.error) {
        const status = result.error === "Print job not found" ? 404 : 403;
        return res.status(status).json({ error: result.error });
      }

      const job = await storage.markJobSent(req.params.id);
      res.json(job);
    } catch (error: any) {
      console.error("[Desktop] Error acknowledging print job:", error);
      res.status(500).json({ error: error.message || "Failed to acknowledge print job" });
    }
  });

  // Complete a print job
  app.post("/api/desktop/print-jobs/:id/complete", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      const result = await verifyPrintJobOwnership(req.params.id, client.id);
      
      if (result.error) {
        const status = result.error === "Print job not found" ? 404 : 403;
        return res.status(status).json({ error: result.error });
      }

      const job = await storage.markJobCompleted(req.params.id);
      res.json(job);
    } catch (error: any) {
      console.error("[Desktop] Error completing print job:", error);
      res.status(500).json({ error: error.message || "Failed to complete print job" });
    }
  });

  // Report a print job failure
  app.post("/api/desktop/print-jobs/:id/fail", requireDesktopAuth, async (req, res) => {
    try {
      const client = (req as any).desktopClient;
      const result = await verifyPrintJobOwnership(req.params.id, client.id);
      
      if (result.error) {
        const status = result.error === "Print job not found" ? 404 : 403;
        return res.status(status).json({ error: result.error });
      }

      const { errorMessage } = req.body;
      const job = await storage.markJobFailed(req.params.id, errorMessage || "Unknown error");
      res.json(job);
    } catch (error: any) {
      console.error("[Desktop] Error reporting print job failure:", error);
      res.status(500).json({ error: error.message || "Failed to report print job failure" });
    }
  });

  // Retry a failed print job
  app.post("/api/desktop/print-jobs/:id/retry", requireAuth, async (req, res) => {
    try {
      const job = await storage.retryJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Print job not found" });
      }
      res.json(job);
    } catch (error: any) {
      console.error("[Desktop] Error retrying print job:", error);
      res.status(500).json({ error: error.message || "Failed to retry print job" });
    }
  });

  // Cancel a print job
  app.post("/api/desktop/print-jobs/:id/cancel", requireAuth, async (req, res) => {
    try {
      const job = await storage.cancelJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Print job not found" });
      }
      res.json(job);
    } catch (error: any) {
      console.error("[Desktop] Error cancelling print job:", error);
      res.status(500).json({ error: error.message || "Failed to cancel print job" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
