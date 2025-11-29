import { eq, ne, desc, or, ilike, and, sql, isNull, isNotNull, gte, lte, inArray, asc, count } from "drizzle-orm";
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
  type PackingLog,
  type InsertPackingLog,
  packingLogs,
  type ShipmentEvent,
  type InsertShipmentEvent,
  shipmentEvents,
  type SavedView,
  type InsertSavedView,
  savedViews,
  // Desktop Printing System
  type Station,
  type InsertStation,
  stations,
  type Printer,
  type InsertPrinter,
  printers,
  type DesktopClient,
  type InsertDesktopClient,
  desktopClients,
  type StationSession,
  type InsertStationSession,
  stationSessions,
  type PrintJob,
  type InsertPrintJob,
  printJobs,
  // Desktop Configuration
  type DesktopConfig,
  type InsertDesktopConfig,
  desktopConfig,
  // Web Packing Sessions
  type WebPackingSession,
  webPackingSessions,
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
  workflowTab?: 'in_progress' | 'packing_queue' | 'shipped' | 'all'; // Workflow tab filter
  status?: string; // Single status for cascading filter
  statusDescription?: string;
  shipmentStatus?: string[]; // Warehouse status (on_hold, awaiting_shipment, etc.) - supports "null" for null values
  carrierCode?: string[];
  dateFrom?: Date; // Ship date range
  dateTo?: Date;
  orphaned?: boolean; // Filter for shipments missing tracking number, ship date, and shipment ID
  withoutOrders?: boolean; // Filter for shipments with no linked order
  shippedWithoutTracking?: boolean; // Filter for shipments with status='shipped' but no tracking number
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
  getRefundsByOrderIds(orderIds: string[]): Promise<OrderRefund[]>;
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
  getShipmentTabCounts(): Promise<{ inProgress: number; packingQueue: number; shipped: number; all: number }>;
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
  getRunningBackfillJobs(): Promise<BackfillJob[]>;
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
  
  // Packing Logs
  createPackingLog(log: InsertPackingLog): Promise<PackingLog>;
  getPackingLogsByShipment(shipmentId: string): Promise<PackingLog[]>;
  getPackingLogsByUser(userId: string, limit?: number): Promise<PackingLog[]>;
  deletePackingLogsByShipment(shipmentId: string): Promise<void>;
  
  // Shipment Events
  createShipmentEvent(event: InsertShipmentEvent): Promise<ShipmentEvent>;
  getShipmentEventsByOrderNumber(orderNumber: string): Promise<ShipmentEvent[]>;
  getShipmentEventsByUser(username: string, limit?: number): Promise<ShipmentEvent[]>;
  getShipmentEventsByDateRange(startDate: Date, endDate: Date): Promise<ShipmentEvent[]>;
  deleteShipmentEventsByOrderNumber(orderNumber: string): Promise<void>;
  
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
    oldestOrderMissingShipmentAt: string | null;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    shopifyOrderSyncFailures: number;
  }>;

  // Pipeline Metrics (SkuVault session workflow)
  getPipelineMetrics(): Promise<{
    sessionedToday: number;
    inPackingQueue: number;
    shippedToday: number;
    oldestQueuedSessionAt: string | null;
  }>;

  // Saved Views
  getSavedView(id: string): Promise<SavedView | undefined>;
  getSavedViewsByUser(userId: string, page?: string): Promise<SavedView[]>;
  getPublicView(id: string): Promise<SavedView | undefined>;
  createSavedView(view: InsertSavedView): Promise<SavedView>;
  updateSavedView(id: string, userId: string, updates: Partial<InsertSavedView>): Promise<SavedView | undefined>;
  deleteSavedView(id: string, userId: string): Promise<boolean>;

  // ============================================================================
  // DESKTOP PRINTING SYSTEM
  // ============================================================================

  // Stations
  createStation(station: InsertStation): Promise<Station>;
  updateStation(id: string, updates: Partial<InsertStation>): Promise<Station | undefined>;
  getStation(id: string): Promise<Station | undefined>;
  getStationByName(name: string): Promise<Station | undefined>;
  getAllStations(activeOnly?: boolean): Promise<Station[]>;
  deleteStation(id: string): Promise<boolean>;

  // Printers
  createPrinter(printer: InsertPrinter): Promise<Printer>;
  updatePrinter(id: string, updates: Partial<InsertPrinter>): Promise<Printer | undefined>;
  getPrinter(id: string): Promise<Printer | undefined>;
  getPrinterBySystemName(systemName: string): Promise<Printer | undefined>;
  getPrintersByStation(stationId: string): Promise<Printer[]>;
  getAllPrinters(): Promise<Printer[]>;
  deletePrinter(id: string): Promise<boolean>;
  updatePrinterLastSeen(id: string): Promise<void>;
  setDefaultPrinter(stationId: string, printerId: string): Promise<Printer | undefined>;

  // Desktop Clients
  createDesktopClient(client: InsertDesktopClient): Promise<DesktopClient>;
  updateDesktopClient(id: string, updates: Partial<InsertDesktopClient>): Promise<DesktopClient | undefined>;
  getDesktopClient(id: string): Promise<DesktopClient | undefined>;
  getDesktopClientByAccessToken(accessTokenHash: string): Promise<DesktopClient | undefined>;
  getDesktopClientByRefreshToken(refreshTokenHash: string): Promise<DesktopClient | undefined>;
  getDesktopClientsByUser(userId: string): Promise<DesktopClient[]>;
  getDesktopClientByUserAndDevice(userId: string, deviceName: string): Promise<DesktopClient | undefined>;
  deleteDesktopClient(id: string): Promise<boolean>;
  updateDesktopClientActivity(id: string, lastIp?: string): Promise<void>;

  // Station Sessions
  createStationSession(session: InsertStationSession): Promise<StationSession>;
  updateStationSession(id: string, updates: Partial<{ status: string; endedAt: Date }>): Promise<StationSession | undefined>;
  getStationSession(id: string): Promise<StationSession | undefined>;
  getActiveSessionByStation(stationId: string): Promise<StationSession | undefined>;
  getActiveSessionByUser(userId: string): Promise<StationSession | undefined>;
  getActiveSessionByDesktopClient(desktopClientId: string): Promise<StationSession | undefined>;
  endStationSession(id: string): Promise<StationSession | undefined>;
  expireOldSessions(): Promise<number>;
  claimStationAtomically(session: InsertStationSession, clientId: string): Promise<{ session?: StationSession; error?: string; claimedBy?: string; expiresAt?: Date }>;

  // Print Jobs (Desktop)
  createPrintJob(job: InsertPrintJob): Promise<PrintJob>;
  updatePrintJob(id: string, updates: Partial<InsertPrintJob & { attempts?: number; sentAt?: Date; completedAt?: Date }>): Promise<PrintJob | undefined>;
  getPrintJob(id: string): Promise<PrintJob | undefined>;
  getDesktopPrintJob(id: string): Promise<PrintJob | undefined>;
  getPendingJobsByStation(stationId: string, limit?: number): Promise<PrintJob[]>;
  getJobsByStation(stationId: string, limit?: number): Promise<PrintJob[]>;
  getJobsByOrder(orderId: string): Promise<PrintJob[]>;
  getJobsByShipment(shipmentId: string): Promise<PrintJob[]>;
  getAllDesktopPrintJobs(limit?: number): Promise<PrintJob[]>;
  markJobSent(id: string): Promise<PrintJob | undefined>;
  markJobCompleted(id: string): Promise<PrintJob | undefined>;
  markJobFailed(id: string, errorMessage: string): Promise<PrintJob | undefined>;
  retryJob(id: string): Promise<PrintJob | undefined>;
  cancelJob(id: string): Promise<PrintJob | undefined>;

  // Desktop Configuration
  getDesktopConfig(): Promise<DesktopConfig>;
  updateDesktopConfig(updates: Partial<InsertDesktopConfig>, updatedBy?: string): Promise<DesktopConfig>;

  // Web Packing Sessions (daily station selection for web users)
  getActiveWebPackingSession(userId: string): Promise<WebPackingSession | undefined>;
  createWebPackingSession(userId: string, stationId: string, expiresAt: Date): Promise<WebPackingSession>;
  deleteWebPackingSession(userId: string): Promise<boolean>;
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
        // Also exclude refunded, restocked, and voided orders when filtering for orders missing shipments
        conditions.push(sql`(${orders.financialStatus} IS NULL OR LOWER(${orders.financialStatus}) NOT IN ('refunded', 'restocked', 'voided'))`);
        // Also exclude orders that have refunds in the order_refunds table
        const orderIdsWithRefunds = db
          .selectDistinct({ orderId: orderRefunds.orderId })
          .from(orderRefunds);
        conditions.push(sql`${orders.id} NOT IN ${orderIdsWithRefunds}`);
        // Also exclude orders with only non-shippable items (gift cards, digital products)
        conditions.push(sql`
          EXISTS (
            SELECT 1 FROM ${orderItems} 
            WHERE ${orderItems.orderId} = ${orders.id} 
            AND (${orderItems.requiresShipping} IS TRUE OR ${orderItems.requiresShipping} IS NULL)
          )
        `);
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

  async getRefundsByOrderIds(orderIds: string[]): Promise<OrderRefund[]> {
    if (orderIds.length === 0) {
      return [];
    }
    
    const result = await db
      .select()
      .from(orderRefunds)
      .where(inArray(orderRefunds.orderId, orderIds))
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
    // Upsert: insert new shipment or update existing if shipment_id conflicts
    // Only update fields that are present and defined (prevents NULL overwrites)
    // Immutable fields (id, createdAt, shipmentId) are excluded from updates
    const { id, createdAt, shipmentId: _, updatedAt: __, ...mutableFields } = shipment as any;
    
    // Build update set with only fields that have actual values
    const updateSet: any = { updatedAt: new Date() };
    Object.keys(mutableFields).forEach(key => {
      const value = (mutableFields as any)[key];
      // Only include fields that are explicitly provided (even if null)
      // Skip undefined values to preserve existing data
      if (value !== undefined) {
        updateSet[key] = value;
      }
    });
    
    const result = await db
      .insert(shipments)
      .values(shipment)
      .onConflictDoUpdate({
        target: shipments.shipmentId,
        set: updateSet,
      })
      .returning();
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
      workflowTab,
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

    // Workflow tab filter - applies different filters based on selected tab
    if (workflowTab) {
      switch (workflowTab) {
        case 'in_progress':
          // In Progress: Orders currently being picked (new or active sessions, not yet shipped)
          conditions.push(
            and(
              isNotNull(shipments.sessionId),
              or(
                eq(shipments.sessionStatus, 'new'),
                eq(shipments.sessionStatus, 'active')
              ),
              isNull(shipments.trackingNumber)
            )
          );
          break;
        case 'packing_queue':
          // Packing Queue: Orders ready to pack (picked/closed session status, no tracking number yet, not cancelled)
          conditions.push(
            and(
              isNotNull(shipments.sessionId),
              or(
                eq(shipments.sessionStatus, 'closed'),
                eq(shipments.sessionStatus, 'picked')
              ),
              isNull(shipments.trackingNumber),
              ne(shipments.status, 'cancelled')
            )
          );
          break;
        case 'shipped':
          // Shipped: Orders that have been shipped (has tracking number)
          conditions.push(isNotNull(shipments.trackingNumber));
          break;
        case 'all':
          // All: No additional filter, shows everything
          break;
      }
    }

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

    // Shipment status filter (warehouse status) - OR condition for multiple values
    if (shipmentStatus && shipmentStatus.length > 0) {
      const statusConditions = shipmentStatus.map(s => {
        if (s === "null") {
          return isNull(shipments.shipmentStatus);
        } else {
          return eq(shipments.shipmentStatus, s);
        }
      });
      if (statusConditions.length > 0) {
        conditions.push(or(...statusConditions));
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

    // Shipped without tracking filter (status='shipped' but no tracking number)
    if (filters.shippedWithoutTracking) {
      conditions.push(
        and(
          eq(shipments.status, 'shipped'),
          isNull(shipments.trackingNumber)
        )
      );
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

  async getShipmentTabCounts(): Promise<{ inProgress: number; packingQueue: number; shipped: number; all: number }> {
    // In Progress: Orders currently being picked (new or active sessions, not yet shipped)
    const inProgressResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(
        and(
          isNotNull(shipments.sessionId),
          or(
            eq(shipments.sessionStatus, 'new'),
            eq(shipments.sessionStatus, 'active')
          ),
          isNull(shipments.trackingNumber)
        )
      );

    // Packing Queue: Orders ready to pack (picked/closed session, no tracking number, not cancelled)
    const packingQueueResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(
        and(
          isNotNull(shipments.sessionId),
          or(
            eq(shipments.sessionStatus, 'closed'),
            eq(shipments.sessionStatus, 'picked')
          ),
          isNull(shipments.trackingNumber),
          ne(shipments.status, 'cancelled')
        )
      );

    // Shipped: Orders that have been shipped (has tracking number)
    const shippedResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(isNotNull(shipments.trackingNumber));

    // All: Total count
    const allResult = await db
      .select({ count: count() })
      .from(shipments);

    return {
      inProgress: Number(inProgressResult[0]?.count) || 0,
      packingQueue: Number(packingQueueResult[0]?.count) || 0,
      shipped: Number(shippedResult[0]?.count) || 0,
      all: Number(allResult[0]?.count) || 0,
    };
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

    // Shipped without tracking filter (status='shipped' but no tracking number)
    if (filters.shippedWithoutTracking) {
      conditions.push(
        and(
          eq(shipments.status, 'shipped'),
          isNull(shipments.trackingNumber)
        )
      );
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

  async getRunningBackfillJobs(): Promise<BackfillJob[]> {
    const result = await db
      .select()
      .from(backfillJobs)
      .where(eq(backfillJobs.status, 'running'))
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

  // Packing Logs
  async createPackingLog(log: InsertPackingLog): Promise<PackingLog> {
    const result = await db.insert(packingLogs).values(log).returning();
    return result[0];
  }

  async getPackingLogsByShipment(shipmentId: string): Promise<PackingLog[]> {
    return await db
      .select()
      .from(packingLogs)
      .where(eq(packingLogs.shipmentId, shipmentId))
      .orderBy(desc(packingLogs.createdAt));
  }

  async getPackingLogsByUser(userId: string, limit = 100): Promise<PackingLog[]> {
    return await db
      .select()
      .from(packingLogs)
      .where(eq(packingLogs.userId, userId))
      .orderBy(desc(packingLogs.createdAt))
      .limit(limit);
  }

  async deletePackingLogsByShipment(shipmentId: string): Promise<void> {
    await db.delete(packingLogs).where(eq(packingLogs.shipmentId, shipmentId));
  }

  // Shipment Events
  async createShipmentEvent(event: InsertShipmentEvent): Promise<ShipmentEvent> {
    const result = await db.insert(shipmentEvents).values(event).returning();
    return result[0];
  }

  async getShipmentEventsByOrderNumber(orderNumber: string): Promise<ShipmentEvent[]> {
    return await db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.orderNumber, orderNumber))
      .orderBy(desc(shipmentEvents.occurredAt));
  }

  async getShipmentEventsByUser(username: string, limit = 100): Promise<ShipmentEvent[]> {
    return await db
      .select()
      .from(shipmentEvents)
      .where(eq(shipmentEvents.username, username))
      .orderBy(desc(shipmentEvents.occurredAt))
      .limit(limit);
  }

  async getShipmentEventsByDateRange(startDate: Date, endDate: Date): Promise<ShipmentEvent[]> {
    return await db
      .select()
      .from(shipmentEvents)
      .where(
        and(
          gte(shipmentEvents.occurredAt, startDate),
          lte(shipmentEvents.occurredAt, endDate)
        )
      )
      .orderBy(desc(shipmentEvents.occurredAt));
  }

  async deleteShipmentEventsByOrderNumber(orderNumber: string): Promise<void> {
    await db.delete(shipmentEvents).where(eq(shipmentEvents.orderNumber, orderNumber));
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
    oldestOrderMissingShipmentAt: string | null;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    shopifyOrderSyncFailures: number;
  }> {
    // Query 1: Orders missing shipments (excluding refunded, restocked, and voided orders, orders with refunds, and orders with only non-shippable items)
    const ordersMissingShipmentsResult = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(shipments, eq(orders.id, shipments.orderId))
      .leftJoin(orderRefunds, eq(orders.id, orderRefunds.orderId))
      .where(sql`
        ${shipments.id} IS NULL 
        AND ${orderRefunds.id} IS NULL 
        AND (${orders.financialStatus} IS NULL OR NOT (${orders.financialStatus} ILIKE ANY(ARRAY['refunded', 'restocked', 'voided'])))
        AND EXISTS (
          SELECT 1 FROM ${orderItems} 
          WHERE ${orderItems.orderId} = ${orders.id} 
          AND (${orderItems.requiresShipping} IS TRUE OR ${orderItems.requiresShipping} IS NULL)
        )
      `);
    
    // Query 1a: Get oldest order missing shipment
    const oldestOrderResult = await db
      .select({ createdAt: orders.createdAt })
      .from(orders)
      .leftJoin(shipments, eq(orders.id, shipments.orderId))
      .leftJoin(orderRefunds, eq(orders.id, orderRefunds.orderId))
      .where(sql`
        ${shipments.id} IS NULL 
        AND ${orderRefunds.id} IS NULL 
        AND (${orders.financialStatus} IS NULL OR NOT (${orders.financialStatus} ILIKE ANY(ARRAY['refunded', 'restocked', 'voided'])))
        AND EXISTS (
          SELECT 1 FROM ${orderItems} 
          WHERE ${orderItems.orderId} = ${orders.id} 
          AND (${orderItems.requiresShipping} IS TRUE OR ${orderItems.requiresShipping} IS NULL)
        )
      `)
      .orderBy(orders.createdAt)
      .limit(1);
    
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
      oldestOrderMissingShipmentAt: oldestOrderResult[0]?.createdAt ? new Date(oldestOrderResult[0].createdAt).toISOString() : null,
      shipmentsWithoutOrders: shipmentsWithoutOrdersResult[0]?.count || 0,
      orphanedShipments: orphanedShipmentsResult[0]?.count || 0,
      shipmentsWithoutStatus: shipmentsWithoutStatusResult[0]?.count || 0,
      shipmentSyncFailures: syncFailuresResult[0]?.count || 0,
      shopifyOrderSyncFailures: shopifyOrderSyncFailuresResult[0]?.count || 0,
    };
  }

  // Pipeline Metrics - Track SkuVault session workflow progress
  async getPipelineMetrics(): Promise<{
    sessionedToday: number;
    inPackingQueue: number;
    shippedToday: number;
    oldestQueuedSessionAt: string | null;
  }> {
    // Get start of today (UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    
    // Query 1: Orders sessioned today (sessionedAt is today)
    const sessionedTodayResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(sql`${shipments.sessionedAt} >= ${todayStart}`);
    
    // Query 2: Orders in packing queue (closed/picked session, no tracking number yet, not cancelled)
    // These are orders ready to be packed - their session is complete but they haven't shipped
    const inPackingQueueResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(
        and(
          isNotNull(shipments.sessionId),
          or(
            eq(shipments.sessionStatus, 'closed'),
            eq(shipments.sessionStatus, 'picked')
          ),
          isNull(shipments.trackingNumber),
          ne(shipments.status, 'cancelled')
        )
      );
    
    // Query 3: Orders shipped today (shipDate is today)
    const shippedTodayResult = await db
      .select({ count: count() })
      .from(shipments)
      .where(sql`${shipments.shipDate} >= ${todayStart}`);
    
    // Query 4: Get oldest session in packing queue (excluding cancelled)
    const oldestQueuedResult = await db
      .select({ sessionedAt: shipments.sessionedAt })
      .from(shipments)
      .where(
        and(
          isNotNull(shipments.sessionId),
          or(
            eq(shipments.sessionStatus, 'closed'),
            eq(shipments.sessionStatus, 'picked')
          ),
          isNull(shipments.trackingNumber),
          ne(shipments.status, 'cancelled')
        )
      )
      .orderBy(shipments.sessionedAt)
      .limit(1);
    
    return {
      sessionedToday: sessionedTodayResult[0]?.count || 0,
      inPackingQueue: inPackingQueueResult[0]?.count || 0,
      shippedToday: shippedTodayResult[0]?.count || 0,
      oldestQueuedSessionAt: oldestQueuedResult[0]?.sessionedAt ? new Date(oldestQueuedResult[0].sessionedAt).toISOString() : null,
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

  // Saved Views
  async getSavedView(id: string): Promise<SavedView | undefined> {
    const result = await db
      .select()
      .from(savedViews)
      .where(eq(savedViews.id, id));
    return result[0];
  }

  async getSavedViewsByUser(userId: string, page?: string): Promise<SavedView[]> {
    let conditions = [eq(savedViews.userId, userId)];
    if (page) {
      conditions.push(eq(savedViews.page, page));
    }
    return await db
      .select()
      .from(savedViews)
      .where(and(...conditions))
      .orderBy(desc(savedViews.createdAt));
  }

  async getPublicView(id: string): Promise<SavedView | undefined> {
    const result = await db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.isPublic, true)));
    return result[0];
  }

  async createSavedView(view: InsertSavedView): Promise<SavedView> {
    const result = await db.insert(savedViews).values(view).returning();
    return result[0];
  }

  async updateSavedView(id: string, userId: string, updates: Partial<InsertSavedView>): Promise<SavedView | undefined> {
    const result = await db
      .update(savedViews)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
      .returning();
    return result[0];
  }

  async deleteSavedView(id: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.userId, userId)))
      .returning();
    return result.length > 0;
  }

  // ============================================================================
  // DESKTOP PRINTING SYSTEM
  // ============================================================================

  // Stations
  async createStation(station: InsertStation): Promise<Station> {
    const result = await db.insert(stations).values(station).returning();
    return result[0];
  }

  async updateStation(id: string, updates: Partial<InsertStation>): Promise<Station | undefined> {
    const result = await db
      .update(stations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(stations.id, id))
      .returning();
    return result[0];
  }

  async getStation(id: string): Promise<Station | undefined> {
    const result = await db.select().from(stations).where(eq(stations.id, id));
    return result[0];
  }

  async getStationByName(name: string): Promise<Station | undefined> {
    const result = await db.select().from(stations).where(eq(stations.name, name));
    return result[0];
  }

  async getAllStations(activeOnly: boolean = false): Promise<Station[]> {
    if (activeOnly) {
      return await db.select().from(stations).where(eq(stations.isActive, true)).orderBy(stations.name);
    }
    return await db.select().from(stations).orderBy(stations.name);
  }

  async deleteStation(id: string): Promise<boolean> {
    const result = await db.delete(stations).where(eq(stations.id, id)).returning();
    return result.length > 0;
  }

  // Printers
  async createPrinter(printer: InsertPrinter): Promise<Printer> {
    const result = await db.insert(printers).values(printer).returning();
    return result[0];
  }

  async updatePrinter(id: string, updates: Partial<InsertPrinter>): Promise<Printer | undefined> {
    const result = await db
      .update(printers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(printers.id, id))
      .returning();
    return result[0];
  }

  async getPrinter(id: string): Promise<Printer | undefined> {
    const result = await db.select().from(printers).where(eq(printers.id, id));
    return result[0];
  }

  async getPrinterBySystemName(systemName: string): Promise<Printer | undefined> {
    const result = await db.select().from(printers).where(eq(printers.systemName, systemName));
    return result[0];
  }

  async getPrintersByStation(stationId: string): Promise<Printer[]> {
    // Sort by isDefault first (default printer at top), then by name for stable ordering
    return await db
      .select()
      .from(printers)
      .where(eq(printers.stationId, stationId))
      .orderBy(desc(printers.isDefault), printers.name);
  }

  async getAllPrinters(): Promise<Printer[]> {
    return await db.select().from(printers).orderBy(desc(printers.isDefault), printers.name);
  }

  async deletePrinter(id: string): Promise<boolean> {
    const result = await db.delete(printers).where(eq(printers.id, id)).returning();
    return result.length > 0;
  }

  async updatePrinterLastSeen(id: string): Promise<void> {
    await db.update(printers).set({ lastSeenAt: new Date() }).where(eq(printers.id, id));
  }

  async setDefaultPrinter(stationId: string, printerId: string): Promise<Printer | undefined> {
    // Use transaction to atomically clear other defaults and set the new one
    return await db.transaction(async (tx) => {
      // First verify the printer exists and belongs to this station
      const targetPrinter = await tx
        .select()
        .from(printers)
        .where(and(eq(printers.id, printerId), eq(printers.stationId, stationId)));
      
      if (targetPrinter.length === 0) {
        return undefined;
      }
      
      // Clear isDefault from all OTHER printers on this station
      await tx
        .update(printers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(
          eq(printers.stationId, stationId),
          ne(printers.id, printerId) // Exclude the target printer
        ));
      
      // Set the specified printer as default
      const result = await tx
        .update(printers)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(printers.id, printerId))
        .returning();
      
      return result[0];
    });
  }

  // Desktop Clients
  async createDesktopClient(client: InsertDesktopClient): Promise<DesktopClient> {
    const result = await db.insert(desktopClients).values(client).returning();
    return result[0];
  }

  async updateDesktopClient(id: string, updates: Partial<InsertDesktopClient>): Promise<DesktopClient | undefined> {
    const result = await db
      .update(desktopClients)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(desktopClients.id, id))
      .returning();
    return result[0];
  }

  async getDesktopClient(id: string): Promise<DesktopClient | undefined> {
    const result = await db.select().from(desktopClients).where(eq(desktopClients.id, id));
    return result[0];
  }

  async getDesktopClientByAccessToken(accessTokenHash: string): Promise<DesktopClient | undefined> {
    const result = await db.select().from(desktopClients).where(eq(desktopClients.accessTokenHash, accessTokenHash));
    return result[0];
  }

  async getDesktopClientByRefreshToken(refreshTokenHash: string): Promise<DesktopClient | undefined> {
    const result = await db.select().from(desktopClients).where(eq(desktopClients.refreshTokenHash, refreshTokenHash));
    return result[0];
  }

  async getDesktopClientsByUser(userId: string): Promise<DesktopClient[]> {
    return await db.select().from(desktopClients).where(eq(desktopClients.userId, userId)).orderBy(desc(desktopClients.lastActiveAt));
  }

  async getDesktopClientByUserAndDevice(userId: string, deviceName: string): Promise<DesktopClient | undefined> {
    const result = await db
      .select()
      .from(desktopClients)
      .where(and(eq(desktopClients.userId, userId), eq(desktopClients.deviceName, deviceName)));
    return result[0];
  }

  async deleteDesktopClient(id: string): Promise<boolean> {
    const result = await db.delete(desktopClients).where(eq(desktopClients.id, id)).returning();
    return result.length > 0;
  }

  async updateDesktopClientActivity(id: string, lastIp?: string): Promise<void> {
    const updates: any = { lastActiveAt: new Date() };
    if (lastIp) {
      updates.lastIp = lastIp;
    }
    await db.update(desktopClients).set(updates).where(eq(desktopClients.id, id));
  }

  // Station Sessions
  async createStationSession(session: InsertStationSession): Promise<StationSession> {
    const result = await db.insert(stationSessions).values(session).returning();
    return result[0];
  }

  async updateStationSession(id: string, updates: Partial<{ status: string; endedAt: Date }>): Promise<StationSession | undefined> {
    const result = await db
      .update(stationSessions)
      .set(updates)
      .where(eq(stationSessions.id, id))
      .returning();
    return result[0];
  }

  async getStationSession(id: string): Promise<StationSession | undefined> {
    const result = await db.select().from(stationSessions).where(eq(stationSessions.id, id));
    return result[0];
  }

  async getActiveSessionByStation(stationId: string): Promise<StationSession | undefined> {
    const result = await db
      .select()
      .from(stationSessions)
      .where(and(eq(stationSessions.stationId, stationId), eq(stationSessions.status, 'active')));
    return result[0];
  }

  async getActiveSessionByUser(userId: string): Promise<StationSession | undefined> {
    const result = await db
      .select()
      .from(stationSessions)
      .where(and(eq(stationSessions.userId, userId), eq(stationSessions.status, 'active')));
    return result[0];
  }

  async getActiveSessionByDesktopClient(desktopClientId: string): Promise<StationSession | undefined> {
    const result = await db
      .select()
      .from(stationSessions)
      .where(and(eq(stationSessions.desktopClientId, desktopClientId), eq(stationSessions.status, 'active')));
    return result[0];
  }

  async endStationSession(id: string): Promise<StationSession | undefined> {
    const result = await db
      .update(stationSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(stationSessions.id, id))
      .returning();
    return result[0];
  }

  async expireOldSessions(): Promise<number> {
    const now = new Date();
    const result = await db
      .update(stationSessions)
      .set({ status: 'expired', endedAt: now })
      .where(and(eq(stationSessions.status, 'active'), lte(stationSessions.expiresAt, now)))
      .returning();
    return result.length;
  }

  async claimStationAtomically(session: InsertStationSession, clientId: string): Promise<{ session?: StationSession; error?: string; claimedBy?: string; expiresAt?: Date }> {
    try {
      return await db.transaction(async (tx) => {
        // Check if station is already claimed by someone else (SELECT FOR UPDATE for row-level lock)
        const existingSession = await tx
          .select()
          .from(stationSessions)
          .where(and(
            eq(stationSessions.stationId, session.stationId),
            eq(stationSessions.status, 'active')
          ))
          .for('update');
        
        if (existingSession.length > 0 && existingSession[0].desktopClientId !== clientId) {
          // Get the user who claimed it
          const claimingUser = await tx
            .select()
            .from(users)
            .where(eq(users.id, existingSession[0].userId));
          
          return {
            error: 'Station is already claimed',
            claimedBy: claimingUser[0]?.name || 'Another user',
            expiresAt: existingSession[0].expiresAt,
          };
        }

        // If there's an existing session for this same client, end it
        if (existingSession.length > 0 && existingSession[0].desktopClientId === clientId) {
          await tx
            .update(stationSessions)
            .set({ status: 'ended', endedAt: new Date() })
            .where(eq(stationSessions.id, existingSession[0].id));
        }

        // End any other active session for this client (they might be claiming a different station)
        await tx
          .update(stationSessions)
          .set({ status: 'ended', endedAt: new Date() })
          .where(and(
            eq(stationSessions.desktopClientId, clientId),
            eq(stationSessions.status, 'active')
          ));

        // Create the new session
        const newSession = await tx
          .insert(stationSessions)
          .values(session)
          .returning();

        return { session: newSession[0] };
      });
    } catch (error: any) {
      console.error('[Station Claim] Transaction failed:', error);
      return { error: error.message || 'Failed to claim station' };
    }
  }

  // Print Jobs
  async createPrintJob(job: InsertPrintJob): Promise<PrintJob> {
    const result = await db.insert(printJobs).values(job).returning();
    return result[0];
  }

  async updatePrintJob(id: string, updates: Partial<InsertPrintJob & { attempts?: number; sentAt?: Date; completedAt?: Date }>): Promise<PrintJob | undefined> {
    const result = await db
      .update(printJobs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  async getPrintJob(id: string): Promise<PrintJob | undefined> {
    const result = await db.select().from(printJobs).where(eq(printJobs.id, id));
    return result[0];
  }

  async getPendingJobsByStation(stationId: string, limit: number = 50): Promise<PrintJob[]> {
    return await db
      .select()
      .from(printJobs)
      .where(and(eq(printJobs.stationId, stationId), eq(printJobs.status, 'pending')))
      .orderBy(desc(printJobs.priority), printJobs.createdAt)
      .limit(limit);
  }

  async getJobsByStation(stationId: string, limit: number = 100): Promise<PrintJob[]> {
    return await db
      .select()
      .from(printJobs)
      .where(eq(printJobs.stationId, stationId))
      .orderBy(desc(printJobs.createdAt))
      .limit(limit);
  }

  async getJobsByOrder(orderId: string): Promise<PrintJob[]> {
    return await db.select().from(printJobs).where(eq(printJobs.orderId, orderId)).orderBy(desc(printJobs.createdAt));
  }

  async getJobsByShipment(shipmentId: string): Promise<PrintJob[]> {
    return await db.select().from(printJobs).where(eq(printJobs.shipmentId, shipmentId)).orderBy(desc(printJobs.createdAt));
  }

  async getDesktopPrintJob(id: string): Promise<PrintJob | undefined> {
    const result = await db.select().from(printJobs).where(eq(printJobs.id, id));
    return result[0];
  }

  async getAllDesktopPrintJobs(limit: number = 100): Promise<PrintJob[]> {
    return await db
      .select()
      .from(printJobs)
      .orderBy(desc(printJobs.createdAt))
      .limit(limit);
  }

  async markJobSent(id: string): Promise<PrintJob | undefined> {
    const result = await db
      .update(printJobs)
      .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  async markJobCompleted(id: string): Promise<PrintJob | undefined> {
    const result = await db
      .update(printJobs)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  async markJobFailed(id: string, errorMessage: string): Promise<PrintJob | undefined> {
    const job = await this.getPrintJob(id);
    if (!job) return undefined;
    
    const newAttempts = job.attempts + 1;
    const newStatus = newAttempts >= job.maxAttempts ? 'failed' : 'pending';
    
    const result = await db
      .update(printJobs)
      .set({ 
        status: newStatus, 
        attempts: newAttempts,
        errorMessage,
        updatedAt: new Date() 
      })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  async retryJob(id: string): Promise<PrintJob | undefined> {
    const result = await db
      .update(printJobs)
      .set({ status: 'pending', errorMessage: null, sentAt: null, updatedAt: new Date() })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  async cancelJob(id: string): Promise<PrintJob | undefined> {
    const result = await db
      .update(printJobs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(printJobs.id, id))
      .returning();
    return result[0];
  }

  // ============================================================================
  // DESKTOP CONFIGURATION
  // ============================================================================

  async getDesktopConfig(): Promise<DesktopConfig> {
    const result = await db.select().from(desktopConfig).where(eq(desktopConfig.id, 'global'));
    if (result[0]) {
      return result[0];
    }
    // Create default config if it doesn't exist
    const [newConfig] = await db.insert(desktopConfig).values({ id: 'global' }).returning();
    return newConfig;
  }

  async updateDesktopConfig(updates: Partial<InsertDesktopConfig>, updatedBy?: string): Promise<DesktopConfig> {
    const result = await db
      .update(desktopConfig)
      .set({ 
        ...updates,
        updatedAt: new Date(),
        updatedBy: updatedBy ?? null,
      })
      .where(eq(desktopConfig.id, 'global'))
      .returning();
    
    if (result[0]) {
      return result[0];
    }
    
    // If no row existed, create it with the updates
    const [newConfig] = await db.insert(desktopConfig).values({ 
      id: 'global',
      ...updates,
      updatedBy: updatedBy ?? null,
    }).returning();
    return newConfig;
  }

  // ============================================================================
  // WEB PACKING SESSIONS
  // ============================================================================

  async getActiveWebPackingSession(userId: string): Promise<WebPackingSession | undefined> {
    const now = new Date();
    const result = await db
      .select()
      .from(webPackingSessions)
      .where(and(
        eq(webPackingSessions.userId, userId),
        gte(webPackingSessions.expiresAt, now)
      ))
      .orderBy(desc(webPackingSessions.selectedAt))
      .limit(1);
    return result[0];
  }

  async createWebPackingSession(userId: string, stationId: string, expiresAt: Date): Promise<WebPackingSession> {
    // Delete any existing sessions for this user first
    await db.delete(webPackingSessions).where(eq(webPackingSessions.userId, userId));
    
    // Create new session
    const [session] = await db
      .insert(webPackingSessions)
      .values({
        userId,
        stationId,
        expiresAt,
      })
      .returning();
    return session;
  }

  async deleteWebPackingSession(userId: string): Promise<boolean> {
    const result = await db
      .delete(webPackingSessions)
      .where(eq(webPackingSessions.userId, userId))
      .returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
