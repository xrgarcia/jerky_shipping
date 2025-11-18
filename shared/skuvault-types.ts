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
 */
export const sessionOrderSchema = z.object({
  sale_id: z.string().nullable().optional(),
  order_number: z.string().nullable().optional(),
  spot_number: z.number().nullable().optional(),
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
 */
export const parsedDirectionSchema = z.object({
  picklist_id: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  sku_name: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  spot_number: z.number().nullable().optional(),
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
