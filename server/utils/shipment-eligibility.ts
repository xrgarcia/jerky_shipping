/**
 * Centralized Shipment Eligibility Utility
 * 
 * Provides a single source of truth for determining if a shipment is shippable.
 * Used by:
 * - Cache warmer service (qcsale-cache-warmer.ts)
 * - Firestore sync worker (firestore-sync.ts)  
 * - Order validation endpoint (routes.ts)
 * 
 * SHIPPABILITY CRITERIA:
 * A shipment is shippable if:
 * 1. It has the "MOVE OVER" tag (indicates picking is complete in SkuVault)
 * 2. Its shipmentStatus is NOT 'on_hold'
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
 * Filter an array of shipments to only those that are shippable.
 * 
 * @param shipments - Array of shipment records
 * @param allTags - Array of all tags for these shipments
 * @returns Array of shippable shipments
 */
export function filterShippableShipments<T extends Pick<Shipment, 'id' | 'shipmentStatus'>>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): T[] {
  return shipments.filter(shipment => isShipmentShippable(shipment, allTags));
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
 * 
 * @param shipments - All shipments for an order
 * @param allTags - All tags for these shipments
 * @returns Analysis result with shippable shipments and default selection
 */
export function analyzeShippableShipments<T extends Pick<Shipment, 'id' | 'shipmentStatus'>>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): ShippableShipmentsResult<T> {
  const shippableShipments = filterShippableShipments(shipments, allTags);
  
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
