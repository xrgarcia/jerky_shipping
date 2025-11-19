import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, boolean } from "drizzle-orm/pg-core";
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
  subtotalPrice: text("subtotal_price").notNull().default('0'), // Price before discounts and shipping
  currentTotalPrice: text("current_total_price").notNull().default('0'), // Total after refunds/adjustments
  currentSubtotalPrice: text("current_subtotal_price").notNull().default('0'), // Subtotal after adjustments
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
});

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
  refundedAtIdx: sql`CREATE INDEX IF NOT EXISTS order_refunds_refunded_at_idx ON ${table} (refunded_at)`,
  orderIdIdx: sql`CREATE INDEX IF NOT EXISTS order_refunds_order_id_idx ON ${table} (order_id)`,
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
  
  // Calculated/aggregated fields for easy reporting queries
  priceSetAmount: text("price_set_amount").notNull().default('0'), // Extracted shop_money.amount from price_set for easy queries
  totalDiscountSetAmount: text("total_discount_set_amount").notNull().default('0'), // Extracted shop_money.amount from total_discount_set
  totalTaxAmount: text("total_tax_amount").notNull().default('0'), // Sum of all tax_lines amounts
  preDiscountPrice: text("pre_discount_price").notNull().default('0'), // Price before any discounts (price * quantity)
  finalLinePrice: text("final_line_price").notNull().default('0'), // Final price after all discounts ((price * quantity) - total_discount)
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  orderIdIdx: sql`CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON ${table} (order_id)`,
  variantIdIdx: sql`CREATE INDEX IF NOT EXISTS order_items_variant_id_idx ON ${table} (variant_id)`,
  productIdIdx: sql`CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON ${table} (product_id)`,
  skuIdx: sql`CREATE INDEX IF NOT EXISTS order_items_sku_idx ON ${table} (sku) WHERE sku IS NOT NULL`,
  // Unique constraint: same line item ID cannot appear twice in database
  uniqueLineItemIdx: sql`CREATE UNIQUE INDEX IF NOT EXISTS order_items_shopify_line_item_id_idx ON ${table} (shopify_line_item_id)`,
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
  orderId: varchar("order_id").notNull().references(() => orders.id),
  shipmentId: text("shipment_id"), // ShipStation shipment ID
  trackingNumber: text("tracking_number"),
  carrierCode: text("carrier_code"),
  serviceCode: text("service_code"),
  status: text("status").notNull().default("pending"), // pending, shipped, in_transit, delivered, exception
  statusDescription: text("status_description"),
  labelUrl: text("label_url"),
  shipDate: timestamp("ship_date"),
  estimatedDeliveryDate: timestamp("estimated_delivery_date"),
  actualDeliveryDate: timestamp("actual_delivery_date"),
  shipmentData: jsonb("shipment_data"), // Store full ShipStation shipment payload
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertShipmentSchema = createInsertSchema(shipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  shipDate: z.coerce.date().optional().or(z.null()),
  estimatedDeliveryDate: z.coerce.date().optional().or(z.null()),
  actualDeliveryDate: z.coerce.date().optional().or(z.null()),
  shipmentId: z.string().nullish(),
  trackingNumber: z.string().nullish(),
  carrierCode: z.string().nullish(),
  serviceCode: z.string().nullish(),
  labelUrl: z.string().nullish(),
  statusDescription: z.string().nullish(),
  shipmentData: z.any().nullish(),
});

export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipments.$inferSelect;

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
  skuIdx: sql`CREATE INDEX IF NOT EXISTS product_variants_sku_idx ON ${table} (sku) WHERE deleted_at IS NULL`,
  barCodeIdx: sql`CREATE INDEX IF NOT EXISTS product_variants_bar_code_idx ON ${table} (bar_code) WHERE deleted_at IS NULL`,
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
  status: text("status").notNull().default("pending"), // pending, in_progress, completed, failed
  totalOrders: integer("total_orders").notNull().default(0),
  processedOrders: integer("processed_orders").notNull().default(0),
  failedOrders: integer("failed_orders").notNull().default(0),
  errorMessage: text("error_message"),
  lastProcessedOrderId: text("last_processed_order_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  queuedAt: timestamp("queued_at").notNull().defaultNow(),
  printedAt: timestamp("printed_at"),
});

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
  orderNumberIdx: sql`CREATE INDEX IF NOT EXISTS shipment_sync_failures_order_number_idx ON ${table} (order_number)`,
  failedAtIdx: sql`CREATE INDEX IF NOT EXISTS shipment_sync_failures_failed_at_idx ON ${table} (failed_at)`,
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
