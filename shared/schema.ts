import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, boolean, index, uniqueIndex, numeric, doublePrecision, real, serial, primaryKey, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================================
// SHIPMENT LIFECYCLE ENUMS (Phase 6: Smart Shipping Engine)
// ============================================================================

/**
 * Shipment Lifecycle Phases
 * 
 * The complete journey of a shipment from order receipt to carrier pickup:
 * 
 * ready_to_fulfill → ready_to_session → fulfillment_prep → ready_to_pick → picking → packing_ready → on_dock
 *                                                                        ↘ picking_issues (exception path)
 * 
 * ready_to_fulfill: On hold + MOVE OVER tag (waiting to be released from ShipStation hold)
 * ready_to_session: Pending + MOVE OVER tag (released, ready for fingerprinting & sessioning)
 */
export const LIFECYCLE_PHASES = {
  READY_TO_FULFILL: 'ready_to_fulfill',      // On hold + MOVE OVER tag - waiting to be released from hold
  READY_TO_SESSION: 'ready_to_session',      // Pending + MOVE OVER tag + no session - fingerprinting & QC explosion happens here
  READY_FOR_SKUVAULT: 'ready_for_skuvault',  // Local fulfillment session built, waiting for SkuVault wave picking
  FULFILLMENT_PREP: 'fulfillment_prep',      // Hydration, fingerprinting, packaging, rate check, sessioning
  READY_TO_PICK: 'ready_to_pick',            // Session created in SkuVault, waiting to start
  PICKING: 'picking',                         // Actively being picked
  PACKING_READY: 'packing_ready',            // Picking complete, ready for packing
  ON_DOCK: 'on_dock',                         // Labeled, waiting for carrier pickup (status NY or AC)
  IN_TRANSIT: 'in_transit',                   // Package in transit to customer (status IT)
  DELIVERED: 'delivered',                     // Package delivered to customer (status DE)
  CANCELLED: 'cancelled',                    // Order cancelled - terminal state
  PROBLEM: 'problem',                        // Shipment problem (SP/UN/EX) - terminal state, becomes customer service issue
  PICKING_ISSUES: 'picking_issues',          // Exception requiring supervisor attention
} as const;

export type LifecyclePhase = typeof LIFECYCLE_PHASES[keyof typeof LIFECYCLE_PHASES];

/**
 * Decision Subphases (within FULFILLMENT_PREP)
 * 
 * The progression of packing decisions before orders can be sessioned:
 * 
 * needs_hydration → needs_categorization → needs_fingerprint → needs_packaging → needs_rate_check → needs_session
 * 
 * needs_hydration: No QC items created yet (fingerprintStatus is NULL). Automated step — hydrator creates shipment_qc_items.
 * needs_categorization: Hydrated but some SKUs not in a geometry collection (fingerprintStatus = 'pending_categorization').
 * needs_fingerprint: All SKUs categorized, fingerprint not yet calculated (fingerprintStatus = 'complete', no fingerprintId).
 * needs_packaging: Fingerprint exists but no packaging type mapped.
 * needs_rate_check: Has packaging, rate check not yet done.
 * needs_session: Everything done, needs to be added to fulfillment session.
 * 
 * After sessioning, orders transition to READY_FOR_SKUVAULT phase (waiting on SkuVault wave picking).
 */
export const DECISION_SUBPHASES = {
  NEEDS_HYDRATION: 'needs_hydration',              // No QC items yet — needs hydrator to run (fingerprintStatus is NULL)
  NEEDS_CATEGORIZATION: 'needs_categorization',    // SKUs not yet assigned to geometry collections (fingerprintStatus = 'pending_categorization')
  NEEDS_FINGERPRINT: 'needs_fingerprint',          // Fingerprint not yet calculated (fingerprintStatus = 'complete', no fingerprintId)
  NEEDS_PACKAGING: 'needs_packaging',              // Fingerprint has no packaging type mapping
  NEEDS_RATE_CHECK: 'needs_rate_check',            // Rate analysis pending - checking for cheaper shipping options
  NEEDS_SESSION: 'needs_session',                  // Ready for sessioning but not yet grouped — terminal subphase before READY_FOR_SKUVAULT
} as const;

export type DecisionSubphase = typeof DECISION_SUBPHASES[keyof typeof DECISION_SUBPHASES];

/**
 * Valid state transitions for lifecycle phases
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecyclePhase, LifecyclePhase[]> = {
  [LIFECYCLE_PHASES.READY_TO_FULFILL]: [LIFECYCLE_PHASES.READY_TO_SESSION], // When released from hold
  [LIFECYCLE_PHASES.READY_TO_SESSION]: [LIFECYCLE_PHASES.READY_FOR_SKUVAULT, LIFECYCLE_PHASES.FULFILLMENT_PREP], // After session built or fingerprinting
  [LIFECYCLE_PHASES.READY_FOR_SKUVAULT]: [LIFECYCLE_PHASES.READY_TO_PICK, LIFECYCLE_PHASES.READY_TO_SESSION], // SkuVault detects session, or session cancelled
  [LIFECYCLE_PHASES.FULFILLMENT_PREP]: [LIFECYCLE_PHASES.READY_TO_PICK],
  [LIFECYCLE_PHASES.READY_TO_PICK]: [LIFECYCLE_PHASES.PICKING, LIFECYCLE_PHASES.PICKING_ISSUES],
  [LIFECYCLE_PHASES.PICKING]: [LIFECYCLE_PHASES.PACKING_READY, LIFECYCLE_PHASES.PICKING_ISSUES],
  [LIFECYCLE_PHASES.PACKING_READY]: [LIFECYCLE_PHASES.ON_DOCK],
  [LIFECYCLE_PHASES.ON_DOCK]: [LIFECYCLE_PHASES.IN_TRANSIT], // Carrier picks up
  [LIFECYCLE_PHASES.IN_TRANSIT]: [LIFECYCLE_PHASES.DELIVERED], // Package delivered
  [LIFECYCLE_PHASES.DELIVERED]: [], // Terminal state
  [LIFECYCLE_PHASES.CANCELLED]: [], // Terminal state
  [LIFECYCLE_PHASES.PROBLEM]: [], // Terminal state
  [LIFECYCLE_PHASES.PICKING_ISSUES]: [LIFECYCLE_PHASES.READY_TO_PICK, LIFECYCLE_PHASES.PICKING], // Can be resolved back
};

/**
 * Valid state transitions for decision subphases (within FULFILLMENT_PREP)
 */
export const DECISION_TRANSITIONS: Record<DecisionSubphase, DecisionSubphase[]> = {
  [DECISION_SUBPHASES.NEEDS_HYDRATION]: [DECISION_SUBPHASES.NEEDS_CATEGORIZATION, DECISION_SUBPHASES.NEEDS_FINGERPRINT], // After hydration, goes to categorization or straight to fingerprint if all SKUs already categorized
  [DECISION_SUBPHASES.NEEDS_CATEGORIZATION]: [DECISION_SUBPHASES.NEEDS_FINGERPRINT],
  [DECISION_SUBPHASES.NEEDS_FINGERPRINT]: [DECISION_SUBPHASES.NEEDS_PACKAGING],
  [DECISION_SUBPHASES.NEEDS_PACKAGING]: [DECISION_SUBPHASES.NEEDS_RATE_CHECK, DECISION_SUBPHASES.NEEDS_SESSION], // Rate check may be skipped if not eligible
  [DECISION_SUBPHASES.NEEDS_RATE_CHECK]: [DECISION_SUBPHASES.NEEDS_SESSION],
  [DECISION_SUBPHASES.NEEDS_SESSION]: [], // Terminal subphase — after sessioning, exits to READY_FOR_SKUVAULT phase
};

// Users table for warehouse staff
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  handle: text("handle").unique(),
  avatarUrl: text("avatar_url"),
  profileBackgroundColor: text("profile_background_color"), // Custom background color for profile header (hex format)
  skuvaultUsername: text("skuvault_username"), // SkuVault username for matching activity
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Magic link tokens for authentication
export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMagicLinkTokenSchema = createInsertSchema(magicLinkTokens).omit({
  id: true,
  createdAt: true,
});

export type InsertMagicLinkToken = z.infer<typeof insertMagicLinkTokenSchema>;
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;

// Sessions table for authenticated users
export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessions).omit({
  id: true,
  createdAt: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

// Orders cache from Shopify
export const orders = pgTable("orders", {
  id: varchar("id").primaryKey(), // Shopify order ID
  orderNumber: text("order_number").notNull(), // Actual order number from sales channel (e.g., "JK3825344788" for Shopify, "111-7320858-2210642" for Amazon)
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),
  shippingAddress: jsonb("shipping_address").notNull(),
  lineItems: jsonb("line_items").notNull(),
  fulfillmentStatus: text("fulfillment_status"),
  financialStatus: text("financial_status"),
  // Price fields (all monetary values are strings from Shopify API)
  totalPrice: text("total_price").notNull().default('0'), // Legacy field, same as orderTotal
  orderTotal: text("order_total").notNull().default('0'), // total_price from Shopify
  totalLineItemsPrice: text("total_line_items_price").notNull().default('0'), // GROSS SALES: Sum of line items before ANY discounts
  subtotalPrice: text("subtotal_price").notNull().default('0'), // Price before discounts and shipping
  currentTotalPrice: text("current_total_price").notNull().default('0'), // Total after refunds/adjustments
  currentSubtotalPrice: text("current_subtotal_price").notNull().default('0'), // NET SALES: Subtotal after all discounts (Gross - Discounts)
  shippingTotal: text("shipping_total").notNull().default('0'), // total_shipping_price_set.shop_money.amount
  totalDiscounts: text("total_discounts").notNull().default('0'), // Total discounts applied
  currentTotalDiscounts: text("current_total_discounts").notNull().default('0'), // Discounts after adjustments
  totalTax: text("total_tax").notNull().default('0'), // Sum of all taxes
  currentTotalTax: text("current_total_tax").notNull().default('0'), // Tax after adjustments
  totalAdditionalFees: text("total_additional_fees").notNull().default('0'), // Duties, import fees, handling
  currentTotalAdditionalFees: text("current_total_additional_fees").notNull().default('0'), // Fees after adjustments
  totalOutstanding: text("total_outstanding").notNull().default('0'), // Outstanding amount remaining
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
}, (table) => ({
  // CRITICAL: Unique index on order_number for constant lookups from webhooks and UI
  orderNumberIdx: uniqueIndex("orders_order_number_idx").on(table.orderNumber),
  // B-tree indexes for date range filters and default sorts (DESC for recent-first queries)
  createdAtIdx: index("orders_created_at_idx").on(table.createdAt.desc().nullsLast()),
  updatedAtIdx: index("orders_updated_at_idx").on(table.updatedAt.desc().nullsLast()),
  // Composite index for status + date dashboard queries
  fulfillmentStatusCreatedAtIdx: index("orders_fulfillment_status_created_at_idx").on(table.fulfillmentStatus, table.createdAt),
  // Index for data health metrics query (orders missing shipments filter)
  financialStatusIdx: index("orders_financial_status_idx").on(table.financialStatus),
  // Index for sync monitoring queries
  lastSyncedAtIdx: index("orders_last_synced_at_idx").on(table.lastSyncedAt),
}));

export const insertOrderSchema = createInsertSchema(orders).omit({
  lastSyncedAt: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order refunds table for Shopify refund tracking
export const orderRefunds = pgTable("order_refunds", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id),
  shopifyRefundId: varchar("shopify_refund_id").notNull().unique(), // Shopify refund ID
  amount: text("amount").notNull(), // Total refund amount as string
  note: text("note"), // Refund reason/note
  refundedAt: timestamp("refunded_at").notNull(), // When refund was created (indexed)
  processedAt: timestamp("processed_at"), // When refund was processed
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  refundedAtIdx: index("order_refunds_refunded_at_idx").on(table.refundedAt),
  orderIdIdx: index("order_refunds_order_id_idx").on(table.orderId),
}));

export const insertOrderRefundSchema = createInsertSchema(orderRefunds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrderRefund = z.infer<typeof insertOrderRefundSchema>;
export type OrderRefund = typeof orderRefunds.$inferSelect;

// Order items table for Shopify line items tracking
export const orderItems = pgTable("order_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id),
  shopifyLineItemId: varchar("shopify_line_item_id").notNull(), // Shopify line item ID
  title: text("title").notNull(), // Product title
  sku: text("sku"), // Product SKU
  variantId: varchar("variant_id"), // Shopify variant ID
  productId: varchar("product_id"), // Shopify product ID
  quantity: integer("quantity").notNull(), // Quantity ordered
  currentQuantity: integer("current_quantity"), // Quantity after refunds/removals
  
  // Core price fields (text strings from Shopify for consistency with orders table)
  price: text("price").notNull().default('0'), // Unit price
  totalDiscount: text("total_discount").notNull().default('0'), // Total discount allocated to line item
  
  // Full Shopify price structures (JSON with amount + currency)
  priceSetJson: jsonb("price_set_json"), // Full price_set with shop_money and presentment_money
  totalDiscountSetJson: jsonb("total_discount_set_json"), // Full total_discount_set with shop_money and presentment_money
  
  // Tax information
  taxable: boolean("taxable"), // Whether the item is taxable
  taxLinesJson: jsonb("tax_lines_json"), // Full tax_lines array with jurisdiction details
  
  // Shipping information
  requiresShipping: boolean("requires_shipping"), // Whether the item requires physical shipping (false for gift cards, digital items)
  
  // Calculated/aggregated fields for easy reporting queries
  priceSetAmount: text("price_set_amount").notNull().default('0'), // Extracted shop_money.amount from price_set for easy queries
  totalDiscountSetAmount: text("total_discount_set_amount").notNull().default('0'), // Extracted shop_money.amount from total_discount_set
  totalTaxAmount: text("total_tax_amount").notNull().default('0'), // Sum of all tax_lines amounts
  preDiscountPrice: text("pre_discount_price").notNull().default('0'), // Price before any discounts (price * quantity)
  finalLinePrice: text("final_line_price").notNull().default('0'), // Final price after all discounts ((price * quantity) - total_discount)
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orderIdIdx: index("order_items_order_id_idx").on(table.orderId),
  variantIdIdx: index("order_items_variant_id_idx").on(table.variantId),
  productIdIdx: index("order_items_product_id_idx").on(table.productId),
  skuIdx: index("order_items_sku_idx").on(table.sku).where(sql`${table.sku} IS NOT NULL`),
  // Index for data health metrics query (filter non-shippable items in EXISTS clause)
  requiresShippingIdx: index("order_items_requires_shipping_idx").on(table.orderId, table.requiresShipping),
  // Unique constraint: same line item ID cannot appear twice in database
  uniqueLineItemIdx: uniqueIndex("order_items_shopify_line_item_id_idx").on(table.shopifyLineItemId),
}));

export const insertOrderItemSchema = createInsertSchema(orderItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;
export type OrderItem = typeof orderItems.$inferSelect;

// Shipments table for ShipStation tracking data
export const shipments = pgTable("shipments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").references(() => orders.id), // Nullable to allow shipments without linked orders
  shipmentId: text("shipment_id").notNull(), // ShipStation shipment ID - REQUIRED to prevent orphan records
  orderNumber: text("order_number").notNull(), // Customer-facing order number from ShipStation (e.g., "JK3825345229") - REQUIRED
  trackingNumber: text("tracking_number"),
  carrierCode: text("carrier_code"),
  serviceCode: text("service_code"),
  status: text("status").notNull().default("pending"), // pending, shipped, in_transit, delivered, exception
  statusDescription: text("status_description"),
  shipmentStatus: text("shipment_status"), // ShipStation shipment lifecycle status: on_hold, pending, shipped, cancelled, etc.
  labelUrl: text("label_url"),
  shipDate: timestamp("ship_date"),
  estimatedDeliveryDate: timestamp("estimated_delivery_date"),
  actualDeliveryDate: timestamp("actual_delivery_date"),
  // ShipStation ship_to customer data (extracted from shipmentData JSONB)
  shipToName: text("ship_to_name"),
  shipToPhone: text("ship_to_phone"),
  shipToEmail: text("ship_to_email"),
  shipToCompany: text("ship_to_company"),
  shipToAddressLine1: text("ship_to_address_line1"),
  shipToAddressLine2: text("ship_to_address_line2"),
  shipToAddressLine3: text("ship_to_address_line3"),
  shipToCity: text("ship_to_city"),
  shipToState: text("ship_to_state"),
  shipToPostalCode: text("ship_to_postal_code"),
  shipToCountry: text("ship_to_country"),
  shipToIsResidential: text("ship_to_is_residential"), // "yes", "no", or "unknown"
  // Return and gift information
  isReturn: boolean("is_return"),
  isGift: boolean("is_gift"),
  notesForGift: text("notes_for_gift"),
  notesFromBuyer: text("notes_from_buyer"),
  totalWeight: text("total_weight"), // Concatenated "value unit" (e.g., "2.5 pounds")
  // Advanced options from ShipStation
  billToAccount: text("bill_to_account"),
  billToCountryCode: text("bill_to_country_code"),
  billToParty: text("bill_to_party"),
  billToPostalCode: text("bill_to_postal_code"),
  billToName: text("bill_to_name"),
  billToAddressLine1: text("bill_to_address_line1"),
  containsAlcohol: boolean("contains_alcohol"),
  deliveredDutyPaid: boolean("delivered_duty_paid"),
  nonMachinable: boolean("non_machinable"),
  saturdayDelivery: boolean("saturday_delivery"),
  dryIce: boolean("dry_ice"),
  dryIceWeight: text("dry_ice_weight"),
  fedexFreight: text("fedex_freight"),
  thirdPartyConsignee: boolean("third_party_consignee"),
  guaranteedDutiesAndTaxes: boolean("guaranteed_duties_and_taxes"),
  ancillaryEndorsementsOption: text("ancillary_endorsements_option"),
  freightClass: text("freight_class"),
  customField1: text("custom_field1"),
  customField2: text("custom_field2"),
  customField3: text("custom_field3"),
  collectOnDelivery: text("collect_on_delivery"),
  returnPickupAttempts: text("return_pickup_attempts"),
  additionalHandling: boolean("additional_handling"),
  ownDocumentUpload: boolean("own_document_upload"),
  limitedQuantity: boolean("limited_quantity"),
  eventNotification: boolean("event_notification"),
  importServices: boolean("import_services"),
  overrideHoliday: boolean("override_holiday"),
  shipmentData: jsonb("shipment_data"), // Store full ShipStation shipment payload
  orderDate: timestamp("order_date"), // ShipStation createDate - when the shipment/label was created
  // SkuVault session data (synced from Firestore skuvaultOrderSessions)
  sessionId: text("session_id"), // SkuVault session ID (numeric in Firestore)
  sessionedAt: timestamp("sessioned_at"), // When order entered a wave/session (create_date)
  waveId: text("wave_id"), // Session picklist ID (wave identifier)
  saleId: text("sale_id"), // SkuVault sale ID for QC operations
  firestoreDocumentId: text("firestore_document_id"), // Firestore document ID for the session
  sessionStatus: text("session_status"), // Session status (e.g., "Picked", "Pending")
  spotNumber: text("spot_number"), // Physical bin/spot number in warehouse (stored as text for compatibility)
  pickedByUserId: text("picked_by_user_id"), // SkuVault user ID who picked the order (stored as text for compatibility)
  pickedByUserName: text("picked_by_user_name"), // Name of picker
  pickStartedAt: timestamp("pick_started_at"), // When picking began
  pickEndedAt: timestamp("pick_ended_at"), // When picking finished
  savedCustomField2: boolean("saved_custom_field_2"), // SkuVault custom field flag
  reverseSyncLastCheckedAt: timestamp("reverse_sync_last_checked_at"), // When reverse sync last verified status with ShipStation
  lastShipstationSyncAt: timestamp("last_shipstation_sync_at"), // When this shipment was last synced from ShipStation (for freshness filtering)
  shipstationModifiedAt: timestamp("shipstation_modified_at"), // ShipStation's modified_at timestamp (for cursor-based polling)
  // Cache warmer tracking
  cacheWarmedAt: timestamp("cache_warmed_at"), // When QCSale data was pre-warmed into cache (null = not warmed)
  // QC completion tracking
  qcCompleted: boolean("qc_completed").default(false), // True when packing QC scan is complete (set on boxing/bagging completion)
  qcCompletedAt: timestamp("qc_completed_at"), // When QC was completed (null = not completed)
  // Actual shipping cost from ShipStation label
  shippingCost: numeric("shipping_cost", { precision: 10, scale: 2 }), // Actual cost paid for shipping label (from ShipStation labels API)
  // Smart Shipping Engine fields (Phase 3)
  qcStationId: varchar("qc_station_id"), // FK to stations table - where this order was packed (set during QC)
  fingerprintId: varchar("fingerprint_id"), // FK to fingerprints table - calculated collection composition
  packagingTypeId: varchar("packaging_type_id"), // FK to packaging_types table - assigned packaging
  assignedStationId: varchar("assigned_station_id"), // FK to stations table - where this order should be routed for packing (auto-assigned from packagingType.stationType)
  packagingDecisionType: text("packaging_decision_type"), // 'auto' (from model) or 'manual' (human decided)
  fingerprintStatus: text("fingerprint_status"), // 'complete' | 'pending_categorization' | 'missing_weight' | 'needs_recalc' | null
  // Package assignment failure tracking
  requiresManualPackage: boolean("requires_manual_package").default(false), // True when auto-assignment failed after retries
  packageAssignmentError: text("package_assignment_error"), // Error message explaining why auto-assignment failed
  // Lifecycle tracking (Phase 6: Smart Shipping Engine)
  lifecyclePhase: text("lifecycle_phase"), // Current phase: fulfillment_prep, ready_to_pick, picking, packing_ready, on_dock, picking_issues
  decisionSubphase: text("decision_subphase"), // Subphase within fulfillment_prep: needs_hydration, needs_categorization, needs_fingerprint, needs_packaging, needs_rate_check, needs_session
  lifecyclePhaseChangedAt: timestamp("lifecycle_phase_changed_at"), // When the lifecycle phase last changed
  // Rate check tracking (automated rate optimization)
  rateCheckStatus: text("rate_check_status"), // 'pending' | 'complete' | 'failed' | 'skipped' | null
  rateCheckAttemptedAt: timestamp("rate_check_attempted_at"), // When rate check was last attempted
  rateCheckError: text("rate_check_error"), // Error message if rate check failed
  fulfillmentSessionId: integer("fulfillment_session_id"), // FK to fulfillment_sessions table (Ship.'s optimized session grouping)
  smartSessionSpot: integer("smart_session_spot"), // Cart position (1-28) within the smart session
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orderNumberIdx: index("shipments_order_number_idx").on(table.orderNumber),
  // Unique constraint: same ShipStation shipment ID cannot appear twice in database
  uniqueShipmentIdIdx: uniqueIndex("shipments_shipment_id_idx").on(table.shipmentId),
  // CRITICAL: Unique index on tracking_number for fast webhook/API lookups
  trackingNumberIdx: uniqueIndex("shipments_tracking_number_idx").on(table.trackingNumber).where(sql`${table.trackingNumber} IS NOT NULL`),
  // Foreign key index for order lookups - COVERS ALL VALUES including NULL for data health metrics
  orderIdIdx: index("shipments_order_id_idx").on(table.orderId),
  // Composite index for webhook reconciliation (order_number + carrier filtering)
  orderNumberCarrierIdx: index("shipments_order_number_carrier_idx").on(table.orderNumber, table.carrierCode).where(sql`${table.orderNumber} IS NOT NULL`),
  // Index for date range filtering/sorting
  shipDateIdx: index("shipments_ship_date_idx").on(table.shipDate.desc().nullsLast()),
  // Partial index for common status queries (most warehouse queries filter by these statuses)
  statusIdx: index("shipments_status_idx").on(table.status).where(sql`${table.status} IN ('delivered', 'in_transit', 'exception', 'pending')`),
  // Partial index for orphaned shipments (missing both order linkage and tracking)
  orphanedIdx: index("shipments_orphaned_idx").on(table.createdAt).where(sql`${table.orderId} IS NULL AND ${table.trackingNumber} IS NULL`),
  // Index for SkuVault session lookups (fast packing queue queries)
  sessionIdIdx: index("shipments_session_id_idx").on(table.sessionId).where(sql`${table.sessionId} IS NOT NULL`),
  // Index for sessioned orders (orders in picking/packing queue)
  sessionedAtIdx: index("shipments_sessioned_at_idx").on(table.sessionedAt.desc().nullsLast()).where(sql`${table.sessionedAt} IS NOT NULL`),
  // Composite index for packing queue queries (sessionStatus + trackingNumber filtering)
  // Covers: WHERE sessionId IS NOT NULL AND sessionStatus IN ('closed', 'picked') AND trackingNumber IS NULL
  packingQueueIdx: index("shipments_packing_queue_idx").on(table.sessionStatus, table.trackingNumber).where(sql`${table.sessionId} IS NOT NULL`),
  // Index for freshness filtering in the new incremental poller
  lastShipstationSyncAtIdx: index("shipments_last_shipstation_sync_at_idx").on(table.lastShipstationSyncAt.desc().nullsLast()),
  // Index for shipmentStatus filtering (on_hold verification)
  shipmentStatusIdx: index("shipments_shipment_status_idx").on(table.shipmentStatus).where(sql`${table.shipmentStatus} IS NOT NULL`),
  // CACHE WARMER INDEXES: Partial index for ready-to-pack orders (closed session, no tracking, no ship date)
  // This is the exact query the cache warmer and packing_ready tab use to find orders awaiting packing
  cacheWarmerReadyIdx: index("shipments_cache_warmer_ready_idx").on(table.updatedAt.desc()).where(sql`${table.sessionStatus} = 'closed' AND ${table.trackingNumber} IS NULL AND ${table.shipDate} IS NULL`),
  // Index for lifecycle-filtered shipment queries (new/active/inactive/closed tabs on shipments page)
  sessionStatusUpdatedAtIdx: index("shipments_session_status_updated_at_idx").on(table.sessionStatus, table.updatedAt.desc()),
  // Index for cache warming tracking (when was this order's cache warmed)
  cacheWarmedAtIdx: index("shipments_cache_warmed_at_idx").on(table.cacheWarmedAt.desc().nullsLast()).where(sql`${table.cacheWarmedAt} IS NOT NULL`),
  // PERFORMANCE INDEXES: Composite indexes for common shipments page query patterns
  // Status + ship_date for filtering by status with date sorting
  statusShipDateIdx: index("shipments_status_ship_date_idx").on(table.shipmentStatus, table.shipDate.desc().nullsLast()).where(sql`${table.shipmentStatus} IS NOT NULL`),
  // Carrier + ship_date for carrier filtering with date sorting
  carrierShipDateIdx: index("shipments_carrier_ship_date_idx").on(table.carrierCode, table.shipDate.desc().nullsLast()).where(sql`${table.carrierCode} IS NOT NULL`),
  // QC completed timestamp for packed shipments report queries
  qcCompletedAtIdx: index("shipments_qc_completed_at_idx").on(table.qcCompletedAt.desc().nullsLast()).where(sql`${table.qcCompletedAt} IS NOT NULL`),
  // Smart Shipping Engine indexes (Phase 3)
  qcStationIdIdx: index("shipments_qc_station_id_idx").on(table.qcStationId).where(sql`${table.qcStationId} IS NOT NULL`),
  fingerprintIdIdx: index("shipments_fingerprint_id_idx").on(table.fingerprintId).where(sql`${table.fingerprintId} IS NOT NULL`),
  packagingTypeIdIdx: index("shipments_packaging_type_id_idx").on(table.packagingTypeId).where(sql`${table.packagingTypeId} IS NOT NULL`),
  assignedStationIdIdx: index("shipments_assigned_station_id_idx").on(table.assignedStationId).where(sql`${table.assignedStationId} IS NOT NULL`),
  packagingDecisionTypeIdx: index("shipments_packaging_decision_type_idx").on(table.packagingDecisionType).where(sql`${table.packagingDecisionType} IS NOT NULL`),
  fingerprintStatusIdx: index("shipments_fingerprint_status_idx").on(table.fingerprintStatus).where(sql`${table.fingerprintStatus} IS NOT NULL`),
  // Lifecycle tracking indexes (Phase 6)
  lifecyclePhaseIdx: index("shipments_lifecycle_phase_idx").on(table.lifecyclePhase).where(sql`${table.lifecyclePhase} IS NOT NULL`),
  decisionSubphaseIdx: index("shipments_decision_subphase_idx").on(table.decisionSubphase).where(sql`${table.decisionSubphase} IS NOT NULL`),
  fulfillmentSessionIdIdx: index("shipments_fulfillment_session_id_idx").on(table.fulfillmentSessionId).where(sql`${table.fulfillmentSessionId} IS NOT NULL`),
  // Rate check tracking index
  rateCheckStatusIdx: index("shipments_rate_check_status_idx").on(table.rateCheckStatus).where(sql`${table.rateCheckStatus} IS NOT NULL`),
}));

export const insertShipmentSchema = createInsertSchema(shipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  orderId: z.string().nullish(), // orderId is now optional
  shipDate: z.coerce.date().optional().or(z.null()),
  estimatedDeliveryDate: z.coerce.date().optional().or(z.null()),
  actualDeliveryDate: z.coerce.date().optional().or(z.null()),
  orderDate: z.coerce.date().optional().or(z.null()),
  shipmentId: z.string().nullish(),
  orderNumber: z.string().nullish(),
  trackingNumber: z.string().nullish(),
  carrierCode: z.string().nullish(),
  serviceCode: z.string().nullish(),
  labelUrl: z.string().nullish(),
  statusDescription: z.string().nullish(),
  shipmentStatus: z.string().nullish(),
  shipmentData: z.any().nullish(),
  // Return and gift fields
  isReturn: z.boolean().nullish(),
  isGift: z.boolean().nullish(),
  notesForGift: z.string().nullish(),
  notesFromBuyer: z.string().nullish(),
  totalWeight: z.string().nullish(),
  // Advanced options
  billToAccount: z.string().nullish(),
  billToCountryCode: z.string().nullish(),
  billToParty: z.string().nullish(),
  billToPostalCode: z.string().nullish(),
  billToName: z.string().nullish(),
  billToAddressLine1: z.string().nullish(),
  containsAlcohol: z.boolean().nullish(),
  deliveredDutyPaid: z.boolean().nullish(),
  nonMachinable: z.boolean().nullish(),
  saturdayDelivery: z.boolean().nullish(),
  dryIce: z.boolean().nullish(),
  dryIceWeight: z.string().nullish(),
  fedexFreight: z.string().nullish(),
  thirdPartyConsignee: z.boolean().nullish(),
  guaranteedDutiesAndTaxes: z.boolean().nullish(),
  ancillaryEndorsementsOption: z.string().nullish(),
  freightClass: z.string().nullish(),
  customField1: z.string().nullish(),
  customField2: z.string().nullish(),
  customField3: z.string().nullish(),
  collectOnDelivery: z.string().nullish(),
  returnPickupAttempts: z.string().nullish(),
  additionalHandling: z.boolean().nullish(),
  ownDocumentUpload: z.boolean().nullish(),
  limitedQuantity: z.boolean().nullish(),
  eventNotification: z.boolean().nullish(),
  importServices: z.boolean().nullish(),
  overrideHoliday: z.boolean().nullish(),
  // SkuVault session fields
  sessionId: z.string().nullish(),
  sessionedAt: z.coerce.date().optional().or(z.null()),
  waveId: z.string().nullish(),
  saleId: z.string().nullish(),
  firestoreDocumentId: z.string().nullish(),
  sessionStatus: z.string().nullish(),
  spotNumber: z.string().nullish(),
  pickedByUserId: z.string().nullish(),
  pickedByUserName: z.string().nullish(),
  pickStartedAt: z.coerce.date().optional().or(z.null()),
  pickEndedAt: z.coerce.date().optional().or(z.null()),
  savedCustomField2: z.boolean().nullish(),
  // New sync tracking fields
  lastShipstationSyncAt: z.coerce.date().optional().or(z.null()),
  shipstationModifiedAt: z.coerce.date().optional().or(z.null()),
  // Cache warmer tracking
  cacheWarmedAt: z.coerce.date().optional().or(z.null()),
  // Smart Shipping Engine fields (Phase 3)
  qcStationId: z.string().nullish(),
  fingerprintId: z.string().nullish(),
  packagingTypeId: z.string().nullish(),
  assignedStationId: z.string().nullish(),
  packagingDecisionType: z.string().nullish(),
  // Lifecycle tracking (Phase 6)
  lifecyclePhase: z.string().nullish(),
  decisionSubphase: z.string().nullish(),
  lifecyclePhaseChangedAt: z.coerce.date().optional().or(z.null()),
  // Rate check tracking
  rateCheckStatus: z.string().nullish(),
  rateCheckAttemptedAt: z.coerce.date().optional().or(z.null()),
  rateCheckError: z.string().nullish(),
  fulfillmentSessionId: z.string().nullish(),
});

export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipments.$inferSelect;

// Sync cursors table for storing cursor positions for incremental polling
export const syncCursors = pgTable("sync_cursors", {
  id: varchar("id").primaryKey(), // e.g., 'shipstation:modified_at'
  cursorValue: text("cursor_value").notNull(), // ISO timestamp or other cursor value
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
  metadata: jsonb("metadata"), // Additional metadata (e.g., last page processed, total synced)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSyncCursorSchema = createInsertSchema(syncCursors).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSyncCursor = z.infer<typeof insertSyncCursorSchema>;
export type SyncCursor = typeof syncCursors.$inferSelect;

// Shipment items table for normalized shipment line items
export const shipmentItems = pgTable("shipment_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  orderItemId: varchar("order_item_id").references(() => orderItems.id), // Nullable - not all shipments linked to orders
  sku: text("sku"), // Product SKU
  name: text("name").notNull(), // Product name/title
  quantity: integer("quantity").notNull(), // Quantity in this shipment (from ShipStation)
  unitPrice: text("unit_price"), // Price per unit (text for consistency)
  externalOrderItemId: text("external_order_item_id"), // ShipStation's reference to Shopify line item
  imageUrl: text("image_url"), // Product image URL
  // SkuVault session item data (sv_ prefix indicates SkuVault source)
  svProductId: integer("sv_product_id"), // SkuVault product ID
  expectedQuantity: integer("expected_quantity"), // Expected quantity from SkuVault session
  scannedQuantity: integer("scanned_quantity").default(0), // QC scan progress during packing
  svPicked: boolean("sv_picked"), // Whether item was picked in SkuVault
  svCompleted: boolean("sv_completed"), // Whether item is complete in SkuVault
  svAuditStatus: text("sv_audit_status"), // SkuVault audit status
  svWarehouseLocation: text("sv_warehouse_location"), // Primary warehouse location
  svWarehouseLocations: jsonb("sv_warehouse_locations"), // All warehouse locations (stored as jsonb array)
  svStockStatus: text("sv_stock_status"), // Stock status from SkuVault
  svAvailableQuantity: integer("sv_available_quantity"), // Available quantity in SkuVault
  svNotFoundProduct: boolean("sv_not_found_product"), // Whether product wasn't found
  svIsSerialized: boolean("sv_is_serialized"), // Whether item is serialized
  svPartNumber: text("sv_part_number"), // SkuVault part number
  svWeightPounds: text("sv_weight_pounds"), // Weight in pounds
  svCode: text("sv_code"), // SkuVault code
  svProductPictures: text("sv_product_pictures").array(), // Product picture URLs
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("shipment_items_shipment_id_idx").on(table.shipmentId),
  orderItemIdIdx: index("shipment_items_order_item_id_idx").on(table.orderItemId).where(sql`${table.orderItemId} IS NOT NULL`),
  skuIdx: index("shipment_items_sku_idx").on(table.sku).where(sql`${table.sku} IS NOT NULL`),
  // Index for webhook reconciliation via ShipStation's external order item ID reference
  externalOrderItemIdIdx: index("shipment_items_external_order_item_id_idx").on(table.externalOrderItemId).where(sql`${table.externalOrderItemId} IS NOT NULL`),
  // Index for SkuVault product lookups
  svProductIdIdx: index("shipment_items_sv_product_id_idx").on(table.svProductId).where(sql`${table.svProductId} IS NOT NULL`),
}));

export const insertShipmentItemSchema = createInsertSchema(shipmentItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShipmentItem = z.infer<typeof insertShipmentItemSchema>;
export type ShipmentItem = typeof shipmentItems.$inferSelect;

// Shipment tags table for normalized shipment tags
export const shipmentTags = pgTable("shipment_tags", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  name: text("name").notNull(), // Tag name (e.g., "All Orders", "Check Address")
  color: text("color"), // Tag color (nullable)
  tagId: integer("tag_id"), // ShipStation tag ID (nullable)
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("shipment_tags_shipment_id_idx").on(table.shipmentId),
  nameIdx: index("shipment_tags_name_idx").on(table.name),
}));

export const insertShipmentTagSchema = createInsertSchema(shipmentTags).omit({
  id: true,
  createdAt: true,
});

export type InsertShipmentTag = z.infer<typeof insertShipmentTagSchema>;
export type ShipmentTag = typeof shipmentTags.$inferSelect;

// Shipment packages table for normalized package details from ShipStation
export const shipmentPackages = pgTable("shipment_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  shipmentPackageId: text("shipment_package_id"), // ShipStation's unique package ID (e.g., "se-1196610004")
  packageId: text("package_id"), // Package type ID (e.g., "se-153790")
  packageCode: text("package_code"), // Package code (e.g., "package")
  packageName: text("package_name"), // Package display name (e.g., "Box #2 (13 x 13 x 13)")
  externalPackageId: text("external_package_id"), // External reference ID
  contentDescription: text("content_description"), // Description of package contents
  // Flattened weight fields
  weightValue: text("weight_value"), // Weight value as text for precision (e.g., "40.00")
  weightUnit: text("weight_unit"), // Weight unit (e.g., "ounce", "pound")
  // Flattened dimension fields
  dimensionLength: text("dimension_length"), // Length as text for precision
  dimensionWidth: text("dimension_width"), // Width as text for precision
  dimensionHeight: text("dimension_height"), // Height as text for precision
  dimensionUnit: text("dimension_unit"), // Dimension unit (e.g., "inch", "cm")
  // Flattened insured value fields
  insuredAmount: text("insured_amount"), // Insured amount as text for precision
  insuredCurrency: text("insured_currency"), // Currency code (e.g., "usd")
  // Flattened label message fields
  labelReference1: text("label_reference1"), // Label reference 1
  labelReference2: text("label_reference2"), // Label reference 2
  labelReference3: text("label_reference3"), // Label reference 3
  // Additional package info
  products: jsonb("products"), // Products array (usually null, stored as jsonb if present)
  dangerousGoodsInfo: jsonb("dangerous_goods_info"), // Dangerous goods package info
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("shipment_packages_shipment_id_idx").on(table.shipmentId),
  shipmentPackageIdIdx: index("shipment_packages_shipment_package_id_idx").on(table.shipmentPackageId).where(sql`${table.shipmentPackageId} IS NOT NULL`),
  packageIdIdx: index("shipment_packages_package_id_idx").on(table.packageId).where(sql`${table.packageId} IS NOT NULL`),
  packageNameIdx: index("shipment_packages_package_name_idx").on(table.packageName).where(sql`${table.packageName} IS NOT NULL`),
}));

export const insertShipmentPackageSchema = createInsertSchema(shipmentPackages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShipmentPackage = z.infer<typeof insertShipmentPackageSchema>;
export type ShipmentPackage = typeof shipmentPackages.$inferSelect;

// Shipment events table for comprehensive audit trail
export const shipmentEvents = pgTable("shipment_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  username: text("username").notNull(), // Email of logged-in user
  station: text("station").notNull(), // e.g., "packing", "shipping", "receiving"
  stationId: text("station_id"), // UUID of the specific workstation (e.g., "Station 1", "Bagging 2")
  eventName: text("event_name").notNull(), // e.g., "order_scanned", "product_scan_success"
  orderNumber: text("order_number"), // Links to shipments.order_number
  metadata: jsonb("metadata"), // Flexible JSON data for event-specific details
  skuvaultImport: boolean("skuvault_import").notNull().default(false), // True if event was imported from SkuVault PassedItems
}, (table) => ({
  occurredAtIdx: index("shipment_events_occurred_at_idx").on(table.occurredAt),
  orderNumberIdx: index("shipment_events_order_number_idx").on(table.orderNumber).where(sql`${table.orderNumber} IS NOT NULL`),
  eventNameIdx: index("shipment_events_event_name_idx").on(table.eventName),
  usernameIdx: index("shipment_events_username_idx").on(table.username),
  stationIdIdx: index("shipment_events_station_id_idx").on(table.stationId).where(sql`${table.stationId} IS NOT NULL`),
  timingIdx: index("shipment_events_timing_idx").on(table.orderNumber, table.username, table.eventName, table.occurredAt),
  // Composite index for date range + station aggregation queries
  stationTimingIdx: index("shipment_events_station_timing_idx").on(table.occurredAt, table.stationId).where(sql`${table.stationId} IS NOT NULL`),
}));

export const insertShipmentEventSchema = createInsertSchema(shipmentEvents).omit({
  id: true,
}).extend({
  occurredAt: z.coerce.date().optional(),
  metadata: z.any().nullish(),
});

export type InsertShipmentEvent = z.infer<typeof insertShipmentEventSchema>;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;

// Shopify Products table - synced from Shopify Admin API
export const shopifyProducts = pgTable("shopify_products", {
  id: varchar("id").primaryKey(), // Shopify product ID
  title: text("title").notNull(),
  imageUrl: text("image_url"),
  status: text("status").notNull().default("active"), // active, archived, draft
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // Soft delete
});

export const insertShopifyProductSchema = createInsertSchema(shopifyProducts).omit({
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
});

export type InsertShopifyProduct = z.infer<typeof insertShopifyProductSchema>;
export type ShopifyProduct = typeof shopifyProducts.$inferSelect;

// Shopify Product Variants table - synced from Shopify Admin API
export const shopifyProductVariants = pgTable("shopify_product_variants", {
  id: varchar("id").primaryKey(), // Shopify variant ID
  productId: varchar("product_id").notNull().references(() => shopifyProducts.id),
  sku: text("sku"), // Indexed for fast lookups
  barCode: text("bar_code"), // Indexed for barcode scanning
  title: text("title").notNull(),
  imageUrl: text("image_url"), // Variant-specific image, falls back to product image
  price: text("price").notNull(),
  inventoryQuantity: integer("inventory_quantity").notNull().default(0),
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"), // Soft delete
}, (table) => ({
  skuIdx: index("shopify_product_variants_sku_idx").on(table.sku).where(sql`${table.deletedAt} IS NULL`),
  barCodeIdx: index("shopify_product_variants_bar_code_idx").on(table.barCode).where(sql`${table.deletedAt} IS NULL`),
}));

export const insertShopifyProductVariantSchema = createInsertSchema(shopifyProductVariants).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertShopifyProductVariant = z.infer<typeof insertShopifyProductVariantSchema>;
export type ShopifyProductVariant = typeof shopifyProductVariants.$inferSelect;

// Backfill jobs table for order backfill operations
export const backfillJobs = pgTable("backfill_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed, cancelled
  // Shopify progress tracking
  shopifyOrdersTotal: integer("shopify_orders_total").notNull().default(0),
  shopifyOrdersImported: integer("shopify_orders_imported").notNull().default(0),
  shopifyOrdersFailed: integer("shopify_orders_failed").notNull().default(0),
  // ShipStation progress tracking
  shipstationShipmentsTotal: integer("shipstation_shipments_total").notNull().default(0),
  shipstationShipmentsImported: integer("shipstation_shipments_imported").notNull().default(0),
  shipstationShipmentsFailed: integer("shipstation_shipments_failed").notNull().default(0),
  // Resume cursor for ShipStation pagination (oldest created_at seen in last complete page)
  shipstationResumeCreatedAt: timestamp("shipstation_resume_created_at"),
  // Error tracking
  errorMessage: text("error_message"),
  // Timestamps
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Index for resume checks and status monitoring
  statusIdx: index("backfill_jobs_status_idx").on(table.status),
  // Index for job timeline queries
  createdAtIdx: index("backfill_jobs_created_at_idx").on(table.createdAt.desc().nullsLast()),
}));

export const insertBackfillJobSchema = createInsertSchema(backfillJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBackfillJob = z.infer<typeof insertBackfillJobSchema>;
export type BackfillJob = typeof backfillJobs.$inferSelect;

// Print queue table for tracking label printing jobs
export const printQueue = pgTable("print_queue", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull().references(() => orders.id),
  labelUrl: text("label_url"), // ShipStation label PDF/ZPL URL (nullable until label is fetched/created)
  status: text("status").notNull().default("queued"), // queued, printing, printed, failed
  error: text("error"), // Error message if status is failed
  retryCount: integer("retry_count").notNull().default(0), // Number of retry attempts
  lastRetryAt: timestamp("last_retry_at"), // Last retry timestamp for backoff calculation
  queuedAt: timestamp("queued_at").notNull().defaultNow(),
  printedAt: timestamp("printed_at"),
}, (table) => ({
  // Composite index for polling worker queries (status + time ordering)
  statusQueuedAtIdx: index("print_queue_status_queued_at_idx").on(table.status, table.queuedAt),
}));

export const insertPrintQueueSchema = createInsertSchema(printQueue).omit({
  id: true,
  queuedAt: true,
}).extend({
  labelUrl: z.string().nullish(),
  error: z.string().nullish(),
});

export type InsertPrintQueue = z.infer<typeof insertPrintQueueSchema>;
export type PrintQueue = typeof printQueue.$inferSelect;

// Shipment sync failures table for dead letter queue
export const shipmentSyncFailures = pgTable("shipment_sync_failures", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipstationShipmentId: text("shipstation_shipment_id"), // ShipStation shipment ID (nullable for orphan failures)
  modifiedAt: text("modified_at"), // Shipment modified_at timestamp (nullable for webhooks without timestamp)
  orderNumber: text("order_number").notNull(),
  reason: text("reason").notNull(), // 'unified_sync' | 'backfill' | 'webhook' | 'manual'
  errorMessage: text("error_message").notNull(),
  requestData: jsonb("request_data"), // Original shipment data from ShipStation
  responseData: jsonb("response_data"), // API response if available
  retryCount: integer("retry_count").notNull().default(0), // Number of times we tried before dead-lettering
  failedAt: timestamp("failed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  orderNumberIdx: index("shipment_sync_failures_order_number_idx").on(table.orderNumber),
  failedAtIdx: index("shipment_sync_failures_failed_at_idx").on(table.failedAt),
  // Index on shipment ID for lookups (no longer unique since we may have nulls)
  shipmentIdIdx: index("shipment_sync_failures_shipment_id_idx").on(table.shipstationShipmentId),
}));

export const insertShipmentSyncFailureSchema = createInsertSchema(shipmentSyncFailures).omit({
  id: true,
  createdAt: true,
}).extend({
  shipstationShipmentId: z.string().nullish(),
  modifiedAt: z.string().nullish(),
  requestData: z.any().nullish(),
  responseData: z.any().nullish(),
});

export type InsertShipmentSyncFailure = z.infer<typeof insertShipmentSyncFailureSchema>;
export type ShipmentSyncFailure = typeof shipmentSyncFailures.$inferSelect;

// Shipments dead letters table - stores shipments that cannot be processed
export const shipmentsDeadLetters = pgTable("shipments_dead_letters", {
  shipmentId: text("shipment_id").primaryKey(), // ShipStation shipment ID like "se-123454356"
  data: jsonb("data").notNull(), // Raw shipment data from ShipStation
  reason: text("reason").notNull(), // Why it was dead-lettered (e.g., "null_order_number")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertShipmentsDeadLetterSchema = createInsertSchema(shipmentsDeadLetters).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertShipmentsDeadLetter = z.infer<typeof insertShipmentsDeadLetterSchema>;
export type ShipmentsDeadLetter = typeof shipmentsDeadLetters.$inferSelect;

// Shopify order sync failures table for dead letter queue
export const shopifyOrderSyncFailures = pgTable("shopify_order_sync_failures", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderNumber: text("order_number").notNull(),
  reason: text("reason").notNull(), // 'shipment-webhook' | 'manual' | etc
  errorMessage: text("error_message").notNull(),
  requestData: jsonb("request_data"), // Original request details (queue message)
  responseData: jsonb("response_data"), // Shopify API response if available
  retryCount: integer("retry_count").notNull().default(0),
  failedAt: timestamp("failed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  orderNumberIdx: index("shopify_order_sync_failures_order_number_idx").on(table.orderNumber),
  failedAtIdx: index("shopify_order_sync_failures_failed_at_idx").on(table.failedAt),
}));

export const insertShopifyOrderSyncFailureSchema = createInsertSchema(shopifyOrderSyncFailures).omit({
  id: true,
  createdAt: true,
}).extend({
  requestData: z.any().nullish(),
  responseData: z.any().nullish(),
});

export type InsertShopifyOrderSyncFailure = z.infer<typeof insertShopifyOrderSyncFailureSchema>;
export type ShopifyOrderSyncFailure = typeof shopifyOrderSyncFailures.$inferSelect;

// Packing logs table for QC audit trail
export const packingLogs = pgTable("packing_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  orderNumber: text("order_number").notNull(),
  action: text("action").notNull(), // 'scan_order', 'scan_product', 'qc_pass', 'qc_fail', 'complete_order'
  productSku: text("product_sku"), // SKU scanned (null for scan_order/complete_order actions)
  scannedCode: text("scanned_code"), // Actual barcode value
  skuVaultProductId: text("skuvault_product_id"), // IdItem from SkuVault (null if not found)
  success: boolean("success").notNull(),
  errorMessage: text("error_message"),
  skuVaultRawResponse: jsonb("skuvault_raw_response"), // Full SkuVault API response for debugging/audit
  station: text("station"), // 'boxing' | 'bagging' - nullable for historical logs
  stationId: text("station_id"), // UUID of specific workstation
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("packing_logs_shipment_id_idx").on(table.shipmentId),
  userIdIdx: index("packing_logs_user_id_idx").on(table.userId),
  orderNumberIdx: index("packing_logs_order_number_idx").on(table.orderNumber),
  createdAtIdx: index("packing_logs_created_at_idx").on(table.createdAt),
  stationIdx: index("packing_logs_station_idx").on(table.station),
}));

export const insertPackingLogSchema = createInsertSchema(packingLogs).omit({
  id: true,
  createdAt: true,
}).extend({
  skuVaultRawResponse: z.any().nullish(), // Allow any JSON structure from SkuVault API
});

export type InsertPackingLog = z.infer<typeof insertPackingLogSchema>;
export type PackingLog = typeof packingLogs.$inferSelect;

// Saved views for customizable table columns and filters
export const savedViews = pgTable("saved_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  page: text("page").notNull(), // e.g., 'po-recommendations', 'orders', 'shipments'
  config: jsonb("config").notNull(), // { columns: string[], filters: {...}, sort: {...} }
  isPublic: boolean("is_public").notNull().default(false), // Whether view is shareable
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  userIdPageIdx: index("saved_views_user_id_page_idx").on(table.userId, table.page),
  isPublicIdx: index("saved_views_is_public_idx").on(table.isPublic),
}));

export const insertSavedViewSchema = createInsertSchema(savedViews).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  config: z.object({
    columns: z.array(z.string()),
    filters: z.record(z.any()).optional(),
    sort: z.object({
      column: z.string(),
      order: z.enum(['asc', 'desc']),
    }).optional(),
  }),
});

export type InsertSavedView = z.infer<typeof insertSavedViewSchema>;
export type SavedView = typeof savedViews.$inferSelect;
export type SavedViewConfig = z.infer<typeof insertSavedViewSchema>['config'];

// ============================================================================
// DESKTOP PRINTING SYSTEM TABLES
// ============================================================================

// Stations - Physical packing stations in the warehouse
export const stations = pgTable("stations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(), // e.g., "Station 1", "Packing Area A"
  locationHint: text("location_hint"), // e.g., "Near shipping dock", "Second floor"
  stationType: text("station_type"), // 'boxing_machine', 'poly_bag', 'hand_pack' - matches packaging_types.station_type
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  nameIdx: index("stations_name_idx").on(table.name),
  isActiveIdx: index("stations_is_active_idx").on(table.isActive),
  stationTypeIdx: index("stations_station_type_idx").on(table.stationType),
}));

export const insertStationSchema = createInsertSchema(stations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertStation = z.infer<typeof insertStationSchema>;
export type Station = typeof stations.$inferSelect;

// Printers - Local printers discovered by desktop apps
export const printers = pgTable("printers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stationId: varchar("station_id").references(() => stations.id), // Nullable - printer may not be assigned to a station yet
  name: text("name").notNull(), // Display name, e.g., "Zebra ZP450"
  systemName: text("system_name").notNull(), // macOS system printer name for lpstat/lp
  printerType: text("printer_type").notNull().default("label"), // "label" or "document"
  capabilities: jsonb("capabilities"), // Supported paper sizes, dpi, etc.
  isDefault: boolean("is_default").notNull().default(false), // Default printer for this station
  status: text("status").notNull().default("offline"), // Printer status: "online", "offline", "busy", "error"
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  stationIdIdx: index("printers_station_id_idx").on(table.stationId),
  systemNameIdx: uniqueIndex("printers_system_name_idx").on(table.systemName),
}));

export const insertPrinterSchema = createInsertSchema(printers).omit({
  id: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPrinter = z.infer<typeof insertPrinterSchema>;
export type Printer = typeof printers.$inferSelect;

// Desktop Clients - Registered Electron app instances with auth tokens
export const desktopClients = pgTable("desktop_clients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  deviceName: text("device_name").notNull(), // Computer name, e.g., "Rays-MacBook-Pro"
  accessTokenHash: text("access_token_hash").notNull(), // Hashed access token
  refreshTokenHash: text("refresh_token_hash").notNull(), // Hashed refresh token
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at").notNull(),
  lastIp: text("last_ip"),
  lastActiveAt: timestamp("last_active_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("desktop_clients_user_id_idx").on(table.userId),
  accessTokenHashIdx: uniqueIndex("desktop_clients_access_token_hash_idx").on(table.accessTokenHash),
  refreshTokenHashIdx: uniqueIndex("desktop_clients_refresh_token_hash_idx").on(table.refreshTokenHash),
}));

export const insertDesktopClientSchema = createInsertSchema(desktopClients).omit({
  id: true,
  lastActiveAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDesktopClient = z.infer<typeof insertDesktopClientSchema>;
export type DesktopClient = typeof desktopClients.$inferSelect;

// Station Sessions - Who's working at which station (20-hour sessions)
export const stationSessions = pgTable("station_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stationId: varchar("station_id").notNull().references(() => stations.id),
  userId: varchar("user_id").notNull().references(() => users.id),
  desktopClientId: varchar("desktop_client_id").notNull().references(() => desktopClients.id),
  status: text("status").notNull().default("active"), // "active", "ended", "expired"
  startedAt: timestamp("started_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(), // startedAt + 20 hours
  endedAt: timestamp("ended_at"), // When user manually ended or was kicked
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  stationIdIdx: index("station_sessions_station_id_idx").on(table.stationId),
  userIdIdx: index("station_sessions_user_id_idx").on(table.userId),
  desktopClientIdIdx: index("station_sessions_desktop_client_id_idx").on(table.desktopClientId),
  statusIdx: index("station_sessions_status_idx").on(table.status),
  // Ensure only one active session per station at a time
  activeStationIdx: uniqueIndex("station_sessions_active_station_idx")
    .on(table.stationId)
    .where(sql`${table.status} = 'active'`),
}));

export const insertStationSessionSchema = createInsertSchema(stationSessions).omit({
  id: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
});

export type InsertStationSession = z.infer<typeof insertStationSessionSchema>;
export type StationSession = typeof stationSessions.$inferSelect;

// Print Jobs - Queue of labels to print with status tracking
export const printJobs = pgTable("print_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  stationId: varchar("station_id").notNull().references(() => stations.id),
  printerId: varchar("printer_id").references(() => printers.id), // Nullable until printer is assigned
  orderId: varchar("order_id").references(() => orders.id), // Optional link to order
  shipmentId: varchar("shipment_id").references(() => shipments.id), // Optional link to shipment
  jobType: text("job_type").notNull().default("label"), // "label", "packing_slip", "invoice"
  payload: jsonb("payload").notNull(), // Label data, PDF URL, or raw print content
  // Status lifecycle: pending -> picked_up -> sent -> completed/failed
  // pending: Job created, waiting for desktop to pick up
  // picked_up: Desktop received the job
  // sent: Job sent to printer spooler
  // completed: Print job finished successfully
  // failed: Print job failed (includes error message)
  status: text("status").notNull().default("pending"), // "pending", "picked_up", "sent", "completed", "failed"
  priority: integer("priority").notNull().default(0), // Higher = more urgent
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  errorMessage: text("error_message"),
  requestedBy: varchar("requested_by").references(() => users.id), // User who created the print job
  sentAt: timestamp("sent_at"), // When job was sent to desktop client
  completedAt: timestamp("completed_at"), // When printing finished
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  stationIdIdx: index("print_jobs_station_id_idx").on(table.stationId),
  printerIdIdx: index("print_jobs_printer_id_idx").on(table.printerId),
  orderIdIdx: index("print_jobs_order_id_idx").on(table.orderId),
  shipmentIdIdx: index("print_jobs_shipment_id_idx").on(table.shipmentId),
  statusIdx: index("print_jobs_status_idx").on(table.status),
  requestedByIdx: index("print_jobs_requested_by_idx").on(table.requestedBy),
  // Composite index for fetching pending jobs by station, ordered by priority
  pendingJobsIdx: index("print_jobs_pending_idx")
    .on(table.stationId, table.priority.desc(), table.createdAt)
    .where(sql`${table.status} = 'pending'`),
}));

export const insertPrintJobSchema = createInsertSchema(printJobs).omit({
  id: true,
  attempts: true,
  sentAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPrintJob = z.infer<typeof insertPrintJobSchema>;
export type PrintJob = typeof printJobs.$inferSelect;

// Desktop Client Configuration - Global settings for all desktop clients
// Single-row table pattern: id is always 'global'
export const desktopConfig = pgTable("desktop_config", {
  id: varchar("id").primaryKey().default("global"), // Always 'global' for single-row pattern
  // WebSocket timing settings (in milliseconds)
  connectionTimeout: integer("connection_timeout").notNull().default(15000), // 15 seconds
  baseReconnectDelay: integer("base_reconnect_delay").notNull().default(2000), // 2 seconds
  maxReconnectDelay: integer("max_reconnect_delay").notNull().default(30000), // 30 seconds
  heartbeatInterval: integer("heartbeat_interval").notNull().default(30000), // 30 seconds
  reconnectInterval: integer("reconnect_interval").notNull().default(5000), // 5 seconds
  // Token/Auth timing
  tokenRefreshInterval: integer("token_refresh_interval").notNull().default(3600000), // 1 hour
  // Offline notification
  offlineTimeout: integer("offline_timeout").notNull().default(1000), // 1 second
  // Metadata
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: varchar("updated_by").references(() => users.id),
});

export const insertDesktopConfigSchema = createInsertSchema(desktopConfig).omit({
  updatedAt: true,
});

export type InsertDesktopConfig = z.infer<typeof insertDesktopConfigSchema>;
export type DesktopConfig = typeof desktopConfig.$inferSelect;

// Web Packing Sessions - Tracks which station web users are working at (daily sessions)
// Expires at midnight local time each day, so users select their station each morning
export const webPackingSessions = pgTable("web_packing_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  stationId: varchar("station_id").notNull().references(() => stations.id),
  selectedAt: timestamp("selected_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(), // Midnight local time
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index("web_packing_sessions_user_id_idx").on(table.userId),
  stationIdIdx: index("web_packing_sessions_station_id_idx").on(table.stationId),
  expiresAtIdx: index("web_packing_sessions_expires_at_idx").on(table.expiresAt),
}));

export const insertWebPackingSessionSchema = createInsertSchema(webPackingSessions).omit({
  id: true,
  selectedAt: true,
  createdAt: true,
});

export type InsertWebPackingSession = z.infer<typeof insertWebPackingSessionSchema>;
export type WebPackingSession = typeof webPackingSessions.$inferSelect;

// Product Collections - Groups of products with similar physical characteristics for Ship. Smart Shipping Engine
// Used for footprint detection to determine packaging type and station routing
export const productCollections = pgTable("product_collections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  incrementalQuantity: integer("incremental_quantity"), // Quantity increment for packaging calculations
  productCategory: text("product_category"), // Category from skuvault_products
  createdBy: varchar("created_by").notNull().references(() => users.id),
  updatedBy: varchar("updated_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  nameIdx: index("product_collections_name_idx").on(table.name),
}));

export const insertProductCollectionSchema = createInsertSchema(productCollections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProductCollection = z.infer<typeof insertProductCollectionSchema>;
export type ProductCollection = typeof productCollections.$inferSelect;

// Product Collection Mappings - Maps product SKUs to collections (many-to-many)
// A SKU can belong to multiple collections for flexibility
export const productCollectionMappings = pgTable("product_collection_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productCollectionId: varchar("product_collection_id").notNull().references(() => productCollections.id),
  sku: text("sku").notNull(),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  updatedBy: varchar("updated_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  productCollectionIdIdx: index("product_collection_mappings_collection_id_idx").on(table.productCollectionId),
  skuIdx: index("product_collection_mappings_sku_idx").on(table.sku),
}));

export const insertProductCollectionMappingSchema = createInsertSchema(productCollectionMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProductCollectionMapping = z.infer<typeof insertProductCollectionMappingSchema>;
export type ProductCollectionMapping = typeof productCollectionMappings.$inferSelect;

// Kit Component Mappings - Maps kit SKUs to their component SKUs
// Synced hourly from GCP reporting database (vw_internal_kit_component_inventory_latest)
// Used by QC hydrator to explode kits into their components
export const kitComponentMappings = pgTable("kit_component_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  kitSku: text("kit_sku").notNull(),
  componentSku: text("component_sku").notNull(),
  componentQuantity: integer("component_quantity").notNull().default(1),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
}, (table) => ({
  kitSkuIdx: index("kit_component_mappings_kit_sku_idx").on(table.kitSku),
  componentSkuIdx: index("kit_component_mappings_component_sku_idx").on(table.componentSku),
  uniqueMapping: index("kit_component_mappings_unique_idx").on(table.kitSku, table.componentSku),
}));

export const insertKitComponentMappingSchema = createInsertSchema(kitComponentMappings).omit({
  id: true,
  syncedAt: true,
});

export type InsertKitComponentMapping = z.infer<typeof insertKitComponentMappingSchema>;
export type KitComponentMapping = typeof kitComponentMappings.$inferSelect;

// Slashbin Kit Component Mappings - Real-time kit mappings from Slashbin webhooks
// Updated via webhook when kit compositions change in SkuVault
export const slashbinKitComponentMappings = pgTable("slashbin_kit_component_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  kitSku: text("kit_sku").notNull(),
  componentSku: text("component_sku").notNull(),
  componentQuantity: integer("component_quantity").notNull().default(1),
  syncedAt: timestamp("synced_at").notNull().defaultNow(),
}, (table) => ({
  kitSkuIdx: index("slashbin_kit_component_mappings_kit_sku_idx").on(table.kitSku),
  componentSkuIdx: index("slashbin_kit_component_mappings_component_sku_idx").on(table.componentSku),
  uniqueMapping: index("slashbin_kit_component_mappings_unique_idx").on(table.kitSku, table.componentSku),
}));

export const insertSlashbinKitComponentMappingSchema = createInsertSchema(slashbinKitComponentMappings).omit({
  id: true,
  syncedAt: true,
});

export type InsertSlashbinKitComponentMapping = z.infer<typeof insertSlashbinKitComponentMappingSchema>;
export type SlashbinKitComponentMapping = typeof slashbinKitComponentMappings.$inferSelect;

// Slashbin Orders - Shopify orders received via Slashbin webhooks
// Flattens shipping and customer objects into main table
export const slashbinOrders = pgTable("slashbin_orders", {
  orderNumber: varchar("order_number").primaryKey(), // e.g., "JK3825361274"
  orderTotal: numeric("order_total", { precision: 10, scale: 2 }),
  orderDate: timestamp("order_date"),
  buyerEmail: text("buyer_email"),
  taxTotal: numeric("tax_total", { precision: 10, scale: 2 }),
  subTotal: numeric("sub_total", { precision: 10, scale: 2 }),
  shippingCost: numeric("shipping_cost", { precision: 10, scale: 2 }),
  discountTotal: numeric("discount_total", { precision: 10, scale: 2 }),
  tags: text("tags"),
  refundTotal: numeric("refund_total", { precision: 10, scale: 2 }),
  notes: text("notes"),
  shippingMethod: text("shipping_method"),
  orderStatus: text("order_status"),
  salesChannel: text("sales_channel"),
  // Flattened shipping fields
  shippingFirstName: text("shipping_first_name"),
  shippingLastName: text("shipping_last_name"),
  shippingAddress1: text("shipping_address1"),
  shippingAddress2: text("shipping_address2"),
  shippingCity: text("shipping_city"),
  shippingProvince: text("shipping_province"),
  shippingProvinceCode: text("shipping_province_code"),
  shippingZip: text("shipping_zip"),
  shippingCountry: text("shipping_country"),
  shippingCountryCode: text("shipping_country_code"),
  shippingPhone: text("shipping_phone"),
  shippingCompany: text("shipping_company"),
  // Flattened customer fields
  customerId: text("customer_id"),
  customerEmail: text("customer_email"),
  customerFirstName: text("customer_first_name"),
  customerLastName: text("customer_last_name"),
  customerPhone: text("customer_phone"),
  customerCreatedAt: timestamp("customer_created_at"),
  customerCurrency: text("customer_currency"),
  customerProvince: text("customer_province"),
  customerCountry: text("customer_country"),
  customerAddress1: text("customer_address1"),
  customerCity: text("customer_city"),
  customerZip: text("customer_zip"),
  // Tracking timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orderDateIdx: index("slashbin_orders_order_date_idx").on(table.orderDate),
  orderStatusIdx: index("slashbin_orders_order_status_idx").on(table.orderStatus),
  buyerEmailIdx: index("slashbin_orders_buyer_email_idx").on(table.buyerEmail),
}));

export const insertSlashbinOrderSchema = createInsertSchema(slashbinOrders).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSlashbinOrder = z.infer<typeof insertSlashbinOrderSchema>;
export type SlashbinOrder = typeof slashbinOrders.$inferSelect;

// Slashbin Order Items - Line items for Slashbin orders
// Uses auto-generated UUID primary key to allow duplicate SKUs in the same order
export const slashbinOrderItems = pgTable("slashbin_order_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderNumber: varchar("order_number").notNull().references(() => slashbinOrders.orderNumber, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  productName: text("product_name"),
  qty: integer("qty"),
  fulfillmentStatus: text("fulfillment_status"),
  price: numeric("price", { precision: 10, scale: 2 }),
  productBrand: text("product_brand"),
  weight: numeric("weight", { precision: 10, scale: 2 }),
  tax: numeric("tax", { precision: 10, scale: 2 }),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }),
  productId: text("product_id"),
  // Tracking timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orderNumberIdx: index("slashbin_order_items_order_number_idx").on(table.orderNumber),
  skuIdx: index("slashbin_order_items_sku_idx").on(table.sku),
}));

export const insertSlashbinOrderItemSchema = createInsertSchema(slashbinOrderItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSlashbinOrderItem = z.infer<typeof insertSlashbinOrderItemSchema>;
export type SlashbinOrderItem = typeof slashbinOrderItems.$inferSelect;

// Slashbin Products - Shopify products received via Slashbin webhooks
export const slashbinProducts = pgTable("slashbin_products", {
  id: varchar("id").primaryKey(), // Shopify product ID
  title: text("title").notNull(),
  imageUrl: text("image_url"),
  status: text("status").notNull().default("active"), // active, archived, draft
  tags: text("tags"), // Comma-separated product tags
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const insertSlashbinProductSchema = createInsertSchema(slashbinProducts).omit({
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
});

export type InsertSlashbinProduct = z.infer<typeof insertSlashbinProductSchema>;
export type SlashbinProduct = typeof slashbinProducts.$inferSelect;

// Slashbin Product Variants - Shopify product variants received via Slashbin webhooks
export const slashbinProductVariants = pgTable("slashbin_product_variants", {
  id: varchar("id").primaryKey(), // Shopify variant ID
  productId: varchar("product_id").notNull().references(() => slashbinProducts.id),
  sku: text("sku"),
  barCode: text("bar_code"),
  title: text("title").notNull(),
  imageUrl: text("image_url"),
  price: text("price").notNull(),
  inventoryQuantity: integer("inventory_quantity").notNull().default(0),
  shopifyCreatedAt: timestamp("shopify_created_at").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (table) => ({
  skuIdx: index("slashbin_product_variants_sku_idx").on(table.sku).where(sql`${table.deletedAt} IS NULL`),
  barCodeIdx: index("slashbin_product_variants_bar_code_idx").on(table.barCode).where(sql`${table.deletedAt} IS NULL`),
}));

export const insertSlashbinProductVariantSchema = createInsertSchema(slashbinProductVariants).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSlashbinProductVariant = z.infer<typeof insertSlashbinProductVariantSchema>;
export type SlashbinProductVariant = typeof slashbinProductVariants.$inferSelect;

// ============================================================================
// PHASE 3: SMART SHIPPING ENGINE - FINGERPRINT DETECTION & LEARNING
// ============================================================================

// Packaging Types - Discrete set of packaging options used by jerky.com
// Seeded from historical shipment_packages data
export const packagingTypes = pgTable("packaging_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: text("package_id").unique(), // ShipStation unique identifier (e.g., "se-154479") - prevents duplicate imports
  name: text("name").notNull().unique(), // e.g., "Box #2 (13 x 13 x 13)", "Poly Bag 16x18"
  packageCode: text("package_code"), // ShipStation package code
  dimensionLength: text("dimension_length"),
  dimensionWidth: text("dimension_width"),
  dimensionHeight: text("dimension_height"),
  dimensionUnit: text("dimension_unit").default("inch"),
  stationType: text("station_type"), // 'boxing_machine', 'poly_bag', 'hand_pack'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  packageIdIdx: index("packaging_types_package_id_idx").on(table.packageId),
  nameIdx: index("packaging_types_name_idx").on(table.name),
  stationTypeIdx: index("packaging_types_station_type_idx").on(table.stationType),
}));

export const insertPackagingTypeSchema = createInsertSchema(packagingTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPackagingType = z.infer<typeof insertPackagingTypeSchema>;
export type PackagingType = typeof packagingTypes.$inferSelect;

// Fingerprints - Unique "shape signatures" based on collection composition
// A fingerprint represents a specific combination of collections + quantities
export const fingerprints = pgTable("fingerprints", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  signature: text("signature").notNull().unique(), // Canonical JSON string, e.g., '{"GiftBox":2,"SmallJerky":5,"weight":42}'
  signatureHash: text("signature_hash").notNull().unique(), // Hash for fast lookup
  displayName: text("display_name"), // Human-readable, e.g., "2 Gift Boxes + 5 Small Jerky | 42oz"
  totalItems: integer("total_items").notNull(), // Sum of all quantities
  collectionCount: integer("collection_count").notNull(), // Number of distinct collections
  totalWeight: real("total_weight"), // Total order weight in weightUnit (sum of item weights) - decimal for precision
  weightUnit: text("weight_unit"), // Weight unit (e.g., "oz")
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  signatureHashIdx: index("fingerprints_signature_hash_idx").on(table.signatureHash),
  totalItemsIdx: index("fingerprints_total_items_idx").on(table.totalItems),
}));

export const insertFingerprintSchema = createInsertSchema(fingerprints).omit({
  id: true,
  createdAt: true,
});

export type InsertFingerprint = z.infer<typeof insertFingerprintSchema>;
export type Fingerprint = typeof fingerprints.$inferSelect;

// Fingerprint Models - Learned rules mapping fingerprint → packaging type
// When a manager decides packaging for an unknown fingerprint, it becomes a permanent rule
export const fingerprintModels = pgTable("fingerprint_models", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fingerprintId: varchar("fingerprint_id").notNull().references(() => fingerprints.id),
  packagingTypeId: varchar("packaging_type_id").notNull().references(() => packagingTypes.id),
  confidence: text("confidence").default("manual"), // 'manual', 'high', 'medium', 'low' (for future ML)
  createdBy: varchar("created_by").notNull().references(() => users.id),
  notes: text("notes"), // Optional notes about the decision
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  fingerprintIdIdx: uniqueIndex("fingerprint_models_fingerprint_id_idx").on(table.fingerprintId), // One model per fingerprint
  packagingTypeIdIdx: index("fingerprint_models_packaging_type_id_idx").on(table.packagingTypeId),
}));

export const insertFingerprintModelSchema = createInsertSchema(fingerprintModels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFingerprintModel = z.infer<typeof insertFingerprintModelSchema>;
export type FingerprintModel = typeof fingerprintModels.$inferSelect;

// Shipment QC Items - Exploded line items for each shipment with QC tracking
// Each row represents one SKU (post-explosion) that needs to be scanned during packing
export const shipmentQcItems = pgTable("shipment_qc_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  sku: text("sku").notNull(), // Individual product SKU (post-explosion)
  barcode: text("barcode"), // Scannable barcode (from internal_inventory.code)
  description: text("description"), // Product name for display
  imageUrl: text("image_url"), // Product image from skuvault_products
  quantityExpected: integer("quantity_expected").notNull().default(1), // How many we need to scan
  quantityScanned: integer("quantity_scanned").notNull().default(0), // How many we've scanned so far
  collectionId: varchar("collection_id").references(() => productCollections.id), // For fingerprint calculation
  syncedToSkuvault: boolean("synced_to_skuvault").notNull().default(false), // Have we pushed passQCitem
  isKitComponent: boolean("is_kit_component").notNull().default(false), // True if this is an exploded kit component
  parentSku: text("parent_sku"), // If kit component, the parent kit SKU
  weightValue: real("weight_value"), // Weight per unit in weightUnit (from skuvault_products) - decimal for precision
  weightUnit: text("weight_unit"), // Weight unit (e.g., "oz", "lb")
  physicalLocation: text("physical_location"), // Warehouse location (from skuvault_products) for picking path optimization
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shipmentSkuUnique: uniqueIndex("shipment_qc_items_shipment_sku_unique").on(table.shipmentId, table.sku),
  shipmentIdIdx: index("shipment_qc_items_shipment_id_idx").on(table.shipmentId),
  skuIdx: index("shipment_qc_items_sku_idx").on(table.sku),
  barcodeIdx: index("shipment_qc_items_barcode_idx").on(table.barcode).where(sql`${table.barcode} IS NOT NULL`),
  collectionIdIdx: index("shipment_qc_items_collection_id_idx").on(table.collectionId).where(sql`${table.collectionId} IS NOT NULL`),
  syncedToSkuvaultIdx: index("shipment_qc_items_synced_idx").on(table.syncedToSkuvault),
}));

export const insertShipmentQcItemSchema = createInsertSchema(shipmentQcItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShipmentQcItem = z.infer<typeof insertShipmentQcItemSchema>;
export type ShipmentQcItem = typeof shipmentQcItems.$inferSelect;

// Fulfillment Session Status Enum
export const FULFILLMENT_SESSION_STATUSES = ['draft', 'ready', 'picking', 'packing', 'completed', 'cancelled'] as const;
export type FulfillmentSessionStatus = typeof FULFILLMENT_SESSION_STATUSES[number];

// Fulfillment Sessions - Ship.'s optimized order groupings for warehouse flow
// Groups orders by station type and similar products for efficient picking/packing
export const fulfillmentSessions = pgTable("fulfillment_sessions", {
  id: serial("id").primaryKey(),
  // Session identification
  name: text("name"), // Optional human-readable name (e.g., "Boxing Session #42")
  sequenceNumber: integer("sequence_number"), // Auto-incrementing session number per day
  // Station routing
  stationId: varchar("station_id").references(() => stations.id), // Target packing station
  stationType: text("station_type").notNull(), // 'boxing_machine', 'poly_bag', 'hand_pack'
  // Session composition
  orderCount: integer("order_count").notNull().default(0), // Number of orders in this session
  maxOrders: integer("max_orders").notNull().default(28), // Physical cart capacity limit
  // Status tracking
  status: text("status").notNull().default('draft'), // draft, ready, picking, packing, completed, cancelled
  // Timestamps
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  readyAt: timestamp("ready_at"), // When session was marked ready for picking
  pickingStartedAt: timestamp("picking_started_at"), // When picking began
  packingStartedAt: timestamp("packing_started_at"), // When packing began
  completedAt: timestamp("completed_at"), // When all orders completed
  // Audit
  createdBy: varchar("created_by").references(() => users.id),
}, (table) => ({
  stationTypeIdx: index("fulfillment_sessions_station_type_idx").on(table.stationType),
  stationIdIdx: index("fulfillment_sessions_station_id_idx").on(table.stationId).where(sql`${table.stationId} IS NOT NULL`),
  statusIdx: index("fulfillment_sessions_status_idx").on(table.status),
  createdAtIdx: index("fulfillment_sessions_created_at_idx").on(table.createdAt.desc()),
}));

export const insertFulfillmentSessionSchema = createInsertSchema(fulfillmentSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFulfillmentSession = z.infer<typeof insertFulfillmentSessionSchema>;
export type FulfillmentSession = typeof fulfillmentSessions.$inferSelect;

// ============================================================================
// SKUVAULT PRODUCTS (Centralized product catalog from SkuVault/reporting DB)
// ============================================================================

/**
 * SkuVault Products - Centralized product catalog synced hourly from reporting database
 * 
 * Data sources (three queries merged in order):
 * 1. Kit products: internal_kit_inventory (kits with cost/barcode)
 * 2. Parent products: internal_inventory WHERE sku = primary_sku (individual products with weight)
 * 3. Variant products: internal_inventory WHERE sku != primary_sku (variants with parent_sku)
 * 
 * Primary key is SKU - duplicates are merged with later queries filling missing fields.
 * 
 * Image URL resolution priority:
 * 1. productVariants table (Shopify catalog)
 * 2. shipmentItems table (most recent order)
 * 3. orderItems → related shipment (if available)
 * 4. null (fallback to default image)
 */
export const skuvaultProducts = pgTable("skuvault_products", {
  sku: text("sku").primaryKey(), // SkuVault SKU - unique identifier
  stockCheckDate: timestamp("stock_check_date").notNull(), // Date of the data snapshot
  productTitle: text("product_title"), // Product description/name from SkuVault
  barcode: text("barcode"), // Scannable barcode (internal_inventory.code)
  productCategory: text("product_category"), // Category from inventory_forecasts_daily (or 'kit')
  isAssembledProduct: boolean("is_assembled_product").notNull().default(false), // True for kits/APs
  unitCost: text("unit_cost"), // Cost per unit (stored as text for precision)
  productImageUrl: text("product_image_url"), // Resolved from products/shipments/orders
  weightValue: real("weight_value"), // Weight value as decimal (from internal_inventory) - preserves precision
  weightUnit: text("weight_unit"), // Weight unit (e.g., "oz", "lb")
  parentSku: text("parent_sku"), // For variants: the parent SKU this variant belongs to (null for parents/kits)
  quantityOnHand: integer("quantity_on_hand").notNull().default(0), // Current stock quantity from SkuVault (snapshot, read-only)
  pendingQuantity: integer("pending_quantity").notNull().default(0), // Orders hydrated but not yet in a session (incremented on QC explosion, cleared when session starts)
  allocatedQuantity: integer("allocated_quantity").notNull().default(0), // Orders in active sessions (moved from pending when session is built)
  availableQuantity: integer("available_quantity").notNull().default(0), // Available stock = quantityOnHand - allocatedQuantity (pending doesn't block availability, reset on daily sync)
  physicalLocation: text("physical_location"), // Physical warehouse location from SkuVault inventory API (synced hourly)
  brand: text("brand"), // Brand name from SkuVault (e.g., "Jerky.com", "Klements")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  stockCheckDateIdx: index("skuvault_products_stock_check_date_idx").on(table.stockCheckDate),
  productCategoryIdx: index("skuvault_products_product_category_idx").on(table.productCategory).where(sql`${table.productCategory} IS NOT NULL`),
  isAssembledProductIdx: index("skuvault_products_is_assembled_product_idx").on(table.isAssembledProduct),
  barcodeIdx: index("skuvault_products_barcode_idx").on(table.barcode).where(sql`${table.barcode} IS NOT NULL`),
  parentSkuIdx: index("skuvault_products_parent_sku_idx").on(table.parentSku).where(sql`${table.parentSku} IS NOT NULL`),
}));

export const insertSkuvaultProductSchema = createInsertSchema(skuvaultProducts).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSkuvaultProduct = z.infer<typeof insertSkuvaultProductSchema>;
export type SkuvaultProduct = typeof skuvaultProducts.$inferSelect;

// ============================================================================
// EXCLUDED EXPLOSION SKUS (SKUs to exclude from QC explosion processing)
// ============================================================================

/**
 * Excluded Explosion SKUs - SKUs that should be filtered out during QC item hydration
 * 
 * These are typically "build" SKUs (BUILDBAG, BUILDBOX, BUILDJAS) that represent
 * instructions or packaging materials rather than actual products to be picked.
 * 
 * When the QC Item Hydrator processes a shipment, it will skip any items with
 * SKUs that appear in this table.
 */
export const excludedExplosionSkus = pgTable("excluded_explosion_skus", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  reason: text("reason"), // Optional reason for exclusion (e.g., "Build instruction SKU")
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"), // Email of user who added the exclusion (no FK to allow any OAuth user)
}, (table) => ({
  skuIdx: index("excluded_explosion_skus_sku_idx").on(table.sku),
}));

export const insertExcludedExplosionSkuSchema = createInsertSchema(excludedExplosionSkus).omit({
  id: true,
  createdAt: true,
});

export type InsertExcludedExplosionSku = z.infer<typeof insertExcludedExplosionSkuSchema>;
export type ExcludedExplosionSku = typeof excludedExplosionSkus.$inferSelect;

// ============================================================================
// SMART CARRIER RATE ANALYSIS (Cost Optimization)
// ============================================================================

/**
 * Shipment Rate Analysis Table
 * 
 * Stores the results of smart carrier rate checking for cost optimization.
 * Uses shipment_id (ShipStation ID like "se-1111111") as primary key for
 * easy joins with the main shipments table.
 * 
 * This enables reporting on:
 * - Total potential cost savings across all shipments
 * - Which carrier/service combos are most cost-effective from OKC
 * - Comparison of customer-selected vs optimal shipping methods
 */
export const shipmentRateAnalysis = pgTable("shipment_rate_analysis", {
  // Primary key: ShipStation shipment ID (e.g., "se-1111111")
  shipmentId: text("shipment_id").primaryKey(),
  
  // Customer's original selection
  customerShippingMethod: text("customer_shipping_method"), // e.g., "ups_ground"
  customerShippingCost: numeric("customer_shipping_cost", { precision: 10, scale: 2 }),
  customerDeliveryDays: integer("customer_delivery_days"),
  
  // Smart recommendation (cost-effective alternative that meets delivery requirements)
  smartShippingMethod: text("smart_shipping_method"), // e.g., "fedex_ground"
  smartShippingCost: numeric("smart_shipping_cost", { precision: 10, scale: 2 }),
  smartDeliveryDays: integer("smart_delivery_days"),
  
  // Savings calculation
  costSavings: numeric("cost_savings", { precision: 10, scale: 2 }), // customer_cost - smart_cost
  
  // Human-readable explanation
  reasoning: text("reasoning"), // e.g., "FedEx Ground saves $2.45 vs UPS Ground with same 3-day delivery"
  
  // Analysis metadata
  ratesComparedCount: integer("rates_compared_count"), // How many rates were evaluated
  carrierCode: text("carrier_code"), // Smart method's carrier (e.g., "fedex", "ups", "usps")
  serviceCode: text("service_code"), // Smart method's service code
  
  // Origin/destination context (for pattern analysis)
  originPostalCode: text("origin_postal_code").notNull().default("73108"), // Jerky.com fulfillment center
  destinationPostalCode: text("destination_postal_code"),
  destinationState: text("destination_state"),
  
  // Package details source tracking
  // When true: Used ShipStation fallback package data (needs re-analysis when package assigned)
  // When false: Used fingerprint's assigned package data (accurate, no re-analysis needed)
  usedFallbackPackageDetails: boolean("used_fallback_package_details").notNull().default(true),
  
  // Package dimensions used for rate calculation (for debugging/audit)
  packageWeightOz: numeric("package_weight_oz", { precision: 10, scale: 2 }),
  packageLengthIn: numeric("package_length_in", { precision: 6, scale: 2 }),
  packageWidthIn: numeric("package_width_in", { precision: 6, scale: 2 }),
  packageHeightIn: numeric("package_height_in", { precision: 6, scale: 2 }),
  
  // All rates checked during analysis (for validation and transparency)
  // Format: [{carrier: "usps", service: "first_class_mail", cost: 3.92, deliveryDays: 1}, ...]
  allRatesChecked: jsonb("all_rates_checked").$type<Array<{
    carrier: string;
    service: string;
    cost: number;
    deliveryDays: number | null;
  }>>(),
  
  // Tracking
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Index for savings reports
  costSavingsIdx: index("shipment_rate_analysis_cost_savings_idx").on(table.costSavings.desc().nullsLast()),
  // Index for destination pattern analysis
  destinationStateIdx: index("shipment_rate_analysis_destination_state_idx").on(table.destinationState),
  // Index for carrier comparison reports
  smartMethodIdx: index("shipment_rate_analysis_smart_method_idx").on(table.smartShippingMethod),
  // Index for time-based queries
  createdAtIdx: index("shipment_rate_analysis_created_at_idx").on(table.createdAt.desc()),
}));

export const insertShipmentRateAnalysisSchema = createInsertSchema(shipmentRateAnalysis).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertShipmentRateAnalysis = z.infer<typeof insertShipmentRateAnalysisSchema>;
export type ShipmentRateAnalysis = typeof shipmentRateAnalysis.$inferSelect;

// Rate Analysis Jobs - Background jobs for backfilling rate analysis on historical shipments
// These jobs run in the background and can survive page changes/logouts
export const rateAnalysisJobs = pgTable("rate_analysis_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  preset: text("preset").notNull(), // '1day', '7days', '30days', '90days', 'all'
  daysBack: integer("days_back"), // null for 'all time'
  status: text("status").notNull().default("pending"), // pending, running, completed, failed, cancelled
  shipmentsTotal: integer("shipments_total").notNull().default(0),
  shipmentsAnalyzed: integer("shipments_analyzed").notNull().default(0),
  shipmentsFailed: integer("shipments_failed").notNull().default(0),
  savingsFound: numeric("savings_found").default("0"), // Total potential savings found
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("rate_analysis_jobs_status_idx").on(table.status),
  createdAtIdx: index("rate_analysis_jobs_created_at_idx").on(table.createdAt.desc().nullsLast()),
}));

export const insertRateAnalysisJobSchema = createInsertSchema(rateAnalysisJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRateAnalysisJob = z.infer<typeof insertRateAnalysisJobSchema>;
export type RateAnalysisJob = typeof rateAnalysisJobs.$inferSelect;

// Lifecycle Repair Jobs - Background jobs for fixing stale lifecycle phases
// These jobs run in the background and can survive page changes/logouts
export const lifecycleRepairJobs = pgTable("lifecycle_repair_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  status: text("status").notNull().default("pending"), // pending, running, completed, failed, cancelled
  shipmentsTotal: integer("shipments_total").notNull().default(0),
  shipmentsRepaired: integer("shipments_repaired").notNull().default(0),
  shipmentsFailed: integer("shipments_failed").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  statusIdx: index("lifecycle_repair_jobs_status_idx").on(table.status),
  createdAtIdx: index("lifecycle_repair_jobs_created_at_idx").on(table.createdAt.desc().nullsLast()),
}));

export const insertLifecycleRepairJobSchema = createInsertSchema(lifecycleRepairJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLifecycleRepairJob = z.infer<typeof insertLifecycleRepairJobSchema>;
export type LifecycleRepairJob = typeof lifecycleRepairJobs.$inferSelect;

// Feature Flags - Runtime-toggleable feature switches for operations control
export const featureFlags = pgTable("feature_flags", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (table) => ({
  keyIdx: index("feature_flags_key_idx").on(table.key),
}));

export const insertFeatureFlagSchema = createInsertSchema(featureFlags).omit({
  id: true,
  updatedAt: true,
});

export type InsertFeatureFlag = z.infer<typeof insertFeatureFlagSchema>;
export type FeatureFlag = typeof featureFlags.$inferSelect;

// Customer Shipping Methods - Configuration for rate checking and assignment permissions
// Each unique customer_shipping_method from shipments gets an entry here
export const customerShippingMethods = pgTable("customer_shipping_methods", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(), // The customer_shipping_method value (e.g., "ups_ground")
  allowRateCheck: boolean("allow_rate_check").notNull().default(true), // Whether rate checker runs on shipments with this method
  allowChange: boolean("allow_change").notNull().default(true), // Whether rate checker can change the shipping method (if false, keeps customer's choice)
  minAllowedWeight: numeric("min_allowed_weight", { precision: 10, scale: 2 }), // Minimum weight in oz (nullable = no limit)
  maxAllowedWeight: numeric("max_allowed_weight", { precision: 10, scale: 2 }), // Maximum weight in oz (nullable = no limit)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"), // User who last modified this record
}, (table) => ({
  nameIdx: index("customer_shipping_methods_name_idx").on(table.name),
}));

export const insertCustomerShippingMethodSchema = createInsertSchema(customerShippingMethods).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCustomerShippingMethod = z.infer<typeof insertCustomerShippingMethodSchema>;
export type CustomerShippingMethod = typeof customerShippingMethods.$inferSelect;

// Rate Check Shipping Methods - Candidate shipping methods from rate checker analysis
// Each unique smart_shipping_method from shipment_rate_analysis gets an entry here
export const rateCheckShippingMethods = pgTable("rate_check_shipping_methods", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  allowRateCheck: boolean("allow_rate_check").notNull().default(true),
  minAllowedWeight: numeric("min_allowed_weight", { precision: 10, scale: 2 }),
  maxAllowedWeight: numeric("max_allowed_weight", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (table) => ({
  nameIdx: index("rate_check_shipping_methods_name_idx").on(table.name),
}));

export const insertRateCheckShippingMethodSchema = createInsertSchema(rateCheckShippingMethods).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRateCheckShippingMethod = z.infer<typeof insertRateCheckShippingMethodSchema>;
export type RateCheckShippingMethod = typeof rateCheckShippingMethods.$inferSelect;

// ShipStation Write Queue - Reliable, rate-limit-aware queue for ShipStation shipment writes
// Uses PATCH semantics: patchPayload contains only the fields that need to change
// Worker does GET (fresh state) → merge patch → PUT (full payload) to avoid staleness
export const shipstationWriteQueue = pgTable("shipstation_write_queue", {
  id: serial("id").primaryKey(),
  shipmentId: text("shipment_id").notNull(), // ShipStation shipment ID (e.g., "se-924665462")
  patchPayload: jsonb("patch_payload").notNull(), // Only the fields to change (PATCH semantics)
  reason: text("reason").notNull(), // Why this write was enqueued (e.g., "package_sync", "shipment_number_fix")
  status: text("status").notNull().default("queued"), // queued | processing | completed | failed | dead_letter
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  completedAt: timestamp("completed_at"),
  localShipmentId: text("local_shipment_id"), // Our DB shipment UUID for post-write callbacks
  callbackAction: text("callback_action"), // Optional action to run after successful write (e.g., "clear_manual_package_flag")
  orderNumber: text("order_number"), // Denormalized for correlation without joining shipments
  httpStatusCode: integer("http_status_code"), // ShipStation PUT response status code
  httpResponse: jsonb("http_response"), // ShipStation PUT response body
}, (table) => ({
  statusIdx: index("ssw_queue_status_idx").on(table.status),
  shipmentIdx: index("ssw_queue_shipment_idx").on(table.shipmentId),
  nextRetryIdx: index("ssw_queue_next_retry_idx").on(table.nextRetryAt),
  statusCreatedIdx: index("ssw_queue_status_created_idx").on(table.status, table.createdAt),
}));

export const insertShipstationWriteQueueSchema = createInsertSchema(shipstationWriteQueue).omit({
  id: true,
  createdAt: true,
});

export type InsertShipstationWriteQueue = z.infer<typeof insertShipstationWriteQueueSchema>;
export type ShipstationWriteQueue = typeof shipstationWriteQueue.$inferSelect;

export const rateCheckQueue = pgTable("rate_check_queue", {
  id: serial("id").primaryKey(),
  shipmentId: text("shipment_id").notNull(),
  localShipmentId: text("local_shipment_id").notNull(),
  orderNumber: text("order_number"),
  serviceCode: text("service_code"),
  destinationPostalCode: text("destination_postal_code"),
  status: text("status").notNull().default("queued"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  completedAt: timestamp("completed_at"),
  httpStatusCode: integer("http_status_code"),
  httpResponse: jsonb("http_response"),
}, (table) => ({
  statusIdx: index("rcq_status_idx").on(table.status),
  shipmentIdx: index("rcq_shipment_idx").on(table.shipmentId),
  nextRetryIdx: index("rcq_next_retry_idx").on(table.nextRetryAt),
  statusCreatedIdx: index("rcq_status_created_idx").on(table.status, table.createdAt),
  orderNumberIdx: index("rcq_order_number_idx").on(table.orderNumber),
}));

export const insertRateCheckQueueSchema = createInsertSchema(rateCheckQueue).omit({
  id: true,
  createdAt: true,
});

export type InsertRateCheckQueue = z.infer<typeof insertRateCheckQueueSchema>;
export type RateCheckQueue = typeof rateCheckQueue.$inferSelect;

export const qcExplosionQueue = pgTable("qc_explosion_queue", {
  id: serial("id").primaryKey(),
  shipmentId: text("shipment_id").notNull(),
  orderNumber: text("order_number"),
  status: text("status").notNull().default("queued"),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(5),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  completedAt: timestamp("completed_at"),
  itemsCreated: integer("items_created"),
  fingerprintStatus: text("fingerprint_status"),
  fingerprintIsNew: boolean("fingerprint_is_new"),
}, (table) => ({
  statusIdx: index("qceq_status_idx").on(table.status),
  shipmentIdx: index("qceq_shipment_idx").on(table.shipmentId),
  nextRetryIdx: index("qceq_next_retry_idx").on(table.nextRetryAt),
  statusCreatedIdx: index("qceq_status_created_idx").on(table.status, table.createdAt),
  orderNumberIdx: index("qceq_order_number_idx").on(table.orderNumber),
}));

export const insertQcExplosionQueueSchema = createInsertSchema(qcExplosionQueue).omit({
  id: true,
  createdAt: true,
});

export type InsertQcExplosionQueue = z.infer<typeof insertQcExplosionQueueSchema>;
export type QcExplosionQueue = typeof qcExplosionQueue.$inferSelect;

export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => users.id),
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  userNamespaceKeyIdx: uniqueIndex("user_prefs_user_ns_key_idx").on(table.userId, table.namespace, table.key),
  namespaceIdx: index("user_prefs_namespace_idx").on(table.userId, table.namespace),
}));

export const insertUserPreferenceSchema = createInsertSchema(userPreferences).omit({
  id: true,
  updatedAt: true,
});

export type InsertUserPreference = z.infer<typeof insertUserPreferenceSchema>;
export type UserPreference = typeof userPreferences.$inferSelect;

export const chartNotes = pgTable("chart_notes", {
  id: serial("id").primaryKey(),
  chartType: varchar("chart_type", { length: 50 }).notNull(),
  noteDate: varchar("note_date", { length: 10 }).notNull(),
  content: text("content").notNull(),
  authorEmail: varchar("author_email", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  chartTypeDateIdx: index("chart_notes_type_date_idx").on(table.chartType, table.noteDate),
}));

export const insertChartNoteSchema = createInsertSchema(chartNotes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChartNote = z.infer<typeof insertChartNoteSchema>;
export type ChartNote = typeof chartNotes.$inferSelect;

export const salesForecasting = pgTable("sales_forecasting", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 255 }).notNull(),
  orderDate: timestamp("order_date").notNull(),
  salesChannel: varchar("sales_channel", { length: 255 }).notNull(),
  dailySalesQuantity: numeric("daily_sales_quantity"),
  dailySalesRevenue: numeric("daily_sales_revenue"),
  kitDailySalesQuantity: numeric("kit_daily_sales_quantity"),
  kitDailySalesRevenue: numeric("kit_daily_sales_revenue"),
  yoyDailySalesQuantity: numeric("yoy_daily_sales_quantity"),
  yoyDailySalesRevenue: numeric("yoy_daily_sales_revenue"),
  yoyKitDailySalesQuantity: numeric("yoy_kit_daily_sales_quantity"),
  yoyKitDailySalesRevenue: numeric("yoy_kit_daily_sales_revenue"),
  yoyGrowthFactor: numeric("yoy_growth_factor"),
  yoyKitGrowthFactor: numeric("yoy_kit_growth_factor"),
  trendFactor: numeric("trend_factor"),
  confidenceLevel: varchar("confidence_level", { length: 50 }),
  calculatedConfidenceFactor: numeric("calculated_confidence_factor"),
  velocity7Day: numeric("velocity_7_day"),
  velocity14Day: numeric("velocity_14_day"),
  velocity30Day: numeric("velocity_30_day"),
  sales1To14Days: numeric("sales_1_to_14_days"),
  sales15To44Days: numeric("sales_15_to_44_days"),
  sales45To74Days: numeric("sales_45_to_74_days"),
  sales75To104Days: numeric("sales_75_to_104_days"),
  eventType: varchar("event_type", { length: 255 }),
  eventDate: timestamp("event_date"),
  eventWindowSales: numeric("event_window_sales"),
  eventLyWindowSales: numeric("event_ly_window_sales"),
  isPeakSeason: boolean("is_peak_season"),
  peakSeasonName: varchar("peak_season_name", { length: 255 }),
  daysToPeak: integer("days_to_peak"),
  daysSincePeak: integer("days_since_peak"),
  peakVelocityRatio: numeric("peak_velocity_ratio"),
  velocityStabilityScore: numeric("velocity_stability_score"),
  growthPatternConfidence: numeric("growth_pattern_confidence"),
  isAssembledProduct: boolean("is_assembled_product"),
  isKit: boolean("is_kit"),
  parentSku: text("parent_sku"),
  parentKit: text("parent_kit").array(),
  category: varchar("category", { length: 255 }),
  yoyStartDate: timestamp("yoy_start_date"),
  yoyEndDate: timestamp("yoy_end_date"),
  yoyUnitsSold: numeric("yoy_units_sold"),
  yoyRevenueSold: numeric("yoy_revenue_sold"),
  yoyKitUnitsSold: numeric("yoy_kit_units_sold"),
  yoyKitRevenueSold: numeric("yoy_kit_revenue_sold"),
  kitSales1To14Days: numeric("kit_sales_1_to_14_days"),
  currDailySalesQuantity: numeric("curr_daily_sales_quantity"),
  currDailySalesRevenue: numeric("curr_daily_sales_revenue"),
  currKitDailySalesQuantity: numeric("curr_kit_daily_sales_quantity"),
  currKitDailySalesRevenue: numeric("curr_kit_daily_sales_revenue"),
  title: text("title"),
  calculationDate: timestamp("calculation_date"),
  lastUpdated: timestamp("last_updated"),
  sourceDate: varchar("source_date", { length: 10 }).notNull(),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
}, (table) => ({
  orderDateIdx: index("sales_forecasting_order_date_idx").on(table.orderDate),
  skuChannelIdx: index("sales_forecasting_sku_channel_idx").on(table.sku, table.salesChannel),
  orderDateChannelIdx: index("sales_forecasting_date_channel_idx").on(table.orderDate, table.salesChannel),
  dateChannelAssembledIdx: index("sales_forecasting_date_channel_assembled_idx").on(table.orderDate, table.salesChannel, table.isAssembledProduct),
  dateChannelCategoryIdx: index("sales_forecasting_date_channel_category_idx").on(table.orderDate, table.salesChannel, table.category),
  isPeakSeasonIdx: index("sales_forecasting_is_peak_season_idx").on(table.orderDate, table.isPeakSeason),
  eventTypeIdx: index("sales_forecasting_event_type_idx").on(table.orderDate, table.eventType),
  skuDateIdx: index("sales_forecasting_sku_date_idx").on(table.sku, table.orderDate),
}));

export type SalesForecasting = typeof salesForecasting.$inferSelect;

// ============================================================================
// PURCHASE ORDER SNAPSHOTS
// ============================================================================

/**
 * Purchase Order Snapshots - Daily inventory snapshots combining skuvault_products
 * and inventory_forecasts_daily (IFD) data from the GCP reporting database.
 * 
 * Primary key: composite (stock_check_date + sku)
 * Created on-demand when warehouse management clicks "Create Purchase Order"
 * Only enabled when IFD and internal_inventory snapshot dates match and are
 * newer than the latest local snapshot.
 */
export const purchaseOrderSnapshots = pgTable("purchase_order_snapshots", {
  id: serial("id").primaryKey(),
  stockCheckDate: timestamp("stock_check_date").notNull(),
  sku: text("sku").notNull(),
  // -- skuvault_products fields --
  productTitle: text("product_title"),
  barcode: text("barcode"),
  productCategory: text("product_category"),
  isAssembledProduct: boolean("is_assembled_product").notNull().default(false),
  isKit: boolean("is_kit").notNull().default(false),
  unitCost: text("unit_cost"),
  productImageUrl: text("product_image_url"),
  weightValue: real("weight_value"),
  weightUnit: text("weight_unit"),
  parentSku: text("parent_sku"),
  quantityOnHand: integer("quantity_on_hand").notNull().default(0),
  availableQuantity: integer("available_quantity").notNull().default(0),
  physicalLocation: text("physical_location"),
  brand: text("brand"),
  // -- IFD-specific fields --
  supplier: text("supplier"),
  description: text("description"),
  leadTime: integer("lead_time"),
  quantityIncoming: integer("quantity_incoming"),
  extAmznInv: integer("ext_amzn_inv"),
  extWlmtInv: integer("ext_wlmt_inv"),
  totalStock: integer("total_stock"),
  quantityInKits: integer("quantity_in_kits"),
  caseCount: text("case_count"),
  moq: numeric("moq"),
  moqInfo: text("moq_info"),
  // -- metadata --
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  dateSkuIdx: index("po_snapshots_date_sku_idx").on(table.stockCheckDate, table.sku),
  stockCheckDateIdx: index("po_snapshots_stock_check_date_idx").on(table.stockCheckDate),
  skuIdx: index("po_snapshots_sku_idx").on(table.sku),
}));

export const insertPurchaseOrderSnapshotSchema = createInsertSchema(purchaseOrderSnapshots).omit({
  id: true,
  createdAt: true,
});

export type InsertPurchaseOrderSnapshot = z.infer<typeof insertPurchaseOrderSnapshotSchema>;
export type PurchaseOrderSnapshot = typeof purchaseOrderSnapshots.$inferSelect;

// ============================================================================
// Purchase Order Config - Single-row global config for the PO tab
// ============================================================================

export const purchaseOrderConfig = pgTable("purchase_order_config", {
  id: varchar("id").primaryKey().default("global"),
  activeSnapshotDate: date("active_snapshot_date"),
  projectionDate: date("projection_date"),
  velocityWindowStart: date("velocity_window_start"),
  velocityWindowEnd: date("velocity_window_end"),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
  defaultLeadTime: integer("default_lead_time"),
  safetyStockDays: integer("safety_stock_days").notNull().default(0),
  activeProjectionMethod: varchar("active_projection_method", { length: 20 }).notNull().default("yoy"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const updatePurchaseOrderConfigSchema = createInsertSchema(purchaseOrderConfig).omit({
  id: true,
  updatedAt: true,
}).partial();

export type PurchaseOrderConfig = typeof purchaseOrderConfig.$inferSelect;

// ============================================================================
// Purchase Order SKU Notes - Per-SKU markdown notes, persisted across snapshots
// ============================================================================

export const purchaseOrderSkuNotes = pgTable("purchase_order_sku_notes", {
  sku: text("sku").primaryKey(),
  notes: text("notes").notNull().default(""),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const upsertPurchaseOrderSkuNoteSchema = createInsertSchema(purchaseOrderSkuNotes);
export type PurchaseOrderSkuNote = typeof purchaseOrderSkuNotes.$inferSelect;
