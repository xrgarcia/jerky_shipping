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
