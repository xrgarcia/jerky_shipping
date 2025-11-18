import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const result = await pool.query(`
  SELECT id, status, total_orders, processed_orders, failed_orders, 
         TO_CHAR(start_date, 'YYYY-MM-DD') as start_date, 
         TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
         created_at
  FROM backfill_jobs 
  ORDER BY created_at DESC 
  LIMIT 10
`);

console.log('Backfill Jobs:');
console.table(result.rows);

await pool.end();
