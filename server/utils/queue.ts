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
  await redis.lpush(QUEUE_KEY, JSON.stringify(webhookData));
}

export async function enqueueOrderId(orderId: string, jobId?: string): Promise<void> {
  const redis = getRedisClient();
  const queueItem = {
    type: 'order-id',
    orderId,
    jobId: jobId || null,
  };
  await redis.lpush(QUEUE_KEY, JSON.stringify(queueItem));
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
  reason: 'backfill' | 'webhook' | 'manual';
  orderNumber?: string; // Optional: use for order-based sync
  trackingNumber?: string; // Optional: use for tracking-based sync
  labelUrl?: string; // Optional: label URL for shipment ID extraction
  shipmentId?: string; // Optional: direct shipment ID if available
  trackingData?: any; // Optional: tracking data from webhook (status, ship_date, etc.) for fast updates
  enqueuedAt: number;
  jobId?: string; // Optional backfill job ID for tracking
  originalWebhook?: any; // Optional: preserve original webhook payload for troubleshooting
  retryCount?: number; // Retry count to prevent infinite loops
}

/**
 * Generate a deduplication key for a shipment sync message
 * Uses tracking number or order number to identify unique shipments
 */
function getShipmentSyncDedupeKey(message: ShipmentSyncMessage): string | null {
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
    await redis.lpush(SHIPMENT_SYNC_QUEUE_KEY, JSON.stringify(message));
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
  
  // Enqueue the message
  await redis.lpush(SHIPMENT_SYNC_QUEUE_KEY, JSON.stringify(message));
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
  
  // Enqueue all messages
  const serialized = toEnqueue.map(msg => JSON.stringify(msg));
  await redis.lpush(SHIPMENT_SYNC_QUEUE_KEY, ...serialized);
  
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
  
  // Enqueue the message
  await redis.lpush(SHOPIFY_ORDER_SYNC_QUEUE_KEY, JSON.stringify(message));
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
  
  // Enqueue all messages
  const serialized = toEnqueue.map(msg => JSON.stringify(msg));
  await redis.lpush(SHOPIFY_ORDER_SYNC_QUEUE_KEY, ...serialized);
  
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

// Backfill Fetch Task Queue operations
const BACKFILL_FETCH_QUEUE_KEY = 'backfill:fetch-tasks';
const BACKFILL_FETCH_INFLIGHT_KEY = 'backfill:fetch-tasks:inflight';

export interface BackfillFetchTask {
  source: 'shopify' | 'shipstation'; // Which API to fetch from
  startDate: string; // ISO 8601 timestamp for query start
  endDate: string; // ISO 8601 timestamp for query end
  jobId: string; // Backfill job ID for tracking
  enqueuedAt: number; // Unix timestamp when task was enqueued
  retryCount?: number; // Track retry attempts
}

/**
 * Generate a deduplication key for a backfill fetch task
 * Uses source + date range + jobId to identify unique fetch tasks
 */
function getBackfillFetchTaskDedupeKey(task: BackfillFetchTask): string {
  return `${task.source}:${task.startDate}:${task.endDate}:${task.jobId}`;
}

/**
 * Enqueue a backfill fetch task with deduplication
 * Returns true if enqueued, false if already in queue
 * Uses SADD's atomic return value to prevent race conditions
 */
export async function enqueueBackfillFetchTask(task: BackfillFetchTask): Promise<boolean> {
  const redis = getRedisClient();
  const dedupeKey = getBackfillFetchTaskDedupeKey(task);
  
  // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
  const added = await redis.sadd(BACKFILL_FETCH_INFLIGHT_KEY, dedupeKey);
  
  // If already existed, don't enqueue
  if (added === 0) {
    return false; // Already queued/processing
  }
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(BACKFILL_FETCH_INFLIGHT_KEY, 3600);
  
  // Enqueue the message
  await redis.lpush(BACKFILL_FETCH_QUEUE_KEY, JSON.stringify(task));
  return true;
}

/**
 * Enqueue multiple backfill fetch tasks with deduplication
 * Returns count of tasks successfully enqueued (deduplicated tasks are skipped)
 */
export async function enqueueBackfillFetchTaskBatch(tasks: BackfillFetchTask[]): Promise<number> {
  if (tasks.length === 0) return 0;
  
  const redis = getRedisClient();
  const toEnqueue: BackfillFetchTask[] = [];
  const seenKeys = new Set<string>(); // Track duplicates within this batch
  
  for (const task of tasks) {
    const dedupeKey = getBackfillFetchTaskDedupeKey(task);
    
    // Skip if already seen in this batch
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    
    // Atomically add to in-flight set - returns 1 if added (new), 0 if already exists
    const added = await redis.sadd(BACKFILL_FETCH_INFLIGHT_KEY, dedupeKey);
    
    if (added === 1) {
      toEnqueue.push(task);
      seenKeys.add(dedupeKey);
    }
  }
  
  if (toEnqueue.length === 0) return 0;
  
  // Set expiry on the set (1 hour as safety net)
  await redis.expire(BACKFILL_FETCH_INFLIGHT_KEY, 3600);
  
  // Enqueue all tasks
  const serialized = toEnqueue.map(task => JSON.stringify(task));
  await redis.lpush(BACKFILL_FETCH_QUEUE_KEY, ...serialized);
  
  return toEnqueue.length;
}

/**
 * Remove a backfill fetch task from the in-flight set
 * Call this after processing completes (success or failure)
 */
export async function removeBackfillFetchTaskFromInflight(task: BackfillFetchTask): Promise<void> {
  const redis = getRedisClient();
  const dedupeKey = getBackfillFetchTaskDedupeKey(task);
  await redis.srem(BACKFILL_FETCH_INFLIGHT_KEY, dedupeKey);
}

export async function dequeueBackfillFetchTask(): Promise<BackfillFetchTask | null> {
  const redis = getRedisClient();
  const data = await redis.rpop(BACKFILL_FETCH_QUEUE_KEY);
  
  if (!data) {
    return null;
  }

  // Handle case where Redis returns an object instead of a string
  if (typeof data === 'object') {
    return data as BackfillFetchTask;
  }

  return JSON.parse(data as string);
}

export async function dequeueBackfillFetchTaskBatch(count: number): Promise<BackfillFetchTask[]> {
  const redis = getRedisClient();
  const tasks: BackfillFetchTask[] = [];
  
  for (let i = 0; i < count; i++) {
    const data = await redis.rpop(BACKFILL_FETCH_QUEUE_KEY);
    if (!data) break;
    
    // Handle case where Redis returns an object instead of a string
    if (typeof data === 'object') {
      tasks.push(data as BackfillFetchTask);
    } else {
      tasks.push(JSON.parse(data as string));
    }
  }
  
  return tasks;
}

export async function getBackfillFetchQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return await redis.llen(BACKFILL_FETCH_QUEUE_KEY) || 0;
}

export async function clearBackfillFetchQueue(): Promise<number> {
  const redis = getRedisClient();
  const length = await getBackfillFetchQueueLength();
  if (length > 0) {
    await redis.del(BACKFILL_FETCH_QUEUE_KEY);
    await redis.del(BACKFILL_FETCH_INFLIGHT_KEY);
  }
  return length;
}

export async function getOldestBackfillFetchTaskMessage(): Promise<{ enqueuedAt: number | null }> {
  const redis = getRedisClient();
  const data = await redis.lindex(BACKFILL_FETCH_QUEUE_KEY, -1);
  
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
