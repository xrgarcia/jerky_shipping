import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Pool configuration optimized for Neon serverless to prevent cold starts
// keepAlive prevents connections from going idle and triggering Neon compute suspension
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  // Keep connections alive to prevent Neon cold starts
  keepAlive: true,
  // Send keepalive probe immediately when connection becomes idle
  keepAliveInitialDelayMillis: 0,
  // Maximum number of connections in the pool
  max: 10,
  // Minimum number of connections to keep warm (prevents full cold start)
  min: 1,
  // How long a connection can be idle before being closed (5 minutes)
  idleTimeoutMillis: 300000,
  // How long to wait for a connection before timing out (10 seconds)
  connectionTimeoutMillis: 10000,
});
export const db = drizzle({ client: pool, schema });

// Initialize database extensions (pg_trgm for fuzzy text search)
// Note: This runs synchronously on server startup before any database operations.
// Neon PostgreSQL supports CREATE EXTENSION without superuser privileges.
export async function initializeDatabase() {
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    console.log('✓ Database extensions initialized (pg_trgm)');
  } catch (error) {
    console.error('Failed to initialize database extensions (pg_trgm):', error);
    console.error('Note: pg_trgm extension is required for fuzzy text search indexes.');
    console.error('If using a managed PostgreSQL service, ensure CREATE EXTENSION privileges are granted.');
    throw error;
  }
}

// Heartbeat interval reference for cleanup
let heartbeatInterval: NodeJS.Timeout | null = null;

// Start database heartbeat to prevent Neon compute from suspending
// Runs a lightweight query every 3 minutes to keep the database compute awake
export function startDatabaseHeartbeat() {
  // Clear any existing heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  
  console.log('[DB Heartbeat] Starting heartbeat (every 3 minutes)');
  
  heartbeatInterval = setInterval(async () => {
    try {
      const start = Date.now();
      await db.execute(sql`SELECT 1`);
      const duration = Date.now() - start;
      console.log(`[DB Heartbeat] Ping successful (${duration}ms)`);
    } catch (error) {
      console.error('[DB Heartbeat] Ping failed:', error);
    }
  }, HEARTBEAT_INTERVAL_MS);
  
  // Don't block process exit
  heartbeatInterval.unref();
}

// Stop the heartbeat (for graceful shutdown)
export function stopDatabaseHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log('[DB Heartbeat] Stopped');
  }
}
