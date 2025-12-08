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
 * PRIMARY: A shipment is fully shippable if:
 * 1. It has the "MOVE OVER" tag (indicates picking is complete in SkuVault)
 * 2. Its shipmentStatus is NOT 'on_hold'
 * 
 * FALLBACK: When NO shipments pass the primary criteria, we fall back to:
 * - Shipments that are simply NOT 'on_hold' (even without MOVE OVER tag)
 * 
 * This fallback handles cases where split orders have some shipments on hold
 * and others pending, but none have been tagged with MOVE OVER yet.
 */

import type { Shipment, ShipmentTag } from '@shared/schema';

/**
 * Check if a shipment is shippable based on its status and tags.
 * 
 * @param shipment - The shipment record
 * @param tags - Array of tags associated with this shipment
 * @returns true if shipment is shippable (has MOVE OVER tag AND not on_hold)
 */
export function isShipmentShippable(
  shipment: Pick<Shipment, 'id' | 'shipmentStatus'>,
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): boolean {
  const hasMoveOverTag = tags.some(tag => 
    tag.shipmentId === shipment.id && tag.name === 'MOVE OVER'
  );
  const notOnHold = shipment.shipmentStatus !== 'on_hold';
  
  return hasMoveOverTag && notOnHold;
}

/**
 * Filter an array of shipments to only those that are shippable (primary criteria).
 * 
 * @param shipments - Array of shipment records
 * @param allTags - Array of all tags for these shipments
 * @returns Array of shippable shipments (MOVE OVER tag AND not on_hold)
 */
export function filterShippableShipments<T extends Pick<Shipment, 'id' | 'shipmentStatus'>>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): T[] {
  return shipments.filter(shipment => isShipmentShippable(shipment, allTags));
}

/**
 * Filter an array of shipments to only those that are NOT on hold.
 * Used as a fallback when no shipments pass the primary shippable criteria.
 * 
 * @param shipments - Array of shipment records
 * @returns Array of shipments that are not on hold
 */
export function filterNotOnHoldShipments<T extends Pick<Shipment, 'id' | 'shipmentStatus'>>(
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
 * 1. PRIMARY: Shipments with MOVE OVER tag AND not on_hold
 * 2. FALLBACK: If none match primary, use shipments that are simply NOT on_hold
 * 
 * @param shipments - All shipments for an order
 * @param allTags - All tags for these shipments
 * @returns Analysis result with shippable shipments and default selection
 */
export function analyzeShippableShipments<T extends Pick<Shipment, 'id' | 'shipmentStatus'>>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): ShippableShipmentsResult<T> {
  // Try primary criteria first: MOVE OVER tag AND not on_hold
  let shippableShipments = filterShippableShipments(shipments, allTags);
  
  // FALLBACK: If no shipments pass primary criteria, fall back to just "not on_hold"
  // This handles split orders where some shipments are on hold and others are pending
  if (shippableShipments.length === 0) {
    shippableShipments = filterNotOnHoldShipments(shipments);
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
