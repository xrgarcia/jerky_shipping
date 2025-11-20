import { eq, desc, or, ilike, and, sql, isNull, isNotNull, gte, lte, inArray, asc, count } from "drizzle-orm";
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
  type ShipmentItem,
  shipmentItems,
  type ShipmentTag,
  shipmentTags,
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
  type OrderRefund,
  type InsertOrderRefund,
  orderRefunds,
  type OrderItem,
  type InsertOrderItem,
  orderItems,
  type ShipmentSyncFailure,
  shipmentSyncFailures,
  type ShopifyOrderSyncFailure,
  shopifyOrderSyncFailures,
} from "@shared/schema";

export interface OrderFilters {
  search?: string; // Search order number, customer name/email, tracking number, SKU, product title
  fulfillmentStatus?: string[];
  financialStatus?: string[];
  shipmentStatus?: string[];
  hasShipment?: boolean;
  hasRefund?: boolean;
  carrierCode?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  minTotal?: number;
  maxTotal?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'orderTotal' | 'customerName';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ShipmentFilters {
  search?: string; // Search tracking number, carrier, order number, customer name
  status?: string; // Single status for cascading filter
  statusDescription?: string;
  shipmentStatus?: string; // Warehouse status (on_hold, awaiting_shipment, etc.) - supports "null" for null values
  carrierCode?: string[];
  dateFrom?: Date; // Ship date range
  dateTo?: Date;
  orphaned?: boolean; // Filter for shipments missing tracking number, ship date, and shipment ID
  withoutOrders?: boolean; // Filter for shipments with no linked order
  sortBy?: 'shipDate' | 'createdAt' | 'trackingNumber' | 'status' | 'carrierCode' | 'orderDate';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

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
  getOrdersInDateRange(startDate: Date, endDate: Date): Promise<Order[]>;
  getFilteredOrders(filters: OrderFilters): Promise<{ orders: Order[], total: number }>;
  getOrdersWithoutShipments(): Promise<Order[]>;

  // Order Refunds
  upsertOrderRefund(refund: InsertOrderRefund): Promise<OrderRefund>;
  getOrderRefunds(orderId: string): Promise<OrderRefund[]>;
  getRefundsInDateRange(startDate: Date, endDate: Date): Promise<OrderRefund[]>;
  getOrderRefundByShopifyId(shopifyRefundId: string): Promise<OrderRefund | undefined>;

  // Order Items
  upsertOrderItem(item: InsertOrderItem): Promise<OrderItem>;
  getOrderItems(orderId: string): Promise<OrderItem[]>;
  getOrderItemByShopifyId(shopifyLineItemId: string): Promise<OrderItem | undefined>;
  getAllOrderItems(): Promise<OrderItem[]>;

  // Shipments
  createShipment(shipment: InsertShipment): Promise<Shipment>;
  updateShipment(id: string, shipment: Partial<InsertShipment>): Promise<Shipment | undefined>;
  getShipment(id: string): Promise<Shipment | undefined>;
  getAllShipments(): Promise<Shipment[]>;
  getShipmentsByOrderId(orderId: string): Promise<Shipment[]>;
  getShipmentsByOrderNumber(orderNumber: string): Promise<Shipment[]>;
  getShipmentByTrackingNumber(trackingNumber: string): Promise<Shipment | undefined>;
  getShipmentByShipmentId(shipmentId: string): Promise<Shipment | undefined>;
  getNonDeliveredShipments(): Promise<Shipment[]>;
  getFilteredShipments(filters: ShipmentFilters): Promise<{ shipments: Shipment[], total: number }>;
  getFilteredShipmentsWithOrders(filters: ShipmentFilters): Promise<{ shipments: any[], total: number }>;
  getDistinctStatuses(): Promise<string[]>;
  getDistinctStatusDescriptions(status?: string): Promise<string[]>;
  getDistinctShipmentStatuses(): Promise<Array<string | null>>;
  getShipmentItems(shipmentId: string): Promise<ShipmentItem[]>;
  getShipmentTags(shipmentId: string): Promise<ShipmentTag[]>;
  getShipmentItemsByOrderItemId(orderItemId: string): Promise<Array<ShipmentItem & { shipment: Shipment }>>;
  getShipmentItemsByExternalOrderItemId(externalOrderItemId: string): Promise<Array<ShipmentItem & { shipment: Shipment }>>;
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
  getProductVariantsBySKUs(skus: string[]): Promise<ProductVariant[]>;

  // Backfill Jobs
  createBackfillJob(job: InsertBackfillJob): Promise<BackfillJob>;
  updateBackfillJob(id: string, updates: Partial<InsertBackfillJob>): Promise<BackfillJob | undefined>;
  getBackfillJob(id: string): Promise<BackfillJob | undefined>;
  getAllBackfillJobs(): Promise<BackfillJob[]>;
  deleteBackfillJob(id: string): Promise<void>;
  incrementBackfillProgress(id: string, incrementBy: number): Promise<void>;
  incrementBackfillFailed(id: string, incrementBy: number): Promise<void>;
  incrementBackfillFetchTaskCompleted(id: string): Promise<void>;
  incrementBackfillFetchTaskFailed(id: string): Promise<void>;
  incrementBackfillShopifyFetchCompleted(id: string): Promise<void>;
  incrementBackfillShopifyFetchFailed(id: string): Promise<void>;
  incrementBackfillShipstationFetchCompleted(id: string): Promise<void>;
  incrementBackfillShipstationFetchFailed(id: string): Promise<void>;

  // Print Queue
  createPrintJob(job: InsertPrintQueue): Promise<PrintQueue>;
  updatePrintJob(id: string, updates: Partial<InsertPrintQueue>): Promise<PrintQueue | undefined>;
  updatePrintJobStatus(id: string, status: string, printedAt?: Date): Promise<PrintQueue | undefined>;
  getPrintJob(id: string): Promise<PrintQueue | undefined>;
  getActivePrintJobs(): Promise<PrintQueue[]>;
  getPrintJobsByOrderId(orderId: string): Promise<PrintQueue[]>;
  deletePrintJob(id: string): Promise<void>;
  
  // Shipment Sync Failures
  getShipmentSyncFailureCount(): Promise<number>;
  getShipmentSyncFailures(limit?: number, offset?: number): Promise<ShipmentSyncFailure[]>;
  clearShipmentSyncFailures(): Promise<void>;
  
  // Shopify Order Sync Failures
  getShopifyOrderSyncFailureCount(): Promise<number>;
  getShopifyOrderSyncFailures(limit?: number, offset?: number): Promise<ShopifyOrderSyncFailure[]>;
  clearShopifyOrderSyncFailures(): Promise<void>;

  // Data Health Metrics
  getDataHealthMetrics(): Promise<{
    ordersMissingShipments: number;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    shopifyOrderSyncFailures: number;
  }>;
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
    
    // Try with # prefix (old Shopify format)
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

  async getOrdersWithoutShipments(): Promise<Order[]> {
    const result = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        customerPhone: orders.customerPhone,
        shippingAddress: orders.shippingAddress,
        lineItems: orders.lineItems,
        fulfillmentStatus: orders.fulfillmentStatus,
        financialStatus: orders.financialStatus,
        totalPrice: orders.totalPrice,
        orderTotal: orders.orderTotal,
        subtotalPrice: orders.subtotalPrice,
        currentTotalPrice: orders.currentTotalPrice,
        currentSubtotalPrice: orders.currentSubtotalPrice,
        shippingTotal: orders.shippingTotal,
        totalDiscounts: orders.totalDiscounts,
        currentTotalDiscounts: orders.currentTotalDiscounts,
        totalTax: orders.totalTax,
        currentTotalTax: orders.currentTotalTax,
        totalAdditionalFees: orders.totalAdditionalFees,
        currentTotalAdditionalFees: orders.currentTotalAdditionalFees,
        totalOutstanding: orders.totalOutstanding,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        lastSyncedAt: orders.lastSyncedAt,
      })
      .from(orders)
      .leftJoin(shipments, eq(shipments.orderId, orders.id))
      .where(isNull(shipments.orderId))
      .orderBy(desc(orders.createdAt));
    return result;
  }

  async getOrdersInDateRange(startDate: Date, endDate: Date): Promise<Order[]> {
    const result = await db
      .select()
      .from(orders)
      .where(
        and(
          gte(orders.createdAt, startDate),
          lte(orders.createdAt, endDate)
        )
      )
      .orderBy(orders.createdAt);
    return result;
  }

  async getFilteredOrders(filters: OrderFilters): Promise<{ orders: Order[], total: number }> {
    const {
      search,
      fulfillmentStatus,
      financialStatus,
      shipmentStatus,
      hasShipment,
      hasRefund,
      carrierCode,
      dateFrom,
      dateTo,
      minTotal,
      maxTotal,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      pageSize = 50,
    } = filters;

    const conditions: any[] = [];

    // Date range filter
    if (dateFrom) {
      conditions.push(gte(orders.createdAt, dateFrom));
    }
    if (dateTo) {
      conditions.push(lte(orders.createdAt, dateTo));
    }

    // Status filters
    if (fulfillmentStatus && fulfillmentStatus.length > 0) {
      conditions.push(inArray(orders.fulfillmentStatus, fulfillmentStatus));
    }
    if (financialStatus && financialStatus.length > 0) {
      conditions.push(inArray(orders.financialStatus, financialStatus));
    }

    // Price range filter
    if (minTotal !== undefined) {
      conditions.push(sql`CAST(${orders.orderTotal} AS DECIMAL) >= ${minTotal}`);
    }
    if (maxTotal !== undefined) {
      conditions.push(sql`CAST(${orders.orderTotal} AS DECIMAL) <= ${maxTotal}`);
    }

    // Search - need to check multiple tables
    if (search) {
      const searchPattern = `%${search}%`;
      
      // Get order IDs that match search in orders table
      const orderIdsByOrders = db
        .select({ orderId: orders.id })
        .from(orders)
        .where(
          or(
            ilike(orders.orderNumber, searchPattern),
            ilike(orders.customerName, searchPattern),
            ilike(orders.customerEmail, searchPattern),
          )
        );

      // Get order IDs that have matching tracking numbers
      const orderIdsByTracking = db
        .selectDistinct({ orderId: shipments.orderId })
        .from(shipments)
        .where(ilike(shipments.trackingNumber, searchPattern));

      // Get order IDs that have matching SKUs or product titles
      const orderIdsByItems = db
        .selectDistinct({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(
          or(
            ilike(orderItems.sku, searchPattern),
            ilike(orderItems.title, searchPattern),
          )
        );

      // Combine all search results
      conditions.push(
        or(
          sql`${orders.id} IN ${orderIdsByOrders}`,
          sql`${orders.id} IN ${orderIdsByTracking}`,
          sql`${orders.id} IN ${orderIdsByItems}`,
        )
      );
    }

    // Shipment filters - need to check if order has shipments
    if (hasShipment !== undefined || shipmentStatus || carrierCode) {
      if (hasShipment === true) {
        const orderIdsWithShipments = db
          .selectDistinct({ orderId: shipments.orderId })
          .from(shipments)
          .where(isNotNull(shipments.orderId));
        conditions.push(sql`${orders.id} IN ${orderIdsWithShipments}`);
      } else if (hasShipment === false) {
        const orderIdsWithShipments = db
          .selectDistinct({ orderId: shipments.orderId })
          .from(shipments)
          .where(isNotNull(shipments.orderId));
        conditions.push(sql`${orders.id} NOT IN ${orderIdsWithShipments}`);
      }

      if (shipmentStatus && shipmentStatus.length > 0) {
        const orderIdsByShipmentStatus = db
          .selectDistinct({ orderId: shipments.orderId })
          .from(shipments)
          .where(
            and(
              isNotNull(shipments.orderId),
              inArray(shipments.status, shipmentStatus)
            )
          );
        conditions.push(sql`${orders.id} IN ${orderIdsByShipmentStatus}`);
      }

      if (carrierCode && carrierCode.length > 0) {
        const orderIdsByCarrier = db
          .selectDistinct({ orderId: shipments.orderId })
          .from(shipments)
          .where(
            and(
              isNotNull(shipments.orderId),
              inArray(shipments.carrierCode, carrierCode)
            )
          );
        conditions.push(sql`${orders.id} IN ${orderIdsByCarrier}`);
      }
    }

    // Refund filter
    if (hasRefund !== undefined) {
      const orderIdsWithRefunds = db
        .selectDistinct({ orderId: orderRefunds.orderId })
        .from(orderRefunds);
      
      if (hasRefund === true) {
        conditions.push(sql`${orders.id} IN ${orderIdsWithRefunds}`);
      } else {
        conditions.push(sql`${orders.id} NOT IN ${orderIdsWithRefunds}`);
      }
    }

    // Build the where clause
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: count() })
      .from(orders)
      .where(whereClause);
    const total = countResult[0]?.count || 0;

    // Determine sort column and direction
    let sortColumn;
    switch (sortBy) {
      case 'updatedAt':
        sortColumn = orders.updatedAt;
        break;
      case 'orderTotal':
        sortColumn = sql`CAST(${orders.orderTotal} AS DECIMAL)`;
        break;
      case 'customerName':
        sortColumn = orders.customerName;
        break;
      default:
        sortColumn = orders.createdAt;
    }

    const orderByClause = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

    // Get paginated results
    const offset = (page - 1) * pageSize;
    const result = await db
      .select()
      .from(orders)
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(pageSize)
      .offset(offset);

    return { orders: result, total };
  }

  // Order Refunds
  async upsertOrderRefund(refund: InsertOrderRefund): Promise<OrderRefund> {
    const existing = await this.getOrderRefundByShopifyId(refund.shopifyRefundId);
    
    if (existing) {
      const result = await db
        .update(orderRefunds)
        .set({ ...refund, updatedAt: new Date() })
        .where(eq(orderRefunds.shopifyRefundId, refund.shopifyRefundId))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(orderRefunds).values(refund).returning();
      return result[0];
    }
  }

  async getOrderRefunds(orderId: string): Promise<OrderRefund[]> {
    const result = await db
      .select()
      .from(orderRefunds)
      .where(eq(orderRefunds.orderId, orderId))
      .orderBy(desc(orderRefunds.refundedAt));
    return result;
  }

  async getRefundsInDateRange(startDate: Date, endDate: Date): Promise<OrderRefund[]> {
    const result = await db
      .select()
      .from(orderRefunds)
      .where(
        and(
          gte(orderRefunds.refundedAt, startDate),
          lte(orderRefunds.refundedAt, endDate)
        )
      )
      .orderBy(orderRefunds.refundedAt);
    return result;
  }

  async getOrderRefundByShopifyId(shopifyRefundId: string): Promise<OrderRefund | undefined> {
    const result = await db
      .select()
      .from(orderRefunds)
      .where(eq(orderRefunds.shopifyRefundId, shopifyRefundId));
    return result[0];
  }

  // Order Items
  async upsertOrderItem(item: InsertOrderItem): Promise<OrderItem> {
    const existing = await this.getOrderItemByShopifyId(item.shopifyLineItemId);
    
    if (existing) {
      const result = await db
        .update(orderItems)
        .set({ ...item, updatedAt: new Date() })
        .where(eq(orderItems.shopifyLineItemId, item.shopifyLineItemId))
        .returning();
      return result[0];
    } else {
      const result = await db.insert(orderItems).values(item).returning();
      return result[0];
    }
  }

  async getOrderItems(orderId: string): Promise<OrderItem[]> {
    const result = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.createdAt);
    return result;
  }

  async getOrderItemByShopifyId(shopifyLineItemId: string): Promise<OrderItem | undefined> {
    const result = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.shopifyLineItemId, shopifyLineItemId));
    return result[0];
  }

  async getAllOrderItems(): Promise<OrderItem[]> {
    const result = await db
      .select()
      .from(orderItems)
      .orderBy(orderItems.createdAt);
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

  async getShipmentsByOrderNumber(orderNumber: string): Promise<Shipment[]> {
    const result = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderNumber, orderNumber))
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

  async getNonDeliveredShipments(): Promise<Shipment[]> {
    const result = await db
      .select()
      .from(shipments)
      .where(
        and(
          sql`${shipments.status} != 'DE'`,
          isNull(shipments.actualDeliveryDate)
        )
      )
      .orderBy(desc(shipments.createdAt));
    return result;
  }

  async getShipmentItems(shipmentId: string): Promise<ShipmentItem[]> {
    const result = await db
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, shipmentId))
      .orderBy(asc(shipmentItems.createdAt));
    return result;
  }

  async getShipmentTags(shipmentId: string): Promise<ShipmentTag[]> {
    const result = await db
      .select()
      .from(shipmentTags)
      .where(eq(shipmentTags.shipmentId, shipmentId))
      .orderBy(asc(shipmentTags.createdAt));
    return result;
  }

  async getShipmentItemsByOrderItemId(orderItemId: string): Promise<Array<ShipmentItem & { shipment: Shipment }>> {
    const result = await db
      .select({
        id: shipmentItems.id,
        shipmentId: shipmentItems.shipmentId,
        orderItemId: shipmentItems.orderItemId,
        sku: shipmentItems.sku,
        name: shipmentItems.name,
        quantity: shipmentItems.quantity,
        unitPrice: shipmentItems.unitPrice,
        imageUrl: shipmentItems.imageUrl,
        externalOrderItemId: shipmentItems.externalOrderItemId,
        createdAt: shipmentItems.createdAt,
        shipment: shipments,
      })
      .from(shipmentItems)
      .leftJoin(shipments, eq(shipmentItems.shipmentId, shipments.id))
      .where(eq(shipmentItems.orderItemId, orderItemId))
      .orderBy(asc(shipmentItems.createdAt));
    
    return result.map(row => ({
      id: row.id,
      shipmentId: row.shipmentId,
      orderItemId: row.orderItemId,
      sku: row.sku,
      name: row.name,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      imageUrl: row.imageUrl,
      externalOrderItemId: row.externalOrderItemId,
      createdAt: row.createdAt,
      shipment: row.shipment!,
    }));
  }

  async getShipmentItemsByExternalOrderItemId(externalOrderItemId: string): Promise<Array<ShipmentItem & { shipment: Shipment }>> {
    const result = await db
      .select({
        id: shipmentItems.id,
        shipmentId: shipmentItems.shipmentId,
        orderItemId: shipmentItems.orderItemId,
        sku: shipmentItems.sku,
        name: shipmentItems.name,
        quantity: shipmentItems.quantity,
        unitPrice: shipmentItems.unitPrice,
        imageUrl: shipmentItems.imageUrl,
        externalOrderItemId: shipmentItems.externalOrderItemId,
        createdAt: shipmentItems.createdAt,
        shipment: shipments,
      })
      .from(shipmentItems)
      .leftJoin(shipments, eq(shipmentItems.shipmentId, shipments.id))
      .where(eq(shipmentItems.externalOrderItemId, externalOrderItemId))
      .orderBy(asc(shipmentItems.createdAt));
    
    return result.map(row => ({
      id: row.id,
      shipmentId: row.shipmentId,
      orderItemId: row.orderItemId,
      sku: row.sku,
      name: row.name,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      imageUrl: row.imageUrl,
      externalOrderItemId: row.externalOrderItemId,
      createdAt: row.createdAt,
      shipment: row.shipment!,
    }));
  }

  async getFilteredShipments(filters: ShipmentFilters): Promise<{ shipments: Shipment[], total: number }> {
    const {
      search,
      status: statusFilter,
      statusDescription,
      shipmentStatus,
      carrierCode: carrierFilters,
      dateFrom,
      dateTo,
      orphaned,
      withoutOrders,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      pageSize = 50,
    } = filters;

    // Build WHERE conditions
    const conditions = [];

    // Text search across tracking number, carrier, order fields
    if (search) {
      const searchLower = search.toLowerCase();
      conditions.push(
        or(
          ilike(shipments.trackingNumber, `%${searchLower}%`),
          ilike(shipments.carrierCode, `%${searchLower}%`),
          ilike(shipments.shipmentId, `%${searchLower}%`),
          ilike(shipments.orderNumber, `%${searchLower}%`),
          ilike(shipments.shipToName, `%${searchLower}%`)
        )
      );
    }

    // Status filter (single value for cascading)
    if (statusFilter) {
      conditions.push(eq(shipments.status, statusFilter));
    }

    // Status description filter
    if (statusDescription) {
      conditions.push(eq(shipments.statusDescription, statusDescription));
    }

    // Shipment status filter (warehouse status) - supports "null" for null values
    if (shipmentStatus !== undefined && shipmentStatus !== "") {
      if (shipmentStatus === "null") {
        conditions.push(isNull(shipments.shipmentStatus));
      } else {
        conditions.push(eq(shipments.shipmentStatus, shipmentStatus));
      }
    }

    // Carrier filter
    if (carrierFilters && carrierFilters.length > 0) {
      conditions.push(inArray(shipments.carrierCode, carrierFilters));
    }

    // Date range filter (ship date)
    if (dateFrom) {
      conditions.push(gte(shipments.shipDate, dateFrom));
    }
    if (dateTo) {
      conditions.push(lte(shipments.shipDate, dateTo));
    }

    // Orphaned filter (shipments missing tracking number, ship date, and shipment ID)
    if (orphaned) {
      conditions.push(
        and(
          or(isNull(shipments.trackingNumber), eq(shipments.trackingNumber, '')),
          isNull(shipments.shipDate),
          or(isNull(shipments.shipmentId), eq(shipments.shipmentId, ''))
        )
      );
    }

    // Without orders filter (shipments with no linked order)
    if (withoutOrders) {
      conditions.push(isNull(shipments.orderId));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(whereClause);
    const total = countResult[0]?.count || 0;

    // Build ORDER BY - default to createdAt if sortBy is invalid
    const sortColumn = {
      shipDate: shipments.shipDate,
      orderDate: shipments.createdAt, // Use createdAt as proxy for now
      createdAt: shipments.createdAt,
      trackingNumber: shipments.trackingNumber,
      status: shipments.status,
      carrierCode: shipments.carrierCode,
    }[sortBy] || shipments.createdAt;

    // Use NULLS LAST for date columns
    let orderByClause;
    if (sortBy === 'shipDate' || sortBy === 'orderDate') {
      orderByClause = sortOrder === 'asc' 
        ? sql`${sortColumn} ASC NULLS LAST`
        : sql`${sortColumn} DESC NULLS LAST`;
    } else {
      orderByClause = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);
    }

    // Get paginated results
    const offset = (page - 1) * pageSize;
    const result = await db
      .select()
      .from(shipments)
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(pageSize)
      .offset(offset);

    return { shipments: result, total };
  }

  async getDistinctStatuses(): Promise<string[]> {
    const results = await db
      .selectDistinct({ status: shipments.status })
      .from(shipments)
      .where(isNotNull(shipments.status))
      .orderBy(shipments.status);
    
    return results.map(r => r.status).filter((s): s is string => s !== null);
  }

  async getDistinctStatusDescriptions(status?: string): Promise<string[]> {
    const conditions = [isNotNull(shipments.statusDescription)];
    
    // Filter by status if provided
    if (status) {
      conditions.push(eq(shipments.status, status));
    }
    
    const results = await db
      .selectDistinct({ statusDescription: shipments.statusDescription })
      .from(shipments)
      .where(and(...conditions))
      .orderBy(shipments.statusDescription);
    
    return results.map(r => r.statusDescription).filter((s): s is string => s !== null);
  }

  async getDistinctShipmentStatuses(): Promise<Array<string | null>> {
    const results = await db
      .selectDistinct({ shipmentStatus: shipments.shipmentStatus })
      .from(shipments)
      .orderBy(shipments.shipmentStatus);
    
    return results.map(r => r.shipmentStatus);
  }

  async getFilteredShipmentsWithOrders(filters: ShipmentFilters): Promise<{ shipments: any[], total: number }> {
    const {
      search,
      status: statusFilters,
      statusDescription,
      carrierCode: carrierFilters,
      dateFrom,
      dateTo,
      orphaned,
      withoutOrders,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      page = 1,
      pageSize = 50,
    } = filters;

    // Build WHERE conditions
    const conditions = [];

    // Text search across tracking number, carrier, order fields
    if (search) {
      const searchLower = search.toLowerCase();
      conditions.push(
        or(
          ilike(shipments.trackingNumber, `%${searchLower}%`),
          ilike(shipments.carrierCode, `%${searchLower}%`),
          ilike(shipments.shipmentId, `%${searchLower}%`),
          ilike(orders.orderNumber, `%${searchLower}%`),
          ilike(orders.customerName, `%${searchLower}%`)
        )
      );
    }

    // Status filter
    if (statusFilters && statusFilters.length > 0) {
      conditions.push(inArray(shipments.status, statusFilters));
    }

    // Status description filter
    if (statusDescription) {
      conditions.push(eq(shipments.statusDescription, statusDescription));
    }

    // Carrier filter
    if (carrierFilters && carrierFilters.length > 0) {
      conditions.push(inArray(shipments.carrierCode, carrierFilters));
    }

    // Date range filter (ship date)
    if (dateFrom) {
      conditions.push(gte(shipments.shipDate, dateFrom));
    }
    if (dateTo) {
      conditions.push(lte(shipments.shipDate, dateTo));
    }

    // Orphaned filter - shipments missing tracking number, ship date, and shipment ID
    if (orphaned) {
      conditions.push(
        and(
          isNull(shipments.trackingNumber),
          isNull(shipments.shipDate),
          isNull(shipments.shipmentId)
        )
      );
    }

    // Without orders filter - shipments with no linked order
    if (withoutOrders) {
      conditions.push(isNull(shipments.orderId));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count with JOIN
    const countResult = await db
      .select({ count: count() })
      .from(shipments)
      .leftJoin(orders, eq(shipments.orderId, orders.id))
      .where(whereClause);
    const total = countResult[0]?.count || 0;

    // Build ORDER BY - default to createdAt if sortBy is invalid
    let orderByClause;
    const sortColumn = {
      shipDate: shipments.shipDate,
      orderDate: shipments.createdAt, // Use createdAt as proxy for now
      createdAt: shipments.createdAt,
      trackingNumber: shipments.trackingNumber,
      status: shipments.status,
      carrierCode: shipments.carrierCode,
    }[sortBy] || shipments.createdAt;
    
    // Use NULLS LAST for date columns
    if (sortBy === 'shipDate' || sortBy === 'orderDate') {
      orderByClause = sortOrder === 'asc' 
        ? sql`${sortColumn} ASC NULLS LAST`
        : sql`${sortColumn} DESC NULLS LAST`;
    } else {
      orderByClause = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);
    }

    // Get paginated results with LEFT JOIN
    const offset = (page - 1) * pageSize;
    const result = await db
      .select({
        // Shipment fields
        id: shipments.id,
        orderId: shipments.orderId,
        shipmentId: shipments.shipmentId,
        trackingNumber: shipments.trackingNumber,
        carrierCode: shipments.carrierCode,
        serviceCode: shipments.serviceCode,
        status: shipments.status,
        statusDescription: shipments.statusDescription,
        labelUrl: shipments.labelUrl,
        shipDate: shipments.shipDate,
        estimatedDeliveryDate: shipments.estimatedDeliveryDate,
        actualDeliveryDate: shipments.actualDeliveryDate,
        shipmentData: shipments.shipmentData,
        createdAt: shipments.createdAt,
        updatedAt: shipments.updatedAt,
        // Customer/shipping fields from shipments table (ShipStation data)
        orderNumber: shipments.orderNumber,
        orderDate: shipments.orderDate,
        shipToName: shipments.shipToName,
        shipToCompany: shipments.shipToCompany,
        shipToEmail: shipments.shipToEmail,
        shipToPhone: shipments.shipToPhone,
        shipToAddressLine1: shipments.shipToAddressLine1,
        shipToAddressLine2: shipments.shipToAddressLine2,
        shipToAddressLine3: shipments.shipToAddressLine3,
        shipToCity: shipments.shipToCity,
        shipToState: shipments.shipToState,
        shipToPostalCode: shipments.shipToPostalCode,
        shipToCountry: shipments.shipToCountry,
        totalWeight: shipments.totalWeight,
        // Special flags
        isGift: shipments.isGift,
        isReturn: shipments.isReturn,
        saturdayDelivery: shipments.saturdayDelivery,
        containsAlcohol: shipments.containsAlcohol,
        notesForGift: shipments.notesForGift,
        notesFromBuyer: shipments.notesFromBuyer,
        // Item count (subquery)
        itemCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${shipmentItems}
          WHERE ${shipmentItems.shipmentId} = ${shipments.id}
        )`.as('item_count'),
        // Order fields (will be null if no matching order)
        order: {
          id: orders.id,
          orderNumber: orders.orderNumber,
          customerName: orders.customerName,
          customerEmail: orders.customerEmail,
          customerPhone: orders.customerPhone,
          shippingAddress: orders.shippingAddress,
          lineItems: orders.lineItems,
          fulfillmentStatus: orders.fulfillmentStatus,
          financialStatus: orders.financialStatus,
          totalPrice: orders.totalPrice,
          orderTotal: orders.orderTotal,
          subtotalPrice: orders.subtotalPrice,
          currentTotalPrice: orders.currentTotalPrice,
          currentSubtotalPrice: orders.currentSubtotalPrice,
          shippingTotal: orders.shippingTotal,
          totalDiscounts: orders.totalDiscounts,
          currentTotalDiscounts: orders.currentTotalDiscounts,
          totalTax: orders.totalTax,
          currentTotalTax: orders.currentTotalTax,
          totalAdditionalFees: orders.totalAdditionalFees,
          currentTotalAdditionalFees: orders.currentTotalAdditionalFees,
          totalOutstanding: orders.totalOutstanding,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          lastSyncedAt: orders.lastSyncedAt,
        }
      })
      .from(shipments)
      .leftJoin(orders, eq(shipments.orderId, orders.id))
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(pageSize)
      .offset(offset);

    return { shipments: result, total };
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

  async getProductVariantsBySKUs(skus: string[]): Promise<ProductVariant[]> {
    if (skus.length === 0) return [];
    
    const result = await db
      .select()
      .from(productVariants)
      .where(
        and(
          inArray(productVariants.sku, skus),
          isNull(productVariants.deletedAt)
        )
      );
    return result;
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
    // Allow increments regardless of job status to get accurate final count
    // This ensures all processed orders are counted even if job completes before worker finishes
    await db
      .update(backfillJobs)
      .set({
        processedOrders: sql`${backfillJobs.processedOrders} + ${incrementBy}`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
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

  async incrementBackfillFetchTaskCompleted(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        completedFetchTasks: sql`${backfillJobs.completedFetchTasks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  async incrementBackfillFetchTaskFailed(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        failedFetchTasks: sql`${backfillJobs.failedFetchTasks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  async incrementBackfillShopifyFetchCompleted(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        shopifyFetchCompleted: sql`${backfillJobs.shopifyFetchCompleted} + 1`,
        completedFetchTasks: sql`${backfillJobs.completedFetchTasks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  async incrementBackfillShopifyFetchFailed(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        shopifyFetchFailed: sql`${backfillJobs.shopifyFetchFailed} + 1`,
        failedFetchTasks: sql`${backfillJobs.failedFetchTasks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  async incrementBackfillShipstationFetchCompleted(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        shipstationFetchCompleted: sql`${backfillJobs.shipstationFetchCompleted} + 1`,
        completedFetchTasks: sql`${backfillJobs.completedFetchTasks} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(backfillJobs.id, id));
  }

  async incrementBackfillShipstationFetchFailed(id: string): Promise<void> {
    await db
      .update(backfillJobs)
      .set({
        shipstationFetchFailed: sql`${backfillJobs.shipstationFetchFailed} + 1`,
        failedFetchTasks: sql`${backfillJobs.failedFetchTasks} + 1`,
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

  // Shipment Sync Failures
  async getShipmentSyncFailureCount(): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(shipmentSyncFailures);
    return result[0]?.count || 0;
  }

  async getShipmentSyncFailures(limit: number = 50, offset: number = 0): Promise<ShipmentSyncFailure[]> {
    const result = await db
      .select()
      .from(shipmentSyncFailures)
      .orderBy(desc(shipmentSyncFailures.failedAt))
      .limit(limit)
      .offset(offset);
    return result;
  }

  // Data Health Metrics - Batched queries for comprehensive metrics
  async getDataHealthMetrics(): Promise<{
    ordersMissingShipments: number;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    shopifyOrderSyncFailures: number;
  }> {
    // Query 1: Orders missing shipments
    const ordersMissingShipmentsResult = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(shipments, eq(orders.id, shipments.orderId))
      .where(sql`${shipments.id} IS NULL`);
    
    // Query 2: Shipments without orders (orphaned by order relationship)
    const shipmentsWithoutOrdersResult = await db
      .select({ count: count() })
      .from(shipments)
      .leftJoin(orders, eq(shipments.orderId, orders.id))
      .where(sql`${orders.id} IS NULL`);
    
    // Query 3: Orphaned shipments (missing ALL three: tracking number, ship date, shipment ID)
    const orphanedShipmentsResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(
        sql`${shipments.trackingNumber} IS NULL AND ${shipments.shipDate} IS NULL AND ${shipments.shipmentId} IS NULL`
      );
    
    // Query 4: Shipped shipments without tracking numbers
    const shipmentsWithoutStatusResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(
        sql`${shipments.status} = 'shipped' AND ${shipments.trackingNumber} IS NULL`
      );
    
    // Query 5: Shipment sync failures count
    const syncFailuresResult = await db
      .select({ count: count() })
      .from(shipmentSyncFailures);
    
    // Query 6: Shopify order sync failures count
    const shopifyOrderSyncFailuresResult = await db
      .select({ count: count() })
      .from(shopifyOrderSyncFailures);
    
    return {
      ordersMissingShipments: ordersMissingShipmentsResult[0]?.count || 0,
      shipmentsWithoutOrders: shipmentsWithoutOrdersResult[0]?.count || 0,
      orphanedShipments: orphanedShipmentsResult[0]?.count || 0,
      shipmentsWithoutStatus: shipmentsWithoutStatusResult[0]?.count || 0,
      shipmentSyncFailures: syncFailuresResult[0]?.count || 0,
      shopifyOrderSyncFailures: shopifyOrderSyncFailuresResult[0]?.count || 0,
    };
  }

  async clearShipmentSyncFailures(): Promise<void> {
    await db.delete(shipmentSyncFailures);
  }
  
  async getShopifyOrderSyncFailureCount(): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(shopifyOrderSyncFailures);
    return result[0]?.count || 0;
  }

  async getShopifyOrderSyncFailures(limit: number = 50, offset: number = 0): Promise<ShopifyOrderSyncFailure[]> {
    const result = await db
      .select()
      .from(shopifyOrderSyncFailures)
      .orderBy(desc(shopifyOrderSyncFailures.failedAt))
      .limit(limit)
      .offset(offset);
    return result;
  }

  async clearShopifyOrderSyncFailures(): Promise<void> {
    await db.delete(shopifyOrderSyncFailures);
  }
}

export const storage = new DatabaseStorage();
