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

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
