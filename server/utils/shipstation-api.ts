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
 * Get shipments by order number with tracking numbers from labels
 * In ShipStation, shipment_number equals order_number
 */
export async function getShipmentsByOrderNumber(orderNumber: string): Promise<ShipStationShipment[]> {
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

  // Note: We skip label fetching here to improve performance
  // Most shipments during bootstrap are on_hold and don't have labels yet
  // Tracking numbers will be filled in later when tracking webhooks arrive
  return shipments;
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
