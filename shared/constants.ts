/**
 * Shared constants used by both client and server.
 */

/**
 * Shopify tags that mark an order as ready to be shipped through ship.
 * An order with ANY of these tags is considered "shippable".
 *
 * - 'MOVE OVER': Set by SkuVault after wave picking is complete.
 */
export const SHIPPABLE_TAGS = ['MOVE OVER'] as const;
export type ShippableTag = (typeof SHIPPABLE_TAGS)[number];

/**
 * The tag applied by Marc's automation that signals an order should enter
 * the lifecycle state machine at READY_TO_SESSION for prep pipeline processing.
 *
 * This is NOT a shippable condition — it is a lifecycle entry path.
 * Orders with this tag enter at READY_TO_SESSION and flow through the full
 * prep pipeline (hydration → categorization → fingerprint → packaging →
 * rate check → session) regardless of on_hold status.
 *
 * Shippability still requires 'MOVE OVER' + pending status.
 */
export const READY_FOR_SHIPDOT_TAG = 'READY FOR SHIPDOT' as const;

export const BUILD_DEFAULT_EXCLUDED_TAGS = [
  'KIKI Membership - 20th',
  'KIKI + KOOZIE',
  'NOT SHIPPABLE',
] as const;
