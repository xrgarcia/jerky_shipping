/**
 * SkuVault Products Sync Service
 * 
 * Synchronizes product catalog data from the reporting database (GCP PostgreSQL)
 * to the local skuvault_products table. Runs hourly and detects new data by
 * comparing stock_check_date values.
 * 
 * Data sources:
 * 1. Individual products: inventory_forecasts_daily + internal_inventory
 * 2. Kit products: internal_kit_inventory
 * 
 * Image URL resolution priority (waterfall):
 * 1. productVariants.imageUrl (variant-specific image)
 * 2. products.imageUrl (parent product image - Shopify often stores images here)
 * 3. shipmentItems.imageUrl (most recent order)
 * 4. null (fallback)
 */

import { reportingSql } from '../reporting-db';
import { db } from '../db';
import { skuvaultProducts, productVariants, products, shipmentItems, shipments } from '@shared/schema';
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
  weight_value: number | null;
  weight_unit: string | null;
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
 * Fetch products from reporting database (union of individual products and kits)
 */
async function fetchProductsFromReporting(): Promise<ReportingProduct[]> {
  log('Fetching products from reporting database...');
  
  // Fetch kit products first (no weight data)
  const kitProducts = await reportingSql<ReportingProduct[]>`
    SELECT 
      sku,
      snapshot_timestamp as stock_check_date,
      description as product_title,
      code as barcode,
      'kit' as product_category,
      true as is_assembled_product, 
      cost::text as unit_cost,
      NULL::integer as weight_value,
      NULL::text as weight_unit
    FROM 
      public.internal_kit_inventory 
    WHERE snapshot_timestamp = (
      SELECT MAX(i.snapshot_timestamp) 
      FROM public.internal_kit_inventory i
    )
  `;
  
  log(`Fetched ${kitProducts.length} kit products`);
  
  // Fetch individual products with weight data
  const individualProducts = await reportingSql<ReportingProduct[]>`
    SELECT
      inventory_forecasts_daily.sku,
      stock_check_date,
      inventory_forecasts_daily.description AS product_title,
      code as barcode,
      product_category,
      is_assembled_product,
      unit_cost::text as unit_cost,
      ROUND(weight_value::numeric)::integer as weight_value,
      weight_unit
    FROM
      public.inventory_forecasts_daily 
    RIGHT OUTER JOIN 
      public.internal_inventory ON internal_inventory.sku = inventory_forecasts_daily.sku 
        AND stock_check_date = snapshot_timestamp
    WHERE
      stock_check_date = (
        SELECT MAX(i.stock_check_date)
        FROM public.inventory_forecasts_daily i
      )
  `;
  
  log(`Fetched ${individualProducts.length} individual products`);
  
  // Merge with deduplication: kits first, then individual products overwrite (with weight data)
  const productMap = new Map<string, ReportingProduct>();
  
  // Add kit products first
  for (const product of kitProducts) {
    if (product.sku) {
      productMap.set(product.sku, product);
    }
  }
  
  // Individual products overwrite kits (they have weight data and accurate categories)
  for (const product of individualProducts) {
    if (product.sku) {
      productMap.set(product.sku, product);
    }
  }
  
  const merged = Array.from(productMap.values());
  log(`Merged to ${merged.length} unique products (deduplicated)`);
  
  return merged;
}

/**
 * Resolve product image URL using waterfall logic:
 * 1. productVariants.imageUrl (variant-specific image)
 * 2. products.imageUrl (parent product image - Shopify often stores images here)
 * 3. shipmentItems (most recent) - by SKU
 * 4. null (fallback)
 */
async function resolveImageUrl(sku: string): Promise<string | null> {
  // 1. Check productVariants (variant-specific image)
  const variant = await db
    .select({ 
      variantImageUrl: productVariants.imageUrl,
      productId: productVariants.productId,
    })
    .from(productVariants)
    .where(eq(productVariants.sku, sku))
    .limit(1);
  
  if (variant[0]?.variantImageUrl) {
    return variant[0].variantImageUrl;
  }
  
  // 2. Check parent product if variant exists but has no image
  if (variant[0]?.productId) {
    const parentProduct = await db
      .select({ imageUrl: products.imageUrl })
      .from(products)
      .where(eq(products.id, variant[0].productId))
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
  
  // Step 1: Batch fetch from productVariants (with parent product join for fallback)
  const variantsWithParent = await db
    .select({ 
      sku: productVariants.sku, 
      variantImageUrl: productVariants.imageUrl,
      parentImageUrl: products.imageUrl,
    })
    .from(productVariants)
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(sql`${productVariants.sku} IN ${skus}`);
  
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
