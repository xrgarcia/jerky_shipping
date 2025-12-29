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
let reverseComponentCache: Map<string, string[]> | null = null; // component SKU → parent kit SKUs
let cachedSnapshotTimestamp: string | null = null;

/**
 * Get the latest snapshot_timestamp from vw_internal_kit_component_inventory_latest
 * Returns the exact timestamp string from the database without any timezone conversion
 */
async function getLatestSnapshotTimestamp(): Promise<string | null> {
  try {
    // Get the exact timestamp as a string without any JavaScript Date conversion
    const result = await reportingSql`
      SELECT MAX(snapshot_timestamp)::text as latest_timestamp
      FROM vw_internal_kit_component_inventory_latest
    `;
    if (!result[0]?.latest_timestamp) return null;
    // Return the exact string from the database - do NOT convert to Date/ISO
    return result[0].latest_timestamp;
  } catch (error) {
    log(`Error fetching latest snapshot_timestamp: ${error}`);
    return null;
  }
}

/**
 * Fetch and cache kit mappings from vw_internal_kit_component_inventory_latest
 * Uses the exact timestamp string from the database for matching
 */
async function refreshKitMappings(snapshotTimestamp: string): Promise<Map<string, KitComponent[]>> {
  log(`Refreshing kit mappings for snapshot: ${snapshotTimestamp}...`);
  
  // Use the exact timestamp string for matching - cast to timestamp for proper comparison
  const results = await reportingSql`
    SELECT 
      sku as parent_sku,
      component_sku,
      component_quantity
    FROM vw_internal_kit_component_inventory_latest
    WHERE snapshot_timestamp::text = ${snapshotTimestamp}
    ORDER BY sku, component_sku
  `;
  
  const mappings = new Map<string, KitComponent[]>();
  const reverseMap = new Map<string, string[]>();
  
  for (const row of results) {
    const parentSku = row.parent_sku;
    const componentSku = row.component_sku;
    const component: KitComponent = {
      componentSku,
      componentQuantity: row.component_quantity || 1,
    };
    
    // Forward mapping: parent → components
    if (!mappings.has(parentSku)) {
      mappings.set(parentSku, []);
    }
    mappings.get(parentSku)!.push(component);
    
    // Reverse mapping: component → parent kits
    if (!reverseMap.has(componentSku)) {
      reverseMap.set(componentSku, []);
    }
    if (!reverseMap.get(componentSku)!.includes(parentSku)) {
      reverseMap.get(componentSku)!.push(parentSku);
    }
  }
  
  // Update reverse cache
  reverseComponentCache = reverseMap;
  
  log(`Cached ${mappings.size} kit mappings, ${reverseMap.size} component→kit reverse mappings`);
  
  const redis = getRedisClient();
  await redis.set(KIT_MAPPINGS_KEY, Array.from(mappings.entries()));
  
  return mappings;
}

/**
 * Load kit mappings from Redis into memory and rebuild reverse cache
 */
async function loadFromRedis(): Promise<void> {
  const redis = getRedisClient();
  
  const mappingsData = await redis.get<[string, KitComponent[]][]>(KIT_MAPPINGS_KEY);
  if (mappingsData) {
    kitMappingsCache = new Map(mappingsData);
    
    // Rebuild reverse cache from forward mappings
    reverseComponentCache = new Map();
    for (const [parentSku, components] of kitMappingsCache) {
      for (const component of components) {
        if (!reverseComponentCache.has(component.componentSku)) {
          reverseComponentCache.set(component.componentSku, []);
        }
        if (!reverseComponentCache.get(component.componentSku)!.includes(parentSku)) {
          reverseComponentCache.get(component.componentSku)!.push(parentSku);
        }
      }
    }
    
    log(`Loaded ${kitMappingsCache.size} kit mappings, rebuilt ${reverseComponentCache.size} reverse mappings from Redis`);
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
 * Get parent kit SKUs that contain this component SKU (reverse lookup)
 * Returns an array of parent kit SKUs, or undefined if not found
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
