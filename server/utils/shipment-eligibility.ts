/**
 * Centralized Shipment Eligibility Utility
 * 
 * Provides a single source of truth for determining if a shipment is shippable.
 * Used by:
 * - Cache warmer service (qcsale-cache-warmer.ts)
 * - Firestore sync worker (firestore-sync.ts)  
 * - Order validation endpoint (routes.ts)
 * 
 * SHIPPABILITY CRITERIA (with fallback hierarchy):
 * 
 * ALWAYS EXCLUDED (hard filters applied first):
 * - Shipments that are already shipped (have a tracking number)
 * - Shipments that are on_hold
 * 
 * PRIMARY: A shipment is fully shippable if (after hard filters):
 * 1. It has the "MOVE OVER" tag (indicates picking is complete in SkuVault)
 * 
 * FALLBACK: When NO shipments pass the primary criteria, we fall back to:
 * - All shipments that pass the hard filters (not shipped, not on_hold)
 * 
 * This fallback handles cases where split orders have some shipments on hold
 * and others pending, but none have been tagged with MOVE OVER yet.
 */

import type { Shipment, ShipmentTag } from '@shared/schema';

/**
 * Minimum shipment type required for eligibility checks.
 * Includes trackingNumber to filter out already shipped shipments.
 */
export type ShipmentForEligibility = Pick<Shipment, 'id' | 'shipmentStatus' | 'trackingNumber'>;

/**
 * Check if a shipment passes the hard filters (excluded from ALL eligibility).
 * A shipment is excluded if:
 * - It already has a tracking number (already shipped)
 * - Its status is 'on_hold'
 * 
 * @param shipment - The shipment record
 * @returns true if shipment is NOT excluded (passes hard filters)
 */
export function passesHardFilters(shipment: ShipmentForEligibility): boolean {
  const notShipped = !shipment.trackingNumber;
  const notOnHold = shipment.shipmentStatus !== 'on_hold';
  return notShipped && notOnHold;
}

/**
 * Check if a shipment is shippable based on its status and tags (primary criteria).
 * This is applied AFTER hard filters.
 * 
 * @param shipment - The shipment record
 * @param tags - Array of tags associated with this shipment
 * @returns true if shipment is shippable (passes hard filters AND has MOVE OVER tag)
 */
export function isShipmentShippable(
  shipment: ShipmentForEligibility,
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): boolean {
  if (!passesHardFilters(shipment)) {
    return false;
  }
  
  const hasMoveOverTag = tags.some(tag => 
    tag.shipmentId === shipment.id && tag.name === 'MOVE OVER'
  );
  
  return hasMoveOverTag;
}

/**
 * Filter an array of shipments to only those that pass hard filters.
 * (Not shipped AND not on_hold)
 * 
 * @param shipments - Array of shipment records
 * @returns Array of shipments that pass hard filters
 */
export function filterEligibleShipments<T extends ShipmentForEligibility>(
  shipments: T[]
): T[] {
  return shipments.filter(shipment => passesHardFilters(shipment));
}

/**
 * Filter an array of shipments to only those that are shippable (primary criteria).
 * This applies hard filters first, then checks for MOVE OVER tag.
 * 
 * @param shipments - Array of shipment records
 * @param allTags - Array of all tags for these shipments
 * @returns Array of shippable shipments (passes hard filters AND has MOVE OVER tag)
 */
export function filterShippableShipments<T extends ShipmentForEligibility>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): T[] {
  return shipments.filter(shipment => isShipmentShippable(shipment, allTags));
}

/**
 * @deprecated Use filterEligibleShipments instead. This is kept for backward compatibility.
 * Filter an array of shipments to only those that are NOT on hold (but may be shipped).
 * 
 * @param shipments - Array of shipment records
 * @returns Array of shipments that are not on hold
 */
export function filterNotOnHoldShipments<T extends ShipmentForEligibility>(
  shipments: T[]
): T[] {
  return shipments.filter(shipment => shipment.shipmentStatus !== 'on_hold');
}

/**
 * Build a map of shipmentId -> hasMoveOverTag for efficient lookups.
 * 
 * @param tags - Array of all tags
 * @returns Map from shipmentId to whether it has the MOVE OVER tag
 */
export function buildMoveOverTagMap(
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): Map<string, boolean> {
  const hasMoveOverTag = new Map<string, boolean>();
  for (const tag of tags) {
    if (tag.name === 'MOVE OVER') {
      hasMoveOverTag.set(tag.shipmentId, true);
    }
  }
  return hasMoveOverTag;
}

/**
 * Result of analyzing shippable shipments for an order.
 */
export interface ShippableShipmentsResult<T> {
  allShipments: T[];
  shippableShipments: T[];
  defaultShipmentId: string | null;
  reason: 'single' | 'multiple' | 'none';
}

/**
 * Analyze an order's shipments and determine shippability.
 * Uses a fallback hierarchy:
 * 
 * HARD FILTERS (always applied):
 * - Exclude shipments with tracking numbers (already shipped)
 * - Exclude shipments that are on_hold
 * 
 * PRIMARY: Shipments that pass hard filters AND have MOVE OVER tag
 * FALLBACK: If none match primary, use all shipments that pass hard filters
 * 
 * @param shipments - All shipments for an order
 * @param allTags - All tags for these shipments
 * @returns Analysis result with shippable shipments and default selection
 */
export function analyzeShippableShipments<T extends ShipmentForEligibility>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): ShippableShipmentsResult<T> {
  // First apply hard filters: not shipped AND not on_hold
  const eligibleShipments = filterEligibleShipments(shipments);
  
  // Try primary criteria: eligible + MOVE OVER tag
  let shippableShipments = eligibleShipments.filter(shipment => {
    const hasMoveOverTag = allTags.some(tag => 
      tag.shipmentId === shipment.id && tag.name === 'MOVE OVER'
    );
    return hasMoveOverTag;
  });
  
  // FALLBACK: If no shipments pass primary criteria, use all eligible shipments
  // This handles split orders where some shipments are on hold and others are pending,
  // but none have been tagged with MOVE OVER yet.
  if (shippableShipments.length === 0) {
    shippableShipments = eligibleShipments;
  }
  
  let defaultShipmentId: string | null = null;
  let reason: 'single' | 'multiple' | 'none';
  
  if (shippableShipments.length === 0) {
    reason = 'none';
  } else if (shippableShipments.length === 1) {
    reason = 'single';
    defaultShipmentId = shippableShipments[0].id;
  } else {
    reason = 'multiple';
  }
  
  return {
    allShipments: shipments,
    shippableShipments,
    defaultShipmentId,
    reason,
  };
}
