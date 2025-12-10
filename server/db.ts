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
// Also pings the public endpoint to prevent container hibernation
export function startDatabaseHeartbeat() {
  // Clear any existing heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  
  // Determine the public URL for self-ping
  // In production: ship.jerky.com
  // In development: use REPL_SLUG (e.g. workspace-name.username.repl.co)
  const publicUrl = process.env.NODE_ENV === 'production' 
    ? 'https://ship.jerky.com'
    : process.env.REPL_SLUG 
      ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
      : null;
  
  console.log('[Heartbeat] Starting heartbeat (every 3 minutes)');
  if (publicUrl) {
    console.log(`[Heartbeat] Container keep-alive URL: ${publicUrl}/api/health/heart-beat`);
  }
  
  heartbeatInterval = setInterval(async () => {
    // Database heartbeat
    try {
      const dbStart = Date.now();
      await db.execute(sql`SELECT 1`);
      const dbDuration = Date.now() - dbStart;
      console.log(`[Heartbeat] DB ping successful (${dbDuration}ms)`);
    } catch (error) {
      console.error('[Heartbeat] DB ping failed:', error);
    }
    
    // Container keep-alive self-ping
    if (publicUrl) {
      try {
        const httpStart = Date.now();
        const response = await fetch(`${publicUrl}/api/health/heart-beat`, {
          method: 'GET',
          headers: { 'User-Agent': 'Heartbeat-Self-Ping' },
        });
        const httpDuration = Date.now() - httpStart;
        if (response.ok) {
          console.log(`[Heartbeat] Container ping successful (${httpDuration}ms)`);
        } else {
          console.warn(`[Heartbeat] Container ping returned ${response.status}`);
        }
      } catch (error) {
        // Don't log full error - likely ECONNREFUSED in dev which is expected
        console.warn('[Heartbeat] Container ping failed (expected in dev)');
      }
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
