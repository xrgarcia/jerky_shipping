import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { reportingStorage } from "./reporting-storage";
import { reportingSql } from "./reporting-db";
import { db } from "./db";
import { users, shipmentSyncFailures, shopifyOrderSyncFailures, orders, orderItems, shipments, orderRefunds, shipmentItems, shipmentTags, shipmentEvents, fingerprints, shipmentQcItems, fingerprintModels, slashbinKitComponentMappings, packagingTypes, slashbinOrders, slashbinOrderItems, shipmentRateAnalysis, featureFlags } from "@shared/schema";
import { eq, count, desc, asc, or, and, sql, gte, lte, ilike, isNotNull, isNull, ne, inArray, notInArray, exists, type SQL } from "drizzle-orm";
import { randomBytes } from "crypto";
import { z } from "zod";
import { createHash } from "crypto";
import { insertUserSchema, insertPackingLogSchema, insertShipmentEventSchema, insertStationSchema, insertPrinterSchema, insertDesktopClientSchema, insertStationSessionSchema, insertPrintJobSchema } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyShopifyWebhook, reregisterAllWebhooks } from "./utils/shopify-webhook";
import { verifyShipStationWebhook } from "./utils/shipstation-webhook";
import { verifySlashbinWebhook, isJobAlreadyProcessed, markJobAsProcessed } from "./utils/slashbin-webhook";
import { fetchShipStationResource, getShipmentsByOrderNumber, getFulfillmentByTrackingNumber, getShipmentByShipmentId, getTrackingDetails, getShipmentsByDateRange, getLabelsForShipment, createLabelForExistingShipment, updateShipmentNumber, extractPdfLabelUrl } from "./utils/shipstation-api";
import { enqueueWebhook, enqueueOrderId, dequeueWebhook, getQueueLength, clearQueue, enqueueShipmentSync, enqueueShipmentSyncBatch, getShipmentSyncQueueLength, clearShipmentSyncQueue, clearShopifyOrderSyncQueue, getOldestShopifyQueueMessage, getOldestShipmentSyncQueueMessage, getShopifyOrderSyncQueueLength, getOldestShopifyOrderSyncQueueMessage, enqueueSkuVaultQCSync, enqueueLifecycleEvent, enqueueLifecycleEventBatch } from "./utils/queue";
import { extractActualOrderNumber, extractShopifyOrderPrices } from "./utils/shopify-utils";
import { broadcastOrderUpdate, broadcastPrintQueueUpdate, broadcastQueueStatus, broadcastDesktopStationDeleted, broadcastDesktopStationUpdated, broadcastDesktopConfigUpdate, broadcastStationPrinterUpdate, getConnectedStationIds, broadcastDesktopPrintJob, broadcastDesktopJobUpdate } from "./websocket";
import { ShipStationShipmentService } from "./services/shipstation-shipment-service";
import { shopifyOrderETL } from "./services/shopify-order-etl-service";
import { shipStationShipmentETL } from "./services/shipstation-shipment-etl-service";
import { extractShipmentStatus } from "./shipment-sync-worker";
import { skuVaultService, SkuVaultError, qcSaleCache } from "./services/skuvault-service";
import { onLabelCreated, refreshCacheForOrder, refreshCacheForOrderDetailed, getCacheWarmerMetrics, getWarmCache, getInactiveSessionShipments, getWarmCacheStatusBatch, invalidateCacheForOrder, updateCacheAfterScan, getShippableShipmentsForOrder, warmCacheForOrder } from "./services/qcsale-cache-warmer";
import { analyzeShippableShipments, type ShippableShipmentsResult } from "./utils/shipment-eligibility";
import { qcPassItemRequestSchema, qcPassKitSaleItemRequestSchema } from "@shared/skuvault-types";
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { checkRateLimit } from "./utils/rate-limiter";
import type { PORecommendation } from "@shared/reporting-schema";
import { firestoreStorage } from "./firestore-storage";
import type { SkuVaultOrderSessionFilters } from "@shared/firestore-schema";
import { refreshStaleJobsMetrics } from "./print-queue-worker";
import { transformPrintJobForDesktop } from "./print-job-transform";
import { updateShipmentLifecycleBatch, queueLifecycleEvaluationBatch } from "./services/lifecycle-service";

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

// Helper to parse CSV line handling quoted fields with commas
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  
  result.push(current); // Push last field
  return result;
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
function getGoogleAuthUrl(redirectUri: string, state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    state: state,
    prompt: "select_account",
    // Note: hd parameter removed - it was causing 403 errors when users have multiple Google accounts
    // and their personal Gmail is the default. We verify the domain on the backend instead.
  });
  
  // If a login hint is provided, add it to help Google pre-select the right account
  if (loginHint) {
    params.set("login_hint", loginHint);
  }
  
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
    
    // Optional login hint from query parameter (e.g., user's email)
    const loginHint = req.query.login_hint as string | undefined;
    
    res.cookie("oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000, // 10 minutes
      sameSite: "lax",
    });

    const authUrl = getGoogleAuthUrl(redirectUri, state, loginHint);
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

      res.redirect("/shipments");
    } catch (error) {
      console.error("Error in Google OAuth callback:", error);
      res.redirect("/login?error=auth_failed");
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    try {
      const sessionToken = req.cookies[SESSION_COOKIE_NAME];
      const user = req.user!;
      
      // Clear user's station assignment before logging out
      await storage.deleteWebPackingSession(user.id);
      
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

  // Health check endpoint for container keep-alive
  // This endpoint is public (no auth required) to allow external/self pings
  app.get("/api/health/heart-beat", (_req, res) => {
    res.json({ 
      status: "ok", 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Desktop app downloads - fetches latest release from GitHub
  app.get("/api/downloads/latest", async (req, res) => {
    try {
      const GITHUB_OWNER = "xrgarcia";
      const GITHUB_REPO = "jerky_shipping";
      
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        {
          headers: {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "JerkyShipConnect",
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: "No releases found" });
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json();
      
      // Extract version from tag (e.g., "v1.0.0" -> "1.0.0")
      const version = release.tag_name.replace(/^v/, "");
      const releaseDate = new Date(release.published_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
      });

      // Map assets to download URLs
      const assets: Record<string, string> = {};
      for (const asset of release.assets || []) {
        const name = asset.name.toLowerCase();
        if (name.endsWith(".exe") && name.includes("setup")) {
          assets.windowsInstaller = asset.browser_download_url;
        } else if (name.endsWith(".exe") && !name.includes("setup")) {
          assets.windowsPortable = asset.browser_download_url;
        } else if (name.endsWith(".dmg")) {
          assets.macDmg = asset.browser_download_url;
        } else if (name.endsWith(".zip") && name.includes("mac")) {
          assets.macZip = asset.browser_download_url;
        }
      }

      res.json({
        version,
        releaseDate,
        tagName: release.tag_name,
        assets,
        releaseUrl: release.html_url,
      });
    } catch (error: any) {
      console.error("Error fetching GitHub release:", error);
      res.status(500).json({ error: "Failed to fetch release info" });
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
        profileBackgroundColor: z.string().nullable().optional(),
        skuvaultUsername: z.string().nullable().optional(),
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

      // Enrich orders with shipment status (only check for current page's orders)
      const orderIds = orders.map(order => order.id);
      const orderIdsWithShipments = await storage.getOrderIdsWithShipments(orderIds);
      
      const ordersWithShipmentStatus = orders.map(order => ({
        ...order,
        hasShipment: orderIdsWithShipments.has(order.id),
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

      // Check content type to ensure we got a PDF, not an error page
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
        // Log the first part of the response for debugging
        const textContent = await response.text();
        console.error(`[Label Proxy] Expected PDF but got ${contentType}:`, textContent.substring(0, 200));
        return res.status(502).json({ error: "Label unavailable - ShipStation returned invalid content" });
      }

      const pdfBuffer = await response.arrayBuffer();
      
      // Additional check: PDF files start with %PDF
      const pdfBytes = new Uint8Array(pdfBuffer);
      const header = String.fromCharCode(...pdfBytes.slice(0, 4));
      if (header !== '%PDF') {
        console.error(`[Label Proxy] Invalid PDF header:`, header);
        return res.status(502).json({ error: "Label unavailable - invalid PDF content" });
      }
      
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

  // Get distinct package names for filtering
  app.get("/api/shipments/package-names", requireAuth, async (req, res) => {
    try {
      const packageNames = await storage.getDistinctPackageNames();
      res.json({ packageNames });
    } catch (error) {
      console.error("Error fetching package names:", error);
      res.status(500).json({ error: "Failed to fetch package names" });
    }
  });

  // Get distinct service codes for filtering (shipping methods like usps_ground_advantage, ups_ground)
  app.get("/api/shipments/service-codes", requireAuth, async (req, res) => {
    try {
      const serviceCodes = await storage.getDistinctServiceCodes();
      res.json({ serviceCodes });
    } catch (error) {
      console.error("Error fetching service codes:", error);
      res.status(500).json({ error: "Failed to fetch service codes" });
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

  // Get lifecycle tab counts for warehouse flow visibility
  app.get("/api/shipments/lifecycle-counts", requireAuth, async (req, res) => {
    try {
      const counts = await storage.getLifecycleTabCounts();
      res.json(counts);
    } catch (error) {
      console.error("Error fetching lifecycle counts:", error);
      res.status(500).json({ error: "Failed to fetch lifecycle counts" });
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

      // Parse lifecycle tab filter (mutually exclusive with workflowTab)
      if (req.query.lifecycleTab) {
        filters.lifecycleTab = req.query.lifecycleTab as string;
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
      if (req.query.serviceCode) {
        filters.serviceCode = Array.isArray(req.query.serviceCode)
          ? req.query.serviceCode
          : [req.query.serviceCode];
      }
      if (req.query.packageName) {
        filters.packageName = Array.isArray(req.query.packageName)
          ? req.query.packageName
          : [req.query.packageName];
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

      // Parse doNotShip filter (shipments with "**DO NOT SHIP (ALERT MGR)**" package)
      if (req.query.doNotShip === 'true') {
        filters.doNotShip = true;
      }

      // Parse needsManualPackage filter (shipments that failed auto package sync)
      if (req.query.needsManualPackage === 'true') {
        filters.requiresManualPackage = true;
      }

      // Parse sessioning-related filters
      if (req.query.hasFingerprint === 'true') {
        filters.hasFingerprint = true;
      } else if (req.query.hasFingerprint === 'false') {
        filters.hasFingerprint = false;
      }

      if (req.query.decisionSubphase) {
        filters.decisionSubphase = req.query.decisionSubphase as string;
      }

      if (req.query.hasPackaging === 'true') {
        filters.hasPackaging = true;
      } else if (req.query.hasPackaging === 'false') {
        filters.hasPackaging = false;
      }

      if (req.query.assignedStationId) {
        filters.assignedStationId = req.query.assignedStationId as string;
      }

      if (req.query.hasSession === 'true') {
        filters.hasSession = true;
      } else if (req.query.hasSession === 'false') {
        filters.hasSession = false;
      }

      if (req.query.lifecyclePhaseFilter) {
        filters.lifecyclePhaseFilter = req.query.lifecyclePhaseFilter as string;
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

  // Get smart session info for a shipment (fingerprint, session, spot, packaging, station)
  app.get("/api/shipments/:id/smart-session-info", requireAuth, async (req, res) => {
    try {
      const { fingerprints, fulfillmentSessions, packagingTypes, stations } = await import("@shared/schema");
      const idParam = req.params.id;
      
      // Find shipment by shipmentId or UUID
      let shipment = await storage.getShipmentByShipmentId(idParam);
      if (!shipment) {
        shipment = await storage.getShipment(idParam);
      }
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Fetch related entities in parallel
      const [fingerprint, session, packagingType, assignedStation, featureFlagRow] = await Promise.all([
        shipment.fingerprintId 
          ? db.select().from(fingerprints).where(eq(fingerprints.id, shipment.fingerprintId)).then(r => r[0])
          : Promise.resolve(null),
        shipment.fulfillmentSessionId 
          ? db.select().from(fulfillmentSessions).where(eq(fulfillmentSessions.id, shipment.fulfillmentSessionId)).then(r => r[0])
          : Promise.resolve(null),
        shipment.packagingTypeId 
          ? db.select().from(packagingTypes).where(eq(packagingTypes.id, shipment.packagingTypeId)).then(r => r[0])
          : Promise.resolve(null),
        shipment.assignedStationId 
          ? db.select().from(stations).where(eq(stations.id, shipment.assignedStationId)).then(r => r[0])
          : Promise.resolve(null),
        db.select({ enabled: featureFlags.enabled })
          .from(featureFlags)
          .where(eq(featureFlags.key, 'auto_package_sync'))
          .then(r => r[0]),
      ]);

      // Derive auto package assignment readiness status
      const autoPackageSyncEnabled = featureFlagRow?.enabled ?? false;
      let autoPackageStatus: string;
      if (!autoPackageSyncEnabled) {
        autoPackageStatus = 'feature_disabled';
      } else if (shipment.fingerprintStatus === 'pending_categorization') {
        autoPackageStatus = 'needs_geometry_collection';
      } else if (!shipment.fingerprintId || !fingerprint) {
        autoPackageStatus = 'no_fingerprint';
      } else {
        // Check if a fingerprint model (learned rule) exists for this fingerprint
        const [model] = await db
          .select({ packagingTypeId: fingerprintModels.packagingTypeId })
          .from(fingerprintModels)
          .where(eq(fingerprintModels.fingerprintId, shipment.fingerprintId))
          .limit(1);
        if (!model?.packagingTypeId) {
          autoPackageStatus = 'needs_packaging_rule';
        } else {
          autoPackageStatus = 'ready';
        }
      }

      res.json({
        fingerprint: fingerprint ? {
          id: fingerprint.id,
          displayName: fingerprint.displayName,
          signature: fingerprint.signature,
          totalItems: fingerprint.totalItems,
          totalWeight: fingerprint.totalWeight,
          weightUnit: fingerprint.weightUnit,
        } : null,
        session: session ? {
          id: session.id,
          name: session.name,
          status: session.status,
          stationType: session.stationType,
          orderCount: session.orderCount,
        } : null,
        spotNumber: shipment.smartSessionSpot,
        packagingType: packagingType ? {
          id: packagingType.id,
          name: packagingType.name,
          stationType: packagingType.stationType,
        } : null,
        qcStation: assignedStation ? {
          id: assignedStation.id,
          name: assignedStation.name,
          stationType: assignedStation.stationType,
        } : null,
        autoPackageStatus,
      });
    } catch (error) {
      console.error("Error fetching smart session info:", error);
      res.status(500).json({ error: "Failed to fetch smart session info" });
    }
  });

  // Get rate analysis for a shipment
  app.get("/api/shipments/:id/rate-analysis", requireAuth, async (req, res) => {
    try {
      const { shipmentRateAnalysis } = await import("@shared/schema");
      const idParam = req.params.id;
      
      // Find shipment by shipmentId or UUID
      let shipment = await storage.getShipmentByShipmentId(idParam);
      if (!shipment) {
        shipment = await storage.getShipment(idParam);
      }
      
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Rate analysis is keyed by ShipStation shipmentId
      if (!shipment.shipmentId) {
        return res.json({ rateAnalysis: null, reason: "No ShipStation shipment ID" });
      }

      const [analysis] = await db
        .select()
        .from(shipmentRateAnalysis)
        .where(eq(shipmentRateAnalysis.shipmentId, shipment.shipmentId))
        .limit(1);

      res.json({ rateAnalysis: analysis || null });
    } catch (error) {
      console.error("Error fetching rate analysis:", error);
      res.status(500).json({ error: "Failed to fetch rate analysis" });
    }
  });

  // Get all Shopify products with variants
  app.get("/api/shopify-products", requireAuth, async (req, res) => {
    try {
      const productsWithVariants = await storage.getAllShopifyProductsWithVariants();
      res.json({ productsWithVariants });
    } catch (error) {
      console.error("Error fetching Shopify products:", error);
      res.status(500).json({ error: "Failed to fetch Shopify products" });
    }
  });

  // Get Shopify product by ID with variants
  app.get("/api/shopify-products/:id", requireAuth, async (req, res) => {
    try {
      const product = await storage.getShopifyProduct(req.params.id);
      
      if (!product) {
        return res.status(404).json({ error: "Shopify product not found" });
      }

      const variants = await storage.getShopifyProductVariants(product.id);
      res.json({ product, variants });
    } catch (error) {
      console.error("Error fetching Shopify product:", error);
      res.status(500).json({ error: "Failed to fetch Shopify product" });
    }
  });

  // Search Shopify products by barcode or SKU
  app.get("/api/shopify-products/search", requireAuth, async (req, res) => {
    try {
      const barcode = req.query.barcode as string;
      const sku = req.query.sku as string;

      if (!barcode && !sku) {
        return res.status(400).json({ error: "Either barcode or sku parameter is required" });
      }

      let variant = null;

      if (barcode) {
        variant = await storage.getShopifyVariantByBarcode(barcode);
      } else if (sku) {
        variant = await storage.getShopifyVariantBySku(sku);
      }

      if (!variant) {
        return res.status(404).json({ error: "Shopify product variant not found" });
      }

      const product = await storage.getShopifyProduct(variant.productId);

      res.json({ variant, product });
    } catch (error) {
      console.error("Error searching Shopify products:", error);
      res.status(500).json({ error: "Failed to search Shopify products" });
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
        
        // Fetch shipments from PostgreSQL to get accurate timestamps
        // PostgreSQL has the correct synced timestamps, Firestore may have stale/incorrect ones
        const pgShipments = await storage.getShipmentsBySessionId(picklistId);
        const shipmentTimestampMap = new Map<string, { 
          pickStartedAt: Date | null; 
          pickEndedAt: Date | null;
          createdAt: Date | null;
          updatedAt: Date | null;
        }>();
        for (const ship of pgShipments) {
          if (ship.orderNumber) {
            shipmentTimestampMap.set(ship.orderNumber, {
              pickStartedAt: ship.pickStartedAt,
              pickEndedAt: ship.pickEndedAt,
              createdAt: ship.createdAt,
              updatedAt: ship.updatedAt,
            });
          }
        }
        console.log(`Found ${pgShipments.length} shipments in PostgreSQL for session ${picklistId}, mapped ${shipmentTimestampMap.size} order timestamps`);
        
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
        // Use PostgreSQL timestamps instead of Firestore timestamps (Firestore can have stale data)
        const orders = firestoreSessions.map(session => {
          const pgTimestamps = shipmentTimestampMap.get(session.order_number);
          return {
            id: session.order_number, // Use order_number as id for frontend compatibility
            orderNumber: session.order_number,
            saleId: session.sale_id,
            shipmentId: session.shipment_id,
            spot_number: session.spot_number,
            status: session.session_status,
            pickerName: session.picked_by_user_name,
            // Use PostgreSQL timestamps if available, otherwise fall back to Firestore
            pickStartTime: pgTimestamps?.pickStartedAt || session.pick_start_datetime,
            pickEndTime: pgTimestamps?.pickEndedAt || session.pick_end_datetime,
            items: session.order_items.map(item => {
              // Ensure quantity is a number
              const qty = typeof item.quantity === 'number' ? item.quantity : 
                          typeof item.quantity === 'string' ? parseInt(item.quantity, 10) || 0 : 0;
              // Handle picked - could be boolean or number
              const pickedVal = typeof item.picked === 'boolean' ? (item.picked ? qty : 0) :
                                typeof item.picked === 'number' ? item.picked : 0;
              return {
                sku: item.sku,
                description: item.description,
                quantity: qty,
                location: item.location,
                locations: item.locations,
                picked: pickedVal,
                completed: item.completed,
                imageUrl: skuImageMap.get(item.sku) || (item.product_pictures?.[0] || null),
              };
            }),
          };
        });
        
        // Use the first session for picklist-level info
        const firstSession = firestoreSessions[0];
        const firstPgTimestamps = shipmentTimestampMap.get(firstSession.order_number);
        
        // Calculate summary counts from orders (quantities already coerced to numbers above)
        const orderCount = orders.length;
        const allSkus = new Set<string>();
        let totalQuantity = 0;
        let pickedQuantity = 0;
        
        for (const order of orders) {
          for (const item of order.items) {
            if (item.sku) {
              allSkus.add(item.sku);
            }
            totalQuantity += item.quantity;
            pickedQuantity += item.picked;
          }
        }
        
        return res.json({
          source: 'firestore',
          picklist: {
            picklistId: firstSession.session_picklist_id || picklistId,
            sessionId: firstSession.session_id,
            // Use 'state' field for frontend compatibility with parseSessionState()
            state: firstSession.session_status,
            status: firstSession.session_status,
            pickerName: firstSession.picked_by_user_name,
            pickerId: firstSession.picked_by_user_id,
            // Use PostgreSQL timestamps if available, otherwise fall back to Firestore
            pickStartTime: firstPgTimestamps?.pickStartedAt || firstSession.pick_start_datetime,
            pickEndTime: firstPgTimestamps?.pickEndedAt || firstSession.pick_end_datetime,
            createdAt: firstPgTimestamps?.createdAt || firstSession.create_date,
            updatedAt: firstPgTimestamps?.updatedAt || firstSession.updated_date,
            // Summary counts
            orderCount,
            skuCount: allSkus.size,
            totalQuantity,
            pickedQuantity,
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

  // Look up a product with full type discrimination (individual/kit/assembled)
  // Returns discriminated union type with all product details
  app.get("/api/skuvault/qc/product-details/:searchTerm", requireAuth, async (req, res) => {
    try {
      const { searchTerm } = req.params;
      console.log(`Looking up product details for QC: ${searchTerm}`);
      
      const { product, rawResponse } = await skuVaultService.getProductDetailsByCode(searchTerm);
      
      if (!product) {
        return res.status(404).json({ 
          error: "Product not found",
          message: `No product found with code/SKU: ${searchTerm}`,
          rawResponse
        });
      }
      
      res.json({ 
        product,
        productType: product.productType,
        rawResponse
      });
    } catch (error: any) {
      console.error("Error looking up product details for QC:", error);
      
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ 
        error: "Failed to lookup product details",
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
          
          // Update cache to keep it in sync with SkuVault after successful pass
          if (result?.Success && parseResult.data.OrderNumber) {
            updateCacheAfterScan({
              orderNumber: parseResult.data.OrderNumber,
              sku: parseResult.data.ScannedCode,
              scannedCode: parseResult.data.ScannedCode,
              quantity: parseResult.data.Quantity,
              itemId: parseResult.data.IdItem,
              userName: (req.user as any)?.displayName || (req.user as any)?.email || undefined,
            }).catch(err => console.warn(`[QC Pass] Cache update failed (non-blocking):`, err.message));
          }
          
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

  // Mark a kit component as QC passed
  app.post("/api/skuvault/qc/pass-kit-item", requireAuth, async (req, res) => {
    try {
      // Validate and parse request body with Zod schema
      const parseResult = qcPassKitSaleItemRequestSchema.safeParse(req.body);
      
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid request data",
          message: "Request body validation failed",
          details: parseResult.error.format()
        });
      }
      
      // Hybrid approach: Use cached SaleId if available
      let saleId = parseResult.data.IdSale;
      
      if (parseResult.data.IdSale === undefined && parseResult.data.OrderNumber) {
        try {
          console.log(`[QC Kit Pass] No cached SaleId, looking up for order: ${parseResult.data.OrderNumber}`);
          const saleInfo = await skuVaultService.getSaleInformation(parseResult.data.OrderNumber);
          if (saleInfo?.SaleId) {
            saleId = saleInfo.SaleId;
            console.log(`[QC Kit Pass] Found SaleId: ${saleId}`);
          } else {
            console.log(`[QC Kit Pass] Order not in SkuVault - skipping QC pass (non-blocking)`);
          }
        } catch (error: any) {
          console.log(`[QC Kit Pass] Lookup failed - skipping QC pass (non-blocking):`, error.message);
        }
      } else if (parseResult.data.IdSale === null) {
        console.log(`[QC Kit Pass] SaleId already looked up (not found) - skipping QC pass`);
      }
      
      // Only call SkuVault QC if we have a valid SaleId
      if (saleId) {
        try {
          const qcData = {
            ...parseResult.data,
            IdSale: saleId,
          };
          
          console.log(`[QC Kit Pass] Attempting kit QC pass with SaleId: ${saleId}, KitId: ${qcData.KitId}`);
          const result = await skuVaultService.passKitQCItem(qcData);
          
          // Update cache to keep it in sync with SkuVault after successful pass
          if (result?.Success && parseResult.data.OrderNumber) {
            updateCacheAfterScan({
              orderNumber: parseResult.data.OrderNumber,
              sku: parseResult.data.ScannedCode,
              scannedCode: parseResult.data.ScannedCode,
              quantity: parseResult.data.Quantity,
              itemId: parseResult.data.IdItem,
              kitId: parseResult.data.KitId,
              userName: (req.user as any)?.displayName || (req.user as any)?.email || undefined,
            }).catch(err => console.warn(`[QC Kit Pass] Cache update failed (non-blocking):`, err.message));
          }
          
          res.json(result);
        } catch (error: any) {
          // Graceful degradation: Log but return success so packing continues
          console.warn(`[QC Kit Pass] SkuVault kit QC pass failed (non-blocking):`, error.message);
          
          res.json({
            Success: true,
            Data: null,
            Errors: [],
          });
        }
      } else {
        // No SaleId available - skip QC pass but return success
        console.log(`[QC Kit Pass] No valid SaleId - skipping QC pass (order not in SkuVault)`);
        res.json({
          Success: true,
          Data: null,
          Errors: [],
        });
      }
    } catch (error: any) {
      console.error("Error marking kit component as QC passed:", error);
      
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ 
        error: "Failed to mark kit component as QC passed",
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

  // Get shipment packages for a specific shipment (accepts shipmentId or UUID)
  app.get("/api/shipments/:shipmentId/packages", requireAuth, async (req, res) => {
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
      
      // Fetch packages using the database ID
      const packages = await storage.getShipmentPackages(shipment.id);
      res.json(packages);
    } catch (error: any) {
      console.error(`Error fetching shipment packages for ${req.params.shipmentId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment packages" });
    }
  });

  // Get shipment QC items (fulfilled items) for a specific shipment (accepts shipmentId or UUID)
  // Enriched with availableQuantity from skuvault_products
  app.get("/api/shipments/:shipmentId/qc-items", requireAuth, async (req, res) => {
    try {
      const { skuvaultProducts } = await import("@shared/schema");
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
      
      // Fetch QC items with availableQuantity from skuvault_products
      const qcItemsWithInventory = await db
        .select({
          id: shipmentQcItems.id,
          shipmentId: shipmentQcItems.shipmentId,
          sku: shipmentQcItems.sku,
          barcode: shipmentQcItems.barcode,
          description: shipmentQcItems.description,
          quantityExpected: shipmentQcItems.quantityExpected,
          quantityScanned: shipmentQcItems.quantityScanned,
          collectionId: shipmentQcItems.collectionId,
          syncedToSkuvault: shipmentQcItems.syncedToSkuvault,
          isKitComponent: shipmentQcItems.isKitComponent,
          parentSku: shipmentQcItems.parentSku,
          createdAt: shipmentQcItems.createdAt,
          updatedAt: shipmentQcItems.updatedAt,
          imageUrl: shipmentQcItems.imageUrl,
          weightValue: shipmentQcItems.weightValue,
          weightUnit: shipmentQcItems.weightUnit,
          physicalLocation: shipmentQcItems.physicalLocation,
          availableQuantity: skuvaultProducts.availableQuantity,
        })
        .from(shipmentQcItems)
        .leftJoin(skuvaultProducts, eq(shipmentQcItems.sku, skuvaultProducts.sku))
        .where(eq(shipmentQcItems.shipmentId, shipment.id))
        .orderBy(shipmentQcItems.sku);
      
      res.json(qcItemsWithInventory);
    } catch (error: any) {
      console.error(`Error fetching shipment QC items for ${req.params.shipmentId}:`, error);
      res.status(500).json({ error: "Failed to fetch shipment QC items" });
    }
  });

  // Batch fetch shipment packages - reduces N+1 queries on shipments list page
  app.post("/api/shipments/packages/batch", requireAuth, async (req, res) => {
    try {
      const { shipmentIds } = req.body;
      
      if (!Array.isArray(shipmentIds)) {
        return res.status(400).json({ error: "shipmentIds must be an array" });
      }
      
      if (shipmentIds.length > 100) {
        return res.status(400).json({ error: "Maximum 100 shipments per batch request" });
      }
      
      // Fetch all packages in one query
      const packagesMap = await storage.getShipmentPackagesBatch(shipmentIds);
      
      // Convert Map to object for JSON response
      const result: Record<string, any[]> = {};
      for (const [shipmentId, packages] of packagesMap.entries()) {
        result[shipmentId] = packages;
      }
      
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching batch shipment packages:", error);
      res.status(500).json({ error: "Failed to fetch shipment packages" });
    }
  });

  // Batch fetch shipment tags - reduces N+1 queries on shipments list page
  app.post("/api/shipments/tags/batch", requireAuth, async (req, res) => {
    try {
      const { shipmentIds } = req.body;
      
      if (!Array.isArray(shipmentIds)) {
        return res.status(400).json({ error: "shipmentIds must be an array" });
      }
      
      if (shipmentIds.length > 100) {
        return res.status(400).json({ error: "Maximum 100 shipments per batch request" });
      }
      
      // Fetch all tags in one query
      const tagsMap = await storage.getShipmentTagsBatch(shipmentIds);
      
      // Convert Map to object for JSON response
      const result: Record<string, any[]> = {};
      for (const [shipmentId, tags] of tagsMap.entries()) {
        result[shipmentId] = tags;
      }
      
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching batch shipment tags:", error);
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

  // Backfill lifecycle phases for all shipments using the state machine
  // This recalculates lifecycle_phase based on current shipment data
  app.post("/api/shipments/backfill-lifecycle-phases", requireAuth, async (req, res) => {
    try {
      const { days } = req.body as { days?: number };
      const daysLabel = days ? `last ${days} days` : 'all time';
      console.log(`========== LIFECYCLE BACKFILL STARTED (${daysLabel}) ==========`);
      
      const shipmentsWithMoveOver = await storage.getShipmentsForLifecycleBackfill(days);
      console.log(`[Backfill] Found ${shipmentsWithMoveOver.length} shipments with MOVE OVER tag (${daysLabel})`);
      
      const events = shipmentsWithMoveOver.map(s => ({
        shipmentId: s.id,
        orderNumber: s.orderNumber,
        reason: 'backfill' as const,
        enqueuedAt: Date.now(),
      }));
      
      const enqueuedCount = await enqueueLifecycleEventBatch(events);
      console.log(`========== LIFECYCLE BACKFILL COMPLETE: ${enqueuedCount}/${shipmentsWithMoveOver.length} enqueued ==========`);
      
      res.json({
        success: true,
        totalFound: shipmentsWithMoveOver.length,
        enqueuedCount,
        message: `Enqueued ${enqueuedCount} shipments for lifecycle evaluation by the worker`,
      });
    } catch (error: any) {
      console.error("Error during lifecycle backfill:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to enqueue lifecycle backfill",
      });
    }
  });

  // Backfill smart carrier rate analysis for shipments
  // Analyzes shipments to find cost-effective shipping alternatives
  app.post("/api/shipments/backfill-rate-analysis", requireAuth, async (req, res) => {
    try {
      const { days, limit: batchLimit, skipExisting } = req.body as { days?: number; limit?: number; skipExisting?: boolean };
      const daysLabel = days ? `last ${days} days` : 'all time';
      const maxShipments = batchLimit || 100;
      const shouldSkipExisting = skipExisting !== false; // Default to true
      
      console.log(`========== RATE ANALYSIS BACKFILL STARTED (${daysLabel}, limit: ${maxShipments}, skipExisting: ${shouldSkipExisting}) ==========`);
      
      const { smartCarrierRateService } = await import('./services/smart-carrier-rate-service');
      const { shipmentRateAnalysis } = await import('@shared/schema');
      
      // Build base conditions
      const baseConditions = [
        isNotNull(shipments.serviceCode),
        isNotNull(shipments.shipToPostalCode),
        isNotNull(shipments.shipmentId)
      ];
      
      // Apply date filter if provided (using shipDate which is more reliably populated)
      if (days) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        baseConditions.push(gte(shipments.shipDate, cutoffDate));
      }
      
      // Get shipments that need analysis
      let shipmentsToAnalyze;
      
      if (shouldSkipExisting) {
        // Exclude shipments that already have rate analysis (left join + null check)
        shipmentsToAnalyze = await db
          .select({ shipment: shipments })
          .from(shipments)
          .leftJoin(shipmentRateAnalysis, eq(shipments.shipmentId, shipmentRateAnalysis.shipmentId))
          .where(
            and(
              ...baseConditions,
              isNull(shipmentRateAnalysis.shipmentId) // Only shipments without existing analysis
            )
          )
          .limit(maxShipments)
          .then(rows => rows.map(r => r.shipment));
      } else {
        // Analyze all matching shipments (re-analyze if requested)
        shipmentsToAnalyze = await db
          .select()
          .from(shipments)
          .where(and(...baseConditions))
          .limit(maxShipments);
      }
      
      console.log(`Found ${shipmentsToAnalyze.length} shipments for rate analysis backfill (${daysLabel})`);
      
      let successCount = 0;
      let failedCount = 0;
      const errors: string[] = [];
      
      for (const shipment of shipmentsToAnalyze) {
        try {
          const result = await smartCarrierRateService.analyzeAndSave(shipment);
          if (result.success) {
            successCount++;
          } else {
            failedCount++;
            errors.push(`${shipment.shipmentId}: ${result.error}`);
          }
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 150));
        } catch (error: any) {
          failedCount++;
          errors.push(`${shipment.shipmentId}: ${error.message}`);
        }
      }
      
      console.log(`========== RATE ANALYSIS BACKFILL COMPLETE ==========`);
      console.log(`Success: ${successCount}, Failed: ${failedCount}`);
      
      res.json({
        success: true,
        totalProcessed: shipmentsToAnalyze.length,
        successCount,
        failedCount,
        errors: errors.slice(0, 10),
        message: `Rate analysis backfill complete: ${successCount} shipments analyzed, ${failedCount} failed`,
      });
    } catch (error: any) {
      console.error("Error during rate analysis backfill:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to backfill rate analysis",
      });
    }
  });
  
  // Rate Analysis Jobs - Background job management
  // These jobs run in the background and survive page changes/logouts
  
  // Get all rate analysis jobs (for operations page)
  app.get("/api/rate-analysis-jobs", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getAllRateAnalysisJobs();
      const activeJob = await storage.getActiveRateAnalysisJob();
      res.json({ jobs, activeJob });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Create a new rate analysis job with a preset
  app.post("/api/rate-analysis-jobs", requireAuth, async (req, res) => {
    try {
      const { preset } = req.body as { preset: '1day' | '7days' | '30days' | '90days' | '1year' | 'eligible' };
      
      if (!preset || !['1day', '7days', '30days', '90days', '1year', 'eligible'].includes(preset)) {
        return res.status(400).json({ error: 'Invalid preset. Must be: 1day, 7days, 30days, 90days, 1year, or eligible' });
      }
      
      // Check if there's already an active job
      const activeJob = await storage.getActiveRateAnalysisJob();
      if (activeJob) {
        return res.status(409).json({ 
          error: 'A rate analysis job is already running',
          activeJob 
        });
      }
      
      // Determine days back from preset
      // 'eligible' uses null (no date filter) - relies on eligibility criteria only
      const daysBackMap: Record<string, number | null> = {
        '1day': 1,
        '7days': 7,
        '30days': 30,
        '90days': 90,
        '1year': 365,
        'eligible': null,
      };
      
      const job = await storage.createRateAnalysisJob({
        preset,
        daysBack: daysBackMap[preset],
        status: 'pending',
      });
      
      console.log(`[RateAnalysis] Created job ${job.id} with preset ${preset}`);
      res.json({ success: true, job });
    } catch (error: any) {
      console.error("Error creating rate analysis job:", error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Cancel a rate analysis job
  app.post("/api/rate-analysis-jobs/:id/cancel", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.cancelRateAnalysisJob(id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Lifecycle Repair Jobs - repair stale lifecycle phases
  app.get("/api/lifecycle-repair-jobs", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getAllLifecycleRepairJobs();
      const activeJob = await storage.getActiveLifecycleRepairJob();
      res.json({ jobs, activeJob });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.post("/api/lifecycle-repair-jobs", requireAuth, async (req, res) => {
    try {
      // Check if there's already an active job
      const activeJob = await storage.getActiveLifecycleRepairJob();
      if (activeJob) {
        return res.status(409).json({ 
          error: 'A lifecycle repair job is already running',
          activeJob 
        });
      }
      
      const job = await storage.createLifecycleRepairJob({
        status: 'pending',
      });
      
      console.log(`[LifecycleRepair] Created job ${job.id}`);
      res.json({ success: true, job });
    } catch (error: any) {
      console.error("Error creating lifecycle repair job:", error);
      res.status(500).json({ error: error.message });
    }
  });
  
  app.post("/api/lifecycle-repair-jobs/:id/cancel", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.cancelLifecycleRepairJob(id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  // Smart Rate Check Page - Rate analysis data with filtering, pagination, sorting, and metrics
  app.get("/api/rate-analysis", requireAuth, async (req, res) => {
    try {
      const { 
        orderDateFrom,
        orderDateTo,
        orderNumber,
        lifecyclePhase,
        sortBy = 'analyzedAt',
        sortOrder = 'desc',
        page = '1',
        limit = '25'
      } = req.query;
      
      const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 25));
      const offset = (pageNum - 1) * limitNum;
      
      // Build dynamic conditions
      const conditions: SQL<unknown>[] = [];
      
      if (orderDateFrom) {
        conditions.push(gte(shipments.orderDate, new Date(orderDateFrom as string)));
      }
      if (orderDateTo) {
        // Set to end of day (23:59:59.999) to include all records from that day
        const toDate = new Date(orderDateTo as string);
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(shipments.orderDate, toDate));
      }
      if (orderNumber) {
        conditions.push(ilike(shipments.orderNumber, `%${orderNumber}%`));
      }
      if (lifecyclePhase) {
        conditions.push(eq(shipments.lifecyclePhase, lifecyclePhase as string));
      }
      
      // Get total count for pagination
      const countQuery = db
        .select({ count: sql<number>`count(*)::int` })
        .from(shipmentRateAnalysis)
        .innerJoin(shipments, eq(shipmentRateAnalysis.shipmentId, shipments.shipmentId))
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      
      const [{ count: totalCount }] = await countQuery;
      
      // Build sort order
      type SortableColumn = 'analyzedAt' | 'costSavings' | 'customerShippingCost' | 'smartShippingCost' | 'orderDate';
      const sortColumn = (sortBy as SortableColumn) || 'analyzedAt';
      const sortDir = sortOrder === 'asc' ? asc : desc;
      
      const sortMapping: Record<SortableColumn, any> = {
        analyzedAt: shipmentRateAnalysis.createdAt,
        costSavings: shipmentRateAnalysis.costSavings,
        customerShippingCost: shipmentRateAnalysis.customerShippingCost,
        smartShippingCost: shipmentRateAnalysis.smartShippingCost,
        orderDate: shipments.orderDate
      };
      
      // Get paginated results with shipment data
      const results = await db
        .select({
          // Rate analysis fields
          shipmentId: shipmentRateAnalysis.shipmentId,
          customerShippingMethod: shipmentRateAnalysis.customerShippingMethod,
          customerShippingCost: shipmentRateAnalysis.customerShippingCost,
          customerDeliveryDays: shipmentRateAnalysis.customerDeliveryDays,
          smartShippingMethod: shipmentRateAnalysis.smartShippingMethod,
          smartShippingCost: shipmentRateAnalysis.smartShippingCost,
          smartDeliveryDays: shipmentRateAnalysis.smartDeliveryDays,
          costSavings: shipmentRateAnalysis.costSavings,
          reasoning: shipmentRateAnalysis.reasoning,
          ratesComparedCount: shipmentRateAnalysis.ratesComparedCount,
          carrierCode: shipmentRateAnalysis.carrierCode,
          serviceCode: shipmentRateAnalysis.serviceCode,
          originPostalCode: shipmentRateAnalysis.originPostalCode,
          destinationPostalCode: shipmentRateAnalysis.destinationPostalCode,
          destinationState: shipmentRateAnalysis.destinationState,
          analyzedAt: shipmentRateAnalysis.createdAt,
          allRatesChecked: shipmentRateAnalysis.allRatesChecked,
          // Package dimensions used for rate check
          packageWeightOz: shipmentRateAnalysis.packageWeightOz,
          packageLengthIn: shipmentRateAnalysis.packageLengthIn,
          packageWidthIn: shipmentRateAnalysis.packageWidthIn,
          packageHeightIn: shipmentRateAnalysis.packageHeightIn,
          // Shipment fields for display and filtering
          orderNumber: shipments.orderNumber,
          orderDate: shipments.orderDate,
          lifecyclePhase: shipments.lifecyclePhase,
          decisionSubphase: shipments.decisionSubphase,
          // Actual shipping cost from label creation (stored in shipments table)
          actualShippingCost: shipments.shippingCost,
        })
        .from(shipmentRateAnalysis)
        .innerJoin(shipments, eq(shipmentRateAnalysis.shipmentId, shipments.shipmentId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sortDir(sortMapping[sortColumn] || shipmentRateAnalysis.createdAt))
        .limit(limitNum)
        .offset(offset);
      
      // Calculate aggregate metrics (for all matching records, not just current page)
      // Uses shipments.shippingCost for actual label cost (from unified sync worker)
      const metricsQuery = await db
        .select({
          totalAnalyzed: sql<number>`count(*)::int`,
          totalSavings: sql<string>`coalesce(sum(${shipmentRateAnalysis.costSavings}), 0)`,
          totalCurrentSpend: sql<string>`coalesce(sum(${shipmentRateAnalysis.customerShippingCost}), 0)`,
          totalRecommendedSpend: sql<string>`coalesce(sum(${shipmentRateAnalysis.smartShippingCost}), 0)`,
          shipmentsWithSavings: sql<number>`count(case when ${shipmentRateAnalysis.costSavings} > 0 then 1 end)::int`,
          // Actual cost metrics from shipments.shippingCost (label cost from ShipStation)
          shipmentsWithActualCost: sql<number>`count(case when ${shipments.shippingCost} is not null then 1 end)::int`,
          totalActualSpend: sql<string>`coalesce(sum(${shipments.shippingCost}), 0)`,
          // Realized savings: when actual cost <= smart recommendation (adopted recommendation)
          adoptedRecommendationCount: sql<number>`count(case when ${shipments.shippingCost} is not null and ${shipments.shippingCost} <= ${shipmentRateAnalysis.smartShippingCost} then 1 end)::int`,
          // Realized savings = sum of (customer rate - actual cost) when actual cost <= smart rate
          realizedSavings: sql<string>`coalesce(sum(case when ${shipments.shippingCost} is not null and ${shipments.shippingCost} <= ${shipmentRateAnalysis.smartShippingCost} then ${shipmentRateAnalysis.customerShippingCost} - ${shipments.shippingCost} else 0 end), 0)`,
          // Missed savings = sum of (actual cost - smart rate) when actual cost > smart rate and there was savings opportunity
          missedSavings: sql<string>`coalesce(sum(case when ${shipments.shippingCost} is not null and ${shipments.shippingCost} > ${shipmentRateAnalysis.smartShippingCost} and ${shipmentRateAnalysis.costSavings} > 0 then ${shipments.shippingCost} - ${shipmentRateAnalysis.smartShippingCost} else 0 end), 0)`,
        })
        .from(shipmentRateAnalysis)
        .innerJoin(shipments, eq(shipmentRateAnalysis.shipmentId, shipments.shipmentId))
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      
      const metrics = metricsQuery[0];
      const totalAnalyzed = metrics.totalAnalyzed || 0;
      const shipmentsWithSavings = metrics.shipmentsWithSavings || 0;
      const shipmentsWithActualCost = metrics.shipmentsWithActualCost || 0;
      const totalSavings = parseFloat(metrics.totalSavings) || 0;
      const adoptedRecommendationCount = metrics.adoptedRecommendationCount || 0;
      
      res.json({
        data: results,
        pagination: {
          page: pageNum,
          limit: limitNum,
          totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
        metrics: {
          totalAnalyzed,
          totalPotentialSavings: totalSavings,
          totalCustomerShippingCost: parseFloat(metrics.totalCurrentSpend) || 0,
          totalRecommendedSpend: parseFloat(metrics.totalRecommendedSpend) || 0,
          shipmentsWithSavings,
          percentWithSavings: totalAnalyzed > 0 ? Math.round((shipmentsWithSavings / totalAnalyzed) * 100) : 0,
          averageSavingsPerShipment: totalAnalyzed > 0 ? totalSavings / totalAnalyzed : 0,
          // Actual cost metrics
          totalActualSpend: parseFloat(metrics.totalActualSpend) || 0,
          shipmentsWithActualCost,
          realizedSavings: parseFloat(metrics.realizedSavings) || 0,
          missedSavings: parseFloat(metrics.missedSavings) || 0,
          adoptedRecommendationCount,
          adoptionRate: shipmentsWithActualCost > 0 ? Math.round((adoptedRecommendationCount / shipmentsWithActualCost) * 100) : 0,
        }
      });
    } catch (error: any) {
      console.error("Error fetching rate analysis data:", error);
      res.status(500).json({ error: error.message });
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

      // Trigger immediate poll from unified sync worker (webhook as hint)
      try {
        const { triggerImmediatePoll } = await import("./unified-shipment-sync-worker");
        triggerImmediatePoll();
      } catch (err) {
        // Worker may not be running yet - log but don't fail the webhook
        console.log("[webhook] Could not trigger immediate poll:", err);
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error("Error processing ShipStation webhook:", error);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Slashbin webhook endpoint - receives transformed kit mappings
  app.post("/api/webhooks/slashbin/kitMappings", async (req, res) => {
    try {
      const signatureHeader = req.headers['x-slashbin-signature'] as string | undefined;
      const jobId = req.headers['x-slashbin-job-id'] as string;
      
      const signingSecret = process.env.KIT_MAPPING_SIGNING_KEY;
      if (!signingSecret) {
        console.error("[Slashbin/KitMappings] KIT_MAPPING_SIGNING_KEY not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      
      const rawBody = req.rawBody as Buffer;
      if (!verifySlashbinWebhook(rawBody, signatureHeader, signingSecret)) {
        console.error("[Slashbin/KitMappings] HMAC verification FAILED");
        return res.status(401).json({ error: "Webhook verification failed" });
      }
      
      const payloadJobId = req.body.slashbinJobId || jobId;
      if (payloadJobId && isJobAlreadyProcessed(payloadJobId)) {
        return res.status(200).json({ success: true, message: "Already processed" });
      }
      
      const kitPayload = req.body.payload;
      if (!kitPayload || !kitPayload.sku) {
        console.error("[Slashbin/KitMappings] Parse FAILED - missing payload.sku");
        return res.status(400).json({ error: "Invalid payload: missing sku" });
      }
      
      const kitSku = kitPayload.sku;
      const items = kitPayload.items || [];
      
      await db.delete(slashbinKitComponentMappings).where(eq(slashbinKitComponentMappings.kitSku, kitSku));
      
      if (items.length > 0) {
        const mappingsToInsert = items.map((item: { sku: string; quantity: number }) => ({
          kitSku,
          componentSku: item.sku,
          componentQuantity: item.quantity || 1,
        }));
        await db.insert(slashbinKitComponentMappings).values(mappingsToInsert);
      }
      
      console.log(`[Slashbin/KitMappings] OK: ${kitSku} (${items.length} components)`);
      
      if (payloadJobId) {
        markJobAsProcessed(payloadJobId);
      }
      
      res.status(200).json({ success: true, jobId: payloadJobId, kitSku, componentCount: items.length });
      
    } catch (error: any) {
      console.error("[Slashbin/KitMappings] Error:", error.message);
      res.status(500).json({ error: "Failed to process webhook" });
    }
  });

  // Slashbin webhook endpoint - receives Shopify orders from Slashbin
  app.post("/api/webhooks/slashbin/shopifyOrders", async (req, res) => {
    try {
      // Extract headers
      const signatureHeader = req.headers['x-slashbin-signature'] as string | undefined;
      const jobId = req.headers['x-slashbin-job-id'] as string;
      
      // Get signing secret
      const signingSecret = process.env.SLASHBIN_SHOPIFY_ORDERS_SIGNING_KEY;
      
      if (!signingSecret) {
        console.error("[Slashbin/ShopifyOrders] SLASHBIN_SHOPIFY_ORDERS_SIGNING_KEY not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      
      // Verify signature
      const rawBody = req.rawBody as Buffer;
      if (!verifySlashbinWebhook(rawBody, signatureHeader, signingSecret)) {
        console.error("[Slashbin/ShopifyOrders] HMAC FAILED - sig:", signatureHeader ? 'present' : 'missing', "body:", rawBody?.length || 0, "bytes");
        return res.status(401).json({ error: "Webhook verification failed" });
      }
      
      // Check idempotency - avoid processing duplicate webhooks
      const payloadJobId = req.body.slashbin_job_id || jobId;
      if (payloadJobId && isJobAlreadyProcessed(payloadJobId)) {
        return res.status(200).json({ success: true, message: "Already processed" });
      }
      
      // Process Shopify order payload - structure uses snake_case from Slashbin
      const orderPayload = req.body.payload;
      if (!orderPayload || !orderPayload.order_number) {
        console.error("[Slashbin/ShopifyOrders] HMAC OK, Parse FAILED - missing order_number. Keys:", orderPayload ? Object.keys(orderPayload) : 'null');
        return res.status(400).json({ error: "Invalid payload: missing order_number" });
      }
      
      const orderNumber = orderPayload.order_number;
      const items = orderPayload.order_items || [];
      
      // Upsert order data into slashbin_orders table (mapping snake_case to camelCase)
      const orderData = {
        orderNumber: orderPayload.order_number,
        orderTotal: orderPayload.order_total?.toString() || null,
        orderDate: orderPayload.order_date ? new Date(orderPayload.order_date) : null,
        buyerEmail: orderPayload.buyer_email || null,
        taxTotal: orderPayload.tax_total?.toString() || null,
        subTotal: orderPayload.sub_total?.toString() || null,
        shippingCost: orderPayload.shipping_cost?.toString() || null,
        discountTotal: orderPayload.discount_total?.toString() || null,
        tags: orderPayload.tags || null,
        refundTotal: orderPayload.refund_total?.toString() || null,
        notes: orderPayload.notes || null,
        shippingMethod: orderPayload.shipping_method || null,
        orderStatus: orderPayload.order_status || null,
        salesChannel: orderPayload.sales_channel || null,
        // Flattened shipping fields (from payload.shipping)
        shippingFirstName: orderPayload.shipping?.first_name || null,
        shippingLastName: orderPayload.shipping?.last_name || null,
        shippingAddress1: orderPayload.shipping?.address1 || null,
        shippingAddress2: orderPayload.shipping?.address2 || null,
        shippingCity: orderPayload.shipping?.city || null,
        shippingProvince: orderPayload.shipping?.province || null,
        shippingProvinceCode: orderPayload.shipping?.province_code || null,
        shippingZip: orderPayload.shipping?.zip || null,
        shippingCountry: orderPayload.shipping?.country || null,
        shippingCountryCode: orderPayload.shipping?.country_code || null,
        shippingPhone: orderPayload.shipping?.phone || null,
        shippingCompany: orderPayload.shipping?.company || null,
        // Flattened customer fields
        customerId: orderPayload.customer?.id?.toString() || orderPayload.customer?.customer_id?.toString() || null,
        customerEmail: orderPayload.customer?.email || null,
        customerFirstName: orderPayload.customer?.first_name || null,
        customerLastName: orderPayload.customer?.last_name || null,
        customerPhone: orderPayload.customer?.phone || null,
        customerCreatedAt: orderPayload.customer?.created_at ? new Date(orderPayload.customer.created_at) : null,
        customerCurrency: orderPayload.customer?.currency || null,
        customerProvince: orderPayload.customer?.province || null,
        customerCountry: orderPayload.customer?.country || null,
        customerAddress1: orderPayload.customer?.address1 || null,
        customerCity: orderPayload.customer?.city || null,
        customerZip: orderPayload.customer?.zip || null,
        updatedAt: new Date(),
      };
      
      // Upsert the order (insert or update on conflict)
      await db.insert(slashbinOrders)
        .values(orderData)
        .onConflictDoUpdate({
          target: slashbinOrders.orderNumber,
          set: {
            ...orderData,
            updatedAt: new Date(),
          },
        });
      
      // Delete existing items for this order, then insert new ones
      await db.delete(slashbinOrderItems).where(eq(slashbinOrderItems.orderNumber, orderNumber));
      
      if (items.length > 0) {
        const itemsToInsert = items.map((item: any) => ({
          orderNumber,
          sku: item.sku || '',
          productName: item.product_name || null,
          qty: item.qty || null,
          fulfillmentStatus: item.fulfillment_status || null,
          price: item.price?.toString() || null,
          productBrand: item.product_brand || null,
          weight: item.weight?.toString() || null,
          tax: item.tax?.toString() || null,
          subtotal: item.subtotal?.toString() || null,
          productId: item.product_id?.toString() || null,
        }));
        
        await db.insert(slashbinOrderItems).values(itemsToInsert);
      }
      
      // Mark job as processed for idempotency
      if (payloadJobId) {
        markJobAsProcessed(payloadJobId);
      }
      
      // Return 200 to acknowledge receipt
      res.status(200).json({ success: true, jobId: payloadJobId, orderNumber, itemCount: items.length });
      
    } catch (error: any) {
      console.error("[Slashbin/ShopifyOrders] Error:", error.message);
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

  // Broken shipments report - finds shipments with data integrity issues
  app.get("/api/reports/broken-shipments", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      // Parse optional date range (Central Time)
      let start: Date | undefined;
      let end: Date | undefined;
      
      if (startDate && typeof startDate === 'string') {
        start = fromZonedTime(`${startDate} 00:00:00`, CST_TIMEZONE);
        if (isNaN(start.getTime())) start = undefined;
      }
      if (endDate && typeof endDate === 'string') {
        end = fromZonedTime(`${endDate} 23:59:59.999`, CST_TIMEZONE);
        if (isNaN(end.getTime())) end = undefined;
      }
      
      // Get shipments with data integrity issues:
      // 1. Has labelUrl but no trackingNumber (label created but tracking lost)
      // 2. Has shipmentId but we can't retrieve it from ShipStation (orphaned)
      // 3. Missing shipmentData entirely
      const brokenShipments = await storage.getBrokenShipments(start, end);
      
      // Categorize the issues
      let hasLabelNoTracking = 0;
      let orphanedShipmentId = 0;
      let missingShipmentData = 0;
      
      for (const shipment of brokenShipments) {
        if (shipment.labelUrl && !shipment.trackingNumber) {
          hasLabelNoTracking++;
        }
        if (shipment.shipmentId && !shipment.shipmentData) {
          orphanedShipmentId++;
        }
        if (!shipment.shipmentData && !shipment.shipmentId) {
          missingShipmentData++;
        }
      }
      
      res.json({
        shipments: brokenShipments.map(s => ({
          id: s.id,
          orderId: s.orderId,
          orderNumber: s.orderNumber,
          shipmentId: s.shipmentId,
          trackingNumber: s.trackingNumber,
          labelUrl: s.labelUrl,
          carrierCode: s.carrierCode,
          status: s.status,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
        total: brokenShipments.length,
        summary: {
          hasLabelNoTracking,
          orphanedShipmentId,
          missingShipmentData,
        },
      });
    } catch (error) {
      console.error("Error fetching broken shipments:", error);
      res.status(500).json({ error: "Failed to fetch broken shipments" });
    }
  });

  // Dead-lettered shipments report - shipments that failed ETL processing
  app.get("/api/reports/shipments-dlq", requireAuth, async (req, res) => {
    try {
      const { search, page = "1", limit = "50" } = req.query;
      const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
      
      // Get all dead letters
      const allDeadLetters = await storage.getAllShipmentsDeadLetters(1000);
      
      // Filter by search if provided
      let filtered = allDeadLetters;
      if (search && typeof search === 'string' && search.trim()) {
        const searchLower = search.toLowerCase().trim();
        filtered = allDeadLetters.filter(dl => {
          const data = dl.data as any;
          return (
            dl.shipmentId.toLowerCase().includes(searchLower) ||
            (dl.reason && dl.reason.toLowerCase().includes(searchLower)) ||
            (data?.ship_to?.name && data.ship_to.name.toLowerCase().includes(searchLower)) ||
            (data?.ship_to?.city_locality && data.ship_to.city_locality.toLowerCase().includes(searchLower)) ||
            (data?.ship_to?.state_province && data.ship_to.state_province.toLowerCase().includes(searchLower))
          );
        });
      }
      
      // Paginate
      const total = filtered.length;
      const totalPages = Math.ceil(total / limitNum);
      const offset = (pageNum - 1) * limitNum;
      const paginated = filtered.slice(offset, offset + limitNum);
      
      res.json({
        deadLetters: paginated.map(dl => ({
          shipmentId: dl.shipmentId,
          reason: dl.reason,
          createdAt: dl.createdAt,
          updatedAt: dl.updatedAt,
          data: dl.data,
        })),
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      });
    } catch (error) {
      console.error("Error fetching dead-lettered shipments:", error);
      res.status(500).json({ error: "Failed to fetch dead-lettered shipments" });
    }
  });

  // Kit Mappings Comparison Report - compares kit_component_mappings with slashbin_kit_component_mappings
  app.get("/api/reports/kit-mappings-comparison", requireAuth, async (req, res) => {
    try {
      // Get summary counts
      const summaryResult = await db.execute(sql`
        SELECT 
          (SELECT COUNT(DISTINCT kit_sku) FROM kit_component_mappings) as normal_kit_count,
          (SELECT COUNT(DISTINCT kit_sku) FROM slashbin_kit_component_mappings) as slashbin_kit_count,
          (SELECT COUNT(*) FROM kit_component_mappings) as normal_total_mappings,
          (SELECT COUNT(*) FROM slashbin_kit_component_mappings) as slashbin_total_mappings
      `);
      const summary = summaryResult.rows[0] as {
        normal_kit_count: string;
        slashbin_kit_count: string;
        normal_total_mappings: string;
        slashbin_total_mappings: string;
      };

      // Kits only in normal table (not in slashbin)
      const kitsOnlyInNormalResult = await db.execute(sql`
        SELECT k.kit_sku, k.component_sku, k.component_quantity
        FROM kit_component_mappings k
        WHERE k.kit_sku NOT IN (SELECT DISTINCT kit_sku FROM slashbin_kit_component_mappings)
        ORDER BY k.kit_sku, k.component_sku
      `);

      // Kits only in slashbin table (not in normal)
      const kitsOnlyInSlashbinResult = await db.execute(sql`
        SELECT s.kit_sku, s.component_sku, s.component_quantity
        FROM slashbin_kit_component_mappings s
        WHERE s.kit_sku NOT IN (SELECT DISTINCT kit_sku FROM kit_component_mappings)
        ORDER BY s.kit_sku, s.component_sku
      `);

      // Components only in normal (for kits that exist in both tables)
      const componentsOnlyInNormalResult = await db.execute(sql`
        SELECT k.kit_sku, k.component_sku, k.component_quantity, 'missing_in_slashbin' as diff_type
        FROM kit_component_mappings k
        WHERE k.kit_sku IN (SELECT DISTINCT kit_sku FROM slashbin_kit_component_mappings)
          AND NOT EXISTS (
            SELECT 1 FROM slashbin_kit_component_mappings s 
            WHERE s.kit_sku = k.kit_sku AND s.component_sku = k.component_sku
          )
        ORDER BY k.kit_sku, k.component_sku
      `);

      // Components only in slashbin (for kits that exist in both tables)
      const componentsOnlyInSlashbinResult = await db.execute(sql`
        SELECT s.kit_sku, s.component_sku, s.component_quantity, 'missing_in_normal' as diff_type
        FROM slashbin_kit_component_mappings s
        WHERE s.kit_sku IN (SELECT DISTINCT kit_sku FROM kit_component_mappings)
          AND NOT EXISTS (
            SELECT 1 FROM kit_component_mappings k 
            WHERE k.kit_sku = s.kit_sku AND k.component_sku = s.component_sku
          )
        ORDER BY s.kit_sku, s.component_sku
      `);

      // Quantity mismatches (same kit + component but different quantities)
      const quantityMismatchesResult = await db.execute(sql`
        SELECT 
          k.kit_sku, 
          k.component_sku, 
          k.component_quantity as normal_quantity,
          s.component_quantity as slashbin_quantity,
          'quantity_mismatch' as diff_type
        FROM kit_component_mappings k
        INNER JOIN slashbin_kit_component_mappings s 
          ON k.kit_sku = s.kit_sku AND k.component_sku = s.component_sku
        WHERE k.component_quantity != s.component_quantity
        ORDER BY k.kit_sku, k.component_sku
      `);

      res.json({
        summary: {
          normalKitCount: parseInt(summary.normal_kit_count) || 0,
          slashbinKitCount: parseInt(summary.slashbin_kit_count) || 0,
          normalTotalMappings: parseInt(summary.normal_total_mappings) || 0,
          slashbinTotalMappings: parseInt(summary.slashbin_total_mappings) || 0,
        },
        kitsOnlyInNormal: kitsOnlyInNormalResult.rows.map((row: any) => ({
          kitSku: row.kit_sku,
          componentSku: row.component_sku,
          componentQuantity: row.component_quantity,
        })),
        kitsOnlyInSlashbin: kitsOnlyInSlashbinResult.rows.map((row: any) => ({
          kitSku: row.kit_sku,
          componentSku: row.component_sku,
          componentQuantity: row.component_quantity,
        })),
        componentDifferences: [
          ...componentsOnlyInNormalResult.rows.map((row: any) => ({
            kitSku: row.kit_sku,
            componentSku: row.component_sku,
            normalQuantity: row.component_quantity,
            slashbinQuantity: null,
            diffType: 'missing_in_slashbin',
          })),
          ...componentsOnlyInSlashbinResult.rows.map((row: any) => ({
            kitSku: row.kit_sku,
            componentSku: row.component_sku,
            normalQuantity: null,
            slashbinQuantity: row.component_quantity,
            diffType: 'missing_in_normal',
          })),
          ...quantityMismatchesResult.rows.map((row: any) => ({
            kitSku: row.kit_sku,
            componentSku: row.component_sku,
            normalQuantity: row.normal_quantity,
            slashbinQuantity: row.slashbin_quantity,
            diffType: 'quantity_mismatch',
          })),
        ],
      });
    } catch (error) {
      console.error("Error generating kit mappings comparison:", error);
      res.status(500).json({ error: "Failed to generate kit mappings comparison" });
    }
  });

  // Duplicate shipments report - finds orders with multiple shipments
  app.get("/api/reports/duplicate-shipments", requireAuth, async (req, res) => {
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

      // Get orders with duplicate shipments
      const duplicates = await storage.getDuplicateShipments(start, end);
      
      // Calculate totals
      const totalOrders = duplicates.length;
      const totalDuplicateShipments = duplicates.reduce((sum, d) => sum + d.shipmentCount, 0);
      
      res.json({
        startDate,
        endDate,
        totalOrders,
        totalDuplicateShipments,
        duplicates: duplicates.map(d => ({
          ...d,
          shipments: d.shipments.map(s => ({
            ...s,
            shipDate: s.shipDate?.toISOString() || null,
            createdAt: s.createdAt?.toISOString() || null,
          })),
        })),
      });
    } catch (error) {
      console.error("Error fetching duplicate shipments:", error);
      res.status(500).json({ error: "Failed to fetch duplicate shipments" });
    }
  });

  // Fix shipment number in ShipStation - updates to format: [orderNumber]-[shipmentIdNumber]
  app.post("/api/shipments/:id/fix-shipment-number", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get the shipment from our database
      const shipment = await storage.getShipment(id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      if (!shipment.shipmentId) {
        return res.status(400).json({ error: "Shipment has no ShipStation shipment ID" });
      }
      
      if (!shipment.orderNumber) {
        return res.status(400).json({ error: "Shipment has no order number" });
      }
      
      // Extract the numeric part from the shipment_id (e.g., "se-924665462" -> "924665462")
      const shipmentIdNumber = shipment.shipmentId.replace(/^se-/, '');
      
      // Construct the new shipment_number format: orderNumber-shipmentIdNumber
      const newShipmentNumber = `${shipment.orderNumber}-${shipmentIdNumber}`;
      
      console.log(`[Fix Shipment Number] Updating ${shipment.shipmentId} from order ${shipment.orderNumber} to shipment_number: ${newShipmentNumber}`);
      
      // Call ShipStation API to update the shipment_number
      const result = await updateShipmentNumber(shipment.shipmentId, newShipmentNumber);
      
      if (!result.success) {
        console.error(`[Fix Shipment Number] Failed: ${result.error}`);
        return res.status(500).json({ error: result.error || "Failed to update shipment number in ShipStation" });
      }
      
      // Update our local shipmentData if it exists
      if (shipment.shipmentData) {
        const updatedShipmentData = {
          ...(shipment.shipmentData as any),
          shipment_number: newShipmentNumber,
        };
        await storage.updateShipment(shipment.id, { shipmentData: updatedShipmentData });
      }
      
      console.log(`[Fix Shipment Number] Successfully updated ${shipment.shipmentId} shipment_number to: ${newShipmentNumber}`);
      
      res.json({ 
        success: true,
        shipmentId: shipment.shipmentId,
        oldShipmentNumber: shipment.orderNumber,
        newShipmentNumber,
        message: `Successfully updated shipment_number to ${newShipmentNumber}`
      });
    } catch (error: any) {
      console.error("Error fixing shipment number:", error);
      res.status(500).json({ error: error.message || "Failed to fix shipment number" });
    }
  });

  // Packed shipments report - shows shipments by date they were packed
  app.get("/api/reports/packed-shipments", requireAuth, async (req, res) => {
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

      // Get all packing_completed events and timing data in parallel
      const [packingEvents, timingData] = await Promise.all([
        storage.getPackingCompletedEvents(start, end),
        storage.getPackingTimingData(start, end),
      ]);
      
      // Build timing, sessionId, and station lookup maps: key = eventId (unique per packing_completed event)
      // This prevents collisions when multiple events have identical timestamps
      const timingMap = new Map<string, number>();
      const sessionIdMap = new Map<string, string | null>();
      const stationIdMap = new Map<string, string | null>();
      const stationTypeMap = new Map<string, string | null>();
      for (const t of timingData) {
        timingMap.set(t.eventId, t.packingSeconds);
        sessionIdMap.set(t.eventId, t.sessionId);
        stationIdMap.set(t.eventId, t.stationId);
        stationTypeMap.set(t.eventId, t.stationType);
      }
      
      // First, group events by order number to deduplicate
      // Keep the most recent packing event for each order
      const orderMap: Record<string, { 
        orderNumber: string;
        packedAt: Date;
        packedBy: string;
        eventCount: number;
        packingSeconds: number | null;
        sessionId: string | null;
        stationId: string | null;
        stationType: string | null;
      }> = {};
      
      for (const event of packingEvents) {
        const existing = orderMap[event.orderNumber!];
        if (!existing || event.occurredAt > existing.packedAt) {
          // Look up timing, sessionId, and station using the event's unique id
          const packingSeconds = timingMap.get(event.id) ?? null;
          const sessionId = sessionIdMap.get(event.id) ?? null;
          const stationId = stationIdMap.get(event.id) ?? null;
          const stationType = stationTypeMap.get(event.id) ?? null;
          
          orderMap[event.orderNumber] = {
            orderNumber: event.orderNumber,
            packedAt: event.occurredAt,
            packedBy: event.username,
            eventCount: existing ? existing.eventCount + 1 : 1,
            packingSeconds,
            sessionId,
            stationId,
            stationType,
          };
        } else {
          existing.eventCount++;
        }
      }
      
      const uniqueOrders = Object.values(orderMap);
      
      // Calculate overall timing statistics
      const ordersWithTiming = uniqueOrders.filter(o => o.packingSeconds !== null);
      const totalPackingSeconds = ordersWithTiming.reduce((sum, o) => sum + (o.packingSeconds || 0), 0);
      const overallAvgPackingSeconds = ordersWithTiming.length > 0 
        ? totalPackingSeconds / ordersWithTiming.length 
        : null;
      
      // Group unique orders by date (in Central Time)
      const byDate: Record<string, typeof uniqueOrders> = {};
      const byUser: Record<string, { count: number; totalSeconds: number; ordersWithTiming: number }> = {};
      const byStation: Record<string, { count: number; totalSeconds: number; ordersWithTiming: number }> = {};
      const bySession: Record<string, { count: number; totalSeconds: number; ordersWithTiming: number }> = {};
      // Track session totals per station (key: stationId:sessionId)
      const byStationSession: Record<string, { stationId: string; sessionId: string; totalSeconds: number; orderCount: number }> = {};
      
      for (const order of uniqueOrders) {
        // Format date as YYYY-MM-DD in Central Time
        const dateKey = formatInTimeZone(order.packedAt, CST_TIMEZONE, 'yyyy-MM-dd');
        
        if (!byDate[dateKey]) {
          byDate[dateKey] = [];
        }
        byDate[dateKey].push(order);
        
        // Aggregate user timing stats
        if (!byUser[order.packedBy]) {
          byUser[order.packedBy] = { count: 0, totalSeconds: 0, ordersWithTiming: 0 };
        }
        byUser[order.packedBy].count++;
        if (order.packingSeconds !== null) {
          byUser[order.packedBy].totalSeconds += order.packingSeconds;
          byUser[order.packedBy].ordersWithTiming++;
        }
        
        // Aggregate station timing stats
        if (order.stationId) {
          if (!byStation[order.stationId]) {
            byStation[order.stationId] = { count: 0, totalSeconds: 0, ordersWithTiming: 0 };
          }
          byStation[order.stationId].count++;
          if (order.packingSeconds !== null) {
            byStation[order.stationId].totalSeconds += order.packingSeconds;
            byStation[order.stationId].ordersWithTiming++;
          }
        }
        
        // Aggregate session timing stats
        if (order.sessionId) {
          if (!bySession[order.sessionId]) {
            bySession[order.sessionId] = { count: 0, totalSeconds: 0, ordersWithTiming: 0 };
          }
          bySession[order.sessionId].count++;
          if (order.packingSeconds !== null) {
            bySession[order.sessionId].totalSeconds += order.packingSeconds;
            bySession[order.sessionId].ordersWithTiming++;
          }
        }
        
        // Aggregate station-session timing (for avg session time per station)
        if (order.stationId && order.sessionId && order.packingSeconds !== null) {
          const stationSessionKey = `${order.stationId}:${order.sessionId}`;
          if (!byStationSession[stationSessionKey]) {
            byStationSession[stationSessionKey] = { 
              stationId: order.stationId, 
              sessionId: order.sessionId, 
              totalSeconds: 0, 
              orderCount: 0 
            };
          }
          byStationSession[stationSessionKey].totalSeconds += order.packingSeconds;
          byStationSession[stationSessionKey].orderCount++;
        }
      }
      
      // Convert to array sorted by date descending
      const dailySummary = Object.entries(byDate)
        .map(([date, orders]) => {
          // Count unique orders by user for this day
          const userBreakdown: Record<string, number> = {};
          for (const order of orders) {
            userBreakdown[order.packedBy] = (userBreakdown[order.packedBy] || 0) + 1;
          }
          
          // Calculate average packing time for this day
          const dayOrdersWithTiming = orders.filter(o => o.packingSeconds !== null);
          const dayTotalSeconds = dayOrdersWithTiming.reduce((sum, o) => sum + (o.packingSeconds || 0), 0);
          const avgPackingSeconds = dayOrdersWithTiming.length > 0 
            ? dayTotalSeconds / dayOrdersWithTiming.length 
            : null;
          
          return {
            date,
            count: orders.length,
            avgPackingSeconds,
            ordersWithTiming: dayOrdersWithTiming.length,
            userBreakdown,
            orders: orders
              .sort((a, b) => b.packedAt.getTime() - a.packedAt.getTime())
              .map(o => ({
                orderNumber: o.orderNumber,
                packedAt: o.packedAt,
                packedBy: o.packedBy,
                packingSeconds: o.packingSeconds,
                sessionId: o.sessionId,
                stationId: o.stationId,
                stationType: o.stationType,
              })),
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
      
      // Fetch user data (including avatars) for all users in the summary
      const userEmails = Object.keys(byUser);
      const userDataMap = new Map<string, { avatarUrl: string | null }>();
      
      // Fetch user avatars in parallel
      await Promise.all(
        userEmails.map(async (email) => {
          const user = await storage.getUserByEmail(email);
          userDataMap.set(email, { avatarUrl: user?.avatarUrl || null });
        })
      );
      
      res.json({
        startDate,
        endDate,
        totalPacked: uniqueOrders.length,
        // Overall timing metrics
        overallAvgPackingSeconds,
        ordersWithTiming: ordersWithTiming.length,
        // Per-user summary with timing and avatar
        userSummary: Object.entries(byUser)
          .map(([username, stats]) => ({ 
            username, 
            avatarUrl: userDataMap.get(username)?.avatarUrl || null,
            count: stats.count,
            avgPackingSeconds: stats.ordersWithTiming > 0 
              ? stats.totalSeconds / stats.ordersWithTiming 
              : null,
            ordersWithTiming: stats.ordersWithTiming,
          }))
          .sort((a, b) => b.count - a.count),
        // Per-station summary with timing
        stationSummary: Object.entries(byStation)
          .map(([stationId, stats]) => ({ 
            stationId, 
            count: stats.count,
            avgPackingSeconds: stats.ordersWithTiming > 0 
              ? stats.totalSeconds / stats.ordersWithTiming 
              : null,
            ordersWithTiming: stats.ordersWithTiming,
          }))
          .sort((a, b) => b.count - a.count),
        // Per-session summary with timing
        sessionSummary: Object.entries(bySession)
          .map(([sessionId, stats]) => ({ 
            sessionId, 
            count: stats.count,
            avgPackingSeconds: stats.ordersWithTiming > 0 
              ? stats.totalSeconds / stats.ordersWithTiming 
              : null,
            ordersWithTiming: stats.ordersWithTiming,
          }))
          .sort((a, b) => b.count - a.count),
        // Per-station session summary (avg session duration per station)
        stationSessionSummary: (() => {
          // Group station-sessions by stationId
          const stationSessionTotals: Record<string, { sessionCount: number; totalSessionSeconds: number }> = {};
          for (const ss of Object.values(byStationSession)) {
            if (!stationSessionTotals[ss.stationId]) {
              stationSessionTotals[ss.stationId] = { sessionCount: 0, totalSessionSeconds: 0 };
            }
            stationSessionTotals[ss.stationId].sessionCount++;
            stationSessionTotals[ss.stationId].totalSessionSeconds += ss.totalSeconds;
          }
          return Object.entries(stationSessionTotals)
            .map(([stationId, stats]) => ({
              stationId,
              sessionCount: stats.sessionCount,
              avgSessionSeconds: stats.sessionCount > 0 
                ? stats.totalSessionSeconds / stats.sessionCount 
                : null,
            }))
            .sort((a, b) => b.sessionCount - a.sessionCount);
        })(),
        dailySummary,
      });
    } catch (error) {
      console.error("Error fetching packed shipments:", error);
      res.status(500).json({ error: "Failed to fetch packed shipments" });
    }
  });

  // Get shipments with items by order number (for packing logs report dropdown)
  app.get("/api/reports/shipments-by-order", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.query;
      
      if (!orderNumber || typeof orderNumber !== 'string') {
        return res.status(400).json({ error: "orderNumber query parameter is required" });
      }

      const normalizedOrderNumber = orderNumber.trim();
      const shipmentsWithItems = await storage.getShipmentsWithItemsByOrderNumber(normalizedOrderNumber);
      
      res.json({
        orderNumber: normalizedOrderNumber,
        shipments: shipmentsWithItems.map(({ shipment, items }) => ({
          id: shipment.id,
          shipmentId: shipment.shipmentId, // ShipStation ID (se-XXX)
          trackingNumber: shipment.trackingNumber,
          carrier: shipment.carrierCode,
          serviceCode: shipment.serviceCode,
          status: shipment.status,
          createdAt: shipment.createdAt,
          items: items.map(item => ({
            id: item.id,
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
            imageUrl: item.imageUrl,
          })),
        })),
      });
    } catch (error) {
      console.error("Error fetching shipments by order:", error);
      res.status(500).json({ error: "Failed to fetch shipments" });
    }
  });

  // Packing logs report - search and view packing logs by order number
  app.get("/api/reports/packing-logs", requireAuth, async (req, res) => {
    try {
      const { orderNumber, shipmentId } = req.query;
      
      if (!orderNumber || typeof orderNumber !== 'string') {
        return res.status(400).json({ error: "orderNumber query parameter is required" });
      }

      // Normalize order number (strip JK prefix if present for consistency)
      const normalizedOrderNumber = orderNumber.trim();
      
      // Get packing logs with username joined, optionally filtered by shipmentId (our internal UUID)
      const logs = await storage.getPackingLogsByOrderNumber(
        normalizedOrderNumber,
        typeof shipmentId === 'string' ? shipmentId : undefined
      );
      
      res.json({
        orderNumber: normalizedOrderNumber,
        shipmentId: typeof shipmentId === 'string' ? shipmentId : null,
        totalLogs: logs.length,
        logs: logs.map(log => ({
          id: log.id,
          createdAt: log.createdAt,
          username: log.username,
          action: log.action,
          productSku: log.productSku,
          scannedCode: log.scannedCode,
          skuVaultProductId: log.skuVaultProductId,
          success: log.success,
          errorMessage: log.errorMessage,
          skuVaultRawResponse: log.skuVaultRawResponse, // Include full JSON for formatted display
        })),
      });
    } catch (error) {
      console.error("Error fetching packing logs:", error);
      res.status(500).json({ error: "Failed to fetch packing logs" });
    }
  });

  // Shipment events report - browsable view of all shipment events with filtering
  app.get("/api/reports/shipment-events", requireAuth, async (req, res) => {
    try {
      const { 
        startDate, 
        endDate, 
        username, 
        station, 
        eventName, 
        orderNumber,
        sortBy = 'occurredAt',
        sortOrder = 'desc',
        page = '1',
        limit = '50'
      } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      // Parse YYYY-MM-DD strings as Central Time
      const start = fromZonedTime(`${startDate} 00:00:00`, CST_TIMEZONE);
      const end = fromZonedTime(`${endDate} 23:59:59.999`, CST_TIMEZONE);
      
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: "Invalid date format" });
      }

      const pageNum = parseInt(page as string) || 1;
      const limitNum = Math.min(parseInt(limit as string) || 50, 500); // Cap at 500
      const offset = (pageNum - 1) * limitNum;

      // Build dynamic query conditions
      const conditions = [
        gte(shipmentEvents.occurredAt, start),
        lte(shipmentEvents.occurredAt, end)
      ];

      if (username && typeof username === 'string' && username.trim()) {
        conditions.push(ilike(shipmentEvents.username, `%${username.trim()}%`));
      }
      if (station && typeof station === 'string' && station.trim()) {
        conditions.push(ilike(shipmentEvents.station, `%${station.trim()}%`));
      }
      if (eventName && typeof eventName === 'string' && eventName.trim()) {
        conditions.push(ilike(shipmentEvents.eventName, `%${eventName.trim()}%`));
      }
      if (orderNumber && typeof orderNumber === 'string' && orderNumber.trim()) {
        conditions.push(ilike(shipmentEvents.orderNumber, `%${orderNumber.trim()}%`));
      }

      // Determine sort column
      const sortColumn = (() => {
        switch (sortBy) {
          case 'username': return shipmentEvents.username;
          case 'station': return shipmentEvents.station;
          case 'eventName': return shipmentEvents.eventName;
          case 'orderNumber': return shipmentEvents.orderNumber;
          default: return shipmentEvents.occurredAt;
        }
      })();

      const orderDirection = sortOrder === 'asc' ? asc : desc;

      // Count total matching records
      const [countResult] = await db
        .select({ count: count() })
        .from(shipmentEvents)
        .where(and(...conditions));

      const totalCount = countResult?.count || 0;

      // Fetch paginated results - select only needed columns
      const events = await db
        .select({
          id: shipmentEvents.id,
          orderNumber: shipmentEvents.orderNumber,
          eventName: shipmentEvents.eventName,
          username: shipmentEvents.username,
          station: shipmentEvents.station,
          occurredAt: shipmentEvents.occurredAt,
        })
        .from(shipmentEvents)
        .where(and(...conditions))
        .orderBy(orderDirection(sortColumn))
        .limit(limitNum)
        .offset(offset);

      // Base date range conditions for filter dropdowns
      const dateRangeConditions = [
        gte(shipmentEvents.occurredAt, start),
        lte(shipmentEvents.occurredAt, end)
      ];

      // Get distinct values for filter dropdowns (scoped to date range + active filters)
      // Event names - scoped by username, station, and orderNumber filters
      const eventNameConditions = [...dateRangeConditions];
      if (username && typeof username === 'string' && username.trim()) {
        eventNameConditions.push(ilike(shipmentEvents.username, `%${username.trim()}%`));
      }
      if (station && typeof station === 'string' && station.trim()) {
        eventNameConditions.push(ilike(shipmentEvents.station, `%${station.trim()}%`));
      }
      if (orderNumber && typeof orderNumber === 'string' && orderNumber.trim()) {
        eventNameConditions.push(ilike(shipmentEvents.orderNumber, `%${orderNumber.trim()}%`));
      }
      const distinctEventNames = await db
        .selectDistinct({ eventName: shipmentEvents.eventName })
        .from(shipmentEvents)
        .where(and(...eventNameConditions));

      // Stations - scoped by username, eventName, and orderNumber filters
      const stationConditions = [...dateRangeConditions];
      if (username && typeof username === 'string' && username.trim()) {
        stationConditions.push(ilike(shipmentEvents.username, `%${username.trim()}%`));
      }
      if (eventName && typeof eventName === 'string' && eventName.trim()) {
        stationConditions.push(ilike(shipmentEvents.eventName, `%${eventName.trim()}%`));
      }
      if (orderNumber && typeof orderNumber === 'string' && orderNumber.trim()) {
        stationConditions.push(ilike(shipmentEvents.orderNumber, `%${orderNumber.trim()}%`));
      }
      const distinctStations = await db
        .selectDistinct({ station: shipmentEvents.station })
        .from(shipmentEvents)
        .where(and(...stationConditions));

      // Usernames - scoped by station, eventName, and orderNumber filters
      const usernameConditions = [...dateRangeConditions];
      if (station && typeof station === 'string' && station.trim()) {
        usernameConditions.push(ilike(shipmentEvents.station, `%${station.trim()}%`));
      }
      if (eventName && typeof eventName === 'string' && eventName.trim()) {
        usernameConditions.push(ilike(shipmentEvents.eventName, `%${eventName.trim()}%`));
      }
      if (orderNumber && typeof orderNumber === 'string' && orderNumber.trim()) {
        usernameConditions.push(ilike(shipmentEvents.orderNumber, `%${orderNumber.trim()}%`));
      }
      const distinctUsernames = await db
        .selectDistinct({ username: shipmentEvents.username })
        .from(shipmentEvents)
        .where(and(...usernameConditions));

      res.json({
        events: events.map(e => ({
          id: e.id,
          orderNumber: e.orderNumber,
          eventName: e.eventName,
          username: e.username,
          station: e.station,
          occurredAt: e.occurredAt.toISOString(),
        })),
        pagination: {
          page: pageNum,
          limit: limitNum,
          totalCount,
          totalPages: Math.ceil(totalCount / limitNum),
        },
        filters: {
          eventNames: distinctEventNames.map(e => e.eventName).filter(Boolean).sort(),
          stations: distinctStations.map(s => s.station).filter(Boolean).sort(),
          usernames: distinctUsernames.map(u => u.username).filter(Boolean).sort(),
        },
      });
    } catch (error) {
      console.error("Error fetching shipment events:", error);
      res.status(500).json({ error: "Failed to fetch shipment events" });
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

  app.get("/api/lifecycle-worker-status", requireAuth, async (req, res) => {
    try {
      const { getLifecycleWorkerStatus } = await import("./lifecycle-event-worker");
      const status = await getLifecycleWorkerStatus();
      res.json(status);
    } catch (error: any) {
      console.error("Error getting lifecycle worker status:", error.message);
      res.status(500).json({ error: "Failed to get lifecycle worker status" });
    }
  });

  app.post("/api/operations/restart-lifecycle-worker", requireAuth, async (req, res) => {
    try {
      const { stopLifecycleWorker, startLifecycleWorker } = await import("./lifecycle-event-worker");
      stopLifecycleWorker();
      await new Promise(resolve => setTimeout(resolve, 500));
      startLifecycleWorker();
      res.json({ success: true, message: "Lifecycle worker restarted" });
    } catch (error: any) {
      console.error("Error restarting lifecycle worker:", error.message);
      res.status(500).json({ error: "Failed to restart lifecycle worker" });
    }
  });

  app.post("/api/operations/stop-lifecycle-worker", requireAuth, async (req, res) => {
    try {
      const { stopLifecycleWorker } = await import("./lifecycle-event-worker");
      const { clearLifecycleQueue } = await import("./utils/queue");
      stopLifecycleWorker();
      const cleared = await clearLifecycleQueue();
      res.json({ success: true, message: `Lifecycle worker stopped and ${cleared} queue items cleared` });
    } catch (error: any) {
      console.error("Error stopping lifecycle worker:", error.message);
      res.status(500).json({ error: "Failed to stop lifecycle worker" });
    }
  });

  app.get("/api/lifecycle-phase-counts", requireAuth, async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT 
          lifecycle_phase,
          decision_subphase,
          COUNT(*)::int as count
        FROM shipments
        WHERE lifecycle_phase IS NOT NULL
        GROUP BY lifecycle_phase, decision_subphase
        ORDER BY lifecycle_phase, decision_subphase
      `);
      res.json({ counts: result.rows });
    } catch (error: any) {
      console.error("Error getting lifecycle phase counts:", error.message);
      res.status(500).json({ error: "Failed to get lifecycle phase counts" });
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

      // Get print queue worker status, stats, and stale jobs metrics
      let printQueueWorkerStatus: 'sleeping' | 'running' = 'sleeping';
      let printQueueWorkerStats = undefined;
      let stalePrintJobs = undefined;
      try {
        const { getPrintQueueWorkerStatus, getPrintQueueWorkerStats, getStaleJobsMetrics } = await import("./print-queue-worker");
        printQueueWorkerStatus = getPrintQueueWorkerStatus();
        printQueueWorkerStats = getPrintQueueWorkerStats();
        const staleMetrics = getStaleJobsMetrics();
        stalePrintJobs = {
          totalStale: staleMetrics.totalStale,
          warningCount: staleMetrics.warningCount,
          criticalCount: staleMetrics.criticalCount,
          healthStatus: staleMetrics.healthStatus,
          lastCheckedAt: staleMetrics.lastCheckedAt.toISOString(),
        };
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

      // Get unified shipment sync worker status and stats
      let unifiedSyncWorker = undefined;
      try {
        const { getWorkerStatus, getSyncStats } = await import("./unified-shipment-sync-worker");
        const status = await getWorkerStatus();
        const stats = await getSyncStats();
        unifiedSyncWorker = {
          isRunning: status.isRunning,
          isPolling: status.isPolling,
          lastPollTime: status.lastPollTime?.toISOString() || null,
          pollCount: status.pollCount,
          errorCount: status.errorCount,
          lastError: status.lastError,
          cursorPosition: status.cursorPosition,
          lastCursorUpdate: status.lastCursorUpdate?.toISOString() || null,
          credentialsConfigured: status.credentialsConfigured,
          syncStats: stats,
        };
      } catch (error: any) {
        console.error('[queue-stats] Error getting unified sync worker status:', error.message);
      }

      // Get lifecycle event worker status
      let lifecycleEventWorkerStatus = undefined;
      try {
        const { getLifecycleWorkerStatus } = await import("./lifecycle-event-worker");
        lifecycleEventWorkerStatus = await getLifecycleWorkerStatus();
      } catch (error: any) {
        console.error('[queue-stats] Error getting lifecycle event worker status:', error.message);
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
        printQueueWorkerStatus,
        printQueueWorkerStats,
        stalePrintJobs,
        firestoreSessionSyncWorkerStatus,
        firestoreSessionSyncWorkerStats,
        unifiedSyncWorker,
        lifecycleEventWorkerStatus,
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

  // Feature Flags API - Get all feature flags
  app.get("/api/operations/feature-flags", requireAuth, async (req, res) => {
    try {
      const flags = await db.select().from(featureFlags).orderBy(featureFlags.key);
      res.json(flags);
    } catch (error) {
      console.error("Error fetching feature flags:", error);
      res.status(500).json({ error: "Failed to fetch feature flags" });
    }
  });

  // Feature Flags API - Update a feature flag
  app.put("/api/operations/feature-flags/:key", requireAuth, async (req, res) => {
    try {
      const { key } = req.params;
      const { enabled } = req.body;
      const user = req.user as { email: string } | undefined;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }

      // Upsert the feature flag
      const result = await db
        .insert(featureFlags)
        .values({
          key,
          enabled,
          description: getFeatureFlagDescription(key),
          updatedBy: user?.email || 'unknown',
        })
        .onConflictDoUpdate({
          target: featureFlags.key,
          set: {
            enabled,
            updatedAt: new Date(),
            updatedBy: user?.email || 'unknown',
          },
        })
        .returning();

      res.json(result[0]);
    } catch (error) {
      console.error("Error updating feature flag:", error);
      res.status(500).json({ error: "Failed to update feature flag" });
    }
  });

  // Helper function to get descriptions for known feature flags
  function getFeatureFlagDescription(key: string): string {
    const descriptions: Record<string, string> = {
      'auto_package_sync': 'Automatically sync package dimensions to ShipStation when fingerprints with packaging types are assigned',
    };
    return descriptions[key] || '';
  }

  // Shipping Methods API - List all shipping methods
  app.get("/api/settings/shipping-methods", requireAuth, async (req, res) => {
    try {
      const { shippingMethods } = await import("@shared/schema");
      const methods = await db.select().from(shippingMethods).orderBy(shippingMethods.name);
      res.json(methods);
    } catch (error) {
      console.error("Error fetching shipping methods:", error);
      res.status(500).json({ error: "Failed to fetch shipping methods" });
    }
  });

  // Shipping Methods API - Update a shipping method
  app.put("/api/settings/shipping-methods/:id", requireAuth, async (req, res) => {
    try {
      const { shippingMethods } = await import("@shared/schema");
      const { id } = req.params;
      const { allowRateCheck, allowAssignment, allowChange, minAllowedWeight, maxAllowedWeight } = req.body;
      const user = req.user as { email: string } | undefined;
      
      const result = await db
        .update(shippingMethods)
        .set({
          allowRateCheck: allowRateCheck ?? undefined,
          allowAssignment: allowAssignment ?? undefined,
          allowChange: allowChange ?? undefined,
          minAllowedWeight: minAllowedWeight !== undefined ? (minAllowedWeight === null ? null : String(minAllowedWeight)) : undefined,
          maxAllowedWeight: maxAllowedWeight !== undefined ? (maxAllowedWeight === null ? null : String(maxAllowedWeight)) : undefined,
          updatedAt: new Date(),
          updatedBy: user?.email || 'unknown',
        })
        .where(eq(shippingMethods.id, parseInt(id)))
        .returning();
      
      if (result.length === 0) {
        return res.status(404).json({ error: "Shipping method not found" });
      }
      
      res.json(result[0]);
    } catch (error) {
      console.error("Error updating shipping method:", error);
      res.status(500).json({ error: "Failed to update shipping method" });
    }
  });

  // Shipping Methods API - Sync new methods from shipments
  app.post("/api/settings/shipping-methods/sync", requireAuth, async (req, res) => {
    try {
      const { shippingMethods, shipments: shipmentsTable } = await import("@shared/schema");
      
      // Get all unique service codes from shipments that aren't already in shipping_methods
      const result = await db.execute(sql`
        INSERT INTO shipping_methods (name)
        SELECT DISTINCT service_code 
        FROM shipments 
        WHERE service_code IS NOT NULL
        ON CONFLICT (name) DO NOTHING
        RETURNING name
      `);
      
      const newMethods = result.rows?.length || 0;
      res.json({ success: true, newMethods });
    } catch (error) {
      console.error("Error syncing shipping methods:", error);
      res.status(500).json({ error: "Failed to sync shipping methods" });
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

  // Trigger immediate unified sync poll
  app.post("/api/operations/trigger-unified-sync", requireAuth, async (req, res) => {
    try {
      const { triggerImmediatePoll } = await import("./unified-shipment-sync-worker");
      triggerImmediatePoll();
      res.json({ success: true, message: "Immediate poll triggered" });
    } catch (error) {
      console.error("Error triggering unified sync:", error);
      res.status(500).json({ error: "Failed to trigger unified sync" });
    }
  });

  // Force full resync (reset cursor to lookback period)
  app.post("/api/operations/force-unified-resync", requireAuth, async (req, res) => {
    try {
      const { forceFullResync } = await import("./unified-shipment-sync-worker");
      await forceFullResync();
      res.json({ success: true, message: "Full resync initiated - cursor reset to 7-day lookback" });
    } catch (error) {
      console.error("Error forcing unified resync:", error);
      res.status(500).json({ error: "Failed to force unified resync" });
    }
  });

  // Force 1-day resync (reset cursor to 1 day ago)
  app.post("/api/operations/force-unified-resync-1", requireAuth, async (req, res) => {
    try {
      const { forceResyncWithDays } = await import("./unified-shipment-sync-worker");
      await forceResyncWithDays(1);
      res.json({ success: true, message: "Full resync initiated - cursor reset to 1-day lookback" });
    } catch (error) {
      console.error("Error forcing 1-day unified resync:", error);
      res.status(500).json({ error: "Failed to force 1-day unified resync" });
    }
  });

  // Force 30-day resync (reset cursor to 30 days ago)
  app.post("/api/operations/force-unified-resync-30", requireAuth, async (req, res) => {
    try {
      const { forceResyncWithDays } = await import("./unified-shipment-sync-worker");
      await forceResyncWithDays(30);
      res.json({ success: true, message: "Full resync initiated - cursor reset to 30-day lookback" });
    } catch (error) {
      console.error("Error forcing 30-day unified resync:", error);
      res.status(500).json({ error: "Failed to force 30-day unified resync" });
    }
  });

  // Force 90-day resync (reset cursor to 90 days ago)
  app.post("/api/operations/force-unified-resync-90", requireAuth, async (req, res) => {
    try {
      const { forceResyncWithDays } = await import("./unified-shipment-sync-worker");
      await forceResyncWithDays(90);
      res.json({ success: true, message: "Full resync initiated - cursor reset to 90-day lookback" });
    } catch (error) {
      console.error("Error forcing 90-day unified resync:", error);
      res.status(500).json({ error: "Failed to force 90-day unified resync" });
    }
  });

  app.post("/api/operations/force-unified-resync-1year", requireAuth, async (req, res) => {
    try {
      const { forceResyncToDate } = await import("./unified-shipment-sync-worker");
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      oneYearAgo.setUTCHours(0, 0, 0, 0);

      await forceResyncToDate(oneYearAgo);
      res.json({ success: true, message: `Cursor reset to ${oneYearAgo.toISOString().split('T')[0]}` });
    } catch (error) {
      console.error("Error forcing 1-year unified resync:", error);
      res.status(500).json({ error: "Failed to force 1-year unified resync" });
    }
  });

  // Trigger lifecycle event for a specific shipment by order number (for manual package sync)
  app.post("/api/shipments/:orderNumber/trigger-lifecycle", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      
      // Find shipments by order number
      const shipmentList = await storage.getShipmentsByOrderNumber(orderNumber);
      
      if (shipmentList.length === 0) {
        return res.status(404).json({ error: `No shipments found for order ${orderNumber}` });
      }
      
      // Queue lifecycle events for all matching shipments
      const results = await Promise.all(shipmentList.map(async (shipment) => {
        const enqueued = await enqueueLifecycleEvent({
          shipmentId: shipment.id,
          orderNumber: shipment.orderNumber || undefined,
          reason: 'manual',
          enqueuedAt: Date.now(),
          retryCount: 0,
        });
        return { shipmentId: shipment.id, enqueued };
      }));
      
      const queuedCount = results.filter(r => r.enqueued).length;
      const skippedCount = results.filter(r => !r.enqueued).length;
      
      console.log(`[Lifecycle] Manual trigger for ${orderNumber}: ${queuedCount} queued, ${skippedCount} already in queue`);
      
      res.json({ 
        success: true, 
        message: `Lifecycle event queued for ${queuedCount} shipment(s)`,
        queued: queuedCount,
        skipped: skippedCount,
        shipments: results
      });
    } catch (error) {
      console.error("Error triggering lifecycle event:", error);
      res.status(500).json({ error: "Failed to trigger lifecycle event" });
    }
  });

  // Force full Firestore session resync (reset cursor and re-fetch all sessions)
  app.post("/api/operations/force-firestore-resync", requireAuth, async (req, res) => {
    try {
      const { forceFullResync } = await import("./firestore-session-sync-worker");
      const result = await forceFullResync();
      res.json(result);
    } catch (error: any) {
      console.error("Error forcing Firestore resync:", error);
      res.status(500).json({ success: false, message: `Failed to force Firestore resync: ${error.message}` });
    }
  });

  // Re-import ALL sessions (including closed) from oldest shipment date
  // This backfills sessions that were missed because shipments didn't exist when sessions closed
  app.post("/api/operations/firestore-sessions/reimport", requireAuth, async (req, res) => {
    try {
      // Find the oldest shipment by order_date (the actual order date, not DB insert time)
      // Filter out null orderDate values to avoid NULLs sorting first in ascending order
      const oldestShipmentResult = await db
        .select({ orderDate: shipments.orderDate })
        .from(shipments)
        .where(isNotNull(shipments.orderDate))
        .orderBy(asc(shipments.orderDate))
        .limit(1);

      if (oldestShipmentResult.length === 0) {
        return res.json({ 
          success: false, 
          message: "No shipments found in database" 
        });
      }

      const oldestDate = oldestShipmentResult[0].orderDate;
      console.log(`[operations] Starting Firestore session reimport from ${oldestDate?.toISOString()}`);

      const { reimportAllSessions } = await import("./firestore-session-sync-worker");
      const result = await reimportAllSessions(oldestDate!);
      
      res.json({
        ...result,
        startDate: oldestDate?.toISOString(),
      });
    } catch (error: any) {
      console.error("Error reimporting Firestore sessions:", error);
      res.status(500).json({ 
        success: false, 
        message: `Failed to reimport Firestore sessions: ${error.message}` 
      });
    }
  });

  // Get reimport status (to check if one is already running)
  app.get("/api/operations/firestore-sessions/reimport-status", requireAuth, async (req, res) => {
    try {
      const { getReimportStatus } = await import("./firestore-session-sync-worker");
      const status = await getReimportStatus();
      res.json(status);
    } catch (error: any) {
      console.error("Error getting reimport status:", error);
      res.status(500).json({ 
        running: false,
        error: error.message 
      });
    }
  });

  // Cancel an in-progress reimport
  app.post("/api/operations/firestore-sessions/cancel-reimport", requireAuth, async (req, res) => {
    try {
      const { cancelReimport } = await import("./firestore-session-sync-worker");
      await cancelReimport();
      res.json({ success: true, message: "Reimport cancelled" });
    } catch (error: any) {
      console.error("Error cancelling reimport:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
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

  // Re-register all ShipStation webhooks
  app.post("/api/operations/reregister-shipstation-webhooks", requireAuth, async (req, res) => {
    try {
      const apiKey = process.env.SHIPSTATION_API_KEY;

      if (!apiKey) {
        return res.status(400).json({ 
          error: "Missing ShipStation API key. Ensure SHIPSTATION_API_KEY is set." 
        });
      }

      // Use shared webhook URL detection logic
      const { getWebhookBaseUrl } = await import("./utils/webhook-url.js");
      const webhookBaseUrl = getWebhookBaseUrl();

      if (!webhookBaseUrl) {
        return res.status(400).json({ 
          error: "Cannot determine webhook base URL. Check environment configuration (WEBHOOK_BASE_URL or REPLIT_DOMAINS)." 
        });
      }

      // Audit log
      const user = req.user as any;
      const timestamp = new Date().toISOString();
      console.log(`[AUDIT] ShipStation webhook re-registration initiated by user ${user?.email || 'unknown'} at ${timestamp}`);
      console.log(`[AUDIT] Using webhook base URL: ${webhookBaseUrl}`);

      const { ensureShipStationWebhooksRegistered, listShipStationWebhooks } = await import("./utils/shipstation-webhook");
      
      // Get count before
      const webhooksBefore = await listShipStationWebhooks(apiKey);
      const countBefore = webhooksBefore.length;
      
      // Re-register webhooks and get detailed result
      const registrationResult = await ensureShipStationWebhooksRegistered(webhookBaseUrl);
      
      // Get count after
      const webhooksAfter = await listShipStationWebhooks(apiKey);
      const countAfter = webhooksAfter.length;
      
      console.log(`[AUDIT] ShipStation webhooks re-registered. Before: ${countBefore}, After: ${countAfter}`);
      console.log(`[AUDIT] Registration result: registered=${registrationResult.registeredEvents.length}, existing=${registrationResult.existingEvents.length}, failed=${registrationResult.failedEvents.length}`);
      
      // If some events failed to register, return partial success with 207 status
      if (!registrationResult.success) {
        const failedEventsList = registrationResult.failedEvents.map(f => f.event).join(', ');
        const failedDetails = registrationResult.failedEvents.map(f => `${f.event}: ${f.error}`).join('; ');
        console.error(`[AUDIT] Failed to register some webhooks: ${failedDetails}`);
        
        return res.status(207).json({
          success: false,
          before: countBefore,
          after: countAfter,
          webhooks: webhooksAfter,
          registeredEvents: registrationResult.registeredEvents,
          existingEvents: registrationResult.existingEvents,
          failedEvents: registrationResult.failedEvents,
          message: `Partially registered webhooks. Failed events: ${failedEventsList}`,
          error: `Some webhook events failed to register: ${failedEventsList}. This may indicate missing permissions or plan limitations.`
        });
      }
      
      res.json({ 
        success: true, 
        before: countBefore,
        after: countAfter,
        webhooks: webhooksAfter,
        registeredEvents: registrationResult.registeredEvents,
        existingEvents: registrationResult.existingEvents,
        cleanedUpCount: registrationResult.cleanedUpCount,
        message: `Successfully re-registered ShipStation webhooks (${countAfter} total)`
      });
    } catch (error: any) {
      console.error("Error re-registering ShipStation webhooks:", error);
      res.status(500).json({ 
        error: "Failed to re-register ShipStation webhooks",
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
      const {
        myJobs,
        status,
        search,
        sortBy,
        sortOrder,
        page,
        limit,
      } = req.query;

      const options = {
        userId: myJobs === 'true' ? req.user!.id : undefined,
        status: status as string | undefined,
        search: search as string | undefined,
        sortBy: sortBy as string | undefined,
        sortOrder: (sortOrder as 'asc' | 'desc') || 'desc',
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 10,
      };

      const result = await storage.queryPrintJobs(options);
      
      // Get stations for display names
      const stations = await storage.getAllStations();
      const stationMap = new Map(stations.map(s => [s.id, s.name]));

      // Get users for requestedBy display names
      const userIds = [...new Set(result.jobs.map(j => j.requestedBy).filter(Boolean))];
      const usersData: Map<string, { name: string; email: string }> = new Map();
      for (const userId of userIds) {
        const user = await storage.getUser(userId as string);
        if (user) {
          usersData.set(userId as string, { 
            name: user.name || user.email.split('@')[0], 
            email: user.email 
          });
        }
      }
      
      // Transform jobs to include station name and order number from payload
      const jobs = result.jobs.map(job => ({
        id: job.id,
        orderId: job.orderId,
        orderNumber: (job.payload as any)?.orderNumber || job.orderId,
        stationId: job.stationId,
        stationName: stationMap.get(job.stationId) || 'Unknown Station',
        shipmentId: job.shipmentId,
        jobType: job.jobType,
        status: job.status,
        labelUrl: (job.payload as any)?.labelUrl,
        trackingNumber: (job.payload as any)?.trackingNumber,
        errorMessage: job.errorMessage,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        queuedAt: job.createdAt,
        sentAt: job.sentAt,
        printedAt: job.completedAt,
        createdAt: job.createdAt,
        requestedBy: job.requestedBy,
        requestedByName: job.requestedBy ? usersData.get(job.requestedBy)?.name || 'Unknown' : null,
        requestedByEmail: job.requestedBy ? usersData.get(job.requestedBy)?.email || null : null,
      }));
      
      res.json({ 
        jobs,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      });
    } catch (error) {
      console.error("Error fetching print queue:", error);
      res.status(500).json({ error: "Failed to fetch print queue" });
    }
  });

  // Get stale job metrics (used by packing page to block on critical jobs)
  app.get("/api/print-queue/stale-metrics", requireAuth, async (req, res) => {
    try {
      const { getStaleJobsMetrics } = await import("./print-queue-worker");
      const metrics = getStaleJobsMetrics();
      
      res.json({
        totalStale: metrics.totalStale,
        warningCount: metrics.warningCount,
        criticalCount: metrics.criticalCount,
        healthStatus: metrics.healthStatus,
        lastCheckedAt: metrics.lastCheckedAt.toISOString(),
      });
    } catch (error) {
      console.error("Error fetching stale job metrics:", error);
      // Return healthy status if worker not initialized
      res.json({
        totalStale: 0,
        warningCount: 0,
        criticalCount: 0,
        healthStatus: 'healthy',
        lastCheckedAt: new Date().toISOString(),
      });
    }
  });

  // Get pending print jobs for a specific shipment (used by packing page)
  app.get("/api/print-jobs/shipment/:shipmentId", requireAuth, async (req, res) => {
    try {
      const jobs = await storage.getJobsByShipment(req.params.shipmentId);
      
      // Filter to only non-terminal statuses (pending, sent, printing)
      const pendingJobs = jobs.filter(job => 
        ['pending', 'sent', 'printing'].includes(job.status)
      );
      
      // Get station info for display
      const stations = await storage.getAllStations();
      const stationMap = new Map(stations.map(s => [s.id, s.name]));
      
      const formattedJobs = pendingJobs.map(job => ({
        id: job.id,
        stationId: job.stationId,
        stationName: stationMap.get(job.stationId) || 'Unknown Station',
        status: job.status,
        errorMessage: job.errorMessage,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        createdAt: job.createdAt,
      }));
      
      res.json({ pendingJobs: formattedJobs });
    } catch (error) {
      console.error("Error fetching print jobs for shipment:", error);
      res.status(500).json({ error: "Failed to fetch print jobs" });
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
      // Try desktop print jobs table first, then fall back to old print queue table
      let job = await storage.getDesktopPrintJob(req.params.id);
      let isDesktopJob = !!job;
      
      if (!job) {
        // Fall back to old print queue table
        job = await storage.getPrintJob(req.params.id) as any;
      }
      
      if (!job) {
        return res.status(404).json({ error: "Print job not found" });
      }

      if (job.status === "completed" || job.status === "printed") {
        return res.json({ success: true, job });
      }

      let updatedJob;
      if (isDesktopJob) {
        // Use desktop print jobs method
        updatedJob = await storage.markJobCompleted(req.params.id);
        
        // Broadcast status update to desktop station so it reflects there too
        if (updatedJob.stationId) {
          broadcastDesktopJobUpdate(updatedJob.stationId, updatedJob.id, 'completed');
        }
      } else {
        // Use old print queue method
        updatedJob = await storage.updatePrintJobStatus(req.params.id, "printed", new Date());
      }
      
      broadcastPrintQueueUpdate({ type: "job_completed", job: updatedJob });
      
      // Immediately recalculate and broadcast stale job metrics (instant UI update)
      refreshStaleJobsMetrics().catch(err => console.error("[Print Queue] Error refreshing stale metrics:", err));

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

  // ============================================================================
  // PACKING STATION SESSIONS (web users selecting their station)
  // ============================================================================
  
  // Get current user's active packing station session
  app.get("/api/packing/station-session", requireAuth, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const session = await storage.getActiveWebPackingSession(user.id);
      
      if (!session) {
        return res.json({ session: null });
      }
      
      // Get station details
      const station = await storage.getStation(session.stationId);
      
      return res.json({
        session: {
          id: session.id,
          stationId: session.stationId,
          stationName: station?.name || 'Unknown Station',
          stationLocationHint: station?.locationHint || null,
          selectedAt: session.selectedAt,
          expiresAt: session.expiresAt,
        }
      });
    } catch (error: any) {
      console.error("[Packing] Error fetching station session:", error);
      res.status(500).json({ error: "Failed to fetch station session" });
    }
  });
  
  // Set user's packing station for the day (expires at midnight)
  app.post("/api/packing/station-session", requireAuth, async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      const { stationId } = req.body;
      
      if (!stationId) {
        return res.status(400).json({ error: "stationId is required" });
      }
      
      // Verify station exists and is active
      const station = await storage.getStation(stationId);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }
      if (!station.isActive) {
        return res.status(400).json({ error: "Station is not active" });
      }
      
      // Calculate next midnight US Central time using date-fns-tz
      const now = new Date();
      const centralTz = 'America/Chicago';
      
      // Get current date in Central timezone
      const centralNow = toZonedTime(now, centralTz);
      
      // Set to next midnight in Central time
      const nextMidnight = new Date(centralNow);
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      nextMidnight.setHours(0, 0, 0, 0);
      
      // Convert back to UTC for storage
      const expiresAt = fromZonedTime(nextMidnight, centralTz);
      
      const session = await storage.createWebPackingSession(user.id, stationId, expiresAt);
      
      console.log(`[Packing] User ${user.email} selected station ${station.name} (expires ${expiresAt.toISOString()})`);
      
      return res.json({
        session: {
          id: session.id,
          stationId: session.stationId,
          stationName: station.name,
          stationLocationHint: station.locationHint,
          selectedAt: session.selectedAt,
          expiresAt: session.expiresAt,
        }
      });
    } catch (error: any) {
      console.error("[Packing] Error setting station session:", error);
      res.status(500).json({ error: "Failed to set station session" });
    }
  });
  
  // Get list of active stations for selection
  app.get("/api/packing/stations", requireAuth, async (req, res) => {
    try {
      const stations = await storage.getAllStations(true); // Active only
      res.json(stations);
    } catch (error: any) {
      console.error("[Packing] Error fetching stations:", error);
      res.status(500).json({ error: "Failed to fetch stations" });
    }
  });

  // Validate order for packing - cross-validates ShipStation and SkuVault data
  // Query params:
  //   - allowNotShippable: If "true", returns shipment with notShippable warning instead of 422 error
  //     This is used by boxing page which can load orders for QC even if not yet shippable
  //   - shipmentId: If provided, explicitly select this shipment (for multiple shippable shipments scenario)
  app.get("/api/packing/validate-order/:orderNumber", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      const allowNotShippable = req.query.allowNotShippable === 'true';
      const explicitShipmentId = req.query.shipmentId as string | undefined;
      const user = req.user;
      
      console.log(`[Packing Validation] Request for order ${orderNumber}, explicitShipmentId: ${explicitShipmentId || 'none'}`);
      
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      
      // TRACKING NUMBER FALLBACK: If the scanned value is a tracking number, resolve it to an order number
      // This allows workers to scan a shipping label to look up the order (e.g., for packing mistakes)
      let resolvedOrderNumber = orderNumber;
      let scannedTrackingNumber: string | null = null;
      
      // Quick check: Try to find shipments by order number first
      const orderCheck = await storage.getShipmentsByOrderNumber(orderNumber);
      if (orderCheck.length === 0) {
        // No shipments found by order number - try tracking number lookup
        const shipmentByTracking = await storage.getShipmentByTrackingNumber(orderNumber);
        if (shipmentByTracking) {
          console.log(`[Packing Validation] Scanned value "${orderNumber}" resolved as tracking number -> order ${shipmentByTracking.orderNumber}`);
          resolvedOrderNumber = shipmentByTracking.orderNumber;
          scannedTrackingNumber = orderNumber;
        }
      }
      
      // CACHE BYPASS: Skip cache entirely and go direct to SkuVault API
      // The cache was causing issues with stale data, workflow mismatches (bagging vs boxing),
      // and race conditions. The fallback path (database + direct API) is more reliable.
      // TODO: Consider re-enabling cache with simpler logic after stabilizing the packing workflow.
      const warmCacheData = null; // Bypassed: await getWarmCache(resolvedOrderNumber);
      
      let shipment: any = null;
      let shipmentItems: any[] = [];
      let qcSale: import('@shared/skuvault-types').QCSale | null = null;
      let saleId: string | null = null;
      const validationWarnings: string[] = [];
      let cacheSource: 'warm_cache' | 'skuvault_api' | 'database' = 'database';
      
      // Track shippability for response (used when allowNotShippable=true)
      let notShippable: { code: string; message: string; explanation: string; resolution: string } | null = null;
      
      // NEW: Shippable shipments analysis result (for multiple shipment selection)
      let shippableShipments: any[] = [];
      let shippableReason: 'single' | 'multiple' | 'none' = 'none';
      let defaultShipmentId: string | undefined;
      
      // 1. Get shipment data with MULTI-SHIPMENT SUPPORT
      // Check warm cache first for shippable shipments array
      if (warmCacheData?.shippableShipments && warmCacheData.shippableShipments.length > 0) {
        console.log(`[Packing Validation] WARM CACHE HIT for shippable shipments: ${orderNumber} (${warmCacheData.shippableShipments.length} shippable, cached at ${new Date(warmCacheData.warmedAt).toISOString()})`);
        shippableShipments = warmCacheData.shippableShipments;
        shippableReason = warmCacheData.shippableReason || (shippableShipments.length === 1 ? 'single' : 'multiple');
        defaultShipmentId = warmCacheData.defaultShipmentId;
        cacheSource = 'warm_cache';
        
        // Determine which shipment to load based on explicit selection or auto-select
        if (explicitShipmentId) {
          // User explicitly selected a shipment
          shipment = shippableShipments.find((s: any) => s.id === explicitShipmentId);
          if (!shipment) {
            return res.status(404).json({ 
              error: "Selected shipment not found",
              orderNumber,
              requestedShipmentId: explicitShipmentId
            });
          }
          console.log(`[Packing Validation] Using explicitly selected shipment: ${explicitShipmentId}`);
        } else if (shippableShipments.length === 1) {
          // Auto-select single shippable shipment
          shipment = shippableShipments[0];
          console.log(`[Packing Validation] Auto-selecting single shippable shipment: ${shipment.id}`);
        } else if (shippableShipments.length > 1) {
          // MULTIPLE SHIPPABLE SHIPMENTS - Return early with selection options
          console.log(`[Packing Validation] Multiple shippable shipments (${shippableShipments.length}) - returning selection options`);
          
          // Fetch items for each shipment so warehouse can distinguish them
          const shipmentsWithItems = await Promise.all(
            shippableShipments.map(async (s: any) => {
              const items = await storage.getShipmentItems(s.id);
              return {
                id: s.id,
                shipmentId: s.shipmentId,
                carrierCode: s.carrierCode,
                serviceCode: s.serviceCode,
                shipmentStatus: s.shipmentStatus,
                shipToName: s.shipToName,
                shipToCity: s.shipToCity,
                shipToState: s.shipToState,
                trackingNumber: s.trackingNumber,
                items: items.map(item => ({
                  sku: item.sku,
                  name: item.name,
                  quantity: item.quantity,
                })),
              };
            })
          );
          
          return res.json({
            requiresShipmentSelection: true,
            orderNumber: resolvedOrderNumber,
            shippableShipments: shipmentsWithItems,
            shippableCount: shippableShipments.length,
            cacheSource,
          });
        }
      } else {
        // Fall back to database query with centralized eligibility analysis
        console.log(`[Packing Validation] Cache miss for shippable shipments, fetching from PostgreSQL: ${resolvedOrderNumber}`);
        
        const shipmentsResult = await getShippableShipmentsForOrder(resolvedOrderNumber);
        
        if (!shipmentsResult || shipmentsResult.allShipments.length === 0) {
          return res.status(404).json({ 
            error: "Order not found",
            orderNumber: resolvedOrderNumber 
          });
        }
        
        shippableShipments = shipmentsResult.shippableShipments;
        shippableReason = shipmentsResult.reason;
        defaultShipmentId = shipmentsResult.defaultShipmentId;
        
        // Determine which shipment to load
        if (explicitShipmentId) {
          shipment = shippableShipments.find((s: any) => s.id === explicitShipmentId);
          if (!shipment) {
            // Check if it exists but isn't shippable
            const existingShipment = shipmentsResult.allShipments.find((s: any) => s.id === explicitShipmentId);
            if (existingShipment) {
              // Get the specific status for this shipment to provide accurate error message
              const shipmentStatus = shipmentsResult.shipmentStatuses?.find((s: any) => s.id === explicitShipmentId);
              const exclusionReason = shipmentStatus?.reason || 'unknown';
              
              // ALLOW already-shipped orders to proceed for QC purposes
              // This enables the "Proceed to QC" flow on bagging page for already-packed orders
              if (exclusionReason === 'already_shipped' || existingShipment.trackingNumber) {
                console.log(`[Packing Validation] Allowing already-shipped shipment ${explicitShipmentId} for QC purposes`);
                shipment = existingShipment;
              } else {
                // Build accurate error message based on actual exclusion reason
                let explanation = '';
                let resolution = '';
                
                if (exclusionReason === 'on_hold') {
                  explanation = 'This shipment is currently on hold.';
                  resolution = 'Check ShipStation for the hold date, or contact a supervisor if unexpected.';
                } else if (exclusionReason === 'missing_move_over_tag') {
                  explanation = 'This shipment doesn\'t have the "MOVE OVER" tag yet.';
                  resolution = 'Wait for picking to complete in SkuVault, or check with a supervisor.';
                } else if (exclusionReason === 'do_not_ship_package') {
                  explanation = 'This shipment has a "DO NOT SHIP" package type.';
                  resolution = 'Contact a manager immediately before proceeding.';
                } else {
                  explanation = `This shipment is not eligible for packing (reason: ${exclusionReason}).`;
                  resolution = 'Select a different shipment or contact a supervisor.';
                }
                
                return res.status(422).json({
                  error: {
                    code: 'SHIPMENT_NOT_SHIPPABLE',
                    message: 'Selected shipment is not shippable',
                    explanation,
                    resolution
                  },
                  orderNumber: resolvedOrderNumber,
                  requestedShipmentId: explicitShipmentId,
                  exclusionReason
                });
              }
            } else {
              return res.status(404).json({ 
                error: "Selected shipment not found",
                orderNumber: resolvedOrderNumber,
                requestedShipmentId: explicitShipmentId
              });
            }
          }
          console.log(`[Packing Validation] Using explicitly selected shipment: ${explicitShipmentId}`);
        } else if (shippableShipments.length === 1) {
          shipment = shippableShipments[0];
          console.log(`[Packing Validation] Auto-selecting single shippable shipment: ${shipment.id}`);
        } else if (shippableShipments.length > 1) {
          // MULTIPLE SHIPPABLE SHIPMENTS - Return early with selection options
          console.log(`[Packing Validation] Multiple shippable shipments (${shippableShipments.length}) - returning selection options`);
          
          // Fetch items for each shipment so warehouse can distinguish them
          const shipmentsWithItems = await Promise.all(
            shippableShipments.map(async (s: any) => {
              const items = await storage.getShipmentItems(s.id);
              return {
                id: s.id,
                shipmentId: s.shipmentId,
                carrierCode: s.carrierCode,
                serviceCode: s.serviceCode,
                shipmentStatus: s.shipmentStatus,
                shipToName: s.shipToName,
                shipToCity: s.shipToCity,
                shipToState: s.shipToState,
                trackingNumber: s.trackingNumber,
                items: items.map(item => ({
                  sku: item.sku,
                  name: item.name,
                  quantity: item.quantity,
                })),
              };
            })
          );
          
          return res.json({
            requiresShipmentSelection: true,
            orderNumber: resolvedOrderNumber,
            shippableShipments: shipmentsWithItems,
            shippableCount: shippableShipments.length,
            cacheSource,
          });
        } else {
          // NO shippable shipments - all shipments are excluded for various reasons
          // Count exclusion reasons for better error messaging
          const statuses = shipmentsResult.shipmentStatuses;
          const shippedCount = statuses.filter(s => s.reason === 'already_shipped').length;
          const onHoldCount = statuses.filter(s => s.reason === 'on_hold').length;
          const allShipmentsCount = shipmentsResult.allShipments.length;
          
          // SPECIAL CASE: If ALL shipments are already shipped (none on hold), 
          // return alreadyPacked success response instead of error
          // This enables the AlreadyPackedDialog with reprint/QC options
          if (shippedCount === allShipmentsCount && onHoldCount === 0 && allShipmentsCount > 0) {
            console.log(`[Packing Validation] All ${allShipmentsCount} shipments already shipped for order ${resolvedOrderNumber} - returning alreadyPacked response`);
            
            // Fetch items for all shipped shipments
            const alreadyPackedShipments = await Promise.all(
              shipmentsResult.allShipments.map(async (s: any) => {
                const items = await storage.getShipmentItems(s.id);
                return {
                  id: s.id,
                  orderNumber: s.orderNumber,
                  trackingNumber: s.trackingNumber,
                  carrier: s.carrierCode,
                  serviceCode: s.serviceCode,
                  shipToName: s.shipToName,
                  shipToCity: s.shipToCity,
                  shipToState: s.shipToState,
                  status: s.status,
                  qcCompleted: s.qcCompleted,
                  qcCompletedAt: s.qcCompletedAt,
                  items: items.map(item => ({
                    sku: item.sku,
                    name: item.name,
                    quantity: item.quantity,
                    imageUrl: item.imageUrl,
                  })),
                };
              })
            );
            
            // Return success response with alreadyPacked flag
            // Use the first shipment as the "selected" one for consistency
            const firstShipment = shipmentsResult.allShipments[0];
            const firstShipmentItems = await storage.getShipmentItems(firstShipment.id);
            
            return res.json({
              ...firstShipment,
              items: firstShipmentItems,
              alreadyPacked: true,
              alreadyPackedShipments,
              scannedTrackingNumber, // If user scanned a tracking number, include it for filtering
              cacheSource,
              requiresShipmentSelection: false,
              shippableCount: 0,
              selectedShipmentId: firstShipment.id,
              shippableReason: 'none',
            });
          }
          
          // Build dynamic explanation based on actual reasons
          const parts: string[] = [];
          if (shippedCount > 0) {
            parts.push(`${shippedCount} already shipped`);
          }
          if (onHoldCount > 0) {
            parts.push(`${onHoldCount} on hold`);
          }
          const doNotShipCount = statuses.filter(s => s.reason === 'do_not_ship_package').length;
          if (doNotShipCount > 0) {
            parts.push(`${doNotShipCount} DO NOT SHIP`);
          }
          const reasonSummary = parts.length > 0 ? parts.join(', ') : 'not eligible';
          
          const errorInfo = {
            code: doNotShipCount > 0 ? 'DO_NOT_SHIP_PACKAGE' : 'NO_ELIGIBLE_SHIPMENTS',
            message: doNotShipCount > 0 ? 'DO NOT SHIP - Alert Manager' : 'No shipments available for packing',
            explanation: `This order has ${allShipmentsCount} shipment${allShipmentsCount > 1 ? 's' : ''} (${reasonSummary}). None can be packed right now.`,
            resolution: doNotShipCount > 0
              ? 'This order has a "DO NOT SHIP" package type. Contact a manager immediately before proceeding.'
              : shippedCount > 0 && onHoldCount === 0 
                ? 'All shipments have already been shipped. Check ShipStation for tracking info.'
                : onHoldCount > 0 && shippedCount === 0
                  ? 'Check ShipStation for hold dates. If unexpected, contact a supervisor.'
                  : 'Check ShipStation for details on each shipment. Contact a supervisor if unexpected.'
          };
          
          // Fetch items for all shipments so warehouse can distinguish them (needed for both paths)
          const shipmentsWithItems = await Promise.all(
            shipmentsResult.allShipments.map(async (s: any) => {
              // Find the status for this shipment
              const status = statuses.find(st => st.id === s.id);
              const items = await storage.getShipmentItems(s.id);
              return {
                id: s.id,
                shipmentId: s.shipmentId,
                carrierCode: s.carrierCode,
                serviceCode: s.serviceCode,
                shipToName: s.shipToName,
                shipToCity: s.shipToCity,
                shipToState: s.shipToState,
                trackingNumber: s.trackingNumber,
                exclusionReason: status?.reason || 'unknown',
                items: items.map(item => ({
                  sku: item.sku,
                  name: item.name,
                  quantity: item.quantity,
                })),
              };
            })
          );
          
          if (allowNotShippable && shipmentsResult.allShipments.length > 0) {
            // Boxing page: Return early with noEligibleShipments response so frontend can show scan error UI
            // This matches how bagging page handles it via the error path
            console.log(`[Packing Validation] No eligible shipments for order ${resolvedOrderNumber}: ${shippedCount} shipped, ${onHoldCount} on hold - returning noEligibleShipments response`);
            return res.status(200).json({
              noEligibleShipments: true,
              error: errorInfo,
              orderNumber: resolvedOrderNumber,
              shipments: shipmentsWithItems,
              shipmentStatuses: statuses,
            });
          } else {
            const firstShipment = shipmentsResult.allShipments[0];
            
            return res.status(422).json({
              error: errorInfo,
              orderNumber: resolvedOrderNumber,
              shipmentId: firstShipment?.id,
              shipments: shipmentsWithItems,
              shipmentStatuses: statuses,
            });
          }
        }
      }
      
      // DO NOT SHIP PACKAGE & SERVICE CODE CHECK: ALWAYS verify even for cached shipments
      // This catches stale cache data and ensures DO NOT SHIP or missing service code orders are never processed
      if (shipment && !notShippable) {
        // Check for missing serviceCode
        if (!shipment.serviceCode) {
          console.log(`[Packing Validation] Order ${resolvedOrderNumber} is missing serviceCode - blocking`);
          
          const missingServiceError = {
            code: 'MISSING_SERVICE_CODE',
            message: 'No Carrier/Service Selected',
            explanation: 'This order does not have a carrier and service method selected in ShipStation.',
            resolution: 'Contact ShipStation or a manager to select a carrier and service for this order before proceeding.'
          };
          
          if (allowNotShippable) {
            return res.status(200).json({
              noEligibleShipments: true,
              error: missingServiceError,
              orderNumber: resolvedOrderNumber,
              shipments: [{
                id: shipment.id,
                shipmentId: shipment.shipmentId,
                carrierCode: shipment.carrierCode,
                serviceCode: shipment.serviceCode,
                shipToName: shipment.shipToName,
                shipToCity: shipment.shipToCity,
                shipToState: shipment.shipToState,
                trackingNumber: shipment.trackingNumber,
                exclusionReason: 'missing_service_code',
                items: [],
              }],
              shipmentStatuses: [{ id: shipment.id, reason: 'missing_service_code' }],
            });
          } else {
            return res.status(422).json({
              error: missingServiceError,
              orderNumber: resolvedOrderNumber,
              shipmentId: shipment.id
            });
          }
        }
        
        // Check for DO NOT SHIP package
        const shipmentPackagesData = await storage.getShipmentPackages(shipment.id);
        const hasDoNotShipPkg = shipmentPackagesData.some((pkg: { packageName: string | null }) => 
          pkg.packageName === '**DO NOT SHIP (ALERT MGR)**'
        );
        
        if (hasDoNotShipPkg) {
          console.log(`[Packing Validation] Order ${resolvedOrderNumber} has DO NOT SHIP package - blocking`);
          
          const doNotShipError = {
            code: 'DO_NOT_SHIP_PACKAGE',
            message: 'DO NOT SHIP - Alert Manager',
            explanation: 'This order has a "DO NOT SHIP" package type assigned in ShipStation.',
            resolution: 'Contact a manager immediately before proceeding. This order requires special handling.'
          };
          
          // DO NOT SHIP orders should NEVER be packed - always return error
          // Unlike missing MOVE OVER tag, this is a hard block even on boxing page
          if (allowNotShippable) {
            // Return noEligibleShipments response for boxing page UI
            return res.status(200).json({
              noEligibleShipments: true,
              error: doNotShipError,
              orderNumber: resolvedOrderNumber,
              shipments: [{
                id: shipment.id,
                shipmentId: shipment.shipmentId,
                carrierCode: shipment.carrierCode,
                serviceCode: shipment.serviceCode,
                shipToName: shipment.shipToName,
                shipToCity: shipment.shipToCity,
                shipToState: shipment.shipToState,
                trackingNumber: shipment.trackingNumber,
                exclusionReason: 'do_not_ship_package',
                items: [],
              }],
              shipmentStatuses: [{ id: shipment.id, reason: 'do_not_ship_package' }],
            });
          } else {
            return res.status(422).json({
              error: doNotShipError,
              orderNumber: resolvedOrderNumber,
              shipmentId: shipment.id
            });
          }
        }
      }
      
      // SHIPPABILITY CHECK: Verify order has "MOVE OVER" tag before allowing packing
      // Skip this check if we already selected from shippable shipments (they're pre-filtered)
      // Only run if we got here via legacy path or allowNotShippable fallback
      if (!shippableShipments.some((s: any) => s.id === shipment?.id) && shipment && !notShippable) {
        const shipmentTagsData = await storage.getShipmentTags(shipment.id);
        const hasMoveOverTag = shipmentTagsData.some((tag: { name: string }) => tag.name === 'MOVE OVER');
        
        if (!hasMoveOverTag) {
          console.log(`[Packing Validation] Order ${resolvedOrderNumber} is not shippable - missing MOVE OVER tag`);
          
          const notShippableError = {
            code: 'NOT_SHIPPABLE',
            message: 'This order is not shippable',
            explanation: 'The order does not have the "MOVE OVER" tag. This means the order may still be in picking, or it hasn\'t been released from SkuVault yet.',
            resolution: 'Wait for the order to complete picking in SkuVault, or check with a supervisor if you believe this order should be ready to ship.'
          };
          
          // If allowNotShippable is true (boxing page), continue loading but include warning
          // Otherwise (bagging page), return 422 error to block the scan
          if (allowNotShippable) {
            notShippable = notShippableError;
            console.log(`[Packing Validation] allowNotShippable=true, continuing with warning for order ${resolvedOrderNumber}`);
          } else {
            return res.status(422).json({
              error: notShippableError,
              orderNumber: resolvedOrderNumber,
              shipmentId: shipment.id
            });
          }
        }
      }
      
      // Always fetch shipment items from PostgreSQL (not cached, rarely needed for rendering)
      shipmentItems = await storage.getShipmentItems(shipment.id);
      
      try {
        // 2. Get QCSale data (prefer warm cache, fallback to SkuVault API)
        // Use ShipStation ID (se-XXX format) as the canonical key for cache lookups
        // This aligns with how the cache warmer stores data and SkuVault's sale naming convention
        const shipstationShipmentId = shipment?.shipmentId; // se-XXX format - canonical key
        
        // Check if warm cache has shipment-specific QCSale data (multi-shipment support)
        // Priority: qcSalesByShipment[shipstationId] > qcSale (backward compat default)
        const qcSalesByShipment = warmCacheData?.qcSalesByShipment as Record<string, any> | undefined;
        
        // DEBUG: Log available cache keys for multi-shipment debugging
        const cacheKeys = qcSalesByShipment ? Object.keys(qcSalesByShipment) : [];
        console.log(`[Packing Validation] [MULTI-SHIPMENT DEBUG] Looking up key=${shipstationShipmentId}, available keys=[${cacheKeys.join(', ')}]`);
        
        const cachedQcSaleForShipment = shipstationShipmentId && qcSalesByShipment?.[shipstationShipmentId];
        
        if (cachedQcSaleForShipment) {
          console.log(`[Packing Validation] WARM CACHE HIT for QCSale (shipment-specific): ${resolvedOrderNumber}, shipstationId: ${shipstationShipmentId}`);
          // DEBUG: Log QCSale details to verify correct data
          const itemSkus = (cachedQcSaleForShipment.Items || []).slice(0, 5).map((i: any) => i.Sku).join(', ');
          console.log(`[Packing Validation] [MULTI-SHIPMENT DEBUG] Retrieved SaleId=${cachedQcSaleForShipment.SaleId}, Items=${cachedQcSaleForShipment.Items?.length || 0} [${itemSkus}], PassedItems=${cachedQcSaleForShipment.PassedItems?.length || 0}`);
          qcSale = cachedQcSaleForShipment as import('@shared/skuvault-types').QCSale;
          if (cacheSource !== 'warm_cache') cacheSource = 'warm_cache';
        } else if (warmCacheData?.qcSale) {
          // Fallback to default QCSale (single-shipment orders or backward compat)
          console.log(`[Packing Validation] WARM CACHE HIT for QCSale (default): ${resolvedOrderNumber}`);
          qcSale = warmCacheData.qcSale as import('@shared/skuvault-types').QCSale;
          if (cacheSource !== 'warm_cache') cacheSource = 'warm_cache';
        } else {
          // Use ShipStation shipment ID (se-XXX format) for SkuVault lookup
          // SkuVault uses this format in their composite order IDs (e.g., "480797-ORDER-123-933001022")
          console.log(`[Packing Validation] Warm cache miss for QCSale, fetching from SkuVault API: ${resolvedOrderNumber} (shipstationId: ${shipstationShipmentId || 'none'})`);
          qcSale = await skuVaultService.getQCSalesByOrderNumber(resolvedOrderNumber, shipstationShipmentId);
          if (cacheSource === 'database') cacheSource = 'skuvault_api';
        }
        
        if (qcSale) {
          saleId = qcSale.SaleId ?? null;
          console.log(`[Packing Validation] Found SkuVault QC Sale:`, {
            SaleId: saleId,
            Status: qcSale.Status,
            TotalItems: qcSale.TotalItems,
            PassedItems: qcSale.PassedItems?.length ?? 0,
          });
          
          // Cache QCSale data for barcode validation (includes kit components)
          await qcSaleCache.set(resolvedOrderNumber, qcSale);
          
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
                  console.log(`[Packing Validation] No shipment item found for SKU ${passedItem.Sku} (may be kit component or removed item)`);
                  continue;
                }
                
                await storage.createShipmentEvent({
                  occurredAt: new Date(), // Use current time (SkuVault timestamps unreliable)
                  username: passedItem.UserName || `SkuVault User ${passedItem.UserId || 'Unknown'}`,
                  station: "skuvault_qc",
                  eventName: "product_scan_success",
                  orderNumber: resolvedOrderNumber,
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
      
      // 5. Fetch pending print jobs for this shipment (immediate display)
      const allPrintJobs = await storage.getJobsByShipment(shipment.id.toString());
      const pendingPrintJobs = allPrintJobs.filter(job => 
        job.status === 'pending' || job.status === 'queued' || job.status === 'printing'
      );
      
      // 6. Build items array - USE SKUVAULT AS GOLDEN SOURCE when available
      // Transform SkuVault Items to match ShipmentItem format for frontend compatibility
      let itemsToReturn = shipmentItems; // Fallback to ShipStation if SkuVault unavailable
      
      if (qcSale?.Items && qcSale.Items.length > 0) {
        console.log(`[Packing Validation] Using SkuVault as golden source for items (${qcSale.Items.length} items)`);
        
        // Build PassedItems maps for tracking scanned components
        // We need to track by both SKU and Code (barcode) since scans can match either
        const passedItemsBySku = new Map<string, number>();
        const passedItemsByCode = new Map<string, number>();
        console.log(`[Packing Validation] Processing ${(qcSale.PassedItems ?? []).length} PassedItems for progress tracking`);
        
        (qcSale.PassedItems ?? []).forEach(passedItem => {
          const qty = passedItem.Quantity || 0;
          if (qty <= 0) return;
          
          console.log(`[Packing Validation] PassedItem: Sku=${passedItem.Sku}, Code=${passedItem.Code}, ScannedCode=${passedItem.ScannedCode}, Qty=${qty}`);
          
          // Track by SKU
          if (passedItem.Sku) {
            const sku = passedItem.Sku.trim().toUpperCase();
            passedItemsBySku.set(sku, (passedItemsBySku.get(sku) || 0) + qty);
          }
          // Track by Code (barcode) - this is often what gets scanned
          if (passedItem.Code) {
            const code = passedItem.Code.trim().toUpperCase();
            passedItemsByCode.set(code, (passedItemsByCode.get(code) || 0) + qty);
          }
          // Also track by ScannedCode if different from Code
          if (passedItem.ScannedCode && passedItem.ScannedCode !== passedItem.Code) {
            const scannedCode = passedItem.ScannedCode.trim().toUpperCase();
            passedItemsByCode.set(scannedCode, (passedItemsByCode.get(scannedCode) || 0) + qty);
          }
        });
        
        console.log(`[Packing Validation] PassedItems maps: bySku=${JSON.stringify([...passedItemsBySku])}, byCode=${JSON.stringify([...passedItemsByCode])}`);
        
        // Transform items - kits stay as single items with nested components
        const transformedItems: any[] = [];
        
        qcSale.Items.forEach((svItem, index) => {
          // Try to find matching ShipStation item for additional data (imageUrl, etc.)
          const matchingSSItem = shipmentItems.find(ssItem => 
            ssItem.sku && svItem.Sku && 
            ssItem.sku.trim().toUpperCase() === svItem.Sku.trim().toUpperCase()
          );
          
          // For kits: build nested components array and calculate aggregate quantities
          let kitComponents: any[] = [];
          let totalComponentsExpected = 0;
          let totalComponentsScanned = 0;
          
          if (svItem.IsKit && svItem.KitProducts && svItem.KitProducts.length > 0) {
            kitComponents = svItem.KitProducts.map((component, compIndex) => {
              // IMPORTANT: SkuVault's component.Quantity is already the TOTAL needed 
              // (pre-multiplied by kit quantity ordered). Do NOT multiply by svItem.Quantity again.
              // Example: Kit ordered x2 with 2 components each → component.Quantity = 2 (not 1)
              const componentTotalQty = component.Quantity || 1;
              totalComponentsExpected += componentTotalQty;
              
              // Check if this component has been scanned (from PassedItems)
              // Try matching by SKU first, then by Code (barcode)
              const componentSku = (component.Sku || '').toUpperCase().trim();
              const componentCode = (component.Code || '').toUpperCase().trim();
              const componentPartNumber = (component.PartNumber || '').toUpperCase().trim();
              
              // Get scanned quantity - check both SKU and Code maps
              let scannedQty = passedItemsBySku.get(componentSku) || 0;
              const scannedFromSku = scannedQty;
              if (scannedQty === 0 && componentCode) {
                scannedQty = passedItemsByCode.get(componentCode) || 0;
              }
              const scannedFromCode = scannedQty > scannedFromSku ? scannedQty : 0;
              
              // Also check PartNumber as fallback
              if (scannedQty === 0 && componentPartNumber) {
                scannedQty = passedItemsByCode.get(componentPartNumber) || 0;
              }
              
              console.log(`[Packing Validation] Component ${compIndex}: Sku=${componentSku}, Code=${componentCode}, PartNumber=${componentPartNumber}, scannedFromSku=${scannedFromSku}, scannedFromCode=${scannedFromCode}, finalScanned=${scannedQty}/${componentTotalQty}`);
              
              totalComponentsScanned += Math.min(scannedQty, componentTotalQty);
              
              return {
                id: `sv-${svItem.Id || index}-kit-${compIndex}`,
                sku: component.Sku || null,
                code: component.Code || component.PartNumber || null, // Code contains UPC barcode, PartNumber is fallback
                partNumber: component.PartNumber || null,
                name: component.Title || component.Sku || 'Unknown Component',
                quantity: componentTotalQty,
                scannedQuantity: Math.min(scannedQty, componentTotalQty),
                picture: component.Picture || null,
                skuvaultItemId: component.Id || null,
              };
            });
            
            console.log(`[Packing Validation] Kit ${svItem.Sku}: ${kitComponents.length} components, ${totalComponentsScanned}/${totalComponentsExpected} scanned`);
          }
          
          const item = {
            id: `sv-${svItem.Id || index}`,
            shipmentId: shipment.id,
            orderItemId: svItem.Id || null,
            sku: svItem.Sku || null,
            name: svItem.Title || svItem.Sku || 'Unknown Item',
            quantity: svItem.Quantity || 1,
            expectedQuantity: svItem.Quantity || 1,
            unitPrice: svItem.UnitPrice?.a?.toString() || null,
            imageUrl: svItem.Picture || matchingSSItem?.imageUrl || null,
            skuvaultItemId: svItem.Id || null,
            skuvaultCode: svItem.Code || svItem.PartNumber || null, // Code contains UPC barcode, PartNumber is fallback
            skuvaultPartNumber: svItem.PartNumber || null,
            passedStatus: svItem.PassedStatus || null,
            // Kit-related fields
            isKit: svItem.IsKit || false,
            kitComponents: kitComponents.length > 0 ? kitComponents : null,
            totalComponentsExpected: svItem.IsKit ? totalComponentsExpected : null,
            totalComponentsScanned: svItem.IsKit ? totalComponentsScanned : null,
            allKitItemsAndSubstitutes: svItem.AllKitItemsAndSubstitutes || null,
            alternateSkus: svItem.AlternateSkus || null,
            alternateCodes: svItem.AlternateCodes || null,
          };
          
          transformedItems.push(item);
        });
        
        itemsToReturn = transformedItems;
        console.log(`[Packing Validation] Transformed ${qcSale.Items.length} SkuVault items (kits have nested components)`);
      } else {
        console.log(`[Packing Validation] No SkuVault items available, falling back to ShipStation (${shipmentItems.length} items)`);
        validationWarnings.push("Using ShipStation items - SkuVault data unavailable");
      }
      
      // 7. Check if order is already packed (has tracking number = label was purchased)
      // This is more robust than checking events because it catches labels created outside the system
      const alreadyPacked = !!shipment.trackingNumber;
      
      // 7b. NEW: If already packed, collect ALL shipped shipments for this order
      // This supports multi-shipment scenarios where an order was split across packages
      let alreadyPackedShipments: any[] = [];
      if (alreadyPacked) {
        console.log(`[Packing Validation] Order ${resolvedOrderNumber} is already packed - trackingNumber: ${shipment.trackingNumber}`);
        
        // Fetch all shipments for this order and filter to those with tracking numbers
        const allOrderShipments = await storage.getShipmentsByOrderNumber(resolvedOrderNumber);
        const shippedShipments = allOrderShipments.filter(s => !!s.trackingNumber);
        
        console.log(`[Packing Validation] Found ${shippedShipments.length} shipped shipments for order ${resolvedOrderNumber}`);
        
        // Fetch items for each shipped shipment
        alreadyPackedShipments = await Promise.all(
          shippedShipments.map(async (s) => {
            const items = await storage.getShipmentItems(s.id);
            return {
              id: s.id,
              orderNumber: s.orderNumber,
              trackingNumber: s.trackingNumber,
              carrier: s.carrierCode,
              serviceCode: s.serviceCode,
              shipToName: s.shipToName,
              shipToCity: s.shipToCity,
              shipToState: s.shipToState,
              status: s.status,
              qcCompleted: s.qcCompleted,
              qcCompletedAt: s.qcCompletedAt,
              items: items.map(item => ({
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                imageUrl: item.imageUrl,
              })),
            };
          })
        );
      }
      
      // 7c. Fetch packages for the selected shipment
      // For cache hit path, packages may already be in shipment from cache warmer
      // For database fallback path, fetch them now
      let shipmentPackages = shipment.packages || [];
      if (!shipment.packages || shipment.packages.length === 0) {
        shipmentPackages = await storage.getShipmentPackages(shipment.id);
      }
      
      // 8. Return combined data with pending print jobs
      res.json({
        ...shipment,
        packages: shipmentPackages, // Package details for shipping info display
        items: itemsToReturn, // SkuVault items (golden source) or ShipStation fallback
        saleId, // SkuVault Sale ID for QC scanning
        qcSale, // Full SkuVault QC Sale data (includes PassedItems, Items, etc.)
        validationWarnings, // Array of warnings if items don't match
        pendingPrintJobs, // Pre-calculated for immediate display
        hasPendingPrintJobs: pendingPrintJobs.length > 0,
        itemsSource: qcSale?.Items?.length ? 'skuvault' : 'shipstation', // Tell frontend which source was used
        cacheSource, // Whether data came from warm cache or direct API call
        sessionStatus: shipment.sessionStatus || null, // Explicitly include for refresh button gating
        notShippable, // Warning if order is missing MOVE OVER tag (only present when allowNotShippable=true)
        alreadyPacked, // True if order has tracking number (label already purchased)
        alreadyPackedShipments, // Array of all shipped shipments for this order (multi-shipment support)
        scannedTrackingNumber, // If user scanned a tracking number, this is the tracking number they scanned (for filtering)
        // NEW: Multi-shipment support fields
        requiresShipmentSelection: false, // False when a shipment was successfully selected
        shippableCount: shippableShipments.length, // How many shippable shipments exist for this order
        selectedShipmentId: shipment.id, // Which shipment was loaded
        shippableReason, // 'single' | 'multiple' | 'none' - why this shipment was selected
      });
    } catch (error: any) {
      console.error("[Packing Validation] Error validating order:", error);
      res.status(500).json({ error: "Failed to validate order" });
    }
  });

  // Manual cache refresh for a single order
  // Used when customer service makes order changes and packing needs fresh data
  app.post("/api/packing/refresh-cache/:orderNumber", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      const user = (req as any).user;
      
      console.log(`[Packing] Manual cache refresh requested for order: ${orderNumber}`);
      
      // Verify the order exists and is in a valid state for refreshing
      const shipmentResults = await storage.getShipmentsByOrderNumber(orderNumber);
      
      if (shipmentResults.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: "Order not found",
          orderNumber 
        });
      }
      
      const shipment = shipmentResults[0];
      
      // Only allow refresh for orders that haven't completed QC yet
      // NOTE: Bagging workflow prints label FIRST, then scans items for QC.
      // So having a tracking number is NOT enough to block refresh - we must check qcCompleted flag.
      if (shipment.qcCompleted === true) {
        return res.status(400).json({
          success: false,
          error: "Cannot refresh cache for orders that have completed QC",
          orderNumber,
          resolution: "This order has already been packed and QC completed."
        });
      }
      
      // Verify the session is closed (order has been picked and is ready to pack)
      if (shipment.sessionStatus && shipment.sessionStatus !== 'closed') {
        return res.status(400).json({
          success: false,
          error: `Cannot refresh cache for orders in '${shipment.sessionStatus}' session status`,
          orderNumber,
          sessionStatus: shipment.sessionStatus,
          resolution: shipment.sessionStatus === 'active' 
            ? "This order is currently being picked. Wait for picking to complete."
            : shipment.sessionStatus === 'inactive'
              ? "This order is paused mid-pick. It needs supervisor attention."
              : "This order is not yet ready to pack."
        });
      }
      
      // Force refresh the cache from SkuVault - use detailed function for logging
      const refreshResult = await refreshCacheForOrderDetailed(orderNumber);
      
      // Log the refresh attempt to packing_logs for analysis
      try {
        await storage.createPackingLog({
          userId: user.id,
          shipmentId: refreshResult.shipmentId || shipment.id,
          orderNumber,
          action: 'cache_refresh_attempt',
          productSku: null,
          scannedCode: null,
          skuVaultProductId: refreshResult.saleId || null,
          success: refreshResult.success,
          errorMessage: refreshResult.errorMessage || null,
          skuVaultRawResponse: {
            ...(refreshResult.skuvaultRawResponse || {}),
            shipstationId: refreshResult.shipstationId || null,
            saleId: refreshResult.saleId || null,
            skuvaultOrderId: refreshResult.skuvaultOrderId || null,
            qcSaleStatus: refreshResult.qcSaleStatus || null,
            itemsFound: refreshResult.itemsFound ?? 0,
            barcodesFound: refreshResult.barcodesFound ?? 0,
            passedItemsCount: refreshResult.passedItemsCount ?? 0,
            errorStage: refreshResult.errorStage || null,
          },
          station: null,
          stationId: null,
        });
      } catch (logError: any) {
        console.error(`[Packing] Failed to log cache refresh attempt: ${logError.message}`);
      }
      
      if (refreshResult.success) {
        res.json({
          success: true,
          message: "Cache refreshed successfully",
          orderNumber,
          details: {
            saleId: refreshResult.saleId,
            itemsFound: refreshResult.itemsFound,
            barcodesFound: refreshResult.barcodesFound,
          }
        });
      } else {
        res.status(500).json({
          success: false,
          error: "Failed to refresh cache - order may not be sessioned in SkuVault",
          orderNumber,
          resolution: "The order may not have been picked yet. Check SkuVault session status.",
          details: {
            errorStage: refreshResult.errorStage,
            errorMessage: refreshResult.errorMessage,
            shipstationId: refreshResult.shipstationId,
          }
        });
      }
    } catch (error: any) {
      console.error("[Packing] Error refreshing cache:", error);
      res.status(500).json({ 
        success: false,
        error: "Failed to refresh cache",
        message: error.message 
      });
    }
  });

  // Debug endpoint: Get full cache data for an order (shows qcSalesByShipment structure)
  app.get("/api/packing/cache-debug/:orderNumber", requireAuth, async (req, res) => {
    try {
      const { orderNumber } = req.params;
      
      if (!orderNumber) {
        return res.status(400).json({ error: "Order number is required" });
      }
      
      // Get the raw cache data
      const cacheData = await getWarmCache(orderNumber);
      
      if (!cacheData) {
        return res.status(404).json({ 
          error: "No cache found",
          orderNumber,
          message: "This order is not in the warm cache. It may not be ready for packing or the cache has expired."
        });
      }
      
      // Get all shipments for this order from the database
      const shipments = await storage.getShipmentsByOrderNumber(orderNumber);
      
      // Build a comprehensive debug response
      const debugResponse = {
        orderNumber,
        cachedAt: cacheData.cachedAt ? new Date(cacheData.cachedAt).toISOString() : null,
        warmedAt: cacheData.warmedAt ? new Date(cacheData.warmedAt).toISOString() : null,
        
        // Default QCSale (backward compat - first shipment)
        defaultQcSale: cacheData.qcSale ? {
          SaleId: cacheData.qcSale.SaleId,
          OrderId: cacheData.qcSale.OrderId,
          Status: cacheData.qcSale.Status,
          TotalItems: cacheData.qcSale.TotalItems,
          ItemsCount: cacheData.qcSale.Items?.length ?? 0,
          PassedItemsCount: cacheData.qcSale.PassedItems?.length ?? 0,
          PassedItems: cacheData.qcSale.PassedItems ?? [],
          Items: cacheData.qcSale.Items ?? [],
        } : null,
        
        // Per-shipment QCSale data (multi-shipment support)
        qcSalesByShipment: cacheData.qcSalesByShipment ? 
          Object.fromEntries(
            Object.entries(cacheData.qcSalesByShipment).map(([shipmentId, qcSale]: [string, any]) => [
              shipmentId,
              {
                SaleId: qcSale.SaleId,
                OrderId: qcSale.OrderId,
                Status: qcSale.Status,
                TotalItems: qcSale.TotalItems,
                ItemsCount: qcSale.Items?.length ?? 0,
                PassedItemsCount: qcSale.PassedItems?.length ?? 0,
                PassedItems: qcSale.PassedItems ?? [],
                Items: qcSale.Items ?? [],
              }
            ])
          ) : {},
        
        // Shipment metadata from cache
        shippableShipments: cacheData.shippableShipments ?? [],
        defaultShipmentId: cacheData.defaultShipmentId ?? null,
        shippableReason: cacheData.shippableReason ?? null,
        
        // Shipments from database for comparison
        databaseShipments: shipments.map(s => ({
          id: s.id,
          shipmentId: s.shipmentId,
          orderNumber: s.orderNumber,
          sessionStatus: s.sessionStatus,
          trackingNumber: s.trackingNumber,
          qcCompleted: s.qcCompleted,
          shipmentStatus: s.shipmentStatus,
        })),
        
        // Lookup map keys (for barcode debugging)
        lookupMapKeys: cacheData.lookupMap ? Object.keys(cacheData.lookupMap) : [],
        lookupMapsByShipmentKeys: cacheData.lookupMapsByShipment ?
          Object.fromEntries(
            Object.entries(cacheData.lookupMapsByShipment).map(([shipmentId, map]: [string, any]) => [
              shipmentId,
              Object.keys(map)
            ])
          ) : {},
      };
      
      res.json(debugResponse);
    } catch (error: any) {
      console.error("[Packing] Error fetching cache debug data:", error);
      res.status(500).json({ 
        error: "Failed to fetch cache debug data",
        message: error.message 
      });
    }
  });

  // Get cache warmer status and metrics
  app.get("/api/operations/cache-warmer-status", requireAuth, async (req, res) => {
    try {
      const metrics = getCacheWarmerMetrics();
      res.json({
        status: metrics.workerStatus,
        metrics: {
          ordersWarmed: metrics.ordersWarmed,
          cacheHits: metrics.cacheHits,
          cacheMisses: metrics.cacheMisses,
          invalidations: metrics.invalidations,
          manualRefreshes: metrics.manualRefreshes,
          apiCallsSaved: metrics.apiCallsSaved,
        },
        lastPollAt: metrics.lastPollAt?.toISOString() || null,
        lastError: metrics.lastError,
      });
    } catch (error: any) {
      console.error("[Operations] Error fetching cache warmer status:", error);
      res.status(500).json({ error: "Failed to fetch cache warmer status" });
    }
  });

  // Get batch warm cache status for multiple order numbers
  // Used by frontend to show cache indicators on shipment cards
  app.post("/api/operations/warm-cache-status", requireAuth, async (req, res) => {
    try {
      const { orderNumbers } = req.body;
      
      if (!Array.isArray(orderNumbers)) {
        return res.status(400).json({ error: "orderNumbers must be an array" });
      }
      
      if (orderNumbers.length > 100) {
        return res.status(400).json({ error: "Maximum 100 order numbers per request" });
      }
      
      const statusMap = await getWarmCacheStatusBatch(orderNumbers);
      
      // Convert Map to object for JSON response
      const statuses: Record<string, { isWarmed: boolean; warmedAt: number | null }> = {};
      statusMap.forEach((value, key) => {
        statuses[key] = value;
      });
      
      res.json({ statuses });
    } catch (error: any) {
      console.error("[Operations] Error fetching warm cache status:", error);
      res.status(500).json({ error: "Failed to fetch warm cache status" });
    }
  });

  // Get inactive session shipments (stuck orders needing attention)
  app.get("/api/operations/inactive-sessions", requireAuth, async (req, res) => {
    try {
      const inactiveShipments = await getInactiveSessionShipments();
      res.json({
        count: inactiveShipments.length,
        shipments: inactiveShipments,
        message: inactiveShipments.length > 0 
          ? `${inactiveShipments.length} orders are stuck in 'inactive' session status and need supervisor attention`
          : "No inactive sessions found - all orders are progressing normally"
      });
    } catch (error: any) {
      console.error("[Operations] Error fetching inactive sessions:", error);
      res.status(500).json({ error: "Failed to fetch inactive sessions" });
    }
  });

  // Backfill tracking numbers for shipments with closed sessions but no tracking
  // This syncs from ShipStation to hydrate missing tracking numbers
  app.post("/api/operations/backfill-tracking-numbers", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      
      // Find shipments with closed session but no tracking number
      const { shipments } = await storage.getFilteredShipments({
        lifecycleTab: 'packing_ready' // sessionStatus='closed' AND trackingNumber IS NULL AND status != 'cancelled'
      });
      
      const shipmentsToProcess = shipments.slice(0, limit);
      console.log(`[TrackingBackfill] Processing ${shipmentsToProcess.length} of ${shipments.length} shipments`);
      
      const results = {
        total: shipments.length,
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        details: [] as any[]
      };
      
      for (const shipment of shipmentsToProcess) {
        if (!shipment.orderNumber) {
          results.skipped++;
          continue;
        }
        
        try {
          const syncResult = await shipmentService.syncShipmentsForOrder(shipment.orderNumber);
          results.processed++;
          
          if (syncResult.success && syncResult.shipments.length > 0) {
            // Check if any synced shipment now has a tracking number
            const updatedShipment = syncResult.shipments.find((s: any) => s.trackingNumber);
            if (updatedShipment) {
              results.updated++;
              results.details.push({
                orderNumber: shipment.orderNumber,
                status: 'updated',
                trackingNumber: updatedShipment.trackingNumber
              });
              // Invalidate cache for this order since it now has tracking
              try {
                await invalidateCacheForOrder(shipment.orderNumber);
                console.log(`[TrackingBackfill] Invalidated cache for ${shipment.orderNumber}`);
              } catch (cacheError: any) {
                console.error(`[TrackingBackfill] Failed to invalidate cache for ${shipment.orderNumber}:`, cacheError.message);
              }
            }
          }
          
          // Respect rate limits - wait between API calls
          if (syncResult.rateLimit?.remaining && syncResult.rateLimit.remaining < 10) {
            const waitMs = (syncResult.rateLimit.resetInSeconds || 60) * 1000;
            console.log(`[TrackingBackfill] Rate limit low (${syncResult.rateLimit.remaining}), waiting ${waitMs}ms`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          } else {
            // Small delay between requests to be nice to the API
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (error: any) {
          results.errors++;
          console.error(`[TrackingBackfill] Error syncing ${shipment.orderNumber}:`, error.message);
        }
      }
      
      console.log(`[TrackingBackfill] Complete: ${results.updated} updated, ${results.errors} errors`);
      res.json({
        message: `Processed ${results.processed} shipments, updated ${results.updated} with tracking numbers`,
        ...results
      });
    } catch (error: any) {
      console.error("[Operations] Error in tracking backfill:", error);
      res.status(500).json({ error: "Failed to backfill tracking numbers" });
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

  // Fast barcode validation for packing - uses SkuVault cached data (includes kit components)
  // Requires orderNumber to look up in the cached QCSale data
  // Optional query param: ?shipmentId=<se-XXX> for multi-shipment order support (ShipStation ID)
  app.get("/api/packing/validate-barcode/:orderNumber/:barcode", requireAuth, async (req, res) => {
    try {
      const { orderNumber, barcode } = req.params;
      const { shipmentId } = req.query; // Optional: ShipStation shipment ID (se-XXX format) for multi-shipment orders
      
      if (!orderNumber || orderNumber.trim() === '') {
        return res.status(400).json({ 
          valid: false, 
          error: "Order number is required" 
        });
      }
      
      if (!barcode || barcode.trim() === '') {
        return res.status(400).json({ 
          valid: false, 
          error: "Barcode is required" 
        });
      }
      
      // SKUVAULT IS SOURCE OF TRUTH: Validate barcode directly against SkuVault QCSale data
      // This bypasses shipment_items (from ShipStation) which may have different SKU formats
      console.log(`[Packing Validation] Validating barcode ${barcode} against SkuVault QCSale for order ${orderNumber}`);
      
      try {
        // 1. Fetch QCSale from SkuVault - this is the authoritative source
        const qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber);
        
        if (!qcSale || !qcSale.Items || qcSale.Items.length === 0) {
          console.log(`[Packing Validation] No QCSale found in SkuVault for order ${orderNumber}`);
          return res.status(404).json({ 
            valid: false, 
            error: "Order not found in SkuVault QC system",
            scannedValue: barcode,
            orderNumber,
          });
        }
        
        console.log(`[Packing Validation] QCSale found: ${qcSale.SaleId} with ${qcSale.Items.length} items`);
        
        const normalizedBarcode = barcode.toUpperCase().trim();
        
        // 2. Check if barcode matches any top-level item (Code/SKU/PartNumber)
        for (const item of qcSale.Items) {
          const itemCode = (item.Code || '').toUpperCase().trim();
          const itemSku = (item.Sku || '').toUpperCase().trim();
          const itemPartNumber = (item.PartNumber || '').toUpperCase().trim();
          
          if (itemCode === normalizedBarcode || itemSku === normalizedBarcode || itemPartNumber === normalizedBarcode) {
            console.log(`[Packing Validation] Direct match: barcode ${barcode} -> item ${item.Sku} (ID: ${item.Id})`);
            return res.json({
              valid: true,
              sku: item.Sku,
              barcode: barcode,
              title: item.Title || 'Unknown Product',
              quantity: item.Quantity || 1,
              itemId: item.Id?.toString() || null,
              saleId: qcSale.SaleId || null,
              isKitComponent: false,
              kitId: null,
              kitSku: null,
              kitTitle: null,
              fallbackValidation: true,
            });
          }
          
          // 2b. Check AlternateSkus for variant matching
          if (item.AlternateSkus && item.AlternateSkus.length > 0) {
            const matchedVariant = item.AlternateSkus.find(alt => {
              const altSku = (alt.Sku || '').toUpperCase().trim();
              return altSku === normalizedBarcode;
            });
            
            if (matchedVariant) {
              console.log(`[Packing Validation] Variant match: barcode ${barcode} -> variant ${matchedVariant.Sku} of parent ${item.Sku} (ID: ${item.Id})`);
              return res.json({
                valid: true,
                sku: item.Sku,
                barcode: barcode,
                title: item.Title || 'Unknown Product',
                quantity: item.Quantity || 1,
                itemId: item.Id?.toString() || null,
                saleId: qcSale.SaleId || null,
                isKitComponent: false,
                kitId: null,
                kitSku: null,
                kitTitle: null,
                fallbackValidation: true,
                variantSku: matchedVariant.Sku,
              });
            }
          }
          
          // 3. If item is a kit, check kit components
          if (item.IsKit && item.KitProducts && item.KitProducts.length > 0) {
            const matchedComponent = item.KitProducts.find(comp => {
              const componentCode = (comp.Code || '').toUpperCase().trim();
              const componentSku = (comp.Sku || '').toUpperCase().trim();
              const componentPartNumber = (comp.PartNumber || '').toUpperCase().trim();
              return componentCode === normalizedBarcode || 
                     componentSku === normalizedBarcode || 
                     componentPartNumber === normalizedBarcode;
            });
            
            if (matchedComponent) {
              console.log(`[Packing Validation] Kit component match: barcode ${barcode} -> component ${matchedComponent.Sku} (ID: ${matchedComponent.Id}) of kit ${item.Sku}`);
              return res.json({
                valid: true,
                sku: matchedComponent.Sku,
                barcode: barcode,
                title: matchedComponent.Title || 'Kit Component',
                quantity: matchedComponent.Quantity || 1,
                itemId: matchedComponent.Id?.toString() || null,
                saleId: qcSale.SaleId || null,
                isKitComponent: true,
                kitId: item.Id?.toString() || null,
                kitSku: item.Sku || null,
                kitTitle: item.Title || null,
                fallbackValidation: true,
              });
            }
          }
        }
        
        // 4. Fallback: Look up scanned barcode in SkuVault to get its parent SKU
        // This handles cases where the barcode is a variant that maps to a parent product in the order
        console.log(`[Packing Validation] No direct match for ${barcode}, trying product lookup...`);
        try {
          const productLookup = await skuVaultService.getProductByCode(barcode);
          if (productLookup && productLookup.product) {
            const lookupSku = (productLookup.product.Sku || '').toUpperCase().trim();
            
            // Check if the looked-up SKU matches any item in the order
            for (const item of qcSale.Items) {
              const itemSku = (item.Sku || '').toUpperCase().trim();
              
              // Check if lookup SKU matches item SKU
              if (lookupSku === itemSku) {
                console.log(`[Packing Validation] Product lookup match: barcode ${barcode} -> product ${lookupSku} matches order item ${item.Sku}`);
                return res.json({
                  valid: true,
                  sku: item.Sku,
                  barcode: barcode,
                  title: item.Title || 'Unknown Product',
                  quantity: item.Quantity || 1,
                  itemId: item.Id?.toString() || null,
                  saleId: qcSale.SaleId || null,
                  isKitComponent: false,
                  kitId: null,
                  kitSku: null,
                  kitTitle: null,
                  fallbackValidation: true,
                  resolvedFromLookup: true,
                });
              }
              
              // Check if lookup SKU is in the item's AlternateSkus
              if (item.AlternateSkus && item.AlternateSkus.length > 0) {
                const matchedAlt = item.AlternateSkus.find(alt => {
                  const altSku = (alt.Sku || '').toUpperCase().trim();
                  return altSku === lookupSku;
                });
                
                if (matchedAlt) {
                  console.log(`[Packing Validation] Product lookup variant match: barcode ${barcode} -> product ${lookupSku} is variant of order item ${item.Sku}`);
                  return res.json({
                    valid: true,
                    sku: item.Sku,
                    barcode: barcode,
                    title: item.Title || 'Unknown Product',
                    quantity: item.Quantity || 1,
                    itemId: item.Id?.toString() || null,
                    saleId: qcSale.SaleId || null,
                    isKitComponent: false,
                    kitId: null,
                    kitSku: null,
                    kitTitle: null,
                    fallbackValidation: true,
                    variantSku: lookupSku,
                    resolvedFromLookup: true,
                  });
                }
              }
            }
            
            console.log(`[Packing Validation] Product lookup found ${lookupSku} but it doesn't match any order items`);
          }
        } catch (productLookupError: any) {
          console.log(`[Packing Validation] Product lookup failed for ${barcode}:`, productLookupError.message || productLookupError);
        }
        
        // 5. No match found - log what we checked
        const checkedItems = qcSale.Items.map(i => `${i.Sku}(${i.Code})`).join(', ');
        console.log(`[Packing Validation] Barcode ${barcode} not found in QCSale items: ${checkedItems}`);
        
      } catch (lookupError: any) {
        console.error(`[Packing Validation] QCSale lookup failed for order ${orderNumber}:`, lookupError.message || lookupError);
      }
      
      return res.status(404).json({ 
        valid: false, 
        error: "Product not found in order",
        scannedValue: barcode,
        orderNumber,
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

  // Helper function to check if a scanned SKU is a component of a kit SKU
  // Kit pattern: base SKU with -X2, -X3, -X4, etc. suffix (e.g., JCB-POJ-6-16-X2)
  // Component pattern: base SKU without multiplier (e.g., JCB-POJ-6-16)
  function isComponentOfKit(scannedSku: string, kitSku: string): boolean {
    const normalizedScanned = scannedSku.toUpperCase().trim();
    const normalizedKit = kitSku.toUpperCase().trim();
    
    // Check for kit multiplier pattern: -X2, -X3, -X4, -X5, etc.
    const kitMultiplierPattern = /^(.+)-X(\d+)$/;
    const match = normalizedKit.match(kitMultiplierPattern);
    
    if (match) {
      const baseSku = match[1]; // The base SKU without multiplier
      // Check if scanned SKU matches the base SKU of the kit
      if (normalizedScanned === baseSku) {
        console.log(`[Packing QC] Kit match: scanned ${scannedSku} is component of kit ${kitSku}`);
        return true;
      }
    }
    
    return false;
  }

  // Synchronous SkuVault QC scan - verifies item is in order then marks as passed
  // Replaces async queue-based approach for immediate feedback
  app.post("/api/packing/qc-scan", requireAuth, async (req, res) => {
    const userEmail = req.user?.email || "unknown";
    
    // Helper to log SkuVault API calls to shipment_events for troubleshooting
    async function logSkuVaultApiCall(
      eventName: string,
      orderNumber: string,
      apiOperation: string,
      requestData: any,
      responseData: any,
      success: boolean,
      errorMessage?: string
    ) {
      try {
        await storage.createShipmentEvent({
          username: userEmail,
          station: "packing",
          eventName,
          orderNumber,
          metadata: {
            apiOperation,
            request: requestData,
            response: responseData,
            success,
            errorMessage,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (logError) {
        console.error("[Packing QC] Failed to log SkuVault API call:", logError);
      }
    }
    
    try {
      // Extract cached values from frontend (optimization to reduce API calls)
      const { 
        orderNumber, 
        sku, 
        quantity = 1, 
        saleId: cachedSaleId,      // Cached from initial order load
        idItem: cachedIdItem,       // Cached item ID (component ID for kits)
        isKitComponent: cachedIsKitComponent,
        kitId: cachedKitId          // Parent kit's SkuVault ID (for kit component scans)
      } = req.body;
      
      // Validate required fields
      if (!orderNumber || !sku) {
        return res.status(400).json({ 
          success: false, 
          error: "Missing required fields: orderNumber, sku" 
        });
      }
      
      console.log(`[Packing QC] Synchronous QC scan: ${sku} x${quantity} for order ${orderNumber}`);
      
      // OPTIMIZATION: If we have cached SaleId and IdItem, skip the getQCSalesByOrderNumber call
      // This reduces SkuVault API calls from 2 per scan to 1 per scan (~45% reduction)
      // 
      // Cache behavior:
      // - SkuVault-sourced orders: saleId and idItem are populated on order load
      // - ShipStation-only orders: missing SkuVault data triggers fallback lookup
      // 
      // Stale data handling:
      // - SaleId and IdItem are stable identifiers that don't change during order lifecycle
      // - If order is removed from SkuVault QC, passQCItem will fail with error (graceful)
      // - This trade-off is acceptable as order removal is rare during active packing
      let saleId: string | null = cachedSaleId || null;
      let idItem: string | null = cachedIdItem || null;
      let isKitComponentMatch = cachedIsKitComponent || false;
      let kitId: string | null = cachedKitId || null; // Parent kit's SkuVault ID
      
      // Track whether we're using the fast path (cached data) or fallback (fresh lookup)
      // For kit components, we also need kitId for the fast path
      const usingCachedData = !!saleId && !!idItem && (!isKitComponentMatch || !!kitId);
      
      // Only fetch from SkuVault if we don't have cached values
      if (!usingCachedData) {
        console.log(`[Packing QC] No cached data (saleId=${saleId}, idItem=${idItem}), fetching from SkuVault...`);
        
        // Step 1: Get QC sale data to verify item is in order
        // Log the API request
        const getQcSalesRequest = { searchTerm: orderNumber };
        let qcSale: import('@shared/skuvault-types').QCSale | null = null;
        let getQcSalesError: string | undefined;
        
        try {
          qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber);
          
          // Log successful response
          await logSkuVaultApiCall(
            "skuvault_api_getQCSales",
            orderNumber,
            "getQCSalesByOrderNumber",
            getQcSalesRequest,
            qcSale ? {
              SaleId: qcSale.SaleId,
              OrderId: qcSale.OrderId,
              Status: qcSale.Status,
              TotalItems: qcSale.TotalItems,
              PassedItems: qcSale.PassedItems?.length || 0,
              FailedItems: qcSale.FailedItems?.length || 0,
              ItemCount: qcSale.Items?.length || 0,
              Items: qcSale.Items?.map(item => ({
                Id: item.Id,
                Sku: item.Sku,
                Code: item.Code,
                PartNumber: item.PartNumber,
                Quantity: item.Quantity,
                PassedStatus: item.PassedStatus,
                FailedStatus: item.FailedStatus,
              })),
            } : null,
            !!qcSale,
            qcSale ? undefined : "Order not found in SkuVault QC"
          );
        } catch (apiError: any) {
          getQcSalesError = apiError.message || "Unknown error";
          await logSkuVaultApiCall(
            "skuvault_api_getQCSales",
            orderNumber,
            "getQCSalesByOrderNumber",
            getQcSalesRequest,
            null,
            false,
            getQcSalesError
          );
          throw apiError;
        }
        
        if (!qcSale) {
          console.warn(`[Packing QC] Order not found in SkuVault QC: ${orderNumber}`);
          return res.status(404).json({ 
            success: false, 
            error: "Order not found in SkuVault QC system",
            orderNumber
          });
        }
        
        // Extract SaleId
        saleId = qcSale.SaleId || null;
        
        // Step 2: Find the item in expected items by SKU (case-insensitive)
        // Supports:
        // 1. Exact SKU/Code/PartNumber match
        // 2. Kit component barcode match (from KitProducts[].Code array)
        // 3. Legacy kit-component pattern matching (e.g., scanning JCB-POJ-6-16 matches kit JCB-POJ-6-16-X2)
        const normalizedSku = sku.toUpperCase().trim();
        let expectedItem: import('@shared/skuvault-types').QCExpectedItem | undefined;
        let matchedKitComponent: import('@shared/skuvault-types').KitProduct | undefined;
        
        // First try exact match on top-level items
        expectedItem = qcSale.Items?.find(item => {
          const itemSku = (item.Sku || '').toUpperCase().trim();
          const itemCode = (item.Code || '').toUpperCase().trim();
          const itemPartNumber = (item.PartNumber || '').toUpperCase().trim();
          return itemSku === normalizedSku || itemCode === normalizedSku || itemPartNumber === normalizedSku;
        });
        
        // If no exact match, check if this is a kit component barcode
        // Kit components have their barcodes in KitProducts[].Code array
        if (!expectedItem) {
          for (const item of (qcSale.Items || [])) {
            // Only check items that are kits with KitProducts
            if (!item.IsKit || !item.KitProducts || item.KitProducts.length === 0) {
              continue;
            }
            
            // Check if scanned barcode matches any kit component's Code (barcode)
            const component = item.KitProducts.find(comp => {
              const componentCode = (comp.Code || '').toUpperCase().trim();
              const componentSku = (comp.Sku || '').toUpperCase().trim();
              const componentPartNumber = (comp.PartNumber || '').toUpperCase().trim();
              return componentCode === normalizedSku || componentSku === normalizedSku || componentPartNumber === normalizedSku;
            });
            
            if (component) {
              expectedItem = item;
              matchedKitComponent = component;
              isKitComponentMatch = true;
              console.log(`[Packing QC] Matched kit component: scanned ${sku} → component ${component.Sku} (ID: ${component.Id}) of kit ${item.Sku}`);
              break;
            }
          }
        }
        
        // If still no match, try legacy kit-component pattern matching
        // This allows scanning a component barcode (e.g., JCB-POJ-6-16) to match a kit SKU (e.g., JCB-POJ-6-16-X2)
        if (!expectedItem) {
          expectedItem = qcSale.Items?.find(item => {
            const itemSku = item.Sku || '';
            const itemCode = item.Code || '';
            // Check if scanned SKU is a component of any kit SKU in the order
            return isComponentOfKit(normalizedSku, itemSku) || isComponentOfKit(normalizedSku, itemCode);
          });
          
          if (expectedItem) {
            console.log(`[Packing QC] Matched via legacy kit-component pattern: scanned ${sku} → kit ${expectedItem.Sku}`);
          }
        }
        
        if (!expectedItem) {
          console.warn(`[Packing QC] SKU ${sku} not found in order ${orderNumber} (checked exact match and kit-component match)`);
          return res.status(404).json({ 
            success: false, 
            error: `Item ${sku} is not in this order`,
            orderNumber,
            sku
          });
        }
        
        console.log(`[Packing QC] Found item in order:`, {
          sku: expectedItem.Sku,
          code: expectedItem.Code,
          id: expectedItem.Id,
          quantity: expectedItem.Quantity,
          passedStatus: expectedItem.PassedStatus,
          frontendIsKitComponent: cachedIsKitComponent, // What frontend claimed
          fallbackIsKitComponentMatch: isKitComponentMatch, // What fallback determined
          componentId: matchedKitComponent?.Id,
          componentSku: matchedKitComponent?.Sku,
        });
        
        // Get the IdItem and KitId based on whether this is a kit component match
        // Three branches:
        // 1. KIT_COMPONENT: Fallback found kit component via KitProducts - use component data for passKitQCItem
        // 2. KIT_MISMATCH: Frontend claimed kit but fallback couldn't confirm - return error
        // 3. REGULAR_ITEM: Both agree it's a regular item - use item data for passQCItem
        
        if (isKitComponentMatch && matchedKitComponent?.Id) {
          // BRANCH: KIT_COMPONENT - Fallback confirmed kit component via KitProducts match
          idItem = matchedKitComponent.Id;
          kitId = expectedItem.Id || null; // Parent kit's SkuVault ID
          console.log(`[Packing QC] BRANCH: KIT_COMPONENT - componentId=${idItem}, parentKitId=${kitId}, componentSku=${matchedKitComponent.Sku}`);
        } else if (cachedIsKitComponent) {
          // BRANCH: KIT_MISMATCH - Frontend claimed kit component but:
          // a) KitProducts match failed (no matchedKitComponent), or
          // b) Legacy pattern matched parent kit only
          // Return error - don't silently use wrong endpoint
          console.error(`[Packing QC] BRANCH: KIT_MISMATCH - Frontend claimed kit component for SKU=${sku} but fallback couldn't find component data. Matched item: ${expectedItem.Sku}, isKitComponentMatch=${isKitComponentMatch}, hasMatchedComponent=${!!matchedKitComponent}`);
          return res.status(409).json({
            success: false,
            error: "Kit component data mismatch - please refresh order data and try again",
            orderNumber,
            sku,
            requiresRefresh: true,
            details: `Frontend indicated kit component but SkuVault couldn't confirm component data for: ${expectedItem.Sku}`
          });
        } else {
          // BRANCH: REGULAR_ITEM - Frontend said regular item and fallback confirms
          idItem = expectedItem.Id || null;
          kitId = null; // Ensure no stale kit data
          isKitComponentMatch = false; // Ensure consistent state
          console.log(`[Packing QC] BRANCH: REGULAR_ITEM - idItem=${idItem}, sku=${expectedItem.Sku}`);
        }
      } else {
        // Fast path: Using cached SaleId, IdItem, and KitId from frontend
        // This saves 1 SkuVault API call (~45% reduction in API traffic for SkuVault-sourced orders)
        console.log(`[Packing QC] OPTIMIZATION: Using cached data - SaleId=${saleId}, IdItem=${idItem}, KitId=${kitId}, isKit=${isKitComponentMatch}`);
      }
      
      // Validate we have required IDs
      if (!saleId) {
        console.error(`[Packing QC] No SaleId available for order ${orderNumber}`);
        return res.status(500).json({ 
          success: false, 
          error: "Order missing SaleId in SkuVault" 
        });
      }
      
      if (!idItem) {
        console.error(`[Packing QC] No IdItem found for SKU ${sku} in order ${orderNumber}`);
        return res.status(500).json({ 
          success: false, 
          error: "Item missing ID in SkuVault" 
        });
      }
      
      // Log the passQCItem API call
      let result: import('@shared/skuvault-types').QCPassItemResponse;
      
      // Endpoint selection is based on kitId presence - this is the authoritative signal for kit scans
      // kitId is only set when we have confirmed kit component data (from cache or KitProducts match)
      if (kitId) {
        // Kit component scan - use passKitSaleItem endpoint with KitId
        const qcPassKitRequest = {
          KitId: kitId,        // Parent kit's SkuVault ID
          IdItem: idItem,       // Component's SkuVault ID
          IdSale: saleId,
          Quantity: Number(quantity),
          ScannedCode: String(sku),
          SerialNumber: "",
        };
        
        console.log(`[Packing QC] Calling passKitQCItem for kit component:`, qcPassKitRequest);
        
        try {
          result = await skuVaultService.passKitQCItem(qcPassKitRequest);
          
          // Log the response
          await logSkuVaultApiCall(
            "skuvault_api_passKitQCItem",
            orderNumber,
            "passKitQCItem",
            qcPassKitRequest,
            result,
            !!result.Success,
            result.Success ? undefined : (result.Errors?.join(', ') || "Unknown error")
          );
        } catch (apiError: any) {
          await logSkuVaultApiCall(
            "skuvault_api_passKitQCItem",
            orderNumber,
            "passKitQCItem",
            qcPassKitRequest,
            null,
            false,
            apiError.message || "Unknown error"
          );
          throw apiError;
        }
      } else {
        // Regular item scan - use passQCItem endpoint
        const qcPassRequest = {
          IdItem: idItem,
          IdSale: saleId,
          Quantity: Number(quantity),
          ScannedCode: String(sku),
          SerialNumber: "",
        };
        
        console.log(`[Packing QC] Calling passQCItem with:`, qcPassRequest);
        
        try {
          result = await skuVaultService.passQCItem(qcPassRequest);
          
          // Log the response
          await logSkuVaultApiCall(
            "skuvault_api_passQCItem",
            orderNumber,
            "passQCItem",
            qcPassRequest,
            result,
            !!result.Success,
            result.Success ? undefined : (result.Errors?.join(', ') || "Unknown error")
          );
        } catch (apiError: any) {
          await logSkuVaultApiCall(
            "skuvault_api_passQCItem",
            orderNumber,
            "passQCItem",
            qcPassRequest,
            null,
            false,
            apiError.message || "Unknown error"
          );
          throw apiError;
        }
      }
      
      if (result.Success) {
        console.log(`[Packing QC] Successfully passed QC: ${sku} for order ${orderNumber}`);
        
        // Update cache to keep it in sync with SkuVault after successful pass
        // This ensures scan progress persists across page reloads
        updateCacheAfterScan({
          orderNumber,
          sku: String(sku),          // Component/item SKU
          scannedCode: String(sku),  // What was scanned (same as SKU in this flow)
          quantity: Number(quantity),
          itemId: idItem,
          kitId: kitId || undefined,
          userName: userEmail,
        }).catch(err => console.warn(`[Packing QC] Cache update failed (non-blocking):`, err.message));
        
        // Build response with kit info if applicable
        const response: any = { 
          success: true, 
          message: "Item marked as QC passed in SkuVault",
          sku,
          orderNumber,
          quantity: Number(quantity),
        };
        
        // If this was a kit component scan, include parent kit info for UI update
        if (isKitComponentMatch) {
          response.isKitComponent = true;
        }
        
        return res.json(response);
      } else {
        console.warn(`[Packing QC] Failed to pass QC: ${sku} for order ${orderNumber}`, result.Errors);
        return res.status(500).json({ 
          success: false, 
          error: result.Errors?.join(', ') || "Failed to mark item as QC passed in SkuVault",
          sku,
          orderNumber
        });
      }
      
    } catch (error: any) {
      console.error("[Packing QC] Error during synchronous QC scan:", error);
      
      // Handle specific SkuVault errors
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode || 500).json({ 
          success: false, 
          error: error.message,
          skuVaultError: true
        });
      }
      
      res.status(500).json({ 
        success: false, 
        error: "Failed to process QC scan" 
      });
    }
  });

  // Complete order packing
  app.post("/api/packing/complete", requireAuth, async (req, res) => {
    const { shipmentId, skipLabel, skipCacheInvalidation } = req.body;
    const user = req.user!;
    let orderNumber = 'unknown';
    let shipment: Awaited<ReturnType<typeof storage.getShipment>> | null = null;
    let isNotShippable = false; // Track if order is missing MOVE OVER tag
    
    // Station info will be set after webSession is loaded
    let sessionStationId: string | null = null;
    
    // Helper to log packing actions with request/response data
    async function logPackingAction(
      action: string, 
      success: boolean, 
      details: { 
        errorMessage?: string; 
        requestData?: any; 
        responseData?: any;
        sku?: string;
        scannedCode?: string;
      } = {}
    ) {
      try {
        if (!shipment) return; // Can't log without shipment context
        await storage.createPackingLog({
          userId: user.id,
          shipmentId: shipment.id,
          orderNumber: orderNumber,
          action,
          productSku: details.sku || null,
          scannedCode: details.scannedCode || null,
          skuVaultProductId: null,
          success,
          errorMessage: details.errorMessage || null,
          skuVaultRawResponse: details.responseData || details.requestData ? {
            request: details.requestData,
            response: details.responseData,
          } : null,
          station: "boxing", // Boxing workflow uses /api/packing/complete
          stationId: sessionStationId,
        });
      } catch (logError) {
        console.error(`[Packing] Failed to create audit log for action ${action}:`, logError);
      }
    }
    
    try {
      // Get user's current web packing session to get station ID
      const webSession = await storage.getActiveWebPackingSession(user.id);
      if (!webSession) {
        return res.status(400).json({ 
          success: false,
          error: {
            code: 'NO_STATION_SESSION',
            message: 'No active station session',
            resolution: 'Please select a packing station first before completing orders.'
          }
        });
      }
      
      // Set station ID for packing logs
      sessionStationId = webSession.stationId;
      
      // Get printer for this station
      const stationPrinters = await storage.getPrintersByStation(webSession.stationId);
      const selectedPrinter = stationPrinters.length > 0 ? stationPrinters[0] : null;
      
      console.log(`[Packing] Station ${webSession.stationId} printer: ${selectedPrinter?.name || 'none'}`);
      
      // Get shipment
      shipment = await storage.getShipment(shipmentId);
      
      if (!shipment) {
        return res.status(404).json({ 
          success: false,
          error: {
            code: 'SHIPMENT_NOT_FOUND',
            message: 'Shipment not found',
            resolution: 'The shipment may have been deleted. Return to the shipments list to select another order.'
          }
        });
      }
      
      orderNumber = shipment.orderNumber;
      
      // Check if order is shippable (has MOVE OVER tag)
      const shipmentTags = await storage.getShipmentTags(shipment.id);
      const hasMoveOverTag = shipmentTags.some((tag: { name: string }) => tag.name === 'MOVE OVER');
      isNotShippable = !hasMoveOverTag;
      
      // Validate skipLabel is only allowed when order is not shippable
      if (skipLabel && !isNotShippable) {
        console.warn(`[Packing] Rejected skipLabel=true for shippable order ${orderNumber}`);
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_SKIP_LABEL',
            message: 'Cannot skip label for shippable orders',
            resolution: 'This order is ready to ship and requires a label. Complete normally.'
          }
        });
      }
      
      // Log the packing completion attempt
      await logPackingAction('complete_order_start', true, {
        requestData: { 
          shipmentId, 
          stationId: webSession.stationId, 
          hasLabelUrl: !!shipment.labelUrl, 
          hasOrderId: !!shipment.orderId,
          skipLabel: !!skipLabel,
          isNotShippable
        }
      });
      
      // If skipLabel is true (QC-only completion for non-shippable orders), skip label handling entirely
      if (skipLabel && isNotShippable) {
        console.log(`[Packing] Completing QC-only (no label) for non-shippable order ${orderNumber}`);
        
        // Log the QC-only completion
        await logPackingAction('boxing_completed_without_label', true, {
          responseData: { 
            reason: 'Order missing MOVE OVER tag',
            qcOnly: true,
            stationId: webSession.stationId
          }
        });
        
        // Mark QC as completed even for QC-only (no label) completions
        await storage.updateShipment(shipment.id, {
          qcCompleted: true,
          qcCompletedAt: new Date(),
        });
        console.log(`[Packing] Marked QC complete (no label) for shipment ${shipment.id} (order ${orderNumber})`);
        
        return res.json({
          success: true,
          printQueued: false,
          qcOnly: true,
          message: "QC complete! Label not printed - order is not yet shippable (missing MOVE OVER tag).",
          orderNumber: shipment.orderNumber
        });
      }
      
      // If no label URL, try to fetch or create one from ShipStation
      let labelUrl = shipment.labelUrl;
      let trackingNumber = shipment.trackingNumber;
      let labelError: { code: string; message: string; shipStationError?: string; resolution: string } | null = null;
      
      if (!labelUrl && shipment.shipmentId) {
        console.log(`[Packing] Shipment ${shipment.orderNumber} has no label URL - fetching from ShipStation...`);
        
        try {
          // Step 1: Try to fetch existing labels from ShipStation
          await logPackingAction('fetch_existing_labels', true, {
            requestData: { shipStationShipmentId: shipment.shipmentId }
          });
          const existingLabels = await getLabelsForShipment(shipment.shipmentId);
          
          if (existingLabels.length > 0) {
            console.log(`[Packing] Found ${existingLabels.length} existing label(s) in ShipStation`);
            const label = existingLabels[0];
            
            // CRITICAL: Extract PDF format only - SumatraPDF requires PDF, not ZPL
            // The old code used `?.href || label_download` which could return ZPL URLs
            labelUrl = extractPdfLabelUrl(label.label_download);
            trackingNumber = label.tracking_number || trackingNumber;
            
            await logPackingAction('label_fetched_existing', true, {
              responseData: { labelsFound: existingLabels.length, labelUrl, trackingNumber }
            });
            
            if (labelUrl) {
              // Save label URL to database for next time
              await storage.updateShipment(shipment.id, { 
                labelUrl, 
                trackingNumber: trackingNumber || undefined 
              });
              console.log(`[Packing] Saved label URL to shipment: ${labelUrl}`);
            }
          }
          
          // Step 2: If still no label, create one for the existing shipment
          // Use POST /v2/labels/shipment/{shipment_id} - the correct endpoint for existing shipments
          // This attaches a label to the existing shipment without creating duplicates
          if (!labelUrl && shipment.shipmentId) {
            console.log(`[Packing] No existing label found, creating label for existing shipment ${shipment.shipmentId}...`);
            
            await logPackingAction('label_create_attempt', true, {
              requestData: { shipStationShipmentId: shipment.shipmentId, action: 'createLabelForExistingShipment' }
            });
            
            // Always use PDF format - SumatraPDF handles printing for all printers
            const labelData = await createLabelForExistingShipment(shipment.shipmentId, { label_format: 'pdf' });
            
            // Handle dry run mode - returns null when DRY_RUN is enabled
            if (labelData === null) {
              console.log(`[Packing] DRY RUN mode - no label created, skipping print job for ${shipment.orderNumber}`);
              await logPackingAction('label_create_dry_run', true, {
                responseData: { dryRun: true, message: 'Label creation skipped in dry run mode' }
              });
              return res.json({ 
                success: true, 
                printQueued: false,
                dryRun: true,
                message: "DRY RUN: Order complete! Label creation was skipped (dry run mode enabled).",
                orderNumber: shipment.orderNumber
              });
            }
            
            // CRITICAL: Extract PDF format only - use same safe extraction as existing labels
            // We request label_format: 'pdf' but still validate to be safe
            labelUrl = extractPdfLabelUrl(labelData.label_download);
            trackingNumber = labelData.tracking_number || trackingNumber;
            
            await logPackingAction('label_created', !!labelUrl, {
              responseData: { labelUrl, trackingNumber, rawResponse: labelData }
            });
            
            if (labelUrl) {
              await storage.updateShipment(shipment.id, { 
                labelUrl, 
                trackingNumber: trackingNumber || undefined,
                shipmentStatus: 'label_created', // Update status when label is created
              });
              console.log(`[Packing] Created and saved new label: ${labelUrl}, updated shipmentStatus to label_created`);
              
              // CACHE INVALIDATION: For boxing workflow, label created means order is complete
              // For bagging workflow (skipCacheInvalidation=true), we keep the cache until QC scanning is done
              if (shipment.orderNumber && !skipCacheInvalidation) {
                onLabelCreated(shipment.orderNumber).catch(err => {
                  console.warn(`[Packing] Cache invalidation error for ${shipment.orderNumber}:`, err.message);
                });
              } else if (skipCacheInvalidation) {
                console.log(`[Packing] Skipping cache invalidation for ${shipment.orderNumber} (bagging workflow - QC scans pending)`);
              }
            }
          }
        } catch (error: any) {
          console.error(`[Packing] Error fetching/creating label for ${shipment.orderNumber}:`, error.message);
          
          // Parse the ShipStation error to determine the specific issue
          const errorMessage = error.message || 'Unknown error';
          const shipStationError = errorMessage;
          
          // Check for specific error patterns and set appropriate error code/resolution
          if (errorMessage.toLowerCase().includes('on_hold') || 
              errorMessage.toLowerCase().includes('hold_until') ||
              errorMessage.toLowerCase().includes('cannot be shipped') ||
              (shipment.shipmentData as any)?.hold_until_date) {
            labelError = {
              code: 'SHIPMENT_ON_HOLD',
              message: 'This shipment is on hold in ShipStation',
              shipStationError,
              resolution: 'Go to ShipStation, find this order, and remove the hold. Then click Retry below.'
            };
          } else if (errorMessage.includes('rate') || errorMessage.includes('429')) {
            labelError = {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'ShipStation API rate limit reached',
              shipStationError,
              resolution: 'Wait a minute and try again. ShipStation limits how quickly labels can be created.'
            };
          } else if (errorMessage.includes('address') || errorMessage.includes('validation')) {
            labelError = {
              code: 'ADDRESS_VALIDATION_FAILED',
              message: 'The shipping address could not be validated',
              shipStationError,
              resolution: 'Check the shipping address in ShipStation and correct any issues. Then click Retry.'
            };
          } else if (errorMessage.includes('carrier') || errorMessage.includes('service')) {
            labelError = {
              code: 'CARRIER_ERROR',
              message: 'The carrier or shipping service is unavailable',
              shipStationError,
              resolution: 'Check ShipStation to verify the carrier and service are available for this shipment.'
            };
          } else {
            labelError = {
              code: 'LABEL_CREATION_FAILED',
              message: 'Could not create shipping label',
              shipStationError,
              resolution: 'Check ShipStation for more details about this order. The shipment may need to be configured before a label can be created.'
            };
          }
          
          // Log the label creation failure with full error details
          await logPackingAction('label_creation_error', false, {
            errorMessage: labelError.message,
            responseData: { 
              errorCode: labelError.code, 
              shipStationError: labelError.shipStationError,
              resolution: labelError.resolution,
              rawError: error.message,
              stack: error.stack
            }
          });
        }
      }
      
      // If still no label URL after trying to fetch/create
      if (!labelUrl) {
        // Check if shipment is on hold even if we didn't get an error
        const shipmentData = shipment.shipmentData as any;
        if (shipmentData?.hold_until_date) {
          const holdDate = new Date(shipmentData.hold_until_date);
          console.warn(`[Packing] Shipment ${shipment.orderNumber} is on hold until ${holdDate.toISOString()}`);
          labelError = {
            code: 'SHIPMENT_ON_HOLD',
            message: `This shipment is on hold until ${holdDate.toLocaleDateString()}`,
            resolution: 'Go to ShipStation, find this order, and remove the hold. Then click Retry below.'
          };
        }
        
        // Log the failure before returning
        const finalError = labelError || {
          code: 'NO_LABEL_AVAILABLE',
          message: 'Could not get shipping label from ShipStation',
          resolution: 'Check if the shipment exists in ShipStation and is ready to ship. The order may need to be processed first.'
        };
        
        await logPackingAction('complete_order_failed', false, {
          errorMessage: finalError.message,
          responseData: { 
            errorCode: finalError.code,
            resolution: finalError.resolution,
            shipStationError: labelError?.shipStationError 
          }
        });
        
        // Return structured error response
        console.warn(`[Packing] Shipment ${shipment.orderNumber} has no label URL and could not create one`);
        return res.status(422).json({ 
          success: false,
          error: finalError,
          orderNumber: shipment.orderNumber
        });
      }
      
      // Create print job with shipment label URL and station from web session
      // orderId is optional - we can print labels for orders not linked to Shopify
      const printJob = await storage.createPrintJob({
        stationId: webSession.stationId,
        orderId: shipment.orderId || undefined, // Nullable - not all orders are in Shopify
        shipmentId: shipment.id,
        jobType: "label",
        payload: { 
          labelUrl: labelUrl, // Use the fetched/created label URL
          orderNumber: shipment.orderNumber,
          trackingNumber: trackingNumber || shipment.trackingNumber,
          requestedBy: user.displayName || user.email || 'Unknown',
          printerName: selectedPrinter?.name || null, // Printer name for logging/display
        },
        status: "pending", // Start as pending, desktop client will pick it up
        requestedBy: user.id, // Track who created this print job
      });
      
      // Send job to desktop client via WebSocket
      broadcastDesktopPrintJob(webSession.stationId, printJob);
      
      // Also broadcast to browser print queue for visibility
      broadcastPrintQueueUpdate({ 
        type: "job_added", 
        job: printJob 
      });
      
      console.log(`[Packing] Created print job ${printJob.id} for station ${webSession.stationId}`);
      
      // Log successful completion
      await logPackingAction('complete_order_success', true, {
        responseData: { 
          printJobId: printJob.id, 
          stationId: webSession.stationId,
          labelUrl,
          trackingNumber: trackingNumber || shipment.trackingNumber 
        }
      });
      
      // Mark QC as completed (for fast lookup on reprints/re-scans)
      // BOXING ONLY: For bagging workflow (skipCacheInvalidation=true), QC complete is marked
      // in /api/packing/bagging-complete AFTER product scans are done
      if (!skipCacheInvalidation) {
        await storage.updateShipment(shipment.id, {
          qcCompleted: true,
          qcCompletedAt: new Date(),
        });
        console.log(`[Packing] Marked QC complete for shipment ${shipment.id} (order ${orderNumber})`);
      } else {
        console.log(`[Packing] Skipping QC complete mark for ${orderNumber} (bagging workflow - QC scans pending)`);
      }
      
      res.json({ 
        success: true, 
        printQueued: true, 
        printJobId: printJob.id,
        message: "Order complete! Label queued for printing."
      });
    } catch (error: any) {
      console.error("[Packing] Error completing order:", error);
      
      // Log unexpected errors with full context
      if (shipment) {
        await logPackingAction('complete_order_unexpected_error', false, {
          errorMessage: error.message || 'Unknown error',
          responseData: { 
            errorCode: 'UNEXPECTED_ERROR',
            rawError: error.message,
            stack: error.stack
          }
        });
      }
      
      // Return structured error even for unexpected errors
      res.status(500).json({ 
        success: false,
        error: {
          code: 'UNEXPECTED_ERROR',
          message: 'An unexpected error occurred while completing the order',
          resolution: 'Please try again. If the problem persists, contact support with order number: ' + orderNumber
        },
        orderNumber
      });
    }
  });

  // Complete bagging order (QC verification complete - label was already printed on order scan)
  // Logs a single 'packing_completed' event matching boxing station for unified metrics
  app.post("/api/packing/bagging-complete", requireAuth, async (req, res) => {
    const { shipmentId, orderNumber, totalScans, stationId, labelPrintedOnLoad } = req.body;
    const user = req.user!;
    
    try {
      // Validate required fields
      if (!orderNumber) {
        return res.status(400).json({ 
          success: false, 
          error: "Order number is required" 
        });
      }
      
      // Log single packing_completed event (matches boxing station for unified metrics)
      // Use station: "bagging" to differentiate from boxing in analytics
      const event = await storage.createShipmentEvent({
        username: user.email,
        station: "bagging",
        stationId: stationId || null, // Specific workstation ID for reporting
        eventName: "packing_completed",
        orderNumber,
        metadata: {
          shipmentId,
          totalScans: totalScans || 0,
          labelPrintedOnLoad: labelPrintedOnLoad || false,
        },
      });
      
      console.log(`[Bagging] Logged packing_completed event for order ${orderNumber}`);
      
      // Log to packing_logs table for audit trail (matches boxing workflow logging)
      try {
        await storage.createPackingLog({
          userId: user.id,
          shipmentId: shipmentId || null,
          orderNumber,
          action: 'bagging_completed',
          productSku: null,
          scannedCode: null,
          skuVaultProductId: null,
          success: true,
          errorMessage: null,
          skuVaultRawResponse: {
            request: { shipmentId, orderNumber, totalScans, labelPrintedOnLoad },
            response: { eventId: event.id },
          },
          station: "bagging",
          stationId: stationId || null,
        });
        console.log(`[Bagging] Logged packing_log for order ${orderNumber}`);
      } catch (logError) {
        console.error(`[Bagging] Failed to create packing_log for ${orderNumber}:`, logError);
      }
      
      // Mark QC as completed on the shipment (for fast lookup on reprints/re-scans)
      if (shipmentId) {
        await storage.updateShipment(shipmentId, {
          qcCompleted: true,
          qcCompletedAt: new Date(),
        });
        console.log(`[Bagging] Marked QC complete for shipment ${shipmentId} (order ${orderNumber})`);
      }
      
      // BAGGING WORKFLOW: Now that QC is complete, invalidate the warm cache
      // This was deferred from label creation to allow product scans during QC
      if (orderNumber) {
        invalidateCacheForOrder(orderNumber).catch(err => {
          console.warn(`[Bagging] Cache invalidation error for ${orderNumber}:`, err.message);
        });
        console.log(`[Bagging] Invalidated cache for order ${orderNumber} (QC complete)`);
      }
      
      res.json({ 
        success: true, 
        eventId: event.id,
        message: "Bagging complete! QC verification finished."
      });
    } catch (error: any) {
      console.error("[Bagging] Error completing bagging order:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to log bagging completion" 
      });
    }
  });

  // Reprint label for already-packed order
  // Used when order is scanned but was already packed - allows reprinting existing label
  app.post("/api/packing/reprint-label", requireAuth, async (req, res) => {
    try {
      const { shipmentId, orderNumber, station } = req.body;
      const user = req.user!;
      
      if (!shipmentId) {
        return res.status(400).json({ 
          success: false, 
          error: "shipmentId is required" 
        });
      }
      
      // Get shipment to verify it has a label
      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ 
          success: false, 
          error: "Shipment not found" 
        });
      }
      
      // Verify the shipment has a label URL
      if (!shipment.labelUrl) {
        return res.status(422).json({
          success: false,
          error: {
            code: 'NO_LABEL_URL',
            message: 'This order does not have a label URL to reprint',
            resolution: 'The order may not have been properly packed. Try packing it through the normal flow.'
          }
        });
      }
      
      // Get user's current station session
      const webSession = await storage.getActiveWebPackingSession(user.id);
      if (!webSession || !webSession.stationId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'NO_STATION_SESSION',
            message: 'You must select a station before reprinting labels',
            resolution: 'Please select a packing station first.'
          }
        });
      }
      
      // Get the station's printer
      const stationPrinters = await storage.getPrintersByStation(webSession.stationId);
      const selectedPrinter = stationPrinters.length > 0 ? stationPrinters[0] : null;
      
      console.log(`[Packing] Reprint label requested for order ${orderNumber || shipment.orderNumber} at station ${webSession.stationId}`);
      
      // CHECK FOR VOIDED LABEL - If voided, create new label instead of reprinting old one
      // Check database status OR raw shipment data for voided flag
      const isLabelVoided = (): boolean => {
        // Check if our normalized status is 'cancelled'
        if (shipment.status === 'cancelled') {
          return true;
        }
        
        // Check raw ShipStation data for voided labels
        const shipmentData = shipment.shipmentData as any;
        if (shipmentData) {
          // Top-level voided flag
          if (shipmentData.voided === true) {
            return true;
          }
          
          // Check labels array for voided status
          const labels = shipmentData.labels;
          if (Array.isArray(labels) && labels.length > 0) {
            const label = labels[0];
            if (label.voided === true || label.status === 'voided') {
              return true;
            }
          }
        }
        
        return false;
      };
      
      if (isLabelVoided()) {
        console.log(`[Packing] Label is VOIDED for order ${shipment.orderNumber} - creating NEW label instead of reprinting`);
        
        // Get the shipment ID for creating new label on existing shipment
        const shipStationShipmentId = shipment.shipmentId;
        if (!shipStationShipmentId) {
          return res.status(422).json({
            success: false,
            error: {
              code: 'NO_SHIPMENT_ID',
              message: 'Cannot create new label - ShipStation shipment ID is missing',
              resolution: 'Please sync the order from ShipStation and try again.',
              isVoided: true,
            }
          });
        }
        
        console.log(`[Packing] Creating new label for voided shipment ${shipStationShipmentId}...`);
        
        let newLabelUrl: string | null = null;
        let newTrackingNumber: string | null = null;
        
        try {
          // Use createLabelForExistingShipment - takes just the shipment ID
          const labelData = await createLabelForExistingShipment(shipStationShipmentId);
          
          if (!labelData || !labelData.label_download) {
            console.error(`[Packing] ShipStation did not return label data for voided order`);
            return res.status(422).json({
              success: false,
              error: {
                code: 'LABEL_CREATION_FAILED',
                message: 'ShipStation did not return a new label',
                resolution: 'Please check ShipStation for errors and try again.',
                isVoided: true,
              }
            });
          }
          
          newLabelUrl = extractPdfLabelUrl(labelData.label_download);
          newTrackingNumber = labelData.tracking_number || null;
          
          console.log(`[Packing] New label created: ${newLabelUrl}, tracking: ${newTrackingNumber}`);
        } catch (labelError: any) {
          console.error(`[Packing] Failed to create new label for voided order:`, labelError);
          return res.status(422).json({
            success: false,
            error: {
              code: 'LABEL_CREATION_FAILED',
              message: labelError.message || 'Failed to create new label for voided shipment',
              resolution: 'Please check ShipStation for errors and try again.',
              isVoided: true,
            }
          });
        }
        
        if (!newLabelUrl) {
          // ShipStation returned a label but no PDF format - don't mutate shipment
          console.error(`[Packing] New label created but extractPdfLabelUrl returned null - label may only have ZPL/PNG`);
          return res.status(422).json({
            success: false,
            error: {
              code: 'NO_PDF_LABEL',
              message: 'New label was created but no PDF format is available',
              resolution: 'The label may only be available in ZPL or PNG format. Please check ShipStation label settings.',
              isVoided: true,
            }
          });
        }
        
        // Create station-bound print job with new label FIRST (before mutating shipment)
        // This ensures shipment data stays consistent if print job creation fails
        const printJob = await storage.createPrintJob({
          stationId: webSession.stationId,
          orderId: shipment.orderId || undefined,
          shipmentId: shipment.id,
          jobType: "label",
          payload: { 
            labelUrl: newLabelUrl,
            orderNumber: shipment.orderNumber,
            trackingNumber: newTrackingNumber,
            requestedBy: user.displayName || user.email || 'Unknown',
            printerName: selectedPrinter?.name || null,
            isVoidedReplacement: true, // Flag indicating this replaced a voided label
          },
          status: "pending",
          requestedBy: user.id,
        });
        
        // Send job to desktop client via WebSocket
        broadcastDesktopPrintJob(webSession.stationId, printJob);
        
        // Also broadcast to browser print queue for visibility
        broadcastPrintQueueUpdate({ 
          type: "job_added", 
          job: printJob 
        });
        
        // SUCCESS: Now update shipment with new label data (after print job is created)
        await storage.updateShipment(shipment.id, {
          labelUrl: newLabelUrl,
          trackingNumber: newTrackingNumber,
          status: 'shipped', // Reset to shipped status
        });
        console.log(`[Packing] Updated shipment with new label URL and tracking number`);
        
        // Invalidate QC cache for this order (so fresh data is fetched)
        try {
          const { qcSaleCache } = await import("./services/qcsale-cache-warmer");
          await qcSaleCache.invalidate(shipment.orderNumber);
          console.log(`[Packing] Invalidated QC cache for voided order ${shipment.orderNumber}`);
        } catch (err) {
          console.log(`[Packing] Cache invalidation skipped:`, err);
        }
        
        // Log the new label creation (replacing voided label)
        await storage.createShipmentEvent({
          username: user.email,
          station: station || "packing",
          stationId: webSession.stationId,
          eventName: "label_created_after_void",
          orderNumber: shipment.orderNumber,
          metadata: {
            printJobId: printJob.id,
            newLabelUrl: newLabelUrl,
            newTrackingNumber: newTrackingNumber,
            previousTrackingNumber: shipment.trackingNumber,
            previousLabelWasVoided: true,
            requestedBy: user.displayName || user.email,
          },
        });
        
        console.log(`[Packing] Created new label for voided order ${shipment.orderNumber}, print job: ${printJob.id}`);
        
        return res.json({ 
          success: true, 
          printQueued: true, 
          printJobId: printJob.id,
          labelUrl: newLabelUrl,
          trackingNumber: newTrackingNumber,
          wasVoided: true,
          message: "Previous label was voided. New label created and queued for printing."
        });
      }
      
      // Normal reprint flow - label is NOT voided
      // Create print job using existing label URL
      const printJob = await storage.createPrintJob({
        stationId: webSession.stationId,
        orderId: shipment.orderId || undefined,
        shipmentId: shipment.id,
        jobType: "label",
        payload: { 
          labelUrl: shipment.labelUrl,
          orderNumber: shipment.orderNumber,
          trackingNumber: shipment.trackingNumber,
          requestedBy: user.displayName || user.email || 'Unknown',
          printerName: selectedPrinter?.name || null,
          isReprint: true, // Flag to indicate this is a reprint
        },
        status: "pending",
        requestedBy: user.id,
      });
      
      // Send job to desktop client via WebSocket
      broadcastDesktopPrintJob(webSession.stationId, printJob);
      
      // Also broadcast to browser print queue for visibility
      broadcastPrintQueueUpdate({ 
        type: "job_added", 
        job: printJob 
      });
      
      // Log the reprint event
      await storage.createShipmentEvent({
        username: user.email,
        station: station || "packing", // Accept station from request, default to "packing" for backwards compatibility
        stationId: webSession.stationId,
        eventName: "label_reprinted",
        orderNumber: shipment.orderNumber,
        metadata: {
          printJobId: printJob.id,
          labelUrl: shipment.labelUrl,
          trackingNumber: shipment.trackingNumber,
          requestedBy: user.displayName || user.email,
        },
      });
      
      console.log(`[Packing] Created reprint job ${printJob.id} for order ${shipment.orderNumber}`);
      
      res.json({ 
        success: true, 
        printQueued: true, 
        printJobId: printJob.id,
        message: "Label reprint queued successfully."
      });
    } catch (error: any) {
      console.error("[Packing] Error reprinting label:", error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to queue reprint" 
      });
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

  // Excluded Explosion SKUs API endpoints
  app.get("/api/excluded-explosion-skus", requireAuth, async (req, res) => {
    try {
      const skus = await storage.getExcludedExplosionSkus();
      res.json(skus);
    } catch (error: any) {
      console.error("[ExcludedSKUs] Error fetching excluded SKUs:", error);
      res.status(500).json({ error: "Failed to fetch excluded SKUs" });
    }
  });

  app.post("/api/excluded-explosion-skus", requireAuth, async (req, res) => {
    try {
      const { sku, reason } = req.body;
      
      if (!sku || typeof sku !== 'string' || sku.trim() === '') {
        return res.status(400).json({ error: "SKU is required" });
      }
      
      const trimmedSku = sku.trim().toUpperCase();
      const createdBy = req.user!.email || req.user!.id;
      
      const result = await storage.addExcludedExplosionSku(trimmedSku, reason || null, createdBy);
      res.status(201).json(result);
    } catch (error: any) {
      if (error.code === '23505') {
        return res.status(409).json({ error: "SKU already exists in excluded list" });
      }
      console.error("[ExcludedSKUs] Error adding excluded SKU:", error);
      res.status(500).json({ error: "Failed to add excluded SKU" });
    }
  });

  app.delete("/api/excluded-explosion-skus/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid ID" });
      }
      
      const deleted = await storage.deleteExcludedExplosionSku(id);
      if (!deleted) {
        return res.status(404).json({ error: "SKU not found" });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("[ExcludedSKUs] Error deleting excluded SKU:", error);
      res.status(500).json({ error: "Failed to delete excluded SKU" });
    }
  });

  // Reporting API endpoints
  // Returns full snapshot or date-specific data - frontend handles all filtering/sorting locally for instant performance
  app.get("/api/reporting/po-recommendations", requireAuth, async (req, res) => {
    try {
      const dateParam = req.query.date as string | undefined;
      
      let recommendations;
      if (dateParam) {
        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
          return res.status(400).json({ error: "Invalid date format. Expected yyyy-MM-dd" });
        }
        recommendations = await reportingStorage.getRecommendationsByDate(dateParam);
      } else {
        // Default to latest snapshot (cached)
        recommendations = await reportingStorage.getFullSnapshot();
      }
      
      res.json(recommendations);
    } catch (error: any) {
      console.error("[Reporting] Error fetching PO recommendations:", error);
      res.status(500).json({ error: "Failed to fetch PO recommendations" });
    }
  });

  // Get all available stock check dates for the date picker (cached)
  app.get("/api/reporting/po-recommendations/available-dates", requireAuth, async (req, res) => {
    try {
      const dates = await reportingStorage.getAvailableDates();
      res.json({ dates });
    } catch (error: any) {
      console.error("[Reporting] Error fetching available dates:", error);
      res.status(500).json({ error: "Failed to fetch available dates" });
    }
  });

  // Get date bounds (earliest and latest available dates) for validation
  app.get("/api/reporting/po-recommendations/date-bounds", requireAuth, async (req, res) => {
    try {
      const bounds = await reportingStorage.getDateBounds();
      res.json(bounds);
    } catch (error: any) {
      console.error("[Reporting] Error fetching date bounds:", error);
      res.status(500).json({ error: "Failed to fetch date bounds" });
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
        stockCheckDate
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
      const connectedStationIds = getConnectedStationIds();
      
      // Fetch active sessions and printer info for each station
      const stationsWithSessions = await Promise.all(
        stations.map(async (station) => {
          const activeSession = await storage.getActiveSessionByStation(station.id);
          let userName: string | undefined;
          
          if (activeSession) {
            // Get user info for the session
            const user = await storage.getUser(activeSession.userId);
            userName = user?.name || user?.handle || user?.email?.split('@')[0] || undefined;
          }
          
          // Get printer assigned to this station
          const printers = await storage.getPrintersByStation(station.id);
          const selectedPrinter = printers.length > 0 ? printers[0] : null;
          
          return {
            ...station,
            activeSession: activeSession ? {
              id: activeSession.id,
              userId: activeSession.userId,
              userName,
              startedAt: activeSession.startedAt,
              expiresAt: activeSession.expiresAt,
            } : null,
            isConnected: connectedStationIds.includes(station.id),
            printer: selectedPrinter ? {
              id: selectedPrinter.id,
              name: selectedPrinter.name,
              systemName: selectedPrinter.systemName,
              status: selectedPrinter.status || 'offline',
            } : null,
          };
        })
      );
      
      // Calculate connection stats ONLY for active stations (inactive stations are intentionally disabled)
      const activeStations = stationsWithSessions.filter(s => s.isActive);
      const totalActiveStations = activeStations.length;
      const connectedCount = activeStations.filter(s => s.isConnected).length;
      const offlineCount = totalActiveStations - connectedCount;
      
      res.json({ 
        stations: stationsWithSessions,
        connectionStats: {
          total: totalActiveStations,
          connected: connectedCount,
          offline: offlineCount,
        }
      });
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
      
      // Enrich stations with session info (who has claimed them)
      const enrichedStations = await Promise.all(stations.map(async (station) => {
        const activeSession = await storage.getActiveSessionByStation(station.id);
        if (activeSession) {
          // Check if session has expired
          const now = new Date();
          if (activeSession.expiresAt && activeSession.expiresAt < now) {
            // Session has expired, mark it as available
            return {
              ...station,
              claimedBy: null,
              sessionExpiresAt: null,
              sessionExpired: true,
            };
          }
          
          // Get the user who claimed it
          const user = await storage.getUser(activeSession.userId);
          return {
            ...station,
            claimedBy: user?.name || user?.email || 'Unknown user',
            claimedByUserId: activeSession.userId,
            sessionExpiresAt: activeSession.expiresAt,
            sessionExpired: false,
          };
        }
        return {
          ...station,
          claimedBy: null,
          sessionExpiresAt: null,
          sessionExpired: false,
        };
      }));
      
      res.json(enrichedStations);
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
      
      // Broadcast station update to desktop client (updates UI in real-time)
      broadcastDesktopStationUpdated(station.id, station);
      
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
  app.get("/api/desktop/printers", requireDesktopAuth, async (req, res) => {
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
  app.get("/api/desktop/printers/:id", requireDesktopAuth, async (req, res) => {
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
        
        // Broadcast printer update if associated with a station
        if (updated && updated.stationId) {
          broadcastStationPrinterUpdate(updated.stationId, {
            id: updated.id,
            name: updated.name,
            systemName: updated.systemName,
            status: updated.status || 'offline',
          });
        }
        
        return res.json(updated);
      }

      const printer = await storage.createPrinter(data);
      
      // Broadcast printer update if associated with a station
      if (printer.stationId) {
        broadcastStationPrinterUpdate(printer.stationId, {
          id: printer.id,
          name: printer.name,
          systemName: printer.systemName,
          status: printer.status || 'offline',
        });
      }
      
      res.status(201).json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error registering printer:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: "Invalid printer data", details: error.errors });
      }
      res.status(500).json({ error: error.message || "Failed to register printer" });
    }
  });

  // Update a printer (accessible by both web and desktop)
  app.patch("/api/desktop/printers/:id", hybridAuth, async (req, res) => {
    try {
      const printer = await storage.updatePrinter(req.params.id, req.body);
      if (!printer) {
        return res.status(404).json({ error: "Printer not found" });
      }
      
      // Broadcast printer update if associated with a station
      if (printer.stationId) {
        broadcastStationPrinterUpdate(printer.stationId, {
          id: printer.id,
          name: printer.name,
          systemName: printer.systemName,
          status: printer.status || 'offline',
        });
      }
      
      res.json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error updating printer:", error);
      res.status(500).json({ error: error.message || "Failed to update printer" });
    }
  });

  // Delete a printer
  app.delete("/api/desktop/printers/:id", requireDesktopAuth, async (req, res) => {
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

  // Set default printer for a station
  app.post("/api/desktop/stations/:stationId/printers/:printerId/default", requireDesktopAuth, async (req, res) => {
    try {
      const { stationId, printerId } = req.params;
      
      // Verify the station exists
      const station = await storage.getStation(stationId);
      if (!station) {
        return res.status(404).json({ error: "Station not found" });
      }
      
      // Set the default printer (atomically clears other defaults)
      const printer = await storage.setDefaultPrinter(stationId, printerId);
      if (!printer) {
        return res.status(404).json({ error: "Printer not found or not assigned to this station" });
      }
      
      // Broadcast the printer update to all clients watching this station
      broadcastStationPrinterUpdate(stationId, {
        id: printer.id,
        name: printer.name,
        systemName: printer.systemName,
        status: printer.status || 'offline',
        isDefault: true,
      });
      
      console.log(`[Desktop] Set default printer for station ${stationId}: ${printer.name} (${printer.id})`);
      
      res.json(printer);
    } catch (error: any) {
      console.error("[Desktop] Error setting default printer:", error);
      res.status(500).json({ error: error.message || "Failed to set default printer" });
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
      } else if (googleData.name && user.name !== googleData.name) {
        // Update user name if it changed in Google
        await storage.updateUser(user.id, { name: googleData.name });
        user.name = googleData.name;
      }

      // Generate tokens
      const accessToken = randomBytes(32).toString('hex');
      const refreshToken = randomBytes(32).toString('hex');
      const now = new Date();
      const accessTokenExpiry = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20 hours
      const refreshTokenExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

      // Check if desktop client already exists for this user+device (preserve session ownership)
      let client = await storage.getDesktopClientByUserAndDevice(user.id, deviceName);
      
      if (client) {
        // Reuse existing client - just update tokens (keeps session ownership intact!)
        console.log(`[Desktop] Reusing existing client ${client.id} for ${email} on ${deviceName}`);
        client = await storage.updateDesktopClient(client.id, {
          accessTokenHash: hashToken(accessToken),
          refreshTokenHash: hashToken(refreshToken),
          accessTokenExpiresAt: accessTokenExpiry,
          refreshTokenExpiresAt: refreshTokenExpiry,
          lastIp: req.ip || req.socket.remoteAddress,
          lastActiveAt: now,
        }) as typeof client;
      } else {
        // Create new desktop client
        const clientId = randomBytes(16).toString('hex');
        console.log(`[Desktop] Creating new client ${clientId} for ${email} on ${deviceName}`);
        client = await storage.createDesktopClient({
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
      }

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
  // Supports forceClaim=true to override an existing session (reclaim)
  app.post("/api/desktop/sessions/claim", requireDesktopAuth, async (req, res) => {
    try {
      const { stationId, forceClaim } = req.body;
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
      }, client.id, !!forceClaim);

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

      const rawJobs = pendingOnly
        ? await storage.getPendingJobsByStation(session.stationId, limit)
        : await storage.getJobsByStation(session.stationId, limit);

      // Transform jobs for desktop client compatibility
      const jobs = rawJobs.map(transformPrintJobForDesktop);

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
      const job = await storage.createPrintJob({
        ...data,
        requestedBy: req.user!.id, // Track who created this print job
      });
      
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
      res.json(transformPrintJobForDesktop(job));
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
      
      // Immediately recalculate and broadcast stale job metrics (instant UI update)
      refreshStaleJobsMetrics().catch(err => console.error("[Print Queue] Error refreshing stale metrics:", err));
      
      res.json(transformPrintJobForDesktop(job));
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
      
      // Immediately recalculate and broadcast stale job metrics (instant UI update)
      refreshStaleJobsMetrics().catch(err => console.error("[Print Queue] Error refreshing stale metrics:", err));
      
      res.json(transformPrintJobForDesktop(job));
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
      res.json(transformPrintJobForDesktop(job));
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
      res.json(transformPrintJobForDesktop(job));
    } catch (error: any) {
      console.error("[Desktop] Error cancelling print job:", error);
      res.status(500).json({ error: error.message || "Failed to cancel print job" });
    }
  });

  // ============================================================================
  // DESKTOP CONFIGURATION ENDPOINTS - "Mars rover" remote control
  // ============================================================================

  // Get current desktop configuration (accessible by web and desktop clients)
  app.get("/api/desktop/config", hybridAuth, async (req, res) => {
    try {
      const config = await storage.getDesktopConfig();
      res.json(config);
    } catch (error: any) {
      console.error("[Desktop] Error fetching config:", error);
      res.status(500).json({ error: error.message || "Failed to fetch desktop configuration" });
    }
  });

  // Update desktop configuration (web admin only) - broadcasts update to all connected desktop clients
  app.patch("/api/desktop/config", requireAuth, async (req, res) => {
    try {
      const { 
        connectionTimeout, 
        baseReconnectDelay, 
        maxReconnectDelay, 
        heartbeatInterval, 
        reconnectInterval, 
        tokenRefreshInterval, 
        offlineTimeout 
      } = req.body;

      // Minimum values to prevent infinite loops and broken connectivity
      const MIN_VALUES = {
        connectionTimeout: 5000,      // 5 seconds minimum
        baseReconnectDelay: 1000,     // 1 second minimum
        maxReconnectDelay: 5000,      // 5 seconds minimum
        heartbeatInterval: 10000,     // 10 seconds minimum
        reconnectInterval: 1000,      // 1 second minimum
        tokenRefreshInterval: 300000, // 5 minutes minimum
        offlineTimeout: 500,          // 0.5 seconds minimum
      };

      // Validate and build update object with only provided fields
      const updates: Record<string, number> = {};
      const errors: string[] = [];

      if (typeof connectionTimeout === 'number') {
        if (connectionTimeout < MIN_VALUES.connectionTimeout) {
          errors.push(`connectionTimeout must be at least ${MIN_VALUES.connectionTimeout}ms`);
        } else {
          updates.connectionTimeout = connectionTimeout;
        }
      }
      if (typeof baseReconnectDelay === 'number') {
        if (baseReconnectDelay < MIN_VALUES.baseReconnectDelay) {
          errors.push(`baseReconnectDelay must be at least ${MIN_VALUES.baseReconnectDelay}ms`);
        } else {
          updates.baseReconnectDelay = baseReconnectDelay;
        }
      }
      if (typeof maxReconnectDelay === 'number') {
        if (maxReconnectDelay < MIN_VALUES.maxReconnectDelay) {
          errors.push(`maxReconnectDelay must be at least ${MIN_VALUES.maxReconnectDelay}ms`);
        } else {
          updates.maxReconnectDelay = maxReconnectDelay;
        }
      }
      if (typeof heartbeatInterval === 'number') {
        if (heartbeatInterval < MIN_VALUES.heartbeatInterval) {
          errors.push(`heartbeatInterval must be at least ${MIN_VALUES.heartbeatInterval}ms`);
        } else {
          updates.heartbeatInterval = heartbeatInterval;
        }
      }
      if (typeof reconnectInterval === 'number') {
        if (reconnectInterval < MIN_VALUES.reconnectInterval) {
          errors.push(`reconnectInterval must be at least ${MIN_VALUES.reconnectInterval}ms`);
        } else {
          updates.reconnectInterval = reconnectInterval;
        }
      }
      if (typeof tokenRefreshInterval === 'number') {
        if (tokenRefreshInterval < MIN_VALUES.tokenRefreshInterval) {
          errors.push(`tokenRefreshInterval must be at least ${MIN_VALUES.tokenRefreshInterval}ms`);
        } else {
          updates.tokenRefreshInterval = tokenRefreshInterval;
        }
      }
      if (typeof offlineTimeout === 'number') {
        if (offlineTimeout < MIN_VALUES.offlineTimeout) {
          errors.push(`offlineTimeout must be at least ${MIN_VALUES.offlineTimeout}ms`);
        } else {
          updates.offlineTimeout = offlineTimeout;
        }
      }

      // Return validation errors if any
      if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid configuration fields provided" });
      }

      // Get user ID from session (web auth)
      const userId = (req as any).user?.id;
      const config = await storage.updateDesktopConfig(updates, userId);

      // Broadcast the update to all connected desktop clients
      broadcastDesktopConfigUpdate({
        connectionTimeout: config.connectionTimeout,
        baseReconnectDelay: config.baseReconnectDelay,
        maxReconnectDelay: config.maxReconnectDelay,
        heartbeatInterval: config.heartbeatInterval,
        reconnectInterval: config.reconnectInterval,
        tokenRefreshInterval: config.tokenRefreshInterval,
        offlineTimeout: config.offlineTimeout,
      });

      console.log(`[Desktop] Config updated by user ${userId}:`, updates);
      res.json(config);
    } catch (error: any) {
      console.error("[Desktop] Error updating config:", error);
      res.status(500).json({ error: error.message || "Failed to update desktop configuration" });
    }
  });

  // ========================================
  // Product Collections API
  // ========================================

  // Get distinct product categories from skuvault_products for dropdown
  app.get("/api/collections/categories", requireAuth, async (req, res) => {
    try {
      const { skuvaultProducts } = await import("@shared/schema");
      const categories = await db
        .selectDistinct({ category: skuvaultProducts.productCategory })
        .from(skuvaultProducts)
        .where(sql`${skuvaultProducts.productCategory} IS NOT NULL AND ${skuvaultProducts.productCategory} != ''`)
        .orderBy(skuvaultProducts.productCategory);
      
      res.json({ categories: categories.map(c => c.category).filter(Boolean) });
    } catch (error: any) {
      console.error("[Collections] Error fetching categories:", error);
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  });

  // Get all collections with product counts
  // Supports optional ?search= query param to filter by collection name, description, category, or product SKU/name/barcode
  app.get("/api/collections", requireAuth, async (req, res) => {
    try {
      const search = req.query.search as string | undefined;
      const collections = await storage.getProductCollections(search);
      res.json({ collections });
    } catch (error: any) {
      console.error("[Collections] Error fetching collections:", error);
      res.status(500).json({ error: "Failed to fetch collections" });
    }
  });

  // Get a single collection with its products
  app.get("/api/collections/:id/products", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const collection = await storage.getProductCollection(id);
      if (!collection) {
        return res.status(404).json({ error: "Collection not found" });
      }
      const mappings = await storage.getProductCollectionMappings(id);
      res.json({ collection, mappings });
    } catch (error: any) {
      console.error("[Collections] Error fetching collection products:", error);
      res.status(500).json({ error: "Failed to fetch collection products" });
    }
  });

  // Create a new collection
  // If productCategory is provided, automatically adds all matching products to the collection
  app.post("/api/collections", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const { name, description, incrementalQuantity, productCategory } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: "Collection name is required" });
      }
      
      const trimmedCategory = productCategory?.trim() || null;
      
      const collection = await storage.createProductCollection({
        name: name.trim(),
        description: description?.trim() || null,
        incrementalQuantity: incrementalQuantity != null ? parseInt(incrementalQuantity, 10) : null,
        productCategory: trimmedCategory,
        createdBy: userId,
        updatedBy: userId,
      });
      
      // If a productCategory was specified, automatically add all matching products
      if (trimmedCategory) {
        const { skuvaultProducts } = await import("@shared/schema");
        
        // Find all products matching the category
        const matchingProducts = await db
          .select({ sku: skuvaultProducts.sku })
          .from(skuvaultProducts)
          .where(eq(skuvaultProducts.productCategory, trimmedCategory));
        
        if (matchingProducts.length > 0) {
          const skus = matchingProducts.map(p => p.sku);
          console.log(`[Collections] Auto-adding ${skus.length} products with category "${trimmedCategory}" to collection "${name}"`);
          
          // Add all matching products to the collection
          await storage.addProductsToCollection(collection.id, skus, userId);
        }
      }
      
      res.status(201).json(collection);
    } catch (error: any) {
      console.error("[Collections] Error creating collection:", error);
      
      // Handle conflict error when auto-adding products that are already assigned
      if (error.code === 'PRODUCTS_ALREADY_ASSIGNED' && error.conflicts) {
        return res.status(409).json({ 
          error: "Some products are already assigned to other collections",
          code: error.code,
          conflicts: error.conflicts
        });
      }
      
      res.status(500).json({ error: "Failed to create collection" });
    }
  });

  // Update a collection
  app.patch("/api/collections/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;
      const { name, description, incrementalQuantity, productCategory } = req.body;
      const updateData: any = { updatedBy: userId };
      if (name !== undefined) updateData.name = name?.trim();
      if (description !== undefined) updateData.description = description?.trim() || null;
      if (incrementalQuantity !== undefined) updateData.incrementalQuantity = incrementalQuantity != null ? parseInt(incrementalQuantity, 10) : null;
      if (productCategory !== undefined) updateData.productCategory = productCategory?.trim() || null;
      
      const collection = await storage.updateProductCollection(id, updateData);
      if (!collection) {
        return res.status(404).json({ error: "Collection not found" });
      }
      res.json(collection);
    } catch (error: any) {
      console.error("[Collections] Error updating collection:", error);
      res.status(500).json({ error: "Failed to update collection" });
    }
  });

  // Delete a collection - blocked if products still assigned
  app.delete("/api/collections/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Step 0: Check if any products are assigned to this collection
      const mappings = await storage.getProductCollectionMappings(id);
      if (mappings.length > 0) {
        return res.status(400).json({ 
          error: "Cannot delete collection with products assigned",
          message: `This collection still has ${mappings.length} product(s) assigned. Remove all products from the collection before deleting it.`,
          productCount: mappings.length
        });
      }
      
      const { fingerprints, fingerprintModels, shipments: shipmentsTable } = await import("@shared/schema");
      
      // Step 1: Find all fingerprints that reference this collection ID in their signature
      // Fingerprint signatures are JSON objects like {"collectionId": count, ...}
      const affectedFingerprints = await db
        .select({ id: fingerprints.id })
        .from(fingerprints)
        .where(sql`${fingerprints.signature}::text LIKE ${'%"' + id + '"%'}`);
      
      const affectedFingerprintIds = affectedFingerprints.map(f => f.id);
      
      if (affectedFingerprintIds.length > 0) {
        // Step 2: Reset shipments linked to affected fingerprints to needs_recalc
        const resetResult = await db
          .update(shipmentsTable)
          .set({ 
            fingerprintStatus: 'needs_recalc',
            fingerprintId: null,
            packagingTypeId: null,
            assignedStationId: null,
            packagingDecisionType: null,
          })
          .where(sql`${shipmentsTable.fingerprintId} IN (${sql.raw(affectedFingerprintIds.map(id => `'${id}'`).join(','))})`);
        
        // Step 3: Delete fingerprint_models for affected fingerprints
        await db
          .delete(fingerprintModels)
          .where(sql`${fingerprintModels.fingerprintId} IN (${sql.raw(affectedFingerprintIds.map(id => `'${id}'`).join(','))})`);
        
        // Step 4: Delete the affected fingerprints
        await db
          .delete(fingerprints)
          .where(sql`${fingerprints.id} IN (${sql.raw(affectedFingerprintIds.map(id => `'${id}'`).join(','))})`);
        
        console.log(`[Collections] Cascade delete: invalidated ${affectedFingerprintIds.length} fingerprints for collection ${id}`);
      }
      
      // Step 5: Delete the collection itself
      const deleted = await storage.deleteProductCollection(id);
      if (!deleted) {
        return res.status(404).json({ error: "Collection not found" });
      }
      
      res.json({ 
        success: true, 
        cascade: {
          fingerprintsInvalidated: affectedFingerprintIds.length
        }
      });
    } catch (error: any) {
      console.error("[Collections] Error deleting collection:", error);
      res.status(500).json({ error: "Failed to delete collection" });
    }
  });

  // Add products to a collection
  app.post("/api/collections/:id/products", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req as any).user?.id;
      const { skus } = req.body;
      if (!Array.isArray(skus) || skus.length === 0) {
        return res.status(400).json({ error: "SKUs array is required" });
      }
      const mappings = await storage.addProductsToCollection(id, skus, userId);
      
      // Invalidate fingerprints for shipments containing these SKUs
      const { onCollectionChanged } = await import('./services/qc-item-hydrator');
      const invalidationResult = await onCollectionChanged(skus);
      console.log(`[Collections] Added ${mappings.length} products, invalidated ${invalidationResult.shipmentsInvalidated} shipments`);
      
      res.status(201).json({ mappings, added: mappings.length, shipmentsInvalidated: invalidationResult.shipmentsInvalidated });
    } catch (error: any) {
      // Handle products already assigned to other collections
      if (error.code === 'PRODUCTS_ALREADY_ASSIGNED') {
        console.log(`[Collections] Rejected adding products - ${error.conflicts.length} already assigned to other collections`);
        return res.status(409).json({
          error: "Products already assigned to other collections",
          code: "PRODUCTS_ALREADY_ASSIGNED",
          conflicts: error.conflicts,
        });
      }
      console.error("[Collections] Error adding products to collection:", error);
      res.status(500).json({ error: "Failed to add products to collection" });
    }
  });

  // Remove a product from a collection
  app.delete("/api/collections/:collectionId/products/:mappingId", requireAuth, async (req, res) => {
    try {
      const { mappingId } = req.params;
      const deleted = await storage.removeProductFromCollection(mappingId);
      if (!deleted) {
        return res.status(404).json({ error: "Mapping not found" });
      }
      
      // Invalidate fingerprints for shipments containing this SKU
      const { onCollectionChanged } = await import('./services/qc-item-hydrator');
      const invalidationResult = await onCollectionChanged([deleted.sku]);
      console.log(`[Collections] Removed product ${deleted.sku}, invalidated ${invalidationResult.shipmentsInvalidated} shipments`);
      
      res.json({ success: true, shipmentsInvalidated: invalidationResult.shipmentsInvalidated });
    } catch (error: any) {
      console.error("[Collections] Error removing product from collection:", error);
      res.status(500).json({ error: "Failed to remove product from collection" });
    }
  });

  // Get pending fingerprint count for recalculation status
  // Also returns count of uncategorized products blocking those shipments
  app.get("/api/collections/pending-fingerprints", requireAuth, async (req, res) => {
    try {
      const { shipments: shipmentsTable } = await import("@shared/schema");
      
      // Get pending shipment count
      const pendingResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(shipmentsTable)
        .where(eq(shipmentsTable.fingerprintStatus, 'pending_categorization'));
      
      const pendingCount = Number(pendingResult[0]?.count || 0);
      
      // Get count of unique uncategorized products blocking those shipments
      let uncategorizedProductCount = 0;
      if (pendingCount > 0) {
        const uncategorizedResult = await db.execute(sql`
          WITH pending_shipments AS (
            SELECT id FROM shipments WHERE fingerprint_status = 'pending_categorization'
          )
          SELECT COUNT(DISTINCT qc.sku) as count
          FROM shipment_qc_items qc
          INNER JOIN pending_shipments ps ON qc.shipment_id = ps.id
          LEFT JOIN product_collection_mappings pcm ON qc.sku = pcm.sku
          WHERE pcm.id IS NULL
        `);
        uncategorizedProductCount = Number((uncategorizedResult.rows?.[0] as any)?.count) || 0;
      }
      
      res.json({ pendingCount, uncategorizedProductCount });
    } catch (error: any) {
      console.error("[Collections] Error fetching pending fingerprint count:", error);
      res.status(500).json({ error: "Failed to fetch pending count" });
    }
  });

  // Bulk recalculate fingerprints for all pending shipments
  app.post("/api/collections/recalculate-fingerprints", requireAuth, async (req, res) => {
    try {
      const { shipments: shipmentsTable } = await import("@shared/schema");
      const { calculateFingerprint } = await import('./services/qc-item-hydrator');
      
      // Get all shipments with pending_categorization status
      const pendingShipments = await db
        .select({ id: shipmentsTable.id })
        .from(shipmentsTable)
        .where(eq(shipmentsTable.fingerprintStatus, 'pending_categorization'))
        .limit(1000); // Process in batches to avoid timeout
      
      let processed = 0;
      let completed = 0;
      let stillPending = 0;
      let errors = 0;
      
      for (const shipment of pendingShipments) {
        try {
          const result = await calculateFingerprint(shipment.id);
          processed++;
          if (result.status === 'complete') {
            completed++;
          } else if (result.status === 'pending_categorization') {
            stillPending++;
          }
        } catch (err) {
          console.error(`[Collections] Error recalculating fingerprint for shipment ${shipment.id}:`, err);
          errors++;
        }
      }
      
      console.log(`[Collections] Bulk recalculation: processed ${processed}, completed ${completed}, still pending ${stillPending}, errors ${errors}`);
      
      res.json({
        success: true,
        processed,
        completed,
        stillPending,
        errors,
        hasMore: pendingShipments.length === 1000
      });
    } catch (error: any) {
      console.error("[Collections] Error bulk recalculating fingerprints:", error);
      res.status(500).json({ error: "Failed to recalculate fingerprints" });
    }
  });

  // Hydrate a single shipment (for testing excluded SKUs)
  app.post("/api/collections/hydrate-shipment", requireAuth, async (req, res) => {
    try {
      const { shipmentId } = req.body;
      if (!shipmentId) {
        return res.status(400).json({ error: "shipmentId is required" });
      }
      
      const { hydrateShipment } = await import('./services/qc-item-hydrator');
      
      // Get the order number
      const shipmentData = await db
        .select({ orderNumber: shipments.orderNumber })
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);
      
      if (!shipmentData[0]) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      const result = await hydrateShipment(shipmentId, shipmentData[0].orderNumber || 'unknown');
      
      console.log(`[Collections] Hydrated shipment ${shipmentId}:`, result);
      
      res.json({
        success: true,
        ...result
      });
    } catch (error: any) {
      console.error("[Collections] Error hydrating shipment:", error);
      res.status(500).json({ error: "Failed to hydrate shipment" });
    }
  });

  // Complete reset and recalculate ALL fingerprints
  // This performs a FULL RESET of the fulfillment prep workflow:
  // 1. Clears all fingerprint/packaging/station assignments from shipments
  // 2. Deletes all fingerprints, fingerprint_models, and shipment_qc_items
  // 3. Re-hydrates QC items from shipment_items (with kit explosion)
  // 4. Recalculates fingerprints based on existing product_collection_mappings
  app.post("/api/collections/recalculate-all-fingerprints", requireAuth, async (req, res) => {
    try {
      const { shipments: shipmentsTable, shipmentQcItems, fingerprints, fingerprintModels } = await import("@shared/schema");
      const { hydrateShipment } = await import('./services/qc-item-hydrator');
      
      console.log(`[Collections] Starting COMPLETE RESET of fulfillment prep workflow...`);
      
      // ========== PHASE 1: COMPLETE RESET ==========
      
      // Step 1a: Reset all shipments to pending state
      const resetResult = await db
        .update(shipmentsTable)
        .set({
          fingerprintStatus: 'pending_categorization',
          fingerprintId: null,
          decisionSubphase: 'needs_categorization',
          packagingTypeId: null,
          assignedStationId: null,
        })
        .where(
          or(
            isNotNull(shipmentsTable.fingerprintStatus),
            isNotNull(shipmentsTable.decisionSubphase),
            isNotNull(shipmentsTable.packagingTypeId),
            isNotNull(shipmentsTable.assignedStationId)
          )
        );
      
      // Count how many shipments were reset
      const [resetCount] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(shipmentsTable)
        .where(eq(shipmentsTable.fingerprintStatus, 'pending_categorization'));
      
      console.log(`[Collections] Reset ${resetCount?.count || 0} shipments to pending_categorization`);
      
      // Step 1b: Delete all shipment_qc_items (will be re-hydrated)
      await db.delete(shipmentQcItems);
      console.log(`[Collections] Deleted all shipment_qc_items`);
      
      // Step 1c: Delete all fingerprint models
      await db.delete(fingerprintModels);
      console.log(`[Collections] Deleted all fingerprint_models`);
      
      // Step 1d: Delete all fingerprints
      await db.delete(fingerprints);
      console.log(`[Collections] Deleted all fingerprints`);
      
      // ========== PHASE 2: HYDRATE AND RECALCULATE ==========
      
      let totalProcessed = 0;
      let totalCompleted = 0;
      let totalStillPending = 0;
      let totalErrors = 0;
      let totalItemsCreated = 0;
      let batchNumber = 0;
      const BATCH_SIZE = 500;
      
      console.log(`[Collections] Starting QC item hydration and fingerprint calculation...`);
      
      // Loop until we've processed everything
      while (true) {
        batchNumber++;
        
        // Get next batch of shipments that need processing (include orderNumber for hydrateShipment)
        const batchShipments = await db
          .select({ id: shipmentsTable.id, orderNumber: shipmentsTable.orderNumber })
          .from(shipmentsTable)
          .where(eq(shipmentsTable.fingerprintStatus, 'pending_categorization'))
          .limit(BATCH_SIZE);
        
        if (batchShipments.length === 0) {
          console.log(`[Collections] No more shipments to process. Done!`);
          break;
        }
        
        console.log(`[Collections] Batch ${batchNumber}: Processing ${batchShipments.length} shipments...`);
        
        for (const shipment of batchShipments) {
          try {
            // hydrateShipment creates QC items AND calculates fingerprint in one call
            const result = await hydrateShipment(shipment.id, shipment.orderNumber || 'unknown');
            totalProcessed++;
            totalItemsCreated += result.itemsCreated;
            
            if (result.error) {
              // Shipment had an issue but wasn't a complete failure
              totalStillPending++;
            } else if (result.fingerprintStatus === 'complete') {
              totalCompleted++;
            } else if (result.fingerprintStatus === 'pending_categorization') {
              totalStillPending++;
            } else {
              // No items found or other reason
              totalStillPending++;
            }
          } catch (err) {
            console.error(`[Collections] Error hydrating shipment ${shipment.id}:`, err);
            totalErrors++;
            totalProcessed++;
          }
        }
        
        console.log(`[Collections] Batch ${batchNumber} complete. Running totals: ${totalProcessed} processed, ${totalCompleted} completed, ${totalStillPending} pending, ${totalErrors} errors`);
      }
      
      console.log(`[Collections] COMPLETE RESET AND RECALCULATION DONE: ${totalProcessed} shipments processed, ${totalCompleted} completed, ${totalStillPending} pending, ${totalErrors} errors, ${totalItemsCreated} QC items created`);
      
      res.json({
        success: true,
        shipmentsReset: resetCount?.count || 0,
        processed: totalProcessed,
        completed: totalCompleted,
        stillPending: totalStillPending,
        errors: totalErrors,
        itemsCreated: totalItemsCreated,
        batches: batchNumber
      });
    } catch (error: any) {
      console.error("[Collections] Error in complete reset:", error);
      res.status(500).json({ error: "Failed to reset and recalculate fingerprints" });
    }
  });

  // Manual kit mappings sync from GCP (full two-way sync)
  app.post("/api/kit-mappings/refresh", requireAuth, async (req, res) => {
    try {
      const { syncKitMappingsFromGcp, getKitCacheStats } = await import('./services/kit-mappings-cache');
      
      console.log(`[kit-mappings] Manual sync triggered by user`);
      
      const beforeStats = getKitCacheStats();
      console.log(`[kit-mappings] Before sync: ${beforeStats.kitCount} kits`);
      
      const syncResult = await syncKitMappingsFromGcp();
      
      const afterStats = getKitCacheStats();
      console.log(`[kit-mappings] After sync: ${afterStats.kitCount} kits`);
      
      res.json({
        success: !syncResult.error,
        syncResult,
        before: { kitCount: beforeStats.kitCount },
        after: { kitCount: afterStats.kitCount },
      });
    } catch (error: any) {
      console.error("[kit-mappings] Error syncing:", error);
      res.status(500).json({ error: "Failed to sync kit mappings from GCP" });
    }
  });

  // Get kit mappings cache status
  app.get("/api/kit-mappings/status", requireAuth, async (req, res) => {
    try {
      const { getKitCacheStats, getAllKitMappings } = await import('./services/kit-mappings-cache');
      const stats = getKitCacheStats();
      const allMappings = getAllKitMappings();
      
      res.json({
        kitCount: stats.kitCount,
        snapshotTimestamp: stats.snapshotTimestamp,
        sampleKits: allMappings ? Array.from(allMappings.keys()).slice(0, 10) : [],
      });
    } catch (error: any) {
      console.error("[kit-mappings] Error getting status:", error);
      res.status(500).json({ error: "Failed to get kit mappings status" });
    }
  });

  // Repair shipments with un-exploded kit SKUs
  // This fixes shipments where kits weren't properly exploded during hydration
  // (e.g., due to stale cache or race conditions)
  app.post("/api/collections/repair-unexploded-kits", requireAuth, async (req, res) => {
    try {
      const { repairUnexplodedKits } = await import('./services/qc-item-hydrator');
      const limit = parseInt(req.query.limit as string) || 50;
      
      console.log(`[Collections] Starting repair of un-exploded kits (limit: ${limit})`);
      
      const result = await repairUnexplodedKits(limit);
      
      console.log(`[Collections] Repair complete: ${result.shipmentsRepaired} repaired, ${result.shipmentsSkipped} skipped`);
      
      res.json({
        success: true,
        shipmentsRepaired: result.shipmentsRepaired,
        shipmentsSkipped: result.shipmentsSkipped,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error("[Collections] Error repairing un-exploded kits:", error);
      res.status(500).json({ error: "Failed to repair un-exploded kits" });
    }
  });

  // Repair shipments with un-substituted variant SKUs
  // This fixes shipments where variants weren't properly substituted with parent SKUs
  // (e.g., due to race condition during product catalog sync)
  app.post("/api/collections/repair-unsubstituted-variants", requireAuth, async (req, res) => {
    try {
      const { repairUnsubstitutedVariants } = await import('./services/qc-item-hydrator');
      const limit = parseInt(req.query.limit as string) || 50;
      
      console.log(`[Collections] Starting repair of un-substituted variants (limit: ${limit})`);
      
      const result = await repairUnsubstitutedVariants(limit);
      
      console.log(`[Collections] Variant repair complete: ${result.shipmentsRepaired} repaired, ${result.shipmentsSkipped} skipped`);
      
      res.json({
        success: true,
        shipmentsRepaired: result.shipmentsRepaired,
        shipmentsSkipped: result.shipmentsSkipped,
        variantsFound: result.variantsFound,
        errors: result.errors,
      });
    } catch (error: any) {
      console.error("[Collections] Error repairing un-substituted variants:", error);
      res.status(500).json({ error: "Failed to repair un-substituted variants" });
    }
  });

  // Cleanup shipped orders with stale fingerprint statuses
  // Shipped orders (those with tracking_number or ship_date) should not have active fingerprint statuses
  // This sets fingerprint_status to NULL for orders that have already shipped
  app.post("/api/collections/cleanup-shipped-fingerprints", requireAuth, async (req, res) => {
    try {
      console.log('[Collections] Starting cleanup of shipped orders with stale fingerprint statuses...');
      
      // Find and update shipped orders with active fingerprint statuses
      const result = await db.execute(sql`
        UPDATE shipments
        SET fingerprint_status = NULL
        WHERE (tracking_number IS NOT NULL OR ship_date IS NOT NULL)
          AND fingerprint_status IN ('pending_categorization', 'missing_weight', 'needs_recalc')
        RETURNING id, order_number, fingerprint_status
      `);
      
      const updatedCount = result.rows?.length || 0;
      console.log(`[Collections] Cleaned up ${updatedCount} shipped orders`);
      
      res.json({
        success: true,
        updatedCount,
        orders: result.rows?.slice(0, 20) || [], // Return first 20 for debugging
      });
    } catch (error: any) {
      console.error("[Collections] Error cleaning up shipped fingerprints:", error);
      res.status(500).json({ error: "Failed to cleanup shipped fingerprints" });
    }
  });

  // Repair stale lifecycle phases - fixes shipments where stored phase doesn't match derived phase
  // Primary use case: on_dock shipments that should be delivered/in_transit based on carrier status
  app.post("/api/admin/repair-lifecycle-phases", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 1000;
      const dryRun = req.query.dryRun === 'true';
      
      console.log(`[Repair] Starting lifecycle phase repair (limit: ${limit}, dryRun: ${dryRun})`);
      
      // Import lifecycle functions
      const { deriveLifecyclePhase, LIFECYCLE_PHASES } = await import('./services/lifecycle-state-machine');
      
      // Find shipments where stored phase is on_dock but status indicates different phase
      // These are stale - the status was updated by webhooks but lifecycle wasn't recalculated
      const staleShipments = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
          status: shipments.status,
          shipmentStatus: shipments.shipmentStatus,
          lifecyclePhase: shipments.lifecyclePhase,
          trackingNumber: shipments.trackingNumber,
          sessionStatus: shipments.sessionStatus,
        })
        .from(shipments)
        .where(
          and(
            eq(shipments.lifecyclePhase, 'on_dock'),
            or(
              // Carrier codes that indicate NOT on_dock
              inArray(shipments.status, ['DE', 'IT', 'SP', 'UN', 'EX']),
              // ShipStation statuses that shouldn't be on_dock
              inArray(shipments.status, ['shipped', 'cancelled'])
            )
          )
        )
        .limit(limit);
      
      console.log(`[Repair] Found ${staleShipments.length} stale on_dock shipments`);
      
      if (dryRun) {
        // Group by status for summary
        const summary: Record<string, number> = {};
        staleShipments.forEach(s => {
          summary[s.status || 'null'] = (summary[s.status || 'null'] || 0) + 1;
        });
        
        return res.json({
          success: true,
          dryRun: true,
          totalFound: staleShipments.length,
          byStatus: summary,
          sample: staleShipments.slice(0, 10),
        });
      }
      
      // Recalculate lifecycle for each stale shipment
      let repaired = 0;
      let errors = 0;
      const changes: Array<{id: string, orderNumber: string | null, from: string, to: string}> = [];
      
      for (const shipment of staleShipments) {
        try {
          // Get full shipment data for lifecycle calculation
          const fullShipment = await storage.getShipment(shipment.id);
          if (!fullShipment) continue;
          
          // Get tags for MOVE OVER detection
          const tags = await storage.getShipmentTagsByShipmentId(shipment.id);
          const hasMoveOverTag = tags.some(t => t.name === 'MOVE OVER');
          
          // Derive the correct phase
          const derivedState = deriveLifecyclePhase({
            shipmentStatus: fullShipment.shipmentStatus,
            status: fullShipment.status,
            trackingNumber: fullShipment.trackingNumber,
            sessionStatus: fullShipment.sessionStatus,
            qcCompleted: fullShipment.qcCompleted || false,
            hasMoveOverTag,
            fingerprintId: fullShipment.fingerprintId,
          });
          
          const newPhase = derivedState.phase;
          const oldPhase = shipment.lifecyclePhase;
          
          if (newPhase !== oldPhase) {
            await db
              .update(shipments)
              .set({ 
                lifecyclePhase: newPhase,
                lifecycleSubphase: derivedState.subphase,
              })
              .where(eq(shipments.id, shipment.id));
            
            changes.push({
              id: shipment.id,
              orderNumber: shipment.orderNumber,
              from: oldPhase || 'null',
              to: newPhase,
            });
            repaired++;
          }
        } catch (error: any) {
          console.error(`[Repair] Error repairing ${shipment.id}:`, error.message);
          errors++;
        }
      }
      
      console.log(`[Repair] Complete: ${repaired} repaired, ${errors} errors`);
      
      res.json({
        success: true,
        totalFound: staleShipments.length,
        repaired,
        errors,
        changes: changes.slice(0, 50), // Return first 50 changes for verification
      });
    } catch (error: any) {
      console.error("[Repair] Error repairing lifecycle phases:", error);
      res.status(500).json({ error: "Failed to repair lifecycle phases" });
    }
  });


  // Lookup specific kit components
  app.get("/api/kit-mappings/:sku", requireAuth, async (req, res) => {
    try {
      const { getKitComponents, isKit } = await import('./services/kit-mappings-cache');
      const { sku } = req.params;
      
      const isKitResult = await isKit(sku);
      const components = await getKitComponents(sku);
      
      res.json({
        sku,
        isKit: isKitResult,
        components: components || [],
      });
    } catch (error: any) {
      console.error("[kit-mappings] Error looking up kit:", error);
      res.status(500).json({ error: "Failed to lookup kit" });
    }
  });

  // Bulk import collections from CSV
  app.post("/api/collections/bulk-import", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const file = req.file;
      
      if (!file) {
        return res.status(400).json({ error: "No CSV file uploaded" });
      }

      // Read and parse CSV
      const csvContent = fs.readFileSync(file.path, "utf-8");
      const lines = csvContent.split("\n").filter(line => line.trim());
      
      if (lines.length < 2) {
        fs.unlinkSync(file.path); // Clean up
        return res.status(400).json({ error: "CSV file must have a header and at least one data row" });
      }

      // Parse header to find column indices
      const headerLine = lines[0];
      const headers = parseCSVLine(headerLine).map(h => h.toLowerCase().trim());
      
      const colMap = {
        collectionName: headers.findIndex(h => h.includes("collection") && h.includes("name")),
        sku: headers.findIndex(h => h === "sku"),
        incrementalQuantity: headers.findIndex(h => h.includes("incremental") || h.includes("quantity")),
        classification: headers.findIndex(h => h.includes("classification") || h.includes("category")),
      };

      if (colMap.collectionName === -1 || colMap.sku === -1) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ error: "CSV must have 'Collection Name' and 'SKU' columns" });
      }

      // Track collections to create (first occurrence defines properties)
      const collectionDefinitions: Map<string, {
        name: string;
        incrementalQuantity: number | null;
        productCategory: string | null;
      }> = new Map();
      
      // Track SKU assignments
      const skuAssignments: { collectionName: string; sku: string }[] = [];
      const errors: string[] = [];

      // Parse data rows
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const values = parseCSVLine(line);
        const collectionName = values[colMap.collectionName]?.trim();
        const sku = values[colMap.sku]?.trim();

        if (!collectionName || !sku) {
          errors.push(`Row ${i + 1}: Missing collection name or SKU`);
          continue;
        }

        // Store collection definition (first occurrence wins)
        if (!collectionDefinitions.has(collectionName)) {
          const incQtyStr = colMap.incrementalQuantity >= 0 ? values[colMap.incrementalQuantity]?.trim() : null;
          const classification = colMap.classification >= 0 ? values[colMap.classification]?.trim() : null;

          collectionDefinitions.set(collectionName, {
            name: collectionName,
            incrementalQuantity: incQtyStr ? parseInt(incQtyStr, 10) : null,
            productCategory: classification || null,
          });
        }

        skuAssignments.push({ collectionName, sku });
      }

      // Get existing collections
      const { productCollections, productCollectionMappings } = await import("@shared/schema");
      const existingCollections = await db.select().from(productCollections);
      const existingCollectionMap = new Map(existingCollections.map(c => [c.name, c]));

      // Get existing mappings to check for duplicates
      const existingMappings = await db.select().from(productCollectionMappings);
      const existingMappingSet = new Set(existingMappings.map(m => `${m.productCollectionId}:${m.sku}`));

      // Create new collections
      const collectionsCreated: string[] = [];
      const collectionsUpdated: string[] = [];
      const collectionIdMap: Map<string, string> = new Map();

      for (const [name, def] of collectionDefinitions) {
        const existing = existingCollectionMap.get(name);
        if (existing) {
          collectionIdMap.set(name, existing.id);
          // Optionally update existing collection properties if needed
        } else {
          // Create new collection
          const newCollection = await storage.createProductCollection({
            name: def.name,
            description: null,
            incrementalQuantity: def.incrementalQuantity,
            productCategory: def.productCategory,
            createdBy: userId,
            updatedBy: userId,
          });
          collectionIdMap.set(name, newCollection.id);
          collectionsCreated.push(name);
        }
      }

      // Create product mappings
      let mappingsCreated = 0;
      let mappingsSkipped = 0;

      for (const { collectionName, sku } of skuAssignments) {
        const collectionId = collectionIdMap.get(collectionName);
        if (!collectionId) {
          errors.push(`Collection not found for SKU ${sku}: ${collectionName}`);
          continue;
        }

        const mappingKey = `${collectionId}:${sku}`;
        if (existingMappingSet.has(mappingKey)) {
          mappingsSkipped++;
          continue;
        }

        try {
          await db.insert(productCollectionMappings).values({
            productCollectionId: collectionId,
            sku,
            createdBy: userId,
            updatedBy: userId,
          });
          existingMappingSet.add(mappingKey); // Track to avoid duplicates within CSV
          mappingsCreated++;
        } catch (err: any) {
          errors.push(`Failed to add SKU ${sku} to ${collectionName}: ${err.message}`);
        }
      }

      // Clean up uploaded file
      fs.unlinkSync(file.path);

      res.json({
        success: true,
        summary: {
          totalRows: skuAssignments.length,
          collectionsCreated: collectionsCreated.length,
          collectionsExisting: collectionDefinitions.size - collectionsCreated.length,
          mappingsCreated,
          mappingsSkipped,
          errors: errors.length,
        },
        collectionsCreated,
        errors: errors.slice(0, 50), // Limit error output
      });
    } catch (error: any) {
      console.error("[Collections] Bulk import error:", error);
      res.status(500).json({ error: "Failed to process bulk import", details: error.message });
    }
  });

  // Get distinct filter options for product catalog (from local skuvault_products table)
  app.get("/api/product-catalog/filters", requireAuth, async (req, res) => {
    try {
      const { skuvaultProducts } = await import("@shared/schema");
      
      const categories = await db
        .selectDistinct({ productCategory: skuvaultProducts.productCategory })
        .from(skuvaultProducts)
        .where(sql`${skuvaultProducts.productCategory} IS NOT NULL AND ${skuvaultProducts.productCategory} != ''`)
        .orderBy(skuvaultProducts.productCategory);

      res.json({
        categories: categories.map((r) => r.productCategory).filter(Boolean)
      });
    } catch (error: any) {
      console.error("[Product Catalog] Error fetching filters:", error);
      res.status(500).json({ error: "Failed to fetch filter options" });
    }
  });

  // Search product catalog from local skuvault_products table
  app.get("/api/product-catalog", requireAuth, async (req, res) => {
    try {
      const { search, category, isKit, loadAll, excludeAssigned } = req.query;
      const { skuvaultProducts } = await import("@shared/schema");
      
      const searchTerm = search ? String(search).trim() : null;
      const categoryFilter = category && category !== "all" ? String(category) : null;
      const shouldLoadAll = loadAll === "true";
      const shouldExcludeAssigned = excludeAssigned === "true";
      
      // Need at least a search term, one filter, or explicit loadAll flag
      const hasFilters = categoryFilter || isKit === "yes" || isKit === "no";
      if (!searchTerm && !hasFilters && !shouldLoadAll) {
        return res.json({ products: [], total: 0 });
      }
      
      // Build conditions array
      const conditions = [];
      
      if (searchTerm) {
        const searchPattern = `%${searchTerm}%`;
        conditions.push(sql`(
          ${skuvaultProducts.sku} ILIKE ${searchPattern} 
          OR ${skuvaultProducts.productTitle} ILIKE ${searchPattern}
          OR ${skuvaultProducts.barcode} ILIKE ${searchPattern}
          OR ${skuvaultProducts.productCategory} ILIKE ${searchPattern}
        )`);
      }
      
      if (categoryFilter) {
        conditions.push(eq(skuvaultProducts.productCategory, categoryFilter));
      }
      
      if (isKit === "yes") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, true));
      } else if (isKit === "no") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, false));
      }
      
      // If excludeAssigned, filter out products already in any collection
      if (shouldExcludeAssigned) {
        conditions.push(sql`NOT EXISTS (
          SELECT 1 FROM product_collection_mappings 
          WHERE product_collection_mappings.sku = ${skuvaultProducts.sku}
        )`);
      }
      
      const products = await db
        .select({
          sku: skuvaultProducts.sku,
          productTitle: skuvaultProducts.productTitle,
          barcode: skuvaultProducts.barcode,
          productCategory: skuvaultProducts.productCategory,
          isAssembledProduct: skuvaultProducts.isAssembledProduct,
          unitCost: skuvaultProducts.unitCost,
          productImageUrl: skuvaultProducts.productImageUrl,
        })
        .from(skuvaultProducts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(skuvaultProducts.sku)
        .limit(500);

      res.json({ products, total: products.length });
    } catch (error: any) {
      console.error("[Product Catalog] Error searching products:", error);
      res.status(500).json({ error: "Failed to search product catalog" });
    }
  });

  // ========================================
  // Packing Decisions API (Smart Shipping Engine)
  // ========================================

  // Get count of uncategorized products only (for summary cards)
  // Uses fingerprint_status = 'pending_categorization' to match the products list endpoint
  // Excludes shipped orders (those with tracking_number or ship_date)
  app.get("/api/packing-decisions/uncategorized/count", requireAuth, async (req, res) => {
    try {
      // Fast query: count unique uncategorized SKUs in pending_categorization shipments
      // Uses the same fingerprint_status filter as the products list endpoint for consistency
      // Excludes shipped orders to prevent already-fulfilled orders from appearing in reports
      const result = await db.execute(sql`
        WITH pending_shipments AS (
          SELECT id FROM shipments 
          WHERE fingerprint_status = 'pending_categorization'
            AND tracking_number IS NULL
            AND ship_date IS NULL
            AND lifecycle_phase NOT IN ('cancelled', 'delivered', 'in_transit', 'on_dock')
        )
        SELECT COUNT(DISTINCT qc.sku) as count
        FROM shipment_qc_items qc
        INNER JOIN pending_shipments ps ON qc.shipment_id = ps.id
        LEFT JOIN product_collection_mappings pcm ON qc.sku = pcm.sku
        WHERE pcm.id IS NULL
      `);
      
      const count = Number((result.rows?.[0] as any)?.count) || 0;
      res.json({ count });
    } catch (error: any) {
      console.error("[Packing Decisions] Error fetching uncategorized count:", error);
      res.status(500).json({ error: "Failed to fetch uncategorized count" });
    }
  });

  // Get uncategorized products with shipment counts
  // Uses product_collection_mappings as the source of truth for categorization
  // Uses skuvault_products as source of truth for product catalog (title, image, weight)
  // OPTIMIZED: Filter by pending_categorization shipments FIRST (small set), then join QC items
  app.get("/api/packing-decisions/uncategorized", requireAuth, async (req, res) => {
    try {
      const { shipmentQcItems, productCollectionMappings, shipments: shipmentsTable, skuvaultProducts } = await import("@shared/schema");
      
      // Run all 3 queries in parallel for better performance
      // All queries exclude shipped orders (tracking_number or ship_date present)
      const [uncategorizedProducts, coverageStatsResult, fingerprintStatsResult] = await Promise.all([
        // Query 1: Get uncategorized products - OPTIMIZED to filter shipments first
        // Uses subquery to get pending_categorization shipment IDs first (small set ~30 rows)
        // Then only scans QC items for those shipments, not all 1M+ rows
        // Excludes shipped orders to prevent already-fulfilled orders from appearing
        db.execute(sql`
          WITH pending_shipments AS (
            SELECT id FROM shipments 
            WHERE fingerprint_status = 'pending_categorization'
              AND tracking_number IS NULL
              AND ship_date IS NULL
              AND lifecycle_phase NOT IN ('cancelled', 'delivered', 'in_transit', 'on_dock')
          )
          SELECT 
            qc.sku,
            qc.description,
            sv.product_title as "productTitle",
            sv.product_image_url as "imageUrl",
            sv.sku IS NOT NULL as "inSkuvaultCatalog",
            COUNT(DISTINCT qc.shipment_id) as "shipmentCount"
          FROM shipment_qc_items qc
          INNER JOIN pending_shipments ps ON qc.shipment_id = ps.id
          LEFT JOIN product_collection_mappings pcm ON qc.sku = pcm.sku
          LEFT JOIN skuvault_products sv ON qc.sku = sv.sku
          WHERE pcm.id IS NULL
          GROUP BY qc.sku, qc.description, sv.product_title, sv.product_image_url, sv.sku
          ORDER BY COUNT(DISTINCT qc.shipment_id) DESC
        `),
        
        // Query 2: Coverage stats - OPTIMIZED with same approach
        // Excludes shipped/cancelled/delivered orders
        db.execute(sql`
          WITH pending_shipments AS (
            SELECT id, order_date FROM shipments 
            WHERE fingerprint_status = 'pending_categorization'
              AND tracking_number IS NULL
              AND ship_date IS NULL
              AND lifecycle_phase NOT IN ('cancelled', 'delivered', 'in_transit', 'on_dock')
          )
          SELECT 
            COUNT(DISTINCT qc.sku) as "totalProducts",
            COUNT(DISTINCT CASE WHEN pcm.id IS NOT NULL THEN qc.sku END) as "categorizedProducts",
            COUNT(DISTINCT qc.shipment_id) as "totalShipments",
            MIN(ps.order_date) as "oldestOrderDate"
          FROM shipment_qc_items qc
          INNER JOIN pending_shipments ps ON qc.shipment_id = ps.id
          LEFT JOIN product_collection_mappings pcm ON qc.sku = pcm.sku
        `),
        
        // Query 3: Fingerprint stats - already efficient (just counting shipments)
        db
          .select({
            complete: sql<number>`COUNT(*) FILTER (WHERE fingerprint_status = 'complete')`,
            pending: sql<number>`COUNT(*) FILTER (WHERE fingerprint_status = 'pending_categorization')`,
          })
          .from(shipmentsTable)
          .where(sql`fingerprint_status IS NOT NULL`)
      ]);
      
      const coverageStats = (coverageStatsResult.rows?.[0] || {}) as Record<string, any>;
      const fingerprintStats = fingerprintStatsResult[0] || {};

      res.json({
        uncategorizedProducts: uncategorizedProducts.rows || [],
        stats: {
          totalProducts: Number(coverageStats?.totalProducts) || 0,
          categorizedProducts: Number(coverageStats?.categorizedProducts) || 0,
          totalShipments: Number(coverageStats?.totalShipments) || 0,
          shipmentsComplete: Number(fingerprintStats?.complete) || 0,
          shipmentsPending: Number(fingerprintStats?.pending) || 0,
          oldestOrderDate: coverageStats?.oldestOrderDate || null,
        }
      });
    } catch (error: any) {
      console.error("[Packing Decisions] Error fetching uncategorized products:", error);
      res.status(500).json({ error: "Failed to fetch uncategorized products" });
    }
  });

  // Get shipments containing a specific uncategorized SKU (for troubleshooting)
  app.get("/api/uncategorized-products/:sku/shipments", requireAuth, async (req, res) => {
    try {
      const { sku } = req.params;
      // Note: shipments and shipmentQcItems are already imported at top of file
      
      const shipmentsWithSku = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
          orderDate: shipments.orderDate,
          shipmentStatus: shipments.shipmentStatus,
          fingerprintStatus: shipments.fingerprintStatus,
        })
        .from(shipments)
        .innerJoin(shipmentQcItems, eq(shipmentQcItems.shipmentId, shipments.id))
        .where(
          and(
            eq(shipmentQcItems.sku, sku),
            eq(shipments.fingerprintStatus, 'pending_categorization'),
            notInArray(shipments.lifecyclePhase, ['cancelled', 'delivered', 'in_transit', 'on_dock'])
          )
        )
        .groupBy(shipments.id, shipments.orderNumber, shipments.orderDate, shipments.shipmentStatus, shipments.fingerprintStatus)
        .orderBy(desc(shipments.orderDate))
        .limit(100);
      
      res.json({
        sku,
        shipments: shipmentsWithSku.map(s => ({
          id: s.id,
          orderNumber: s.orderNumber,
          orderDate: s.orderDate,
          shipmentStatus: s.shipmentStatus,
          fingerprintStatus: s.fingerprintStatus,
        })),
        totalCount: shipmentsWithSku.length,
      });
    } catch (error: any) {
      console.error("[Packing Decisions] Error fetching shipments for SKU:", error);
      res.status(500).json({ error: "Failed to fetch shipments for SKU" });
    }
  });

  // Get count of products with missing weight only (for summary cards)
  // Excludes shipped orders (those with tracking_number or ship_date)
  app.get("/api/packing-decisions/missing-weight/count", requireAuth, async (req, res) => {
    try {
      const result = await db.execute(sql`
        WITH missing_weight_shipments AS (
          SELECT id FROM shipments 
          WHERE fingerprint_status = 'missing_weight'
            AND tracking_number IS NULL
            AND ship_date IS NULL
        )
        SELECT COUNT(DISTINCT qc.sku) as count
        FROM shipment_qc_items qc
        INNER JOIN missing_weight_shipments mws ON qc.shipment_id = mws.id
        WHERE qc.weight_value IS NULL OR qc.weight_value = 0
      `);
      
      const count = Number((result.rows?.[0] as any)?.count) || 0;
      res.json({ count });
    } catch (error: any) {
      console.error("[Packing Decisions] Error fetching missing weight count:", error);
      res.status(500).json({ error: "Failed to fetch missing weight count" });
    }
  });

  // Get products with missing weight data
  // Excludes shipped orders (those with tracking_number or ship_date)
  app.get("/api/packing-decisions/missing-weight", requireAuth, async (req, res) => {
    try {
      const { shipmentQcItems, shipments: shipmentsTable, skuvaultProducts } = await import("@shared/schema");
      
      // Get products with missing weight from missing_weight status shipments
      // Excludes shipped orders to prevent already-fulfilled orders from appearing
      const productsResult = await db.execute(sql`
        WITH missing_weight_shipments AS (
          SELECT id, order_date FROM shipments 
          WHERE fingerprint_status = 'missing_weight'
            AND tracking_number IS NULL
            AND ship_date IS NULL
        )
        SELECT 
          qc.sku,
          qc.description,
          sv.product_title as "productTitle",
          sv.product_image_url as "imageUrl",
          sv.weight_value as "catalogWeight",
          sv.weight_unit as "catalogWeightUnit",
          sv.sku IS NOT NULL as "inSkuvaultCatalog",
          COUNT(DISTINCT qc.shipment_id) as "shipmentCount"
        FROM shipment_qc_items qc
        INNER JOIN missing_weight_shipments mws ON qc.shipment_id = mws.id
        LEFT JOIN skuvault_products sv ON qc.sku = sv.sku
        WHERE qc.weight_value IS NULL OR qc.weight_value = 0
        GROUP BY qc.sku, qc.description, sv.product_title, sv.product_image_url, sv.weight_value, sv.weight_unit, sv.sku
        ORDER BY COUNT(DISTINCT qc.shipment_id) DESC
      `);
      
      // Get stats - also excludes shipped orders
      const statsResult = await db.execute(sql`
        WITH missing_weight_shipments AS (
          SELECT id, order_date FROM shipments 
          WHERE fingerprint_status = 'missing_weight'
            AND tracking_number IS NULL
            AND ship_date IS NULL
        )
        SELECT 
          COUNT(DISTINCT qc.sku) as "totalProducts",
          COUNT(DISTINCT qc.shipment_id) as "totalShipments",
          MIN(mws.order_date) as "oldestOrderDate"
        FROM shipment_qc_items qc
        INNER JOIN missing_weight_shipments mws ON qc.shipment_id = mws.id
        WHERE qc.weight_value IS NULL OR qc.weight_value = 0
      `);
      
      const stats = (statsResult.rows?.[0] || {}) as Record<string, any>;
      
      res.json({
        missingWeightProducts: productsResult.rows || [],
        stats: {
          totalProducts: Number(stats?.totalProducts) || 0,
          totalShipments: Number(stats?.totalShipments) || 0,
          oldestOrderDate: stats?.oldestOrderDate || null,
        }
      });
    } catch (error: any) {
      console.error("[Packing Decisions] Error fetching missing weight products:", error);
      res.status(500).json({ error: "Failed to fetch missing weight products" });
    }
  });

  // Get all SKUs that have collection assignments (for filtering uncategorized in catalog)
  app.get("/api/collections/assigned-skus", requireAuth, async (req, res) => {
    try {
      const { productCollectionMappings } = await import("@shared/schema");
      
      const result = await db
        .selectDistinct({ sku: productCollectionMappings.sku })
        .from(productCollectionMappings);
      
      const assignedSkus = result.map(r => r.sku);
      res.json({ assignedSkus });
    } catch (error: any) {
      console.error("[Collections] Error fetching assigned SKUs:", error);
      res.status(500).json({ error: "Failed to fetch assigned SKUs" });
    }
  });

  // Get products that appear in more than one geometry collection (validation)
  app.get("/api/collections/validation/duplicate-products", requireAuth, async (req, res) => {
    try {
      const { productCollectionMappings, productCollections, skuvaultProducts } = await import("@shared/schema");
      
      // Find SKUs that appear in multiple collections
      const duplicateSkus = await db
        .select({
          sku: productCollectionMappings.sku,
          collectionCount: count(productCollectionMappings.productCollectionId).as('collection_count'),
        })
        .from(productCollectionMappings)
        .groupBy(productCollectionMappings.sku)
        .having(sql`count(${productCollectionMappings.productCollectionId}) > 1`);
      
      if (duplicateSkus.length === 0) {
        return res.json({ duplicateProducts: [], totalCount: 0 });
      }
      
      const skuList = duplicateSkus.map(d => d.sku);
      
      // Get collection details for each duplicate SKU
      const mappingsWithCollections = await db
        .select({
          sku: productCollectionMappings.sku,
          collectionId: productCollections.id,
          collectionName: productCollections.name,
        })
        .from(productCollectionMappings)
        .innerJoin(productCollections, eq(productCollectionMappings.productCollectionId, productCollections.id))
        .where(inArray(productCollectionMappings.sku, skuList));
      
      // Get product details from skuvault_products
      const productDetails = await db
        .select({
          sku: skuvaultProducts.sku,
          productTitle: skuvaultProducts.productTitle,
        })
        .from(skuvaultProducts)
        .where(inArray(skuvaultProducts.sku, skuList));
      
      const productTitleMap = new Map(productDetails.map(p => [p.sku, p.productTitle]));
      
      // Group by SKU
      const skuCollectionsMap = new Map<string, { collectionId: string; collectionName: string }[]>();
      for (const mapping of mappingsWithCollections) {
        if (!skuCollectionsMap.has(mapping.sku)) {
          skuCollectionsMap.set(mapping.sku, []);
        }
        skuCollectionsMap.get(mapping.sku)!.push({
          collectionId: mapping.collectionId,
          collectionName: mapping.collectionName,
        });
      }
      
      // Build response with SKU, product title, and collections
      const duplicateProducts = skuList.map(sku => ({
        sku,
        productTitle: productTitleMap.get(sku) || null,
        collectionCount: skuCollectionsMap.get(sku)?.length || 0,
        collections: skuCollectionsMap.get(sku) || [],
      }));
      
      // Sort by collection count (highest first), then by SKU
      duplicateProducts.sort((a, b) => {
        if (b.collectionCount !== a.collectionCount) {
          return b.collectionCount - a.collectionCount;
        }
        return a.sku.localeCompare(b.sku);
      });
      
      res.json({
        duplicateProducts,
        totalCount: duplicateProducts.length,
      });
    } catch (error: any) {
      console.error("[Collections] Error fetching duplicate products:", error);
      res.status(500).json({ error: "Failed to fetch duplicate products" });
    }
  });

  // Quick-assign a product to a collection and recalculate fingerprints
  // Uses product_collection_mappings as source of truth - no need to update QC items
  // NOTE: Both /assign and /categorize endpoints do the same thing - /categorize is the frontend-facing name
  app.post("/api/packing-decisions/categorize", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const { sku, collectionId } = req.body;
      
      if (!sku || !collectionId) {
        return res.status(400).json({ error: "SKU and collectionId are required" });
      }
      
      // Add product to collection (this is the source of truth)
      const mappings = await storage.addProductsToCollection(collectionId, [sku], userId);
      
      const { shipmentQcItems, shipments: shipmentsTable } = await import("@shared/schema");
      
      const affectedShipments = await db
        .selectDistinct({ shipmentId: shipmentQcItems.shipmentId, orderNumber: shipmentsTable.orderNumber })
        .from(shipmentQcItems)
        .innerJoin(shipmentsTable, eq(shipmentQcItems.shipmentId, shipmentsTable.id))
        .where(
          and(
            eq(shipmentQcItems.sku, sku),
            eq(shipmentsTable.fingerprintStatus, 'pending_categorization')
          )
        );
      
      const { calculateFingerprint } = await import('./services/qc-item-hydrator');
      let fingerprintsUpdated = 0;
      
      for (const { shipmentId } of affectedShipments) {
        try {
          const result = await calculateFingerprint(shipmentId);
          if (result.status === 'complete') {
            fingerprintsUpdated++;
          }
        } catch (err) {
          console.error(`[Packing Decisions] Error recalculating fingerprint for ${shipmentId}:`, err);
        }
      }
      
      if (affectedShipments.length > 0) {
        const items = affectedShipments.map(s => ({ shipmentId: s.shipmentId, orderNumber: s.orderNumber || undefined }));
        const queued = await queueLifecycleEvaluationBatch(items, 'categorization');
        console.log(`[Packing Decisions] Categorized ${sku} → queued ${queued}/${affectedShipments.length} lifecycle events`);
      }
      
      console.log(`[Packing Decisions] Categorized ${sku} to collection ${collectionId}, recalculated ${affectedShipments.length} shipments, ${fingerprintsUpdated} now complete`);
      
      res.json({
        success: true,
        mapping: mappings[0],
        shipmentsAffected: affectedShipments.length,
        fingerprintsCompleted: fingerprintsUpdated,
      });
    } catch (error: any) {
      console.error("[Packing Decisions] Error categorizing product:", error);
      res.status(500).json({ error: "Failed to categorize product" });
    }
  });

  app.post("/api/packing-decisions/assign", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const { sku, collectionId } = req.body;
      
      if (!sku || !collectionId) {
        return res.status(400).json({ error: "SKU and collectionId are required" });
      }
      
      // Add product to collection (this is the source of truth)
      const mappings = await storage.addProductsToCollection(collectionId, [sku], userId);
      
      const { shipmentQcItems, shipments: shipmentsTable } = await import("@shared/schema");
      
      const affectedShipments = await db
        .selectDistinct({ shipmentId: shipmentQcItems.shipmentId, orderNumber: shipmentsTable.orderNumber })
        .from(shipmentQcItems)
        .innerJoin(shipmentsTable, eq(shipmentQcItems.shipmentId, shipmentsTable.id))
        .where(
          and(
            eq(shipmentQcItems.sku, sku),
            eq(shipmentsTable.fingerprintStatus, 'pending_categorization')
          )
        );
      
      const { calculateFingerprint } = await import('./services/qc-item-hydrator');
      let fingerprintsUpdated = 0;
      
      for (const { shipmentId } of affectedShipments) {
        try {
          const result = await calculateFingerprint(shipmentId);
          if (result.status === 'complete') {
            fingerprintsUpdated++;
          }
        } catch (err) {
          console.error(`[Packing Decisions] Error recalculating fingerprint for ${shipmentId}:`, err);
        }
      }
      
      if (affectedShipments.length > 0) {
        const items = affectedShipments.map(s => ({ shipmentId: s.shipmentId, orderNumber: s.orderNumber || undefined }));
        const queued = await queueLifecycleEvaluationBatch(items, 'categorization');
        console.log(`[Packing Decisions] Assigned ${sku} → queued ${queued}/${affectedShipments.length} lifecycle events`);
      }
      
      console.log(`[Packing Decisions] Assigned ${sku} to collection ${collectionId}, recalculated ${affectedShipments.length} shipments, ${fingerprintsUpdated} now complete`);
      
      res.json({
        success: true,
        mapping: mappings[0],
        shipmentsAffected: affectedShipments.length,
        fingerprintsCompleted: fingerprintsUpdated,
      });
    } catch (error: any) {
      console.error("[Packing Decisions] Error assigning product:", error);
      res.status(500).json({ error: "Failed to assign product to collection" });
    }
  });

  // ========================================
  // SkuVault Products API (Centralized Product Catalog)
  // ========================================

  // Get paginated skuvault products with filtering and search
  app.get("/api/skuvault-products", requireAuth, async (req, res) => {
    try {
      const { skuvaultProducts } = await import("@shared/schema");
      
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 200);
      const search = (req.query.search as string || "").trim().toLowerCase();
      const categoriesParam = req.query.categories as string; // comma-separated list
      const brandsParam = req.query.brands as string; // comma-separated list of brands
      const isAssembled = req.query.isAssembled as string;
      
      console.log(`[SkuVault Products] Query params: page=${page}, pageSize=${pageSize}, search="${search}", categories="${categoriesParam || 'none'}", brands="${brandsParam || 'none'}", isAssembled="${isAssembled || 'all'}"`);
      
      // Build where conditions
      const conditions = [];
      
      if (search) {
        conditions.push(
          or(
            sql`LOWER(${skuvaultProducts.sku}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.productTitle}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.barcode}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.productCategory}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.physicalLocation}) LIKE ${`%${search}%`}`
          )
        );
      }
      
      // Multi-select categories filter (comma-separated)
      if (categoriesParam && categoriesParam.trim()) {
        const categoryList = categoriesParam.split(",").map(c => c.trim()).filter(Boolean);
        console.log(`[SkuVault Products] Categories filter: ${categoryList.length} categories selected:`, categoryList.slice(0, 3).join(", "), categoryList.length > 3 ? "..." : "");
        if (categoryList.length > 0) {
          conditions.push(inArray(skuvaultProducts.productCategory, categoryList));
        }
      }
      
      // Multi-select brands filter (comma-separated)
      if (brandsParam && brandsParam.trim()) {
        const brandList = brandsParam.split(",").map(b => b.trim()).filter(Boolean);
        console.log(`[SkuVault Products] Brands filter: ${brandList.length} brands selected:`, brandList.slice(0, 3).join(", "), brandList.length > 3 ? "..." : "");
        if (brandList.length > 0) {
          conditions.push(inArray(skuvaultProducts.brand, brandList));
        }
      }
      
      if (isAssembled === "true") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, true));
      } else if (isAssembled === "false") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, false));
      }
      
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      
      // Get total count
      const countResult = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(skuvaultProducts)
        .where(whereClause);
      
      const total = countResult[0]?.count || 0;
      const totalPages = Math.ceil(total / pageSize);
      
      console.log(`[SkuVault Products] Query result: ${total} total products matching filters`);
      
      // Get paginated products
      const products = await db
        .select()
        .from(skuvaultProducts)
        .where(whereClause)
        .orderBy(skuvaultProducts.sku)
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      
      // Get distinct categories for filter dropdown
      const categoriesResult = await db
        .selectDistinct({ category: skuvaultProducts.productCategory })
        .from(skuvaultProducts)
        .where(sql`${skuvaultProducts.productCategory} IS NOT NULL`)
        .orderBy(skuvaultProducts.productCategory);
      
      const allCategories = categoriesResult
        .map(r => r.category)
        .filter((c): c is string => c !== null);
      
      // Get distinct brands for filter dropdown
      const brandsResult = await db
        .selectDistinct({ brand: skuvaultProducts.brand })
        .from(skuvaultProducts)
        .where(sql`${skuvaultProducts.brand} IS NOT NULL`)
        .orderBy(skuvaultProducts.brand);
      
      const allBrands = brandsResult
        .map(r => r.brand)
        .filter((b): b is string => b !== null);
      
      res.json({
        products,
        total,
        page,
        pageSize,
        totalPages,
        categories: allCategories,
        brands: allBrands,
      });
    } catch (error: any) {
      console.error("[SkuVault Products] Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // Export skuvault products to CSV with filtering
  app.get("/api/skuvault-products/export", requireAuth, async (req, res) => {
    try {
      const { skuvaultProducts } = await import("@shared/schema");
      
      const search = (req.query.search as string || "").trim().toLowerCase();
      const categoriesParam = req.query.categories as string; // comma-separated list
      const isAssembled = req.query.isAssembled as string;
      
      // Build where conditions (same as list endpoint)
      const conditions = [];
      
      if (search) {
        conditions.push(
          or(
            sql`LOWER(${skuvaultProducts.sku}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.productTitle}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.barcode}) LIKE ${`%${search}%`}`,
            sql`LOWER(${skuvaultProducts.productCategory}) LIKE ${`%${search}%`}`
          )
        );
      }
      
      // Multi-select categories filter (comma-separated)
      if (categoriesParam && categoriesParam.trim()) {
        const categoryList = categoriesParam.split(",").map(c => c.trim()).filter(Boolean);
        if (categoryList.length > 0) {
          conditions.push(inArray(skuvaultProducts.productCategory, categoryList));
        }
      }
      
      if (isAssembled === "true") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, true));
      } else if (isAssembled === "false") {
        conditions.push(eq(skuvaultProducts.isAssembledProduct, false));
      }
      
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      
      // Get all matching products (no pagination for export)
      const products = await db
        .select()
        .from(skuvaultProducts)
        .where(whereClause)
        .orderBy(skuvaultProducts.sku);
      
      // Build CSV content
      const headers = ["SKU", "Product Title", "Barcode", "Category", "Is Assembled Product", "Unit Cost", "Image URL", "Stock Check Date"];
      const escapeCSV = (value: string | null | undefined): string => {
        if (value == null) return "";
        const str = String(value);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      
      const rows = products.map(p => [
        escapeCSV(p.sku),
        escapeCSV(p.productTitle),
        escapeCSV(p.barcode),
        escapeCSV(p.productCategory),
        p.isAssembledProduct ? "Yes" : "No",
        escapeCSV(p.unitCost),
        escapeCSV(p.productImageUrl),
        escapeCSV(p.stockCheckDate),
      ].join(","));
      
      const csv = [headers.join(","), ...rows].join("\n");
      
      // Set headers for CSV download
      const filename = `skuvault-products-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
      
      console.log(`[SkuVault Products] Exported ${products.length} products to CSV`);
    } catch (error: any) {
      console.error("[SkuVault Products] Error exporting products:", error);
      res.status(500).json({ error: "Failed to export products" });
    }
  });

  // Force sync skuvault products (clears cache and re-syncs from reporting database)
  app.post("/api/skuvault-products/force-sync", requireAuth, async (req, res) => {
    try {
      const { syncSkuvaultProducts, clearLastSyncedDate } = await import("./services/skuvault-products-sync-service");
      
      console.log("[SkuVault Products] Force sync requested - clearing cache first");
      await clearLastSyncedDate();
      
      const result = await syncSkuvaultProducts();
      
      res.json({
        success: result.success,
        productCount: result.productCount,
        stockCheckDate: result.stockCheckDate,
        duration: result.duration,
      });
    } catch (error: any) {
      console.error("[SkuVault Products] Force sync failed:", error);
      res.status(500).json({ error: "Failed to force sync products" });
    }
  });

  app.get("/api/skuvault-products/:sku/kit-components", requireAuth, async (req, res) => {
    try {
      const { sku } = req.params;
      const { getKitComponents } = await import("./services/kit-mappings-cache");
      
      const components = await getKitComponents(sku);
      
      res.json({
        sku,
        components: components || [],
        hasComponents: components !== null && components.length > 0,
      });
    } catch (error: any) {
      console.error(`[SkuVault Products] Error fetching kit components for ${req.params.sku}:`, error);
      res.status(500).json({ error: "Failed to fetch kit components" });
    }
  });

  // Get collections assigned to a specific SKU
  app.get("/api/skuvault-products/:sku/collections", requireAuth, async (req, res) => {
    try {
      const { sku } = req.params;
      const { productCollections, productCollectionMappings } = await import("@shared/schema");
      
      const assignments = await db
        .select({
          mappingId: productCollectionMappings.id,
          collectionId: productCollections.id,
          collectionName: productCollections.name,
          collectionDescription: productCollections.description,
        })
        .from(productCollectionMappings)
        .innerJoin(productCollections, eq(productCollections.id, productCollectionMappings.productCollectionId))
        .where(eq(productCollectionMappings.sku, sku));
      
      res.json({
        sku,
        collections: assignments,
        hasCollections: assignments.length > 0,
      });
    } catch (error: any) {
      console.error(`[SkuVault Products] Error fetching collections for ${req.params.sku}:`, error);
      res.status(500).json({ error: "Failed to fetch collections for SKU" });
    }
  });

  // Assign a SKU to a collection
  app.post("/api/skuvault-products/:sku/collections", requireAuth, async (req, res) => {
    try {
      const { sku } = req.params;
      const { collectionId } = req.body;
      const { productCollections, productCollectionMappings } = await import("@shared/schema");
      
      if (!collectionId) {
        return res.status(400).json({ error: "collectionId is required" });
      }
      
      // Check if collection exists
      const collection = await db
        .select()
        .from(productCollections)
        .where(eq(productCollections.id, collectionId))
        .limit(1);
      
      if (collection.length === 0) {
        return res.status(404).json({ error: "Collection not found" });
      }
      
      // Check if mapping already exists
      const existingMapping = await db
        .select()
        .from(productCollectionMappings)
        .where(
          and(
            eq(productCollectionMappings.sku, sku),
            eq(productCollectionMappings.productCollectionId, collectionId)
          )
        )
        .limit(1);
      
      if (existingMapping.length > 0) {
        return res.status(409).json({ error: "SKU is already assigned to this collection" });
      }
      
      // Create the mapping
      const [newMapping] = await db
        .insert(productCollectionMappings)
        .values({
          sku,
          productCollectionId: collectionId,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        })
        .returning();
      
      // Invalidate fingerprints for shipments containing this SKU
      const { onCollectionChanged } = await import('./services/qc-item-hydrator');
      const invalidationResult = await onCollectionChanged([sku]);
      
      console.log(`[SkuVault Products] Assigned SKU ${sku} to collection ${collectionId}, invalidated ${invalidationResult.shipmentsInvalidated} shipments`);
      
      res.json({
        success: true,
        mapping: newMapping,
        shipmentsInvalidated: invalidationResult.shipmentsInvalidated,
      });
    } catch (error: any) {
      console.error(`[SkuVault Products] Error assigning ${req.params.sku} to collection:`, error);
      res.status(500).json({ error: "Failed to assign SKU to collection" });
    }
  });

  // Remove a SKU from a collection
  app.delete("/api/skuvault-products/:sku/collections/:collectionId", requireAuth, async (req, res) => {
    try {
      const { sku, collectionId } = req.params;
      const { productCollectionMappings } = await import("@shared/schema");
      
      const deleted = await db
        .delete(productCollectionMappings)
        .where(
          and(
            eq(productCollectionMappings.sku, sku),
            eq(productCollectionMappings.productCollectionId, collectionId)
          )
        )
        .returning();
      
      if (deleted.length === 0) {
        return res.status(404).json({ error: "Mapping not found" });
      }
      
      // Invalidate fingerprints for shipments containing this SKU
      const { onCollectionChanged } = await import('./services/qc-item-hydrator');
      const invalidationResult = await onCollectionChanged([sku]);
      
      console.log(`[SkuVault Products] Removed SKU ${sku} from collection ${collectionId}, invalidated ${invalidationResult.shipmentsInvalidated} shipments`);
      
      res.json({
        success: true,
        deleted: deleted[0],
        shipmentsInvalidated: invalidationResult.shipmentsInvalidated,
      });
    } catch (error: any) {
      console.error(`[SkuVault Products] Error removing ${req.params.sku} from collection:`, error);
      res.status(500).json({ error: "Failed to remove SKU from collection" });
    }
  });

  // ========================================
  // SkuVault Inventory API
  // ========================================

  /**
   * Get inventory by brand and warehouse
   * Query params:
   *   - brand (required): Brand name to filter by (e.g., "Jerky.com")
   *   - warehouseCode (optional): Warehouse code, defaults to "-1" (all warehouses)
   * 
   * Returns inventory items with quantities, locations, and summary statistics
   */
  app.get("/api/skuvault/inventory/by-brand", requireAuth, async (req, res) => {
    try {
      const brand = req.query.brand as string;
      const warehouseCode = (req.query.warehouseCode as string) || '-1';
      
      if (!brand) {
        return res.status(400).json({ 
          error: "Missing required parameter: brand",
          example: "/api/skuvault/inventory/by-brand?brand=Jerky.com&warehouseCode=-1"
        });
      }
      
      console.log(`[API] Fetching inventory for brand: ${brand}, warehouse: ${warehouseCode}`);
      
      const response = await skuVaultService.getInventoryByBrandAndWarehouse(brand, warehouseCode);
      
      // Check for API errors
      if (response.Errors && response.Errors.length > 0) {
        console.error(`[API] SkuVault returned errors:`, response.Errors);
        return res.status(400).json({
          error: "SkuVault API returned errors",
          details: response.Errors,
        });
      }
      
      res.json(response);
    } catch (error: any) {
      console.error(`[API] Error fetching inventory by brand:`, error);
      
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ error: "Failed to fetch inventory" });
    }
  });

  /**
   * Get inventory by title/search term and warehouse
   * Query params:
   *   - term (required): Product title or search term to filter by
   *   - warehouseCode (optional): Warehouse code, defaults to "-1" (all warehouses)
   * 
   * Returns inventory items with quantities, locations, and summary statistics
   */
  app.get("/api/skuvault/inventory/by-title", requireAuth, async (req, res) => {
    try {
      const term = req.query.term as string;
      const warehouseCode = (req.query.warehouseCode as string) || '-1';
      
      if (!term) {
        return res.status(400).json({ 
          error: "Missing required parameter: term",
          example: "/api/skuvault/inventory/by-title?term=Red Wine Beef Jerky&warehouseCode=-1"
        });
      }
      
      console.log(`[API] Fetching inventory for term: "${term}", warehouse: ${warehouseCode}`);
      
      const response = await skuVaultService.getInventoryByTitleAndWarehouse(term, warehouseCode);
      
      // Check for API errors
      if (response.Errors && response.Errors.length > 0) {
        console.error(`[API] SkuVault returned errors:`, response.Errors);
        return res.status(400).json({
          error: "SkuVault API returned errors",
          details: response.Errors,
        });
      }
      
      res.json(response);
    } catch (error: any) {
      console.error(`[API] Error fetching inventory by title:`, error);
      
      if (error instanceof SkuVaultError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        });
      }
      
      res.status(500).json({ error: "Failed to fetch inventory" });
    }
  });

  // ========================================
  // Fingerprints API (Smart Shipping Engine)
  // ========================================

  // Trigger manual hydration of shipments (re-creates QC items and fingerprints)
  app.post("/api/fingerprints/trigger-hydration", requireAuth, async (req, res) => {
    try {
      const { runHydration } = await import("./services/qc-item-hydrator");
      const { batchSize = 500 } = req.body;
      
      console.log(`[Fingerprints] Manual hydration triggered (batch size: ${batchSize})`);
      const stats = await runHydration(batchSize);
      
      res.json({
        success: true,
        stats,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Manual hydration failed:", error);
      res.status(500).json({ error: "Failed to run hydration" });
    }
  });

  // Get all fingerprints with shipment counts and packaging status
  app.get("/api/fingerprints", requireAuth, async (req, res) => {
    try {
      const { fingerprints: fingerprintsTable, fingerprintModels, packagingTypes, shipments: shipmentsTable, productCollections } = await import("@shared/schema");
      
      // Get all fingerprints with shipment count and packaging assignment
      const fingerprintsWithStats = await db
        .select({
          id: fingerprintsTable.id,
          signature: fingerprintsTable.signature,
          signatureHash: fingerprintsTable.signatureHash,
          displayName: fingerprintsTable.displayName,
          totalItems: fingerprintsTable.totalItems,
          collectionCount: fingerprintsTable.collectionCount,
          totalWeight: fingerprintsTable.totalWeight,
          weightUnit: fingerprintsTable.weightUnit,
          createdAt: fingerprintsTable.createdAt,
          shipmentCount: sql<number>`COUNT(DISTINCT ${shipmentsTable.id})`.as('shipment_count'),
          packagingTypeId: fingerprintModels.packagingTypeId,
          packagingTypeName: packagingTypes.name,
          stationType: packagingTypes.stationType,
        })
        .from(fingerprintsTable)
        .leftJoin(shipmentsTable, eq(shipmentsTable.fingerprintId, fingerprintsTable.id))
        .leftJoin(fingerprintModels, eq(fingerprintModels.fingerprintId, fingerprintsTable.id))
        .leftJoin(packagingTypes, eq(packagingTypes.id, fingerprintModels.packagingTypeId))
        .groupBy(
          fingerprintsTable.id,
          fingerprintsTable.signature,
          fingerprintsTable.signatureHash,
          fingerprintsTable.displayName,
          fingerprintsTable.totalItems,
          fingerprintsTable.collectionCount,
          fingerprintsTable.totalWeight,
          fingerprintsTable.weightUnit,
          fingerprintsTable.createdAt,
          fingerprintModels.packagingTypeId,
          packagingTypes.name,
          packagingTypes.stationType
        )
        .orderBy(desc(sql`COUNT(DISTINCT ${shipmentsTable.id})`));
      
      // Filter out orphan fingerprints (0 shipments) - these are stale entries
      const activeFingerprints = fingerprintsWithStats.filter(fp => fp.shipmentCount > 0);
      
      // Parse signatures and build human-readable names with collection names
      const collectionsMap = new Map<string, string>();
      const allCollections = await db.select().from(productCollections);
      allCollections.forEach(c => collectionsMap.set(c.id, c.name));
      
      const fingerprintsWithNames = activeFingerprints.map(fp => {
        let humanReadableName = fp.displayName;
        
        if (!humanReadableName && fp.signature) {
          try {
            const sig = JSON.parse(fp.signature) as Record<string, number>;
            const parts = Object.entries(sig)
              .sort((a, b) => b[1] - a[1]) // Sort by quantity desc
              .map(([collectionId, qty]) => {
                const collectionName = collectionsMap.get(collectionId) || collectionId;
                return `${collectionName} (${qty})`;
              });
            humanReadableName = parts.join(' + ');
          } catch {
            humanReadableName = 'Unknown pattern';
          }
        }
        
        return {
          ...fp,
          humanReadableName: humanReadableName || 'Unknown pattern',
          hasPackaging: !!fp.packagingTypeId,
        };
      });
      
      // Get stats
      const totalFingerprints = fingerprintsWithNames.length;
      const assignedFingerprints = fingerprintsWithNames.filter(fp => fp.hasPackaging).length;
      const needsDecision = totalFingerprints - assignedFingerprints;
      
      res.json({
        fingerprints: fingerprintsWithNames,
        stats: {
          total: totalFingerprints,
          assigned: assignedFingerprints,
          needsDecision,
        }
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error fetching fingerprints:", error);
      res.status(500).json({ error: "Failed to fetch fingerprints" });
    }
  });

  // Get fingerprint stats only (lightweight - for summary cards)
  app.get("/api/fingerprints/stats", requireAuth, async (req, res) => {
    try {
      const { fingerprints: fingerprintsTable, fingerprintModels, shipments: shipmentsTable } = await import("@shared/schema");
      
      // Fast query: count fingerprints with active shipments and packaging status
      // Only count fingerprints where at least one shipment is in 'ready_to_session' or 'fulfillment_prep' phase
      // This excludes on-hold orders (ready_to_fulfill), shipped orders, and delivered orders
      const statsResult = await db.execute(sql`
        WITH active_fingerprints AS (
          SELECT DISTINCT f.id, fm.packaging_type_id IS NOT NULL as has_packaging
          FROM fingerprints f
          INNER JOIN shipments s ON s.fingerprint_id = f.id 
            AND s.lifecycle_phase IN ('ready_to_session', 'fulfillment_prep')
          LEFT JOIN fingerprint_models fm ON fm.fingerprint_id = f.id
        )
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE has_packaging) as assigned,
          COUNT(*) FILTER (WHERE NOT has_packaging) as needs_decision
        FROM active_fingerprints
      `);
      
      const row = statsResult.rows?.[0] || {};
      
      res.json({
        total: Number(row.total) || 0,
        assigned: Number(row.assigned) || 0,
        needsDecision: Number(row.needs_decision) || 0,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch fingerprint stats" });
    }
  });

  // Get fingerprints that need mapping (no packaging assigned)
  // Only shows fingerprints with active orders (ready_to_session or fulfillment_prep phase)
  app.get("/api/fingerprints/needs-mapping", requireAuth, async (req, res) => {
    try {
      const { fingerprints: fingerprintsTable, fingerprintModels, packagingTypes, shipments: shipmentsTable, productCollections } = await import("@shared/schema");
      
      // Get fingerprints WITHOUT packaging assignment that have active shipments
      // Includes 'ready_to_session' and 'fulfillment_prep' phases
      // This excludes on-hold orders (ready_to_fulfill), shipped orders, and delivered orders
      const fingerprintsWithStats = await db
        .select({
          id: fingerprintsTable.id,
          signature: fingerprintsTable.signature,
          signatureHash: fingerprintsTable.signatureHash,
          displayName: fingerprintsTable.displayName,
          totalItems: fingerprintsTable.totalItems,
          collectionCount: fingerprintsTable.collectionCount,
          totalWeight: fingerprintsTable.totalWeight,
          weightUnit: fingerprintsTable.weightUnit,
          createdAt: fingerprintsTable.createdAt,
          shipmentCount: sql<number>`COUNT(DISTINCT ${shipmentsTable.id})`.as('shipment_count'),
        })
        .from(fingerprintsTable)
        .innerJoin(shipmentsTable, and(
          eq(shipmentsTable.fingerprintId, fingerprintsTable.id),
          inArray(shipmentsTable.lifecyclePhase, ['ready_to_session', 'fulfillment_prep'])
        ))
        .leftJoin(fingerprintModels, eq(fingerprintModels.fingerprintId, fingerprintsTable.id))
        .where(isNull(fingerprintModels.packagingTypeId))
        .groupBy(
          fingerprintsTable.id,
          fingerprintsTable.signature,
          fingerprintsTable.signatureHash,
          fingerprintsTable.displayName,
          fingerprintsTable.totalItems,
          fingerprintsTable.collectionCount,
          fingerprintsTable.totalWeight,
          fingerprintsTable.weightUnit,
          fingerprintsTable.createdAt
        )
        .orderBy(desc(sql`COUNT(DISTINCT ${shipmentsTable.id})`));
      
      // Parse signatures and build human-readable names
      const collectionsMap = new Map<string, string>();
      const allCollections = await db.select().from(productCollections);
      allCollections.forEach(c => collectionsMap.set(c.id, c.name));
      
      const fingerprintsWithNames = fingerprintsWithStats.map(fp => {
        let humanReadableName = fp.displayName;
        
        if (!humanReadableName && fp.signature) {
          try {
            const sig = JSON.parse(fp.signature) as Record<string, number>;
            const parts = Object.entries(sig)
              .sort((a, b) => b[1] - a[1])
              .map(([collectionId, qty]) => {
                const collectionName = collectionsMap.get(collectionId) || collectionId;
                return `${collectionName} (${qty})`;
              });
            humanReadableName = parts.join(' + ');
          } catch {
            humanReadableName = 'Unknown pattern';
          }
        }
        
        return {
          ...fp,
          humanReadableName: humanReadableName || 'Unknown pattern',
          hasPackaging: false,
          packagingTypeId: null,
          packagingTypeName: null,
          stationType: null,
        };
      });
      
      res.json({
        fingerprints: fingerprintsWithNames,
        count: fingerprintsWithNames.length,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error fetching needs-mapping:", error);
      res.status(500).json({ error: "Failed to fetch fingerprints needing mapping" });
    }
  });

  // Get fingerprints that are already mapped (have packaging assigned)
  app.get("/api/fingerprints/mapped", requireAuth, async (req, res) => {
    try {
      const { fingerprints: fingerprintsTable, fingerprintModels, packagingTypes, shipments: shipmentsTable, productCollections } = await import("@shared/schema");
      
      // Get fingerprints WITH packaging assignment that have active shipments
      const fingerprintsWithStats = await db
        .select({
          id: fingerprintsTable.id,
          signature: fingerprintsTable.signature,
          signatureHash: fingerprintsTable.signatureHash,
          displayName: fingerprintsTable.displayName,
          totalItems: fingerprintsTable.totalItems,
          collectionCount: fingerprintsTable.collectionCount,
          totalWeight: fingerprintsTable.totalWeight,
          weightUnit: fingerprintsTable.weightUnit,
          createdAt: fingerprintsTable.createdAt,
          shipmentCount: sql<number>`COUNT(DISTINCT ${shipmentsTable.id})`.as('shipment_count'),
          packagingTypeId: fingerprintModels.packagingTypeId,
          packagingTypeName: packagingTypes.name,
          stationType: packagingTypes.stationType,
        })
        .from(fingerprintsTable)
        .innerJoin(shipmentsTable, eq(shipmentsTable.fingerprintId, fingerprintsTable.id))
        .innerJoin(fingerprintModels, eq(fingerprintModels.fingerprintId, fingerprintsTable.id))
        .innerJoin(packagingTypes, eq(packagingTypes.id, fingerprintModels.packagingTypeId))
        .groupBy(
          fingerprintsTable.id,
          fingerprintsTable.signature,
          fingerprintsTable.signatureHash,
          fingerprintsTable.displayName,
          fingerprintsTable.totalItems,
          fingerprintsTable.collectionCount,
          fingerprintsTable.totalWeight,
          fingerprintsTable.weightUnit,
          fingerprintsTable.createdAt,
          fingerprintModels.packagingTypeId,
          packagingTypes.name,
          packagingTypes.stationType
        )
        .orderBy(desc(sql`COUNT(DISTINCT ${shipmentsTable.id})`));
      
      // Parse signatures and build human-readable names
      const collectionsMap = new Map<string, string>();
      const allCollections = await db.select().from(productCollections);
      allCollections.forEach(c => collectionsMap.set(c.id, c.name));
      
      const fingerprintsWithNames = fingerprintsWithStats.map(fp => {
        let humanReadableName = fp.displayName;
        
        if (!humanReadableName && fp.signature) {
          try {
            const sig = JSON.parse(fp.signature) as Record<string, number>;
            const parts = Object.entries(sig)
              .sort((a, b) => b[1] - a[1])
              .map(([collectionId, qty]) => {
                const collectionName = collectionsMap.get(collectionId) || collectionId;
                return `${collectionName} (${qty})`;
              });
            humanReadableName = parts.join(' + ');
          } catch {
            humanReadableName = 'Unknown pattern';
          }
        }
        
        return {
          ...fp,
          humanReadableName: humanReadableName || 'Unknown pattern',
          hasPackaging: true,
        };
      });
      
      res.json({
        fingerprints: fingerprintsWithNames,
        count: fingerprintsWithNames.length,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error fetching mapped:", error);
      res.status(500).json({ error: "Failed to fetch mapped fingerprints" });
    }
  });

  // Get packing-ready fingerprints with pagination, sorting, and filtering
  // These are fingerprints where at least one shipment is ready to pack (session closed, no tracking, pending status)
  app.get("/api/fingerprints/packing-ready", requireAuth, async (req, res) => {
    try {
      const { fingerprints: fingerprintsTable, fingerprintModels, packagingTypes, shipments: shipmentsTable, productCollections } = await import("@shared/schema");
      
      // Parse query params
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 25));
      const sortBy = (req.query.sortBy as string) || 'shipmentCount';
      const sortOrder = (req.query.sortOrder as string) === 'asc' ? 'asc' : 'desc';
      const searchQuery = (req.query.search as string) || '';
      const collectionFilter = (req.query.collection as string) || '';
      const packageFilter = (req.query.package as string) || '';
      
      // Build the base query for packing-ready shipments
      // Packing ready = sessionStatus='closed' AND trackingNumber IS NULL AND shipmentStatus='pending'
      const packingReadyCondition = and(
        eq(shipmentsTable.sessionStatus, 'closed'),
        isNull(shipmentsTable.trackingNumber),
        eq(shipmentsTable.shipmentStatus, 'pending')
      );
      
      // Get fingerprints with packing-ready shipment counts
      let baseQuery = db
        .select({
          id: fingerprintsTable.id,
          signature: fingerprintsTable.signature,
          signatureHash: fingerprintsTable.signatureHash,
          displayName: fingerprintsTable.displayName,
          totalItems: fingerprintsTable.totalItems,
          collectionCount: fingerprintsTable.collectionCount,
          totalWeight: fingerprintsTable.totalWeight,
          weightUnit: fingerprintsTable.weightUnit,
          createdAt: fingerprintsTable.createdAt,
          packingReadyCount: sql<number>`COUNT(DISTINCT ${shipmentsTable.id})`.as('packing_ready_count'),
          packagingTypeId: fingerprintModels.packagingTypeId,
          packagingTypeName: packagingTypes.name,
          stationType: packagingTypes.stationType,
        })
        .from(fingerprintsTable)
        .innerJoin(shipmentsTable, and(
          eq(shipmentsTable.fingerprintId, fingerprintsTable.id),
          packingReadyCondition
        ))
        .leftJoin(fingerprintModels, eq(fingerprintModels.fingerprintId, fingerprintsTable.id))
        .leftJoin(packagingTypes, eq(packagingTypes.id, fingerprintModels.packagingTypeId));
      
      // Apply filters
      const conditions: SQL[] = [];
      
      if (searchQuery) {
        conditions.push(
          or(
            sql`${fingerprintsTable.displayName} ILIKE ${`%${searchQuery}%`}`,
            sql`${fingerprintsTable.signature} ILIKE ${`%${searchQuery}%`}`
          )!
        );
      }
      
      if (packageFilter) {
        if (packageFilter === 'unassigned') {
          conditions.push(isNull(fingerprintModels.packagingTypeId));
        } else {
          conditions.push(eq(fingerprintModels.packagingTypeId, packageFilter));
        }
      }
      
      // Collection filter requires parsing the signature JSON
      // We'll filter this in memory after the query for simplicity
      
      // Group by fingerprint and packaging info
      const groupedQuery = baseQuery
        .groupBy(
          fingerprintsTable.id,
          fingerprintsTable.signature,
          fingerprintsTable.signatureHash,
          fingerprintsTable.displayName,
          fingerprintsTable.totalItems,
          fingerprintsTable.collectionCount,
          fingerprintsTable.totalWeight,
          fingerprintsTable.weightUnit,
          fingerprintsTable.createdAt,
          fingerprintModels.packagingTypeId,
          packagingTypes.name,
          packagingTypes.stationType
        );
      
      // Execute query to get all results first (for accurate total count and collection filtering)
      const allResults = await groupedQuery;
      
      // Parse signatures and build human-readable names, apply collection filter
      const collectionsMap = new Map<string, string>();
      const allCollections = await db.select().from(productCollections);
      allCollections.forEach(c => collectionsMap.set(c.id, c.name));
      
      let processedResults = allResults.map(fp => {
        let humanReadableName = fp.displayName;
        let collectionIds: string[] = [];
        
        if (fp.signature) {
          try {
            const sig = JSON.parse(fp.signature) as Record<string, number>;
            collectionIds = Object.keys(sig);
            const parts = Object.entries(sig)
              .sort((a, b) => b[1] - a[1])
              .map(([collectionId, qty]) => {
                const collectionName = collectionsMap.get(collectionId) || collectionId;
                return `${collectionName} (${qty})`;
              });
            humanReadableName = humanReadableName || parts.join(' + ');
          } catch {
            humanReadableName = humanReadableName || 'Unknown pattern';
          }
        }
        
        return {
          ...fp,
          humanReadableName: humanReadableName || 'Unknown pattern',
          hasPackaging: !!fp.packagingTypeId,
          collectionIds,
        };
      });
      
      // Apply collection filter in memory
      if (collectionFilter) {
        processedResults = processedResults.filter(fp => 
          fp.collectionIds.includes(collectionFilter)
        );
      }
      
      // Apply search filter in memory (for display name matching)
      if (searchQuery) {
        const lowerSearch = searchQuery.toLowerCase();
        processedResults = processedResults.filter(fp =>
          fp.humanReadableName.toLowerCase().includes(lowerSearch) ||
          (fp.packagingTypeName || '').toLowerCase().includes(lowerSearch)
        );
      }
      
      // Sort results
      processedResults.sort((a, b) => {
        let comparison = 0;
        switch (sortBy) {
          case 'weight':
            comparison = (a.totalWeight || 0) - (b.totalWeight || 0);
            break;
          case 'shipmentCount':
            comparison = a.packingReadyCount - b.packingReadyCount;
            break;
          case 'package':
            comparison = (a.packagingTypeName || 'zzz').localeCompare(b.packagingTypeName || 'zzz');
            break;
          case 'fingerprint':
            comparison = a.humanReadableName.localeCompare(b.humanReadableName);
            break;
          case 'collection':
            // Sort by first collection name
            const aCol = a.collectionIds[0] ? (collectionsMap.get(a.collectionIds[0]) || '') : '';
            const bCol = b.collectionIds[0] ? (collectionsMap.get(b.collectionIds[0]) || '') : '';
            comparison = aCol.localeCompare(bCol);
            break;
          default:
            comparison = a.packingReadyCount - b.packingReadyCount;
        }
        return sortOrder === 'asc' ? comparison : -comparison;
      });
      
      // Calculate pagination
      const total = processedResults.length;
      const totalPages = Math.ceil(total / pageSize);
      const offset = (page - 1) * pageSize;
      const paginatedResults = processedResults.slice(offset, offset + pageSize);
      
      // Get unique collections for filter dropdown
      const uniqueCollectionIds = new Set<string>();
      processedResults.forEach(fp => fp.collectionIds.forEach(id => uniqueCollectionIds.add(id)));
      const availableCollections = Array.from(uniqueCollectionIds).map(id => ({
        id,
        name: collectionsMap.get(id) || id,
      })).sort((a, b) => a.name.localeCompare(b.name));
      
      // Get unique packages for filter dropdown
      const uniquePackages = new Map<string, string>();
      processedResults.forEach(fp => {
        if (fp.packagingTypeId && fp.packagingTypeName) {
          uniquePackages.set(fp.packagingTypeId, fp.packagingTypeName);
        }
      });
      const availablePackages = Array.from(uniquePackages.entries()).map(([id, name]) => ({
        id,
        name,
      })).sort((a, b) => a.name.localeCompare(b.name));
      
      // Summary stats
      const stats = {
        totalFingerprints: total,
        totalPackingReady: processedResults.reduce((sum, fp) => sum + fp.packingReadyCount, 0),
        withPackaging: processedResults.filter(fp => fp.hasPackaging).length,
        withoutPackaging: processedResults.filter(fp => !fp.hasPackaging).length,
      };
      
      res.json({
        fingerprints: paginatedResults,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
        },
        filters: {
          availableCollections,
          availablePackages,
        },
        stats,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error fetching packing-ready:", error);
      res.status(500).json({ error: "Failed to fetch packing-ready fingerprints" });
    }
  });

  // Get all packaging types for dropdown or management
  app.get("/api/packaging-types", requireAuth, async (req, res) => {
    try {
      const { packagingTypes, shipments } = await import("@shared/schema");
      const includeInactive = req.query.includeInactive === 'true';
      
      // Get packaging types with fingerprint counts
      const typesWithCounts = await db
        .select({
          id: packagingTypes.id,
          name: packagingTypes.name,
          packageCode: packagingTypes.packageCode,
          packageId: packagingTypes.packageId,
          stationType: packagingTypes.stationType,
          dimensionLength: packagingTypes.dimensionLength,
          dimensionWidth: packagingTypes.dimensionWidth,
          dimensionHeight: packagingTypes.dimensionHeight,
          isActive: packagingTypes.isActive,
          fingerprintCount: sql<number>`COUNT(${shipments.id})::int`,
        })
        .from(packagingTypes)
        .leftJoin(shipments, eq(shipments.packagingTypeId, packagingTypes.id))
        .where(includeInactive ? undefined : eq(packagingTypes.isActive, true))
        .groupBy(packagingTypes.id)
        .orderBy(packagingTypes.name);
      
      res.json({ packagingTypes: typesWithCounts });
    } catch (error: any) {
      console.error("[Packaging Types] Error fetching:", error);
      res.status(500).json({ error: "Failed to fetch packaging types" });
    }
  });

  // Create a new packaging type
  app.post("/api/packaging-types", requireAuth, async (req, res) => {
    try {
      const { packagingTypes } = await import("@shared/schema");
      const { name, stationType, packageCode, dimensionLength, dimensionWidth, dimensionHeight } = req.body;

      if (!name?.trim()) {
        return res.status(400).json({ error: "Name is required" });
      }

      const [newType] = await db
        .insert(packagingTypes)
        .values({
          name: name.trim(),
          stationType: stationType || null,
          packageCode: packageCode || null,
          dimensionLength: dimensionLength || null,
          dimensionWidth: dimensionWidth || null,
          dimensionHeight: dimensionHeight || null,
        })
        .returning();

      console.log(`[Packaging Types] Created: ${newType.name} (${newType.stationType || 'no station type'})`);
      res.json(newType);
    } catch (error: any) {
      console.error("[Packaging Types] Error creating:", error);
      if (error.code === '23505') {
        res.status(400).json({ error: "A packaging type with this name already exists" });
      } else {
        res.status(500).json({ error: "Failed to create packaging type" });
      }
    }
  });

  // Update a packaging type
  app.patch("/api/packaging-types/:id", requireAuth, async (req, res) => {
    try {
      const { packagingTypes } = await import("@shared/schema");
      const { id } = req.params;
      const { name, stationType, packageCode, dimensionLength, dimensionWidth, dimensionHeight, isActive } = req.body;

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) updateData.name = name.trim();
      if (stationType !== undefined) updateData.stationType = stationType || null;
      if (packageCode !== undefined) updateData.packageCode = packageCode || null;
      if (dimensionLength !== undefined) updateData.dimensionLength = dimensionLength || null;
      if (dimensionWidth !== undefined) updateData.dimensionWidth = dimensionWidth || null;
      if (dimensionHeight !== undefined) updateData.dimensionHeight = dimensionHeight || null;
      if (isActive !== undefined) updateData.isActive = isActive;

      const [updated] = await db
        .update(packagingTypes)
        .set(updateData)
        .where(eq(packagingTypes.id, id))
        .returning();

      if (!updated) {
        return res.status(404).json({ error: "Packaging type not found" });
      }

      console.log(`[Packaging Types] Updated: ${updated.name} (${updated.stationType || 'no station type'})`);
      res.json(updated);
    } catch (error: any) {
      console.error("[Packaging Types] Error updating:", error);
      if (error.code === '23505') {
        res.status(400).json({ error: "A packaging type with this name already exists" });
      } else {
        res.status(500).json({ error: "Failed to update packaging type" });
      }
    }
  });

  // Assign packaging type to fingerprint
  app.post("/api/fingerprints/:fingerprintId/assign", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const { fingerprintId } = req.params;
      const { packagingTypeId, notes } = req.body;
      
      if (!packagingTypeId) {
        return res.status(400).json({ error: "packagingTypeId is required" });
      }
      
      const { fingerprintModels, fingerprints: fingerprintsTable, packagingTypes, shipments: shipmentsTable, stations } = await import("@shared/schema");
      
      // Check if fingerprint exists
      const [fingerprint] = await db.select().from(fingerprintsTable).where(eq(fingerprintsTable.id, fingerprintId));
      if (!fingerprint) {
        return res.status(404).json({ error: "Fingerprint not found" });
      }
      
      // Check if packaging type exists
      const [packagingType] = await db.select().from(packagingTypes).where(eq(packagingTypes.id, packagingTypeId));
      if (!packagingType) {
        return res.status(404).json({ error: "Packaging type not found" });
      }
      
      // Look up station by stationType (auto station assignment)
      let assignedStationId: string | null = null;
      if (packagingType.stationType) {
        const [station] = await db
          .select()
          .from(stations)
          .where(and(
            eq(stations.stationType, packagingType.stationType),
            eq(stations.isActive, true)
          ))
          .limit(1);
        
        if (station) {
          assignedStationId = station.id;
          console.log(`[Station Assignment] Found station ${station.name} (${station.stationType}) for packaging ${packagingType.name}`);
        } else {
          console.warn(`[Station Assignment] No active station found for stationType: ${packagingType.stationType}`);
        }
      }
      
      // Upsert the fingerprint model (one model per fingerprint)
      const existingModel = await db.select().from(fingerprintModels).where(eq(fingerprintModels.fingerprintId, fingerprintId));
      
      let model;
      if (existingModel.length > 0) {
        // Update existing
        [model] = await db
          .update(fingerprintModels)
          .set({
            packagingTypeId,
            notes: notes || null,
            updatedAt: new Date(),
          })
          .where(eq(fingerprintModels.fingerprintId, fingerprintId))
          .returning();
      } else {
        // Create new
        [model] = await db
          .insert(fingerprintModels)
          .values({
            fingerprintId,
            packagingTypeId,
            createdBy: userId,
            notes: notes || null,
            confidence: 'manual',
          })
          .returning();
      }
      
      // Update all shipments with this fingerprint to have the packaging type and assigned station
      const updateData: Record<string, any> = {
        packagingTypeId,
        packagingDecisionType: 'auto',
        updatedAt: new Date(),
      };
      if (assignedStationId) {
        updateData.assignedStationId = assignedStationId;
      }
      
      const updatedShipments = await db
        .update(shipmentsTable)
        .set(updateData)
        .where(eq(shipmentsTable.fingerprintId, fingerprintId))
        .returning({ id: shipmentsTable.id });
      
      // Update lifecycle phase for all affected shipments (they may move from needs_packaging to needs_session)
      if (updatedShipments.length > 0) {
        const shipmentIds = updatedShipments.map(s => s.id);
        await updateShipmentLifecycleBatch(shipmentIds);
        
        // Queue lifecycle events with 'packaging' reason to trigger package sync side effect
        // This enables the auto_package_sync feature to push dimensions to ShipStation
        await queueLifecycleEvaluationBatch(
          shipmentIds.map(id => ({ shipmentId: id })),
          'packaging'
        );
        console.log(`[Fingerprints] Queued ${shipmentIds.length} lifecycle events with 'packaging' reason for package sync`);
      }
      
      // Re-run rate analysis for shipments that used fallback package details
      // Now that we have the actual package assignment, the rates may be more accurate
      let rateAnalysisRerun = 0;
      try {
        const { shipmentRateAnalysis, shipments: shipmentsSchema } = await import("@shared/schema");
        const { smartCarrierRateService } = await import("./services/smart-carrier-rate-service");
        
        // Find shipments with this fingerprint that have rate analysis using fallback
        const shipmentsNeedingReanalysis = await db
          .select({
            id: shipmentsSchema.id,
            shipmentId: shipmentsSchema.shipmentId,
          })
          .from(shipmentsSchema)
          .innerJoin(shipmentRateAnalysis, eq(shipmentRateAnalysis.shipmentId, shipmentsSchema.shipmentId))
          .where(and(
            eq(shipmentsSchema.fingerprintId, fingerprintId),
            eq(shipmentRateAnalysis.usedFallbackPackageDetails, true)
          ));
        
        if (shipmentsNeedingReanalysis.length > 0) {
          console.log(`[Fingerprints] Re-running rate analysis for ${shipmentsNeedingReanalysis.length} shipments that used fallback package data`);
          
          for (const s of shipmentsNeedingReanalysis) {
            // Fetch full shipment for analysis
            const [fullShipment] = await db
              .select()
              .from(shipmentsSchema)
              .where(eq(shipmentsSchema.id, s.id))
              .limit(1);
            
            if (fullShipment) {
              const result = await smartCarrierRateService.analyzeAndSave(fullShipment);
              if (result.success) {
                rateAnalysisRerun++;
              }
            }
          }
          
          console.log(`[Fingerprints] Successfully re-analyzed ${rateAnalysisRerun}/${shipmentsNeedingReanalysis.length} shipments with new package data`);
        }
      } catch (rateError: any) {
        console.warn(`[Fingerprints] Error re-running rate analysis:`, rateError.message);
      }
      
      console.log(`[Fingerprints] Assigned packaging ${packagingType.name} to fingerprint ${fingerprintId}, updated ${updatedShipments.length} shipments${assignedStationId ? ` (station: ${assignedStationId})` : ''}${rateAnalysisRerun > 0 ? `, re-analyzed ${rateAnalysisRerun} rates` : ''}`);
      
      res.json({
        success: true,
        model,
        shipmentsUpdated: updatedShipments.length,
        packagingTypeName: packagingType.name,
        assignedStationId,
        rateAnalysisRerun,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error assigning packaging:", error);
      res.status(500).json({ error: "Failed to assign packaging to fingerprint" });
    }
  });

  // Bulk assign packaging type to multiple fingerprints
  app.post("/api/fingerprints/bulk-assign", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      const { fingerprintIds, packagingTypeId } = req.body;
      
      if (!fingerprintIds || !Array.isArray(fingerprintIds) || fingerprintIds.length === 0) {
        return res.status(400).json({ error: "fingerprintIds array is required" });
      }
      if (!packagingTypeId) {
        return res.status(400).json({ error: "packagingTypeId is required" });
      }
      
      const { fingerprintModels, fingerprints: fingerprintsTable, packagingTypes, shipments: shipmentsTable, stations } = await import("@shared/schema");
      
      // Check if packaging type exists
      const [packagingType] = await db.select().from(packagingTypes).where(eq(packagingTypes.id, packagingTypeId));
      if (!packagingType) {
        return res.status(404).json({ error: "Packaging type not found" });
      }
      
      // Look up station by stationType (auto station assignment)
      let assignedStationId: string | null = null;
      if (packagingType.stationType) {
        const [station] = await db
          .select()
          .from(stations)
          .where(and(
            eq(stations.stationType, packagingType.stationType),
            eq(stations.isActive, true)
          ))
          .limit(1);
        
        if (station) {
          assignedStationId = station.id;
          console.log(`[Bulk Assign] Found station ${station.name} (${station.stationType}) for packaging ${packagingType.name}`);
        }
      }
      
      let totalFingerprintsAssigned = 0;
      let totalShipmentsUpdated = 0;
      const allShipmentIds: string[] = [];
      
      // Process each fingerprint
      for (const fingerprintId of fingerprintIds) {
        // Check if fingerprint exists
        const [fingerprint] = await db.select().from(fingerprintsTable).where(eq(fingerprintsTable.id, fingerprintId));
        if (!fingerprint) {
          console.warn(`[Bulk Assign] Fingerprint ${fingerprintId} not found, skipping`);
          continue;
        }
        
        // Upsert the fingerprint model
        const existingModel = await db.select().from(fingerprintModels).where(eq(fingerprintModels.fingerprintId, fingerprintId));
        
        if (existingModel.length > 0) {
          await db
            .update(fingerprintModels)
            .set({
              packagingTypeId,
              updatedAt: new Date(),
            })
            .where(eq(fingerprintModels.fingerprintId, fingerprintId));
        } else {
          await db
            .insert(fingerprintModels)
            .values({
              fingerprintId,
              packagingTypeId,
              createdBy: userId,
              confidence: 'manual',
            });
        }
        
        totalFingerprintsAssigned++;
        
        // Update all shipments with this fingerprint
        const updateData: Record<string, any> = {
          packagingTypeId,
          packagingDecisionType: 'auto',
          updatedAt: new Date(),
        };
        if (assignedStationId) {
          updateData.assignedStationId = assignedStationId;
        }
        
        const updatedShipments = await db
          .update(shipmentsTable)
          .set(updateData)
          .where(eq(shipmentsTable.fingerprintId, fingerprintId))
          .returning({ id: shipmentsTable.id });
        
        totalShipmentsUpdated += updatedShipments.length;
        allShipmentIds.push(...updatedShipments.map(s => s.id));
      }
      
      // Update lifecycle phase for all affected shipments
      if (allShipmentIds.length > 0) {
        await updateShipmentLifecycleBatch(allShipmentIds);
      }
      
      console.log(`[Bulk Assign] Assigned packaging ${packagingType.name} to ${totalFingerprintsAssigned} fingerprints, updated ${totalShipmentsUpdated} shipments`);
      
      res.json({
        success: true,
        fingerprintsAssigned: totalFingerprintsAssigned,
        shipmentsUpdated: totalShipmentsUpdated,
        packagingTypeName: packagingType.name,
        assignedStationId,
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error bulk assigning packaging:", error);
      res.status(500).json({ error: "Failed to bulk assign packaging" });
    }
  });

  // Get shipments and products for a fingerprint (for the shipment count modal)
  app.get("/api/fingerprints/:fingerprintId/shipments", requireAuth, async (req, res) => {
    try {
      const { fingerprintId } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;
      
      // Check if fingerprint exists
      const [fingerprint] = await db
        .select()
        .from(fingerprints)
        .where(eq(fingerprints.id, fingerprintId));
      
      if (!fingerprint) {
        return res.status(404).json({ error: "Fingerprint not found" });
      }
      
      // Get total count of shipments with this fingerprint
      const countResult = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(shipments)
        .where(eq(shipments.fingerprintId, fingerprintId));
      const totalCount = countResult[0]?.count || 0;
      
      // Get paginated shipments with this fingerprint
      const paginatedShipments = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
          shipmentId: shipments.shipmentId,
          trackingNumber: shipments.trackingNumber,
          status: shipments.status,
          createdAt: shipments.createdAt,
        })
        .from(shipments)
        .where(eq(shipments.fingerprintId, fingerprintId))
        .orderBy(desc(shipments.createdAt))
        .limit(limit)
        .offset(offset);
      
      // Get all shipments for product grouping (existing logic)
      const shipmentsWithOrders = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
        })
        .from(shipments)
        .where(eq(shipments.fingerprintId, fingerprintId))
        .orderBy(shipments.createdAt);
      
      // Get products with their associated order numbers
      const shipmentIds = shipmentsWithOrders.map(s => s.id);
      const shipmentIdToOrderNumber = new Map(shipmentsWithOrders.map(s => [s.id, s.orderNumber]));
      
      let products: { sku: string; title: string | null; weight: string | null; orderNumbers: string[] }[] = [];
      
      if (shipmentIds.length > 0) {
        const qcItemsRaw = await db
          .select({
            shipmentId: shipmentQcItems.shipmentId,
            sku: shipmentQcItems.sku,
            description: shipmentQcItems.description,
            weightValue: shipmentQcItems.weightValue,
            weightUnit: shipmentQcItems.weightUnit,
          })
          .from(shipmentQcItems)
          .where(inArray(shipmentQcItems.shipmentId, shipmentIds));
        
        // Group by SKU with list of order numbers
        const productMap = new Map<string, { sku: string; title: string | null; weight: string | null; orderNumbers: Set<string> }>();
        for (const item of qcItemsRaw) {
          const orderNumber = shipmentIdToOrderNumber.get(item.shipmentId);
          if (!orderNumber) continue;
          
          const existing = productMap.get(item.sku);
          if (existing) {
            existing.orderNumbers.add(orderNumber);
          } else {
            const weight = item.weightValue && item.weightUnit 
              ? `${item.weightValue}${item.weightUnit}` 
              : null;
            productMap.set(item.sku, {
              sku: item.sku,
              title: item.description,
              weight,
              orderNumbers: new Set([orderNumber]),
            });
          }
        }
        products = Array.from(productMap.values())
          .map(p => ({ ...p, orderNumbers: Array.from(p.orderNumbers).sort() }))
          .sort((a, b) => a.sku.localeCompare(b.sku));
      }
      
      res.json({
        fingerprint: {
          id: fingerprint.id,
          displayName: fingerprint.displayName,
          signature: fingerprint.signature,
        },
        shipments: paginatedShipments,
        products,
        totalShipments: totalCount,
        uniqueProducts: products.length,
        pagination: {
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error: any) {
      console.error("[Fingerprints] Error getting shipments:", error);
      res.status(500).json({ error: "Failed to get fingerprint shipments" });
    }
  });

  // ============================================================================
  // Fulfillment Sessions API - Smart Shipping Engine (Phase 6 Step 3)
  // ============================================================================

  // Get all orders in ready-to-session phase with their session readiness status
  app.get("/api/fulfillment-sessions/ready-to-session-orders", requireAuth, async (req, res) => {
    try {
      // Get all orders that are ready to be added to a session
      // Uses lifecycle_phase column as single source of truth
      // Left join with fingerprint_models to check if fingerprint has packaging assigned
      // Also join fingerprints to get display name for packaging assignment messages
      const readyToSessionOrders = await db
        .select({
          id: shipments.id,
          shipmentId: shipments.shipmentId,
          orderNumber: shipments.orderNumber,
          fingerprintId: shipments.fingerprintId,
          fingerprintStatus: shipments.fingerprintStatus,
          assignedStationId: shipments.assignedStationId,
          decisionSubphase: shipments.decisionSubphase,
          lifecyclePhase: shipments.lifecyclePhase,
          fingerprintModelId: fingerprintModels.id,
          fingerprintDisplayName: fingerprints.displayName,
          fingerprintSignature: fingerprints.signature,
          packagingStationType: packagingTypes.stationType,
          shipToName: shipments.shipToName,
          shipToAddressLine1: shipments.shipToAddressLine1,
          shipToCity: shipments.shipToCity,
          shipToPostalCode: shipments.shipToPostalCode,
        })
        .from(shipments)
        .leftJoin(fingerprints, eq(shipments.fingerprintId, fingerprints.id))
        .leftJoin(fingerprintModels, eq(shipments.fingerprintId, fingerprintModels.fingerprintId))
        .leftJoin(packagingTypes, eq(fingerprintModels.packagingTypeId, packagingTypes.id))
        .where(
          // Use lifecycle_phase as single source of truth
          eq(shipments.lifecyclePhase, 'ready_to_session')
        )
        .orderBy(asc(shipments.orderNumber));

      // Get shipment IDs that need categorization (no fingerprint)
      const shipmentIdsNeedingCategorization = readyToSessionOrders
        .filter(o => !o.fingerprintId)
        .map(o => o.id);

      // Batch query uncategorized SKUs for all orders that need categorization
      let uncategorizedSkusByShipment = new Map<string, string[]>();
      if (shipmentIdsNeedingCategorization.length > 0) {
        const uncategorizedItems = await db
          .select({
            shipmentId: shipmentQcItems.shipmentId,
            sku: shipmentQcItems.sku,
          })
          .from(shipmentQcItems)
          .where(
            and(
              sql`${shipmentQcItems.shipmentId} IN (${sql.raw(shipmentIdsNeedingCategorization.map(id => `'${id}'`).join(','))})`,
              isNull(shipmentQcItems.collectionId)
            )
          );

        // Group by shipment
        for (const item of uncategorizedItems) {
          const existing = uncategorizedSkusByShipment.get(item.shipmentId) || [];
          if (!existing.includes(item.sku)) {
            existing.push(item.sku);
          }
          uncategorizedSkusByShipment.set(item.shipmentId, existing);
        }
      }

      // Batch query SKUs with missing weight for orders with fingerprint_status = 'missing_weight'
      const shipmentIdsWithMissingWeight = readyToSessionOrders
        .filter(o => o.fingerprintStatus === 'missing_weight')
        .map(o => o.id);

      let missingWeightSkusByShipment = new Map<string, string[]>();
      if (shipmentIdsWithMissingWeight.length > 0) {
        // Get all QC items for these shipments and join with skuvault_products to find SKUs missing weight
        const { skuvaultProducts } = await import("@shared/schema");
        const qcItemsForWeightCheck = await db
          .select({
            shipmentId: shipmentQcItems.shipmentId,
            sku: shipmentQcItems.sku,
            catalogWeight: skuvaultProducts.weightValue,
          })
          .from(shipmentQcItems)
          .leftJoin(skuvaultProducts, eq(shipmentQcItems.sku, skuvaultProducts.sku))
          .where(
            sql`${shipmentQcItems.shipmentId} IN (${sql.raw(shipmentIdsWithMissingWeight.map(id => `'${id}'`).join(','))})`
          );

        // Group by shipment - only include SKUs where weight is null or 0
        for (const item of qcItemsForWeightCheck) {
          if (item.catalogWeight === null || item.catalogWeight === 0) {
            const existing = missingWeightSkusByShipment.get(item.shipmentId) || [];
            if (!existing.includes(item.sku)) {
              existing.push(item.sku);
            }
            missingWeightSkusByShipment.set(item.shipmentId, existing);
          }
        }
      }

      // Get collection names for building human-readable fingerprint names
      const { productCollections, stations } = await import("@shared/schema");
      const allCollections = await db.select().from(productCollections);
      const collectionsMap = new Map<string, string>();
      allCollections.forEach(c => collectionsMap.set(c.id, c.name));

      // Batch fetch station names for orders that have assigned stations
      const stationIds = [...new Set(readyToSessionOrders.map(o => o.assignedStationId).filter((id): id is string => !!id))];
      const stationsMap = new Map<string, { name: string; stationType: string | null }>();
      if (stationIds.length > 0) {
        const stationRows = await db
          .select({ id: stations.id, name: stations.name, stationType: stations.stationType })
          .from(stations)
          .where(inArray(stations.id, stationIds));
        stationRows.forEach(s => stationsMap.set(s.id, { name: s.name, stationType: s.stationType }));
      }

      // Batch fetch tags for all orders
      const allShipmentIds = readyToSessionOrders.map(o => o.id);
      let tagsByShipment = new Map<string, { name: string; color: string | null }[]>();
      
      if (allShipmentIds.length > 0) {
        const allTags = await db
          .select({
            shipmentId: shipmentTags.shipmentId,
            name: shipmentTags.name,
            color: shipmentTags.color,
          })
          .from(shipmentTags)
          .where(
            sql`${shipmentTags.shipmentId} IN (${sql.raw(allShipmentIds.map(id => `'${id}'`).join(','))})`
          );

        // Group by shipment
        for (const tag of allTags) {
          const existing = tagsByShipment.get(tag.shipmentId) || [];
          existing.push({ name: tag.name, color: tag.color });
          tagsByShipment.set(tag.shipmentId, existing);
        }
      }

      // Batch query inventory availability for all SKUs in these orders
      // Check if any order has SKUs with available_quantity <= 0 (unfulfillable)
      let unfulfillableSkusByShipment = new Map<string, string[]>();
      
      if (allShipmentIds.length > 0) {
        // Get all SKUs for all shipments
        const allQcItems = await db
          .select({
            shipmentId: shipmentQcItems.shipmentId,
            sku: shipmentQcItems.sku,
          })
          .from(shipmentQcItems)
          .where(
            sql`${shipmentQcItems.shipmentId} IN (${sql.raw(allShipmentIds.map(id => `'${id}'`).join(','))})`
          );

        // Get unique SKUs to check inventory
        const uniqueSkus = [...new Set(allQcItems.map(item => item.sku))];
        
        if (uniqueSkus.length > 0) {
          // Query skuvault_products for available_quantity
          const { skuvaultProducts } = await import("@shared/schema");
          const inventoryData = await db
            .select({
              sku: skuvaultProducts.sku,
              availableQuantity: skuvaultProducts.availableQuantity,
            })
            .from(skuvaultProducts)
            .where(inArray(skuvaultProducts.sku, uniqueSkus));
          
          // Build SKU -> available_quantity map
          const inventoryMap = new Map<string, number>();
          inventoryData.forEach(inv => inventoryMap.set(inv.sku, inv.availableQuantity));
          
          // Check each shipment's SKUs for unfulfillable items
          for (const item of allQcItems) {
            const available = inventoryMap.get(item.sku);
            // SKU is unfulfillable if available_quantity is 0 or below, or SKU not found in inventory
            if (available === undefined || available <= 0) {
              const existing = unfulfillableSkusByShipment.get(item.shipmentId) || [];
              if (!existing.includes(item.sku)) {
                existing.push(item.sku);
              }
              unfulfillableSkusByShipment.set(item.shipmentId, existing);
            }
          }
        }
      }

      // Helper to build human-readable fingerprint name from signature
      const buildFingerprintName = (displayName: string | null, signature: string | null): string => {
        if (displayName) return displayName;
        if (!signature) return 'Unknown pattern';
        try {
          const sig = JSON.parse(signature) as Record<string, number>;
          const parts = Object.entries(sig)
            .sort((a, b) => b[1] - a[1])
            .map(([collectionId, qty]) => {
              const collectionName = collectionsMap.get(collectionId) || collectionId;
              return `${collectionName} (${qty})`;
            });
          return parts.join(' + ');
        } catch {
          return 'Unknown pattern';
        }
      };

      // Build duplicate address detection map - O(n) hash map approach
      // Normalize address: lowercase(name + address1 + city + zip)
      const normalizeAddress = (name: string | null, address1: string | null, city: string | null, zip: string | null): string => {
        return [name, address1, city, zip]
          .map(s => (s || '').toLowerCase().trim())
          .join('|');
      };
      
      // First pass: map normalized address -> first order number seen
      const addressToFirstOrder = new Map<string, string>();
      for (const order of readyToSessionOrders) {
        const addressKey = normalizeAddress(
          order.shipToName,
          order.shipToAddressLine1,
          order.shipToCity,
          order.shipToPostalCode
        );
        if (addressKey && !addressToFirstOrder.has(addressKey)) {
          addressToFirstOrder.set(addressKey, order.orderNumber);
        }
      }

      // Evaluate each order's session readiness and provide actionable reason
      const ordersWithStatus = readyToSessionOrders.map(order => {
        let readyToSession = false;
        let reason = '';
        let actionTab: string | null = null;

        // Check for unfulfillable SKUs - show warning but still allow sessioning
        const unfulfillableSkus = unfulfillableSkusByShipment.get(order.id) || [];
        const hasOutOfStockWarning = unfulfillableSkus.length > 0;
        if (hasOutOfStockWarning) {
          const displaySkus = unfulfillableSkus.slice(0, 3);
          const remaining = unfulfillableSkus.length - 3;
          reason = `Out of stock: ${displaySkus.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
        }
        
        if (!order.fingerprintId) {
          // Order needs fingerprint - check why in priority order
          const uncategorizedSkus = uncategorizedSkusByShipment.get(order.id) || [];
          const missingWeightSkus = missingWeightSkusByShipment.get(order.id) || [];
          
          if (uncategorizedSkus.length > 0) {
            // SKUs missing collection assignment - highest priority fix
            const displaySkus = uncategorizedSkus.slice(0, 3);
            const remaining = uncategorizedSkus.length - 3;
            reason = `Missing Collection: ${displaySkus.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
            actionTab = 'categorize';
          } else if (missingWeightSkus.length > 0 || order.fingerprintStatus === 'missing_weight') {
            // SKUs missing weight data
            if (missingWeightSkus.length > 0) {
              const displaySkus = missingWeightSkus.slice(0, 3);
              const remaining = missingWeightSkus.length - 3;
              reason = `Missing Weight: ${displaySkus.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
            } else {
              reason = 'Missing Weight: Check product catalog';
            }
            actionTab = 'categorize';
          } else if (order.fingerprintStatus === 'pending_categorization') {
            // Still being processed - check for any issues
            reason = 'Pending categorization - check for uncategorized SKUs';
            actionTab = 'categorize';
          } else if (order.fingerprintStatus === 'needs_recalc') {
            // Fingerprint needs recalculation - will auto-resolve
            reason = 'Fingerprint recalculating...';
            actionTab = null;
          } else {
            // Genuinely being processed - show more specific status
            reason = `Processing (${order.fingerprintStatus || 'analyzing'})`;
            actionTab = null;
          }
        } else if (!order.fingerprintModelId) {
          // Fingerprint exists but no packaging assigned
          const fpName = buildFingerprintName(order.fingerprintDisplayName, order.fingerprintSignature);
          reason = `Assign packaging to: ${fpName}`;
          actionTab = 'packaging';
        } else if (!order.assignedStationId) {
          // Packaging exists but no station - show packaging type for context
          const stationTypeLabel = order.packagingStationType === 'boxing_machine' ? 'Boxer' 
            : order.packagingStationType === 'poly_bag' ? 'Bagger' 
            : order.packagingStationType === 'hand_pack' ? 'Hand Pack' 
            : 'Unknown';
          reason = `Needs workstation assignment (${stationTypeLabel})`;
          actionTab = 'packaging';
        } else {
          // Has fingerprint + packaging model + station = ready for session
          // We derive readiness from actual data fields, not the potentially-stale decisionSubphase column
          readyToSession = true;
          if (!hasOutOfStockWarning) {
            reason = 'Ready for session';
          }
        }

        const stationInfo = order.assignedStationId ? stationsMap.get(order.assignedStationId) : null;
        
        // Build a search term for linking to packaging tab - use displayName or first collection name from signature
        let fingerprintSearchTerm: string | null = null;
        if (actionTab === 'packaging' && order.fingerprintId) {
          if (order.fingerprintDisplayName) {
            fingerprintSearchTerm = order.fingerprintDisplayName;
          } else if (order.fingerprintSignature) {
            try {
              const sig = JSON.parse(order.fingerprintSignature) as Record<string, number>;
              // Get first collection name as search term
              const firstCollectionId = Object.keys(sig)[0];
              if (firstCollectionId) {
                fingerprintSearchTerm = collectionsMap.get(firstCollectionId) || null;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
        
        // Get tags for this order
        const orderTags = tagsByShipment.get(order.id) || [];
        
        // Check for duplicate address - if this order's address matches another order,
        // and that other order is not this order, mark as duplicate
        const addressKey = normalizeAddress(
          order.shipToName,
          order.shipToAddressLine1,
          order.shipToCity,
          order.shipToPostalCode
        );
        const firstOrderWithAddress = addressToFirstOrder.get(addressKey);
        const duplicateOf = (firstOrderWithAddress && firstOrderWithAddress !== order.orderNumber) 
          ? firstOrderWithAddress 
          : null;
        
        // Build actionUrl for direct navigation based on actionTab
        let actionUrl: string | null = null;
        if (!readyToSession && actionTab) {
          switch (actionTab) {
            case 'out_of_stock':
              // Out of stock - link to shipment details page
              if (order.shipmentId) {
                actionUrl = `/shipments/${order.shipmentId}`;
              }
              break;
            case 'categorize':
              // Missing collection or weight - link to categorize tab
              actionUrl = '/fulfillment-prep/categorize';
              break;
            case 'packaging':
              // Need packaging mapping - link to Packaging tab with fingerprint search
              if (fingerprintSearchTerm) {
                actionUrl = `/fulfillment-prep/packaging/needs-mapping?search=${encodeURIComponent(fingerprintSearchTerm)}`;
              } else {
                actionUrl = '/fulfillment-prep/packaging/needs-mapping';
              }
              break;
            default:
              // No specific action - null URL
              break;
          }
        }
        
        return {
          orderNumber: order.orderNumber,
          shipmentId: order.shipmentId,
          readyToSession,
          reason,
          actionTab,
          actionUrl,
          fingerprintSearchTerm,
          stationName: stationInfo?.name || null,
          stationType: stationInfo?.stationType || null,
          tags: orderTags,
          duplicateOf,
        };
      });

      // Calculate summary stats
      const readyCount = ordersWithStatus.filter(o => o.readyToSession).length;
      const notReadyCount = ordersWithStatus.filter(o => !o.readyToSession).length;

      res.json({
        orders: ordersWithStatus,
        stats: {
          total: ordersWithStatus.length,
          ready: readyCount,
          notReady: notReadyCount,
        },
      });
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error getting ready-to-session orders:", error);
      res.status(500).json({ error: "Failed to get ready-to-session orders" });
    }
  });

  // Preview sessionable shipments and potential session groupings
  app.get("/api/fulfillment-sessions/preview", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const { stationType } = req.query;
      
      const preview = await fulfillmentSessionService.previewSessions(
        stationType as string | undefined
      );
      
      res.json({
        success: true,
        preview,
        totalOrders: preview.reduce((sum, p) => sum + p.orderCount, 0),
      });
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error getting preview:", error);
      res.status(500).json({ error: "Failed to get session preview" });
    }
  });

  // Build fulfillment sessions from sessionable shipments
  app.post("/api/fulfillment-sessions/build", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }
      
      console.log(`[FulfillmentSessions] Build request from user ${userId}:`, JSON.stringify(req.body));
      
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const { stationType, dryRun, orderNumbers } = req.body;
      
      const result = await fulfillmentSessionService.buildSessions(userId, {
        stationType: stationType as string | undefined,
        dryRun: dryRun === true,
        orderNumbers: Array.isArray(orderNumbers) ? orderNumbers : undefined,
      });
      
      console.log(`[FulfillmentSessions] Build result: ${result.sessionsCreated} sessions, ${result.shipmentsAssigned} assigned, ${result.shipmentsSkipped} skipped, errors: [${result.errors.join(', ')}]`);
      
      if (!result.success) {
        return res.status(400).json({
          success: false,
          errors: result.errors,
        });
      }
      
      res.json(result);
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error building sessions:", error);
      res.status(500).json({ error: "Failed to build sessions" });
    }
  });

  // Get all fulfillment sessions with optional status filter
  app.get("/api/fulfillment-sessions", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const { FULFILLMENT_SESSION_STATUSES } = await import("@shared/schema");
      const { status } = req.query;
      
      // Validate status if provided
      if (status && !FULFILLMENT_SESSION_STATUSES.includes(status as any)) {
        return res.status(400).json({ 
          error: `Invalid status. Must be one of: ${FULFILLMENT_SESSION_STATUSES.join(', ')}` 
        });
      }
      
      const sessions = await fulfillmentSessionService.getSessions(status as any);
      res.json(sessions);
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error getting sessions:", error);
      res.status(500).json({ error: "Failed to get sessions" });
    }
  });

  // Paginated fulfillment sessions search for Smart Sessions page
  app.get("/api/smart-sessions", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessions, stations, FULFILLMENT_SESSION_STATUSES } = await import("@shared/schema");
      
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const offset = (page - 1) * limit;
      const search = (req.query.search as string || "").trim();
      const status = req.query.status as string;
      const stationType = req.query.stationType as string;
      const sortBy = (req.query.sortBy as string) || "createdAt";
      const sortOrder = (req.query.sortOrder as string) || "desc";
      
      // Build conditions
      const conditions: any[] = [];
      
      if (status && status !== "all" && FULFILLMENT_SESSION_STATUSES.includes(status as any)) {
        conditions.push(eq(fulfillmentSessions.status, status));
      }
      
      if (stationType && stationType !== "all") {
        conditions.push(eq(fulfillmentSessions.stationType, stationType));
      }
      
      if (search) {
        conditions.push(
          or(
            ilike(fulfillmentSessions.name, `%${search}%`),
            ilike(fulfillmentSessions.id, `%${search}%`),
            sql`CAST(${fulfillmentSessions.sequenceNumber} AS TEXT) ILIKE ${`%${search}%`}`
          )
        );
      }
      
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      
      // Get total count
      const countResult = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(fulfillmentSessions)
        .where(whereClause);
      const totalCount = countResult[0]?.count || 0;
      
      // Build sort order
      const sortColumn = {
        createdAt: fulfillmentSessions.createdAt,
        orderCount: fulfillmentSessions.orderCount,
        status: fulfillmentSessions.status,
        stationType: fulfillmentSessions.stationType,
        sequenceNumber: fulfillmentSessions.sequenceNumber,
      }[sortBy] || fulfillmentSessions.createdAt;
      
      const orderDirection = sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
      
      // Get paginated sessions with station info
      const sessions = await db
        .select({
          id: fulfillmentSessions.id,
          name: fulfillmentSessions.name,
          sequenceNumber: fulfillmentSessions.sequenceNumber,
          stationId: fulfillmentSessions.stationId,
          stationType: fulfillmentSessions.stationType,
          orderCount: fulfillmentSessions.orderCount,
          maxOrders: fulfillmentSessions.maxOrders,
          status: fulfillmentSessions.status,
          createdAt: fulfillmentSessions.createdAt,
          updatedAt: fulfillmentSessions.updatedAt,
          readyAt: fulfillmentSessions.readyAt,
          pickingStartedAt: fulfillmentSessions.pickingStartedAt,
          packingStartedAt: fulfillmentSessions.packingStartedAt,
          completedAt: fulfillmentSessions.completedAt,
          createdBy: fulfillmentSessions.createdBy,
          stationName: stations.name,
        })
        .from(fulfillmentSessions)
        .leftJoin(stations, eq(fulfillmentSessions.stationId, stations.id))
        .where(whereClause)
        .orderBy(orderDirection)
        .limit(limit)
        .offset(offset);
      
      res.json({
        sessions,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error: any) {
      console.error("[SmartSessions] Error getting sessions:", error);
      res.status(500).json({ error: "Failed to get sessions" });
    }
  });

  // Get a specific fulfillment session by ID
  app.get("/api/fulfillment-sessions/:id", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const sessionId = parseInt(req.params.id, 10);
      if (isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
      }
      
      const session = await fulfillmentSessionService.getSessionById(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      // Get shipments in this session
      const { shipments: shipmentsTable, shipmentQcItems } = await import("@shared/schema");
      const sessionShipments = await db
        .select({
          id: shipmentsTable.id,
          shipmentId: shipmentsTable.shipmentId,
          orderNumber: shipmentsTable.orderNumber,
          saleId: shipmentsTable.saleId,
          fingerprintId: shipmentsTable.fingerprintId,
          trackingNumber: shipmentsTable.trackingNumber,
          lifecyclePhase: shipmentsTable.lifecyclePhase,
          smartSessionSpot: shipmentsTable.smartSessionSpot,
        })
        .from(shipmentsTable)
        .where(eq(shipmentsTable.fulfillmentSessionId, sessionId))
        .orderBy(shipmentsTable.smartSessionSpot);
      
      // Fetch QC items (exploded items) for each shipment - these are what warehouse staff actually scan
      // Note: shipmentQcItems uses the internal UUID (s.id), not ShipStation ID (s.shipmentId)
      const internalIds = sessionShipments.map(s => s.id);
      const allItems = internalIds.length > 0 
        ? await db
            .select({
              internalId: shipmentQcItems.shipmentId,  // This is the internal UUID FK
              sku: shipmentQcItems.sku,
              name: shipmentQcItems.description,
              quantity: shipmentQcItems.quantityExpected,
              imageUrl: shipmentQcItems.imageUrl,
              weightValue: shipmentQcItems.weightValue,
              weightUnit: shipmentQcItems.weightUnit,
              physicalLocation: shipmentQcItems.physicalLocation,
            })
            .from(shipmentQcItems)
            .where(inArray(shipmentQcItems.shipmentId, internalIds))
        : [];
      
      // Fetch per-order weights from QC items (more accurate as it includes kit expansion)
      const orderWeights = internalIds.length > 0
        ? await db
            .select({
              internalId: shipmentQcItems.shipmentId,
              totalWeight: sql<number>`COALESCE(SUM(${shipmentQcItems.weightValue} * ${shipmentQcItems.quantityExpected}), 0)`.as('total_weight'),
            })
            .from(shipmentQcItems)
            .where(inArray(shipmentQcItems.shipmentId, internalIds))
            .groupBy(shipmentQcItems.shipmentId)
        : [];
      
      // Create weight map by internal UUID
      const weightByShipment = new Map<string, number>();
      for (const row of orderWeights) {
        weightByShipment.set(row.internalId, Number(row.totalWeight) || 0);
      }
      
      // Group items by internal UUID
      const itemsByShipment: Record<string, typeof allItems> = {};
      for (const item of allItems) {
        if (!itemsByShipment[item.internalId]) {
          itemsByShipment[item.internalId] = [];
        }
        itemsByShipment[item.internalId].push(item);
      }
      
      // Attach items and weight to each shipment
      const shipmentsWithItems = sessionShipments.map(s => ({
        ...s,
        totalWeightOz: weightByShipment.get(s.id) || null,
        items: (itemsByShipment[s.id] || []).map(item => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          imageUrl: item.imageUrl,
          weightValue: item.weightValue,
          weightUnit: item.weightUnit,
          physicalLocation: item.physicalLocation,
        })),
      }));
      
      res.json({
        ...session,
        shipments: shipmentsWithItems,
      });
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error getting session:", error);
      res.status(500).json({ error: "Failed to get session" });
    }
  });

  // Update session status
  app.patch("/api/fulfillment-sessions/:id/status", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const { FULFILLMENT_SESSION_STATUSES } = await import("@shared/schema");
      const sessionId = parseInt(req.params.id, 10);
      const { status } = req.body;
      
      if (isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
      }
      
      if (!status || !FULFILLMENT_SESSION_STATUSES.includes(status)) {
        return res.status(400).json({ 
          error: `Invalid status. Must be one of: ${FULFILLMENT_SESSION_STATUSES.join(', ')}` 
        });
      }
      
      const updated = await fulfillmentSessionService.updateSessionStatus(sessionId, status);
      
      if (!updated) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      console.log(`[FulfillmentSessions] Updated session ${sessionId} status to: ${status}`);
      res.json(updated);
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error updating session status:", error);
      res.status(500).json({ error: "Failed to update session status" });
    }
  });

  // Bulk update session status (e.g., release multiple draft sessions to floor)
  app.post("/api/fulfillment-sessions/bulk-status", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessionService } = await import("./services/fulfillment-session-service");
      const { FULFILLMENT_SESSION_STATUSES } = await import("@shared/schema");
      const { sessionIds, status } = req.body;
      
      if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({ error: "sessionIds must be a non-empty array" });
      }
      
      // Parse session IDs as numbers
      const numericSessionIds = sessionIds.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
      if (numericSessionIds.length === 0) {
        return res.status(400).json({ error: "No valid session IDs provided" });
      }
      
      if (!status || !FULFILLMENT_SESSION_STATUSES.includes(status)) {
        return res.status(400).json({ 
          error: `Invalid status. Must be one of: ${FULFILLMENT_SESSION_STATUSES.join(', ')}` 
        });
      }
      
      const result = await fulfillmentSessionService.bulkUpdateSessionStatus(numericSessionIds, status);
      
      console.log(`[FulfillmentSessions] Bulk updated ${result.updated} sessions to status: ${status}`);
      res.json(result);
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error bulk updating session status:", error);
      res.status(500).json({ error: "Failed to bulk update session status" });
    }
  });

  // Delete a fulfillment session (unlinks shipments and deletes session)
  app.delete("/api/fulfillment-sessions/:id", requireAuth, async (req, res) => {
    try {
      const { fulfillmentSessions, shipments: shipmentsTable } = await import("@shared/schema");
      const { updateShipmentLifecycleBatch } = await import("./services/lifecycle-service");
      const sessionId = parseInt(req.params.id, 10);
      
      if (isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
      }
      
      // Get shipment IDs before unlinking (needed for lifecycle recalculation)
      const linkedShipments = await db
        .select({ id: shipmentsTable.id })
        .from(shipmentsTable)
        .where(eq(shipmentsTable.fulfillmentSessionId, sessionId));
      
      const shipmentIds = linkedShipments.map(s => s.id);
      
      // Unlink all shipments from this session (clear session reference and spot)
      await db
        .update(shipmentsTable)
        .set({
          fulfillmentSessionId: null,
          smartSessionSpot: null,
          updatedAt: new Date(),
        })
        .where(eq(shipmentsTable.fulfillmentSessionId, sessionId));
      
      // Then delete the session
      const deleted = await db
        .delete(fulfillmentSessions)
        .where(eq(fulfillmentSessions.id, sessionId))
        .returning();
      
      if (deleted.length === 0) {
        return res.status(404).json({ error: "Session not found" });
      }
      
      // Recalculate lifecycle phase for unlinked shipments using central service
      if (shipmentIds.length > 0) {
        await updateShipmentLifecycleBatch(shipmentIds);
        console.log(`[FulfillmentSessions] Deleted session ${sessionId}, recalculated lifecycle for ${shipmentIds.length} shipments`);
      } else {
        console.log(`[FulfillmentSessions] Deleted session ${sessionId} (no shipments linked)`);
      }
      
      res.json({ success: true, deletedId: sessionId, shipmentsUnlinked: shipmentIds.length });
    } catch (error: any) {
      console.error("[FulfillmentSessions] Error deleting session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  // ====================================================================================
  // QC VALIDATION REPORT ENDPOINTS
  // ====================================================================================
  
  // Get shipments with QC items for validation
  app.get("/api/reports/qc-validation/shipments", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate, search, shipmentStatus, page = '1', pageSize = '20' } = req.query;
      
      const pageNum = parseInt(page as string, 10) || 1;
      const pageSizeNum = parseInt(pageSize as string, 10) || 20;
      const offset = (pageNum - 1) * pageSizeNum;
      
      // Build query conditions
      const conditions: any[] = [];
      
      if (startDate) {
        conditions.push(sql`${shipments.orderDate} >= ${new Date(startDate as string)}`);
      }
      if (endDate) {
        // Add 1 day to include the end date fully
        const endDatePlusOne = new Date(endDate as string);
        endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
        conditions.push(sql`${shipments.orderDate} < ${endDatePlusOne}`);
      }
      if (search) {
        conditions.push(ilike(shipments.orderNumber, `%${search}%`));
      }
      if (shipmentStatus && shipmentStatus !== 'all') {
        conditions.push(eq(shipments.shipmentStatus, shipmentStatus as string));
      }
      
      // Only include shipments that have QC items - use EXISTS subquery for efficiency
      const hasQcItemsCondition = sql`EXISTS (SELECT 1 FROM shipment_qc_items WHERE shipment_id = ${shipments.id})`;
      conditions.push(hasQcItemsCondition);
      
      const shipmentsWithQcItems = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
          orderDate: shipments.orderDate,
          shipmentStatus: shipments.shipmentStatus,
          qcItemCount: sql<number>`(SELECT COUNT(*) FROM shipment_qc_items WHERE shipment_id = ${shipments.id})`,
        })
        .from(shipments)
        .where(and(...conditions))
        .orderBy(desc(shipments.orderDate))
        .limit(pageSizeNum)
        .offset(offset);
      
      // Get total count
      const countResult = await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${shipments.id})`,
        })
        .from(shipments)
        .innerJoin(shipmentQcItems, eq(shipmentQcItems.shipmentId, shipments.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      
      const totalCount = countResult[0]?.count || 0;
      const totalPages = Math.ceil(totalCount / pageSizeNum);
      
      res.json({
        shipments: shipmentsWithQcItems,
        totalCount,
        page: pageNum,
        pageSize: pageSizeNum,
        totalPages,
      });
    } catch (error: any) {
      console.error("[QC Validation] Error fetching shipments:", error);
      res.status(500).json({ error: "Failed to fetch shipments" });
    }
  });
  
  // Analyze shipments against SkuVault QC data
  app.post("/api/reports/qc-validation/analyze", requireAuth, async (req, res) => {
    try {
      const { shipmentIds } = req.body;
      
      if (!shipmentIds || !Array.isArray(shipmentIds) || shipmentIds.length === 0) {
        return res.status(400).json({ error: "shipmentIds array is required" });
      }
      
      // Import SkuVault service and product lookup
      const { skuVaultService } = await import("./services/skuvault-service");
      const { getProductsBatch } = await import("./services/product-lookup");
      const { getKitComponents, getParentKitsForComponent } = await import("./services/kit-mappings-cache");
      const { diagnoseShipmentMismatches } = await import("./services/qc-diagnosis-service");
      
      const results: Array<{
        shipmentId: string;
        orderNumber: string;
        totalDifferences: number;
        missingInLocal: number;
        missingInSkuvault: number;
        fieldMismatches: number;
        differences: Array<{
          sku: string;
          field: string;
          localValue: string | number | null;
          skuvaultValue: string | number | null;
          diagnosis?: {
            category: string;
            reason: string;
            parentSku?: string;
            productCategory?: string | null;
            isAssembledProduct?: boolean;
            quantityOnHand?: number;
          };
        }>;
        localItems: Array<{
          sku: string;
          barcode: string | null;
          description: string | null;
          quantityExpected: number;
        }>;
        skuvaultItems: Array<{
          sku: string;
          barcode: string | null;
          title: string | null;
          quantity: number;
        }>;
        skuvaultRawItems?: Array<{
          Sku: string;
          IsKit: boolean;
          QuantityOnHand?: number;
        }>;
        productInfo: Array<{
          sku: string;
          productCategory: string | null;
          isAssembledProduct: boolean;
          parentSku: string | null;
          kitComponents: Array<{ componentSku: string; componentQuantity: number }> | null;
          parentKits: string[] | null;
          foundInCatalog: boolean;
        }>;
        error?: string;
      }> = [];
      
      // Fetch shipments with their QC items
      const shipmentsWithItems = await db
        .select({
          id: shipments.id,
          orderNumber: shipments.orderNumber,
          shipmentId: shipments.shipmentId,
        })
        .from(shipments)
        .where(inArray(shipments.id, shipmentIds));
      
      for (const shipment of shipmentsWithItems) {
        try {
          // Get local QC items
          const localItems = await db
            .select({
              sku: shipmentQcItems.sku,
              barcode: shipmentQcItems.barcode,
              description: shipmentQcItems.description,
              quantityExpected: shipmentQcItems.quantityExpected,
            })
            .from(shipmentQcItems)
            .where(eq(shipmentQcItems.shipmentId, shipment.id));
          
          // Get SkuVault QC data
          const qcSale = await skuVaultService.getQCSalesByOrderNumber(
            shipment.orderNumber,
            shipment.shipmentId
          );
          
          // Extract items from SkuVault response
          const skuvaultItems: Array<{
            sku: string;
            barcode: string | null;
            title: string | null;
            quantity: number;
          }> = [];
          
          // Also keep raw items for diagnosis (to get QuantityOnHand, IsKit etc)
          const skuvaultRawItems: Array<{
            Sku: string;
            IsKit: boolean;
            QuantityOnHand?: number;
            KitProducts?: Array<{ Sku: string; Quantity: number }>;
          }> = [];
          
          if (qcSale && qcSale.Items) {
            for (const item of qcSale.Items) {
              // Capture raw item for diagnosis
              skuvaultRawItems.push({
                Sku: item.Sku || '',
                IsKit: item.IsKit || false,
                QuantityOnHand: item.QuantityOnHand,
                KitProducts: item.KitProducts?.map((kp: any) => ({ Sku: kp.Sku || '', Quantity: kp.Quantity || 0 })),
              });
              
              // Handle kit products - add components instead of parent kit
              if (item.IsKit && item.KitProducts && item.KitProducts.length > 0) {
                for (const component of item.KitProducts) {
                  // IMPORTANT: SkuVault's component.Quantity is already the TOTAL needed
                  // (pre-multiplied by kit quantity ordered). Do NOT multiply by item.Quantity again.
                  // Example: Kit ordered x2 with 2 components each → component.Quantity = 4 (already multiplied)
                  skuvaultItems.push({
                    sku: component.Sku || '',
                    barcode: component.Code || null,
                    title: component.Title || null,
                    quantity: component.Quantity || 1,
                  });
                }
              } else {
                skuvaultItems.push({
                  sku: item.Sku || '',
                  barcode: item.Code || null,
                  title: item.Title || null,
                  quantity: item.Quantity || 0,
                });
              }
            }
          }
          
          // Compare items
          const differences: Array<{
            sku: string;
            field: string;
            localValue: string | number | null;
            skuvaultValue: string | number | null;
          }> = [];
          
          let missingInLocal = 0;
          let missingInSkuvault = 0;
          let fieldMismatches = 0;
          
          // Create lookup maps
          const localBySku = new Map<string, typeof localItems[0]>();
          for (const item of localItems) {
            const existing = localBySku.get(item.sku);
            if (existing) {
              // Sum quantities for same SKU
              existing.quantityExpected += item.quantityExpected;
            } else {
              localBySku.set(item.sku, { ...item });
            }
          }
          
          const skuvaultBySku = new Map<string, typeof skuvaultItems[0]>();
          for (const item of skuvaultItems) {
            const existing = skuvaultBySku.get(item.sku);
            if (existing) {
              existing.quantity += item.quantity;
            } else {
              skuvaultBySku.set(item.sku, { ...item });
            }
          }
          
          // Check items in SkuVault against local
          for (const [sku, svItem] of skuvaultBySku) {
            const localItem = localBySku.get(sku);
            
            if (!localItem) {
              missingInLocal++;
              differences.push({
                sku,
                field: 'item',
                localValue: null,
                skuvaultValue: `qty: ${svItem.quantity}`,
              });
            } else {
              // Compare quantity
              if (localItem.quantityExpected !== svItem.quantity) {
                fieldMismatches++;
                differences.push({
                  sku,
                  field: 'quantity',
                  localValue: localItem.quantityExpected,
                  skuvaultValue: svItem.quantity,
                });
              }
              
              // Compare barcode (only if both have values)
              if (svItem.barcode && localItem.barcode && svItem.barcode !== localItem.barcode) {
                fieldMismatches++;
                differences.push({
                  sku,
                  field: 'barcode',
                  localValue: localItem.barcode,
                  skuvaultValue: svItem.barcode,
                });
              }
            }
          }
          
          // Check items in local that aren't in SkuVault
          for (const [sku, localItem] of localBySku) {
            if (!skuvaultBySku.has(sku)) {
              missingInSkuvault++;
              differences.push({
                sku,
                field: 'item',
                localValue: `qty: ${localItem.quantityExpected}`,
                skuvaultValue: null,
              });
            }
          }
          
          // Get product info for all unique SKUs (local + skuvault)
          const allSkus = new Set<string>();
          for (const sku of localBySku.keys()) allSkus.add(sku);
          for (const sku of skuvaultBySku.keys()) allSkus.add(sku);
          
          const productMap = await getProductsBatch(Array.from(allSkus));
          
          // Run diagnosis on all differences to determine root cause
          const diagnosisMap = await diagnoseShipmentMismatches(
            differences,
            localBySku as Map<string, { sku: string; quantityExpected: number }>,
            skuvaultBySku as Map<string, { sku: string; quantity: number }>,
            allSkus,
            skuvaultRawItems
          );
          
          // Add diagnosis to each difference
          const differencesWithDiagnosis = differences.map(diff => ({
            ...diff,
            diagnosis: diagnosisMap.get(diff.sku),
          }));
          
          // Build product info array with kit components and parent kits
          const productInfo: Array<{
            sku: string;
            productCategory: string | null;
            isAssembledProduct: boolean;
            parentSku: string | null;
            kitComponents: Array<{ componentSku: string; componentQuantity: number }> | null;
            parentKits: string[] | null;
            foundInCatalog: boolean;
          }> = [];
          
          for (const sku of Array.from(allSkus)) {
            const product = productMap.get(sku);
            let kitComponents = null;
            let parentKits: string[] | null = null;
            
            // Try to get kit components if this might be a kit/AP
            try {
              const components = await getKitComponents(sku);
              if (components && components.length > 0) {
                kitComponents = components;
              }
            } catch (e) {
              // Kit components not available, that's ok
            }
            
            // Get parent kits this SKU belongs to (reverse lookup)
            try {
              const parents = await getParentKitsForComponent(sku);
              if (parents && parents.length > 0) {
                parentKits = parents;
              }
            } catch (e) {
              // Parent kits not available, that's ok
            }
            
            productInfo.push({
              sku,
              productCategory: product?.productCategory || null,
              isAssembledProduct: product?.isAssembledProduct || false,
              parentSku: product?.parentSku || null,
              kitComponents,
              parentKits,
              foundInCatalog: !!product,
            });
          }
          
          results.push({
            shipmentId: shipment.id,
            orderNumber: shipment.orderNumber,
            totalDifferences: differences.length,
            missingInLocal,
            missingInSkuvault,
            fieldMismatches,
            differences: differencesWithDiagnosis,
            localItems: Array.from(localBySku.values()),
            skuvaultItems: Array.from(skuvaultBySku.values()),
            skuvaultRawItems,
            productInfo,
          });
          
        } catch (error: any) {
          console.error(`[QC Validation] Error analyzing shipment ${shipment.orderNumber}:`, error);
          results.push({
            shipmentId: shipment.id,
            orderNumber: shipment.orderNumber,
            totalDifferences: 0,
            missingInLocal: 0,
            missingInSkuvault: 0,
            fieldMismatches: 0,
            differences: [],
            localItems: [],
            skuvaultItems: [],
            productInfo: [],
            error: error.message || 'Unknown error',
          });
        }
      }
      
      const totalWithDifferences = results.filter(r => r.totalDifferences > 0 && !r.error).length;
      const totalDifferences = results.reduce((sum, r) => sum + r.totalDifferences, 0);
      
      res.json({
        results,
        totalAnalyzed: results.length,
        totalWithDifferences,
        totalDifferences,
      });
      
    } catch (error: any) {
      console.error("[QC Validation] Error analyzing shipments:", error);
      res.status(500).json({ error: "Failed to analyze shipments" });
    }
  });

  // Validate Order Details Report - Compare main Shopify DB with reporting DB
  app.get("/api/reports/validate-orders", requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }
      
      // Parse dates as CST date strings
      const startStr = startDate as string;
      const endStr = endDate as string;
      
      // Convert CST date strings to UTC timestamps for Shopify database queries
      // Shopify stores timestamps in UTC, so we convert CST boundaries to UTC
      const startCst = fromZonedTime(`${startStr} 00:00:00`, CST_TIMEZONE);
      const endCst = fromZonedTime(`${endStr} 23:59:59`, CST_TIMEZONE);
      
      // Query main Shopify database (uses UTC timestamps internally)
      // Using totalLineItemsPrice for comparison with reporting DB's order_total
      const shopifyOrders = await db
        .select({
          orderNumber: orders.orderNumber,
          createdAt: orders.createdAt,
          subtotalPrice: orders.totalLineItemsPrice,
        })
        .from(orders)
        .where(
          and(
            gte(orders.createdAt, startCst),
            lte(orders.createdAt, endCst)
          )
        );
      
      // Query reporting database - convert to CST timestamps for consistent comparison
      // The reporting DB stores order_date as timestamp, so we need to use CST boundaries
      const reportingOrders = await reportingSql`
        SELECT
          order_number,
          order_date AT TIME ZONE 'America/Chicago' as order_date_cst,
          order_total as subtotal_price
        FROM orders
        WHERE 
          order_date AT TIME ZONE 'America/Chicago' >= ${startStr}::date
          AND order_date AT TIME ZONE 'America/Chicago' < (${endStr}::date + interval '1 day')
          AND sales_channel IN ('etsy', 'jerky.com', 'ebay', 'walmart', 'tiktok')
      `;
      
      // Create maps for comparison
      const shopifyMap = new Map<string, { orderNumber: string; createdAt: Date | null; subtotalPrice: string }>();
      for (const order of shopifyOrders) {
        shopifyMap.set(order.orderNumber, order);
      }
      
      const reportingMap = new Map<string, { order_number: string; order_date_cst: Date; subtotal_price: string }>();
      for (const order of reportingOrders) {
        reportingMap.set(order.order_number, order);
      }
      
      // Find differences
      const missingInReporting: Array<{ orderNumber: string; createdAt: string | null; subtotalPrice: string }> = [];
      const missingInShopify: Array<{ orderNumber: string; orderDate: string; subtotalPrice: string }> = [];
      const subtotalMismatches: Array<{
        orderNumber: string;
        shopifySubtotal: string;
        reportingSubtotal: string;
        difference: string;
        createdAt: string | null;
      }> = [];
      
      // Check for orders missing in reporting DB and subtotal mismatches
      for (const [orderNumber, shopifyOrder] of shopifyMap) {
        const reportingOrder = reportingMap.get(orderNumber);
        
        if (!reportingOrder) {
          missingInReporting.push({
            orderNumber,
            createdAt: shopifyOrder.createdAt ? formatInTimeZone(shopifyOrder.createdAt, CST_TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : null,
            subtotalPrice: shopifyOrder.subtotalPrice,
          });
        } else {
          // Compare subtotals (handle numeric comparison)
          const shopifySubtotal = parseFloat(shopifyOrder.subtotalPrice) || 0;
          const reportingSubtotal = parseFloat(reportingOrder.subtotal_price) || 0;
          
          // Check if difference is significant (more than 1 cent)
          if (Math.abs(shopifySubtotal - reportingSubtotal) > 0.01) {
            subtotalMismatches.push({
              orderNumber,
              shopifySubtotal: shopifyOrder.subtotalPrice,
              reportingSubtotal: reportingOrder.subtotal_price,
              difference: (shopifySubtotal - reportingSubtotal).toFixed(2),
              createdAt: shopifyOrder.createdAt ? formatInTimeZone(shopifyOrder.createdAt, CST_TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : null,
            });
          }
        }
      }
      
      // Check for orders missing in Shopify DB
      for (const [orderNumber, reportingOrder] of reportingMap) {
        if (!shopifyMap.has(orderNumber)) {
          missingInShopify.push({
            orderNumber,
            orderDate: reportingOrder.order_date_cst instanceof Date 
              ? formatInTimeZone(reportingOrder.order_date_cst, CST_TIMEZONE, 'yyyy-MM-dd')
              : String(reportingOrder.order_date_cst),
            subtotalPrice: reportingOrder.subtotal_price,
          });
        }
      }
      
      res.json({
        summary: {
          shopifyOrderCount: shopifyOrders.length,
          reportingOrderCount: reportingOrders.length,
          missingInReportingCount: missingInReporting.length,
          missingInShopifyCount: missingInShopify.length,
          subtotalMismatchCount: subtotalMismatches.length,
        },
        missingInReporting,
        missingInShopify,
        subtotalMismatches,
      });
      
    } catch (error: any) {
      console.error("[Validate Orders Report] Error:", error);
      res.status(500).json({ error: "Failed to validate orders: " + error.message });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
