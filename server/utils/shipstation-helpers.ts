/**
 * Shared ShipStation utility helpers.
 * These are used by both the write queue and the rate check service
 * to avoid circular dependencies.
 */

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

const READ_ONLY_FIELDS = [
  'shipment_id',
  'created_at',
  'modified_at',
  'label_id',
  'shipment_status',
  'label_status',
  'tracking_number',
  'label_download',
  'form_download',
  'insurance_claim',
];

/**
 * Strip null/empty option values from shipment items.
 * ShipStation rejects PUT payloads where items[].options[] have empty values.
 * Shopify apps (e.g. Frequently Bought Together) inject these.
 */
export function sanitizeItemOptions(payload: Record<string, any>): Record<string, any> {
  if (!payload.items || !Array.isArray(payload.items)) return payload;

  let strippedCount = 0;
  payload.items = payload.items.map((item: any) => {
    if (!item.options || !Array.isArray(item.options)) return item;
    const before = item.options.length;
    item.options = item.options.filter((opt: any) =>
      opt.value !== null && opt.value !== undefined && opt.value !== ''
    );
    strippedCount += before - item.options.length;
    return item;
  });

  if (strippedCount > 0) {
    console.log(`[shipstation-helpers] Stripped ${strippedCount} item option(s) with empty values`);
  }
  return payload;
}

/**
 * Check whether a ShipStation shipment payload has any items with dirty (null/empty) option values.
 */
function hasDirtyItemOptions(payload: Record<string, any>): boolean {
  if (!payload.items || !Array.isArray(payload.items)) return false;
  return payload.items.some((item: any) =>
    Array.isArray(item.options) &&
    item.options.some((opt: any) =>
      opt.value === null || opt.value === undefined || opt.value === ''
    )
  );
}

/**
 * GET the live ShipStation shipment, and if any item options have null/empty values,
 * strip them and PUT the cleaned payload back. This ensures the rate API can fetch
 * item details from ShipStation without 400 errors.
 *
 * @returns `{ sanitized: true }` if a PUT was performed, `{ sanitized: false }` if no changes were needed.
 */
export async function sanitizeShipmentItemOptionsIfNeeded(
  shipmentId: string
): Promise<{ sanitized: boolean }> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }

  const getUrl = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  const headers = {
    'api-key': SHIPSTATION_API_KEY,
    'Content-Type': 'application/json',
  };

  const getResponse = await fetch(getUrl, { headers });
  if (!getResponse.ok) {
    const text = await getResponse.text();
    throw new Error(`ShipStation GET shipment failed: ${getResponse.status} ${text}`);
  }

  const shipment: Record<string, any> = await getResponse.json();

  if (!hasDirtyItemOptions(shipment)) {
    return { sanitized: false };
  }

  const cleaned = { ...shipment };
  for (const field of READ_ONLY_FIELDS) {
    delete cleaned[field];
  }
  sanitizeItemOptions(cleaned);

  const putUrl = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  const putResponse = await fetch(putUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify(cleaned),
  });

  if (!putResponse.ok) {
    const text = await putResponse.text();
    throw new Error(`ShipStation PUT shipment failed: ${putResponse.status} ${text}`);
  }

  console.log(`[shipstation-helpers] Sanitized item options on shipment ${shipmentId} via PUT`);
  return { sanitized: true };
}
