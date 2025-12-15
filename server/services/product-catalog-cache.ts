/**
 * Product Catalog Cache Service
 * 
 * Caches product catalog data and kit mappings from the reporting database (GCP PostgreSQL).
 * Uses Upstash Redis for distributed caching with date-based invalidation.
 * 
 * Two independent caches:
 * - Product Catalog: inventory_forecasts_daily (invalidates on new stock_check_date)
 * - Kit Mappings: vw_internal_kit_component_inventory_latest (invalidates on new snapshot_timestamp)
 */

import { reportingSql } from '../reporting-db';
import { getRedisClient } from '../utils/queue';
import { formatInTimeZone } from 'date-fns-tz';

const CST_TIMEZONE = 'America/Chicago';
const log = (message: string) => console.log(`[product-catalog-cache] ${message}`);

// Redis cache keys
const CACHE_PREFIX = 'qc_hydrator:';
const PRODUCT_CATALOG_KEY = `${CACHE_PREFIX}product_catalog`;
const KIT_MAPPINGS_KEY = `${CACHE_PREFIX}kit_mappings`;
const LATEST_DATES_KEY = `${CACHE_PREFIX}latest_dates`;

// Types for cached data
export interface ProductCatalogItem {
  sku: string;
  barcode: string | null;
  description: string | null;
  isAssembledProduct: boolean;
}

export interface KitComponent {
  componentSku: string;
  componentQuantity: number;
}

export interface KitMapping {
  parentSku: string;
  components: KitComponent[];
}

interface CachedDates {
  stockCheckDate: string | null;
  snapshotTimestamp: string | null;
}

// In-memory cache for faster access (Redis as source of truth)
let productCatalogCache: Map<string, ProductCatalogItem> | null = null;
let kitMappingsCache: Map<string, KitComponent[]> | null = null;
let cachedDates: CachedDates = { stockCheckDate: null, snapshotTimestamp: null };

/**
 * Get the latest stock_check_date from inventory_forecasts_daily
 */
async function getLatestStockCheckDate(): Promise<string | null> {
  try {
    const result = await reportingSql`
      SELECT MAX(stock_check_date) as latest_date
      FROM inventory_forecasts_daily
    `;
    if (!result[0]?.latest_date) return null;
    return formatInTimeZone(result[0].latest_date, CST_TIMEZONE, 'yyyy-MM-dd');
  } catch (error) {
    log(`Error fetching latest stock_check_date: ${error}`);
    return null;
  }
}

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
    // Use ISO string for timestamp
    return new Date(result[0].latest_timestamp).toISOString();
  } catch (error) {
    log(`Error fetching latest snapshot_timestamp: ${error}`);
    return null;
  }
}

/**
 * Fetch and cache product catalog from inventory_forecasts_daily
 * Joins with internal_inventory to get barcodes
 */
async function refreshProductCatalog(stockCheckDate: string): Promise<Map<string, ProductCatalogItem>> {
  log(`Refreshing product catalog for ${stockCheckDate}...`);
  
  const results = await reportingSql`
    SELECT 
      ifd.sku,
      ii.code as barcode,
      ifd.description,
      ifd.is_assembled_product
    FROM inventory_forecasts_daily ifd
    LEFT JOIN internal_inventory ii 
      ON ii.sku = ifd.sku 
      AND ii.snapshot_timestamp = ifd.stock_check_date
    WHERE ifd.stock_check_date = ${stockCheckDate}
  `;
  
  const catalog = new Map<string, ProductCatalogItem>();
  for (const row of results) {
    catalog.set(row.sku, {
      sku: row.sku,
      barcode: row.barcode || null,
      description: row.description || null,
      isAssembledProduct: row.is_assembled_product === true,
    });
  }
  
  log(`Cached ${catalog.size} products from catalog`);
  
  // Store in Redis
  const redis = getRedisClient();
  await redis.set(PRODUCT_CATALOG_KEY, Array.from(catalog.entries()));
  
  return catalog;
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
  
  // Store in Redis
  const redis = getRedisClient();
  await redis.set(KIT_MAPPINGS_KEY, Array.from(mappings.entries()));
  
  return mappings;
}

/**
 * Load caches from Redis into memory
 */
async function loadFromRedis(): Promise<void> {
  const redis = getRedisClient();
  
  // Load product catalog
  const catalogData = await redis.get<[string, ProductCatalogItem][]>(PRODUCT_CATALOG_KEY);
  if (catalogData) {
    productCatalogCache = new Map(catalogData);
    log(`Loaded ${productCatalogCache.size} products from Redis`);
  }
  
  // Load kit mappings
  const mappingsData = await redis.get<[string, KitComponent[]][]>(KIT_MAPPINGS_KEY);
  if (mappingsData) {
    kitMappingsCache = new Map(mappingsData);
    log(`Loaded ${kitMappingsCache.size} kit mappings from Redis`);
  }
  
  // Load cached dates
  const dates = await redis.get<CachedDates>(LATEST_DATES_KEY);
  if (dates) {
    cachedDates = dates;
    log(`Loaded cached dates: stock_check=${dates.stockCheckDate}, snapshot=${dates.snapshotTimestamp}`);
  }
}

/**
 * Check for new data and refresh caches if needed
 * Returns true if any cache was refreshed
 */
export async function ensureCacheFresh(): Promise<boolean> {
  let refreshed = false;
  
  try {
    // Check latest dates from reporting DB
    const [latestStockDate, latestSnapshot] = await Promise.all([
      getLatestStockCheckDate(),
      getLatestSnapshotTimestamp(),
    ]);
    
    // Load from Redis if memory cache is empty
    if (!productCatalogCache || !kitMappingsCache) {
      await loadFromRedis();
    }
    
    const redis = getRedisClient();
    
    // Check if product catalog needs refresh
    if (latestStockDate && latestStockDate !== cachedDates.stockCheckDate) {
      log(`New stock_check_date detected: ${latestStockDate} (was: ${cachedDates.stockCheckDate})`);
      productCatalogCache = await refreshProductCatalog(latestStockDate);
      cachedDates.stockCheckDate = latestStockDate;
      refreshed = true;
    }
    
    // Check if kit mappings need refresh
    if (latestSnapshot && latestSnapshot !== cachedDates.snapshotTimestamp) {
      log(`New snapshot_timestamp detected: ${latestSnapshot} (was: ${cachedDates.snapshotTimestamp})`);
      kitMappingsCache = await refreshKitMappings(latestSnapshot);
      cachedDates.snapshotTimestamp = latestSnapshot;
      refreshed = true;
    }
    
    // Update cached dates in Redis
    if (refreshed) {
      await redis.set(LATEST_DATES_KEY, cachedDates);
    }
    
  } catch (error) {
    log(`Error checking cache freshness: ${error}`);
  }
  
  return refreshed;
}

/**
 * Get product info by SKU
 */
export function getProduct(sku: string): ProductCatalogItem | undefined {
  return productCatalogCache?.get(sku);
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
export function getCacheStats(): {
  productCount: number;
  kitCount: number;
  stockCheckDate: string | null;
  snapshotTimestamp: string | null;
} {
  return {
    productCount: productCatalogCache?.size ?? 0,
    kitCount: kitMappingsCache?.size ?? 0,
    stockCheckDate: cachedDates.stockCheckDate,
    snapshotTimestamp: cachedDates.snapshotTimestamp,
  };
}

/**
 * Force refresh both caches (for manual trigger)
 */
export async function forceRefresh(): Promise<void> {
  const [latestStockDate, latestSnapshot] = await Promise.all([
    getLatestStockCheckDate(),
    getLatestSnapshotTimestamp(),
  ]);
  
  if (latestStockDate) {
    productCatalogCache = await refreshProductCatalog(latestStockDate);
    cachedDates.stockCheckDate = latestStockDate;
  }
  
  if (latestSnapshot) {
    kitMappingsCache = await refreshKitMappings(latestSnapshot);
    cachedDates.snapshotTimestamp = latestSnapshot;
  }
  
  const redis = getRedisClient();
  await redis.set(LATEST_DATES_KEY, cachedDates);
  
  log('Force refresh complete');
}
