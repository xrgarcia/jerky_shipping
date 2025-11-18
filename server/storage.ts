import { eq, desc, or, ilike, and, sql, isNull } from "drizzle-orm";
import { db } from "./db";
import {
  type User,
  type InsertUser,
  users,
  type MagicLinkToken,
  type InsertMagicLinkToken,
  magicLinkTokens,
  type Session,
  type InsertSession,
  sessions,
  type Order,
  type InsertOrder,
  orders,
  type Shipment,
  type InsertShipment,
  shipments,
  type Product,
  type InsertProduct,
  products,
  type ProductVariant,
  type InsertProductVariant,
  productVariants,
  type BackfillJob,
  type InsertBackfillJob,
  backfillJobs,
  type PrintQueue,
  type InsertPrintQueue,
  printQueue,
} from "@shared/schema";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined>;

  // Magic Link Tokens
  createMagicLinkToken(token: InsertMagicLinkToken): Promise<MagicLinkToken>;
  getMagicLinkToken(token: string): Promise<MagicLinkToken | undefined>;
  deleteMagicLinkToken(token: string): Promise<void>;
  deleteExpiredTokens(): Promise<void>;

  // Sessions
  createSession(session: InsertSession): Promise<Session>;
  getSession(token: string): Promise<Session | undefined>;
  deleteSession(token: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Orders
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrder(id: string, order: Partial<InsertOrder>): Promise<Order | undefined>;
  getOrder(id: string): Promise<Order | undefined>;
  getOrderByOrderNumber(orderNumber: string): Promise<Order | undefined>;
  searchOrders(query: string): Promise<Order[]>;
  getAllOrders(limit?: number): Promise<Order[]>;

  // Shipments
  createShipment(shipment: InsertShipment): Promise<Shipment>;
  updateShipment(id: string, shipment: Partial<InsertShipment>): Promise<Shipment | undefined>;
  getShipment(id: string): Promise<Shipment | undefined>;
  getAllShipments(): Promise<Shipment[]>;
  getShipmentsByOrderId(orderId: string): Promise<Shipment[]>;
  getShipmentByTrackingNumber(trackingNumber: string): Promise<Shipment | undefined>;
  getShipmentByShipmentId(shipmentId: string): Promise<Shipment | undefined>;
  getUserById(id: string): Promise<User | undefined>;

  // Products
  upsertProduct(product: InsertProduct): Promise<Product>;
  softDeleteProduct(id: string): Promise<void>;
  getProduct(id: string): Promise<Product | undefined>;
  getAllProducts(includeDeleted?: boolean): Promise<Product[]>;
  getAllProductsWithVariants(includeDeleted?: boolean): Promise<Array<{ product: Product; variants: ProductVariant[] }>>;

  // Product Variants
  upsertProductVariant(variant: InsertProductVariant): Promise<ProductVariant>;
  softDeleteProductVariant(id: string): Promise<void>;
  getProductVariant(id: string): Promise<ProductVariant | undefined>;
  getProductVariants(productId: string): Promise<ProductVariant[]>;
  getVariantByBarcode(barcode: string): Promise<ProductVariant | undefined>;
  getVariantBySku(sku: string): Promise<ProductVariant | undefined>;

  // Backfill Jobs
  createBackfillJob(job: InsertBackfillJob): Promise<BackfillJob>;
  updateBackfillJob(id: string, updates: Partial<InsertBackfillJob>): Promise<BackfillJob | undefined>;
  getBackfillJob(id: string): Promise<BackfillJob | undefined>;
  getAllBackfillJobs(): Promise<BackfillJob[]>;
  deleteBackfillJob(id: string): Promise<void>;
  incrementBackfillProgress(id: string, incrementBy: number): Promise<void>;
  incrementBackfillFailed(id: string, incrementBy: number): Promise<void>;

  // Print Queue
  createPrintJob(job: InsertPrintQueue): Promise<PrintQueue>;
  updatePrintJob(id: string, updates: Partial<InsertPrintQueue>): Promise<PrintQueue | undefined>;
  updatePrintJobStatus(id: string, status: string, printedAt?: Date): Promise<PrintQueue | undefined>;
  getPrintJob(id: string): Promise<PrintQueue | undefined>;
  getActivePrintJobs(): Promise<PrintQueue[]>;
  getPrintJobsByOrderId(orderId: string): Promise<PrintQueue[]>;
  deletePrintJob(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  // Users
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.email, email));
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined> {
    const result = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return result[0];
  }

  // Magic Link Tokens
  async createMagicLinkToken(token: InsertMagicLinkToken): Promise<MagicLinkToken> {
    const result = await db.insert(magicLinkTokens).values(token).returning();
    return result[0];
  }

  async getMagicLinkToken(token: string): Promise<MagicLinkToken | undefined> {
    const result = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.token, token));
    return result[0];
  }

  async deleteMagicLinkToken(token: string): Promise<void> {
    await db.delete(magicLinkTokens).where(eq(magicLinkTokens.token, token));
  }

  async deleteExpiredTokens(): Promise<void> {
    await db
      .delete(magicLinkTokens)
      .where(eq(magicLinkTokens.expiresAt, new Date()));
  }

  // Sessions
  async createSession(session: InsertSession): Promise<Session> {
    const result = await db.insert(sessions).values(session).returning();
    return result[0];
  }

  async getSession(token: string): Promise<Session | undefined> {
    const result = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token));
    return result[0];
  }

  async deleteSession(token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async deleteExpiredSessions(): Promise<void> {
    await db.delete(sessions).where(eq(sessions.expiresAt, new Date()));
  }

  // Orders
  async createOrder(order: InsertOrder): Promise<Order> {
    const result = await db.insert(orders).values(order).returning();
    return result[0];
  }

  async updateOrder(id: string, orderUpdate: Partial<InsertOrder>): Promise<Order | undefined> {
    const result = await db
      .update(orders)
      .set(orderUpdate)
      .where(eq(orders.id, id))
      .returning();
    return result[0];
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    return result[0];
  }

  async getOrderByOrderNumber(orderNumber: string): Promise<Order | undefined> {
    // Try exact match first
    let result = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber));
    if (result[0]) return result[0];
    
    // Try with # prefix (Shopify format)
    result = await db.select().from(orders).where(eq(orders.orderNumber, `#${orderNumber}`));
    if (result[0]) return result[0];
    
    // Try without # prefix
    const withoutHash = orderNumber.replace(/^#/, '');
    result = await db.select().from(orders).where(eq(orders.orderNumber, withoutHash));
    return result[0];
  }

  async searchOrders(query: string): Promise<Order[]> {
    const searchPattern = `%${query}%`;
    const result = await db
      .select()
      .from(orders)
      .where(
        or(
          ilike(orders.customerName, searchPattern),
          ilike(orders.customerEmail, searchPattern),
          ilike(orders.orderNumber, searchPattern),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(50);
    return result;
  }

  async getAllOrders(limit: number = 50): Promise<Order[]> {
    const result = await db
      .select()
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    return result;
  }

  // Shipments
  async createShipment(shipment: InsertShipment): Promise<Shipment> {
    const result = await db.insert(shipments).values(shipment).returning();
    return result[0];
  }

  async updateShipment(id: string, shipmentUpdate: Partial<InsertShipment>): Promise<Shipment | undefined> {
    const result = await db
      .update(shipments)
      .set({ ...shipmentUpdate, updatedAt: new Date() })
      .where(eq(shipments.id, id))
      .returning();
    return result[0];
  }

  async getShipment(id: string): Promise<Shipment | undefined> {
    const result = await db.select().from(shipments).where(eq(shipments.id, id));
    return result[0];
  }

  async getAllShipments(): Promise<Shipment[]> {
    const result = await db
      .select()
      .from(shipments)
      .orderBy(desc(shipments.createdAt));
    return result;
  }

  async getShipmentsByOrderId(orderId: string): Promise<Shipment[]> {
    const result = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .orderBy(desc(shipments.createdAt));
    return result;
  }

  async getShipmentByTrackingNumber(trackingNumber: string): Promise<Shipment | undefined> {
    const result = await db
      .select()
      .from(shipments)
      .where(eq(shipments.trackingNumber, trackingNumber));
    return result[0];
  }

  async getShipmentByShipmentId(shipmentId: string): Promise<Shipment | undefined> {
    const result = await db
      .select()
      .from(shipments)
      .where(eq(shipments.shipmentId, shipmentId));
    return result[0];
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.getUser(id);
  }

  // Products
  async upsertProduct(product: InsertProduct): Promise<Product> {
    const result = await db
      .insert(products)
      .values({
        ...product,
        updatedAt: new Date(),
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          ...product,
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  async softDeleteProduct(id: string): Promise<void> {
    await db
      .update(products)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(products.id, id));
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const result = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deletedAt)));
    return result[0];
  }

  async getAllProducts(includeDeleted: boolean = false): Promise<Product[]> {
    let query = db
      .select()
      .from(products);
    
    if (!includeDeleted) {
      query = query.where(isNull(products.deletedAt));
    }
    
    const result = await query.orderBy(desc(products.createdAt));
    return result;
  }

  async getAllProductsWithVariants(includeDeleted: boolean = false): Promise<Array<{ product: Product; variants: ProductVariant[] }>> {
    const allProducts = await this.getAllProducts(includeDeleted);
    
    const allVariants = await db
      .select()
      .from(productVariants)
      .where(isNull(productVariants.deletedAt))
      .orderBy(productVariants.title);
    
    const variantsByProduct = new Map<string, ProductVariant[]>();
    for (const variant of allVariants) {
      if (!variantsByProduct.has(variant.productId)) {
        variantsByProduct.set(variant.productId, []);
      }
      variantsByProduct.get(variant.productId)!.push(variant);
    }
    
    return allProducts.map(product => ({
      product,
      variants: variantsByProduct.get(product.id) || []
    }));
  }

  // Product Variants
  async upsertProductVariant(variant: InsertProductVariant): Promise<ProductVariant> {
    const result = await db
      .insert(productVariants)
      .values({
        ...variant,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: productVariants.id,
        set: {
          ...variant,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  async softDeleteProductVariant(id: string): Promise<void> {
    await db
      .update(productVariants)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(productVariants.id, id));
  }

  async getProductVariant(id: string): Promise<ProductVariant | undefined> {
    const result = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.id, id), isNull(productVariants.deletedAt)));
    return result[0];
  }

  async getProductVariants(productId: string): Promise<ProductVariant[]> {
    const result = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)))
      .orderBy(productVariants.title);
    return result;
  }

  async getVariantByBarcode(barcode: string): Promise<ProductVariant | undefined> {
    const result = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.barCode, barcode), isNull(productVariants.deletedAt)));
    return result[0];
  }

  async getVariantBySku(sku: string): Promise<ProductVariant | undefined> {
    const result = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.sku, sku), isNull(productVariants.deletedAt)));
    return result[0];
  }

  // Backfill Jobs
  async createBackfillJob(job: InsertBackfillJob): Promise<BackfillJob> {
    const result = await db.insert(backfillJobs).values(job).returning();
    return result[0];
  }

  async updateBackfillJob(id: string, updates: Partial<InsertBackfillJob>): Promise<BackfillJob | undefined> {
    const result = await db
      .update(backfillJobs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(backfillJobs.id, id))
      .returning();
    return result[0];
  }

  async getBackfillJob(id: string): Promise<BackfillJob | undefined> {
    const result = await db
      .select()
      .from(backfillJobs)
      .where(eq(backfillJobs.id, id));
    return result[0];
  }

  async getAllBackfillJobs(): Promise<BackfillJob[]> {
    const result = await db
      .select()
      .from(backfillJobs)
      .orderBy(desc(backfillJobs.createdAt));
    return result;
  }

  async deleteBackfillJob(id: string): Promise<void> {
    await db.delete(backfillJobs).where(eq(backfillJobs.id, id));
  }

  async incrementBackfillProgress(id: string, incrementBy: number): Promise<void> {
    // Only increment if job is still in_progress (prevents orphaned tasks from updating failed jobs)
    await db
      .update(backfillJobs)
      .set({
        processedOrders: sql`${backfillJobs.processedOrders} + ${incrementBy}`,
        updatedAt: new Date(),
      })
      .where(
        sql`${backfillJobs.id} = ${id} AND ${backfillJobs.status} = 'in_progress'`
      );
  }

  async incrementBackfillFailed(id: string, incrementBy: number): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        failedOrders: sql`${backfillJobs.failedOrders} + ${incrementBy}`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  // Print Queue
  async createPrintJob(job: InsertPrintQueue): Promise<PrintQueue> {
    const result = await db.insert(printQueue).values(job).returning();
    return result[0];
  }

  async updatePrintJob(id: string, updates: Partial<InsertPrintQueue>): Promise<PrintQueue | undefined> {
    const result = await db
      .update(printQueue)
      .set(updates)
      .where(eq(printQueue.id, id))
      .returning();
    return result[0];
  }

  async updatePrintJobStatus(id: string, status: string, printedAt?: Date): Promise<PrintQueue | undefined> {
    const result = await db
      .update(printQueue)
      .set({ 
        status,
        ...(printedAt && { printedAt })
      })
      .where(eq(printQueue.id, id))
      .returning();
    return result[0];
  }

  async getPrintJob(id: string): Promise<PrintQueue | undefined> {
    const result = await db
      .select()
      .from(printQueue)
      .where(eq(printQueue.id, id));
    return result[0];
  }

  async getActivePrintJobs(): Promise<PrintQueue[]> {
    const result = await db
      .select()
      .from(printQueue)
      .where(or(eq(printQueue.status, "queued"), eq(printQueue.status, "printing")))
      .orderBy(desc(printQueue.queuedAt));
    return result;
  }

  async getPrintJobsByOrderId(orderId: string): Promise<PrintQueue[]> {
    const result = await db
      .select()
      .from(printQueue)
      .where(eq(printQueue.orderId, orderId))
      .orderBy(desc(printQueue.queuedAt));
    return result;
  }

  async deletePrintJob(id: string): Promise<void> {
    await db.delete(printQueue).where(eq(printQueue.id, id));
  }
}

export const storage = new DatabaseStorage();
