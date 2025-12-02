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
import { eq, and, isNull, isNotNull, ne, or } from 'drizzle-orm';
import { skuVaultService } from './skuvault-service';

const log = (message: string) => console.log(`[QCSaleWarmer] ${message}`);
const error = (message: string) => console.error(`[QCSaleWarmer] ${message}`);

// Constants
const WARM_CACHE_KEY_PREFIX = 'skuvault:qcsale:warm:';
const WARM_TTL_SECONDS = 600; // 10 minutes for pre-warmed entries (vs 2 min for regular cache)
const WARMED_SET_KEY = 'skuvault:qcsale:warmed_orders';
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
 */
function buildLookupMap(qcSale: import('@shared/skuvault-types').QCSale): Record<string, any> {
  const saleId = qcSale.SaleId || '';
  const lookupMap: Record<string, any> = {};
  
  for (const item of qcSale.Items || []) {
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
    
    // Add kit component items
    if (item.KitProducts && item.KitProducts.length > 0) {
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
    
    // Check if already warmed (unless forcing refresh)
    if (!force) {
      const isWarmed = await redis.sismember(WARMED_SET_KEY, orderNumber);
      if (isWarmed) {
        log(`Order ${orderNumber} already warmed, skipping`);
        metrics.apiCallsSaved++;
        return true;
      }
      
      // Also check if there's a valid cache entry
      const exists = await redis.exists(warmKey);
      if (exists > 0) {
        log(`Order ${orderNumber} already in cache, skipping`);
        metrics.apiCallsSaved++;
        return true;
      }
    }
    
    // Fetch QCSale data from SkuVault
    log(`Warming cache for order ${orderNumber}${force ? ' (forced refresh)' : ''}...`);
    const qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber);
    
    if (!qcSale) {
      log(`No QCSale data found for order ${orderNumber}`);
      return false;
    }
    
    // Build cache data with lookup map
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
    };
    
    // Store with extended TTL
    await redis.set(warmKey, JSON.stringify(cacheData), { ex: WARM_TTL_SECONDS });
    
    // Track in warmed set (also with TTL to auto-cleanup)
    await redis.sadd(WARMED_SET_KEY, orderNumber);
    
    // Update the shipment record with cache_warmed_at timestamp for visibility
    try {
      await db.update(shipments)
        .set({ cacheWarmedAt: new Date() })
        .where(eq(shipments.orderNumber, orderNumber));
    } catch (dbErr: any) {
      // Non-critical - don't fail warming if DB update fails
      error(`Failed to update cacheWarmedAt for ${orderNumber}: ${dbErr.message}`);
    }
    
    log(`Cached order ${orderNumber} with ${Object.keys(lookupMap).length} barcode/SKU entries (${WARM_TTL_SECONDS}s TTL)`);
    
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
    
    // Remove from warmed set
    await redis.srem(WARMED_SET_KEY, orderNumber);
    
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
 * Get warm cache data for an order
 * Returns null if not in warm cache
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
    
    metrics.cacheHits++;
    metrics.apiCallsSaved++;
    
    // Upstash Redis auto-parses JSON
    const parsed = typeof cacheData === 'string' ? JSON.parse(cacheData) : cacheData;
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
 * Get shipments that are ready to pack (closed session, no tracking, no ship date)
 * These are the orders we should pre-warm the cache for
 * If shipDate is set, the order has already shipped even without tracking synced
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
          // No ship date (not yet shipped)
          isNull(shipments.shipDate),
          // Has a session ID
          isNotNull(shipments.sessionId),
          // Not on hold or cancelled
          or(
            isNull(shipments.shipmentStatus),
            and(
              ne(shipments.shipmentStatus, 'on_hold'),
              ne(shipments.shipmentStatus, 'cancelled')
            )
          )
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
