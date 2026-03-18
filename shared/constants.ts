/**
 * Shared constants used by both client and server.
 */

/**
 * Shopify tags that mark an order as ready to be shipped through ship.
 * An order with ANY of these tags is considered "shippable".
 *
 * - 'MOVE OVER': Set by SkuVault after wave picking is complete.
 * - 'READY FOR SHIPDOT': Set by Marc's automation to pre-tag orders
 *   throughout the day, reducing peak-time ShipStation API rate-limit pressure.
 *   Unlike 'MOVE OVER', this tag bypasses the on_hold hard filter so orders
 *   can be packed while still technically on hold in ShipStation.
 */
export const SHIPPABLE_TAGS = ['MOVE OVER', 'READY FOR SHIPDOT'] as const;
export type ShippableTag = (typeof SHIPPABLE_TAGS)[number];

/**
 * The shippable tag that bypasses the on_hold hard filter.
 * Orders tagged with this can be packed while still on hold in ShipStation.
 */
export const ON_HOLD_BYPASS_TAG = 'READY FOR SHIPDOT' as const satisfies ShippableTag;
