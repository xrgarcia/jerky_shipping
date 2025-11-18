import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Check for the specific job the user is looking at (0/358)
const result = await pool.query(`
  SELECT id, status, total_orders, processed_orders, failed_orders, 
         TO_CHAR(start_date, 'YYYY-MM-DD') as start_date, 
         TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
         created_at
  FROM backfill_jobs 
  WHERE total_orders = 358 OR status = 'in_progress' OR status = 'pending'
  ORDER BY created_at DESC
`);

console.log('Jobs with 358 orders or in progress:');
console.table(result.rows);

await pool.end();
