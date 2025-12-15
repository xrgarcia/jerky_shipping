/**
 * QC Item Hydrator Service
 * 
 * Populates shipment_qc_items table for "Ready to Fulfill" shipments.
 * - Explodes kits into component SKUs using cached kit mappings
 * - Gets barcodes from cached product catalog
 * - Maps SKUs to collections for footprint calculation
 * 
 * Trigger: Shipments with status='on_hold' AND 'MOVE OVER' tag AND no existing QC items
 */

import { db } from '../db';
import { 
  shipments, 
  shipmentItems, 
  shipmentTags, 
  shipmentQcItems,
  productCollectionMappings,
  type InsertShipmentQcItem,
} from '@shared/schema';
import { eq, and, exists, sql, notExists } from 'drizzle-orm';
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
  error?: string;
}

interface HydrationStats {
  shipmentsProcessed: number;
  shipmentsSkipped: number;
  totalItemsCreated: number;
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
    .where(sql`${productCollectionMappings.sku} = ANY(${skus})`);
  
  const cache = new Map<string, string>();
  for (const r of results as { sku: string; collectionId: string }[]) {
    cache.set(r.sku, r.collectionId);
  }
  return cache;
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
    
    return { shipmentId, orderNumber, itemsCreated: qcItemsToInsert.length };
    
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
      }
    }
    
    log(`Hydration complete: ${stats.shipmentsProcessed} processed, ${stats.totalItemsCreated} items created`);
    
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
