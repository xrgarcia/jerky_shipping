/**
 * Kit Mappings Cache Service
 * 
 * Caches kit→component mappings from the reporting database (GCP PostgreSQL).
 * Uses Upstash Redis for distributed caching with timestamp-based invalidation.
 * 
 * This is the ONLY data that needs to come from GCP - product catalog data
 * now comes from the local skuvault_products table (synced hourly).
 */

import { reportingSql } from '../reporting-db';
import { getRedisClient } from '../utils/queue';

const log = (message: string) => console.log(`[kit-mappings-cache] ${message}`);

const CACHE_PREFIX = 'kit_mappings:';
const KIT_MAPPINGS_KEY = `${CACHE_PREFIX}data`;
const SNAPSHOT_TIMESTAMP_KEY = `${CACHE_PREFIX}snapshot_timestamp`;

export interface KitComponent {
  componentSku: string;
  componentQuantity: number;
}

let kitMappingsCache: Map<string, KitComponent[]> | null = null;
let cachedSnapshotTimestamp: string | null = null;

/**
 * Get the latest snapshot_timestamp from vw_internal_kit_component_inventory_latest
 */
async function getLatestSnapshotTimestamp(): Promise<string | null> {
  try {
    const result = await reportingSql`
      SELECT MAX(snapshot_timestamp) as latest_timestamp
      FROM vw_internal_kit_component_inventory_latest
    `;
    if (!result[0]?.latest_timestamp) return null;
    return new Date(result[0].latest_timestamp).toISOString();
  } catch (error) {
    log(`Error fetching latest snapshot_timestamp: ${error}`);
    return null;
  }
}

/**
 * Fetch and cache kit mappings from vw_internal_kit_component_inventory_latest
 */
async function refreshKitMappings(snapshotTimestamp: string): Promise<Map<string, KitComponent[]>> {
  log(`Refreshing kit mappings for ${snapshotTimestamp}...`);
  
  const results = await reportingSql`
    SELECT 
      sku as parent_sku,
      component_sku,
      component_quantity
    FROM vw_internal_kit_component_inventory_latest
    WHERE snapshot_timestamp = ${snapshotTimestamp}
    ORDER BY sku, component_sku
  `;
  
  const mappings = new Map<string, KitComponent[]>();
  for (const row of results) {
    const parentSku = row.parent_sku;
    const component: KitComponent = {
      componentSku: row.component_sku,
      componentQuantity: row.component_quantity || 1,
    };
    
    if (!mappings.has(parentSku)) {
      mappings.set(parentSku, []);
    }
    mappings.get(parentSku)!.push(component);
  }
  
  log(`Cached ${mappings.size} kit mappings`);
  
  const redis = getRedisClient();
  await redis.set(KIT_MAPPINGS_KEY, Array.from(mappings.entries()));
  
  return mappings;
}

/**
 * Load kit mappings from Redis into memory
 */
async function loadFromRedis(): Promise<void> {
  const redis = getRedisClient();
  
  const mappingsData = await redis.get<[string, KitComponent[]][]>(KIT_MAPPINGS_KEY);
  if (mappingsData) {
    kitMappingsCache = new Map(mappingsData);
    log(`Loaded ${kitMappingsCache.size} kit mappings from Redis`);
  }
  
  const timestamp = await redis.get<string>(SNAPSHOT_TIMESTAMP_KEY);
  if (timestamp) {
    cachedSnapshotTimestamp = timestamp;
    log(`Loaded cached snapshot timestamp: ${timestamp}`);
  }
}

/**
 * Check for new kit mapping data and refresh cache if needed
 * Returns true if cache was refreshed
 */
export async function ensureKitMappingsFresh(): Promise<boolean> {
  try {
    const latestSnapshot = await getLatestSnapshotTimestamp();
    
    if (!kitMappingsCache) {
      await loadFromRedis();
    }
    
    if (latestSnapshot && latestSnapshot !== cachedSnapshotTimestamp) {
      log(`New snapshot_timestamp detected: ${latestSnapshot} (was: ${cachedSnapshotTimestamp})`);
      kitMappingsCache = await refreshKitMappings(latestSnapshot);
      cachedSnapshotTimestamp = latestSnapshot;
      
      const redis = getRedisClient();
      await redis.set(SNAPSHOT_TIMESTAMP_KEY, latestSnapshot);
      
      return true;
    }
    
    return false;
  } catch (error) {
    log(`Error checking kit mappings freshness: ${error}`);
    return false;
  }
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
 * Get cache statistics
 */
export function getKitCacheStats(): {
  kitCount: number;
  snapshotTimestamp: string | null;
} {
  return {
    kitCount: kitMappingsCache?.size ?? 0,
    snapshotTimestamp: cachedSnapshotTimestamp,
  };
}

/**
 * Force refresh kit mappings (for manual trigger)
 */
export async function forceRefreshKitMappings(): Promise<void> {
  const latestSnapshot = await getLatestSnapshotTimestamp();
  
  if (latestSnapshot) {
    kitMappingsCache = await refreshKitMappings(latestSnapshot);
    cachedSnapshotTimestamp = latestSnapshot;
    
    const redis = getRedisClient();
    await redis.set(SNAPSHOT_TIMESTAMP_KEY, latestSnapshot);
  }
  
  log('Force refresh complete');
}
