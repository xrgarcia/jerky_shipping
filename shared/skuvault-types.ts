/**
 * SkuVault session data models and types
 * 
 * Ported from Python Pydantic models to TypeScript with Zod validation
 */

import { z } from "zod";

/**
 * Valid session states for SkuVault wave picking
 */
export enum SessionState {
  ACTIVE = "active",
  INACTIVE = "inactive",
  NEW = "new",
  READY_TO_SHIP = "readyToShip",
  CLOSED = "closed",
  PICKED = "picked",
  SHIPPED = "shipped",
  CANCELLED = "cancelled"
}

/**
 * Match patterns for search filters
 */
export enum MatchType {
  EXACT = "exact",
  CONTAINS = "contains"
}

/**
 * Helper to convert API status strings to SessionState enum
 */
export function parseSessionState(state: string | null | undefined): SessionState | null {
  if (!state) return null;
  
  const normalized = state.toLowerCase();
  switch (normalized) {
    case "active":
      return SessionState.ACTIVE;
    case "inactive":
      return SessionState.INACTIVE;
    case "new":
      return SessionState.NEW;
    case "readytoship":
      return SessionState.READY_TO_SHIP;
    case "closed":
      return SessionState.CLOSED;
    case "picked":
      return SessionState.PICKED;
    case "shipped":
      return SessionState.SHIPPED;
    case "cancelled":
      return SessionState.CANCELLED;
    default:
      return null;
  }
}

/**
 * User assigned to a wave picking session
 */
export const assignedUserSchema = z.object({
  name: z.string().nullable().optional(),
  userId: z.number().nullable().optional(),
});

export type AssignedUser = z.infer<typeof assignedUserSchema>;

/**
 * Raw session data from the SkuVault API
 */
export const sessionDataSchema = z.object({
  sequenceId: z.number().nullable().optional(),
  picklistId: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  assigned: assignedUserSchema.nullable().optional(),
  skuCount: z.number().nullable().optional(),
  orderCount: z.number().nullable().optional(),
  totalQuantity: z.number().nullable().optional(),
  pickedQuantity: z.number().nullable().optional(),
  availableQuantity: z.number().nullable().optional(),
  totalItemsWeight: z.number().nullable().optional(),
});

export type SessionData = z.infer<typeof sessionDataSchema>;

/**
 * Response model for the sessions API endpoint
 */
export const sessionsResponseSchema = z.object({
  lists: z.array(sessionDataSchema).nullable().optional(),
});

export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/**
 * Parsed and simplified session data for easy consumption
 */
export const parsedSessionSchema = z.object({
  sessionId: z.number().nullable().optional(),
  picklistId: z.string().nullable().optional(),
  status: z.nativeEnum(SessionState).nullable().optional(),
  createdDate: z.string().nullable().optional(),
  assignedUser: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
  skuCount: z.number().nullable().optional(),
  orderCount: z.number().nullable().optional(),
  totalQuantity: z.number().nullable().optional(),
  pickedQuantity: z.number().nullable().optional(),
  availableQuantity: z.number().nullable().optional(),
  totalWeight: z.number().nullable().optional(),
  viewUrl: z.string().nullable().optional(),
  extractedAt: z.number().nullable().optional(),
});

export type ParsedSession = z.infer<typeof parsedSessionSchema>;

/**
 * Location information for a product
 */
export const locationInfoSchema = z.object({
  warehouseId: z.number().nullable().optional(),
  warehouseCode: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  containerId: z.number().nullable().optional(),
  lotId: z.number().nullable().optional(),
  lotNumber: z.string().nullable().optional(),
  quantity: z.number().nullable().optional(),
  missing: z.boolean().nullable().optional(),
  createDate: z.string().nullable().optional(),
  expiredDate: z.string().nullable().optional(),
  firstReceivedDate: z.string().nullable().optional(),
});

export type LocationInfo = z.infer<typeof locationInfoSchema>;

/**
 * Individual item within an order
 */
export const orderItemSchema = z.object({
  productId: z.number().nullable().optional(),
  quantity: z.number().nullable().optional(),
  sku: z.string().nullable().optional(),
  partNumber: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  productPictures: z.array(z.string()).nullable().optional(),
  weightPound: z.number().nullable().optional(),
  locations: z.array(locationInfoSchema).nullable().optional(),
  location: z.string().nullable().optional(),
  available: z.number().nullable().optional(),
  picked: z.number().nullable().optional(),
  notFoundProduct: z.boolean().nullable().optional(),
  completed: z.boolean().nullable().optional(),
  isSerialized: z.boolean().nullable().optional(),
  auditStatus: z.string().nullable().optional(),
  stockStatus: z.string().nullable().optional(),
});

export type OrderItem = z.infer<typeof orderItemSchema>;

/**
 * Order information within a picklist
 */
export const orderSchema = z.object({
  id: z.string().nullable().optional(),
  spot_number: z.number().nullable().optional(), // 1-based order position in picklist
  items: z.array(orderItemSchema).nullable().optional(),
});

export type Order = z.infer<typeof orderSchema>;

/**
 * User assigned to the picklist
 */
export const picklistAssignedUserSchema = z.object({
  userId: z.number().nullable().optional(),
  name: z.string().nullable().optional(),
});

export type PicklistAssignedUser = z.infer<typeof picklistAssignedUserSchema>;

/**
 * Main picklist information
 */
export const picklistInfoSchema = z.object({
  orders: z.array(orderSchema).nullable().optional(),
  bins: z.array(z.any()).nullable().optional(),
  skipNotcountedLocation: z.boolean().nullable().optional(),
  skipSecondaryLocation: z.boolean().nullable().optional(),
  containsNFP: z.boolean().nullable().optional(),
  picklistId: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  sequenceId: z.number().nullable().optional(),
  state: z.string().nullable().optional(),
  cart: z.any().nullable().optional(),
  constrainByWarehouses: z.array(z.any()).nullable().optional(),
  skuCount: z.number().nullable().optional(),
  orderCount: z.number().nullable().optional(),
  binsCount: z.number().nullable().optional(),
  orderItems: z.number().nullable().optional(),
  orderItemsCompleted: z.number().nullable().optional(),
  availableQuantity: z.number().nullable().optional(),
  totalQuantity: z.number().nullable().optional(),
  totalItemsWeight: z.number().nullable().optional(),
  pickedQuantity: z.number().nullable().optional(),
  remainingQuantity: z.number().nullable().optional(),
  unavailableQuantity: z.number().nullable().optional(),
  assigned: picklistAssignedUserSchema.nullable().optional(),
  canAssign: z.boolean().nullable().optional(),
  canStart: z.boolean().nullable().optional(),
  canStop: z.boolean().nullable().optional(),
  canPick: z.boolean().nullable().optional(),
  canClose: z.boolean().nullable().optional(),
  canAssignCart: z.boolean().nullable().optional(),
  canComplete: z.boolean().nullable().optional(),
});

export type PicklistInfo = z.infer<typeof picklistInfoSchema>;

/**
 * Individual history item for picking actions
 */
export const historyItemSchema = z.object({
  date: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  currentBinId: z.number().nullable().optional(),
  quantity: z.number().nullable().optional(),
  productSku: z.string().nullable().optional(),
  productDescription: z.string().nullable().optional(),
  warehouseId: z.number().nullable().optional(),
  locationCode: z.string().nullable().optional(),
  containerId: z.number().nullable().optional(),
  lotId: z.number().nullable().optional(),
  saleId: z.string().nullable().optional(),
  containerDrillDown: z.any().nullable().optional(),
  code: z.string().nullable().optional(),
  partNumber: z.string().nullable().optional(),
  productPictures: z.array(z.string()).nullable().optional(),
  currentBinCode: z.string().nullable().optional(),
  spotId: z.number().nullable().optional(),
  lotNumber: z.string().nullable().optional(),
  serialNumbers: z.array(z.string()).nullable().optional(),
  isSerialized: z.boolean().nullable().optional(),
});

export type HistoryItem = z.infer<typeof historyItemSchema>;

/**
 * Complete response from the SkuVault directions API
 */
export const directionsResponseSchema = z.object({
  picklist: picklistInfoSchema.nullable().optional(),
  directions: z.array(z.any()).nullable().optional(),
  history: z.array(historyItemSchema).nullable().optional(),
});

export type DirectionsResponse = z.infer<typeof directionsResponseSchema>;

/**
 * Simplified order with only key fields for session tracking
 * 
 * spot_number: 1-based index representing the order's position in the picklist.
 * Calculated by enumerating through picklist.orders array (1st order = #1, 2nd = #2, etc.).
 * All items within the same order share the same spot number.
 */
export const sessionOrderSchema = z.object({
  sale_id: z.string().nullable().optional(),
  order_number: z.string().nullable().optional(),
  spot_number: z.number().nullable().optional(), // 1-based order position in picklist
  session_picklist_id: z.string().nullable().optional(),
  session_id: z.number().nullable().optional(),
  create_date: z.string().nullable().optional(),
  pick_start_datetime: z.string().nullable().optional(),
  pick_end_datetime: z.string().nullable().optional(),
  order_items: z.array(orderItemSchema).default([]),
  document_id: z.string().nullable().optional(),
  picked_by_user_id: z.number().nullable().optional(),
  picked_by_user_name: z.string().nullable().optional(),
  session_status: z.nativeEnum(SessionState).nullable().optional(),
  saved_custom_field_2: z.boolean().default(false),
  shipment_id: z.string().nullable().optional(),
  updated_date: z.string().nullable().optional(),
});

export type SessionOrder = z.infer<typeof sessionOrderSchema>;

/**
 * Parsed direction data for easy consumption
 * 
 * spot_number: 1-based order position in the picklist (same as SessionOrder.spot_number)
 */
export const parsedDirectionSchema = z.object({
  picklist_id: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  sku_name: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  spot_number: z.number().nullable().optional(), // 1-based order position
  bin_info: z.string().nullable().optional(),
  quantity: z.number().nullable().optional(),
  order_number: z.string().nullable().optional(),
  order_line: z.number().nullable().optional(),
  warehouse: z.string().nullable().optional(),
  zone: z.string().nullable().optional(),
  aisle: z.string().nullable().optional(),
  rack: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  extracted_at: z.number().nullable().optional(),
});

export type ParsedDirection = z.infer<typeof parsedDirectionSchema>;

/**
 * Search and filter parameters for sessions API
 */
export interface SessionFilters {
  sessionId?: number | null;
  picklistId?: string | null;
  orderNumber?: string | null;
  states?: SessionState[];
  sortDescending?: boolean;
  limit?: number;
  skip?: number;
}

/**
 * Zod schema for session filters validation
 */
export const sessionFiltersSchema = z.object({
  sessionId: z.number().nullable().optional(),
  picklistId: z.string().nullable().optional(),
  orderNumber: z.string().nullable().optional(),
  states: z.array(z.nativeEnum(SessionState)).optional(),
  sortDescending: z.boolean().optional(),
  limit: z.number().min(1).max(100).optional(),
  skip: z.number().min(0).optional(),
});

/**
 * Quality Control Types
 * Used for QC operations to validate products and mark them as inspected
 */

/**
 * Response from product lookup by code/SKU/part number
 * Used to validate scanned barcodes during QC process
 */
export const productLookupResponseSchema = z.object({
  IdItem: z.string().nullable().optional(),
  Sku: z.string().nullable().optional(),
  Code: z.string().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  Description: z.string().nullable().optional(),
  IsKit: z.boolean().nullable().optional(),
  WeightPound: z.number().nullable().optional(),
  ProductPictures: z.array(z.string()).nullable().optional(),
});

export type ProductLookupResponse = z.infer<typeof productLookupResponseSchema>;

/**
 * Request payload for marking an item as QC passed
 * Coerces Quantity to number to handle string inputs from forms
 */
export const qcPassItemRequestSchema = z.object({
  IdItem: z.string(),
  Quantity: z.coerce.number().min(1),
  IdSale: z.string().nullable().optional(), // Cached SaleId (may be null)
  OrderNumber: z.string().optional(), // Fallback for backend lookup
  Note: z.string().nullable().optional(),
  ScannedCode: z.string(),
  SerialNumber: z.string().nullable().optional().default(""),
});

export type QCPassItemRequest = z.infer<typeof qcPassItemRequestSchema>;

/**
 * Request payload for marking a kit component as QC passed
 * Used when scanning components of a kit/assembled product
 * Endpoint: POST /sales/QualityControl/passKitSaleItem
 */
export const qcPassKitSaleItemRequestSchema = z.object({
  KitId: z.string(),              // Parent kit's product ID
  IdItem: z.string(),             // Component item's product ID
  Quantity: z.coerce.number().min(1),
  IdSale: z.string().nullable().optional(), // Cached SaleId (may be null)
  OrderNumber: z.string().optional(), // Fallback for backend lookup
  Note: z.string().nullable().optional(),
  ScannedCode: z.string(),
  SerialNumber: z.string().nullable().optional().default(""),
});

export type QCPassKitSaleItemRequest = z.infer<typeof qcPassKitSaleItemRequestSchema>;

/**
 * Response from QC pass item endpoint
 * SkuVault returns: {"Data": null, "Errors": [], "Success": true}
 */
export const qcPassItemResponseSchema = z.object({
  Success: z.boolean().nullable().optional(),
  Data: z.any().nullable().optional(),
  Errors: z.array(z.string()).nullable().optional(),
});

export type QCPassItemResponse = z.infer<typeof qcPassItemResponseSchema>;

/**
 * Response from getPickedQuantityForProductBySaleId endpoint
 * Returns how many units of a product have been picked/QC'd in SkuVault for a sale
 * SkuVault returns: {"Errors": [], "Messages": [], "Data": 0, "Status": "Blank"}
 */
export const pickedQuantityResponseSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: z.number().nullable().optional(), // Number of units already picked in SkuVault
  Status: z.string().nullable().optional(),
});

export type PickedQuantityResponse = z.infer<typeof pickedQuantityResponseSchema>;

/**
 * Sale item within a SkuVault sale
 */
export const saleItemSchema = z.object({
  Code: z.string().nullable().optional(),
  Sku: z.string().nullable().optional(),
  FnSku: z.string().nullable().optional(),
  LotNumbers: z.any().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  Quantity: z.number().nullable().optional(),
  PassedStatus: z.string().nullable().optional(),
  UnitPrice: z.object({
    a: z.number().nullable().optional(),
    s: z.string().nullable().optional(),
  }).nullable().optional(),
  Id: z.string().nullable().optional(),
  Picture: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
});

export type SaleItem = z.infer<typeof saleItemSchema>;

/**
 * Sale information from SkuVault
 * Response from /sales/Sale/getSaleInformation?Id={SaleId}
 */
export const saleInformationSchema = z.object({
  SaleId: z.string().nullable().optional(),
  AccountId: z.string().nullable().optional(),
  Source: z.string().nullable().optional(),
  Channel: z.string().nullable().optional(),
  MarketplaceId: z.string().nullable().optional(),
  OrderId: z.string().nullable().optional(), // Contains order number (e.g., "138162-JK3825346033")
  Status: z.string().nullable().optional(),
  PassedStatus: z.string().nullable().optional(),
  Items: z.array(saleItemSchema).nullable().optional(),
});

export type SaleInformation = z.infer<typeof saleInformationSchema>;

/**
 * Response wrapper for sale information endpoint
 * SkuVault returns: {"Errors": [], "Messages": [], "Data": {...}}
 */
export const saleInformationResponseSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: saleInformationSchema.nullable().optional(),
});

export type SaleInformationResponse = z.infer<typeof saleInformationResponseSchema>;

/**
 * Quality Control Sales Types
 * Used for the getQCSales endpoint to fetch orders and their QC status
 */

/**
 * Item that has already been QC'd and passed in SkuVault
 */
export const qcPassedItemSchema = z.object({
  KitId: z.union([z.string(), z.number()]).nullable().optional(), // Can be string or number from SkuVault API
  Code: z.string().nullable().optional(), // Barcode
  ScannedCode: z.string().nullable().optional(),
  LotNumber: z.string().nullable().optional(),
  Sku: z.string().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  Quantity: z.number().nullable().optional(),
  Picture: z.string().nullable().optional(),
  DateTimeUtc: z.string().nullable().optional(), // When it was scanned (may be "0001-01-01T00:00:00.0000000Z" placeholder)
  ItemId: z.string().nullable().optional(), // SkuVault Item ID
  UserId: z.string().nullable().optional(),
  UserName: z.string().nullable().optional(),
  OperationType: z.string().nullable().optional(),
  Note: z.string().nullable().optional(),
  FailReasonName: z.string().nullable().optional(),
  PassFail: z.string().nullable().optional(), // "Passed"
  SerialNumbers: z.array(z.string()).nullable().optional(),
});

export type QCPassedItem = z.infer<typeof qcPassedItemSchema>;

/**
 * Item that failed QC in SkuVault (same structure as PassedItem)
 */
export const qcFailedItemSchema = qcPassedItemSchema;
export type QCFailedItem = z.infer<typeof qcFailedItemSchema>;

/**
 * Alternate SKU reference (e.g., for products with multiple SKUs)
 */
export const alternateSkuSchema = z.object({
  Sku: z.string().nullable().optional(),
});

export type AlternateSku = z.infer<typeof alternateSkuSchema>;

/**
 * Kit component product - an individual item within a kit
 * Contains barcode (Code), SKU, quantity, and other scannable product info
 */
export const kitProductSchema = z.object({
  Sku: z.string().nullable().optional(),
  Code: z.string().nullable().optional(), // Barcode for this component
  PartNumber: z.string().nullable().optional(),
  Quantity: z.number().nullable().optional(), // How many of this component in the kit
  Title: z.string().nullable().optional(),
  Picture: z.string().nullable().optional(),
  Id: z.string().nullable().optional(),
});

export type KitProduct = z.infer<typeof kitProductSchema>;

/**
 * Expected item in the order (not yet scanned or in progress)
 * Now includes kit-related fields for proper kit handling
 */
export const qcExpectedItemSchema = z.object({
  Code: z.string().nullable().optional(), // Barcode
  Sku: z.string().nullable().optional(),
  FnSku: z.string().nullable().optional(),
  LotNumbers: z.array(z.string()).nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  Quantity: z.number().nullable().optional(),
  PassedStatus: z.string().nullable().optional(), // "Undefined", "Passed", etc.
  UnitPrice: z.object({
    a: z.number().nullable().optional(),
    s: z.string().nullable().optional(), // Currency symbol
  }).nullable().optional(),
  Id: z.string().nullable().optional(), // SkuVault Item ID
  Picture: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  // Kit-related fields
  IsKit: z.boolean().nullable().optional(), // true if this item is a kit
  KitLines: z.any().nullable().optional(), // Kit line information
  KitProducts: z.array(kitProductSchema).nullable().optional(), // Component products in the kit
  AllKitItemsAndSubstitutes: z.array(z.string()).nullable().optional(), // SKUs of all kit components
  AlternateCodes: z.array(z.union([z.string(), z.object({}).passthrough()])).nullable().optional(), // Alternative barcodes (can be strings or objects)
  AlternateSkus: z.array(alternateSkuSchema).nullable().optional(), // Alternative SKUs
  // Additional status fields
  Locations: z.array(z.any()).nullable().optional(),
  IsFulfilled: z.boolean().nullable().optional(),
  IsDeleted: z.boolean().nullable().optional(),
  IsNonAssignabled: z.boolean().nullable().optional(),
  IsSerialized: z.boolean().nullable().optional(),
  IsLotted: z.boolean().nullable().optional(),
});

export type QCExpectedItem = z.infer<typeof qcExpectedItemSchema>;

/**
 * A single QC Sale (order) with its items and status
 */
export const qcSaleSchema = z.object({
  TotalItems: z.number().nullable().optional(),
  Status: z.string().nullable().optional(), // "Completed", "In Progress", etc.
  SaleId: z.string().nullable().optional(), // e.g., "1-352444-5-13038-138162-JK3825346033"
  OrderId: z.string().nullable().optional(), // e.g., "138162-JK3825346033"
  AccountId: z.string().nullable().optional(),
  SaleDate: z.string().nullable().optional(), // ISO timestamp
  ContainsNFProducts: z.boolean().nullable().optional(),
  AllItemsPassedExceptNFP: z.boolean().nullable().optional(),
  isSingleWarehouse: z.boolean().nullable().optional(),
  isTransferSale: z.boolean().nullable().optional(),
  PassedItems: z.array(qcPassedItemSchema).nullable().optional(),
  FailedItems: z.array(qcFailedItemSchema).nullable().optional(),
  Items: z.array(qcExpectedItemSchema).nullable().optional(), // All expected items
});

export type QCSale = z.infer<typeof qcSaleSchema>;

/**
 * Data payload from getQCSales response
 */
export const qcSalesDataSchema = z.object({
  MergeBinsFlag: z.boolean().nullable().optional(),
  QcSales: z.array(qcSaleSchema).nullable().optional(),
});

export type QCSalesData = z.infer<typeof qcSalesDataSchema>;

/**
 * Response wrapper for getQCSales endpoint
 * SkuVault returns: {"Errors": [], "Messages": [], "Data": {...}}
 */
export const qcSalesResponseSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: qcSalesDataSchema.nullable().optional(),
});

export type QCSalesResponse = z.infer<typeof qcSalesResponseSchema>;

/**
 * =============================================================================
 * Product Lookup Types (getProductOrKitByCodeOrSkuOrPartNumber endpoint)
 * =============================================================================
 * 
 * These types represent the full response from the product lookup endpoint,
 * which is called when scanning barcodes during QC to identify the product.
 * 
 * Uses a discriminated union pattern to differentiate between:
 * - Individual products (IsKit=false, IsAssembledProduct=false)
 * - Kit products (IsKit=true) - bundles of components
 * - Assembled products (IsAssembledProduct=true) - similar to kits but assembled
 * 
 * TODO (Ray): Ask warehouse manager to clarify the differences between kits
 * and assembled products for proper handling in the packing workflow.
 */

/**
 * Product type discriminator
 * Used to explicitly categorize products for type-safe branching
 */
export type ProductType = 'individual' | 'kit' | 'assembledProduct';

/**
 * Supplier information for a product
 */
export const productSupplierSchema = z.object({
  Id: z.string().nullable().optional(),
  Name: z.string().nullable().optional(),
  Cost: z.number().nullable().optional(),
  LeadTime: z.number().nullable().optional(),
  IsLeadTimeUsesGlobalValue: z.boolean().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  Active: z.boolean().nullable().optional(),
});

export type ProductSupplier = z.infer<typeof productSupplierSchema>;

/**
 * Currency/price value structure from SkuVault
 */
export const priceValueSchema = z.object({
  a: z.number().nullable().optional(), // Amount
  s: z.string().nullable().optional(), // Currency symbol (e.g., "$")
});

export type PriceValue = z.infer<typeof priceValueSchema>;

/**
 * Product picture from SkuVault
 */
export const productPictureSchema = z.object({
  Url: z.string().nullable().optional(),
});

export type ProductPicture = z.infer<typeof productPictureSchema>;

/**
 * Base product fields shared by all product types
 * These fields are present regardless of whether the product is
 * an individual item, kit, or assembled product.
 */
export const baseProductDataSchema = z.object({
  Id: z.string().nullable().optional(),
  Code: z.string().nullable().optional(), // Barcode
  Sku: z.string().nullable().optional(),
  SkuJson: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  TitleJson: z.string().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  
  Classification: z.object({
    Id: z.string().nullable().optional(),
    Name: z.string().nullable().optional(),
  }).nullable().optional(),
  ClassificationId: z.string().nullable().optional(),
  ClassificationName: z.string().nullable().optional(),
  
  BrandId: z.string().nullable().optional(),
  BrandName: z.string().nullable().optional(),
  
  PrimarySupplier: productSupplierSchema.nullable().optional(),
  SupplierId: z.string().nullable().optional(),
  Suppliers: z.array(productSupplierSchema).nullable().optional(),
  SupplierNames: z.array(z.string().nullable()).nullable().optional(),
  
  Cost: priceValueSchema.nullable().optional(),
  SalePrice: priceValueSchema.nullable().optional(),
  RetailPrice: priceValueSchema.nullable().optional(),
  
  Weight: z.any().nullable().optional(),
  WeightValue: z.number().nullable().optional(),
  WeightUnit: z.string().nullable().optional(),
  
  ReorderPoint: z.number().nullable().optional(),
  IncrementalQuantity: z.number().nullable().optional(),
  
  // Inventory quantities (global, not order-specific)
  QuantityOnHand: z.number().nullable().optional(),
  QuantityOnHandCase: z.number().nullable().optional(),
  QuantityPending: z.number().nullable().optional(),
  IncomingQuantity: z.number().nullable().optional(),
  QuantityAvailable: z.number().nullable().optional(),
  ExternalQuantityAvailable: z.number().nullable().optional(),
  PickedQuantity: z.number().nullable().optional(),
  PickedQuantityCase: z.number().nullable().optional(),
  TotalQuantity: z.number().nullable().optional(),
  TotalCaseQuantity: z.number().nullable().optional(),
  TotalNotCountedQuantity: z.number().nullable().optional(),
  TotalSecondaryQuantity: z.number().nullable().optional(),
  TotalSecondaryCaseQuantity: z.number().nullable().optional(),
  TotalCountedCaseQuantity: z.number().nullable().optional(),
  TotalNotCountedCaseQuantity: z.number().nullable().optional(),
  TotalQuantityOnHold: z.number().nullable().optional(),
  TotalQuantityCasedOnHold: z.number().nullable().optional(),
  
  CreateDate: z.string().nullable().optional(),
  ModifiedDate: z.string().nullable().optional(),
  
  FbaInventory: z.any().nullable().optional(),
  WfsInventory: z.any().nullable().optional(),
  
  Attributes: z.array(z.any()).nullable().optional(),
  Pictures: z.array(productPictureSchema).nullable().optional(),
  WeightUnits: z.array(z.any()).nullable().optional(),
  AlternateCodes: z.array(z.union([z.string(), z.object({}).passthrough()])).nullable().optional(), // Can be strings or objects
  AlternateSkus: z.array(z.any()).nullable().optional(),
  
  // Product type flags - used to determine ProductType
  IsKit: z.boolean().nullable().optional(),
  IsAssembledProduct: z.boolean().nullable().optional(),
  IsCasePack: z.boolean().nullable().optional(),
  IsQuickCreation: z.boolean().nullable().optional(),
  
  CorrespondingKitQuantity: z.number().nullable().optional(),
  MinimumOrderQuantity: z.any().nullable().optional(),
  MinimumOrderQuantityInfo: z.any().nullable().optional(),
  
  Note: z.string().nullable().optional(),
  StatusesIds: z.array(z.any()).nullable().optional(),
  StatusesNames: z.array(z.string()).nullable().optional(),
  LongDescription: z.string().nullable().optional(),
  ShortDescription: z.string().nullable().optional(),
  VariationParentSku: z.string().nullable().optional(),
  DontSendQty: z.boolean().nullable().optional(),
  CountAmazonChannelAccounts: z.number().nullable().optional(),
  ExternalInventory: z.any().nullable().optional(),
  
  // TODO (Ray): Ask warehouse manager about these serialization/lot fields.
  // We don't fully understand when IsSerialized or IsLotted would be true
  // and what additional validation that requires during QC scanning.
  IsSerialized: z.boolean().nullable().optional(),
  IsFoundBySerialNumber: z.boolean().nullable().optional(),
  IsLotted: z.boolean().nullable().optional(),
  LotScanned: z.boolean().nullable().optional(),
  LotPrioritySetting: z.string().nullable().optional(), // e.g., "Global"
  LotPriorities: z.array(z.any()).nullable().optional(),
  
  ClientId: z.string().nullable().optional(),
  ClientName: z.string().nullable().optional(),
  
  // FN SKU info (Amazon FBA)
  FnSkuInfo: z.any().nullable().optional(),
});

export type BaseProductData = z.infer<typeof baseProductDataSchema>;

/**
 * API response envelope for product lookup
 * SkuVault returns: {"Errors": [], "Messages": [], "Data": {...}, "Status": "Data"}
 * Note: Response is prefixed with anti-XSSI token )]}'
 */
export const productLookupEnvelopeSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: baseProductDataSchema.nullable().optional(),
  Status: z.string().nullable().optional(), // "Data", "Blank", etc.
});

export type ProductLookupEnvelope = z.infer<typeof productLookupEnvelopeSchema>;

/**
 * Determine the product type from raw API flags
 * Kit and AssembledProduct are mutually exclusive based on SkuVault's design
 */
export function determineProductType(data: BaseProductData | null): ProductType {
  if (!data) return 'individual';
  if (data.IsKit) return 'kit';
  if (data.IsAssembledProduct) return 'assembledProduct';
  return 'individual';
}

/**
 * Individual product (not a kit or assembled product)
 */
export interface IndividualProductDetails {
  productType: 'individual';
  id: string;
  sku: string;
  code: string | null;
  partNumber: string | null;
  title: string;
  pictures: string[];
  weightValue: number | null;
  weightUnit: string | null;
  quantityAvailable: number;
  isSerialized: boolean;
  isLotted: boolean;
  rawData: BaseProductData;
}

/**
 * Kit product - contains multiple component products
 * When scanned, each component must be verified individually
 * 
 * TODO: Add kitComponents array once we understand the response
 * structure when looking up a kit product specifically
 */
export interface KitProductDetails {
  productType: 'kit';
  id: string;
  sku: string;
  code: string | null;
  partNumber: string | null;
  title: string;
  pictures: string[];
  weightValue: number | null;
  weightUnit: string | null;
  quantityAvailable: number;
  isSerialized: boolean;
  isLotted: boolean;
  correspondingKitQuantity: number;
  rawData: BaseProductData;
}

/**
 * Assembled product - similar to kit but with differences
 * 
 * TODO (Ray): Ask warehouse manager to clarify:
 * 1. How is an assembled product different from a kit in practice?
 * 2. Does scanning behavior differ for assembled products?
 * 3. Are components pre-assembled or assembled at pack time?
 */
export interface AssembledProductDetails {
  productType: 'assembledProduct';
  id: string;
  sku: string;
  code: string | null;
  partNumber: string | null;
  title: string;
  pictures: string[];
  weightValue: number | null;
  weightUnit: string | null;
  quantityAvailable: number;
  isSerialized: boolean;
  isLotted: boolean;
  rawData: BaseProductData;
}

/**
 * Discriminated union of all product types
 * Use productType field to narrow the type in TypeScript
 * 
 * @example
 * ```typescript
 * function handleProduct(product: ProductDetails) {
 *   switch (product.productType) {
 *     case 'individual':
 *       // Handle regular item
 *       break;
 *     case 'kit':
 *       // Handle kit with components
 *       break;
 *     case 'assembledProduct':
 *       // Handle assembled product
 *       break;
 *   }
 * }
 * ```
 */
export type ProductDetails = IndividualProductDetails | KitProductDetails | AssembledProductDetails;

/**
 * Transform raw API response into typed ProductDetails
 * Normalizes the SkuVault response into our discriminated union
 */
export function transformProductLookup(envelope: ProductLookupEnvelope): ProductDetails | null {
  const data = envelope.Data;
  if (!data || !data.Id) {
    return null;
  }

  const productType = determineProductType(data);
  const pictures = data.Pictures?.map(p => p.Url).filter((url): url is string => !!url) || [];

  const baseFields = {
    id: data.Id,
    sku: data.Sku || '',
    code: data.Code || null,
    partNumber: data.PartNumber || null,
    title: data.Title || '',
    pictures,
    weightValue: data.WeightValue || null,
    weightUnit: data.WeightUnit || null,
    quantityAvailable: data.QuantityAvailable || 0,
    isSerialized: data.IsSerialized || false,
    isLotted: data.IsLotted || false,
    rawData: data,
  };

  switch (productType) {
    case 'kit':
      return {
        ...baseFields,
        productType: 'kit',
        correspondingKitQuantity: data.CorrespondingKitQuantity || 0,
      };
    case 'assembledProduct':
      return {
        ...baseFields,
        productType: 'assembledProduct',
      };
    default:
      return {
        ...baseFields,
        productType: 'individual',
      };
  }
}

/**
 * =============================================================================
 * Inventory By Brand Types (getInventoryByBrandAndWarehouse endpoint)
 * =============================================================================
 * 
 * These types represent the response from the inventory lookup endpoint,
 * which is called to search/filter SkuVault's product catalog by brand.
 * 
 * Endpoint: GET /inventory/item/getInventoryByBrandAndWarehouse
 * Query params: Brand={brandName}&WarehouseCode={code}
 * WarehouseCode=-1 means all warehouses
 */

/**
 * Individual inventory item from the getInventoryByBrandAndWarehouse response
 * Note: Same product can appear multiple times with different locations
 */
export const inventoryItemSchema = z.object({
  Id: z.string().nullable().optional(),
  Code: z.string().nullable().optional(), // Barcode
  Sku: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  
  // Quantities
  Quantity: z.number().nullable().optional(),
  UnlottedQuantity: z.number().nullable().optional(),
  
  // Location information
  Location: z.string().nullable().optional(),
  LocationCode: z.string().nullable().optional(),
  LocationWithWarehouseCode: z.string().nullable().optional(),
  LocationIsNotCounted: z.boolean().nullable().optional(),
  ContainerCode: z.string().nullable().optional(),
  WarehouseCode: z.string().nullable().optional(),
  
  // Cost structure (amount + currency symbol)
  Cost: priceValueSchema.nullable().optional(),
  
  // Product images
  PictureUrl: z.string().nullable().optional(),
  
  // Product flags
  IsCasePack: z.boolean().nullable().optional(),
  IsLotted: z.boolean().nullable().optional(),
  IsSerialized: z.boolean().nullable().optional(),
  
  // Additional optional fields
  Lots: z.array(z.any()).nullable().optional(),
  Suppliers: z.any().nullable().optional(),
  PrimarySupplier: z.string().nullable().optional(),
  SerialNumbers: z.any().nullable().optional(),
});

export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/**
 * Data payload from getInventoryByBrandAndWarehouse response
 * Contains summary statistics and paginated Items array
 */
export const inventoryByBrandDataSchema = z.object({
  // Summary statistics (some are returned as strings)
  ProductsWithQuantity: z.string().nullable().optional(),
  TotalLines: z.number().nullable().optional(),
  QuantityOnHand: z.string().nullable().optional(),
  PickedQuantity: z.string().nullable().optional(),
  PendingQuantity: z.string().nullable().optional(),
  HeldQuantity: z.string().nullable().optional(),
  AvailableQuantity: z.string().nullable().optional(),
  
  // Total cost with currency
  TotalCost: priceValueSchema.nullable().optional(),
  DecimalPlaces: z.number().nullable().optional(),
  CurrencyISOCode: z.string().nullable().optional(),
  
  // Search/filter info
  Term: z.string().nullable().optional(), // The brand name that was searched
  
  // Product existence check (for single product lookup scenarios)
  ProductExist: z.boolean().nullable().optional(),
  PictureUrl: z.string().nullable().optional(),
  Code: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  Sku: z.string().nullable().optional(),
  
  // Product flags (for single product lookup scenarios)
  IsCasePack: z.boolean().nullable().optional(),
  IsSerialized: z.boolean().nullable().optional(),
  IsLotted: z.boolean().nullable().optional(),
  IsFoundBySerialNumber: z.boolean().nullable().optional(),
  LotScanned: z.boolean().nullable().optional(),
  HasLots: z.boolean().nullable().optional(),
  IsLotExpired: z.boolean().nullable().optional(),
  
  // Filter options
  Classifications: z.array(z.any()).nullable().optional(),
  Brands: z.array(z.any()).nullable().optional(),
  Suppliers: z.array(z.any()).nullable().optional(),
  Warehouses: z.any().nullable().optional(),
  DisabledWarehouses: z.any().nullable().optional(),
  CurrentWarehouse: z.any().nullable().optional(),
  
  // The main inventory items array
  Items: z.array(inventoryItemSchema).nullable().optional(),
});

export type InventoryByBrandData = z.infer<typeof inventoryByBrandDataSchema>;

/**
 * Response wrapper for getInventoryByBrandAndWarehouse endpoint
 * SkuVault returns: {"Errors": [], "Messages": [], "Data": {...}}
 */
export const inventoryByBrandResponseSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: inventoryByBrandDataSchema.nullable().optional(),
});

export type InventoryByBrandResponse = z.infer<typeof inventoryByBrandResponseSchema>;

/**
 * Product lookup response from getProductOrKitByCodeOrSkuOrPartNumber endpoint
 * Used to look up a product by barcode/SKU/part number and get its parent SKU info
 */
export const productLookupDataSchema = z.object({
  Id: z.string().nullable().optional(),
  Code: z.string().nullable().optional(),
  Sku: z.string().nullable().optional(),
  Title: z.string().nullable().optional(),
  PartNumber: z.string().nullable().optional(),
  
  IsKit: z.boolean().nullable().optional(),
  IsAssembledProduct: z.boolean().nullable().optional(),
  IsCasePack: z.boolean().nullable().optional(),
  IsSerialized: z.boolean().nullable().optional(),
  IsLotted: z.boolean().nullable().optional(),
  
  VariationParentSku: z.string().nullable().optional(),
  
  AlternateCodes: z.array(z.string()).nullable().optional(),
  AlternateSkus: z.array(z.object({
    Sku: z.string().nullable().optional(),
  })).nullable().optional(),
  
  QuantityOnHand: z.number().nullable().optional(),
  QuantityAvailable: z.number().nullable().optional(),
  
  Pictures: z.array(z.object({
    Url: z.string().nullable().optional(),
  })).nullable().optional(),
});

export type ProductLookupData = z.infer<typeof productLookupDataSchema>;

/**
 * Response wrapper for getProductOrKitByCodeOrSkuOrPartNumber endpoint
 */
export const productLookupResponseSchema = z.object({
  Errors: z.array(z.string()).nullable().optional(),
  Messages: z.array(z.string()).nullable().optional(),
  Data: productLookupDataSchema.nullable().optional(),
  Status: z.string().nullable().optional(),
});

export type ProductLookupResponse = z.infer<typeof productLookupResponseSchema>;
