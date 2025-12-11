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
import { shipments, shipmentTags, shipmentPackages, type Shipment, type ShipmentPackage } from '@shared/schema';
import { eq, and, isNull, isNotNull, ne, sql, inArray } from 'drizzle-orm';
import { skuVaultService } from './skuvault-service';
import { analyzeShippableShipments, type ShippableShipmentsResult } from '../utils/shipment-eligibility';

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
const DELAY_BETWEEN_ORDERS_MS = 2500; // 2.5 seconds between orders for session stability

// Failed order retry tracking with exponential backoff
const FAILED_ORDER_KEY_PREFIX = 'skuvault:qcsale:failed:';
const BACKOFF_SCHEDULE_MS = [
  2 * 60 * 1000,    // 1st retry: 2 minutes
  5 * 60 * 1000,    // 2nd retry: 5 minutes
  15 * 60 * 1000,   // 3rd retry: 15 minutes
  60 * 60 * 1000,   // 4th+ retry: 1 hour
];
const MAX_RETRY_ATTEMPTS = 10; // After this, stop retrying until manual refresh

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
 * Get the failed order tracking key
 */
function getFailedOrderKey(orderNumber: string): string {
  return `${FAILED_ORDER_KEY_PREFIX}${orderNumber}`;
}

/**
 * Track a failed warming attempt for exponential backoff
 */
async function trackFailedOrder(orderNumber: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = getFailedOrderKey(orderNumber);
    
    const existing = await redis.get(key);
    const data = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : null;
    
    const attempts = (data?.attempts || 0) + 1;
    const newData = {
      orderNumber,
      attempts,
      lastAttemptAt: Date.now(),
      firstFailedAt: data?.firstFailedAt || Date.now(),
    };
    
    // TTL of 24 hours - if order hasn't been retried in 24 hours, reset
    await redis.set(key, JSON.stringify(newData), { ex: 86400 });
    log(`Tracked failed order ${orderNumber} (attempt ${attempts})`);
  } catch (err: any) {
    error(`Failed to track failed order ${orderNumber}: ${err.message}`);
  }
}

/**
 * Check if an order should be retried based on exponential backoff
 */
async function shouldRetryOrder(orderNumber: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const key = getFailedOrderKey(orderNumber);
    
    const existing = await redis.get(key);
    if (!existing) return true; // No failure record, can try
    
    const data = typeof existing === 'string' ? JSON.parse(existing) : existing;
    const attempts = data.attempts || 0;
    const lastAttemptAt = data.lastAttemptAt || 0;
    
    // Max retries reached - don't auto-retry, wait for manual refresh
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      return false;
    }
    
    // Calculate backoff delay based on attempt count
    const backoffIndex = Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1);
    const backoffDelay = BACKOFF_SCHEDULE_MS[Math.max(0, backoffIndex)];
    const timeSinceLastAttempt = Date.now() - lastAttemptAt;
    
    if (timeSinceLastAttempt < backoffDelay) {
      // Not enough time has passed
      return false;
    }
    
    return true;
  } catch (err: any) {
    error(`Failed to check retry status for ${orderNumber}: ${err.message}`);
    return true; // On error, allow retry
  }
}

/**
 * Clear failed order tracking (called on success or when order ships)
 */
async function clearFailedOrderTracking(orderNumber: string): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = getFailedOrderKey(orderNumber);
    await redis.del(key);
  } catch (err: any) {
    error(`Failed to clear failed order tracking for ${orderNumber}: ${err.message}`);
  }
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
 * Validation result for barcode completeness check
 */
interface BarcodeValidationResult {
  isValid: boolean;
  missingItems: Array<{
    sku: string;
    title: string | null;
    isKitComponent: boolean;
    kitSku?: string;
  }>;
  totalItems: number;
  coveredItems: number;
}

/**
 * Validate that all QCSale items have at least one scannable barcode in the lookup map.
 * Returns validation result with details about any missing items.
 * 
 * An item is considered "covered" if it has at least one of:
 * - Code (barcode)
 * - SKU
 * - PartNumber (UPC)
 * - AlternateCode
 */
function validateLookupMapCompleteness(
  qcSale: import('@shared/skuvault-types').QCSale,
  lookupMap: Record<string, any>
): BarcodeValidationResult {
  const missingItems: BarcodeValidationResult['missingItems'] = [];
  let totalItems = 0;
  let coveredItems = 0;
  
  for (const item of qcSale.Items || []) {
    const isKit = item.KitProducts && item.KitProducts.length > 0;
    
    if (!isKit) {
      totalItems++;
      const hasScannable = 
        (item.Code && lookupMap[item.Code.toUpperCase()]) ||
        (item.Sku && lookupMap[item.Sku.toUpperCase()]) ||
        (item.PartNumber && lookupMap[item.PartNumber.toUpperCase()]) ||
        (item.AlternateCodes?.some(ac => ac && typeof ac === 'string' && lookupMap[ac.toUpperCase()]));
      
      if (hasScannable) {
        coveredItems++;
      } else {
        missingItems.push({
          sku: item.Sku || 'UNKNOWN',
          title: item.Title || null,
          isKitComponent: false,
        });
      }
    }
    
    if (isKit && item.KitProducts) {
      for (const component of item.KitProducts) {
        totalItems++;
        const hasScannable = 
          (component.Code && lookupMap[component.Code.toUpperCase()]) ||
          (component.Sku && lookupMap[component.Sku.toUpperCase()]) ||
          (component.PartNumber && lookupMap[component.PartNumber.toUpperCase()]);
        
        if (hasScannable) {
          coveredItems++;
        } else {
          missingItems.push({
            sku: component.Sku || 'UNKNOWN',
            title: component.Title || null,
            isKitComponent: true,
            kitSku: item.Sku || undefined,
          });
        }
      }
    }
  }
  
  return {
    isValid: missingItems.length === 0,
    missingItems,
    totalItems,
    coveredItems,
  };
}

/**
 * Get all shippable shipments for an order using centralized eligibility logic.
 * 
 * A shipment is shippable if:
 * - Has "MOVE OVER" tag (picking complete in SkuVault)
 * - shipmentStatus is NOT 'on_hold'
 * 
 * Returns analysis result with:
 * - allShipments: All shipments for the order
 * - shippableShipments: Filtered to only shippable ones
 * - defaultShipmentId: Auto-set when exactly 1 shippable
 * - reason: 'single' | 'multiple' | 'none'
 */
export async function getShippableShipmentsForOrder(orderNumber: string): Promise<ShippableShipmentsResult<Shipment> | null> {
  try {
    // Fetch ALL shipments for this order
    const allShipments = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderNumber, orderNumber));
    
    if (allShipments.length === 0) {
      log(`No shipments found for order ${orderNumber}`);
      return null;
    }
    
    // Batch fetch tags for all shipments
    const shipmentIds = allShipments.map(s => s.id);
    const tagsResult = await db
      .select()
      .from(shipmentTags)
      .where(inArray(shipmentTags.shipmentId, shipmentIds));
    
    // Use centralized eligibility logic
    const result = analyzeShippableShipments(allShipments, tagsResult);
    
    // Log based on reason
    if (result.reason === 'none') {
      log(`No shippable shipments for order ${orderNumber} (${allShipments.length} total, none with MOVE OVER tag and not on_hold)`);
    } else if (result.reason === 'multiple') {
      log(`Multiple shippable shipments for order ${orderNumber} (${result.shippableShipments.length} found)`);
    } else {
      log(`Single shippable shipment for order ${orderNumber}: ${result.defaultShipmentId}`);
    }
    
    return result;
  } catch (err: any) {
    error(`Failed to get shippable shipments for order ${orderNumber}: ${err.message}`);
    return null;
  }
}

/**
 * Helper to serialize a shipment for cache storage
 */
function serializeShipmentForCache(shipment: Shipment, packages?: ShipmentPackage[]) {
  return {
    id: shipment.id,
    orderNumber: shipment.orderNumber,
    orderId: shipment.orderId,
    carrierCode: shipment.carrierCode,
    serviceCode: shipment.serviceCode,
    shipmentStatus: shipment.shipmentStatus,
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
    // QC completion tracking - for fast reprint QC determination
    qcCompleted: shipment.qcCompleted,
    qcCompletedAt: shipment.qcCompletedAt,
    // Package details for shipping info display
    packages: packages || [],
  };
}

/**
 * Warm the cache for a single order by fetching QCSale data from SkuVault
 * Uses extended TTL for pre-warmed entries
 * 
 * NEW: Supports multiple shippable shipments - stores array in cache for UI selection
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
    
    // Get all shippable shipments using centralized eligibility logic
    const shipmentsResult = await getShippableShipmentsForOrder(orderNumber);
    
    if (!shipmentsResult || shipmentsResult.reason === 'none') {
      // No shippable shipments found - don't cache
      return false;
    }
    
    // Now fetch QCSale data from SkuVault for EACH shippable shipment
    // Multi-shipment orders have separate QC Sales per shipment in SkuVault
    const shipmentCount = shipmentsResult.shippableShipments.length;
    log(`Warming cache for order ${orderNumber} (${shipmentCount} shippable shipment${shipmentCount > 1 ? 's' : ''})${force ? ' (forced refresh)' : ''}...`);
    
    // Build maps for each shipment's QC Sale data
    const qcSalesByShipment: Record<string, any> = {};
    const lookupMapsByShipment: Record<string, Record<string, any>> = {};
    
    // Default QC Sale (backward compat) - will be set to first successful fetch
    let defaultQcSale: any = null;
    let defaultLookupMap: Record<string, any> = {};
    
    // Fetch QC Sale for each shippable shipment with barcode validation and retry
    for (const shipment of shipmentsResult.shippableShipments) {
      try {
        // IMPORTANT: Two different IDs are used here:
        // - shipment.id: Our internal UUID, used as cache key
        // - shipment.shipmentId: ShipStation ID (se-XXX format), used for SkuVault API lookup
        // SkuVault uses the ShipStation ID suffix in their composite order IDs (e.g., "480797-ORDER-123-933001022")
        const shipstationId = (shipment as any).shipmentId;
        
        // Attempt to fetch and validate QC Sale data with one retry
        let qcSale: import('@shared/skuvault-types').QCSale | null = null;
        let lookupMap: Record<string, any> = {};
        let validationResult: BarcodeValidationResult | null = null;
        let attempt = 0;
        const maxAttempts = 2;
        
        while (attempt < maxAttempts) {
          attempt++;
          qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber, shipstationId);
          
          if (!qcSale) {
            log(`  No QC Sale found for shipment ${shipment.id} (shipstationId: ${shipstationId})`);
            break; // No data at all, don't retry
          }
          
          lookupMap = buildLookupMap(qcSale);
          validationResult = validateLookupMapCompleteness(qcSale, lookupMap);
          
          if (validationResult.isValid) {
            // All items have scannable barcodes
            break;
          }
          
          // Validation failed - some items are missing barcodes
          if (attempt < maxAttempts) {
            log(`  [BARCODE VALIDATION] Shipment ${shipment.id}: ${validationResult.coveredItems}/${validationResult.totalItems} items have barcodes - retrying in 500ms...`);
            await new Promise(resolve => setTimeout(resolve, 500)); // Brief delay before retry
          } else {
            // Final attempt failed - log details and skip this shipment for now
            error(`  [BARCODE VALIDATION FAILED] Shipment ${shipment.id}: ${validationResult.missingItems.length} items missing barcodes after ${maxAttempts} attempts:`);
            for (const missing of validationResult.missingItems.slice(0, 5)) {
              const kitInfo = missing.isKitComponent ? ` (kit component of ${missing.kitSku})` : '';
              error(`    - SKU: ${missing.sku}${kitInfo}${missing.title ? ` - ${missing.title}` : ''}`);
            }
            if (validationResult.missingItems.length > 5) {
              error(`    ... and ${validationResult.missingItems.length - 5} more`);
            }
            error(`  Skipping shipment ${shipment.id} - will retry on next cache warmer run`);
            qcSale = null; // Clear so we don't cache incomplete data
          }
        }
        
        if (qcSale && validationResult?.isValid) {
          // Store by INTERNAL shipment ID (matches cache lookup in routes.ts)
          qcSalesByShipment[shipment.id] = {
            SaleId: qcSale.SaleId,
            OrderId: qcSale.OrderId,
            Status: qcSale.Status,
            TotalItems: qcSale.TotalItems,
            PassedItems: qcSale.PassedItems,
            Items: qcSale.Items,
          };
          lookupMapsByShipment[shipment.id] = lookupMap;
          
          // Set default to first successful fetch (for backward compat)
          if (!defaultQcSale) {
            defaultQcSale = qcSale;
            defaultLookupMap = lookupMap;
          }
          
          log(`  Fetched QC Sale for shipment ${shipment.id} (shipstationId: ${shipstationId}, ${Object.keys(lookupMap).length} barcode entries, validated OK)`);
        }
      } catch (err: any) {
        error(`  Failed to fetch QC Sale for shipment ${shipment.id}: ${err.message}`);
      }
    }
    
    // If no QC Sales found for any shipment, don't cache
    if (!defaultQcSale) {
      log(`No QCSale data found for any shipment of order ${orderNumber}`);
      return false;
    }
    
    // Batch fetch packages for all shippable shipments
    const shippableIds = shipmentsResult.shippableShipments.map(s => s.id);
    const allPackages = shippableIds.length > 0 
      ? await db.select().from(shipmentPackages).where(inArray(shipmentPackages.shipmentId, shippableIds))
      : [];
    
    // Group packages by shipment ID
    const packagesByShipmentId: Record<string, ShipmentPackage[]> = {};
    for (const pkg of allPackages) {
      if (!packagesByShipmentId[pkg.shipmentId]) {
        packagesByShipmentId[pkg.shipmentId] = [];
      }
      packagesByShipmentId[pkg.shipmentId].push(pkg);
    }
    
    // Serialize all shippable shipments for cache (with packages)
    const shippableShipmentsData = shipmentsResult.shippableShipments.map(s => 
      serializeShipmentForCache(s, packagesByShipmentId[s.id] || [])
    );
    
    // For backward compatibility, keep 'shipment' as the default (first/only shippable)
    const defaultShipment = shipmentsResult.shippableShipments.length > 0 
      ? shipmentsResult.shippableShipments[0] 
      : null;
    
    const cacheData = {
      saleId: defaultQcSale.SaleId || '',
      orderNumber,
      cachedAt: Date.now(),
      warmedAt: Date.now(),
      // BACKWARD COMPAT: Default lookup map (first shipment)
      lookupMap: defaultLookupMap,
      // BACKWARD COMPAT: Default QCSale (first shipment)
      qcSale: {
        SaleId: defaultQcSale.SaleId,
        OrderId: defaultQcSale.OrderId,
        Status: defaultQcSale.Status,
        TotalItems: defaultQcSale.TotalItems,
        PassedItems: defaultQcSale.PassedItems,
        Items: defaultQcSale.Items,
      },
      // BACKWARD COMPAT: Single shipment field (first shippable or null)
      shipment: defaultShipment ? serializeShipmentForCache(defaultShipment, packagesByShipmentId[defaultShipment.id] || []) : null,
      // NEW: QC Sales and lookup maps keyed by shipment ID
      qcSalesByShipment,
      lookupMapsByShipment,
      // Array of all shippable shipments for UI selection
      shippableShipments: shippableShipmentsData,
      // Default shipment ID (auto-set when exactly 1 shippable)
      defaultShipmentId: shipmentsResult.defaultShipmentId,
      // Reason for the result (single/multiple/none)
      shippableReason: shipmentsResult.reason,
    };
    
    // Store with extended TTL
    await redis.set(warmKey, JSON.stringify(cacheData), { ex: WARM_TTL_SECONDS });
    
    // Update cacheWarmedAt timestamp for all shippable shipments
    for (const shipment of shipmentsResult.shippableShipments) {
      try {
        await db.update(shipments)
          .set({ cacheWarmedAt: new Date() })
          .where(eq(shipments.id, shipment.id));
      } catch (dbErr: any) {
        // Non-critical - don't fail warming if DB update fails
        error(`Failed to update cacheWarmedAt for shipment ${shipment.id}: ${dbErr.message}`);
      }
    }
    
    const qcSalesCount = Object.keys(qcSalesByShipment).length;
    const totalBarcodes = Object.values(lookupMapsByShipment).reduce((sum, map) => sum + Object.keys(map).length, 0);
    log(`Cached order ${orderNumber} with ${qcSalesCount} QC Sale(s), ${totalBarcodes} barcode entries, ${shipmentCount} shippable shipment(s) (${WARM_TTL_SECONDS}s TTL)`);
    
    if (force) {
      metrics.manualRefreshes++;
    } else {
      metrics.ordersWarmed++;
    }
    
    return true;
  } catch (err: any) {
    // Token refresh is expected during startup or token expiry - log at info level
    const isTokenRefresh = err.message?.includes('No authentication token available');
    if (isTokenRefresh) {
      log(`Skipped warming cache for order ${orderNumber}: token refresh in progress`);
    } else {
      error(`Failed to warm cache for order ${orderNumber}: ${err.message}`);
    }
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
    
    // Clear failed order tracking (order shipped, no longer needs retry)
    await clearFailedOrderTracking(orderNumber);
    
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
  const success = await warmCacheForOrder(orderNumber, true);
  
  if (success) {
    // Clear backoff tracking on successful manual refresh
    await clearFailedOrderTracking(orderNumber);
  }
  
  return success;
}

/**
 * Detailed result from cache refresh operation for logging/debugging
 */
export interface CacheRefreshDetailedResult {
  success: boolean;
  orderNumber: string;
  shipmentId?: string;
  shipstationId?: string;
  saleId?: string;
  itemsFound?: number;
  barcodesFound?: number;
  passedItemsCount?: number;
  qcSaleStatus?: string;
  skuvaultOrderId?: string;
  errorStage?: 'shipment_lookup' | 'skuvault_api' | 'validation' | 'cache_write';
  errorMessage?: string;
  skuvaultRawResponse?: any;
  lookupAttempts?: Array<{
    searchTerm: string;
    resultCount: number;
    matched: boolean;
  }>;
}

/**
 * Manual refresh with detailed result - for packing_logs
 * Returns rich diagnostic data about what happened
 */
export async function refreshCacheForOrderDetailed(orderNumber: string): Promise<CacheRefreshDetailedResult> {
  log(`Manual refresh (detailed) requested for order ${orderNumber}`);
  
  const result: CacheRefreshDetailedResult = {
    success: false,
    orderNumber,
  };
  
  try {
    const redis = getRedisClient();
    const warmKey = getWarmCacheKey(orderNumber);
    
    // Get all shippable shipments using centralized eligibility logic
    const shipmentsResult = await getShippableShipmentsForOrder(orderNumber);
    
    if (!shipmentsResult || shipmentsResult.reason === 'none') {
      result.errorStage = 'shipment_lookup';
      result.errorMessage = 'No shippable shipments found for order';
      return result;
    }
    
    // Use the first shippable shipment
    const shipment = shipmentsResult.shippableShipments[0];
    const shipstationId = (shipment as any).shipmentId;
    
    result.shipmentId = shipment.id;
    result.shipstationId = shipstationId;
    
    // Fetch QC Sale from SkuVault with detailed tracking
    const lookupAttempts: CacheRefreshDetailedResult['lookupAttempts'] = [];
    
    // Get QC Sale - this call internally handles suffix matching and composite search
    const qcSale = await skuVaultService.getQCSalesByOrderNumber(orderNumber, shipstationId);
    
    // Store raw response for debugging
    if (qcSale) {
      result.skuvaultRawResponse = {
        SaleId: qcSale.SaleId,
        OrderId: qcSale.OrderId,
        Status: qcSale.Status,
        TotalItems: qcSale.TotalItems,
        ItemsCount: qcSale.Items?.length || 0,
        PassedItemsCount: qcSale.PassedItems?.length || 0,
        ItemSkus: qcSale.Items?.map(i => i.Sku).slice(0, 10), // First 10 SKUs
      };
      
      result.saleId = qcSale.SaleId || undefined;
      result.skuvaultOrderId = qcSale.OrderId || undefined;
      result.qcSaleStatus = qcSale.Status || undefined;
      result.itemsFound = qcSale.TotalItems ?? undefined;
      result.passedItemsCount = qcSale.PassedItems?.length || 0;
      
      // Build lookup map to count barcodes
      const lookupMap = buildLookupMap(qcSale);
      result.barcodesFound = Object.keys(lookupMap).length;
      
      // Validate completeness
      const validationResult = validateLookupMapCompleteness(qcSale, lookupMap);
      
      if (!validationResult.isValid) {
        result.errorStage = 'validation';
        result.errorMessage = `${validationResult.missingItems.length} items missing barcodes: ${validationResult.missingItems.slice(0, 3).map(i => i.sku).join(', ')}`;
        // Still continue - cache what we have
      }
      
      // Cache the data
      const cacheSuccess = await warmCacheForOrder(orderNumber, true);
      
      if (cacheSuccess) {
        result.success = true;
        await clearFailedOrderTracking(orderNumber);
      } else {
        result.errorStage = 'cache_write';
        result.errorMessage = 'Failed to write cache after fetching data';
      }
    } else {
      result.errorStage = 'skuvault_api';
      result.errorMessage = `No QC Sale found in SkuVault for order ${orderNumber} (shipstationId: ${shipstationId})`;
      result.skuvaultRawResponse = { status: 'no_match', shipstationId };
    }
    
    return result;
  } catch (err: any) {
    result.errorStage = 'skuvault_api';
    result.errorMessage = err.message;
    result.skuvaultRawResponse = { error: err.message, stack: err.stack?.split('\n').slice(0, 3) };
    return result;
  }
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
 * 
 * Now uses exponential backoff for failed orders to avoid
 * hammering SkuVault with requests that keep failing.
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
    
    // Filter orders based on backoff - skip orders that failed recently
    const ordersToProcess: string[] = [];
    const skippedDueToBackoff: string[] = [];
    
    for (const orderNumber of orderNumbers) {
      const canRetry = await shouldRetryOrder(orderNumber);
      if (canRetry) {
        ordersToProcess.push(orderNumber);
      } else {
        skippedDueToBackoff.push(orderNumber);
      }
    }
    
    if (skippedDueToBackoff.length > 0) {
      log(`Skipping ${skippedDueToBackoff.length} orders due to backoff (failed recently)`);
    }
    
    if (ordersToProcess.length === 0) {
      log(`All ${orderNumbers.length} orders are in backoff period`);
      metrics.workerStatus = 'sleeping';
      return;
    }
    
    log(`Processing ${ordersToProcess.length}/${orderNumbers.length} orders (${skippedDueToBackoff.length} in backoff)...`);
    
    let warmed = 0;
    let failed = 0;
    
    // Process orders serially with longer delay for session stability
    for (const orderNumber of ordersToProcess) {
      const success = await warmCacheForOrder(orderNumber);
      
      if (success) {
        warmed++;
        // Clear any previous failure tracking on success
        await clearFailedOrderTracking(orderNumber);
      } else {
        failed++;
        // Track failure for exponential backoff
        await trackFailedOrder(orderNumber);
      }
      
      // Longer delay between orders for SkuVault session stability (2.5 seconds)
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ORDERS_MS));
    }
    
    log(`Warmed ${warmed}/${ordersToProcess.length} orders (${failed} failed, will retry with backoff)`);
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
 * Shipment context passed to onSessionClosed for packing-ready determination
 */
export interface ShipmentContext {
  trackingNumber: string | null;
  shipmentStatus: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  cacheWarmedAt: Date | null;
}

/**
 * Valid shipment statuses for packing-ready determination
 * Exported for reuse in other modules
 */
export const PACKING_READY_STATUSES = ['pending', 'label_pending'];

/**
 * Check if a shipment is packing-ready based on full criteria
 * Packing ready = closed session + no tracking + pending/label_pending status + has session ID
 * 
 * Returns { ready: boolean, reason?: string } for diagnostic logging
 */
export function isPackingReadyWithReason(shipment: ShipmentContext): { ready: boolean; reason?: string } {
  if (shipment.trackingNumber) {
    return { ready: false, reason: 'has trackingNumber' };
  }
  if (shipment.sessionId === null) {
    return { ready: false, reason: 'sessionId is null' };
  }
  if (shipment.sessionStatus !== 'closed') {
    return { ready: false, reason: `sessionStatus is '${shipment.sessionStatus}' (expected 'closed')` };
  }
  if (shipment.shipmentStatus === null) {
    return { ready: false, reason: 'shipmentStatus is null' };
  }
  if (!PACKING_READY_STATUSES.includes(shipment.shipmentStatus)) {
    return { ready: false, reason: `shipmentStatus '${shipment.shipmentStatus}' not in [${PACKING_READY_STATUSES.join(', ')}]` };
  }
  return { ready: true };
}

/**
 * Check if a shipment is packing-ready (simple boolean version)
 * Use isPackingReadyWithReason() when you need diagnostic info
 */
export function isPackingReady(shipment: ShipmentContext): boolean {
  return isPackingReadyWithReason(shipment).ready;
}

/**
 * Build a ShipmentContext from shipment data
 * Centralizes context construction to prevent missing fields
 * 
 * @param shipment - Object with shipment fields (from DB query or full shipment)
 * @param sessionStatusOverride - Optional override for sessionStatus (e.g., from Firestore session)
 */
export function buildShipmentContext(
  shipment: {
    trackingNumber?: string | null;
    shipmentStatus?: string | null;
    sessionId?: string | null;
    sessionStatus?: string | null;
    cacheWarmedAt?: Date | null;
  },
  sessionStatusOverride?: string | null
): ShipmentContext {
  return {
    trackingNumber: shipment.trackingNumber ?? null,
    shipmentStatus: shipment.shipmentStatus ?? null,
    sessionId: shipment.sessionId ?? null,
    sessionStatus: sessionStatusOverride ?? shipment.sessionStatus ?? null,
    cacheWarmedAt: shipment.cacheWarmedAt ?? null,
  };
}

/**
 * Called when a session transitions to 'closed' to immediately warm the cache
 * Now checks full packing-ready criteria before warming
 * Hook this into the Firestore session sync worker
 */
export async function onSessionClosed(orderNumber: string, shipment: ShipmentContext): Promise<void> {
  // If already has tracking, invalidate cache (order was shipped)
  if (shipment.trackingNumber) {
    await invalidateCacheForOrder(orderNumber);
    return;
  }
  
  // Check if order is packing-ready with detailed reason
  const packingCheck = isPackingReadyWithReason(shipment);
  if (!packingCheck.ready) {
    log(`Order ${orderNumber} is not packing-ready: ${packingCheck.reason}`);
    return;
  }
  
  // Check if already warmed (avoid redundant warming)
  if (shipment.cacheWarmedAt) {
    log(`Order ${orderNumber} already has cacheWarmedAt set, skipping`);
    return;
  }
  
  // Ready to pack, warm the cache
  await warmCacheForOrder(orderNumber);
}

/**
 * Called when a label is created (tracking number assigned)
 * Invalidates the cache for this order
 */
export async function onLabelCreated(orderNumber: string): Promise<void> {
  await invalidateCacheForOrder(orderNumber);
}
