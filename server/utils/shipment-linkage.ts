/**
 * Shared utility for linking tracking webhooks to orders
 * Handles shipment ID extraction and multi-tier order lookup fallback strategy
 */

import { getShipmentByShipmentId, getFulfillmentByTrackingNumber } from './shipstation-api';
import type { IStorage } from '../storage';

export interface TrackingData {
  tracking_number: string;
  label_url?: string;
  shipment_id?: string;
  carrier_code?: string;
  status_code?: string;
  status_description?: string;
  ship_date?: string;
  [key: string]: any;
}

export interface ShipmentLinkageResult {
  order: any | null;
  shipmentData: any | null;
  orderNumber: string | null;
  error: string | null;
}

/**
 * Links a tracking number to an order using multiple fallback strategies
 * Extracts shipment ID from tracking webhook, fetches shipment details, and finds the order
 */
export async function linkTrackingToOrder(
  trackingData: TrackingData,
  storage: IStorage
): Promise<ShipmentLinkageResult> {
  const trackingNumber = trackingData.tracking_number;
  
  // Try to extract shipment_id from multiple sources
  let shipmentId: string | null = null;
  
  // Method 1: Extract from label_url (supports both numeric and UUID formats)
  // Examples: "se-594045345" or "se-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  const labelUrl = trackingData.label_url;
  if (labelUrl) {
    const shipmentIdMatch = labelUrl.match(/\/labels\/(se-[a-f0-9-]+)/i);
    if (shipmentIdMatch) {
      shipmentId = shipmentIdMatch[1];
    }
  }
  
  // Method 2: Fallback to shipment_id field if present in tracking data
  if (!shipmentId && trackingData.shipment_id) {
    shipmentId = trackingData.shipment_id;
  }
  
  if (!shipmentId) {
    return {
      order: null,
      shipmentData: null,
      orderNumber: null,
      error: `Could not extract shipment_id for tracking ${trackingNumber} - no label_url or shipment_id field available`,
    };
  }
  
  try {
    // Fetch full shipment details from ShipStation
    const shipmentData = await getShipmentByShipmentId(shipmentId);
    
    if (!shipmentData) {
      return {
        order: null,
        shipmentData: null,
        orderNumber: null,
        error: `ShipStation returned null for shipment ${shipmentId}`,
      };
    }
    
    // Try to get order number from multiple sources in shipmentData
    let orderNumber = shipmentData.shipment_number || shipmentData.orderNumber;
    let order: any = null;
    
    // Method 1: If we have an order number, try to find the order
    if (orderNumber) {
      order = await storage.getOrderByOrderNumber(orderNumber);
    }
    
    // Method 2: Try using orderId directly from shipment payload
    if (!order && shipmentData.orderId) {
      order = await storage.getOrder(shipmentData.orderId.toString());
    }
    
    // Method 3: Try using orderKey from shipment payload
    if (!order && shipmentData.orderKey) {
      order = await storage.getOrder(shipmentData.orderKey);
    }
    
    // Method 4: Try external_shipment_id (format: "shopifyOrderId-lineItemId")
    if (!order && shipmentData.external_shipment_id) {
      const externalIdParts = shipmentData.external_shipment_id.split('-');
      if (externalIdParts.length >= 1) {
        const shopifyOrderId = externalIdParts[0];
        order = await storage.getOrder(shopifyOrderId);
        if (order) {
          console.log(`Found order ${order.orderNumber} via external_shipment_id for tracking ${trackingNumber}`);
        }
      }
    }
    
    // Method 5: Try fulfillment API lookup by tracking number as last resort
    if (!order) {
      try {
        const fulfillmentData = await getFulfillmentByTrackingNumber(trackingNumber);
        if (fulfillmentData?.order_number) {
          order = await storage.getOrderByOrderNumber(fulfillmentData.order_number);
          if (order) {
            console.log(`Found order ${order.orderNumber} via fulfillment API for tracking ${trackingNumber}`);
          }
        }
      } catch (fulfillmentError: any) {
        console.warn(`Fulfillment API lookup failed for ${trackingNumber}:`, fulfillmentError.message);
      }
    }
    
    if (!order) {
      return {
        order: null,
        shipmentData,
        orderNumber,
        error: `Cannot link tracking ${trackingNumber} to any order - tried shipment_number, orderId, orderKey, external_shipment_id, and fulfillment API`,
      };
    }
    
    return {
      order,
      shipmentData,
      orderNumber: order.orderNumber,
      error: null,
    };
  } catch (error: any) {
    return {
      order: null,
      shipmentData: null,
      orderNumber: null,
      error: `Failed to fetch shipment ${shipmentId} from ShipStation: ${error.message}`,
    };
  }
}
