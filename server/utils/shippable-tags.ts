/**
 * Centralized shippable tag utilities for the server.
 *
 * Re-exports SHIPPABLE_TAGS from shared/constants so all server code
 * imports from the same source of truth.
 */

import { SHIPPABLE_TAGS } from '@shared/constants';

export { SHIPPABLE_TAGS, type ShippableTag } from '@shared/constants';

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
  tagName: string,
  shipmentId?: string
): boolean {
  return tags.some(
    (tag) =>
      (shipmentId == null || tag.shipmentId === shipmentId) &&
      tag.name === tagName
  );
}
