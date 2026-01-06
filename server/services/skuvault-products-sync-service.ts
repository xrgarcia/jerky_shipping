/**
 * SkuVault Products Sync Service
 * 
 * Synchronizes product catalog data from the reporting database (GCP PostgreSQL)
 * to the local skuvault_products table. Runs hourly and detects new data by
 * comparing stock_check_date values.
 * 
 * Data sources (merged in order):
 * 1. Kit products: internal_kit_inventory (kits with cost/barcode)
 * 2. Parent products: internal_inventory WHERE sku = primary_sku (individual products with weight)
 * 3. Variant products: internal_inventory WHERE sku != primary_sku (variants with parent_sku)
 * 
 * Merge logic: Later queries fill missing fields, conflicts are logged.
 * 
 * Image URL resolution priority (waterfall):
 * 1. shopifyProductVariants.imageUrl (variant-specific image)
 * 2. shopifyProducts.imageUrl (parent product image - Shopify often stores images here)
 * 3. shipmentItems.imageUrl (most recent order)
 * 4. null (fallback)
 */

import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { skuvaultProducts, shopifyProductVariants, shopifyProducts, shipmentItems, shipments } from '@shared/schema';
import { eq, sql, desc, isNull } from 'drizzle-orm';
import { getRedisClient } from '../utils/queue';

const log = (message: string) => console.log(`[skuvault-products-sync] ${message}`);

const LAST_SYNCED_DATE_KEY = 'skuvault_products:last_synced_date';

interface ReportingProduct {
  sku: string;
  stock_check_date: Date;
  product_title: string | null;
  barcode: string | null;
  product_category: string | null;
  is_assembled_product: boolean;
  unit_cost: string | null;
  weight_value: number | null; // Decimal value (e.g., 2.5 for 2.5oz)
  weight_unit: string | null;
  parent_sku: string | null; // For variants: the parent SKU (null for parents/kits)
  quantity_on_hand: number | null; // Current stock quantity from SkuVault
  brand: string | null; // Brand name (e.g., "Jerky.com", "Klements") - null for kits, filled from parent/variant queries
}

/**
 * Merge two product records.
 * 
 * @param existing - The existing product record
 * @param incoming - The incoming product record to merge
 * @param sourceLabel - Label for logging (e.g., 'parent', 'variant')
 * @param override - If true, incoming values override existing values (for parent merge).
 *                   If false, only fills missing fields (for variant merge).
 */
function mergeProducts(
  existing: ReportingProduct,
  incoming: ReportingProduct,
  sourceLabel: string,
  override: boolean = false
): ReportingProduct {
  const merged: ReportingProduct = { ...existing };
  
  // Helper to merge a field
  const mergeField = <K extends keyof ReportingProduct>(field: K) => {
    const existingVal = existing[field];
    const incomingVal = incoming[field];
    
    if (override && incomingVal != null) {
      // Override mode: incoming value takes precedence when non-null
      (merged as any)[field] = incomingVal;
    } else if (existingVal == null && incomingVal != null) {
      // Fill mode: only fill missing fields from incoming
      (merged as any)[field] = incomingVal;
    }
    // If existing has value and incoming is null, keep existing (no action needed)
  };
  
  // Merge all fields except sku (primary key)
  mergeField('stock_check_date');
  mergeField('product_title');
  mergeField('barcode');
  mergeField('product_category');
  mergeField('is_assembled_product');
  mergeField('unit_cost');
  mergeField('weight_value');
  mergeField('weight_unit');
  mergeField('parent_sku');
  mergeField('quantity_on_hand');
  mergeField('brand');
  
  return merged;
}

/**
 * Get the latest stock_check_date from the reporting database
 */
export async function getLatestStockCheckDate(): Promise<Date | null> {
  try {
    const result = await reportingSql`
      SELECT MAX(stock_check_date) as max_date
      FROM public.inventory_forecasts_daily
    `;
    return result[0]?.max_date || null;
  } catch (error) {
    log(`Error getting latest stock check date: ${error}`);
    throw error;
  }
}

/**
 * Get the last synced date from Redis
 */
export async function getLastSyncedDate(): Promise<string | null> {
  const redis = getRedisClient();
  return redis.get<string>(LAST_SYNCED_DATE_KEY);
}

/**
 * Set the last synced date in Redis
 */
async function setLastSyncedDate(dateStr: string): Promise<void> {
  const redis = getRedisClient();
  await redis.set(LAST_SYNCED_DATE_KEY, dateStr);
}

/**
 * Fetch products from reporting database (3-way merge)
 * 
 * Order of queries:
 * 1. Kits: internal_kit_inventory (is_assembled_product=true, cost)
 * 2. Parents: internal_inventory WHERE sku = primary_sku (weight, barcode)
 * 3. Variants: internal_inventory WHERE sku != primary_sku (weight, barcode, parent_sku)
 * 
 * Later queries fill missing fields, conflicts are logged.
 */
async function fetchProductsFromReporting(): Promise<ReportingProduct[]> {
  log('Fetching products from reporting database (3-way merge)...');
  
  // 1. Fetch kit products (no weight data, but have cost)
  // NOTE: is_assembled_product=false because kits are EXPLODED at fulfillment time
  // APs (pre-built products) have is_assembled_product=true and are NOT exploded
  // Kits don't have their own brand - they inherit from parent query during merge
  const kitProducts = await reportingSql<ReportingProduct[]>`
    SELECT 
      sku,
      snapshot_timestamp as stock_check_date,
      description as product_title,
      code as barcode,
      'kit' as product_category,
      false as is_assembled_product, 
      cost::text as unit_cost,
      NULL::real as weight_value,
      NULL::text as weight_unit,
      NULL::text as parent_sku,
      available_quantity as quantity_on_hand,
      NULL::text as brand
    FROM 
      public.internal_kit_inventory 
    WHERE snapshot_timestamp = (
      SELECT MAX(i.snapshot_timestamp) 
      FROM public.internal_kit_inventory i
    )
  `;
  
  log(`[1/3] Fetched ${kitProducts.length} kit products`);
  
  // 2. Fetch parent products (sku = primary_sku) with weight data and brand
  const parentProducts = await reportingSql<ReportingProduct[]>`
    SELECT
      sku,
      snapshot_timestamp AS stock_check_date,
      description AS product_title,
      code AS barcode,
      classification AS product_category,
      weight_unit,
      weight_value::real as weight_value,
      COST::text AS unit_cost,
      (CASE WHEN internal_inventory_statuses.status_value THEN true ELSE false END) as is_assembled_product,
      NULL::text as parent_sku,
      quantity_on_hand,
      brand
    FROM
      public.internal_inventory 
    LEFT JOIN 
      public.internal_inventory_statuses 
    ON 
      internal_inventory.snapshot_timestamp = internal_inventory_statuses.inventory_snapshot_timestamp 
      AND internal_inventory.sku = internal_inventory_statuses.inventory_sku
      AND status = 'Assembled Product'
    WHERE
      snapshot_timestamp = (
        SELECT MAX(i.snapshot_timestamp)
        FROM public.internal_inventory i
      )
      AND sku = primary_sku
  `;
  
  log(`[2/3] Fetched ${parentProducts.length} parent products`);
  
  // 3. Fetch variant products (sku != primary_sku) with parent_sku and brand
  const variantProducts = await reportingSql<ReportingProduct[]>`
    SELECT
      sku,
      snapshot_timestamp AS stock_check_date,
      description AS product_title,
      code AS barcode,
      classification AS product_category,
      weight_unit,
      weight_value::real as weight_value,
      COST::text AS unit_cost,
      primary_sku as parent_sku,
      (CASE WHEN internal_inventory_statuses.status_value THEN true ELSE false END) as is_assembled_product,
      quantity_on_hand,
      brand
    FROM
      public.internal_inventory 
    LEFT JOIN 
      public.internal_inventory_statuses 
    ON 
      internal_inventory.snapshot_timestamp = internal_inventory_statuses.inventory_snapshot_timestamp 
      AND internal_inventory.sku = internal_inventory_statuses.inventory_sku
      AND status = 'Assembled Product'
    WHERE
      snapshot_timestamp = (
        SELECT MAX(i.snapshot_timestamp)
        FROM public.internal_inventory i
      )
      AND sku != primary_sku
  `;
  
  log(`[3/3] Fetched ${variantProducts.length} variant products`);
  
  // 3-way merge: kits → parents → variants
  // Later sources fill missing fields, conflicts are logged
  const productMap = new Map<string, ReportingProduct>();
  
  // Add kit products first (baseline)
  for (const product of kitProducts) {
    if (product.sku) {
      productMap.set(product.sku, product);
    }
  }
  log(`After kits: ${productMap.size} products`);
  
  // Merge parent products (OVERRIDE all fields from kit import - parent has real data)
  let parentMerges = 0;
  let parentNew = 0;
  for (const product of parentProducts) {
    if (product.sku) {
      const existing = productMap.get(product.sku);
      if (existing) {
        // Override mode: parent values take precedence over kit placeholder values
        productMap.set(product.sku, mergeProducts(existing, product, 'parent', true));
        parentMerges++;
      } else {
        productMap.set(product.sku, product);
        parentNew++;
      }
    }
  }
  log(`After parents: ${productMap.size} products (${parentNew} new, ${parentMerges} merged/overridden)`);
  
  // Merge variant products (fills parent_sku for variants)
  let variantMerges = 0;
  let variantNew = 0;
  for (const product of variantProducts) {
    if (product.sku) {
      const existing = productMap.get(product.sku);
      if (existing) {
        productMap.set(product.sku, mergeProducts(existing, product, 'variant'));
        variantMerges++;
      } else {
        productMap.set(product.sku, product);
        variantNew++;
      }
    }
  }
  log(`After variants: ${productMap.size} products (${variantNew} new, ${variantMerges} merged)`);
  
  const merged = Array.from(productMap.values());
  log(`Final: ${merged.length} unique products`);
  
  return merged;
}

/**
 * Resolve product image URL using waterfall logic:
 * 1. shopifyProductVariants.imageUrl (variant-specific image)
 * 2. shopifyProducts.imageUrl (parent product image - Shopify often stores images here)
 * 3. shipmentItems (most recent) - by SKU
 * 4. null (fallback)
 */
async function resolveImageUrl(sku: string): Promise<string | null> {
  // 1. Check shopifyProductVariants (variant-specific image)
  const variant = await db
    .select({ 
      variantImageUrl: shopifyProductVariants.imageUrl,
      productId: shopifyProductVariants.productId,
    })
    .from(shopifyProductVariants)
    .where(eq(shopifyProductVariants.sku, sku))
    .limit(1);
  
  if (variant[0]?.variantImageUrl) {
    return variant[0].variantImageUrl;
  }
  
  // 2. Check parent product if variant exists but has no image
  if (variant[0]?.productId) {
    const parentProduct = await db
      .select({ imageUrl: shopifyProducts.imageUrl })
      .from(shopifyProducts)
      .where(eq(shopifyProducts.id, variant[0].productId))
      .limit(1);
    
    if (parentProduct[0]?.imageUrl) {
      return parentProduct[0].imageUrl;
    }
  }
  
  // 3. Check shipmentItems (most recent order) - join with shipments for ordering
  const shipmentItem = await db
    .select({ imageUrl: shipmentItems.imageUrl })
    .from(shipmentItems)
    .innerJoin(shipments, eq(shipmentItems.shipmentId, shipments.id))
    .where(eq(shipmentItems.sku, sku))
    .orderBy(desc(shipments.orderDate))
    .limit(1);
  
  if (shipmentItem[0]?.imageUrl) {
    return shipmentItem[0].imageUrl;
  }
  
  // 4. Fallback to null
  return null;
}

/**
 * Batch resolve image URLs for multiple SKUs
 * Waterfall: variant image → parent product image → shipment item image → null
 */
async function batchResolveImageUrls(skus: string[]): Promise<Map<string, string | null>> {
  const imageMap = new Map<string, string | null>();
  
  if (skus.length === 0) return imageMap;
  
  log(`Resolving image URLs for ${skus.length} SKUs...`);
  
  // Step 1: Batch fetch from shopifyProductVariants (with parent product join for fallback)
  const variantsWithParent = await db
    .select({ 
      sku: shopifyProductVariants.sku, 
      variantImageUrl: shopifyProductVariants.imageUrl,
      parentImageUrl: shopifyProducts.imageUrl,
    })
    .from(shopifyProductVariants)
    .leftJoin(shopifyProducts, eq(shopifyProductVariants.productId, shopifyProducts.id))
    .where(sql`${shopifyProductVariants.sku} IN ${skus}`);
  
  for (const v of variantsWithParent) {
    if (v.sku) {
      // Use variant image if available, otherwise use parent image
      const imageUrl = v.variantImageUrl || v.parentImageUrl;
      if (imageUrl) {
        imageMap.set(v.sku, imageUrl);
      }
    }
  }
  
  // Find SKUs still missing images
  const missingSkus = skus.filter(sku => !imageMap.has(sku));
  
  if (missingSkus.length > 0) {
    // Step 2: Batch fetch from shipmentItems (get most recent per SKU)
    const shipmentImagesRaw = await db
      .select({
        sku: shipmentItems.sku,
        imageUrl: shipmentItems.imageUrl,
        orderDate: shipments.orderDate,
      })
      .from(shipmentItems)
      .innerJoin(shipments, eq(shipmentItems.shipmentId, shipments.id))
      .where(sql`${shipmentItems.sku} IN ${missingSkus} AND ${shipmentItems.imageUrl} IS NOT NULL`)
      .orderBy(desc(shipments.orderDate));
    
    // Keep only first (most recent) per SKU
    for (const si of shipmentImagesRaw) {
      if (si.sku && si.imageUrl && !imageMap.has(si.sku)) {
        imageMap.set(si.sku, si.imageUrl);
      }
    }
  }
  
  // Set null for remaining SKUs
  for (const sku of skus) {
    if (!imageMap.has(sku)) {
      imageMap.set(sku, null);
    }
  }
  
  const withImages = Array.from(imageMap.values()).filter(v => v !== null).length;
  log(`Resolved ${withImages}/${skus.length} SKUs with images`);
  
  return imageMap;
}

/**
 * Sync products from reporting database to local skuvault_products table
 */
export async function syncSkuvaultProducts(): Promise<{
  success: boolean;
  productCount: number;
  stockCheckDate: string | null;
  duration: number;
}> {
  const startTime = Date.now();
  
  try {
    // Fetch products from reporting database
    const products = await fetchProductsFromReporting();
    
    if (products.length === 0) {
      log('No products found in reporting database');
      return {
        success: false,
        productCount: 0,
        stockCheckDate: null,
        duration: Date.now() - startTime,
      };
    }
    
    const stockCheckDate = products[0].stock_check_date;
    const stockCheckDateStr = stockCheckDate.toISOString().split('T')[0];
    
    log(`Processing ${products.length} products for ${stockCheckDateStr}`);
    
    // Batch resolve image URLs
    const skus = products.map(p => p.sku).filter(Boolean);
    const imageMap = await batchResolveImageUrls(skus);
    
    // Truncate existing data and insert new
    log('Truncating existing skuvault_products data...');
    await db.delete(skuvaultProducts);
    
    // Insert in batches of 500
    const BATCH_SIZE = 500;
    let insertedCount = 0;
    
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      
      const insertData = batch.map(p => ({
        sku: p.sku,
        stockCheckDate: p.stock_check_date,
        productTitle: p.product_title,
        barcode: p.barcode,
        productCategory: p.product_category,
        isAssembledProduct: p.is_assembled_product || false,
        unitCost: p.unit_cost,
        productImageUrl: imageMap.get(p.sku) || null,
        weightValue: p.weight_value,
        weightUnit: p.weight_unit,
        parentSku: p.parent_sku,
        quantityOnHand: p.quantity_on_hand ?? 0,
        availableQuantity: p.quantity_on_hand ?? 0, // Reset to match quantityOnHand on each sync
        brand: p.brand,
      }));
      
      await db.insert(skuvaultProducts).values(insertData);
      insertedCount += batch.length;
      
      if (i + BATCH_SIZE < products.length) {
        log(`Inserted ${insertedCount}/${products.length} products...`);
      }
    }
    
    // Update last synced date
    await setLastSyncedDate(stockCheckDateStr);
    
    const duration = Date.now() - startTime;
    log(`Sync complete: ${insertedCount} products in ${duration}ms`);
    
    return {
      success: true,
      productCount: insertedCount,
      stockCheckDate: stockCheckDateStr,
      duration,
    };
    
  } catch (error) {
    log(`Sync failed: ${error}`);
    console.error('[skuvault-products-sync] Full error:', error);
    return {
      success: false,
      productCount: 0,
      stockCheckDate: null,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Check if new data is available and sync if needed
 */
export async function checkAndSync(): Promise<{
  synced: boolean;
  productCount: number;
  stockCheckDate: string | null;
  reason: string;
}> {
  try {
    const latestDate = await getLatestStockCheckDate();
    
    if (!latestDate) {
      return {
        synced: false,
        productCount: 0,
        stockCheckDate: null,
        reason: 'No data available in reporting database',
      };
    }
    
    const latestDateStr = latestDate.toISOString().split('T')[0];
    const lastSyncedDate = await getLastSyncedDate();
    
    if (lastSyncedDate === latestDateStr) {
      log(`Already synced for ${latestDateStr}, skipping`);
      return {
        synced: false,
        productCount: 0,
        stockCheckDate: latestDateStr,
        reason: `Already synced for ${latestDateStr}`,
      };
    }
    
    log(`New data detected: ${latestDateStr} (previous: ${lastSyncedDate || 'none'})`);
    
    const result = await syncSkuvaultProducts();
    
    return {
      synced: result.success,
      productCount: result.productCount,
      stockCheckDate: result.stockCheckDate,
      reason: result.success 
        ? `Synced ${result.productCount} products for ${result.stockCheckDate}`
        : 'Sync failed',
    };
    
  } catch (error) {
    log(`Check and sync failed: ${error}`);
    return {
      synced: false,
      productCount: 0,
      stockCheckDate: null,
      reason: `Error: ${error}`,
    };
  }
}

/**
 * Get sync status for monitoring
 */
export async function getSyncStatus(): Promise<{
  lastSyncedDate: string | null;
  latestAvailableDate: string | null;
  productCount: number;
  needsSync: boolean;
}> {
  try {
    const [lastSyncedDate, latestDate, countResult] = await Promise.all([
      getLastSyncedDate(),
      getLatestStockCheckDate(),
      db.select({ count: sql<number>`COUNT(*)` }).from(skuvaultProducts),
    ]);
    
    const latestDateStr = latestDate?.toISOString().split('T')[0] || null;
    
    return {
      lastSyncedDate,
      latestAvailableDate: latestDateStr,
      productCount: countResult[0]?.count || 0,
      needsSync: latestDateStr !== null && latestDateStr !== lastSyncedDate,
    };
  } catch (error) {
    log(`Error getting sync status: ${error}`);
    return {
      lastSyncedDate: null,
      latestAvailableDate: null,
      productCount: 0,
      needsSync: false,
    };
  }
}

// ============================================================================
// PHYSICAL LOCATION SYNC (SkuVault Inventory API)
// ============================================================================

/**
 * Sync physical locations from SkuVault inventory API
 * 
 * This function:
 * 1. Gets distinct brand values from the local skuvault_products table
 * 2. For each brand, calls the SkuVault inventory API
 * 3. Matches items by SKU and updates physical_location if different
 * 
 * @returns Sync statistics including updated and skipped counts
 */
export async function syncPhysicalLocations(): Promise<{
  success: boolean;
  brandsProcessed: number;
  productsChecked: number;
  locationsUpdated: number;
  locationsUnchanged: number;
  errors: string[];
  duration: number;
}> {
  const startTime = Date.now();
  const errors: string[] = [];
  let brandsProcessed = 0;
  let productsChecked = 0;
  let locationsUpdated = 0;
  let locationsUnchanged = 0;

  log('[location-sync] Starting physical location sync...');

  try {
    // Get distinct brands from our local products table
    const distinctBrands = await db
      .selectDistinct({ brand: skuvaultProducts.brand })
      .from(skuvaultProducts)
      .where(sql`${skuvaultProducts.brand} IS NOT NULL`);

    const brands = distinctBrands
      .map(r => r.brand)
      .filter((b): b is string => b !== null && b.trim() !== '');

    log(`[location-sync] Found ${brands.length} distinct brand(s) to process: ${brands.join(', ')}`);

    // Import the SkuVault service
    const { skuVaultService } = await import('./skuvault-service');

    // Process each brand
    for (const brand of brands) {
      try {
        log(`[location-sync] Processing brand: ${brand}`);
        
        // Call SkuVault API to get inventory for this brand
        const response = await skuVaultService.getInventoryByBrandAndWarehouse(brand, '-1');
        
        if (response.Errors && response.Errors.length > 0) {
          errors.push(`Brand "${brand}": ${response.Errors.join(', ')}`);
          continue;
        }

        const items = response.Data?.Items || [];
        
        if (items.length === 0) {
          log(`[location-sync] No items found for brand: ${brand}`);
          brandsProcessed++;
          continue;
        }

        // Build a map of SKU -> location (take first location with highest quantity)
        const skuLocationMap = new Map<string, string>();
        
        for (const item of items) {
          if (!item.Sku || !item.Location) continue;
          
          const existingLocation = skuLocationMap.get(item.Sku);
          if (!existingLocation) {
            // First location for this SKU - use it
            skuLocationMap.set(item.Sku, item.Location);
          }
          // If we already have a location for this SKU, keep the first one
          // (items are returned with primary location first typically)
        }

        // Get products for this brand from our database to match against SkuVault inventory
        const currentProducts = await db
          .select({ 
            sku: skuvaultProducts.sku, 
            physicalLocation: skuvaultProducts.physicalLocation 
          })
          .from(skuvaultProducts)
          .where(eq(skuvaultProducts.brand, brand));

        // Compare and update where different
        for (const product of currentProducts) {
          productsChecked++;
          
          const newLocation = skuLocationMap.get(product.sku);
          
          if (!newLocation) {
            // SKU not found in SkuVault response - skip
            continue;
          }

          if (product.physicalLocation === newLocation) {
            // Location unchanged
            locationsUnchanged++;
          } else {
            // Location is different - update
            await db
              .update(skuvaultProducts)
              .set({ 
                physicalLocation: newLocation,
                updatedAt: new Date(),
              })
              .where(eq(skuvaultProducts.sku, product.sku));
            
            locationsUpdated++;
          }
        }

        brandsProcessed++;
        log(`[location-sync] Completed brand "${brand}": ${items.length} items from API, ${currentProducts.length} local products`);

      } catch (brandError) {
        const errorMsg = brandError instanceof Error ? brandError.message : String(brandError);
        errors.push(`Brand "${brand}": ${errorMsg}`);
        log(`[location-sync] Error processing brand "${brand}": ${errorMsg}`);
      }
    }

    const duration = Date.now() - startTime;
    log(`[location-sync] Sync complete: ${brandsProcessed} brands, ${productsChecked} products checked, ${locationsUpdated} updated, ${locationsUnchanged} unchanged (${duration}ms)`);

    return {
      success: errors.length === 0,
      brandsProcessed,
      productsChecked,
      locationsUpdated,
      locationsUnchanged,
      errors,
      duration,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`[location-sync] Fatal error: ${errorMsg}`);
    
    return {
      success: false,
      brandsProcessed,
      productsChecked,
      locationsUpdated,
      locationsUnchanged,
      errors: [...errors, `Fatal: ${errorMsg}`],
      duration: Date.now() - startTime,
    };
  }
}
