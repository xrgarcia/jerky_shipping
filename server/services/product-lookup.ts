/**
 * Product Lookup Service
 * 
 * Provides product catalog lookups from the local skuvault_products table.
 * This replaces the GCP-based product catalog cache for product data lookups.
 * 
 * The skuvault_products table is synced hourly from GCP by the sync worker,
 * so this provides fast local queries without needing to hit GCP for each lookup.
 */

import { db } from '../db';
import { skuvaultProducts } from '@shared/schema';
import { eq, inArray } from 'drizzle-orm';

const log = (message: string) => console.log(`[product-lookup] ${message}`);

export interface ProductInfo {
  sku: string;
  barcode: string | null;
  description: string | null;
  isAssembledProduct: boolean;
}

/**
 * Get product info by SKU from local skuvault_products table
 */
export async function getProduct(sku: string): Promise<ProductInfo | undefined> {
  const result = await db
    .select({
      sku: skuvaultProducts.sku,
      barcode: skuvaultProducts.barcode,
      description: skuvaultProducts.productTitle,
      isAssembledProduct: skuvaultProducts.isAssembledProduct,
    })
    .from(skuvaultProducts)
    .where(eq(skuvaultProducts.sku, sku))
    .limit(1);
  
  if (result.length === 0) {
    return undefined;
  }
  
  return {
    sku: result[0].sku,
    barcode: result[0].barcode,
    description: result[0].description,
    isAssembledProduct: result[0].isAssembledProduct,
  };
}

/**
 * Batch get products by SKUs for efficient hydration
 * Returns a Map for O(1) lookups
 */
export async function getProductsBatch(skus: string[]): Promise<Map<string, ProductInfo>> {
  if (skus.length === 0) return new Map();
  
  const uniqueSkus = [...new Set(skus)];
  
  const results = await db
    .select({
      sku: skuvaultProducts.sku,
      barcode: skuvaultProducts.barcode,
      description: skuvaultProducts.productTitle,
      isAssembledProduct: skuvaultProducts.isAssembledProduct,
    })
    .from(skuvaultProducts)
    .where(inArray(skuvaultProducts.sku, uniqueSkus));
  
  const productMap = new Map<string, ProductInfo>();
  for (const row of results) {
    productMap.set(row.sku, {
      sku: row.sku,
      barcode: row.barcode,
      description: row.description,
      isAssembledProduct: row.isAssembledProduct,
    });
  }
  
  log(`Batch lookup: ${uniqueSkus.length} SKUs requested, ${productMap.size} found`);
  
  return productMap;
}

/**
 * Get total product count in local table
 */
export async function getProductCount(): Promise<number> {
  const result = await db
    .select({ count: skuvaultProducts.sku })
    .from(skuvaultProducts);
  return result.length;
}
