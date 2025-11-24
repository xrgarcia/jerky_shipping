import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users table for warehouse staff
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  handle: text("handle").unique(),
  avatarUrl: text("avatar_url"),
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
  // GIN trigram indexes for ILIKE search on order numbers and customer names
  orderNumberTrigramIdx: index("orders_order_number_trgm_idx").using("gin", table.orderNumber.op("gin_trgm_ops")),
  customerNameTrigramIdx: index("orders_customer_name_trgm_idx").using("gin", table.customerName.op("gin_trgm_ops")),
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
  shipmentId: text("shipment_id"), // ShipStation shipment ID
  orderNumber: text("order_number"), // Customer-facing order number from ShipStation (e.g., "JK3825345229")
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
});

export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipments.$inferSelect;

// Shipment items table for normalized shipment line items
export const shipmentItems = pgTable("shipment_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
  orderItemId: varchar("order_item_id").references(() => orderItems.id), // Nullable - not all shipments linked to orders
  sku: text("sku"), // Product SKU
  name: text("name").notNull(), // Product name/title
  quantity: integer("quantity").notNull(), // Quantity in this shipment
  unitPrice: text("unit_price"), // Price per unit (text for consistency)
  externalOrderItemId: text("external_order_item_id"), // ShipStation's reference to Shopify line item
  imageUrl: text("image_url"), // Product image URL
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("shipment_items_shipment_id_idx").on(table.shipmentId),
  orderItemIdIdx: index("shipment_items_order_item_id_idx").on(table.orderItemId).where(sql`${table.orderItemId} IS NOT NULL`),
  skuIdx: index("shipment_items_sku_idx").on(table.sku).where(sql`${table.sku} IS NOT NULL`),
  // Index for webhook reconciliation via ShipStation's external order item ID reference
  externalOrderItemIdIdx: index("shipment_items_external_order_item_id_idx").on(table.externalOrderItemId).where(sql`${table.externalOrderItemId} IS NOT NULL`),
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

// Shipment events table for comprehensive audit trail
export const shipmentEvents = pgTable("shipment_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  username: text("username").notNull(), // Email of logged-in user
  station: text("station").notNull(), // e.g., "packing", "shipping", "receiving"
  eventName: text("event_name").notNull(), // e.g., "order_scanned", "product_scan_success"
  orderNumber: text("order_number"), // Links to shipments.order_number
  metadata: jsonb("metadata"), // Flexible JSON data for event-specific details
  skuvaultImport: boolean("skuvault_import").notNull().default(false), // True if event was imported from SkuVault PassedItems
}, (table) => ({
  occurredAtIdx: index("shipment_events_occurred_at_idx").on(table.occurredAt),
  orderNumberIdx: index("shipment_events_order_number_idx").on(table.orderNumber).where(sql`${table.orderNumber} IS NOT NULL`),
  eventNameIdx: index("shipment_events_event_name_idx").on(table.eventName),
  usernameIdx: index("shipment_events_username_idx").on(table.username),
}));

export const insertShipmentEventSchema = createInsertSchema(shipmentEvents).omit({
  id: true,
}).extend({
  occurredAt: z.coerce.date().optional(),
  metadata: z.any().nullish(),
});

export type InsertShipmentEvent = z.infer<typeof insertShipmentEventSchema>;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;

// Products table for Shopify products
export const products = pgTable("products", {
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

export const insertProductSchema = createInsertSchema(products).omit({
  createdAt: true,
  updatedAt: true,
  lastSyncedAt: true,
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// Product variants table for Shopify product variants
export const productVariants = pgTable("product_variants", {
  id: varchar("id").primaryKey(), // Shopify variant ID
  productId: varchar("product_id").notNull().references(() => products.id),
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
  skuIdx: index("product_variants_sku_idx").on(table.sku).where(sql`${table.deletedAt} IS NULL`),
  barCodeIdx: index("product_variants_bar_code_idx").on(table.barCode).where(sql`${table.deletedAt} IS NULL`),
}));

export const insertProductVariantSchema = createInsertSchema(productVariants).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertProductVariant = z.infer<typeof insertProductVariantSchema>;
export type ProductVariant = typeof productVariants.$inferSelect;

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
  orderNumber: text("order_number").notNull(),
  reason: text("reason").notNull(), // 'backfill' | 'webhook' | 'manual'
  errorMessage: text("error_message").notNull(),
  requestData: jsonb("request_data"), // Original request details
  responseData: jsonb("response_data"), // API response if available
  retryCount: integer("retry_count").notNull().default(0),
  failedAt: timestamp("failed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  orderNumberIdx: index("shipment_sync_failures_order_number_idx").on(table.orderNumber),
  failedAtIdx: index("shipment_sync_failures_failed_at_idx").on(table.failedAt),
}));

export const insertShipmentSyncFailureSchema = createInsertSchema(shipmentSyncFailures).omit({
  id: true,
  createdAt: true,
}).extend({
  requestData: z.any().nullish(),
  responseData: z.any().nullish(),
});

export type InsertShipmentSyncFailure = z.infer<typeof insertShipmentSyncFailureSchema>;
export type ShipmentSyncFailure = typeof shipmentSyncFailures.$inferSelect;

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  shipmentIdIdx: index("packing_logs_shipment_id_idx").on(table.shipmentId),
  userIdIdx: index("packing_logs_user_id_idx").on(table.userId),
  createdAtIdx: index("packing_logs_created_at_idx").on(table.createdAt),
}));

export const insertPackingLogSchema = createInsertSchema(packingLogs).omit({
  id: true,
  createdAt: true,
}).extend({
  skuVaultRawResponse: z.any().nullish(), // Allow any JSON structure from SkuVault API
});

export type InsertPackingLog = z.infer<typeof insertPackingLogSchema>;
export type PackingLog = typeof packingLogs.$inferSelect;
