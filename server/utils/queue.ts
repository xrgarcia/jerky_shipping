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

// Shipment Sync Queue operations - Priority-based with high/low queues
const SHIPMENT_SYNC_QUEUE_KEY_HIGH = 'shipstation:shipment-sync:high';
const SHIPMENT_SYNC_QUEUE_KEY_LOW = 'shipstation:shipment-sync:low';
const SHIPMENT_SYNC_QUEUE_KEY = 'shipstation:shipment-sync'; // Legacy - still used for queue length checks
const SHIPMENT_SYNC_INFLIGHT_KEY = 'shipstation:shipment-sync:inflight';

export type ShipmentSyncPriority = 'high' | 'low';

export interface ShipmentSyncMessage {
  reason: 'backfill' | 'webhook' | 'webhook_tracking' | 'webhook_fulfillment' | 'manual' | 'reverse_sync';
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
  priority?: ShipmentSyncPriority; // Queue priority - high for webhooks, low for reverse_sync
}

/**
 * Determine the priority for a shipment sync message based on its reason
 * - Webhooks get high priority (often have inline data, customer-facing)
 * - Reverse sync gets low priority (background verification, always needs API)
 * - Backfill and manual get high priority (explicit user actions)
 */
function getShipmentSyncPriority(message: ShipmentSyncMessage): ShipmentSyncPriority {
  // Explicit priority takes precedence
  if (message.priority) {
    return message.priority;
  }
  
  // Reverse sync always low priority - background verification work
  if (message.reason === 'reverse_sync') {
    return 'low';
  }
  
  // Everything else is high priority - webhooks, manual, backfill
  return 'high';
}

/**
 * Get the queue key for a given priority
 */
function getShipmentSyncQueueKey(priority: ShipmentSyncPriority): string {
  return priority === 'high' ? SHIPMENT_SYNC_QUEUE_KEY_HIGH : SHIPMENT_SYNC_QUEUE_KEY_LOW;
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
 * Enqueue a shipment sync message with deduplication and priority routing
 * Returns true if enqueued, false if already in queue
 * Uses SADD's atomic return value to prevent race conditions
 * Priority: webhooks -> high, reverse_sync -> low
 */
export async function enqueueShipmentSync(message: ShipmentSyncMessage): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = getShipmentSyncDedupeKey(message);
  const priority = getShipmentSyncPriority(message);
  const queueKey = getShipmentSyncQueueKey(priority);
  
  // Store priority in message for logging/debugging
  const messageWithPriority = { ...message, priority };
  
  // If no dedupe key (no tracking or order number), enqueue anyway
  if (!dedupeKey) {
    // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
    await redis.rpush(queueKey, JSON.stringify(messageWithPriority));
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
  await redis.rpush(queueKey, JSON.stringify(messageWithPriority));
  return true;
}

/**
 * Enqueue multiple shipment sync messages with deduplication and priority routing
 * Returns count of messages successfully enqueued (deduplicated messages are skipped)
 * Handles both in-batch duplicates and existing queue duplicates atomically
 * Messages are routed to high/low priority queues based on their reason
 */
export async function enqueueShipmentSyncBatch(messages: ShipmentSyncMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  
  const redis = getRedisClient();
  const highPriorityMessages: ShipmentSyncMessage[] = [];
  const lowPriorityMessages: ShipmentSyncMessage[] = [];
  const seenKeys = new Set<string>(); // Track duplicates within this batch
  
  for (const message of messages) {
    const dedupeKey = getShipmentSyncDedupeKey(message);
    const priority = getShipmentSyncPriority(message);
    const messageWithPriority = { ...message, priority };
    
    // If no dedupe key, always enqueue
    if (!dedupeKey) {
      if (priority === 'high') {
        highPriorityMessages.push(messageWithPriority);
      } else {
        lowPriorityMessages.push(messageWithPriority);
      }
      continue;
    }
    
    // Skip if already seen in this batch
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    
    // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
    const added = await redis.sadd(SHIPMENT_SYNC_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      if (priority === 'high') {
        highPriorityMessages.push(messageWithPriority);
      } else {
        lowPriorityMessages.push(messageWithPriority);
      }
      seenKeys.add(dedupeKey);
    }
  }
  
  const totalToEnqueue = highPriorityMessages.length + lowPriorityMessages.length;
  if (totalToEnqueue === 0) return 0;
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(SHIPMENT_SYNC_INFLIGHT_KEY, 3600);
  
  // CRITICAL: Use RPUSH (add to tail) with RPOP (remove from tail) = FIFO queue
  // Enqueue to respective priority queues
  if (highPriorityMessages.length > 0) {
    const serialized = highPriorityMessages.map(msg => JSON.stringify(msg));
    await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY_HIGH, ...serialized);
  }
  if (lowPriorityMessages.length > 0) {
    const serialized = lowPriorityMessages.map(msg => JSON.stringify(msg));
    await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY_LOW, ...serialized);
  }
  
  return totalToEnqueue;
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

/**
 * Dequeue a shipment sync message, prioritizing high priority queue
 * Checks high priority queue first, then falls back to low priority
 */
export async function dequeueShipmentSync(): Promise<ShipmentSyncMessage | null> {
  const redis = getRedisClient();
  
  // Try high priority first
  let data = await redis.rpop(SHIPMENT_SYNC_QUEUE_KEY_HIGH);
  
  // Fall back to low priority if high is empty
  if (!data) {
    data = await redis.rpop(SHIPMENT_SYNC_QUEUE_KEY_LOW);
  }
  
  // Also check legacy queue for backward compatibility during transition
  if (!data) {
    data = await redis.rpop(SHIPMENT_SYNC_QUEUE_KEY);
  }
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data as ShipmentSyncMessage;
  }

  return JSON.parse(data as string);
}

/**
 * Dequeue a batch of shipment sync messages, prioritizing high priority queue
 * Drains high priority first, then low priority, then legacy until count is reached
 * Continues across queues to ensure we get as many messages as possible up to count
 */
export async function dequeueShipmentSyncBatch(count: number): Promise<ShipmentSyncMessage[]> {
  const redis = getRedisClient();
  const messages: ShipmentSyncMessage[] = [];
  const queues = [SHIPMENT_SYNC_QUEUE_KEY_HIGH, SHIPMENT_SYNC_QUEUE_KEY_LOW, SHIPMENT_SYNC_QUEUE_KEY];
  
  // Try each queue in priority order until we have enough messages
  for (const queueKey of queues) {
    while (messages.length < count) {
      const data = await redis.rpop(queueKey);
      if (!data) break; // This queue is empty, move to next
      
      if (typeof data === 'object') {
        messages.push(data as ShipmentSyncMessage);
      } else {
        messages.push(JSON.parse(data as string));
      }
    }
    
    // Stop if we have enough messages
    if (messages.length >= count) break;
  }
  
  return messages;
}

/**
 * Get total length of all shipment sync queues (high + low + legacy)
 */
export async function getShipmentSyncQueueLength(): Promise<number> {
  const redis = getRedisClient();
  const [high, low, legacy] = await Promise.all([
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY_HIGH),
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY_LOW),
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY),
  ]);
  return (high || 0) + (low || 0) + (legacy || 0);
}

/**
 * Get length of each priority queue separately (for monitoring)
 */
export async function getShipmentSyncQueueLengthByPriority(): Promise<{ high: number; low: number; legacy: number; total: number }> {
  const redis = getRedisClient();
  const [high, low, legacy] = await Promise.all([
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY_HIGH),
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY_LOW),
    redis.llen(SHIPMENT_SYNC_QUEUE_KEY),
  ]);
  const highLen = high || 0;
  const lowLen = low || 0;
  const legacyLen = legacy || 0;
  return { high: highLen, low: lowLen, legacy: legacyLen, total: highLen + lowLen + legacyLen };
}

/**
 * Clear all shipment sync queues (high + low + legacy)
 */
export async function clearShipmentSyncQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getShipmentSyncQueueLength();
  if (length > 0) {
    await Promise.all([
      redis.del(SHIPMENT_SYNC_QUEUE_KEY_HIGH),
      redis.del(SHIPMENT_SYNC_QUEUE_KEY_LOW),
      redis.del(SHIPMENT_SYNC_QUEUE_KEY),
    ]);
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

/**
 * Get the oldest message timestamp from all shipment sync queues
 * Returns the oldest enqueuedAt across high, low, and legacy queues
 */
export async function getOldestShipmentSyncQueueMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  
  // Check all queues in parallel
  const [highData, lowData, legacyData] = await Promise.all([
    redis.lindex(SHIPMENT_SYNC_QUEUE_KEY_HIGH, -1),
    redis.lindex(SHIPMENT_SYNC_QUEUE_KEY_LOW, -1),
    redis.lindex(SHIPMENT_SYNC_QUEUE_KEY, -1),
  ]);
  
  const timestamps: number[] = [];
  
  for (const data of [highData, lowData, legacyData]) {
    if (data) {
      try {
        const parsed = typeof data === 'object' ? data : JSON.parse(data as string);
        if (parsed.enqueuedAt) {
          timestamps.push(parsed.enqueuedAt);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
  
  if (timestamps.length === 0) {
    return { enqueuedAt: null };
  }
  
  // Return the oldest (minimum) timestamp
  return { enqueuedAt: Math.min(...timestamps) };
}

/**
 * Requeue shipment sync messages back to the front of the queue (FIFO order preserved)
 * Routes messages to the appropriate priority queue based on their priority field
 * Used when worker needs to stop processing due to rate limits
 * 
 * With RPOP (removes from tail), we use RPUSH (adds to tail) so requeued items
 * are processed BEFORE existing items. Reverse maintains original processing order.
 */
export async function requeueShipmentSyncMessages(messages: ShipmentSyncMessage[]): Promise<void> {
  if (messages.length === 0) return;
  
  const redis = getRedisClient();
  
  // Separate by priority
  const highPriority: ShipmentSyncMessage[] = [];
  const lowPriority: ShipmentSyncMessage[] = [];
  
  for (const msg of messages) {
    const priority = getShipmentSyncPriority(msg);
    if (priority === 'high') {
      highPriority.push(msg);
    } else {
      lowPriority.push(msg);
    }
  }
  
  // RPUSH adds to tail, RPOP removes from tail
  // Requeued items go to tail so RPOP sees them first (before existing items)
  // Reverse to maintain original order: [m1,m2] reversed + RPUSH = RPOP gets m1,m2
  if (highPriority.length > 0) {
    const serialized = highPriority.reverse().map(msg => JSON.stringify(msg));
    await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY_HIGH, ...serialized);
  }
  if (lowPriority.length > 0) {
    const serialized = lowPriority.reverse().map(msg => JSON.stringify(msg));
    await redis.rpush(SHIPMENT_SYNC_QUEUE_KEY_LOW, ...serialized);
  }
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

// Unified Shipment Sync Failure Tracking
// Used by the unified shipment sync worker to track and dead-letter persistently failing shipments
const SHIPMENT_SYNC_FAILURE_PREFIX = 'shipstation:sync-failure:';
const SHIPMENT_SYNC_FAILURE_TTL_HOURS = 24;

/**
 * Generate a unique key for tracking sync failures of a specific shipment version
 * Uses shipmentId + modifiedAt to distinguish between different versions of the same shipment
 */
function getShipmentSyncFailureKey(shipmentId: string, modifiedAt: string): string {
  return `${SHIPMENT_SYNC_FAILURE_PREFIX}${shipmentId}:${modifiedAt}`;
}

/**
 * Increment the failure count for a shipment sync attempt
 * Returns the new failure count after incrementing
 * Sets 24-hour TTL so old failures don't block future syncs of the same shipment
 */
export async function incrementShipmentSyncFailureCount(shipmentId: string, modifiedAt: string): Promise<number> {
  const redis = getRedisClient();
  const key = getShipmentSyncFailureKey(shipmentId, modifiedAt);
  
  const newCount = await redis.incr(key);
  await redis.expire(key, SHIPMENT_SYNC_FAILURE_TTL_HOURS * 3600);
  
  return newCount;
}

/**
 * Get the current failure count for a shipment sync attempt
 * Returns 0 if no failures recorded (key doesn't exist)
 */
export async function getShipmentSyncFailureCount(shipmentId: string, modifiedAt: string): Promise<number> {
  const redis = getRedisClient();
  const key = getShipmentSyncFailureKey(shipmentId, modifiedAt);
  
  const count = await redis.get<number>(key);
  return count || 0;
}

/**
 * Clear the failure count for a shipment sync attempt
 * Call this after successful sync or after moving to dead-letter queue
 */
export async function clearShipmentSyncFailureCount(shipmentId: string, modifiedAt: string): Promise<void> {
  const redis = getRedisClient();
  const key = getShipmentSyncFailureKey(shipmentId, modifiedAt);
  
  await redis.del(key);
}

/**
 * Check if a shipment has been dead-lettered (exceeded max retries)
 * Uses a separate set to track dead-lettered shipments for the current sync cycle
 */
const SHIPMENT_SYNC_DEADLETTER_SET = 'shipstation:sync-deadlettered';
const SHIPMENT_SYNC_DEADLETTER_TTL_HOURS = 24;

/**
 * Mark a shipment as dead-lettered in Redis
 * This prevents the cursor from being blocked by this shipment
 */
export async function markShipmentAsDeadLettered(shipmentId: string, modifiedAt: string): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = `${shipmentId}:${modifiedAt}`;
  
  await redis.sadd(SHIPMENT_SYNC_DEADLETTER_SET, dedupeKey);
  await redis.expire(SHIPMENT_SYNC_DEADLETTER_SET, SHIPMENT_SYNC_DEADLETTER_TTL_HOURS * 3600);
}

/**
 * Check if a shipment is currently dead-lettered
 */
export async function isShipmentDeadLettered(shipmentId: string, modifiedAt: string): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = `${shipmentId}:${modifiedAt}`;
  
  const isMember = await redis.sismember(SHIPMENT_SYNC_DEADLETTER_SET, dedupeKey);
  return isMember === 1;
}

/**
 * Clear a shipment from the dead-letter set
 * Call this if the shipment is manually fixed and should be retried
 */
export async function clearShipmentFromDeadLetter(shipmentId: string, modifiedAt: string): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = `${shipmentId}:${modifiedAt}`;
  
  await redis.srem(SHIPMENT_SYNC_DEADLETTER_SET, dedupeKey);
}

/**
 * Get all dead-lettered shipment keys (for debugging/monitoring)
 */
export async function getDeadLetteredShipments(): Promise<string[]> {
  const redis = getRedisClient();
  const members = await redis.smembers(SHIPMENT_SYNC_DEADLETTER_SET);
  return members || [];
}

// ============================================================================
// LIFECYCLE EVENT QUEUE
// ============================================================================
// Event-driven lifecycle state machine queue for shipments.
// Events are queued when shipment data changes (webhooks, user actions, sync).
// A worker consumes events, derives lifecycle state, and triggers side effects.
// ============================================================================

const LIFECYCLE_QUEUE_KEY = 'lifecycle:events';
const LIFECYCLE_INFLIGHT_KEY = 'lifecycle:inflight';
const MAX_LIFECYCLE_RETRIES = 3;

export type LifecycleEventReason = 
  | 'webhook'           // ShipStation webhook triggered update
  | 'webhook_tracking'  // ShipStation tracking webhook update
  | 'shipment_sync'     // Unified shipment sync worker
  | 'categorization'    // Product categorized
  | 'fingerprint'       // Fingerprint assigned
  | 'packaging'         // Packaging type assigned
  | 'session'           // Added to fulfillment session
  | 'rate_check'        // Rate check completed
  | 'rate_analysis'     // Smart carrier rate analysis completed
  | 'lifecycle_repair'  // Lifecycle repair worker batch operation
  | 'manual'            // Manual trigger from UI
  | 'backfill';         // Batch backfill operation

export interface LifecycleEvent {
  shipmentId: string;           // Internal shipment UUID (primary key)
  orderNumber?: string;         // For logging/debugging
  reason: LifecycleEventReason;
  enqueuedAt: number;
  retryCount?: number;
  metadata?: Record<string, any>; // Optional context (e.g., which field changed)
}

/**
 * Enqueue a lifecycle event for a shipment with deduplication
 * Returns true if enqueued, false if already in queue/processing
 */
export async function enqueueLifecycleEvent(event: LifecycleEvent): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = `lifecycle:${event.shipmentId}`;
  
  // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
  const added = await redis.sadd(LIFECYCLE_INFLIGHT_KEY, dedupeKey);
  
  if (added === 0) {
    return false; // Already queued/processing
  }
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(LIFECYCLE_INFLIGHT_KEY, 3600);
  
  // FIFO: RPUSH (tail) + LPOP (head)
  await redis.rpush(LIFECYCLE_QUEUE_KEY, JSON.stringify(event));
  return true;
}

/**
 * Enqueue lifecycle events for multiple shipments (batch operation)
 * Returns count of messages successfully enqueued (deduplicated ones are skipped)
 */
export async function enqueueLifecycleEventBatch(events: LifecycleEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  
  const redis = getRedisClient();
  const toEnqueue: LifecycleEvent[] = [];
  const seenIds = new Set<string>();
  
  for (const event of events) {
    // Skip duplicates within this batch
    if (seenIds.has(event.shipmentId)) {
      continue;
    }
    
    const dedupeKey = `lifecycle:${event.shipmentId}`;
    const added = await redis.sadd(LIFECYCLE_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      toEnqueue.push(event);
      seenIds.add(event.shipmentId);
    }
  }
  
  if (toEnqueue.length === 0) return 0;
  
  await redis.expire(LIFECYCLE_INFLIGHT_KEY, 3600);
  
  const serialized = toEnqueue.map(e => JSON.stringify(e));
  await redis.rpush(LIFECYCLE_QUEUE_KEY, ...serialized);
  
  return toEnqueue.length;
}

/**
 * Dequeue the next lifecycle event (FIFO order)
 */
export async function dequeueLifecycleEvent(): Promise<LifecycleEvent | null> {
  const redis = getRedisClient();
  const data = await redis.lpop(LIFECYCLE_QUEUE_KEY);
  
  if (!data) return null;
  
  if (typeof data === 'object') {
    return data as LifecycleEvent;
  }
  
  return JSON.parse(data as string);
}

/**
 * Mark a lifecycle event as completed (remove from in-flight set)
 */
export async function completeLifecycleEvent(shipmentId: string): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = `lifecycle:${shipmentId}`;
  await redis.srem(LIFECYCLE_INFLIGHT_KEY, dedupeKey);
}

/**
 * Re-enqueue a failed lifecycle event with incremented retry count
 * Returns false if max retries exceeded
 */
export async function retryLifecycleEvent(event: LifecycleEvent): Promise<boolean> {
  const retryCount = (event.retryCount || 0) + 1;
  
  if (retryCount > MAX_LIFECYCLE_RETRIES) {
    console.error(`[LifecycleQueue] Max retries exceeded for shipment ${event.shipmentId}`);
    return false;
  }
  
  const redis = getRedisClient();
  const retryEvent = { ...event, retryCount, enqueuedAt: Date.now() };
  
  // Re-add to queue (already in in-flight set, so no dedupe check needed)
  await redis.rpush(LIFECYCLE_QUEUE_KEY, JSON.stringify(retryEvent));
  return true;
}

/**
 * Get the current lifecycle queue length
 */
export async function getLifecycleQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(LIFECYCLE_QUEUE_KEY) || 0;
}

/**
 * Get count of in-flight lifecycle events (being processed)
 */
export async function getLifecycleInflightCount(): Promise<number> {
  const redis = getRedisClient();
  return await redis.scard(LIFECYCLE_INFLIGHT_KEY) || 0;
}

/**
 * Clear the lifecycle queue (for testing/reset)
 */
export async function clearLifecycleQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getLifecycleQueueLength();
  if (length > 0) {
    await redis.del(LIFECYCLE_QUEUE_KEY);
  }
  await redis.del(LIFECYCLE_INFLIGHT_KEY);
  return length;
}