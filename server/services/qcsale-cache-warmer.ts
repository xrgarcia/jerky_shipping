/**
 * QCSale Cache Warmer Service
 * 
 * Proactively warms the cache for orders that are ready to be packed.
 * This dramatically reduces SkuVault API calls during active packing operations.
 * 
 * WAREHOUSE SESSION LIFECYCLE (Critical System Knowledge):
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │   SESSION STATUS    │  TRACKING   │  WAREHOUSE STATE       │  SYSTEM ACTION│
 * │   ──────────────────┼─────────────┼────────────────────────┼───────────────│
 * │   "new"             │  -          │  Ready to be picked    │  Pick queue   │
 * │   "active"          │  -          │  Being picked now      │  In progress  │
 * │   "inactive"        │  -          │  ⚠️ PAUSED/STUCK       │  FLAG IT!     │
 * │   "closed"          │  NULL       │  ✅ READY TO PACK      │  WARM CACHE   │
 * │   "closed"          │  Has value  │  Ready for carrier     │  INVALIDATE   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 * 
 * Key Features:
 * - Extended TTL (10 minutes) for pre-warmed cache entries
 * - Background polling every 30 seconds to catch eligible orders
 * - Redis tracking to prevent duplicate SkuVault API calls
 * - Immediate cache warming when session transitions to 'closed'
 * - Cache invalidation when label/tracking is created
 * - Manual refresh capability for customer service order changes
 */

import { getRedisClient } from '../utils/queue';
import { db } from '../db';
import { shipments } from '@shared/schema';
import { eq, and, isNull, isNotNull, ne, sql, inArray } from 'drizzle-orm';
import { skuVaultService } from './skuvault-service';

const log = (message: string) => console.log(`[QCSaleWarmer] ${message}`);
const error = (message: string) => console.error(`[QCSaleWarmer] ${message}`);

// Constants
const WARM_CACHE_KEY_PREFIX = 'skuvault:qcsale:warm:';
const WARM_TTL_SECONDS = 172800; // 48 hours for pre-warmed entries
// Note: Previously used WARMED_SET_KEY for tracking, but removed because Redis sets
// don't have per-member TTLs, causing orders to stay "warmed" after cache expires.
// Now we only check redis.exists() on the actual cache key which respects TTL.
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_ORDERS_PER_POLL = 10; // Limit API calls per poll cycle

// Metrics
interface CacheWarmerMetrics {
  ordersWarmed: number;
  cacheHits: number;
  cacheMisses: number;
  invalidations: number;
  manualRefreshes: number;
  apiCallsSaved: number;
  legacyUpgrades: number;
  legacyUpgradeFailures: number;
  lastPollAt: Date | null;
  workerStatus: 'sleeping' | 'running' | 'error';
  lastError: string | null;
}

let metrics: CacheWarmerMetrics = {
  ordersWarmed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  invalidations: 0,
  manualRefreshes: 0,
  apiCallsSaved: 0,
  legacyUpgrades: 0,
  legacyUpgradeFailures: 0,
  lastPollAt: null,
  workerStatus: 'sleeping',
  lastError: null,
};

let pollIntervalId: NodeJS.Timeout | null = null;

/**
 * Get the warm cache key for an order
 */
function getWarmCacheKey(orderNumber: string): string {
  return `${WARM_CACHE_KEY_PREFIX}${orderNumber}`;
}

/**
 * Build flattened barcode lookup map from QCSale data
 * This is the same structure used by the regular QCSaleCache
 * 
 * IMPORTANT Kit handling:
 * - Parent kit SKUs are NOT added to the lookup map (they're not scannable)
 * - Only kit component barcodes/SKUs are added
 * - component.Quantity is already the TOTAL needed (pre-multiplied by kit qty ordered)
 */
function buildLookupMap(qcSale: import('@shared/skuvault-types').QCSale): Record<string, any> {
  const saleId = qcSale.SaleId || '';
  const lookupMap: Record<string, any> = {};
  
  for (const item of qcSale.Items || []) {
    const isKit = item.KitProducts && item.KitProducts.length > 0;
    
    // For kit items, ONLY add component entries - the parent kit SKU itself is not scannable
    // For regular items, add the item's Code/SKU/PartNumber entries
    if (!isKit) {
      const regularItemResult = {
        found: true,
        sku: item.Sku || '',
        code: item.Code || null,
        title: item.Title || null,
        quantity: item.Quantity || 1,
        itemId: item.Id || null,
        saleId,
        isKitComponent: false,
      };
      
      // Add by Code (barcode)
      if (item.Code) {
        lookupMap[item.Code.toUpperCase()] = regularItemResult;
      }
      
      // Add by SKU
      if (item.Sku) {
        lookupMap[item.Sku.toUpperCase()] = regularItemResult;
      }
      
      // Add by PartNumber (UPC barcode)
      if (item.PartNumber) {
        lookupMap[item.PartNumber.toUpperCase()] = regularItemResult;
      }
    }
    
    // Add kit component items (only for kits)
    if (isKit && item.KitProducts) {
      for (const component of item.KitProducts) {
        const componentResult = {
          found: true,
          sku: component.Sku || '',
          code: component.Code || null,
          title: component.Title || null,
          quantity: component.Quantity || 1,
          itemId: component.Id || null,
          saleId,
          isKitComponent: true,
          kitId: item.Id || null,
          kitSku: item.Sku || null,
          kitTitle: item.Title || null,
        };
        
        if (component.Code) {
          lookupMap[component.Code.toUpperCase()] = componentResult;
        }
        if (component.Sku) {
          lookupMap[component.Sku.toUpperCase()] = componentResult;
        }
        if (component.PartNumber) {
          lookupMap[component.PartNumber.toUpperCase()] = componentResult;
        }
      }
    }
    
    // AlternateCodes
    if (item.AlternateCodes) {
      for (const altCode of item.AlternateCodes) {
        // Defensive check: ensure altCode is a string before calling toUpperCase
        if (altCode && typeof altCode === 'string' && !lookupMap[altCode.toUpperCase()]) {
          lookupMap[altCode.toUpperCase()] = {
            found: true,
            sku: item.Sku || '',
            code: altCode,
            title: item.Title || null,
            quantity: item.Quantity || 1,
            itemId: item.Id || null,
            saleId,
            isKitComponent: false,
          };
        }
      }
    }
  }
  
  return lookupMap;
}

/**
 * Warm the cache for a single order by fetching QCSale data from SkuVault
 * Uses extended TTL for pre-warmed entries
 */
export async function warmCacheForOrder(orderNumber: string, force: boolean = false): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const warmKey = getWarmCacheKey(orderNumber);
    
    // Check if already in cache (unless forcing refresh)
    // This check respects the TTL, so expired entries get re-warmed.
    if (!force) {
      const exists = await redis.exists(warmKey);
      if (exists > 0) {
        log(`Order ${orderNumber} already in cache, skipping`);
        metrics.apiCallsSaved++;
        return true;
      }
    }
    
    // Fetch QCSale data from SkuVault AND shipment data from PostgreSQL in parallel
    log(`Warming cache for order ${orderNumber}${force ? ' (forced refresh)' : ''}...`);
    
    const [qcSale, shipmentResults] = await Promise.all([
      skuVaultService.getQCSalesByOrderNumber(orderNumber),
      db.select().from(shipments).where(eq(shipments.orderNumber, orderNumber)).limit(1),
    ]);
    
    if (!qcSale) {
      log(`No QCSale data found for order ${orderNumber}`);
      return false;
    }
    
    const shipment = shipmentResults[0] || null;
    
    // Build cache data with lookup map AND shipment data
    const lookupMap = buildLookupMap(qcSale);
    const cacheData = {
      saleId: qcSale.SaleId || '',
      orderNumber,
      cachedAt: Date.now(),
      warmedAt: Date.now(),
      lookupMap,
      // Store full QCSale for validation endpoint
      qcSale: {
        SaleId: qcSale.SaleId,
        OrderId: qcSale.OrderId,
        Status: qcSale.Status,
        TotalItems: qcSale.TotalItems,
        PassedItems: qcSale.PassedItems,
        Items: qcSale.Items,
      },
      // Store shipment data to eliminate PostgreSQL query during order load
      shipment: shipment ? {
        id: shipment.id,
        orderNumber: shipment.orderNumber,
        orderId: shipment.orderId,
        carrierCode: shipment.carrierCode,
        serviceCode: shipment.serviceCode,
        shipmentStatus: shipment.shipmentStatus,
        // Recipient address (ship_to fields)
        shipToName: shipment.shipToName,
        shipToCompany: shipment.shipToCompany,
        shipToAddressLine1: shipment.shipToAddressLine1,
        shipToAddressLine2: shipment.shipToAddressLine2,
        shipToCity: shipment.shipToCity,
        shipToState: shipment.shipToState,
        shipToPostalCode: shipment.shipToPostalCode,
        shipToCountry: shipment.shipToCountry,
        shipToPhone: shipment.shipToPhone,
        totalWeight: shipment.totalWeight,
        shipDate: shipment.shipDate,
        trackingNumber: shipment.trackingNumber,
        shipmentId: shipment.shipmentId,
        sessionStatus: shipment.sessionStatus,
        cacheWarmedAt: shipment.cacheWarmedAt,
      } : null,
    };
    
    // Store with extended TTL
    await redis.set(warmKey, JSON.stringify(cacheData), { ex: WARM_TTL_SECONDS });
    
    // Update the shipment record with cache_warmed_at timestamp for visibility
    try {
      await db.update(shipments)
        .set({ cacheWarmedAt: new Date() })
        .where(eq(shipments.orderNumber, orderNumber));
    } catch (dbErr: any) {
      // Non-critical - don't fail warming if DB update fails
      error(`Failed to update cacheWarmedAt for ${orderNumber}: ${dbErr.message}`);
    }
    
    log(`Cached order ${orderNumber} with ${Object.keys(lookupMap).length} barcode/SKU entries + shipment data (${WARM_TTL_SECONDS}s TTL)`);
    
    if (force) {
      metrics.manualRefreshes++;
    } else {
      metrics.ordersWarmed++;
    }
    
    return true;
  } catch (err: any) {
    error(`Failed to warm cache for order ${orderNumber}: ${err.message}`);
    metrics.lastError = err.message;
    return false;
  }
}

/**
 * Invalidate cache for an order (e.g., when label is created)
 * Called when tracking number is assigned
 */
export async function invalidateCacheForOrder(orderNumber: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const warmKey = getWarmCacheKey(orderNumber);
    
    // Remove from warm cache
    await redis.del(warmKey);
    
    // Also clear the regular QCSale cache key
    const regularKey = `skuvault:qcsale:${orderNumber}`;
    await redis.del(regularKey);
    
    // Clear the cacheWarmedAt timestamp in the database
    try {
      await db.update(shipments)
        .set({ cacheWarmedAt: null })
        .where(eq(shipments.orderNumber, orderNumber));
    } catch (dbErr: any) {
      // Non-critical - don't fail invalidation if DB update fails
      error(`Failed to clear cacheWarmedAt for ${orderNumber}: ${dbErr.message}`);
    }
    
    log(`Invalidated cache for order ${orderNumber}`);
    metrics.invalidations++;
  } catch (err: any) {
    error(`Failed to invalidate cache for order ${orderNumber}: ${err.message}`);
  }
}

/**
 * Manual refresh - forces a fresh fetch from SkuVault
 * Used when customer service makes order changes
 */
export async function refreshCacheForOrder(orderNumber: string): Promise<boolean> {
  log(`Manual refresh requested for order ${orderNumber}`);
  return warmCacheForOrder(orderNumber, true);
}

/**
 * Passed item data for cache update after a successful scan
 */
interface PassedItemUpdate {
  orderNumber: string;
  sku: string;
  code?: string | null;       // Barcode
  scannedCode?: string;       // What was actually scanned
  quantity: number;
  itemId?: string | null;     // SkuVault Item ID
  kitId?: string | null;      // For kit components
  userName?: string;          // Who scanned it
}

/**
 * Update the cache after a successful SkuVault passQCItem/passKitQCItem call
 * Adds the passed item to the cached PassedItems array so it persists across page reloads
 * 
 * This is critical for keeping cache, events, and SkuVault in sync:
 * 1. SkuVault API call succeeds (item marked as passed in SkuVault)
 * 2. Event logged (shipment_events table)
 * 3. Cache updated (this function) - so reload shows correct progress
 */
export async function updateCacheAfterScan(passedItem: PassedItemUpdate): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const warmKey = getWarmCacheKey(passedItem.orderNumber);
    
    // Get current cached data
    const cached = await redis.get(warmKey);
    if (!cached) {
      log(`No cache found for order ${passedItem.orderNumber} - cannot update after scan`);
      return false;
    }
    
    // Handle both string and object return types from Redis
    const cacheData = typeof cached === 'string' ? JSON.parse(cached) : cached;
    
    // Ensure qcSale and PassedItems exist
    if (!cacheData.qcSale) {
      log(`Cache for ${passedItem.orderNumber} has no qcSale data - cannot update`);
      return false;
    }
    
    // Initialize PassedItems array if it doesn't exist
    if (!cacheData.qcSale.PassedItems) {
      cacheData.qcSale.PassedItems = [];
    }
    
    // Create the passed item entry matching SkuVault's PassedItem structure
    const passedEntry = {
      KitId: passedItem.kitId || null,
      Code: passedItem.code || null,
      ScannedCode: passedItem.scannedCode || passedItem.sku,
      Sku: passedItem.sku,
      Quantity: passedItem.quantity,
      ItemId: passedItem.itemId || null,
      UserName: passedItem.userName || null,
      DateTimeUtc: new Date().toISOString(),
    };
    
    // Add to PassedItems array
    cacheData.qcSale.PassedItems.push(passedEntry);
    
    // Update the cachedAt timestamp
    cacheData.cachedAt = Date.now();
    
    // Save back to Redis with same TTL
    await redis.set(warmKey, JSON.stringify(cacheData), { ex: WARM_TTL_SECONDS });
    
    log(`Updated cache for ${passedItem.orderNumber}: added passed item ${passedItem.sku} (total passed: ${cacheData.qcSale.PassedItems.length})`);
    return true;
  } catch (err: any) {
    error(`Failed to update cache after scan for ${passedItem.orderNumber}: ${err.message}`);
    return false;
  }
}

// Track in-flight legacy upgrades to prevent concurrent upgrades for the same order
// Note: This is an in-memory guard for single-process deployments.
// For multi-worker scenarios, use Redis SETNX-based locking.
const pendingUpgrades = new Set<string>();

/**
 * Background upgrade for legacy cache entries
 * Fire-and-forget with concurrency guard and retry logic
 */
function upgradeLegacyCacheInBackground(orderNumber: string): void {
  // Check if upgrade already in progress for this order
  if (pendingUpgrades.has(orderNumber)) {
    log(`Legacy upgrade already in progress for ${orderNumber}, skipping`);
    return;
  }
  
  // Mark as in-progress BEFORE starting async work
  pendingUpgrades.add(orderNumber);
  
  // Fire-and-forget async upgrade
  (async () => {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1000;
    
    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          log(`Legacy upgrade attempt ${attempt}/${MAX_RETRIES} for ${orderNumber}`);
          const success = await warmCacheForOrder(orderNumber, true);
          if (success) {
            log(`Legacy cache upgraded successfully for ${orderNumber}`);
            metrics.legacyUpgrades++;
            return;
          }
        } catch (err: any) {
          error(`Legacy upgrade attempt ${attempt} failed for ${orderNumber}: ${err.message}`);
          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
          }
        }
      }
      metrics.legacyUpgradeFailures++;
      error(`Legacy upgrade exhausted all retries for ${orderNumber}`);
    } finally {
      // Always clean up the guard, even on unexpected errors
      pendingUpgrades.delete(orderNumber);
    }
  })();
}

/**
 * Get warm cache data for an order
 * Returns null if not in warm cache
 * 
 * CACHE UPGRADE: If the cached entry is a legacy entry (missing 'shipment' key entirely),
 * the upgrade is triggered in the background (non-blocking) and stale data is returned immediately.
 * Note: A cache entry with `shipment: null` is NOT legacy - it means no shipment exists in DB.
 */
export async function getWarmCache(orderNumber: string): Promise<any | null> {
  try {
    const redis = getRedisClient();
    const warmKey = getWarmCacheKey(orderNumber);
    
    const cacheData = await redis.get(warmKey);
    if (!cacheData) {
      metrics.cacheMisses++;
      return null;
    }
    
    // Upstash Redis auto-parses JSON
    const parsed = typeof cacheData === 'string' ? JSON.parse(cacheData) : cacheData;
    
    // CACHE UPGRADE: Check if this is a LEGACY entry (missing 'shipment' key entirely)
    // New cache entries have `shipment: null` when no shipment exists - that's NOT legacy
    // Legacy entries don't have the 'shipment' key at all
    const isLegacyEntry = parsed.qcSale && !('shipment' in parsed);
    
    if (isLegacyEntry) {
      log(`Legacy cache entry for ${orderNumber} - triggering background upgrade`);
      // NON-BLOCKING: Fire off upgrade in background, return stale data immediately
      // This avoids the 6-second blocking call for SkuVault API
      upgradeLegacyCacheInBackground(orderNumber);
    }
    
    metrics.cacheHits++;
    metrics.apiCallsSaved++;
    
    return parsed;
  } catch (err: any) {
    error(`Failed to get warm cache for order ${orderNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Look up a barcode/SKU in the warm cache
 */
export async function lookupInWarmCache(orderNumber: string, barcodeOrSku: string): Promise<any | null> {
  const cacheData = await getWarmCache(orderNumber);
  if (!cacheData) return null;
  
  const key = barcodeOrSku.toUpperCase();
  if (cacheData.lookupMap && cacheData.lookupMap[key]) {
    log(`Warm cache hit for ${barcodeOrSku} in order ${orderNumber}`);
    return cacheData.lookupMap[key];
  }
  
  log(`Barcode ${barcodeOrSku} not found in warm cache for order ${orderNumber}`);
  return { found: false, saleId: cacheData.saleId };
}

/**
 * Get shipments that are ready to pack (closed session, no tracking, pending status)
 * These are the orders we should pre-warm the cache for
 * Uses shipmentStatus IN ('pending', 'label_pending') to support both old and new status values
 * 
 * NOTE: We don't filter by cacheWarmedAt here because the DB and Redis can get out of sync
 * (e.g., Redis restart/eviction). Instead, we return all packable orders and let
 * warmCacheForOrder() check if Redis actually has the cache.
 */
export async function getReadyToPackShipments(limit: number = MAX_ORDERS_PER_POLL): Promise<string[]> {
  try {
    const result = await db
      .select({ orderNumber: shipments.orderNumber })
      .from(shipments)
      .where(
        and(
          // Session is closed (picking complete)
          eq(shipments.sessionStatus, 'closed'),
          // No tracking number (not yet labeled)
          isNull(shipments.trackingNumber),
          // Pending status (not yet shipped) - support both old and new values
          inArray(shipments.shipmentStatus, ['pending', 'label_pending']),
          // Has a session ID
          isNotNull(shipments.sessionId)
        )
      )
      .limit(limit);
    
    return result.map(r => r.orderNumber).filter(Boolean) as string[];
  } catch (err: any) {
    error(`Failed to get ready-to-pack shipments: ${err.message}`);
    return [];
  }
}

/**
 * Get shipments with inactive session status (stuck mid-pick)
 * These should be flagged for supervisor attention
 */
export async function getInactiveSessionShipments(): Promise<Array<{ orderNumber: string; sessionId: string | null; pickedByUserName: string | null }>> {
  try {
    const result = await db
      .select({
        orderNumber: shipments.orderNumber,
        sessionId: shipments.sessionId,
        pickedByUserName: shipments.pickedByUserName,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.sessionStatus, 'inactive'),
          isNotNull(shipments.sessionId)
        )
      );
    
    return result.filter(r => r.orderNumber) as Array<{ orderNumber: string; sessionId: string | null; pickedByUserName: string | null }>;
  } catch (err: any) {
    error(`Failed to get inactive session shipments: ${err.message}`);
    return [];
  }
}

/**
 * Poll for ready-to-pack orders and warm their cache
 * Called on interval (every 30 seconds)
 */
async function pollAndWarm(): Promise<void> {
  try {
    metrics.workerStatus = 'running';
    metrics.lastPollAt = new Date();
    
    const orderNumbers = await getReadyToPackShipments();
    
    if (orderNumbers.length === 0) {
      log('No orders ready to pack');
      metrics.workerStatus = 'sleeping';
      return;
    }
    
    log(`Found ${orderNumbers.length} orders ready to pack, warming cache...`);
    
    let warmed = 0;
    for (const orderNumber of orderNumbers) {
      const success = await warmCacheForOrder(orderNumber);
      if (success) warmed++;
      
      // Small delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    log(`Warmed cache for ${warmed}/${orderNumbers.length} orders`);
    metrics.workerStatus = 'sleeping';
  } catch (err: any) {
    error(`Poll and warm error: ${err.message}`);
    metrics.workerStatus = 'error';
    metrics.lastError = err.message;
  }
}

/**
 * Start the cache warmer worker
 * Polls every 30 seconds for ready-to-pack orders
 */
export function startCacheWarmer(): void {
  if (pollIntervalId) {
    log('Cache warmer already running');
    return;
  }
  
  log('Starting QCSale cache warmer...');
  
  // Initial poll
  pollAndWarm();
  
  // Set up interval
  pollIntervalId = setInterval(pollAndWarm, POLL_INTERVAL_MS);
  
  log(`Cache warmer started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the cache warmer worker
 */
export function stopCacheWarmer(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    log('Cache warmer stopped');
  }
}

/**
 * Get cache warmer metrics
 */
export function getCacheWarmerMetrics(): CacheWarmerMetrics {
  return { ...metrics };
}

/**
 * Batch check warm cache status for multiple order numbers
 * Returns a map of orderNumber -> { isWarmed, warmedAt }
 */
export async function getWarmCacheStatusBatch(orderNumbers: string[]): Promise<Map<string, { isWarmed: boolean; warmedAt: number | null }>> {
  const results = new Map<string, { isWarmed: boolean; warmedAt: number | null }>();
  
  if (!orderNumbers.length) {
    return results;
  }
  
  try {
    const redis = getRedisClient();
    
    // Check all order numbers in parallel
    await Promise.all(
      orderNumbers.map(async (orderNumber) => {
        const warmKey = getWarmCacheKey(orderNumber);
        const cacheData = await redis.get(warmKey);
        
        if (cacheData) {
          const parsed = typeof cacheData === 'string' ? JSON.parse(cacheData) : cacheData;
          results.set(orderNumber, {
            isWarmed: true,
            warmedAt: parsed.warmedAt || parsed.cachedAt || null,
          });
        } else {
          results.set(orderNumber, {
            isWarmed: false,
            warmedAt: null,
          });
        }
      })
    );
    
    return results;
  } catch (err: any) {
    error(`Failed to batch check warm cache status: ${err.message}`);
    // Return all as not warmed on error
    orderNumbers.forEach(orderNumber => {
      results.set(orderNumber, { isWarmed: false, warmedAt: null });
    });
    return results;
  }
}

/**
 * Called when a session transitions to 'closed' to immediately warm the cache
 * Hook this into the Firestore session sync worker
 */
export async function onSessionClosed(orderNumber: string, hasTrackingNumber: boolean): Promise<void> {
  if (hasTrackingNumber) {
    // Already has tracking, invalidate instead
    await invalidateCacheForOrder(orderNumber);
  } else {
    // Ready to pack, warm the cache
    await warmCacheForOrder(orderNumber);
  }
}

/**
 * Called when a label is created (tracking number assigned)
 * Invalidates the cache for this order
 */
export async function onLabelCreated(orderNumber: string): Promise<void> {
  await invalidateCacheForOrder(orderNumber);
}
