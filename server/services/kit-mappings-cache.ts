/**
 * Kit Mappings Cache Service
 * 
 * Manages kit→component mappings with lazy loading:
 * 1. Local PostgreSQL table as persistent storage (kit_component_mappings)
 * 2. Hourly sync from GCP reporting database (full two-way sync with deletes)
 * 3. In-memory cache with lazy loading (check cache first, DB on miss)
 * 
 * Pattern: Cache-first with DB fallback
 * - Check in-memory cache first (O(1) lookup)
 * - On cache miss, query DB for that specific SKU
 * - If found in DB, add to cache and return
 * - If not in DB, cache the "miss" to avoid repeated queries
 */

import { db } from '../db';
import { kitComponentMappings } from '@shared/schema';
import { eq, inArray } from 'drizzle-orm';
import { reportingSql } from '../reporting-db';

const log = (message: string) => console.log(`[kit-mappings-cache] ${message}`);

export interface KitComponent {
  componentSku: string;
  componentQuantity: number;
}

// In-memory cache: SKU → components (empty array means "checked DB, not a kit")
const kitMappingsCache = new Map<string, KitComponent[]>();

// Reverse cache: component SKU → parent kit SKUs
const reverseComponentCache = new Map<string, string[]>();

// Track when we last did a full load (for stats only)
let lastFullLoadAt: Date | null = null;

/**
 * Load a single kit's components from DB into cache
 * Returns components if found, empty array if not a kit
 */
async function loadKitFromDb(sku: string): Promise<KitComponent[]> {
  try {
    const results = await db
      .select({
        componentSku: kitComponentMappings.componentSku,
        componentQuantity: kitComponentMappings.componentQuantity,
      })
      .from(kitComponentMappings)
      .where(eq(kitComponentMappings.kitSku, sku));
    
    const components: KitComponent[] = results.map(row => ({
      componentSku: row.componentSku,
      componentQuantity: row.componentQuantity,
    }));
    
    // Cache the result (even if empty - negative cache)
    kitMappingsCache.set(sku, components);
    
    // Update reverse cache for each component
    for (const comp of components) {
      if (!reverseComponentCache.has(comp.componentSku)) {
        reverseComponentCache.set(comp.componentSku, []);
      }
      const parents = reverseComponentCache.get(comp.componentSku)!;
      if (!parents.includes(sku)) {
        parents.push(sku);
      }
    }
    
    return components;
  } catch (error) {
    log(`Error loading kit ${sku} from DB: ${error}`);
    throw error;
  }
}

/**
 * Check if a SKU is a kit (has components)
 * Lazy-loads from DB on cache miss
 */
export async function isKit(sku: string): Promise<boolean> {
  // Check cache first
  if (kitMappingsCache.has(sku)) {
    const components = kitMappingsCache.get(sku)!;
    return components.length > 0;
  }
  
  // Cache miss - load from DB
  const components = await loadKitFromDb(sku);
  return components.length > 0;
}

/**
 * Get kit components for a parent SKU
 * Lazy-loads from DB on cache miss
 * Returns undefined if not a kit (no components)
 */
export async function getKitComponents(sku: string): Promise<KitComponent[] | undefined> {
  // Check cache first
  if (kitMappingsCache.has(sku)) {
    const components = kitMappingsCache.get(sku)!;
    return components.length > 0 ? components : undefined;
  }
  
  // Cache miss - load from DB
  const components = await loadKitFromDb(sku);
  return components.length > 0 ? components : undefined;
}

/**
 * Get parent kit SKUs that contain this component SKU (reverse lookup)
 * For this, we need to query the DB since we may not have loaded all kits yet
 */
export async function getParentKitsForComponent(componentSku: string): Promise<string[] | undefined> {
  // Check reverse cache first
  if (reverseComponentCache.has(componentSku)) {
    const parents = reverseComponentCache.get(componentSku)!;
    return parents.length > 0 ? parents : undefined;
  }
  
  // Cache miss - query DB for all kits containing this component
  try {
    const results = await db
      .select({
        kitSku: kitComponentMappings.kitSku,
      })
      .from(kitComponentMappings)
      .where(eq(kitComponentMappings.componentSku, componentSku));
    
    const parentSkus = results.map(r => r.kitSku);
    
    // Cache the result
    reverseComponentCache.set(componentSku, parentSkus);
    
    return parentSkus.length > 0 ? parentSkus : undefined;
  } catch (error) {
    log(`Error looking up parents for component ${componentSku}: ${error}`);
    return undefined;
  }
}

/**
 * Invalidate cache entries for specific SKUs
 * Called after GCP sync to ensure updated mappings are reloaded
 */
export function invalidateCacheEntries(skus: string[]): void {
  for (const sku of skus) {
    kitMappingsCache.delete(sku);
  }
  // Also clear reverse cache since parent relationships may have changed
  if (skus.length > 0) {
    reverseComponentCache.clear();
  }
}

/**
 * Clear entire cache (useful for testing or after major sync)
 */
export function clearCache(): void {
  kitMappingsCache.clear();
  reverseComponentCache.clear();
  log('Cache cleared');
}

/**
 * Sync kit mappings from GCP to local database
 * Full two-way sync: upserts new/changed records, deletes stale records
 * Invalidates cache for affected SKUs after sync
 */
export async function syncKitMappingsFromGcp(): Promise<{
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
  error?: string;
}> {
  const stats = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  const affectedSkus: string[] = [];
  
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
    const toUpdate: { id: string; componentQuantity: number; kitSku: string }[] = [];
    const toDelete: { id: string; kitSku: string }[] = [];
    
    for (const [key, gcpQty] of Array.from(gcpMappings.entries())) {
      const [kitSku, componentSku] = key.split('|');
      const local = localMappings.get(key);
      
      if (!local) {
        toInsert.push({ kitSku, componentSku, componentQuantity: gcpQty });
        if (!affectedSkus.includes(kitSku)) affectedSkus.push(kitSku);
      } else if (local.quantity !== gcpQty) {
        toUpdate.push({ id: local.id, componentQuantity: gcpQty, kitSku });
        if (!affectedSkus.includes(kitSku)) affectedSkus.push(kitSku);
      } else {
        stats.unchanged++;
      }
    }
    
    for (const [key, local] of Array.from(localMappings.entries())) {
      if (!gcpMappings.has(key)) {
        const [kitSku] = key.split('|');
        toDelete.push({ id: local.id, kitSku });
        if (!affectedSkus.includes(kitSku)) affectedSkus.push(kitSku);
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
        .where(inArray(kitComponentMappings.id, toDelete.map(d => d.id)));
      stats.deleted = toDelete.length;
      log(`Deleted ${toDelete.length} stale mappings`);
    }
    
    // Invalidate cache for affected SKUs so next lookup gets fresh data
    if (affectedSkus.length > 0) {
      invalidateCacheEntries(affectedSkus);
      log(`Invalidated cache for ${affectedSkus.length} affected kit SKUs`);
    }
    
    log(`Sync complete: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.deleted} deleted, ${stats.unchanged} unchanged`);
    
    return stats;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Sync error: ${errorMsg}`);
    return { ...stats, error: errorMsg };
  }
}

/**
 * Bulk preload kit mappings for a list of SKUs
 * Useful when you know you'll need multiple kit lookups
 * More efficient than individual lookups due to batch query
 */
export async function preloadKitMappings(skus: string[]): Promise<void> {
  // Filter to SKUs not already in cache
  const uncachedSkus = skus.filter(sku => !kitMappingsCache.has(sku));
  
  if (uncachedSkus.length === 0) return;
  
  try {
    const results = await db
      .select({
        kitSku: kitComponentMappings.kitSku,
        componentSku: kitComponentMappings.componentSku,
        componentQuantity: kitComponentMappings.componentQuantity,
      })
      .from(kitComponentMappings)
      .where(inArray(kitComponentMappings.kitSku, uncachedSkus));
    
    // Group results by kit SKU
    const groupedResults = new Map<string, KitComponent[]>();
    for (const row of results) {
      if (!groupedResults.has(row.kitSku)) {
        groupedResults.set(row.kitSku, []);
      }
      groupedResults.get(row.kitSku)!.push({
        componentSku: row.componentSku,
        componentQuantity: row.componentQuantity,
      });
    }
    
    // Add to cache (including negative entries for SKUs not found)
    for (const sku of uncachedSkus) {
      const components = groupedResults.get(sku) || [];
      kitMappingsCache.set(sku, components);
      
      // Update reverse cache
      for (const comp of components) {
        if (!reverseComponentCache.has(comp.componentSku)) {
          reverseComponentCache.set(comp.componentSku, []);
        }
        const parents = reverseComponentCache.get(comp.componentSku)!;
        if (!parents.includes(sku)) {
          parents.push(sku);
        }
      }
    }
    
    log(`Preloaded ${uncachedSkus.length} SKUs (${groupedResults.size} are kits)`);
  } catch (error) {
    log(`Error preloading kit mappings: ${error}`);
    throw error;
  }
}

/**
 * Get all kit mappings (loads everything from DB)
 * Use sparingly - mainly for bulk analysis or debugging
 */
export async function getAllKitMappings(): Promise<Map<string, KitComponent[]>> {
  try {
    const results = await db
      .select({
        kitSku: kitComponentMappings.kitSku,
        componentSku: kitComponentMappings.componentSku,
        componentQuantity: kitComponentMappings.componentQuantity,
      })
      .from(kitComponentMappings);
    
    const mappings = new Map<string, KitComponent[]>();
    
    for (const row of results) {
      if (!mappings.has(row.kitSku)) {
        mappings.set(row.kitSku, []);
      }
      mappings.get(row.kitSku)!.push({
        componentSku: row.componentSku,
        componentQuantity: row.componentQuantity,
      });
    }
    
    // Update cache with everything we loaded
    for (const [sku, components] of mappings) {
      kitMappingsCache.set(sku, components);
    }
    
    lastFullLoadAt = new Date();
    log(`Full load: ${mappings.size} kit mappings`);
    
    return mappings;
  } catch (error) {
    log(`Error loading all kit mappings: ${error}`);
    throw error;
  }
}

/**
 * Get cache statistics
 */
export function getKitCacheStats(): {
  cachedKitCount: number;
  cachedNonKitCount: number;
  totalCached: number;
  lastFullLoadAt: string | null;
} {
  let kitCount = 0;
  let nonKitCount = 0;
  
  for (const [, components] of kitMappingsCache) {
    if (components.length > 0) {
      kitCount++;
    } else {
      nonKitCount++;
    }
  }
  
  return {
    cachedKitCount: kitCount,
    cachedNonKitCount: nonKitCount,
    totalCached: kitMappingsCache.size,
    lastFullLoadAt: lastFullLoadAt?.toISOString() ?? null,
  };
}
