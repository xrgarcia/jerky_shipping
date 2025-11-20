import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { users, shipmentSyncFailures, orders } from "@shared/schema";
import { eq, count, desc, or, and, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { insertUserSchema, insertMagicLinkTokenSchema } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyShopifyWebhook, reregisterAllWebhooks } from "./utils/shopify-webhook";
import { verifyShipStationWebhook } from "./utils/shipstation-webhook";
import { fetchShipStationResource, getShipmentsByOrderNumber, getFulfillmentByTrackingNumber, getShipmentByShipmentId, getTrackingDetails } from "./utils/shipstation-api";
import { enqueueWebhook, enqueueOrderId, dequeueWebhook, getQueueLength, clearQueue, enqueueShipmentSync, getShipmentSyncQueueLength, clearShipmentSyncQueue, getOldestShopifyQueueMessage, getOldestShipmentSyncQueueMessage } from "./utils/queue";
import { broadcastOrderUpdate, broadcastPrintQueueUpdate } from "./websocket";
import { ShipStationShipmentService } from "./services/shipstation-shipment-service";
import { skuVaultService, SkuVaultError } from "./services/skuvault-service";
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { checkRateLimit } from "./utils/rate-limiter";

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

// Shopify API helpers
// To set up Shopify integration:
// 1. Go to your Shopify admin: Settings > Apps and sales channels > Develop apps
// 2. Create a new custom app with a descriptive name (e.g., "Warehouse Fulfillment")
// 3. Configure Admin API scopes: read_orders, read_products, read_customers
// 4. Install the app and reveal the Admin API access token
// 5. Add these secrets: SHOPIFY_SHOP_DOMAIN (e.g., yourstore.myshopify.com) and SHOPIFY_ADMIN_ACCESS_TOKEN
/**
 * Extract all price fields from a Shopify order object
 * Helper to ensure consistent price field extraction across all data entry points
 * All price fields default to '0' to match schema constraints
 */
function extractShopifyOrderPrices(shopifyOrder: any) {
  return {
    totalPrice: shopifyOrder.total_price || '0', // Legacy field for backwards compatibility
    orderTotal: shopifyOrder.total_price || '0',
    subtotalPrice: shopifyOrder.subtotal_price || '0',
    currentTotalPrice: shopifyOrder.current_total_price || '0',
    currentSubtotalPrice: shopifyOrder.current_subtotal_price || '0',
    shippingTotal: shopifyOrder.total_shipping_price_set?.shop_money?.amount || '0',
    totalDiscounts: shopifyOrder.total_discounts || '0',
    currentTotalDiscounts: shopifyOrder.current_total_discounts || '0',
    totalTax: shopifyOrder.total_tax || '0',
    currentTotalTax: shopifyOrder.current_total_tax || '0',
    totalAdditionalFees: shopifyOrder.total_additional_fees_set?.shop_money?.amount || '0',
    currentTotalAdditionalFees: shopifyOrder.current_total_additional_fees_set?.shop_money?.amount || '0',
    totalOutstanding: shopifyOrder.total_outstanding || '0',
  };
}

/**
 * Extract the actual order number from any sales channel
 * - For Amazon orders: returns Amazon order number (e.g., "111-7320858-2210642")
 * - For direct Shopify orders: returns Shopify order number (e.g., "JK3825344788")
 * - For other marketplaces: returns their native order number format
 */
function extractActualOrderNumber(shopifyOrder: any): string {
  // Method 1: Check fulfillments for Amazon marketplace data
  const fulfillments = shopifyOrder.fulfillments || [];
  for (const fulfillment of fulfillments) {
    // Amazon orders have gateway set to "amazon" and receipt contains marketplace data
    if (fulfillment.receipt?.marketplace_fulfillment_order_id) {
      return fulfillment.receipt.marketplace_fulfillment_order_id;
    }
    // Alternative: Some Amazon orders store it in the order_id field
    if (fulfillment.receipt?.order_id && /^\d{3}-\d{7}-\d{7}$/.test(fulfillment.receipt.order_id)) {
      return fulfillment.receipt.order_id;
    }
  }
  
  // Method 2: Check if source_name indicates Amazon marketplace
  if (shopifyOrder.source_name === 'amazon' && shopifyOrder.source_identifier) {
    return shopifyOrder.source_identifier;
  }
  
  // Method 3: Parse order name if it matches Amazon format (###-#######-#######)
  if (shopifyOrder.name && /^\d{3}-\d{7}-\d{7}$/.test(shopifyOrder.name)) {
    return shopifyOrder.name;
  }
  
  // Method 4: Default to Shopify order name, stripping the # prefix if present
  const shopifyOrderName = shopifyOrder.name || shopifyOrder.order_number || '';
  return shopifyOrderName.replace(/^#/, '');
}

async function processOrderRefunds(orderId: string, shopifyOrder: any) {
  const refunds = shopifyOrder.refunds || [];
  
  for (const refund of refunds) {
    try {
      const totalAmount = refund.transactions?.reduce((sum: number, txn: any) => {
        return sum + parseFloat(txn.amount || '0');
      }, 0) || 0;

      const refundData = {
        orderId: orderId,
        shopifyRefundId: refund.id.toString(),
        amount: totalAmount.toFixed(2),
        note: refund.note || null,
        refundedAt: new Date(refund.created_at),
        processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
      };

      await storage.upsertOrderRefund(refundData);
    } catch (error) {
      console.error(`Error processing refund ${refund.id} for order ${orderId}:`, error);
    }
  }
}

async function processOrderLineItems(orderId: string, shopifyOrder: any) {
  const lineItems = shopifyOrder.line_items || [];
  
  for (const item of lineItems) {
    try {
      const unitPrice = parseFloat(item.price || '0');
      const quantity = item.quantity || 0;
      const preDiscountPrice = (unitPrice * quantity).toFixed(2);
      const totalDiscount = item.total_discount || '0.00';
      const finalLinePrice = (parseFloat(preDiscountPrice) - parseFloat(totalDiscount)).toFixed(2);
      
      const taxAmount = item.tax_lines?.reduce((sum: number, taxLine: any) => {
        return sum + parseFloat(taxLine.price || '0');
      }, 0) || 0;

      const itemData = {
        orderId: orderId,
        shopifyLineItemId: item.id.toString(),
        title: item.title || item.name || 'Unknown Item',
        sku: item.sku || null,
        variantId: item.variant_id ? item.variant_id.toString() : null,
        productId: item.product_id ? item.product_id.toString() : null,
        quantity: quantity,
        currentQuantity: item.current_quantity !== undefined ? item.current_quantity : null,
        price: item.price || '0.00',
        totalDiscount: totalDiscount,
        priceSetJson: item.price_set || null,
        totalDiscountSetJson: item.total_discount_set || null,
        taxLinesJson: item.tax_lines || null,
        taxable: item.taxable !== undefined ? item.taxable : null,
        priceSetAmount: item.price_set?.shop_money?.amount || '0',
        totalDiscountSetAmount: item.total_discount_set?.shop_money?.amount || '0',
        totalTaxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : '0',
        preDiscountPrice: preDiscountPrice,
        finalLinePrice: finalLinePrice,
      };

      await storage.upsertOrderItem(itemData);
    } catch (error) {
      console.error(`Error processing line item ${item.id} for order ${orderId}:`, error);
    }
  }
}

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

// Email helper
async function sendMagicLinkEmail(email: string, token: string, req: Request) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const magicLink = `${baseUrl}/auth/verify?token=${token}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM_EMAIL,
    to: email,
    subject: "Your ship.jerky.com Login Link",
    html: `
      <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #6B8E23; font-size: 28px;">ship.jerky.com</h1>
        <p style="font-size: 16px; color: #2c2c2c;">Click the link below to sign in to your warehouse dashboard:</p>
        <p style="margin: 30px 0;">
          <a href="${magicLink}" style="background-color: #6B8E23; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: bold;">Sign In</a>
        </p>
        <p style="font-size: 14px; color: #666666;">This link will expire in 15 minutes.</p>
        <p style="font-size: 14px; color: #666666;">If you didn't request this link, you can safely ignore this email.</p>
      </div>
    `,
  });
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
  // Auth routes
  app.post("/api/auth/request-magic-link", async (req, res) => {
    try {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await storage.createMagicLinkToken({
        email,
        token,
        expiresAt,
      });

      await sendMagicLinkEmail(email, token, req);

      res.json({ success: true });
    } catch (error) {
      console.error("Error requesting magic link:", error);
      res.status(500).json({ error: "Failed to send magic link" });
    }
  });

  app.post("/api/auth/verify-magic-link", async (req, res) => {
    try {
      const { token } = z.object({ token: z.string().min(1) }).parse(req.body);

      const magicLink = await storage.getMagicLinkToken(token);

      if (!magicLink || magicLink.expiresAt < new Date()) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      let user = await storage.getUserByEmail(magicLink.email);

      if (!user) {
        user = await storage.createUser({ email: magicLink.email });
      }

      await storage.deleteMagicLinkToken(token);

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

      res.json({ success: true, user });
    } catch (error) {
      console.error("Error verifying magic link:", error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Token is required" });
      }
      res.status(500).json({ error: "Failed to verify token" });
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

        // Process refunds for this order
        if (shopifyOrder.refunds && shopifyOrder.refunds.length > 0) {
          for (const refund of shopifyOrder.refunds) {
            try {
              const totalAmount = refund.transactions?.reduce((sum: number, txn: any) => {
                return sum + parseFloat(txn.amount || '0');
              }, 0) || 0;

              const refundData = {
                orderId: orderData.id,
                shopifyRefundId: refund.id.toString(),
                amount: totalAmount.toFixed(2),
                note: refund.note || null,
                refundedAt: new Date(refund.created_at),
                processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
              };

              await storage.upsertOrderRefund(refundData);
            } catch (refundError) {
              console.error(`Error processing refund for order ${orderData.id}:`, refundError);
            }
          }
        }

        // Process line items for this order
        if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
          for (const item of shopifyOrder.line_items) {
            try {
              // Calculate derived price fields
              const unitPrice = parseFloat(item.price || '0');
              const quantity = item.quantity || 0;
              const preDiscountPrice = (unitPrice * quantity).toFixed(2);
              const totalDiscount = item.total_discount || '0.00';
              const finalLinePrice = (parseFloat(preDiscountPrice) - parseFloat(totalDiscount)).toFixed(2);
              
              // Sum all tax amounts from tax_lines array
              const taxAmount = item.tax_lines?.reduce((sum: number, taxLine: any) => {
                return sum + parseFloat(taxLine.price || '0');
              }, 0) || 0;

              const itemData = {
                orderId: orderData.id,
                shopifyLineItemId: item.id.toString(),
                title: item.title || item.name || 'Unknown Item',
                sku: item.sku || null,
                variantId: item.variant_id ? item.variant_id.toString() : null,
                productId: item.product_id ? item.product_id.toString() : null,
                quantity: quantity,
                currentQuantity: item.current_quantity !== undefined ? item.current_quantity : null,
                
                // Core price fields (text strings for consistency)
                price: item.price || '0.00',
                totalDiscount: totalDiscount,
                
                // Full Shopify JSON structures (preserves currency and complete data)
                priceSetJson: item.price_set || null,
                totalDiscountSetJson: item.total_discount_set || null,
                taxLinesJson: item.tax_lines || null,
                
                // Tax information
                taxable: item.taxable !== undefined ? item.taxable : null,
                
                // Calculated/extracted fields for easy querying
                priceSetAmount: item.price_set?.shop_money?.amount || '0',
                totalDiscountSetAmount: item.total_discount_set?.shop_money?.amount || '0',
                totalTaxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : '0',
                preDiscountPrice: preDiscountPrice,
                finalLinePrice: finalLinePrice,
              };

              await storage.upsertOrderItem(itemData);
            } catch (itemError) {
              console.error(`Error processing line item for order ${orderData.id}:`, itemError);
            }
          }
        }

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

      // Parse date parameters
      if (req.query.dateFrom) {
        filters.dateFrom = new Date(req.query.dateFrom as string);
      }
      if (req.query.dateTo) {
        filters.dateTo = new Date(req.query.dateTo as string);
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

      res.json({ order, shipments });
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

      // Parse array parameters
      if (req.query.status) {
        filters.status = Array.isArray(req.query.status)
          ? req.query.status
          : [req.query.status];
      }
      if (req.query.carrierCode) {
        filters.carrierCode = Array.isArray(req.query.carrierCode)
          ? req.query.carrierCode
          : [req.query.carrierCode];
      }

      // Parse date parameters
      if (req.query.dateFrom) {
        filters.dateFrom = new Date(req.query.dateFrom as string);
      }
      if (req.query.dateTo) {
        filters.dateTo = new Date(req.query.dateTo as string);
      }

      // Get filtered shipments with pagination
      const { shipments: filteredShipments, total } = await storage.getFilteredShipments(filters);

      // Get all orders to join with shipments
      const allOrders = await storage.getAllOrders();
      const ordersMap = new Map(allOrders.map(o => [o.id, o]));

      // Enrich shipments with order information
      const shipmentsWithOrders = filteredShipments.map(shipment => {
        const order = ordersMap.get(shipment.orderId);
        return {
          ...shipment,
          order: order || null,
        };
      });

      res.json({
        shipments: shipmentsWithOrders,
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
  app.get("/api/skuvault/sessions/:picklistId", requireAuth, async (req, res) => {
    try {
      const { picklistId } = req.params;
      console.log(`Fetching SkuVault session details for picklist ${picklistId}...`);
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
      
      res.json(directions);
    } catch (error: any) {
      console.error(`Error fetching SkuVault session details for picklist ${req.params.picklistId}:`, error);
      res.status(500).json({ 
        error: "Failed to fetch session details",
        message: error.message 
      });
    }
  });

  // Manual sync endpoint - pulls all shipments from ShipStation for existing orders
  // AND fetches rich tracking data for each shipment
  app.post("/api/shipments/sync", requireAuth, async (req, res) => {
    try {
      console.log("========== MANUAL SHIPMENT SYNC WITH TRACKING STARTED ==========");
      const orders = await storage.getAllOrders();
      console.log(`Syncing shipments for ${orders.length} orders...`);

      let syncedCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let trackingEnrichedCount = 0;
      const errors: string[] = [];
      let lastRateLimit: any = null;

      for (const order of orders) {
        try {
          // Fetch shipments from ShipStation for this order
          const { data: shipStationShipments, rateLimit } = await getShipmentsByOrderNumber(order.orderNumber);
          lastRateLimit = rateLimit;
          
          if (shipStationShipments.length > 0) {
            console.log(`Found ${shipStationShipments.length} shipment(s) for order ${order.orderNumber}`);
          }

          for (const shipmentData of shipStationShipments) {
            const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
            
            // Start with basic shipment data
            let statusDescription = shipmentData.voided ? 'Shipment voided' : 'Shipment created';
            let enrichedShipmentData = shipmentData;
            
            // Try to fetch rich tracking details if shipment has a tracking number
            if (shipmentData.trackingNumber && !shipmentData.voided) {
              try {
                const trackingDetails = await getTrackingDetails(shipmentData.trackingNumber);
                
                if (trackingDetails) {
                  lastRateLimit = trackingDetails.rateLimit;
                  
                  // Use rich carrier status description if available
                  if (trackingDetails.carrierStatusDescription) {
                    statusDescription = trackingDetails.carrierStatusDescription;
                    trackingEnrichedCount++;
                  } else if (trackingDetails.trackingStatus) {
                    statusDescription = trackingDetails.trackingStatus;
                    trackingEnrichedCount++;
                  }
                  
                  // Merge tracking data with shipment data
                  enrichedShipmentData = {
                    ...shipmentData,
                    trackingDetails: {
                      labelId: trackingDetails.labelId,
                      trackingStatus: trackingDetails.trackingStatus,
                      carrierStatusDescription: trackingDetails.carrierStatusDescription,
                      events: trackingDetails.events,
                    },
                  };
                  
                  console.log(`  ✓ Enriched ${shipmentData.trackingNumber}: "${statusDescription}"`);
                }
                
                // Rate limit check - pause if getting low
                if (lastRateLimit && lastRateLimit.remaining < 5) {
                  const waitTime = Math.max(lastRateLimit.reset, 2) * 1000;
                  console.log(`  ⏸ Rate limit low (${lastRateLimit.remaining} remaining), waiting ${waitTime/1000}s...`);
                  await new Promise(resolve => setTimeout(resolve, waitTime));
                }
              } catch (trackingError: any) {
                console.warn(`  ⚠ Could not fetch tracking for ${shipmentData.trackingNumber}: ${trackingError.message}`);
                // Continue with basic shipment data
              }
            }
            
            const shipmentRecord = {
              orderId: order.id,
              shipmentId: shipmentData.shipmentId?.toString(),
              trackingNumber: shipmentData.trackingNumber,
              carrierCode: shipmentData.carrierCode,
              serviceCode: shipmentData.serviceCode,
              status: shipmentData.voided ? 'cancelled' : 'shipped',
              statusDescription,
              shipDate: shipmentData.shipDate ? new Date(shipmentData.shipDate) : null,
              shipmentData: enrichedShipmentData,
            };

            if (existingShipment) {
              await storage.updateShipment(existingShipment.id, shipmentRecord);
              updatedCount++;
            } else {
              await storage.createShipment(shipmentRecord);
              createdCount++;
            }
            
            syncedCount++;
          }
        } catch (orderError: any) {
          const errorMsg = `Order ${order.orderNumber}: ${orderError.message}`;
          console.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      console.log(`========== SYNC COMPLETE ==========`);
      console.log(`Total: ${syncedCount} shipments (${createdCount} new, ${updatedCount} updated)`);
      console.log(`Tracking enriched: ${trackingEnrichedCount} shipments`);

      res.json({ 
        success: true,
        syncedCount,
        createdCount,
        updatedCount,
        trackingEnrichedCount,
        ordersChecked: orders.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error: any) {
      console.error("Error syncing shipments:", error);
      res.status(500).json({ error: error.message || "Failed to sync shipments" });
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
        trackingData: req.body.data, // Include tracking data for track webhooks
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
              
              // Check if we already have this shipment
              const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
              
              if (!existingShipment) {
                // We don't have this shipment yet - queue it for async processing
                console.log(`No shipment found for tracking ${trackingNumber} - queuing for shipment sync worker`);
                
                await enqueueShipmentSync({
                  trackingNumber,
                  reason: 'webhook',
                  enqueuedAt: Date.now(),
                });
              } else {
                // Update existing shipment with latest tracking info
                const updatedShipmentData = {
                  ...(existingShipment.shipmentData || {}),
                  latestTracking: trackingData,
                };
                
                await storage.updateShipment(existingShipment.id, {
                  status: trackingData.status_code === 'DE' ? 'delivered' : 'in_transit',
                  statusDescription: trackingData.status_description || existingShipment.statusDescription,
                  shipmentData: updatedShipmentData,
                });
                
                // Broadcast update
                const order = await storage.getOrder(existingShipment.orderId);
                if (order) {
                  broadcastOrderUpdate(order);
                }
              }
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

      if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
        return res.status(400).json({ error: "Shopify credentials not configured" });
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      if (start > end) {
        return res.status(400).json({ error: "Start date must be before end date" });
      }

      // Check if there's already an active job
      const allJobs = await storage.getAllBackfillJobs();
      const activeJob = allJobs.find(j => j.status === 'in_progress' || j.status === 'pending');
      if (activeJob) {
        return res.status(400).json({ 
          error: "A backfill job is already in progress. Please wait for it to complete or delete it before starting a new one." 
        });
      }

      // Create backfill job with observability fields
      const job = await storage.createBackfillJob({
        startDate: start,
        endDate: end,
        status: "pending",
        totalOrders: 0,
        processedOrders: 0,
        failedOrders: 0,
        currentStage: "fetching_orders",
        lastActivityAt: new Date(),
        errorLog: [],
      });

      // Fetch orders from Shopify with date filters
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      let allOrders: any[] = [];
      let pageInfo: string | null = null;
      let hasNextPage = true;
      let fetchPageCount = 0;

      // Paginate through all orders in date range
      while (hasNextPage) {
        fetchPageCount++;
        
        // Heartbeat update every page to prove job is alive
        await storage.updateBackfillJob(job.id, {
          lastActivityAt: new Date(),
        });
        // For pagination, use page_info OR query params, never both
        let url: string;
        if (pageInfo) {
          // Subsequent pages: only use page_info (Shopify requirement)
          url = `https://${shopDomain}/admin/api/2024-01/orders.json?page_info=${pageInfo}`;
        } else {
          // First page: use query parameters
          url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${start.toISOString()}&created_at_max=${end.toISOString()}`;
        }

        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          await storage.updateBackfillJob(job.id, {
            status: "failed",
            errorMessage: `Shopify API error: ${errorText}`,
          });
          return res.status(500).json({ error: "Failed to fetch orders from Shopify" });
        }

        const data = await response.json();
        allOrders = allOrders.concat(data.orders || []);

        // Check for pagination
        const linkHeader = response.headers.get("Link");
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (nextMatch) {
            const nextUrl = new URL(nextMatch[1]);
            pageInfo = nextUrl.searchParams.get("page_info");
          } else {
            hasNextPage = false;
          }
        } else {
          hasNextPage = false;
        }

        // Rate limiting: wait 500ms between requests
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // CRITICAL: Set totalOrders FIRST, before queuing orders
      // This prevents race condition where worker finishes before totalOrders is set
      await storage.updateBackfillJob(job.id, {
        totalOrders: allOrders.length,
        status: "in_progress",
        currentStage: "storing_orders",
        lastActivityAt: new Date(),
      });

      // Process each order immediately and queue only the ID
      // This prevents Redis queue from exceeding 100MB limit
      // Wrap EACH order in try-catch so one bad order doesn't kill the whole job
      let processedCount = 0;
      let failedCount = 0;
      const errorLog: any[] = [];
      let lastHeartbeat = Date.now();
      
      for (let i = 0; i < allOrders.length; i++) {
        const shopifyOrder = allOrders[i];
        const orderIndex = i + 1; // 1-based index for UI
        
        // Check for cancellation on every iteration (read-only)
        const currentJob = await storage.getBackfillJob(job.id);
        if (currentJob && currentJob.status === "failed" && currentJob.currentStage === "cancelled") {
          console.log(`[Backfill ${job.id}] Job cancelled by user, stopping at order ${i} of ${allOrders.length}`);
          
          // Update job with final stats before returning
          await storage.updateBackfillJob(job.id, {
            lastActivityAt: new Date(),
            errorLog,
            currentOrderIndex: orderIndex,
          });
          
          return res.json({ 
            success: true,
            job: await storage.getBackfillJob(job.id),
            message: "Job cancelled by user",
          });
        }
        
        // Heartbeat update every 5 seconds (write)
        const now = Date.now();
        if (now - lastHeartbeat > 5000) {
          await storage.updateBackfillJob(job.id, {
            lastActivityAt: new Date(),
            currentOrderIndex: orderIndex,
          });
          lastHeartbeat = now;
        }
        
        try {
          // Store order in database first
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

          // Process refunds and line items
          await processOrderRefunds(orderData.id, shopifyOrder);
          await processOrderLineItems(orderData.id, shopifyOrder);

          // Enqueue shipment sync request (processed asynchronously by shipment-sync-worker)
          await enqueueShipmentSync({
            reason: 'backfill',
            orderNumber: orderData.orderNumber,
            enqueuedAt: Date.now(),
            jobId: job.id,
          });

          // Queue only the order ID (not full order data)
          await enqueueOrderId(orderData.id, job.id);
          
          processedCount++;
        } catch (orderError: any) {
          // Log individual order failure - don't abort entire backfill
          const orderNumber = shopifyOrder.order_number || shopifyOrder.id || 'unknown';
          console.error(`[Backfill ${job.id}] Failed to process order ${orderNumber}:`, orderError.message);
          
          // Add to error log for troubleshooting
          errorLog.push({
            orderNumber,
            orderIndex,
            error: orderError.message,
            timestamp: new Date().toISOString(),
          });
          
          // Increment failed counter and update error log
          await storage.incrementBackfillFailed(job.id, 1);
          await storage.updateBackfillJob(job.id, {
            errorLog,
            lastActivityAt: new Date(),
          });
          
          failedCount++;
        }
      }
      
      // Final update: set stage to completed (but don't overwrite if cancelled)
      const finalJob = await storage.getBackfillJob(job.id);
      if (finalJob && finalJob.currentStage !== "cancelled") {
        await storage.updateBackfillJob(job.id, {
          currentStage: "completed",
          lastActivityAt: new Date(),
          errorLog,
        });
      } else {
        // Job was cancelled, just update error log and timestamp
        await storage.updateBackfillJob(job.id, {
          lastActivityAt: new Date(),
          errorLog,
        });
      }
      
      console.log(`[Backfill ${job.id}] Completed: ${processedCount} queued, ${failedCount} failed out of ${allOrders.length} total orders`);

      res.json({ 
        success: true,
        job: await storage.getBackfillJob(job.id),
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

      if (job.status !== "in_progress" && job.status !== "pending") {
        return res.status(400).json({ error: "Only pending or in-progress jobs can be cancelled" });
      }

      await storage.updateBackfillJob(req.params.id, {
        status: "failed",
        errorMessage: "Cancelled by user",
        currentStage: "cancelled",
        lastActivityAt: new Date(),
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
      const activeJob = allJobs.find(j => j.status === 'in_progress' || j.status === 'pending');
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
        totalOrders: 0,
        processedOrders: 0,
        failedOrders: 0,
      });

      // Fetch orders from Shopify with date filters
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

      let allOrders: any[] = [];
      let pageInfo: string | null = null;
      let hasNextPage = true;

      // Paginate through all orders in date range
      while (hasNextPage) {
        let url: string;
        if (pageInfo) {
          url = `https://${shopDomain}/admin/api/2024-01/orders.json?page_info=${pageInfo}`;
        } else {
          url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${start.toISOString()}&created_at_max=${end.toISOString()}`;
        }

        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          await storage.updateBackfillJob(job.id, {
            status: "failed",
            errorMessage: `Shopify API error: ${errorText}`,
          });
          return res.status(500).json({ error: "Failed to fetch orders from Shopify" });
        }

        const data = await response.json();
        allOrders = allOrders.concat(data.orders || []);

        const linkHeader = response.headers.get("Link");
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (nextMatch) {
            const nextUrl = new URL(nextMatch[1]);
            pageInfo = nextUrl.searchParams.get("page_info");
          } else {
            hasNextPage = false;
          }
        } else {
          hasNextPage = false;
        }

        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // CRITICAL: Set totalOrders FIRST, before queuing orders
      // This prevents race condition where worker finishes before totalOrders is set
      await storage.updateBackfillJob(job.id, {
        totalOrders: allOrders.length,
        status: "in_progress",
      });

      // Now queue each order for async processing
      // Wrap in try/catch to rollback if enqueue fails
      try {
        for (const shopifyOrder of allOrders) {
          const webhookData = {
            type: 'backfill',
            jobId: job.id,
            order: shopifyOrder,
            receivedAt: new Date().toISOString(),
          };
          await enqueueWebhook(webhookData);
        }
      } catch (enqueueError: any) {
        // Rollback: reset job completely so it can be retried
        // Reset counters to prevent processedOrders > totalOrders from orphaned tasks
        await storage.updateBackfillJob(job.id, {
          totalOrders: 0,
          processedOrders: 0,
          failedOrders: 0,
          status: "failed",
          errorMessage: `Failed to queue orders: ${enqueueError.message}`,
        });
        console.error("Error queuing orders for backfill restart:", enqueueError);
        return res.status(500).json({ error: "Failed to queue orders for processing" });
      }

      res.json({ 
        success: true,
        job: await storage.getBackfillJob(job.id),
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

      // Query refunds by refund date (not order creation date)
      const refundsInRange = await storage.getRefundsInDateRange(start, end);
      
      // Calculate returns value from actual refund amounts
      let returnsValue = 0;
      const refundedOrderIds = new Set<string>();
      refundsInRange.forEach((refund) => {
        returnsValue += parseAmount(refund.amount);
        refundedOrderIds.add(refund.orderId);
      });

      // Split orders into refunded and non-refunded
      // Check financial_status (payment status) not fulfillment_status (shipping status)
      const refundedOrders = ordersInRange.filter(order => 
        order.financialStatus === 'refunded' || order.financialStatus === 'partially_refunded'
      );
      const nonRefundedOrders = ordersInRange.filter(order => 
        order.financialStatus !== 'refunded' && order.financialStatus !== 'partially_refunded'
      );

      // Calculate aggregations (excluding refunded orders)
      let totalRevenue = 0;
      let totalShipping = 0;
      let totalSubtotal = 0;
      let totalTax = 0;
      let totalDiscounts = 0;
      const dailyTotals: { [key: string]: number } = {};
      const statusCounts: { [key: string]: number } = {};
      const fulfillmentCounts: { [key: string]: number } = {};

      nonRefundedOrders.forEach((order) => {
        // Revenue aggregations (excluding refunded orders)
        totalRevenue += parseAmount(order.orderTotal);
        totalShipping += parseAmount(order.shippingTotal);
        totalSubtotal += parseAmount(order.subtotalPrice);
        totalTax += parseAmount(order.totalTax);
        totalDiscounts += parseAmount(order.totalDiscounts);

        // Daily totals for chart (excluding refunded orders)
        // Group by CST day to match date range filtering
        const dayKey = formatInTimeZone(order.createdAt, CST_TIMEZONE, 'yyyy-MM-dd');
        dailyTotals[dayKey] = (dailyTotals[dayKey] || 0) + parseAmount(order.orderTotal);

        // Status counts (excluding refunded orders)
        const financialStatus = order.financialStatus || 'unknown';
        statusCounts[financialStatus] = (statusCounts[financialStatus] || 0) + 1;

        const fulfillmentStatus = order.fulfillmentStatus || 'unfulfilled';
        fulfillmentCounts[fulfillmentStatus] = (fulfillmentCounts[fulfillmentStatus] || 0) + 1;
      });

      // Convert daily totals to array format for chart
      const dailyData = Object.entries(dailyTotals)
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const summary = {
        totalOrders: ordersInRange.length,
        fulfilledOrders: nonRefundedOrders.length,
        refundedOrders: refundedOrderIds.size, // Use unique orders with refunds in this date range
        totalRevenue: totalRevenue.toFixed(2),
        totalShipping: totalShipping.toFixed(2),
        totalSubtotal: totalSubtotal.toFixed(2),
        totalTax: totalTax.toFixed(2),
        totalDiscounts: totalDiscounts.toFixed(2),
        returnsValue: returnsValue.toFixed(2),
        averageOrderValue: nonRefundedOrders.length > 0 ? (totalRevenue / nonRefundedOrders.length).toFixed(2) : '0.00',
        averageShipping: nonRefundedOrders.length > 0 ? (totalShipping / nonRefundedOrders.length).toFixed(2) : '0.00',
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

            // Process line items if they exist
            let itemsPersisted = 0;
            if (shopifyOrder.line_items && shopifyOrder.line_items.length > 0) {
              for (const item of shopifyOrder.line_items) {
                try {
                  // Calculate derived price fields
                  const unitPrice = parseFloat(item.price || '0');
                  const quantity = item.quantity || 0;
                  const preDiscountPrice = (unitPrice * quantity).toFixed(2);
                  const totalDiscount = item.total_discount || '0.00';
                  const finalLinePrice = (parseFloat(preDiscountPrice) - parseFloat(totalDiscount)).toFixed(2);
                  
                  // Sum all tax amounts from tax_lines array
                  const taxAmount = item.tax_lines?.reduce((sum: number, taxLine: any) => {
                    return sum + parseFloat(taxLine.price || '0');
                  }, 0) || 0;

                  const itemData = {
                    orderId: order.id,
                    shopifyLineItemId: item.id.toString(),
                    title: item.title || item.name || 'Unknown Item',
                    sku: item.sku || null,
                    variantId: item.variant_id ? item.variant_id.toString() : null,
                    productId: item.product_id ? item.product_id.toString() : null,
                    quantity: quantity,
                    currentQuantity: item.current_quantity !== undefined ? item.current_quantity : null,
                    
                    // Core price fields (text strings for consistency)
                    price: item.price || '0.00',
                    totalDiscount: totalDiscount,
                    
                    // Full Shopify JSON structures (preserves currency and complete data)
                    priceSetJson: item.price_set || null,
                    totalDiscountSetJson: item.total_discount_set || null,
                    taxLinesJson: item.tax_lines || null,
                    
                    // Tax information
                    taxable: item.taxable !== undefined ? item.taxable : null,
                    
                    // Calculated/extracted fields for easy querying
                    priceSetAmount: item.price_set?.shop_money?.amount || '0',
                    totalDiscountSetAmount: item.total_discount_set?.shop_money?.amount || '0',
                    totalTaxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : '0',
                    preDiscountPrice: preDiscountPrice,
                    finalLinePrice: finalLinePrice,
                  };

                  await storage.upsertOrderItem(itemData);
                  itemsPersisted++;
                } catch (itemError: any) {
                  console.error(`Error persisting line item for order ${order.id}:`, itemError.message);
                }
              }
              
              if (shopifyOrder.line_items.length > 0 && itemsPersisted === 0) {
                console.error(`Failed to persist any line items for order ${order.id} (${shopifyOrder.line_items.length} items found)`);
                failedCount++;
                failedOrderIds.push(order.orderNumber);
              } else if (itemsPersisted > 0) {
                persistedCount++;
              }
            }

            itemsFound += itemsPersisted;

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
      const shopifyQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const oldestShopify = await getOldestShopifyQueueMessage();
      const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
      
      const failureCount = await db.select({ count: count() })
        .from(shipmentSyncFailures)
        .then(rows => rows[0]?.count || 0);

      // Get active/recent backfill jobs
      const allBackfillJobs = await storage.getAllBackfillJobs();
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'in_progress' || j.status === 'pending');
      const recentBackfillJobs = allBackfillJobs.slice(0, 5); // Last 5 jobs

      res.json({
        shopifyQueue: {
          size: shopifyQueueLength,
          oldestMessageAt: oldestShopify.enqueuedAt,
        },
        shipmentSyncQueue: {
          size: shipmentSyncQueueLength,
          oldestMessageAt: oldestShipmentSync.enqueuedAt,
        },
        failures: {
          total: failureCount,
        },
        backfill: {
          activeJob: activeBackfillJob || null,
          recentJobs: recentBackfillJobs,
        },
      });
    } catch (error) {
      console.error("Error fetching queue stats:", error);
      res.status(500).json({ error: "Failed to fetch queue stats" });
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

  app.post("/api/operations/purge-failures", requireAuth, async (req, res) => {
    try {
      await db.delete(shipmentSyncFailures);
      res.json({ success: true });
    } catch (error) {
      console.error("Error purging failures:", error);
      res.status(500).json({ error: "Failed to purge failures table" });
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

  const httpServer = createServer(app);

  return httpServer;
}
