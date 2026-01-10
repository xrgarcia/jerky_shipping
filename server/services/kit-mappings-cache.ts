/**
 * Kit Mappings Cache Service
 * 
 * Manages kit→component mappings with:
 * 1. Local PostgreSQL table as persistent storage (kit_component_mappings)
 * 2. Hourly sync from GCP reporting database (full two-way sync with deletes)
 * 3. In-memory cache for fast lookups during hydration
 * 
 * The local table is the source of truth for the hydrator.
 * GCP is the upstream source, synced hourly.
 */

import { db } from '../db';
import { kitComponentMappings } from '@shared/schema';
import { eq, sql, inArray, and } from 'drizzle-orm';
import { reportingSql } from '../reporting-db';

const log = (message: string) => console.log(`[kit-mappings-cache] ${message}`);

export interface KitComponent {
  componentSku: string;
  componentQuantity: number;
}

let kitMappingsCache: Map<string, KitComponent[]> | null = null;
let reverseComponentCache: Map<string, string[]> | null = null;
let lastLoadedAt: Date | null = null;

// Maximum cache age in milliseconds before forcing a reload
// Set to 5 minutes to catch recently synced kit mappings
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Load kit mappings from local database into memory cache
 */
async function loadFromLocalDb(): Promise<void> {
  try {
    const results = await db
      .select({
        kitSku: kitComponentMappings.kitSku,
        componentSku: kitComponentMappings.componentSku,
        componentQuantity: kitComponentMappings.componentQuantity,
      })
      .from(kitComponentMappings);
    
    const mappings = new Map<string, KitComponent[]>();
    const reverseMap = new Map<string, string[]>();
    
    for (const row of results) {
      const component: KitComponent = {
        componentSku: row.componentSku,
        componentQuantity: row.componentQuantity,
      };
      
      if (!mappings.has(row.kitSku)) {
        mappings.set(row.kitSku, []);
      }
      mappings.get(row.kitSku)!.push(component);
      
      if (!reverseMap.has(row.componentSku)) {
        reverseMap.set(row.componentSku, []);
      }
      if (!reverseMap.get(row.componentSku)!.includes(row.kitSku)) {
        reverseMap.get(row.componentSku)!.push(row.kitSku);
      }
    }
    
    kitMappingsCache = mappings;
    reverseComponentCache = reverseMap;
    lastLoadedAt = new Date();
    
    log(`Loaded ${mappings.size} kit mappings from local DB`);
  } catch (error) {
    log(`Error loading from local DB: ${error}`);
    throw error;
  }
}

/**
 * Sync kit mappings from GCP to local database
 * Full two-way sync: upserts new/changed records, deletes stale records
 * Returns stats about what changed
 */
export async function syncKitMappingsFromGcp(): Promise<{
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  error?: string;
}> {
  const stats = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  
  try {
    log('Starting kit mappings sync from GCP...');
    
    const gcpResults = await reportingSql`
      SELECT DISTINCT
        sku as kit_sku,
        component_sku,
        component_quantity
      FROM vw_internal_kit_component_inventory_latest
      ORDER BY sku, component_sku
    `;
    
    log(`Fetched ${gcpResults.length} mappings from GCP`);
    
    if (gcpResults.length === 0) {
      log('Warning: GCP returned 0 mappings, skipping sync to avoid data loss');
      return { ...stats, error: 'GCP returned 0 mappings' };
    }
    
    const gcpMappings = new Map<string, number>();
    for (const row of gcpResults) {
      const key = `${row.kit_sku}|${row.component_sku}`;
      gcpMappings.set(key, row.component_quantity || 1);
    }
    
    const localResults = await db
      .select({
        id: kitComponentMappings.id,
        kitSku: kitComponentMappings.kitSku,
        componentSku: kitComponentMappings.componentSku,
        componentQuantity: kitComponentMappings.componentQuantity,
      })
      .from(kitComponentMappings);
    
    const localMappings = new Map<string, { id: string; quantity: number }>();
    for (const row of localResults) {
      const key = `${row.kitSku}|${row.componentSku}`;
      localMappings.set(key, { id: row.id, quantity: row.componentQuantity });
    }
    
    const toInsert: { kitSku: string; componentSku: string; componentQuantity: number }[] = [];
    const toUpdate: { id: string; componentQuantity: number }[] = [];
    const toDelete: string[] = [];
    
    for (const [key, gcpQty] of Array.from(gcpMappings.entries())) {
      const [kitSku, componentSku] = key.split('|');
      const local = localMappings.get(key);
      
      if (!local) {
        toInsert.push({ kitSku, componentSku, componentQuantity: gcpQty });
      } else if (local.quantity !== gcpQty) {
        toUpdate.push({ id: local.id, componentQuantity: gcpQty });
      } else {
        stats.unchanged++;
      }
    }
    
    for (const [key, local] of Array.from(localMappings.entries())) {
      if (!gcpMappings.has(key)) {
        toDelete.push(local.id);
      }
    }
    
    if (toInsert.length > 0) {
      const now = new Date();
      await db.insert(kitComponentMappings).values(
        toInsert.map(m => ({
          kitSku: m.kitSku,
          componentSku: m.componentSku,
          componentQuantity: m.componentQuantity,
          syncedAt: now,
        }))
      );
      stats.inserted = toInsert.length;
      log(`Inserted ${toInsert.length} new mappings`);
    }
    
    if (toUpdate.length > 0) {
      const now = new Date();
      for (const update of toUpdate) {
        await db
          .update(kitComponentMappings)
          .set({ componentQuantity: update.componentQuantity, syncedAt: now })
          .where(eq(kitComponentMappings.id, update.id));
      }
      stats.updated = toUpdate.length;
      log(`Updated ${toUpdate.length} mappings`);
    }
    
    if (toDelete.length > 0) {
      await db
        .delete(kitComponentMappings)
        .where(inArray(kitComponentMappings.id, toDelete));
      stats.deleted = toDelete.length;
      log(`Deleted ${toDelete.length} stale mappings`);
    }
    
    await loadFromLocalDb();
    
    log(`Sync complete: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged`);
    
    return stats;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Sync error: ${errorMsg}`);
    return { ...stats, error: errorMsg };
  }
}

/**
 * Check if cache is stale and needs refresh
 */
function isCacheStale(): boolean {
  if (!lastLoadedAt) return true;
  const age = Date.now() - lastLoadedAt.getTime();
  return age > CACHE_MAX_AGE_MS;
}

/**
 * Ensure kit mappings are loaded into memory AND fresh
 * Called by hydrator before processing shipments
 * 
 * CRITICAL FIX: Previously this only loaded once and never refreshed.
 * Now it checks cache age and reloads if stale (>5 minutes).
 * This prevents race conditions where:
 * 1. GCP sync adds new kit mappings to local DB
 * 2. Hydrator runs with stale in-memory cache
 * 3. New kits aren't recognized and don't get exploded
 */
export async function ensureKitMappingsFresh(): Promise<boolean> {
  try {
    const needsRefresh = !kitMappingsCache || isCacheStale();
    
    if (needsRefresh) {
      const wasEmpty = !kitMappingsCache;
      await loadFromLocalDb();
      if (!wasEmpty) {
        log(`Cache was stale (${Math.round((Date.now() - (lastLoadedAt?.getTime() || 0)) / 1000 / 60)}+ min old), refreshed from local DB`);
      }
      return true;
    }
    return false;
  } catch (error) {
    log(`Error ensuring kit mappings fresh: ${error}`);
    return false;
  }
}

/**
 * Force refresh from local DB (for after sync completes)
 */
export async function forceRefreshKitMappings(): Promise<void> {
  await loadFromLocalDb();
  log('Force refresh from local DB complete');
}

/**
 * Check if a SKU is a kit (has components)
 */
export function isKit(sku: string): boolean {
  return kitMappingsCache?.has(sku) ?? false;
}

/**
 * Get kit components for a parent SKU
 */
export function getKitComponents(sku: string): KitComponent[] | undefined {
  return kitMappingsCache?.get(sku);
}

/**
 * Get parent kit SKUs that contain this component SKU (reverse lookup)
 */
export function getParentKitsForComponent(componentSku: string): string[] | undefined {
  return reverseComponentCache?.get(componentSku);
}

/**
 * Get all kit mappings (for bulk analysis)
 */
export function getAllKitMappings(): Map<string, KitComponent[]> | null {
  return kitMappingsCache;
}

/**
 * Get cache statistics
 */
export function getKitCacheStats(): {
  kitCount: number;
  snapshotTimestamp: string | null;
  lastLoadedAt: string | null;
} {
  return {
    kitCount: kitMappingsCache?.size ?? 0,
    snapshotTimestamp: null,
    lastLoadedAt: lastLoadedAt?.toISOString() ?? null,
  };
}
