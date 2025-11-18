import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error('Upstash Redis credentials not configured');
  process.exit(1);
}

const redis = new Redis({ url, token });
const QUEUE_KEY = 'shopify:webhooks:orders';

const length = await redis.llen(QUEUE_KEY) || 0;
console.log(`Current queue length: ${length}`);

if (length > 0) {
  await redis.del(QUEUE_KEY);
  console.log(`✓ Cleared ${length} webhooks from queue`);
} else {
  console.log('Queue is already empty');
}

const newLength = await redis.llen(QUEUE_KEY) || 0;
console.log(`New queue length: ${newLength}`);
