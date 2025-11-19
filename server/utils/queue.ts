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

export interface ShipmentSyncMessage {
  reason: 'backfill' | 'webhook' | 'manual';
  orderNumber?: string; // Optional: use for order-based sync
  trackingNumber?: string; // Optional: use for tracking-based sync
  labelUrl?: string; // Optional: label URL for shipment ID extraction
  shipmentId?: string; // Optional: direct shipment ID if available
  enqueuedAt: number;
  jobId?: string; // Optional backfill job ID for tracking
  originalWebhook?: any; // Optional: preserve original webhook payload for troubleshooting
}

export async function enqueueShipmentSync(message: ShipmentSyncMessage): Promise<void> {
  const redis = getRedisClient();
  await redis.lpush(SHIPMENT_SYNC_QUEUE_KEY, JSON.stringify(message));
}

export async function enqueueShipmentSyncBatch(messages: ShipmentSyncMessage[]): Promise<void> {
  if (messages.length === 0) return;
  
  const redis = getRedisClient();
  const serialized = messages.map(msg => JSON.stringify(msg));
  await redis.lpush(SHIPMENT_SYNC_QUEUE_KEY, ...serialized);
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
