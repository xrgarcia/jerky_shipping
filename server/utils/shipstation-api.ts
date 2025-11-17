/**
 * ShipStation API Client
 * Uses API-Key header authentication for V2 API
 */

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://ssapi.shipstation.com';

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

  // ShipStation V2 API uses API-Key header
  const response = await fetch(resourceUrl, {
    headers: {
      'API-Key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ShipStation API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get shipments by order number
 */
export async function getShipmentsByOrderNumber(orderNumber: string): Promise<ShipStationShipment[]> {
  const url = `${SHIPSTATION_API_BASE}/shipments?orderNumber=${encodeURIComponent(orderNumber)}`;
  const data: ShipStationShipmentsResponse = await fetchShipStationResource(url);
  return data.shipments || [];
}

/**
 * Subscribe to ShipStation webhook
 */
export async function subscribeToWebhook(
  targetUrl: string,
  event: 'ORDER_NOTIFY' | 'SHIP_NOTIFY' | 'ITEM_ORDER_NOTIFY' | 'ITEM_SHIP_NOTIFY',
  friendlyName: string
): Promise<any> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/webhooks/subscribe`, {
    method: 'POST',
    headers: {
      'API-Key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      target_url: targetUrl,
      event,
      store_id: null, // null = all stores
      friendly_name: friendlyName,
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

  const response = await fetch(`${SHIPSTATION_API_BASE}/webhooks`, {
    headers: {
      'API-Key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list ShipStation webhooks: ${response.status}`);
  }

  const data = await response.json();
  return data.webhooks || [];
}

/**
 * Unsubscribe from a webhook
 */
export async function unsubscribeWebhook(webhookId: string): Promise<void> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const response = await fetch(`${SHIPSTATION_API_BASE}/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'API-Key': SHIPSTATION_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to unsubscribe ShipStation webhook: ${response.status}`);
  }
}
