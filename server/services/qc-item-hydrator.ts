/**
 * QC Item Hydrator Service
 * 
 * Populates shipment_qc_items table for shipments in the READY_TO_SESSION lifecycle phase.
 * - Explodes kits into component SKUs using cached kit mappings
 * - Gets barcodes from cached product catalog
 * - Maps SKUs to collections for fingerprint calculation
 * - Calculates fingerprint signature and creates/matches fingerprints
 * 
 * Trigger: READY_TO_SESSION phase = on_hold + MOVE OVER tag + no session + no QC items
 * 
 * This must run BEFORE SkuVault picks up orders for sessioning to ensure:
 * 1. QC items are exploded and barcodes are available for scanning
 * 2. Fingerprints are calculated for packaging decisions
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
  fingerprintModels,
  packagingTypes,
  stations,
  skuvaultProducts,
  type InsertShipmentQcItem,
  type InsertFingerprint,
} from '@shared/schema';
import { eq, and, or, exists, sql, notExists, inArray, isNull } from 'drizzle-orm';
import { 
  isKit, 
  getKitComponents,
  getKitCacheStats,
  preloadKitMappings,
} from './kit-mappings-cache';
import { getProductsBatch, type ProductInfo } from './product-lookup';
import { queueLifecycleEvaluation } from './lifecycle-service';
import { storage } from '../storage';

const log = (message: string) => console.log(`[qc-item-hydrator] ${message}`);

interface HydrationResult {
  shipmentId: string;
  orderNumber: string;
  itemsCreated: number;
  fingerprintStatus?: 'complete' | 'pending_categorization' | 'missing_weight';
  fingerprintIsNew?: boolean;
  uncategorizedSkuCount?: number;
  missingWeightSkuCount?: number;
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
 * Criteria: pending status + MOVE OVER tag + no session yet + no existing shipment_qc_items
 * 
 * This targets the READY_TO_SESSION lifecycle phase - shipments that need fingerprinting
 * before they can be picked up by SkuVault sessioning.
 * 
 * Note: on_hold is BEFORE fulfillment starts, pending is when orders are ready to be sessioned
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
        // Status is pending (READY_TO_SESSION phase criteria)
        // on_hold is BEFORE fulfillment starts
        eq(shipments.shipmentStatus, 'pending'),
        // Has MOVE OVER tag (READY_TO_SESSION phase criteria)
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
        // Not yet picked up by SkuVault (READY_TO_SESSION phase criteria)
        sql`${shipments.sessionStatus} IS NULL`,
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
  status: 'complete' | 'pending_categorization' | 'missing_weight';
  fingerprintId?: string;
  isNew?: boolean;
  uncategorizedSkus?: string[];
  missingWeightSkus?: string[];
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
  
  // Check for items with missing weights (null or 0)
  const missingWeightSkus: string[] = [];
  for (const item of qcItems) {
    if (!item.weightValue || item.weightValue === 0) {
      missingWeightSkus.push(item.sku);
    }
  }
  
  if (missingWeightSkus.length > 0) {
    // Mark shipment as missing weight data
    await db
      .update(shipments)
      .set({ fingerprintStatus: 'missing_weight' })
      .where(eq(shipments.id, shipmentId));
    
    return { 
      status: 'missing_weight', 
      missingWeightSkus: Array.from(new Set(missingWeightSkus)) // Unique SKUs
    };
  }
  
  // All items have collections and weights - aggregate by collection and calculate total weight
  const collectionQuantities = new Map<string, number>();
  let totalWeight = 0;
  let weightUnit = 'oz'; // Default weight unit
  
  for (const item of qcItems) {
    const collectionId = collectionCache.get(item.sku)!;
    const current = collectionQuantities.get(collectionId) || 0;
    collectionQuantities.set(collectionId, current + item.quantityExpected);
    
    // Calculate weight: weightValue × quantity
    totalWeight += item.weightValue! * item.quantityExpected;
    if (item.weightUnit) {
      weightUnit = item.weightUnit; // Use the weight unit from items
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
  
  // Check if this fingerprint already has a packaging model assigned
  // If so, auto-assign the packaging type and station to the new shipment
  let packagingTypeId: string | null = null;
  let assignedStationId: string | null = null;
  
  const existingModel = await db
    .select({
      packagingTypeId: fingerprintModels.packagingTypeId,
    })
    .from(fingerprintModels)
    .where(eq(fingerprintModels.fingerprintId, fingerprintId))
    .limit(1);
  
  if (existingModel.length > 0 && existingModel[0].packagingTypeId) {
    packagingTypeId = existingModel[0].packagingTypeId;
    
    // Look up station by packaging type's station type
    const [packagingType] = await db
      .select({ stationType: packagingTypes.stationType })
      .from(packagingTypes)
      .where(eq(packagingTypes.id, packagingTypeId))
      .limit(1);
    
    if (packagingType?.stationType) {
      const [station] = await db
        .select({ id: stations.id, name: stations.name })
        .from(stations)
        .where(and(
          eq(stations.stationType, packagingType.stationType),
          eq(stations.isActive, true)
        ))
        .limit(1);
      
      if (station) {
        assignedStationId = station.id;
        log(`Auto-assigned packaging and station for existing fingerprint: packaging=${packagingTypeId}, station=${station.name}`);
      }
    }
  }
  
  // Update shipment with fingerprint and inherited packaging/station
  const updateData: Record<string, any> = { 
    fingerprintId,
    fingerprintStatus: 'complete',
  };
  
  if (packagingTypeId) {
    updateData.packagingTypeId = packagingTypeId;
    updateData.packagingDecisionType = 'auto';
  }
  if (assignedStationId) {
    updateData.assignedStationId = assignedStationId;
  }
  
  await db
    .update(shipments)
    .set(updateData)
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
    
    // Get excluded SKUs set for filtering kit components (e.g., BUILDBAG, BUILDBOX)
    const excludedSkus = await storage.getExcludedExplosionSkuSet();
    
    // Phase 1: Pre-fetch product info to check product categories before explosion
    // We need productCategory to determine if a SKU should be exploded
    const rawSkus = items.map(item => item.sku).filter((sku): sku is string => !!sku);
    const preProductCache = await getProductsBatch(rawSkus);
    
    // Preload kit mappings for all SKUs (batch query is more efficient)
    await preloadKitMappings(rawSkus);
    
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
      
      // Skip excluded SKUs at top level (e.g., BUILDBAG, BUILDBOX, BUILDJAS as line items)
      if (excludedSkus.has(sku)) {
        log(`Skipping excluded top-level SKU: ${sku} from order ${orderNumber}`);
        continue;
      }
      
      // Determine if product should be exploded into components
      const productInfo = preProductCache.get(sku);
      const isKitCategory = productInfo?.productCategory?.toLowerCase() === 'kit';
      const isAssembledProduct = productInfo?.isAssembledProduct ?? false;
      const quantityOnHand = productInfo?.quantityOnHand ?? 0;
      const hasKitComponents = await isKit(sku);
      
      // Explode if:
      // 1. Product category is 'kit' AND has component mappings, OR
      // 2. Product is an AP (Assembled Product) with zero stock AND has component mappings
      //    (APs with zero stock need to be built at fulfillment time like kits)
      const shouldExplodeAsKit = isKitCategory && hasKitComponents;
      const shouldExplodeAsOutOfStockAP = isAssembledProduct && quantityOnHand === 0 && hasKitComponents;
      const shouldExplode = shouldExplodeAsKit || shouldExplodeAsOutOfStockAP;
      
      if (shouldExplodeAsOutOfStockAP && !shouldExplodeAsKit) {
        log(`AP explosion (zero stock): ${sku} has qty=${quantityOnHand}, exploding into components`);
      }
      
      if (shouldExplode) {
        const components = await getKitComponents(sku);
        if (components && components.length > 0) {
          for (const comp of components) {
            // Skip excluded SKUs (e.g., BUILDBAG, BUILDBOX, BUILDJAS)
            if (excludedSkus.has(comp.componentSku)) {
              log(`Skipping excluded component SKU: ${comp.componentSku} from kit ${sku}`);
              continue;
            }
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
        
        // DEFENSIVE: If product not found in catalog, defer hydration
        // This prevents race condition where sync is running and catalog is incomplete
        if (!productInfo) {
          log(`Product not found in catalog: ${sku} - deferring hydration for order ${orderNumber}`);
          return { 
            shipmentId, 
            orderNumber, 
            itemsCreated: 0, 
            error: `Product ${sku} not in catalog - will retry when catalog is available` 
          };
        }
        
        const fulfillSku = productInfo.parentSku || sku;
        const isVariant = !!productInfo.parentSku;
        
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
    
    // Phase 2.5: Aggregate items by SKU to sum quantities
    // This prevents the upsert from overwriting kit-exploded components with direct line items
    // Example: Kit explodes to 7x SKU-A, plus direct line item 1x SKU-A = 8x SKU-A total
    const aggregatedItems = new Map<string, ItemToProcess>();
    for (const item of itemsToProcess) {
      const existing = aggregatedItems.get(item.sku);
      if (existing) {
        // Sum quantities
        existing.quantity += item.quantity;
        // If any instance is a kit component, mark as such (preserve kit lineage)
        if (item.isKitComponent) {
          existing.isKitComponent = true;
          existing.parentSku = item.parentSku;
        }
      } else {
        // Clone to avoid mutating original
        aggregatedItems.set(item.sku, { ...item });
      }
    }
    const aggregatedItemsArray = Array.from(aggregatedItems.values());
    
    // Phase 3: Batch fetch product info for all SKUs (including kit components)
    // This may include new SKUs from kit explosion that weren't in preProductCache
    const productCache = await getProductsBatch(skusToLookup);
    
    // Phase 4: Build QC items with product info (using aggregated items)
    const qcItemsToInsert: InsertShipmentQcItem[] = [];
    const allSkus: string[] = [];
    
    for (const item of aggregatedItemsArray) {
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
        physicalLocation: product?.physicalLocation || null,
      });
    }
    
    // Phase 4: Batch fetch collection mappings
    const collectionCache = await buildCollectionCache(allSkus);
    
    // Fill in collection IDs
    for (const qcItem of qcItemsToInsert) {
      qcItem.collectionId = collectionCache.get(qcItem.sku) || null;
    }
    
    // Upsert all QC items (use ON CONFLICT to prevent duplicates)
    // If a shipment+sku already exists, update the quantity and other fields
    // Note: We must provide explicit IDs because Drizzle's onConflictDoUpdate 
    // doesn't correctly use database defaults when the conflict target differs from PK
    for (const qcItem of qcItemsToInsert) {
      await db
        .insert(shipmentQcItems)
        .values({
          ...qcItem,
          id: crypto.randomUUID(), // Explicitly provide UUID for new inserts
        } as any)
        .onConflictDoUpdate({
          target: [shipmentQcItems.shipmentId, shipmentQcItems.sku],
          set: {
            quantityExpected: qcItem.quantityExpected,
            barcode: qcItem.barcode,
            description: qcItem.description,
            imageUrl: qcItem.imageUrl,
            collectionId: qcItem.collectionId,
            isKitComponent: qcItem.isKitComponent,
            parentSku: qcItem.parentSku,
            weightValue: qcItem.weightValue,
            weightUnit: qcItem.weightUnit,
            physicalLocation: qcItem.physicalLocation,
            updatedAt: new Date(),
          },
        });
    }
    
    // Increment pending_quantity in skuvault_products for each SKU
    // This tracks orders that are hydrated but not yet in a session
    // Pending inventory doesn't block availability - it only becomes "allocated" when session is built
    const skuQuantities: Record<string, number> = {};
    for (const qcItem of qcItemsToInsert) {
      const qty = qcItem.quantityExpected ?? 0;
      skuQuantities[qcItem.sku] = (skuQuantities[qcItem.sku] || 0) + qty;
    }
    
    for (const sku of Object.keys(skuQuantities)) {
      const quantity = skuQuantities[sku];
      await db
        .update(skuvaultProducts)
        .set({
          pendingQuantity: sql`${skuvaultProducts.pendingQuantity} + ${quantity}`,
          updatedAt: new Date(),
        })
        .where(eq(skuvaultProducts.sku, sku));
    }
    
    // Calculate and assign fingerprint
    const fingerprintResult = await calculateFingerprint(shipmentId);
    
    // Queue lifecycle evaluation for async processing (fingerprint calculation)
    // This enables side effects like auto rate check to be triggered
    await queueLifecycleEvaluation(shipmentId, 'fingerprint', orderNumber);
    
    return { 
      shipmentId, 
      orderNumber, 
      itemsCreated: qcItemsToInsert.length,
      fingerprintStatus: fingerprintResult.status,
      fingerprintIsNew: fingerprintResult.isNew,
      uncategorizedSkuCount: fingerprintResult.uncategorizedSkus?.length,
      missingWeightSkuCount: fingerprintResult.missingWeightSkus?.length,
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
 * 
 * Also handles:
 * - needs_recalc: Collection changed, needs fresh fingerprint
 * - missing_weight: Products missing weight data
 * - pending_categorization: Products not yet assigned to geometry collections
 */
export async function backfillFingerprints(limit: number = 100): Promise<{
  processed: number;
  complete: number;
  pendingCategorization: number;
  missingWeight: number;
  needsRecalc: number;
  newFingerprints: number;
  errors: string[];
}> {
  const result = {
    processed: 0,
    complete: 0,
    pendingCategorization: 0,
    missingWeight: 0,
    needsRecalc: 0,
    newFingerprints: 0,
    errors: [] as string[],
  };
  
  try {
    // Find shipments with QC items that need fingerprint calculation
    // This includes:
    // - no fingerprint_status yet
    // - pending_categorization: products not yet assigned to collections
    // - missing_weight: products missing weight data (retry in case weight synced)
    // - needs_recalc: collection changed, need fresh fingerprint
    // - has a fingerprint with 0 weight (weight data was missing at creation time)
    const shipmentsToProcess = await db
      .select({
        id: shipments.id,
        orderNumber: shipments.orderNumber,
        fingerprintStatus: shipments.fingerprintStatus,
      })
      .from(shipments)
      .leftJoin(fingerprints, eq(shipments.fingerprintId, fingerprints.id))
      .where(
        and(
          // Has QC items
          exists(
            db.select({ one: sql`1` })
              .from(shipmentQcItems)
              .where(eq(shipmentQcItems.shipmentId, shipments.id))
          ),
          or(
            sql`${shipments.fingerprintStatus} IS NULL`,
            eq(shipments.fingerprintStatus, 'pending_categorization'),
            eq(shipments.fingerprintStatus, 'missing_weight'),
            eq(shipments.fingerprintStatus, 'needs_recalc'),
            // Include shipments with complete fingerprints that have 0 weight
            and(
              eq(shipments.fingerprintStatus, 'complete'),
              sql`${fingerprints.totalWeight} = 0`
            )
          )
        )
      )
      .limit(limit);
    
    if (shipmentsToProcess.length === 0) {
      log('Backfill: No shipments need fingerprint calculation');
      return result;
    }
    
    // Count by status for logging
    const statusCounts = shipmentsToProcess.reduce((acc, s) => {
      const status = s.fingerprintStatus || 'null';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    log(`Backfill: Found ${shipmentsToProcess.length} shipments needing fingerprint calculation (${JSON.stringify(statusCounts)})`);
    
    for (const shipment of shipmentsToProcess) {
      try {
        const fingerprintResult = await calculateFingerprint(shipment.id);
        result.processed++;
        
        if (fingerprintResult.status === 'complete') {
          result.complete++;
          if (fingerprintResult.isNew) {
            result.newFingerprints++;
          }
          // Queue lifecycle evaluation for async processing (batch fingerprint)
          await queueLifecycleEvaluation(shipment.id, 'fingerprint', shipment.orderNumber || undefined);
        } else if (fingerprintResult.status === 'missing_weight') {
          result.missingWeight++;
        } else if (fingerprintResult.status === 'pending_categorization') {
          result.pendingCategorization++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${shipment.orderNumber}: ${errorMsg}`);
      }
    }
    
    log(`Backfill complete: ${result.processed} processed, ${result.complete} complete (${result.newFingerprints} new), ${result.pendingCategorization} pending cat, ${result.missingWeight} missing weight`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Backfill failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}

/**
 * Repair job: Find and re-hydrate shipments with un-exploded kits
 * 
 * PROBLEM: Sometimes kits get stored in shipment_qc_items without being exploded
 * into their component SKUs. This happens when:
 * 1. Kit mappings cache was stale during initial hydration
 * 2. Kit mappings weren't synced yet when the shipment was hydrated
 * 
 * DETECTION: Find QC items where:
 * - SKU exists in kit_component_mappings (meaning it should have been exploded)
 * - is_kit_component = false (meaning it wasn't treated as a kit component)
 * - collection_id IS NULL (meaning it doesn't have a collection mapping)
 * 
 * FIX: Delete the bad QC items and re-run hydration for affected shipments
 */
export async function repairUnexplodedKits(limit: number = 50): Promise<{
  shipmentsRepaired: number;
  shipmentsSkipped: number;
  errors: string[];
}> {
  const result = {
    shipmentsRepaired: 0,
    shipmentsSkipped: 0,
    errors: [] as string[],
  };
  
  try {
    // Import kitComponentMappings for the repair query
    const { kitComponentMappings } = await import('@shared/schema');
    
    // Find shipments with un-exploded kit SKUs
    // These are QC items where the SKU:
    // 1. Exists in kit_component_mappings (it's a kit that should be exploded)
    // 2. Is marked as is_kit_component = false (it wasn't exploded)
    // 3. Has no collection_id (kits typically don't have direct collection mappings)
    const affectedShipments = await db
      .selectDistinct({
        shipmentId: shipmentQcItems.shipmentId,
        orderNumber: shipments.orderNumber,
      })
      .from(shipmentQcItems)
      .innerJoin(shipments, eq(shipments.id, shipmentQcItems.shipmentId))
      .innerJoin(kitComponentMappings, eq(kitComponentMappings.kitSku, shipmentQcItems.sku))
      .where(
        and(
          eq(shipmentQcItems.isKitComponent, false),
          sql`${shipmentQcItems.collectionId} IS NULL`
        )
      )
      .limit(limit);
    
    if (affectedShipments.length === 0) {
      log('Repair: No shipments with un-exploded kits found');
      return result;
    }
    
    log(`Repair: Found ${affectedShipments.length} shipments with un-exploded kit SKUs`);
    
    for (const shipment of affectedShipments) {
      try {
        // Delete all existing QC items for this shipment
        await db
          .delete(shipmentQcItems)
          .where(eq(shipmentQcItems.shipmentId, shipment.shipmentId));
        
        // Clear fingerprint data so it gets recalculated
        await db
          .update(shipments)
          .set({
            fingerprintId: null,
            fingerprintStatus: null,
            packagingTypeId: null,
            assignedStationId: null,
            packagingDecisionType: null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipment.shipmentId));
        
        // Re-hydrate the shipment (this will explode kits correctly now)
        const hydrationResult = await hydrateShipment(
          shipment.shipmentId, 
          shipment.orderNumber || 'unknown'
        );
        
        if (hydrationResult.error) {
          result.errors.push(`${shipment.orderNumber}: ${hydrationResult.error}`);
          result.shipmentsSkipped++;
        } else {
          result.shipmentsRepaired++;
          log(`Repaired ${shipment.orderNumber}: ${hydrationResult.itemsCreated} items, fingerprint ${hydrationResult.fingerprintStatus}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${shipment.orderNumber}: ${errorMsg}`);
        result.shipmentsSkipped++;
      }
    }
    
    log(`Repair complete: ${result.shipmentsRepaired} repaired, ${result.shipmentsSkipped} skipped, ${result.errors.length} errors`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Repair failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}

/**
 * Repair job: Find and re-hydrate shipments with un-substituted variant SKUs
 * 
 * PROBLEM: Sometimes variant SKUs get stored in shipment_qc_items without being
 * substituted with their parent SKU. This happens when:
 * 1. Product catalog was being synced during hydration (race condition with truncate+insert)
 * 2. Product catalog didn't have parentSku set when hydration ran
 * 
 * DETECTION: Find QC items where:
 * - SKU has a parent_sku in skuvault_products (meaning it's a variant)
 * - is_kit_component = false (meaning it's not already a kit component)
 * 
 * FIX: Delete the bad QC items and re-run hydration for affected shipments
 */
export async function repairUnsubstitutedVariants(limit: number = 50): Promise<{
  shipmentsRepaired: number;
  shipmentsSkipped: number;
  variantsFound: string[];
  errors: string[];
}> {
  const result = {
    shipmentsRepaired: 0,
    shipmentsSkipped: 0,
    variantsFound: [] as string[],
    errors: [] as string[],
  };
  
  try {
    // Find shipments with un-substituted variant SKUs
    // These are QC items where the SKU:
    // 1. Exists in skuvault_products with a parent_sku (it's a variant)
    // 2. Is marked as is_kit_component = false (it's a regular line item, not kit component)
    const affectedShipments = await db
      .selectDistinct({
        shipmentId: shipmentQcItems.shipmentId,
        orderNumber: shipments.orderNumber,
        variantSku: shipmentQcItems.sku,
        parentSku: skuvaultProducts.parentSku,
      })
      .from(shipmentQcItems)
      .innerJoin(shipments, eq(shipments.id, shipmentQcItems.shipmentId))
      .innerJoin(skuvaultProducts, eq(skuvaultProducts.sku, shipmentQcItems.sku))
      .where(
        and(
          eq(shipmentQcItems.isKitComponent, false),
          sql`${skuvaultProducts.parentSku} IS NOT NULL`,
          // Only repair shipments that haven't shipped yet
          isNull(shipments.trackingNumber),
          isNull(shipments.shipDate)
        )
      )
      .limit(limit);
    
    if (affectedShipments.length === 0) {
      log('Repair variants: No shipments with un-substituted variants found');
      return result;
    }
    
    // Track unique variants found
    const variantSet = new Set<string>();
    for (const s of affectedShipments) {
      variantSet.add(`${s.variantSku} → ${s.parentSku}`);
    }
    result.variantsFound = Array.from(variantSet);
    
    // Group by shipmentId to avoid processing same shipment multiple times
    const uniqueShipmentIds = new Map<string, string>();
    for (const s of affectedShipments) {
      if (!uniqueShipmentIds.has(s.shipmentId)) {
        uniqueShipmentIds.set(s.shipmentId, s.orderNumber || 'unknown');
      }
    }
    
    log(`Repair variants: Found ${uniqueShipmentIds.size} shipments with ${result.variantsFound.length} un-substituted variants`);
    
    for (const [shipmentId, orderNumber] of Array.from(uniqueShipmentIds.entries())) {
      try {
        // Delete all existing QC items for this shipment
        await db
          .delete(shipmentQcItems)
          .where(eq(shipmentQcItems.shipmentId, shipmentId));
        
        // Clear fingerprint data so it gets recalculated
        await db
          .update(shipments)
          .set({
            fingerprintId: null,
            fingerprintStatus: null,
            packagingTypeId: null,
            assignedStationId: null,
            packagingDecisionType: null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipmentId));
        
        // Re-hydrate the shipment (this will substitute variants correctly now)
        const hydrationResult = await hydrateShipment(shipmentId, orderNumber);
        
        if (hydrationResult.error) {
          result.errors.push(`${orderNumber}: ${hydrationResult.error}`);
          result.shipmentsSkipped++;
        } else {
          result.shipmentsRepaired++;
          log(`Repaired variants in ${orderNumber}: ${hydrationResult.itemsCreated} items, fingerprint ${hydrationResult.fingerprintStatus}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${orderNumber}: ${errorMsg}`);
        result.shipmentsSkipped++;
      }
    }
    
    log(`Repair variants complete: ${result.shipmentsRepaired} repaired, ${result.shipmentsSkipped} skipped, ${result.errors.length} errors`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Repair variants failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}

/**
 * Repair job: Find and re-hydrate shipments with missing weights that now have weights
 * 
 * PROBLEM: Shipments get fingerprint_status='missing_weight' when products in their
 * QC items don't have weight data in skuvault_products at hydration time. Later,
 * users add weights to the product catalog, but these shipments remain stuck.
 * 
 * DETECTION: Find shipments where:
 * - fingerprint_status = 'missing_weight'
 * - Has QC items with NULL/0 weight
 * - The SKU now has valid weight in skuvault_products
 * - Not yet shipped (no tracking number or ship date)
 * 
 * FIX: Delete the QC items and re-run hydration with the correct weights
 */
export async function repairMissingWeightShipments(limit: number = 50): Promise<{
  shipmentsRepaired: number;
  shipmentsSkipped: number;
  skusWithNewWeights: string[];
  errors: string[];
}> {
  const result = {
    shipmentsRepaired: 0,
    shipmentsSkipped: 0,
    skusWithNewWeights: [] as string[],
    errors: [] as string[],
  };
  
  try {
    // Find shipments with missing_weight status where SKUs now have weights
    // These are shipments where:
    // 1. fingerprint_status = 'missing_weight'
    // 2. Have QC items with NULL or 0 weight
    // 3. The SKU now has valid weight in skuvault_products
    // 4. Not yet shipped
    const affectedShipments = await db.execute(sql`
      SELECT DISTINCT
        s.id as "shipmentId",
        s.order_number as "orderNumber",
        array_agg(DISTINCT qc.sku) as "skusToRepair"
      FROM shipments s
      INNER JOIN shipment_qc_items qc ON qc.shipment_id = s.id
      INNER JOIN skuvault_products sv ON sv.sku = qc.sku
      WHERE s.fingerprint_status = 'missing_weight'
        AND s.tracking_number IS NULL
        AND s.ship_date IS NULL
        AND (qc.weight_value IS NULL OR qc.weight_value = 0)
        AND sv.weight_value IS NOT NULL 
        AND sv.weight_value > 0
      GROUP BY s.id, s.order_number
      LIMIT ${limit}
    `);
    
    const shipmentsToRepair = affectedShipments.rows as Array<{
      shipmentId: string;
      orderNumber: string;
      skusToRepair: string[];
    }>;
    
    if (shipmentsToRepair.length === 0) {
      log('Repair missing weights: No shipments need repair');
      return result;
    }
    
    // Collect all unique SKUs that now have weights
    const allSkus = new Set<string>();
    for (const shipment of shipmentsToRepair) {
      if (shipment.skusToRepair) {
        shipment.skusToRepair.forEach(sku => allSkus.add(sku));
      }
    }
    result.skusWithNewWeights = Array.from(allSkus);
    
    log(`Repair missing weights: Found ${shipmentsToRepair.length} shipments with ${result.skusWithNewWeights.length} SKUs that now have weights`);
    
    for (const shipment of shipmentsToRepair) {
      try {
        const { shipmentId, orderNumber } = shipment;
        
        // Delete all existing QC items for this shipment
        await db
          .delete(shipmentQcItems)
          .where(eq(shipmentQcItems.shipmentId, shipmentId));
        
        // Clear fingerprint data so it gets recalculated
        await db
          .update(shipments)
          .set({
            fingerprintId: null,
            fingerprintStatus: null,
            packagingTypeId: null,
            assignedStationId: null,
            packagingDecisionType: null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipmentId));
        
        // Re-hydrate the shipment (this will use the correct weights now)
        const hydrationResult = await hydrateShipment(
          shipmentId, 
          orderNumber || 'unknown'
        );
        
        if (hydrationResult.error) {
          result.errors.push(`${orderNumber}: ${hydrationResult.error}`);
          result.shipmentsSkipped++;
        } else {
          result.shipmentsRepaired++;
          log(`Repaired weights in ${orderNumber}: ${hydrationResult.itemsCreated} items, fingerprint ${hydrationResult.fingerprintStatus}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`${shipment.orderNumber}: ${errorMsg}`);
        result.shipmentsSkipped++;
      }
    }
    
    log(`Repair missing weights complete: ${result.shipmentsRepaired} repaired, ${result.shipmentsSkipped} skipped, ${result.errors.length} errors`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Repair missing weights failed: ${errorMsg}`);
    result.errors.push(`Fatal: ${errorMsg}`);
  }
  
  return result;
}

/**
 * Centralized handler for when product collection assignments change
 * Called from any collection mutation (add/remove product, delete collection)
 * 
 * This function:
 * 1. Finds all shipments with QC items containing the affected SKUs
 * 2. Clears their fingerprint assignment
 * 3. Sets fingerprint_status to 'needs_recalc'
 * 4. The next sync cycle will automatically recalculate their fingerprints
 * 
 * @param affectedSkus - Array of SKUs whose collection assignment changed
 * @returns Object with count of affected shipments and any errors
 */
export async function onCollectionChanged(affectedSkus: string[]): Promise<{
  shipmentsInvalidated: number;
  fingerprintsOrphaned: string[];
  errors: string[];
}> {
  const result = {
    shipmentsInvalidated: 0,
    fingerprintsOrphaned: [] as string[],
    errors: [] as string[],
  };
  
  if (affectedSkus.length === 0) {
    return result;
  }
  
  try {
    log(`onCollectionChanged: Processing ${affectedSkus.length} affected SKUs`);
    
    // Find all shipments that have QC items with any of the affected SKUs
    // Only consider shipments that haven't shipped yet (no tracking number, no ship date)
    const affectedShipments = await db
      .selectDistinct({
        shipmentId: shipmentQcItems.shipmentId,
        fingerprintId: shipments.fingerprintId,
      })
      .from(shipmentQcItems)
      .innerJoin(shipments, eq(shipments.id, shipmentQcItems.shipmentId))
      .where(and(
        inArray(shipmentQcItems.sku, affectedSkus),
        isNull(shipments.trackingNumber),
        isNull(shipments.shipDate)
      ));
    
    if (affectedShipments.length === 0) {
      log('onCollectionChanged: No active shipments affected');
      return result;
    }
    
    log(`onCollectionChanged: Found ${affectedShipments.length} shipments to invalidate`);
    
    // Collect unique fingerprint IDs that may become orphaned
    const fingerprintIds = new Set<string>();
    for (const shipment of affectedShipments) {
      if (shipment.fingerprintId) {
        fingerprintIds.add(shipment.fingerprintId);
      }
    }
    
    // Invalidate all affected shipments in a single batch update
    const shipmentIds = affectedShipments.map(s => s.shipmentId);
    
    await db
      .update(shipments)
      .set({
        fingerprintId: null,
        fingerprintStatus: 'needs_recalc',
        packagingTypeId: null,
        assignedStationId: null,
        packagingDecisionType: null,
        updatedAt: new Date(),
      })
      .where(inArray(shipments.id, shipmentIds));
    
    result.shipmentsInvalidated = shipmentIds.length;
    result.fingerprintsOrphaned = Array.from(fingerprintIds);
    
    log(`onCollectionChanged: Invalidated ${result.shipmentsInvalidated} shipments, ${result.fingerprintsOrphaned.length} fingerprints may be orphaned`);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`onCollectionChanged error: ${errorMsg}`);
    result.errors.push(errorMsg);
  }
  
  return result;
}
