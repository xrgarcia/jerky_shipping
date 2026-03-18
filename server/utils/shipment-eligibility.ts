/**
 * Centralized Shipment Eligibility Utility
 * 
 * Provides a single source of truth for determining if a shipment is shippable.
 * Used by:
 * - Lifecycle service (lifecycle-service.ts)
 * - Fulfillment session service (fulfillment-session-service.ts)
 * - Order validation endpoint (routes.ts)
 * - Shipments page (filters and badges)
 * - Boxing and Bagging pages (packing workflow)
 * - Shipment details page
 * 
 * SHIPPABILITY CRITERIA (with fallback hierarchy):
 * 
 * ALWAYS EXCLUDED (hard filters applied first):
 * - Shipments that are already shipped (have a tracking number)
 * - Shipments that are on_hold  (EXCEPTION: 'READY FOR SHIPDOT' tag bypasses this)
 * - Shipments with package type "**DO NOT SHIP (ALERT MGR)**"
 * - Shipments with missing serviceCode (no carrier/service selected)
 * 
 * PRIMARY: A shipment is fully shippable if (after hard filters):
 * 1. It has any tag in SHIPPABLE_TAGS ('MOVE OVER' or 'READY FOR SHIPDOT')
 * 
 * FALLBACK: When NO shipments pass the primary criteria, we fall back to:
 * - All shipments that pass the hard filters (not shipped, not on_hold)
 * 
 * This fallback handles cases where split orders have some shipments on hold
 * and others pending, but none have been tagged yet.
 */

import type { Shipment, ShipmentTag, ShipmentPackage } from '@shared/schema';
import { SHIPPABLE_TAGS, hasShippableTag as checkShippableTag } from './shippable-tags';

/**
 * Package name that indicates a shipment should NOT be shipped.
 * This is used by the warehouse to flag orders that need manager attention.
 */
export const DO_NOT_SHIP_PACKAGE_NAME = '**DO NOT SHIP (ALERT MGR)**';

/**
 * Minimum package type required for eligibility checks.
 */
export type PackageForEligibility = Pick<ShipmentPackage, 'shipmentId' | 'packageName'>;

/**
 * Minimum shipment type required for eligibility checks.
 * Includes trackingNumber to filter out already shipped shipments.
 * Includes serviceCode to verify carrier/service is selected.
 */
export type ShipmentForEligibility = Pick<Shipment, 'id' | 'shipmentStatus' | 'trackingNumber' | 'serviceCode'>;

/**
 * Check if a shipment has a "DO NOT SHIP" package assigned.
 * 
 * @param shipmentId - The shipment ID to check
 * @param packages - Array of all packages to search
 * @returns true if shipment has a DO NOT SHIP package
 */
export function hasDoNotShipPackage(
  shipmentId: string,
  packages: PackageForEligibility[]
): boolean {
  return packages.some(pkg => 
    pkg.shipmentId === shipmentId && 
    pkg.packageName === DO_NOT_SHIP_PACKAGE_NAME
  );
}

/**
 * Check if a shipment passes the hard filters (excluded from ALL eligibility).
 * A shipment is excluded if:
 * - It already has a tracking number (already shipped)
 * - Its status is 'on_hold'
 * - It has a "DO NOT SHIP (ALERT MGR)" package (when packages are provided)
 * - It is missing a serviceCode (carrier/service not selected)
 * 
 * NOTE: The 'READY FOR SHIPDOT' tag bypasses the on_hold check at the
 * isShipmentShippable level, not here. passesHardFilters is intentionally
 * tag-agnostic so it can be used for the fallback eligible-set calculation.
 * 
 * @param shipment - The shipment record
 * @param packages - Optional array of packages for this shipment (for DO NOT SHIP check)
 * @returns true if shipment is NOT excluded (passes hard filters)
 */
export function passesHardFilters(
  shipment: ShipmentForEligibility,
  packages: PackageForEligibility[] = []
): boolean {
  const notShipped = !shipment.trackingNumber;
  const notOnHold = shipment.shipmentStatus !== 'on_hold';
  const notDoNotShip = !hasDoNotShipPackage(shipment.id, packages);
  const hasServiceCode = !!shipment.serviceCode;
  return notShipped && notOnHold && notDoNotShip && hasServiceCode;
}

/**
 * Check if a shipment is shippable based on its status, tags, and packages.
 * This is the main function for determining if a shipment can be shipped today.
 * 
 * A shipment is shippable if it has any tag in SHIPPABLE_TAGS AND meets the
 * relevant hard filters. The 'READY FOR SHIPDOT' tag bypasses the on_hold check
 * (allowing packing even while the shipment is technically on hold in ShipStation).
 * 
 * @param shipment - The shipment record
 * @param tags - Array of tags associated with this shipment
 * @param packages - Optional array of packages for DO NOT SHIP check
 * @returns true if shipment is shippable
 */
export function isShipmentShippable(
  shipment: ShipmentForEligibility,
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[],
  packages: PackageForEligibility[] = []
): boolean {
  // 'READY FOR SHIPDOT' bypasses the on_hold hard filter.
  // All other hard filters (already shipped, DO NOT SHIP package, missing service code)
  // still apply regardless of which shippable tag is present.
  const hasReadyForShipDot = tags.some(
    t => t.shipmentId === shipment.id && t.name === 'READY FOR SHIPDOT'
  );

  if (hasReadyForShipDot) {
    const notShipped = !shipment.trackingNumber;
    const notDoNotShip = !hasDoNotShipPackage(shipment.id, packages);
    const hasServiceCode = !!shipment.serviceCode;
    return notShipped && notDoNotShip && hasServiceCode;
  }

  // Standard path: must pass ALL hard filters (including not on_hold)
  // AND have any shippable tag.
  if (!passesHardFilters(shipment, packages)) {
    return false;
  }

  return checkShippableTag(tags, shipment.id);
}

/**
 * Filter an array of shipments to only those that pass hard filters.
 * (Not shipped AND not on_hold AND no DO NOT SHIP package)
 * 
 * @param shipments - Array of shipment records
 * @param packages - Optional array of all packages for these shipments
 * @returns Array of shipments that pass hard filters
 */
export function filterEligibleShipments<T extends ShipmentForEligibility>(
  shipments: T[],
  packages: PackageForEligibility[] = []
): T[] {
  return shipments.filter(shipment => passesHardFilters(shipment, packages));
}

/**
 * Filter an array of shipments to only those that are shippable (primary criteria).
 * This applies hard filters first (with READY FOR SHIPDOT bypass), then checks for
 * any shippable tag.
 * 
 * @param shipments - Array of shipment records
 * @param allTags - Array of all tags for these shipments
 * @param packages - Optional array of all packages for these shipments
 * @returns Array of shippable shipments
 */
export function filterShippableShipments<T extends ShipmentForEligibility>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[],
  packages: PackageForEligibility[] = []
): T[] {
  return shipments.filter(shipment => isShipmentShippable(shipment, allTags, packages));
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
 * Build a map of shipmentId -> hasShippableTag for efficient lookups.
 * Returns true for any shipment that has at least one tag in SHIPPABLE_TAGS.
 * 
 * @param tags - Array of all tags
 * @returns Map from shipmentId to whether it has any shippable tag
 */
export function buildShippableTagMap(
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const tag of tags) {
    if ((SHIPPABLE_TAGS as readonly string[]).includes(tag.name)) {
      result.set(tag.shipmentId, true);
    }
  }
  return result;
}

/**
 * @deprecated Use buildShippableTagMap instead.
 * Build a map of shipmentId -> hasMoveOverTag for efficient lookups.
 */
export function buildMoveOverTagMap(
  tags: Pick<ShipmentTag, 'shipmentId' | 'name'>[]
): Map<string, boolean> {
  return buildShippableTagMap(tags);
}

/**
 * Exclusion reasons for shipments that are not eligible for packing.
 */
export type ShipmentExclusionReason = 'already_shipped' | 'on_hold' | 'do_not_ship_package' | 'missing_service_code' | 'eligible';

/**
 * Per-shipment status with exclusion reason.
 */
export interface ShipmentStatus {
  id: string;
  reason: ShipmentExclusionReason;
}

/**
 * Get the exclusion reason for a shipment.
 * 
 * @param shipment - The shipment to check
 * @param packages - Optional array of packages for DO NOT SHIP check
 * @returns The reason why it's excluded, or 'eligible' if it passes hard filters
 */
export function getShipmentExclusionReason(
  shipment: ShipmentForEligibility,
  packages: PackageForEligibility[] = []
): ShipmentExclusionReason {
  if (shipment.trackingNumber) {
    return 'already_shipped';
  }
  if (shipment.shipmentStatus === 'on_hold') {
    return 'on_hold';
  }
  if (hasDoNotShipPackage(shipment.id, packages)) {
    return 'do_not_ship_package';
  }
  if (!shipment.serviceCode) {
    return 'missing_service_code';
  }
  return 'eligible';
}

/**
 * Get exclusion reasons for all shipments in an order.
 * 
 * @param shipments - All shipments for an order
 * @param packages - Optional array of all packages for these shipments
 * @returns Array of shipment statuses with their exclusion reasons
 */
export function getShipmentStatuses<T extends ShipmentForEligibility>(
  shipments: T[],
  packages: PackageForEligibility[] = []
): ShipmentStatus[] {
  return shipments.map(shipment => ({
    id: shipment.id,
    reason: getShipmentExclusionReason(shipment, packages),
  }));
}

/**
 * Result of analyzing shippable shipments for an order.
 */
export interface ShippableShipmentsResult<T> {
  allShipments: T[];
  shippableShipments: T[];
  defaultShipmentId: string | null;
  reason: 'single' | 'multiple' | 'none';
  /** Per-shipment status with exclusion reasons */
  shipmentStatuses: ShipmentStatus[];
}

/**
 * Analyze an order's shipments and determine shippability.
 * Uses a fallback hierarchy:
 * 
 * HARD FILTERS (always applied):
 * - Exclude shipments with tracking numbers (already shipped)
 * - Exclude shipments that are on_hold  (bypassed for 'READY FOR SHIPDOT')
 * - Exclude shipments with "DO NOT SHIP (ALERT MGR)" package
 * - Exclude shipments with missing serviceCode
 * 
 * PRIMARY: Shipments with any shippable tag (passing applicable hard filters)
 * FALLBACK: If none match primary, use all shipments that pass hard filters
 * 
 * @param shipments - All shipments for an order
 * @param allTags - All tags for these shipments
 * @param packages - Optional array of all packages for these shipments
 * @returns Analysis result with shippable shipments and default selection
 */
export function analyzeShippableShipments<T extends ShipmentForEligibility>(
  shipments: T[],
  allTags: Pick<ShipmentTag, 'shipmentId' | 'name'>[],
  packages: PackageForEligibility[] = []
): ShippableShipmentsResult<T> {
  // Get per-shipment exclusion reasons (including DO NOT SHIP package check)
  const shipmentStatuses = getShipmentStatuses(shipments, packages);
  
  // First apply hard filters: not shipped AND not on_hold AND no DO NOT SHIP package
  const eligibleShipments = filterEligibleShipments(shipments, packages);
  
  // Try primary criteria: eligible (or READY FOR SHIPDOT bypass) + any shippable tag
  let shippableShipments = shipments.filter(shipment =>
    isShipmentShippable(shipment, allTags, packages)
  );
  
  // FALLBACK: If no shipments pass primary criteria, use all eligible shipments
  // This handles split orders where some shipments are on hold and others are pending,
  // but none have been tagged yet.
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
    shipmentStatuses,
  };
}
