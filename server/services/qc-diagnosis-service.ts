/**
 * QC Diagnosis Service
 * 
 * Analyzes QC mismatches to determine root cause of failures.
 * Categories:
 * - AP_EXPLODED_SKUVAULT: Assembled Product exploded in SkuVault (inventory=0) but not locally
 * - AP_EXPLODED_LOCAL: Assembled Product exploded locally but not in SkuVault
 * - KIT_MAPPING_MISMATCH: Kit components don't match between local and SkuVault
 * - INDIVIDUAL_MISSING_LOCAL: Individual product missing from local catalog/QC items
 * - INDIVIDUAL_MISSING_SKUVAULT: Individual product in local but not in SkuVault response
 * - UNKNOWN: Unable to determine root cause
 */

import { getKitComponents, getParentKitsForComponent, KitComponent } from './kit-mappings-cache';
import { getProductsBatch } from './product-lookup';

export type DiagnosisCategory = 
  | 'AP_EXPLODED_SKUVAULT'
  | 'AP_EXPLODED_LOCAL'
  | 'KIT_MAPPING_MISMATCH'
  | 'INDIVIDUAL_MISSING_LOCAL'
  | 'INDIVIDUAL_MISSING_SKUVAULT'
  | 'QUANTITY_MISMATCH'
  | 'UNKNOWN';

export interface Diagnosis {
  category: DiagnosisCategory;
  reason: string;
  parentSku?: string;
  productCategory?: string | null;
  isAssembledProduct?: boolean;
  kitComponentsLocal?: KitComponent[];
  kitComponentsSkuvault?: string[];
  quantityOnHand?: number;
}

export interface DiagnosisContext {
  localBySku: Map<string, { sku: string; quantityExpected: number }>;
  skuvaultBySku: Map<string, { sku: string; quantity: number }>;
  skuvaultRawItems?: Array<{
    Sku: string;
    IsKit: boolean;
    QuantityOnHand?: number;
    KitProducts?: Array<{ Sku: string; Quantity: number }>;
  }>;
}

/**
 * Build a reverse mapping from component SKUs to their parent kit/AP SKUs
 */
async function buildComponentToParentMap(
  allSkus: string[],
  productMap: Map<string, { sku: string; productCategory: string | null; isAssembledProduct: boolean; parentSku: string | null }>
): Promise<Map<string, { parentSku: string; isKit: boolean; isAP: boolean }>> {
  const componentToParent = new Map<string, { parentSku: string; isKit: boolean; isAP: boolean }>();
  
  for (const [sku, product] of Array.from(productMap.entries())) {
    const components = getKitComponents(sku);
    if (components && components.length > 0) {
      for (const component of components) {
        componentToParent.set(component.componentSku, {
          parentSku: sku,
          isKit: product.productCategory === 'kit',
          isAP: product.isAssembledProduct,
        });
      }
    }
  }
  
  return componentToParent;
}

/**
 * Diagnose a single SKU mismatch
 */
export async function diagnoseMismatch(
  sku: string,
  mismatchType: 'missing_local' | 'missing_skuvault' | 'quantity_mismatch',
  context: DiagnosisContext,
  productMap: Map<string, { sku: string; productCategory: string | null; isAssembledProduct: boolean; parentSku: string | null }>,
  componentToParent: Map<string, { parentSku: string; isKit: boolean; isAP: boolean }>,
  skuvaultQuantityOnHand: Map<string, number>
): Promise<Diagnosis> {
  const product = productMap.get(sku);
  const parentInfo = componentToParent.get(sku);
  
  // Case 1: Missing in Local (SkuVault has it, we don't)
  if (mismatchType === 'missing_local') {
    // Check if this SKU is a component of a kit/AP
    if (parentInfo) {
      const parentProduct = productMap.get(parentInfo.parentSku);
      
      if (parentInfo.isAP) {
        // This is a component of an Assembled Product
        // AP was exploded in SkuVault (likely because inventory=0)
        const qoh = skuvaultQuantityOnHand.get(parentInfo.parentSku);
        return {
          category: 'AP_EXPLODED_SKUVAULT',
          reason: `Component of AP "${parentInfo.parentSku}" which was exploded by SkuVault${qoh !== undefined ? ` (qty on hand: ${qoh})` : ''}. APs explode when inventory=0.`,
          parentSku: parentInfo.parentSku,
          productCategory: parentProduct?.productCategory || null,
          isAssembledProduct: true,
          quantityOnHand: qoh,
        };
      } else if (parentInfo.isKit) {
        // This is a kit component - kit mapping issue
        const localComponents = getKitComponents(parentInfo.parentSku);
        return {
          category: 'KIT_MAPPING_MISMATCH',
          reason: `Component of kit "${parentInfo.parentSku}". SkuVault returned this component but local kit mappings may be outdated or kit not exploded locally.`,
          parentSku: parentInfo.parentSku,
          productCategory: 'kit',
          isAssembledProduct: false,
          kitComponentsLocal: localComponents || undefined,
        };
      }
    }
    
    // Not a kit/AP component - individual product issue
    return {
      category: 'INDIVIDUAL_MISSING_LOCAL',
      reason: product 
        ? `Individual product exists in catalog but not in local QC items. May not have been included in shipment sync.`
        : `Individual product not found in local catalog. SKU may be new or variant not synced.`,
      productCategory: product?.productCategory || null,
      isAssembledProduct: product?.isAssembledProduct || false,
    };
  }
  
  // Case 2: Missing in SkuVault (we have it, SkuVault doesn't)
  if (mismatchType === 'missing_skuvault') {
    // Check if this is a component we exploded locally (using local order info)
    if (parentInfo) {
      const parentProduct = productMap.get(parentInfo.parentSku);
      
      if (parentInfo.isAP) {
        // We exploded an AP locally but SkuVault didn't
        const qoh = skuvaultQuantityOnHand.get(parentInfo.parentSku);
        return {
          category: 'AP_EXPLODED_LOCAL',
          reason: `Component of AP "${parentInfo.parentSku}" which we exploded locally but SkuVault did not${qoh !== undefined ? ` (SkuVault qty on hand: ${qoh})` : ''}. Check if is_assembled_product flag is correct.`,
          parentSku: parentInfo.parentSku,
          productCategory: parentProduct?.productCategory || null,
          isAssembledProduct: true,
          quantityOnHand: qoh,
        };
      } else if (parentInfo.isKit) {
        // Kit explosion mismatch
        return {
          category: 'KIT_MAPPING_MISMATCH',
          reason: `Component of kit "${parentInfo.parentSku}". Local kit mappings include this but SkuVault QC response does not. Kit mappings may be outdated.`,
          parentSku: parentInfo.parentSku,
          productCategory: 'kit',
          isAssembledProduct: false,
          kitComponentsLocal: getKitComponents(parentInfo.parentSku) || undefined,
        };
      }
    }
    
    // Also check global reverse lookup - this SKU might be a component of a kit not in this order
    const globalParentKits = getParentKitsForComponent(sku);
    if (globalParentKits && globalParentKits.length > 0) {
      // This SKU is a component of one or more kits in our global mapping
      // Find the most likely parent by checking which kits might be in the order
      const parentKitsSorted = globalParentKits.sort().slice(0, 3); // Show first 3
      const parentKitsStr = parentKitsSorted.join(', ') + (globalParentKits.length > 3 ? ` + ${globalParentKits.length - 3} more` : '');
      
      return {
        category: 'KIT_MAPPING_MISMATCH',
        reason: `This SKU is a component of kit(s): [${parentKitsStr}]. Local kit_mappings_cache has this as a component but SkuVault QC response doesn't include it. Kit definition may differ between systems.`,
        parentSku: parentKitsSorted[0], // Use first as primary
        productCategory: product?.productCategory || null,
        isAssembledProduct: product?.isAssembledProduct || false,
        kitComponentsLocal: getKitComponents(parentKitsSorted[0]) || undefined,
      };
    }
    
    // Check if this SKU itself is a kit/AP that should have been exploded
    if (product?.productCategory === 'kit') {
      const localComponents = getKitComponents(sku);
      return {
        category: 'KIT_MAPPING_MISMATCH',
        reason: `This is a kit that was in local QC items as parent SKU, but SkuVault exploded it into components. Check if kit explosion is working correctly locally.`,
        productCategory: 'kit',
        isAssembledProduct: false,
        kitComponentsLocal: localComponents || undefined,
      };
    }
    
    if (product?.isAssembledProduct) {
      const qoh = skuvaultQuantityOnHand.get(sku);
      return {
        category: 'AP_EXPLODED_LOCAL',
        reason: `This AP was kept as parent in local but SkuVault exploded it${qoh !== undefined ? ` (qty on hand: ${qoh})` : ''}. Check is_assembled_product flag and SkuVault inventory.`,
        productCategory: product.productCategory,
        isAssembledProduct: true,
        quantityOnHand: qoh,
      };
    }
    
    // Individual product not in SkuVault response
    return {
      category: 'INDIVIDUAL_MISSING_SKUVAULT',
      reason: product
        ? `Individual product in local but not in SkuVault QC response. May have been removed from order in SkuVault.`
        : `SKU not in catalog and not in SkuVault. Data integrity issue.`,
      productCategory: product?.productCategory || null,
      isAssembledProduct: product?.isAssembledProduct || false,
    };
  }
  
  // Case 3: Quantity mismatch
  if (mismatchType === 'quantity_mismatch') {
    return {
      category: 'QUANTITY_MISMATCH',
      reason: `Quantity differs between local and SkuVault. May be due to kit quantity multiplication or partial fulfillment.`,
      productCategory: product?.productCategory || null,
      isAssembledProduct: product?.isAssembledProduct || false,
    };
  }
  
  return {
    category: 'UNKNOWN',
    reason: 'Unable to determine root cause of mismatch.',
  };
}

/**
 * Diagnose all mismatches for a shipment
 */
export async function diagnoseShipmentMismatches(
  differences: Array<{
    sku: string;
    field: string;
    localValue: string | number | null;
    skuvaultValue: string | number | null;
  }>,
  localBySku: Map<string, { sku: string; quantityExpected: number }>,
  skuvaultBySku: Map<string, { sku: string; quantity: number }>,
  allSkus: Set<string>,
  skuvaultRawItems?: Array<{
    Sku: string;
    IsKit: boolean;
    QuantityOnHand?: number;
    KitProducts?: Array<{ Sku: string; Quantity: number }>;
  }>
): Promise<Map<string, Diagnosis>> {
  const diagnosisMap = new Map<string, Diagnosis>();
  
  if (differences.length === 0) {
    return diagnosisMap;
  }
  
  // Get product info for all SKUs + potential parent SKUs
  const skusToLookup = new Set(allSkus);
  
  // Also add any kit/AP parent SKUs we find
  for (const sku of Array.from(allSkus)) {
    const components = getKitComponents(sku);
    if (components) {
      for (const c of components) {
        skusToLookup.add(c.componentSku);
      }
    }
  }
  
  const productMap = await getProductsBatch(Array.from(skusToLookup));
  
  // Build component to parent mapping
  const componentToParent = await buildComponentToParentMap(Array.from(skusToLookup), productMap);
  
  // Also check if any of the mismatched SKUs are components of products in the order
  for (const diff of differences) {
    const parentInfo = findParentFromLocalKitMappings(diff.sku, productMap);
    if (parentInfo && !componentToParent.has(diff.sku)) {
      componentToParent.set(diff.sku, parentInfo);
    }
  }
  
  // Build quantity on hand map from SkuVault raw response
  const skuvaultQuantityOnHand = new Map<string, number>();
  if (skuvaultRawItems) {
    for (const item of skuvaultRawItems) {
      if (item.QuantityOnHand !== undefined) {
        skuvaultQuantityOnHand.set(item.Sku, item.QuantityOnHand);
      }
    }
  }
  
  // Diagnose each mismatch
  const context: DiagnosisContext = {
    localBySku: localBySku as Map<string, { sku: string; quantityExpected: number }>,
    skuvaultBySku: skuvaultBySku as Map<string, { sku: string; quantity: number }>,
    skuvaultRawItems,
  };
  
  for (const diff of differences) {
    let mismatchType: 'missing_local' | 'missing_skuvault' | 'quantity_mismatch';
    
    if (diff.field === 'item') {
      if (diff.localValue === null) {
        mismatchType = 'missing_local';
      } else {
        mismatchType = 'missing_skuvault';
      }
    } else if (diff.field === 'quantity') {
      mismatchType = 'quantity_mismatch';
    } else {
      continue; // Skip barcode mismatches for now
    }
    
    const diagnosis = await diagnoseMismatch(
      diff.sku,
      mismatchType,
      context,
      productMap,
      componentToParent,
      skuvaultQuantityOnHand
    );
    
    diagnosisMap.set(diff.sku, diagnosis);
  }
  
  return diagnosisMap;
}

/**
 * Helper to find parent from kit mappings in our product catalog
 */
function findParentFromLocalKitMappings(
  componentSku: string,
  productMap: Map<string, { sku: string; productCategory: string | null; isAssembledProduct: boolean; parentSku: string | null }>
): { parentSku: string; isKit: boolean; isAP: boolean } | null {
  for (const [parentSku, product] of Array.from(productMap.entries())) {
    const components = getKitComponents(parentSku);
    if (components) {
      const hasComponent = components.some(c => c.componentSku === componentSku);
      if (hasComponent) {
        return {
          parentSku,
          isKit: product.productCategory === 'kit',
          isAP: product.isAssembledProduct,
        };
      }
    }
  }
  return null;
}
