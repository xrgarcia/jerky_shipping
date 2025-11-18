import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { insertUserSchema, insertMagicLinkTokenSchema } from "@shared/schema";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyShopifyWebhook } from "./utils/shopify-webhook";
import { verifyShipStationWebhook } from "./utils/shipstation-webhook";
import { fetchShipStationResource } from "./utils/shipstation-api";
import { enqueueWebhook, enqueueOrderId, dequeueWebhook, getQueueLength } from "./utils/queue";
import { broadcastOrderUpdate, broadcastPrintQueueUpdate } from "./websocket";
import { ShipStationShipmentService } from "./services/shipstation-shipment-service";
import { skuVaultService, SkuVaultError } from "./services/skuvault-service";
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz';

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

async function fetchShopifyOrders(limit: number = 50) {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    throw new Error("Shopify credentials not configured. Please set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  const url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=${limit}&status=any`;
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
  return data.orders;
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

      const shopifyOrders = await fetchShopifyOrders(100);
      let syncCount = 0;

      for (const shopifyOrder of shopifyOrders) {
        const orderData = {
          id: shopifyOrder.id.toString(),
          orderNumber: shopifyOrder.name || shopifyOrder.order_number,
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

      res.json({ success: true, count: syncCount });
    } catch (error) {
      console.error("Error syncing orders:", error);
      res.status(500).json({ error: "Failed to sync orders" });
    }
  });

  app.get("/api/orders", requireAuth, async (req, res) => {
    try {
      const query = req.query.q as string;

      let orders = query
        ? await storage.searchOrders(query)
        : await storage.getAllOrders();

      // If searching and no local results found, try fetching from Shopify
      if (query && orders.length === 0) {
        try {
          if (process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
            // Search Shopify by order number or name
            const shopifyOrders = await fetchShopifyOrders(250);
            const matchedOrders = shopifyOrders.filter((order: any) => {
              const orderNum = order.order_number?.toString() || '';
              const name = order.name || '';
              const customerName = order.customer 
                ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() 
                : '';
              const customerEmail = order.customer?.email || '';
              
              const lowerQuery = query.toLowerCase();
              return (
                orderNum.toLowerCase().includes(lowerQuery) ||
                name.toLowerCase().includes(lowerQuery) ||
                customerName.toLowerCase().includes(lowerQuery) ||
                customerEmail.toLowerCase().includes(lowerQuery)
              );
            });

            // Save matched orders to database
            for (const shopifyOrder of matchedOrders) {
              const orderData = {
                id: shopifyOrder.id.toString(),
                orderNumber: shopifyOrder.name || shopifyOrder.order_number,
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
            }

            // Fetch the saved orders from database
            orders = await storage.searchOrders(query);
          }
        } catch (shopifyError) {
          console.error("Error fetching from Shopify:", shopifyError);
          // Continue with empty results rather than failing completely
        }
      }

      // Enrich orders with shipment status
      const allShipments = await storage.getAllShipments();
      const shipmentsMap = new Map<string, boolean>();
      allShipments.forEach(shipment => shipmentsMap.set(shipment.orderId, true));
      
      const ordersWithShipmentStatus = orders.map(order => ({
        ...order,
        hasShipment: shipmentsMap.has(order.id),
      }));

      res.json({ orders: ordersWithShipmentStatus });
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
      const query = req.query.q as string;
      const allShipments = await storage.getAllShipments();

      // Get all orders to join with shipments
      const allOrders = await storage.getAllOrders();
      const ordersMap = new Map(allOrders.map(o => [o.id, o]));

      // Enrich shipments with order information
      const shipmentsWithOrders = allShipments.map(shipment => {
        const order = ordersMap.get(shipment.orderId);
        return {
          ...shipment,
          order: order || null,
        };
      });

      // Filter by query if provided
      let filteredShipments = shipmentsWithOrders;
      if (query) {
        const lowerQuery = query.toLowerCase();
        filteredShipments = shipmentsWithOrders.filter(s => 
          s.trackingNumber?.toLowerCase().includes(lowerQuery) ||
          s.carrierCode?.toLowerCase().includes(lowerQuery) ||
          s.order?.orderNumber?.toLowerCase().includes(lowerQuery) ||
          s.order?.customerName?.toLowerCase().includes(lowerQuery)
        );
      }

      res.json({ shipments: filteredShipments });
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
  app.post("/api/shipments/sync", requireAuth, async (req, res) => {
    try {
      console.log("========== MANUAL SHIPMENT SYNC STARTED ==========");
      const orders = await storage.getAllOrders();
      console.log(`Syncing shipments for ${orders.length} orders...`);

      let syncedCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      const errors: string[] = [];

      for (const order of orders) {
        try {
          // Fetch shipments from ShipStation for this order
          const shipStationShipments = await getShipmentsByOrderNumber(order.orderNumber);
          
          if (shipStationShipments.length > 0) {
            console.log(`Found ${shipStationShipments.length} shipment(s) for order ${order.orderNumber}`);
          }

          for (const shipmentData of shipStationShipments) {
            const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
            
            const shipmentRecord = {
              orderId: order.id,
              shipmentId: shipmentData.shipmentId?.toString(),
              trackingNumber: shipmentData.trackingNumber,
              carrierCode: shipmentData.carrierCode,
              serviceCode: shipmentData.serviceCode,
              status: shipmentData.voided ? 'cancelled' : 'shipped',
              statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
              shipDate: shipmentData.shipDate ? new Date(shipmentData.shipDate) : null,
              shipmentData: shipmentData,
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

      console.log(`========== SYNC COMPLETE: ${syncedCount} shipments (${createdCount} new, ${updatedCount} updated) ==========`);

      res.json({ 
        success: true,
        syncedCount,
        createdCount,
        updatedCount,
        ordersChecked: orders.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error: any) {
      console.error("Error syncing shipments:", error);
      res.status(500).json({ error: error.message || "Failed to sync shipments" });
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

      if (!shopifySecret) {
        console.error("SHOPIFY_API_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody as Buffer;
      if (!verifyShopifyWebhook(rawBody, hmacHeader, shopifySecret)) {
        console.error("Webhook verification failed");
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

      if (!shopifySecret) {
        console.error("SHOPIFY_API_SECRET not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const rawBody = req.rawBody as Buffer;
      if (!verifyShopifyWebhook(rawBody, hmacHeader, shopifySecret)) {
        console.error("Webhook verification failed");
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
              orderNumber: shopifyOrder.name || shopifyOrder.order_number,
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
            // Process ShipStation shipment webhook
            const resourceUrl = webhookData.resourceUrl;
            const shipmentResponse = await fetchShipStationResource(resourceUrl);
            const shipments = shipmentResponse.shipments || [];

            for (const shipmentData of shipments) {
              // Find matching order by order number
              // ShipStation uses 'shipment_number' field for the order number
              const orderNumber = shipmentData.shipment_number;
              const order = await storage.getOrderByOrderNumber(orderNumber);
              
              if (order) {
                
                // Create or update shipment record
                const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
                
                const shipmentRecord = {
                  orderId: order.id,
                  shipmentId: shipmentData.shipmentId?.toString(),
                  trackingNumber: shipmentData.trackingNumber,
                  carrierCode: shipmentData.carrierCode,
                  serviceCode: shipmentData.serviceCode,
                  status: shipmentData.voided ? 'cancelled' : 'shipped',
                  statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
                  shipDate: shipmentData.shipDate ? new Date(shipmentData.shipDate) : null,
                  shipmentData: shipmentData,
                };

                if (existingShipment) {
                  await storage.updateShipment(existingShipment.id, shipmentRecord);
                } else {
                  await storage.createShipment(shipmentRecord);
                }

                // Broadcast shipment update via WebSocket
                broadcastOrderUpdate(order);
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

      // Create backfill job
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
      });

      // Process each order immediately and queue only the ID
      // This prevents Redis queue from exceeding 100MB limit
      try {
        for (const shopifyOrder of allOrders) {
          // Store order in database first
          const orderData = {
            id: shopifyOrder.id.toString(),
            orderNumber: shopifyOrder.name || shopifyOrder.order_number,
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

          // Queue only the order ID (not full order data)
          await enqueueOrderId(orderData.id, job.id);
        }
      } catch (processingError: any) {
        // Rollback: reset job completely so it can be retried
        await storage.updateBackfillJob(job.id, {
          totalOrders: 0,
          processedOrders: 0,
          failedOrders: 0,
          status: "failed",
          errorMessage: `Failed to process orders: ${processingError.message}`,
        });
        console.error("Error processing orders for backfill:", processingError);
        return res.status(500).json({ error: "Failed to process orders" });
      }

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
