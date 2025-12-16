/**
 * QC Item Hydrator Service
 * 
 * Populates shipment_qc_items table for "Ready to Fulfill" shipments.
 * - Explodes kits into component SKUs using cached kit mappings
 * - Gets barcodes from cached product catalog
 * - Maps SKUs to collections for footprint calculation
 * - Calculates footprint signature and creates/matches footprints
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
  footprints,
  type InsertShipmentQcItem,
  type InsertFootprint,
} from '@shared/schema';
import { eq, and, exists, sql, notExists, inArray } from 'drizzle-orm';
import { 
  ensureCacheFresh, 
  getProduct, 
  isKit, 
  getKitComponents,
  getCacheStats,
} from './product-catalog-cache';

const log = (message: string) => console.log(`[qc-item-hydrator] ${message}`);

interface HydrationResult {
  shipmentId: string;
  orderNumber: string;
  itemsCreated: number;
  footprintStatus?: 'complete' | 'pending_categorization';
  footprintIsNew?: boolean;
  uncategorizedSkuCount?: number;
  error?: string;
}

interface HydrationStats {
  shipmentsProcessed: number;
  shipmentsSkipped: number;
  totalItemsCreated: number;
  footprintsComplete: number;
  footprintsNew: number;
  footprintsPendingCategorization: number;
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
 * Generate a canonical signature from collection quantities
 * Format: Sorted JSON object with collection IDs as keys
 */
function generateSignature(collectionQuantities: Map<string, number>): string {
  // Sort by collection ID for deterministic ordering
  const sortedEntries = Array.from(collectionQuantities.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));
  
  const signatureObj: Record<string, number> = {};
  for (const [collectionId, quantity] of sortedEntries) {
    signatureObj[collectionId] = quantity;
  }
  
  return JSON.stringify(signatureObj);
}

/**
 * Generate a hash of the signature for fast lookup
 */
function generateSignatureHash(signature: string): string {
  return crypto.createHash('sha256').update(signature).digest('hex').substring(0, 32);
}

/**
 * Generate human-readable display name from collection quantities
 * Example: "2 Gift Boxes + 5 Small Jerky"
 */
function generateDisplayName(
  collectionQuantities: Map<string, number>, 
  collectionNames: Map<string, string>
): string {
  const parts: string[] = [];
  
  // Sort by quantity descending, then by name
  const sortedEntries = Array.from(collectionQuantities.entries())
    .map(([id, qty]) => ({ id, qty, name: collectionNames.get(id) || 'Unknown' }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  
  for (const { qty, name } of sortedEntries) {
    parts.push(`${qty} ${name}`);
  }
  
  return parts.join(' + ');
}

interface FootprintResult {
  status: 'complete' | 'pending_categorization';
  footprintId?: string;
  isNew?: boolean;
  uncategorizedSkus?: string[];
}

/**
 * Calculate and assign footprint for a shipment after QC items are hydrated
 */
async function calculateFootprint(shipmentId: string): Promise<FootprintResult> {
  // Get all QC items for this shipment
  const qcItems = await db
    .select({
      sku: shipmentQcItems.sku,
      collectionId: shipmentQcItems.collectionId,
      quantityExpected: shipmentQcItems.quantityExpected,
    })
    .from(shipmentQcItems)
    .where(eq(shipmentQcItems.shipmentId, shipmentId));
  
  if (qcItems.length === 0) {
    return { status: 'pending_categorization', uncategorizedSkus: [] };
  }
  
  // Check for uncategorized SKUs
  const uncategorizedSkus: string[] = [];
  for (const item of qcItems) {
    if (!item.collectionId) {
      uncategorizedSkus.push(item.sku);
    }
  }
  
  if (uncategorizedSkus.length > 0) {
    // Mark shipment as pending categorization
    await db
      .update(shipments)
      .set({ footprintStatus: 'pending_categorization' })
      .where(eq(shipments.id, shipmentId));
    
    return { 
      status: 'pending_categorization', 
      uncategorizedSkus: Array.from(new Set(uncategorizedSkus)) // Unique SKUs
    };
  }
  
  // All items have collections - aggregate by collection
  const collectionQuantities = new Map<string, number>();
  for (const item of qcItems) {
    const current = collectionQuantities.get(item.collectionId!) || 0;
    collectionQuantities.set(item.collectionId!, current + item.quantityExpected);
  }
  
  // Generate signature and hash
  const signature = generateSignature(collectionQuantities);
  const signatureHash = generateSignatureHash(signature);
  
  // Try to find existing footprint
  const existingFootprint = await db
    .select({ id: footprints.id })
    .from(footprints)
    .where(eq(footprints.signatureHash, signatureHash))
    .limit(1);
  
  let footprintId: string;
  let isNew = false;
  
  if (existingFootprint.length > 0) {
    // Use existing footprint
    footprintId = existingFootprint[0].id;
  } else {
    // Create new footprint
    const collectionIds = Array.from(collectionQuantities.keys());
    const collectionNameCache = await buildCollectionNameCache(collectionIds);
    const displayName = generateDisplayName(collectionQuantities, collectionNameCache);
    
    const totalItems = Array.from(collectionQuantities.values()).reduce((a, b) => a + b, 0);
    const collectionCount = collectionQuantities.size;
    
    const newFootprint: InsertFootprint = {
      signature,
      signatureHash,
      displayName,
      totalItems,
      collectionCount,
    };
    
    const inserted = await db
      .insert(footprints)
      .values(newFootprint)
      .returning({ id: footprints.id });
    
    footprintId = inserted[0].id;
    isNew = true;
    
    log(`Created new footprint: ${displayName} (${collectionCount} collections, ${totalItems} items)`);
  }
  
  // Update shipment with footprint
  await db
    .update(shipments)
    .set({ 
      footprintId,
      footprintStatus: 'complete',
    })
    .where(eq(shipments.id, shipmentId));
  
  return { status: 'complete', footprintId, isNew };
}

/**
 * Hydrate QC items for a single shipment
 */
async function hydrateShipment(shipmentId: string, orderNumber: string): Promise<HydrationResult> {
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
    
    // Build list of all SKUs we'll need (including exploded kit components)
    const allSkus: string[] = [];
    const qcItemsToInsert: InsertShipmentQcItem[] = [];
    
    for (const item of items) {
      if (!item.sku) continue;
      
      const sku = item.sku;
      const quantity = item.quantity || 1;
      
      // Check if this is a kit
      if (isKit(sku)) {
        const components = getKitComponents(sku);
        if (components && components.length > 0) {
          // Explode kit into components
          for (const comp of components) {
            const product = getProduct(comp.componentSku);
            const totalQty = quantity * comp.componentQuantity;
            
            allSkus.push(comp.componentSku);
            qcItemsToInsert.push({
              shipmentId,
              sku: comp.componentSku,
              barcode: product?.barcode || null,
              description: product?.description || null,
              quantityExpected: totalQty,
              quantityScanned: 0,
              collectionId: null, // Will be filled in batch
              syncedToSkuvault: false,
              isKitComponent: true,
              parentSku: sku,
            });
          }
        } else {
          // Kit but no components found - treat as regular item
          const product = getProduct(sku);
          allSkus.push(sku);
          qcItemsToInsert.push({
            shipmentId,
            sku,
            barcode: product?.barcode || null,
            description: product?.description || item.name || null,
            quantityExpected: quantity,
            quantityScanned: 0,
            collectionId: null,
            syncedToSkuvault: false,
            isKitComponent: false,
            parentSku: null,
          });
        }
      } else {
        // Regular product
        const product = getProduct(sku);
        allSkus.push(sku);
        qcItemsToInsert.push({
          shipmentId,
          sku,
          barcode: product?.barcode || null,
          description: product?.description || item.name || null,
          quantityExpected: quantity,
          quantityScanned: 0,
          collectionId: null,
          syncedToSkuvault: false,
          isKitComponent: false,
          parentSku: null,
        });
      }
    }
    
    if (qcItemsToInsert.length === 0) {
      return { shipmentId, orderNumber, itemsCreated: 0, error: 'No items to insert after processing' };
    }
    
    // Batch fetch collection mappings
    const collectionCache = await buildCollectionCache(allSkus);
    
    // Fill in collection IDs
    for (const item of qcItemsToInsert) {
      item.collectionId = collectionCache.get(item.sku) || null;
    }
    
    // Insert all QC items
    await db.insert(shipmentQcItems).values(qcItemsToInsert);
    
    // Calculate and assign footprint
    const footprintResult = await calculateFootprint(shipmentId);
    
    return { 
      shipmentId, 
      orderNumber, 
      itemsCreated: qcItemsToInsert.length,
      footprintStatus: footprintResult.status,
      footprintIsNew: footprintResult.isNew,
      uncategorizedSkuCount: footprintResult.uncategorizedSkus?.length,
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
    footprintsComplete: 0,
    footprintsNew: 0,
    footprintsPendingCategorization: 0,
    errors: [],
  };
  
  try {
    // Ensure caches are fresh before processing
    const cacheRefreshed = await ensureCacheFresh();
    if (cacheRefreshed) {
      log('Cache was refreshed with new data');
    }
    
    const cacheStats = getCacheStats();
    if (cacheStats.productCount === 0) {
      log('Warning: Product catalog cache is empty');
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
        
        // Track footprint stats
        if (result.footprintStatus === 'complete') {
          stats.footprintsComplete++;
          if (result.footprintIsNew) {
            stats.footprintsNew++;
          }
        } else if (result.footprintStatus === 'pending_categorization') {
          stats.footprintsPendingCategorization++;
        }
      }
    }
    
    log(`Hydration complete: ${stats.shipmentsProcessed} processed, ${stats.totalItemsCreated} items created`);
    log(`Footprints: ${stats.footprintsComplete} complete (${stats.footprintsNew} new), ${stats.footprintsPendingCategorization} pending categorization`);
    
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
  cacheStats: ReturnType<typeof getCacheStats>;
}> {
  const pending = await findShipmentsNeedingHydration(1000);
  return {
    pendingCount: pending.length,
    cacheStats: getCacheStats(),
  };
}

/**
 * Backfill footprints for shipments that have QC items but no footprint
 * Used for shipments hydrated before footprint calculation was added
 */
export async function backfillFootprints(limit: number = 100): Promise<{
  processed: number;
  complete: number;
  pendingCategorization: number;
  newFootprints: number;
  errors: string[];
}> {
  const result = {
    processed: 0,
    complete: 0,
    pendingCategorization: 0,
    newFootprints: 0,
    errors: [] as string[],
  };
  
  try {
    // Find shipments with QC items but no footprint_status
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
          // No footprint_status yet
          sql`${shipments.footprintStatus} IS NULL`
        )
      )
      .limit(limit);
    
    if (shipmentsToProcess.length === 0) {
      log('Backfill: No shipments need footprint calculation');
      return result;
    }
    
    log(`Backfill: Found ${shipmentsToProcess.length} shipments needing footprint calculation`);
    
    for (const shipment of shipmentsToProcess) {
      try {
        const footprintResult = await calculateFootprint(shipment.id);
        result.processed++;
        
        if (footprintResult.status === 'complete') {
          result.complete++;
          if (footprintResult.isNew) {
            result.newFootprints++;
          }
        } else {
          result.pendingCategorization++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${shipment.orderNumber}: ${errorMsg}`);
      }
    }
    
    log(`Backfill complete: ${result.processed} processed, ${result.complete} complete (${result.newFootprints} new), ${result.pendingCategorization} pending categorization`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Backfill failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}
