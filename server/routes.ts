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
          orderNumber: shopifyOrder.order_number,
          customerName: shopifyOrder.customer
            ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
            : "Guest",
          customerEmail: shopifyOrder.customer?.email || null,
          customerPhone: shopifyOrder.customer?.phone || null,
          shippingAddress: shopifyOrder.shipping_address || {},
          lineItems: shopifyOrder.line_items || [],
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          financialStatus: shopifyOrder.financial_status,
          totalPrice: shopifyOrder.total_price,
          createdAt: new Date(shopifyOrder.created_at),
          updatedAt: new Date(shopifyOrder.updated_at),
        };

        const existing = await storage.getOrder(orderData.id);
        if (existing) {
          await storage.updateOrder(orderData.id, orderData);
        } else {
          await storage.createOrder(orderData);
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
                orderNumber: shopifyOrder.order_number,
                customerName: shopifyOrder.customer
                  ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
                  : "Guest",
                customerEmail: shopifyOrder.customer?.email || null,
                customerPhone: shopifyOrder.customer?.phone || null,
                shippingAddress: shopifyOrder.shipping_address || {},
                lineItems: shopifyOrder.line_items || [],
                fulfillmentStatus: shopifyOrder.fulfillment_status,
                financialStatus: shopifyOrder.financial_status,
                totalPrice: shopifyOrder.total_price,
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

      res.json({ orders });
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

      res.json({ order });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
