import { Redis } from '@upstash/redis';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error('Upstash Redis credentials not configured. Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
    }

    redisClient = new Redis({
      url,
      token,
    });
  }

  return redisClient;
}

const QUEUE_KEY = 'shopify:webhooks:orders';

export async function enqueueWebhook(webhookData: any): Promise<void> {
  const redis = getRedisClient();
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  await redis.rpush(QUEUE_KEY, JSON.stringify(webhookData));
}

export async function enqueueOrderId(orderId: string, jobId?: string): Promise<void> {
  const redis = getRedisClient();
  const queueItem = {
    type: 'order-id',
    orderId,
    jobId: jobId || null,
  };
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  await redis.rpush(QUEUE_KEY, JSON.stringify(queueItem));
}

export async function dequeueWebhook(): Promise<any | null> {
  const redis = getRedisClient();
  const data = await redis.rpop(QUEUE_KEY);
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data;
  }

  return JSON.parse(data as string);
}

export async function getQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(QUEUE_KEY) || 0;
}

export async function clearQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getQueueLength();
  if (length > 0) {
    await redis.del(QUEUE_KEY);
  }
  return length;
}

// Shipment Sync Queue operations
const SHIPMENT_SYNC_QUEUE_KEY = 'shipstation:shipment-sync';
const SHIPMENT_SYNC_INFLIGHT_KEY = 'shipstation:shipment-sync:inflight';

export interface ShipmentSyncMessage {
  reason: 'backfill' | 'webhook' | 'webhook_tracking' | 'webhook_fulfillment' | 'manual';
  orderNumber?: string; // Optional: use for order-based sync
  trackingNumber?: string; // Optional: use for tracking-based sync
  labelUrl?: string; // Optional: label URL for shipment ID extraction
  shipmentId?: string; // Optional: direct shipment ID if available
  trackingData?: any; // Optional: tracking data from webhook (status, ship_date, etc.) for fast updates
  webhookData?: any; // Optional: inline webhook data to skip API calls (OPTIMIZATION)
  enqueuedAt: number;
  jobId?: string; // Optional backfill job ID for tracking
  originalWebhook?: any; // Optional: preserve original webhook payload for troubleshooting
  retryCount?: number; // Retry count to prevent infinite loops
}

/**
 * Generate a deduplication key for a shipment sync message
 * Priority: shipmentId > trackingNumber > orderNumber
 * Using shipmentId ensures per-shipment uniqueness for multi-shipment orders
 */
function getShipmentSyncDedupeKey(message: ShipmentSyncMessage): string | null {
  if (message.shipmentId) {
    return `shipment:${message.shipmentId}`;
  }
  if (message.trackingNumber) {
    return `tracking:${message.trackingNumber}`;
  }
  if (message.orderNumber) {
    return `order:${message.orderNumber}`;
  }
  return null;
}

/**
 * Enqueue a shipment sync message with deduplication
 * Returns true if enqueued, false if already in queue
 * Uses SADD's atomic return value to prevent race conditions
 */
export async function enqueueShipmentSync(message: ShipmentSyncMessage): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = getShipmentSyncDedupeKey(message);
  
  // If no dedupe key (no tracking or order number), enqueue anyway
  if (!dedupeKey) {
    // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
    await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY, JSON.stringify(message));
    return true;
  }
  
  // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
  const added = await redis.sadd(SHIPMENT_SYNC_INFLIGHT_KEY, dedupeKey);
  
  // If already existed, don't enqueue
  if (added === 0) {
    return false; // Already queued/processing
  }
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SHIPMENT_SYNC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY, JSON.stringify(message));
  return true;
}

/**
 * Enqueue multiple shipment sync messages with deduplication
 * Returns count of messages successfully enqueued (deduplicated messages are skipped)
 * Handles both in-batch duplicates and existing queue duplicates atomically
 */
export async function enqueueShipmentSyncBatch(messages: ShipmentSyncMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  
  const redis = getRedisClient();
  const toEnqueue: ShipmentSyncMessage[] = [];
  const seenKeys = new Set<string>(); // Track duplicates within this batch
  
  for (const message of messages) {
    const dedupeKey = getShipmentSyncDedupeKey(message);
    
    // If no dedupe key, always enqueue
    if (!dedupeKey) {
      toEnqueue.push(message);
      continue;
    }
    
    // Skip if already seen in this batch
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    
    // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
    const added = await redis.sadd(SHIPMENT_SYNC_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      toEnqueue.push(message);
      seenKeys.add(dedupeKey);
    }
  }
  
  if (toEnqueue.length === 0) return 0;
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SHIPMENT_SYNC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  const serialized = toEnqueue.map(msg => JSON.stringify(msg));
  await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY, ...serialized);
  
  return toEnqueue.length;
}

/**
 * Remove a shipment sync message from the in-flight set
 * Call this after processing completes (success or failure)
 */
export async function removeShipmentSyncFromInflight(message: ShipmentSyncMessage): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = getShipmentSyncDedupeKey(message);
  
  if (dedupeKey) {
    await redis.srem(SHIPMENT_SYNC_INFLIGHT_KEY, dedupeKey);
  }
}

export async function dequeueShipmentSync(): Promise<ShipmentSyncMessage | null> {
  const redis = getRedisClient();
  const data = await redis.rpop(SHIPMENT_SYNC_QUEUE_KEY);
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data as ShipmentSyncMessage;
  }

  return JSON.parse(data as string);
}

export async function dequeueShipmentSyncBatch(count: number): Promise<ShipmentSyncMessage[]> {
  const redis = getRedisClient();
  const messages: ShipmentSyncMessage[] = [];
  
  for (let i = 0; i < count; i++) {
    const data = await redis.rpop(SHIPMENT_SYNC_QUEUE_KEY);
    if (!data) break;
    
    // Handle case where Redis returns an object instead of a string
    if (typeof data === 'object') {
      messages.push(data as ShipmentSyncMessage);
    } else {
      messages.push(JSON.parse(data as string));
    }
  }
  
  return messages;
}

export async function getShipmentSyncQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(SHIPMENT_SYNC_QUEUE_KEY) || 0;
}

export async function clearShipmentSyncQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getShipmentSyncQueueLength();
  if (length > 0) {
    await redis.del(SHIPMENT_SYNC_QUEUE_KEY);
  }
  return length;
}

/**
 * Clear all in-flight shipment sync entries
 * Use this on worker startup to clear stale entries from crashed runs
 */
export async function clearShipmentSyncInflight(): Promise<number> {
  const redis = getRedisClient();
  const size = await redis.scard(SHIPMENT_SYNC_INFLIGHT_KEY) || 0;
  if (size > 0) {
    await redis.del(SHIPMENT_SYNC_INFLIGHT_KEY);
  }
  return size;
}

/**
 * Get the current size of the in-flight set (for debugging)
 */
export async function getShipmentSyncInflightSize(): Promise<number> {
  const redis = getRedisClient();
  return await redis.scard(SHIPMENT_SYNC_INFLIGHT_KEY) || 0;
}

/**
 * Get all members of the in-flight set (for debugging)
 * Returns dedupe keys like "shipment:se-123456" or "tracking:1Z..."
 */
export async function getShipmentSyncInflightMembers(): Promise<string[]> {
  const redis = getRedisClient();
  const members = await redis.smembers(SHIPMENT_SYNC_INFLIGHT_KEY);
  return members || [];
}

export async function getOldestShopifyQueueMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  const data = await redis.lindex(QUEUE_KEY, -1);
  
  if (!data) {
    return { enqueuedAt: null };
  }
  
  try {
    const parsed = typeof data === 'object' ? data : JSON.parse(data as string);
    return { enqueuedAt: parsed.enqueuedAt || parsed.receivedAt || null };
  } catch {
    return { enqueuedAt: null };
  }
}

export async function getOldestShipmentSyncQueueMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  const data = await redis.lindex(SHIPMENT_SYNC_QUEUE_KEY, -1);
  
  if (!data) {
    return { enqueuedAt: null };
  }
  
  try {
    const parsed = typeof data === 'object' ? data : JSON.parse(data as string);
    return { enqueuedAt: parsed.enqueuedAt || null };
  } catch {
    return { enqueuedAt: null };
  }
}

/**
 * Requeue shipment sync messages back to the front of the queue (FIFO order preserved)
 * Used when worker needs to stop processing due to rate limits
 */
export async function requeueShipmentSyncMessages(messages: ShipmentSyncMessage[]): Promise<void> {
  if (messages.length === 0) return;
  
  const redis = getRedisClient();
  // RPUSH adds to the end of the queue (which is the front for RPOP consumers)
  // Reverse the array to maintain FIFO order - first message should be processed first
  const serialized = messages.reverse().map(msg => JSON.stringify(msg));
  await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY, ...serialized);
}

// Shopify Order Sync Queue operations
const SHOPIFY_ORDER_SYNC_QUEUE_KEY = 'shopify:order-sync';
const SHOPIFY_ORDER_SYNC_INFLIGHT_KEY = 'shopify:order-sync:inflight';

export interface ShopifyOrderSyncMessage {
  orderNumber: string; // The order number to import from Shopify
  reason: 'shipment-webhook' | 'manual' | 'backfill'; // Why this order needs to be synced
  enqueuedAt: number;
  retryCount?: number; // Track retry attempts to prevent infinite loops
  triggeringShipmentTracking?: string; // Optional: tracking number that triggered this sync
  jobId?: string; // Optional: backfill job ID for downstream error correlation
}

/**
 * Generate a deduplication key for a Shopify order sync message
 * Uses order number to identify unique orders
 */
function getShopifyOrderSyncDedupeKey(message: ShopifyOrderSyncMessage): string {
  return `order:${message.orderNumber}`;
}

/**
 * Enqueue a Shopify order sync message with deduplication
 * Returns true if enqueued, false if already in queue
 * Uses SADD's atomic return value to prevent race conditions
 */
export async function enqueueShopifyOrderSync(message: ShopifyOrderSyncMessage): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = getShopifyOrderSyncDedupeKey(message);
  
  // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
  const added = await redis.sadd(SHOPIFY_ORDER_SYNC_INFLIGHT_KEY, dedupeKey);
  
  // If already existed, don't enqueue
  if (added === 0) {
    return false; // Already queued/processing
  }
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SHOPIFY_ORDER_SYNC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  await redis.rpush(SHOPIFY_ORDER_SYNC_QUEUE_KEY, JSON.stringify(message));
  return true;
}

/**
 * Enqueue multiple Shopify order sync messages with deduplication
 * Returns count of messages successfully enqueued (deduplicated messages are skipped)
 * Handles both in-batch duplicates and existing queue duplicates atomically
 */
export async function enqueueShopifyOrderSyncBatch(messages: ShopifyOrderSyncMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  
  const redis = getRedisClient();
  const toEnqueue: ShopifyOrderSyncMessage[] = [];
  const seenKeys = new Set<string>(); // Track duplicates within this batch
  
  for (const message of messages) {
    const dedupeKey = getShopifyOrderSyncDedupeKey(message);
    
    // Skip if already seen in this batch
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    
    // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
    const added = await redis.sadd(SHOPIFY_ORDER_SYNC_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      toEnqueue.push(message);
      seenKeys.add(dedupeKey);
    }
  }
  
  if (toEnqueue.length === 0) return 0;
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SHOPIFY_ORDER_SYNC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  const serialized = toEnqueue.map(msg => JSON.stringify(msg));
  await redis.rpush(SHOPIFY_ORDER_SYNC_QUEUE_KEY, ...serialized);
  
  return toEnqueue.length;
}

/**
 * Remove a Shopify order sync message from the in-flight set
 * Call this after processing completes (success or failure)
 */
export async function removeShopifyOrderSyncFromInflight(message: ShopifyOrderSyncMessage): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = getShopifyOrderSyncDedupeKey(message);
  await redis.srem(SHOPIFY_ORDER_SYNC_INFLIGHT_KEY, dedupeKey);
}

export async function dequeueShopifyOrderSync(): Promise<ShopifyOrderSyncMessage | null> {
  const redis = getRedisClient();
  const data = await redis.rpop(SHOPIFY_ORDER_SYNC_QUEUE_KEY);
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data as ShopifyOrderSyncMessage;
  }

  return JSON.parse(data as string);
}

export async function dequeueShopifyOrderSyncBatch(count: number): Promise<ShopifyOrderSyncMessage[]> {
  const redis = getRedisClient();
  const messages: ShopifyOrderSyncMessage[] = [];
  
  for (let i = 0; i < count; i++) {
    const data = await redis.rpop(SHOPIFY_ORDER_SYNC_QUEUE_KEY);
    if (!data) break;
    
    // Handle case where Redis returns an object instead of a string
    if (typeof data === 'object') {
      messages.push(data as ShopifyOrderSyncMessage);
    } else {
      messages.push(JSON.parse(data as string));
    }
  }
  
  return messages;
}

export async function getShopifyOrderSyncQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(SHOPIFY_ORDER_SYNC_QUEUE_KEY) || 0;
}

export async function clearShopifyOrderSyncQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getShopifyOrderSyncQueueLength();
  if (length > 0) {
    await redis.del(SHOPIFY_ORDER_SYNC_QUEUE_KEY);
  }
  return length;
}

export async function getOldestShopifyOrderSyncQueueMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  const data = await redis.lindex(SHOPIFY_ORDER_SYNC_QUEUE_KEY, -1);
  
  if (!data) {
    return { enqueuedAt: null };
  }
  
  try {
    const parsed = typeof data === 'object' ? data : JSON.parse(data as string);
    return { enqueuedAt: parsed.enqueuedAt || null };
  } catch {
    return { enqueuedAt: null };
  }
}

/**
 * Requeue Shopify order sync messages back to the front of the queue (FIFO order preserved)
 * Used when worker needs to retry or defer processing
 */
export async function requeueShopifyOrderSyncMessages(messages: ShopifyOrderSyncMessage[]): Promise<void> {
  if (messages.length === 0) return;
  
  const redis = getRedisClient();
  // RPUSH adds to the end of the queue (which is the front for RPOP consumers)
  // Reverse the array to maintain FIFO order - first message should be processed first
  const serialized = messages.reverse().map(msg => JSON.stringify(msg));
  await redis.rpush(SHOPIFY_ORDER_SYNC_QUEUE_KEY, ...serialized);
}

// SkuVault QC Sync Queue operations - async QC scanning for optimistic packing
const SKUVAULT_QC_QUEUE_KEY = 'skuvault:qc-sync';
const SKUVAULT_QC_INFLIGHT_KEY = 'skuvault:qc-sync:inflight';

export interface SkuVaultQCSyncMessage {
  saleId: string; // SkuVault Sale ID
  sku: string; // Product SKU to mark as scanned
  quantity: number; // Number of units scanned
  orderNumber: string; // Order number for reference
  scannedBy: string; // User who scanned
  scannedAt: string; // ISO timestamp when scanned
  enqueuedAt: number;
  retryCount?: number; // Track retry attempts
  shipmentItemId?: string; // Optional: our shipment item ID for event linking
}

/**
 * Generate a deduplication key for a QC sync message
 * Uses saleId + sku + timestamp window (30 sec) to prevent duplicate scans
 * We want to allow re-scans of same item if they're separated by time
 */
function getSkuVaultQCDedupeKey(message: SkuVaultQCSyncMessage): string {
  // Round timestamp to 30-second window for reasonable deduplication
  const timeWindow = Math.floor(new Date(message.scannedAt).getTime() / 30000);
  return `qc:${message.saleId}:${message.sku}:${timeWindow}`;
}

/**
 * Enqueue a SkuVault QC sync message with deduplication
 * Returns true if enqueued, false if already in queue (duplicate scan)
 */
export async function enqueueSkuVaultQCSync(message: SkuVaultQCSyncMessage): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = getSkuVaultQCDedupeKey(message);
  
  // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
  const added = await redis.sadd(SKUVAULT_QC_INFLIGHT_KEY, dedupeKey);
  
  // If already existed, don't enqueue (duplicate scan within time window)
  if (added === 0) {
    return false;
  }
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SKUVAULT_QC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  await redis.rpush(SKUVAULT_QC_QUEUE_KEY, JSON.stringify(message));
  return true;
}

/**
 * Enqueue multiple SkuVault QC sync messages with deduplication
 * Returns count of messages successfully enqueued
 */
export async function enqueueSkuVaultQCSyncBatch(messages: SkuVaultQCSyncMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  
  const redis = getRedisClient();
  const toEnqueue: SkuVaultQCSyncMessage[] = [];
  const seenKeys = new Set<string>();
  
  for (const message of messages) {
    const dedupeKey = getSkuVaultQCDedupeKey(message);
    
    // Skip if already seen in this batch
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    
    // Atomically add to in-flight set
    const added = await redis.sadd(SKUVAULT_QC_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      toEnqueue.push(message);
      seenKeys.add(dedupeKey);
    }
  }
  
  if (toEnqueue.length === 0) return 0;
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SKUVAULT_QC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  const serialized = toEnqueue.map(msg => JSON.stringify(msg));
  await redis.rpush(SKUVAULT_QC_QUEUE_KEY, ...serialized);
  
  return toEnqueue.length;
}

/**
 * Remove a QC sync message from the in-flight set
 * Call this after processing completes (success or failure)
 */
export async function removeSkuVaultQCFromInflight(message: SkuVaultQCSyncMessage): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = getSkuVaultQCDedupeKey(message);
  await redis.srem(SKUVAULT_QC_INFLIGHT_KEY, dedupeKey);
}

export async function dequeueSkuVaultQCSync(): Promise<SkuVaultQCSyncMessage | null> {
  const redis = getRedisClient();
  const data = await redis.rpop(SKUVAULT_QC_QUEUE_KEY);
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data as SkuVaultQCSyncMessage;
  }

  return JSON.parse(data as string);
}

export async function dequeueSkuVaultQCSyncBatch(count: number): Promise<SkuVaultQCSyncMessage[]> {
  const redis = getRedisClient();
  const messages: SkuVaultQCSyncMessage[] = [];
  
  for (let i = 0; i < count; i++) {
    const data = await redis.rpop(SKUVAULT_QC_QUEUE_KEY);
    if (!data) break;
    
    // Handle case where Redis returns an object instead of a string
    if (typeof data === 'object') {
      messages.push(data as SkuVaultQCSyncMessage);
    } else {
      messages.push(JSON.parse(data as string));
    }
  }
  
  return messages;
}

export async function getSkuVaultQCSyncQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(SKUVAULT_QC_QUEUE_KEY) || 0;
}

export async function clearSkuVaultQCSyncQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getSkuVaultQCSyncQueueLength();
  if (length > 0) {
    await redis.del(SKUVAULT_QC_QUEUE_KEY);
  }
  return length;
}

export async function getOldestSkuVaultQCSyncQueueMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  const data = await redis.lindex(SKUVAULT_QC_QUEUE_KEY, -1);
  
  if (!data) {
    return { enqueuedAt: null };
  }
  
  try {
    const parsed = typeof data === 'object' ? data : JSON.parse(data as string);
    return { enqueuedAt: parsed.enqueuedAt || null };
  } catch {
    return { enqueuedAt: null };
  }
}

/**
 * Requeue QC sync messages back to the front of the queue (FIFO order preserved)
 * Used when worker needs to retry due to rate limits or other failures
 */
export async function requeueSkuVaultQCSyncMessages(messages: SkuVaultQCSyncMessage[]): Promise<void> {
  if (messages.length === 0) return;
  
  const redis = getRedisClient();
  // Increment retry count for each message
  const updatedMessages = messages.map(msg => ({
    ...msg,
    retryCount: (msg.retryCount || 0) + 1
  }));
  
  // RPUSH adds to the end of the queue (which is the front for RPOP consumers)
  // Reverse the array to maintain FIFO order
  const serialized = updatedMessages.reverse().map(msg => JSON.stringify(msg));
  await redis.rpush(SKUVAULT_QC_QUEUE_KEY, ...serialized);
}