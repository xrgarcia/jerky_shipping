/**
 * ShipStation API Client
 * Uses API-Key header authentication for V2 API
 */

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

interface ShipStationShipment {
  shipmentId: number;
  orderId: number;
  orderKey: string;
  userId: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  serviceCode: string;
  shipDate: string;
  createDate: string;
  shipmentCost: number;
  insuranceCost: number;
  voided: boolean;
  voidDate: string | null;
  marketplaceNotified: boolean;
  notifyErrorMessage: string | null;
}

interface ShipStationShipmentsResponse {
  shipments: ShipStationShipment[];
  total: number;
  page: number;
  pages: number;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

export interface ApiResponseWithRateLimit<T> {
  data: T;
  rateLimit: RateLimitInfo;
}

/**
 * Extract rate limit headers from ShipStation response
 */
function extractRateLimitInfo(headers: Headers): RateLimitInfo {
  return {
    limit: parseInt(headers.get('X-Rate-Limit-Limit') || '40'),
    remaining: parseInt(headers.get('X-Rate-Limit-Remaining') || '0'),
    reset: parseInt(headers.get('X-Rate-Limit-Reset') || '60'),
  };
}

/**
 * Fetch shipments from ShipStation API using resource_url
 */
export async function fetchShipStationResource(resourceUrl: string): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // ShipStation V2 API uses api-key header (lowercase)
  const response = await fetch(resourceUrl, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get labels for a shipment to retrieve tracking numbers
 */
export async function getLabelsForShipment(shipmentId: string): Promise<any[]> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipmentId)}`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.labels || [];
}

/**
 * Create a label for a shipment
 * Returns label data including PDF URL
 */
export async function createLabel(shipmentData: any): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/labels`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      shipment: shipmentData,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ShipStation label creation failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * Get shipments by order number with tracking numbers from labels
 * In ShipStation, shipment_number equals order_number
 * Returns shipments array and rate limit info
 */
export async function getShipmentsByOrderNumber(orderNumber: string): Promise<ApiResponseWithRateLimit<ShipStationShipment[]>> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // V2 API endpoint - use shipment_number parameter (which equals order_number)
  const url = `${SHIPSTATION_API_BASE}/v2/shipments?shipment_number=${encodeURIComponent(orderNumber)}&sort_dir=desc&sort_by=created_at`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const shipments = data.shipments || [];
  const rateLimit = extractRateLimitInfo(response.headers);

  // Note: We skip label fetching here to improve performance
  // Most shipments during bootstrap are on_hold and don't have labels yet
  // Tracking numbers will be filled in later when tracking webhooks arrive
  return {
    data: shipments,
    rateLimit,
  };
}

/**
 * Get fulfillment by tracking number using V2 API
 * Returns null if fulfillment not found
 */
export async function getFulfillmentByTrackingNumber(trackingNumber: string): Promise<any | null> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  // V2 API endpoint - supports tracking_number parameter
  const url = `${SHIPSTATION_API_BASE}/v2/fulfillments?tracking_number=${encodeURIComponent(trackingNumber)}`;
  
  const response = await fetch(url, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const fulfillments = data.fulfillments || [];
  
  // Return the first matching fulfillment (there should only be one per tracking number)
  return fulfillments.length > 0 ? fulfillments[0] : null;
}

// ShipStation V2 webhook event types
export type ShipStationWebhookEvent = 
  | 'batch'
  | 'carrier_connected'
  | 'order_source_refresh_complete'
  | 'rate'
  | 'report_complete'
  | 'sales_orders_imported'
  | 'track'
  | 'batch_processed_v2'
  | 'fulfillment_rejected_v2'
  | 'fulfillment_shipped_v2'
  | 'fulfillment_created_v2'
  | 'fulfillment_canceled_v2'
  | 'fulfillment_updated_v2';

/**
 * Subscribe to ShipStation webhook (V2 API)
 */
export async function subscribeToWebhook(
  targetUrl: string,
  event: ShipStationWebhookEvent,
  friendlyName: string
): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks`, {
    method: 'POST',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: friendlyName,
      event,
      url: targetUrl,
      store_id: null, // null = all stores
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to subscribe to ShipStation webhook: ${response.status} ${errorText}`);
  }

  return response.json();
}

/**
 * List all registered webhooks
 */
export async function listWebhooks(): Promise<any[]> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks`, {
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list ShipStation webhooks: ${response.status}`);
  }

  // V2 API returns array directly, not wrapped in {webhooks: [...]}
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Unsubscribe from a webhook
 */
export async function unsubscribeWebhook(webhookId: string): Promise<void> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/v2/environment/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to unsubscribe ShipStation webhook: ${response.status}`);
  }
}
