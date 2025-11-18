import { Redis } from '@upstash/redis';
import pg from 'pg';
const { Pool } = pg;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = new Redis({ url, token });

const queueLength = await redis.llen('shopify:webhooks:orders') || 0;
console.log(`\n📊 Current Queue Status:`);
console.log(`   Total webhooks in queue: ${queueLength}`);

// Check latest backfill jobs
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await pool.query(`
  SELECT id, status, total_orders, processed_orders, 
         TO_CHAR(start_date, 'MM/DD') as start_date, 
         TO_CHAR(end_date, 'MM/DD') as end_date,
         TO_CHAR(created_at, 'HH12:MI AM') as created
  FROM backfill_jobs 
  WHERE created_at > NOW() - INTERVAL '2 hours'
  ORDER BY created_at DESC
`);

console.log(`\n📋 Recent Backfill Jobs (last 2 hours):`);
console.table(result.rows);

await pool.end();
