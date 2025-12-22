/**
 * QC Item Hydrator Service
 * 
 * Populates shipment_qc_items table for "Ready to Fulfill" shipments.
 * - Explodes kits into component SKUs using cached kit mappings
 * - Gets barcodes from cached product catalog
 * - Maps SKUs to collections for fingerprint calculation
 * - Calculates fingerprint signature and creates/matches fingerprints
 * 
 * Trigger: Shipments with status='on_hold' AND 'MOVE OVER' tag AND no existing QC items
 */

import crypto from 'crypto';
import { db } from '../db';
import { 
  shipments, 
  shipmentItems, 
  shipmentTags, 
  shipmentQcItems,
  productCollectionMappings,
  productCollections,
  fingerprints,
  type InsertShipmentQcItem,
  type InsertFingerprint,
} from '@shared/schema';
import { eq, and, or, exists, sql, notExists, inArray } from 'drizzle-orm';
import { 
  ensureKitMappingsFresh, 
  isKit, 
  getKitComponents,
  getKitCacheStats,
} from './kit-mappings-cache';
import { getProductsBatch, type ProductInfo } from './product-lookup';

const log = (message: string) => console.log(`[qc-item-hydrator] ${message}`);

interface HydrationResult {
  shipmentId: string;
  orderNumber: string;
  itemsCreated: number;
  fingerprintStatus?: 'complete' | 'pending_categorization';
  fingerprintIsNew?: boolean;
  uncategorizedSkuCount?: number;
  error?: string;
}

interface HydrationStats {
  shipmentsProcessed: number;
  shipmentsSkipped: number;
  totalItemsCreated: number;
  fingerprintsComplete: number;
  fingerprintsNew: number;
  fingerprintsPendingCategorization: number;
  errors: string[];
}

/**
 * Find shipments that need QC items hydrated
 * Criteria: on_hold status + MOVE OVER tag + no existing shipment_qc_items
 */
async function findShipmentsNeedingHydration(limit: number = 50): Promise<{ id: string; orderNumber: string }[]> {
  const results = await db
    .select({
      id: shipments.id,
      orderNumber: shipments.orderNumber,
    })
    .from(shipments)
    .where(
      and(
        // Status is on_hold
        eq(shipments.shipmentStatus, 'on_hold'),
        // Has MOVE OVER tag
        exists(
          db.select({ one: sql`1` })
            .from(shipmentTags)
            .where(
              and(
                eq(shipmentTags.shipmentId, shipments.id),
                eq(shipmentTags.name, 'MOVE OVER')
              )
            )
        ),
        // Does NOT have any shipment_qc_items yet
        notExists(
          db.select({ one: sql`1` })
            .from(shipmentQcItems)
            .where(eq(shipmentQcItems.shipmentId, shipments.id))
        )
      )
    )
    .limit(limit);
  
  return results.map(r => ({ 
    id: r.id, 
    orderNumber: r.orderNumber || 'unknown' 
  }));
}

/**
 * Get collection mapping for a SKU
 */
async function getCollectionForSku(sku: string): Promise<string | null> {
  const result = await db
    .select({ collectionId: productCollectionMappings.productCollectionId })
    .from(productCollectionMappings)
    .where(eq(productCollectionMappings.sku, sku))
    .limit(1);
  
  return result[0]?.collectionId || null;
}

/**
 * Build collection mapping cache for a batch of SKUs
 */
async function buildCollectionCache(skus: string[]): Promise<Map<string, string>> {
  if (skus.length === 0) return new Map();
  
  const results = await db
    .select({
      sku: productCollectionMappings.sku,
      collectionId: productCollectionMappings.productCollectionId,
    })
    .from(productCollectionMappings)
    .where(inArray(productCollectionMappings.sku, skus));
  
  const cache = new Map<string, string>();
  for (const r of results as { sku: string; collectionId: string }[]) {
    cache.set(r.sku, r.collectionId);
  }
  return cache;
}

/**
 * Build a cache of collection names for display purposes
 */
async function buildCollectionNameCache(collectionIds: string[]): Promise<Map<string, string>> {
  if (collectionIds.length === 0) return new Map();
  
  const results = await db
    .select({
      id: productCollections.id,
      name: productCollections.name,
    })
    .from(productCollections)
    .where(inArray(productCollections.id, collectionIds));
  
  const cache = new Map<string, string>();
  for (const r of results) {
    cache.set(r.id, r.name);
  }
  return cache;
}

/**
 * Generate a canonical signature from collection quantities and total weight
 * Format: Sorted JSON object with collection IDs as keys, plus weight field
 */
function generateSignature(collectionQuantities: Map<string, number>, totalWeight: number): string {
  // Sort by collection ID for deterministic ordering
  const sortedEntries = Array.from(collectionQuantities.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));
  
  const signatureObj: Record<string, number> = {};
  for (const [collectionId, quantity] of sortedEntries) {
    signatureObj[collectionId] = quantity;
  }
  // Include weight in signature - this makes fingerprints weight-sensitive
  signatureObj['weight'] = totalWeight;
  
  return JSON.stringify(signatureObj);
}

/**
 * Generate a hash of the signature for fast lookup
 */
function generateSignatureHash(signature: string): string {
  return crypto.createHash('sha256').update(signature).digest('hex').substring(0, 32);
}

/**
 * Generate human-readable display name from collection quantities and weight
 * Example: "2 Gift Boxes + 5 Small Jerky | 42oz"
 */
function generateDisplayName(
  collectionQuantities: Map<string, number>, 
  collectionNames: Map<string, string>,
  totalWeight: number,
  weightUnit: string
): string {
  const parts: string[] = [];
  
  // Sort by quantity descending, then by name
  const sortedEntries = Array.from(collectionQuantities.entries())
    .map(([id, qty]) => ({ id, qty, name: collectionNames.get(id) || 'Unknown' }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  
  for (const { qty, name } of sortedEntries) {
    parts.push(`${qty} ${name}`);
  }
  
  const collectionsPart = parts.join(' + ');
  return `${collectionsPart} | ${totalWeight}${weightUnit}`;
}

interface FingerprintResult {
  status: 'complete' | 'pending_categorization';
  fingerprintId?: string;
  isNew?: boolean;
  uncategorizedSkus?: string[];
}

/**
 * Calculate and assign fingerprint for a shipment after QC items are hydrated
 * Uses product_collection_mappings as the source of truth for collection membership
 * Exported so it can be called from routes when products are assigned to collections
 */
export async function calculateFingerprint(shipmentId: string): Promise<FingerprintResult> {
  // Get all QC items for this shipment including weight data
  const qcItems = await db
    .select({
      sku: shipmentQcItems.sku,
      quantityExpected: shipmentQcItems.quantityExpected,
      weightValue: shipmentQcItems.weightValue,
      weightUnit: shipmentQcItems.weightUnit,
    })
    .from(shipmentQcItems)
    .where(eq(shipmentQcItems.shipmentId, shipmentId));
  
  if (qcItems.length === 0) {
    return { status: 'pending_categorization', uncategorizedSkus: [] };
  }
  
  // Get all unique SKUs and look up their collections from mappings table (source of truth)
  const uniqueSkus = Array.from(new Set(qcItems.map(item => item.sku)));
  const collectionCache = await buildCollectionCache(uniqueSkus);
  
  // Check for uncategorized SKUs (those not in product_collection_mappings)
  const uncategorizedSkus: string[] = [];
  for (const sku of uniqueSkus) {
    if (!collectionCache.has(sku)) {
      uncategorizedSkus.push(sku);
    }
  }
  
  if (uncategorizedSkus.length > 0) {
    // Mark shipment as pending categorization
    await db
      .update(shipments)
      .set({ fingerprintStatus: 'pending_categorization' })
      .where(eq(shipments.id, shipmentId));
    
    return { 
      status: 'pending_categorization', 
      uncategorizedSkus: Array.from(new Set(uncategorizedSkus)) // Unique SKUs
    };
  }
  
  // All items have collections - aggregate by collection and calculate total weight
  const collectionQuantities = new Map<string, number>();
  let totalWeight = 0;
  let weightUnit = 'oz'; // Default weight unit
  
  for (const item of qcItems) {
    const collectionId = collectionCache.get(item.sku)!;
    const current = collectionQuantities.get(collectionId) || 0;
    collectionQuantities.set(collectionId, current + item.quantityExpected);
    
    // Calculate weight: weightValue × quantity (default to 0 if no weight)
    if (item.weightValue) {
      totalWeight += item.weightValue * item.quantityExpected;
      if (item.weightUnit) {
        weightUnit = item.weightUnit; // Use the weight unit from items
      }
    }
  }
  
  // Round to 1 decimal place to fix floating point precision (e.g., 1815.6000000000001 → 1815.6)
  totalWeight = Math.round(totalWeight * 10) / 10;
  
  // Generate signature and hash (now includes weight)
  const signature = generateSignature(collectionQuantities, totalWeight);
  const signatureHash = generateSignatureHash(signature);
  
  // Try to find existing fingerprint
  const existingFingerprint = await db
    .select({ id: fingerprints.id })
    .from(fingerprints)
    .where(eq(fingerprints.signatureHash, signatureHash))
    .limit(1);
  
  let fingerprintId: string;
  let isNew = false;
  
  if (existingFingerprint.length > 0) {
    // Use existing fingerprint
    fingerprintId = existingFingerprint[0].id;
  } else {
    // Create new fingerprint
    const collectionIds = Array.from(collectionQuantities.keys());
    const collectionNameCache = await buildCollectionNameCache(collectionIds);
    const displayName = generateDisplayName(collectionQuantities, collectionNameCache, totalWeight, weightUnit);
    
    const totalItems = Array.from(collectionQuantities.values()).reduce((a, b) => a + b, 0);
    const collectionCount = collectionQuantities.size;
    
    const newFingerprint: InsertFingerprint = {
      signature,
      signatureHash,
      displayName,
      totalItems,
      collectionCount,
      totalWeight,
      weightUnit,
    };
    
    const inserted = await db
      .insert(fingerprints)
      .values(newFingerprint)
      .returning({ id: fingerprints.id });
    
    fingerprintId = inserted[0].id;
    isNew = true;
    
    log(`Created new fingerprint: ${displayName} (${collectionCount} collections, ${totalItems} items, ${totalWeight}${weightUnit})`);
  }
  
  // Update shipment with fingerprint
  await db
    .update(shipments)
    .set({ 
      fingerprintId,
      fingerprintStatus: 'complete',
    })
    .where(eq(shipments.id, shipmentId));
  
  return { status: 'complete', fingerprintId, isNew };
}

/**
 * Hydrate QC items for a single shipment
 * Exported for use in recalculate-all route
 */
export async function hydrateShipment(shipmentId: string, orderNumber: string): Promise<HydrationResult> {
  try {
    // Get shipment items (non-exploded)
    const items = await db
      .select({
        sku: shipmentItems.sku,
        name: shipmentItems.name,
        quantity: shipmentItems.quantity,
      })
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, shipmentId));
    
    if (items.length === 0) {
      return { shipmentId, orderNumber, itemsCreated: 0, error: 'No shipment items found' };
    }
    
    // Phase 1: Pre-fetch product info to check product categories before explosion
    // We need productCategory to determine if a SKU should be exploded
    const rawSkus = items.map(item => item.sku).filter((sku): sku is string => !!sku);
    const preProductCache = await getProductsBatch(rawSkus);
    
    // Phase 2: Build list of all SKUs we need (exploding only products with category 'kit')
    const skusToLookup: string[] = [];
    interface ItemToProcess {
      sku: string;
      name: string | null;
      quantity: number;
      isKitComponent: boolean;
      parentSku: string | null;
    }
    const itemsToProcess: ItemToProcess[] = [];
    
    for (const item of items) {
      if (!item.sku) continue;
      
      const sku = item.sku;
      const quantity = item.quantity || 1;
      
      // Only explode if product has category 'kit' AND has component mappings
      const productInfo = preProductCache.get(sku);
      const isKitCategory = productInfo?.productCategory?.toLowerCase() === 'kit';
      const hasKitComponents = isKit(sku);
      const shouldExplode = isKitCategory && hasKitComponents;
      
      if (shouldExplode) {
        const components = getKitComponents(sku);
        if (components && components.length > 0) {
          for (const comp of components) {
            const totalQty = quantity * comp.componentQuantity;
            skusToLookup.push(comp.componentSku);
            itemsToProcess.push({
              sku: comp.componentSku,
              name: null,
              quantity: totalQty,
              isKitComponent: true,
              parentSku: sku,
            });
          }
        } else {
          // Kit category but no components found - treat as regular item
          skusToLookup.push(sku);
          itemsToProcess.push({
            sku,
            name: item.name,
            quantity,
            isKitComponent: false,
            parentSku: null,
          });
        }
      } else {
        // Not a kit - check if it's a variant that should fulfill the parent SKU
        // Variant products (category != 'kit' but have parentSku) should fulfill the parent
        const fulfillSku = productInfo?.parentSku || sku;
        const isVariant = !!productInfo?.parentSku;
        
        skusToLookup.push(fulfillSku);
        itemsToProcess.push({
          sku: fulfillSku,  // Use parent SKU for variants, original SKU otherwise
          name: item.name,
          quantity,
          isKitComponent: false,
          parentSku: isVariant ? sku : null,  // Track original variant SKU for audit
        });
        
        if (isVariant) {
          log(`Variant substitution: ${sku} → ${fulfillSku} (qty: ${quantity})`);
        }
      }
    }
    
    if (itemsToProcess.length === 0) {
      return { shipmentId, orderNumber, itemsCreated: 0, error: 'No items to insert after processing' };
    }
    
    // Phase 3: Batch fetch product info for all SKUs (including kit components)
    // This may include new SKUs from kit explosion that weren't in preProductCache
    const productCache = await getProductsBatch(skusToLookup);
    
    // Phase 4: Build QC items with product info
    const qcItemsToInsert: InsertShipmentQcItem[] = [];
    const allSkus: string[] = [];
    
    for (const item of itemsToProcess) {
      const product = productCache.get(item.sku);
      allSkus.push(item.sku);
      
      qcItemsToInsert.push({
        shipmentId,
        sku: item.sku,
        barcode: product?.barcode || null,
        description: product?.description || item.name || null,
        imageUrl: product?.imageUrl || null,
        quantityExpected: item.quantity,
        quantityScanned: 0,
        collectionId: null, // Will be filled in batch
        syncedToSkuvault: false,
        isKitComponent: item.isKitComponent,
        parentSku: item.parentSku,
        weightValue: product?.weightValue || null,
        weightUnit: product?.weightUnit || null,
      });
    }
    
    // Phase 4: Batch fetch collection mappings
    const collectionCache = await buildCollectionCache(allSkus);
    
    // Fill in collection IDs
    for (const qcItem of qcItemsToInsert) {
      qcItem.collectionId = collectionCache.get(qcItem.sku) || null;
    }
    
    // Insert all QC items
    await db.insert(shipmentQcItems).values(qcItemsToInsert);
    
    // Calculate and assign fingerprint
    const fingerprintResult = await calculateFingerprint(shipmentId);
    
    return { 
      shipmentId, 
      orderNumber, 
      itemsCreated: qcItemsToInsert.length,
      fingerprintStatus: fingerprintResult.status,
      fingerprintIsNew: fingerprintResult.isNew,
      uncategorizedSkuCount: fingerprintResult.uncategorizedSkus?.length,
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Error hydrating shipment ${orderNumber}: ${errorMsg}`);
    return { shipmentId, orderNumber, itemsCreated: 0, error: errorMsg };
  }
}

/**
 * Main hydration function - called by the worker
 * Finds eligible shipments and hydrates their QC items
 */
export async function runHydration(batchSize: number = 50): Promise<HydrationStats> {
  const stats: HydrationStats = {
    shipmentsProcessed: 0,
    shipmentsSkipped: 0,
    totalItemsCreated: 0,
    fingerprintsComplete: 0,
    fingerprintsNew: 0,
    fingerprintsPendingCategorization: 0,
    errors: [],
  };
  
  try {
    // Ensure kit mappings cache is fresh before processing
    const cacheRefreshed = await ensureKitMappingsFresh();
    if (cacheRefreshed) {
      log('Kit mappings cache was refreshed with new data');
    }
    
    const cacheStats = getKitCacheStats();
    if (cacheStats.kitCount === 0) {
      log('Warning: Kit mappings cache is empty');
    }
    
    // Find shipments needing hydration
    const shipmentsToProcess = await findShipmentsNeedingHydration(batchSize);
    
    if (shipmentsToProcess.length === 0) {
      return stats;
    }
    
    log(`Found ${shipmentsToProcess.length} shipments to hydrate`);
    
    // Process each shipment
    for (const shipment of shipmentsToProcess) {
      const result = await hydrateShipment(shipment.id, shipment.orderNumber);
      
      if (result.error) {
        stats.errors.push(`${result.orderNumber}: ${result.error}`);
        stats.shipmentsSkipped++;
      } else {
        stats.shipmentsProcessed++;
        stats.totalItemsCreated += result.itemsCreated;
        
        // Track fingerprint stats
        if (result.fingerprintStatus === 'complete') {
          stats.fingerprintsComplete++;
          if (result.fingerprintIsNew) {
            stats.fingerprintsNew++;
          }
        } else if (result.fingerprintStatus === 'pending_categorization') {
          stats.fingerprintsPendingCategorization++;
        }
      }
    }
    
    log(`Hydration complete: ${stats.shipmentsProcessed} processed, ${stats.totalItemsCreated} items created`);
    log(`Fingerprints: ${stats.fingerprintsComplete} complete (${stats.fingerprintsNew} new), ${stats.fingerprintsPendingCategorization} pending categorization`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Hydration failed: ${errorMsg}`);
    stats.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return stats;
}

/**
 * Get hydration status for monitoring
 */
export async function getHydrationStatus(): Promise<{
  pendingCount: number;
  kitCacheStats: ReturnType<typeof getKitCacheStats>;
}> {
  const pending = await findShipmentsNeedingHydration(1000);
  return {
    pendingCount: pending.length,
    kitCacheStats: getKitCacheStats(),
  };
}

/**
 * Backfill fingerprints for shipments that have QC items but no fingerprint
 * Used for shipments hydrated before fingerprint calculation was added
 */
export async function backfillFingerprints(limit: number = 100): Promise<{
  processed: number;
  complete: number;
  pendingCategorization: number;
  newFingerprints: number;
  errors: string[];
}> {
  const result = {
    processed: 0,
    complete: 0,
    pendingCategorization: 0,
    newFingerprints: 0,
    errors: [] as string[],
  };
  
  try {
    // Find shipments with QC items that need fingerprint calculation
    // This includes: no fingerprint_status yet, OR pending_categorization status
    const shipmentsToProcess = await db
      .select({
        id: shipments.id,
        orderNumber: shipments.orderNumber,
      })
      .from(shipments)
      .where(
        and(
          // Has QC items
          exists(
            db.select({ one: sql`1` })
              .from(shipmentQcItems)
              .where(eq(shipmentQcItems.shipmentId, shipments.id))
          ),
          // Either no fingerprint_status yet, or pending_categorization
          or(
            sql`${shipments.fingerprintStatus} IS NULL`,
            eq(shipments.fingerprintStatus, 'pending_categorization')
          )
        )
      )
      .limit(limit);
    
    if (shipmentsToProcess.length === 0) {
      log('Backfill: No shipments need fingerprint calculation');
      return result;
    }
    
    log(`Backfill: Found ${shipmentsToProcess.length} shipments needing fingerprint calculation`);
    
    for (const shipment of shipmentsToProcess) {
      try {
        const fingerprintResult = await calculateFingerprint(shipment.id);
        result.processed++;
        
        if (fingerprintResult.status === 'complete') {
          result.complete++;
          if (fingerprintResult.isNew) {
            result.newFingerprints++;
          }
        } else {
          result.pendingCategorization++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${shipment.orderNumber}: ${errorMsg}`);
      }
    }
    
    log(`Backfill complete: ${result.processed} processed, ${result.complete} complete (${result.newFingerprints} new), ${result.pendingCategorization} pending categorization`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Backfill failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}
