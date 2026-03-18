/**
 * Centralized shippable tag definitions.
 *
 * Shipments with any of these tags are considered "shippable" — they have
 * been flagged by an operator or automation as ready to process.
 *
 * 'MOVE OVER': Standard tag applied after SkuVault wave picking session closes.
 * 'READY FOR SHIPDOT': Pre-tag applied by Marc's automation before hold release,
 *   allowing Ship.dot to start packing earlier and spread load throughout the day.
 *   Unlike MOVE OVER, this tag can be present while the shipment is still on_hold.
 */

export const SHIPPABLE_TAGS = ['MOVE OVER', 'READY FOR SHIPDOT'] as const;
export type ShippableTag = (typeof SHIPPABLE_TAGS)[number];

/**
 * Check whether a collection of tags contains any shippable tag.
 *
 * @param tags  - Array of tag objects (must have a `name` field; optional `shipmentId`)
 * @param shipmentId - When provided, only tags belonging to this shipment are considered
 */
export function hasShippableTag(
  tags: { name: string; shipmentId?: string }[],
  shipmentId?: string
): boolean {
  return tags.some(
    (tag) =>
      (shipmentId == null || tag.shipmentId === shipmentId) &&
      (SHIPPABLE_TAGS as readonly string[]).includes(tag.name)
  );
}

/**
 * Check whether a collection of tags contains a specific shippable tag.
 *
 * @param tags       - Array of tag objects (must have a `name` field; optional `shipmentId`)
 * @param tagName    - The specific shippable tag to look for
 * @param shipmentId - When provided, only tags belonging to this shipment are considered
 */
export function hasSpecificShippableTag(
  tags: { name: string; shipmentId?: string }[],
  tagName: ShippableTag,
  shipmentId?: string
): boolean {
  return tags.some(
    (tag) =>
      (shipmentId == null || tag.shipmentId === shipmentId) &&
      tag.name === tagName
  );
}
