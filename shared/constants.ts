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

export const UNIVERSAL_TAGS = new Set([
  'All Orders',
  'MOVE OVER',
  'READY FOR SHIPDOT',
  'TikTok Order',
  'TODAY',
]);

export const TAG_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  'OOS item':                      { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300' },
  'Backorder':                     { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300' },
  'Fraud Risk':                    { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300' },
  'TEST ORDER - DO NOT SHIP':      { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300' },
  'Check Address':                 { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-300' },
  'International - Discreet Packaging': { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-300' },
  'KIKI Membership - 20th':        { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-300' },
  'KIKI + KOOZIE':                 { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-300' },
  'Express':                       { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300' },
  'Gift':                          { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-300' },
  'Flavor Drop Bundle':            { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-300' },
  'EMPLOYEE ORDER  - Mark As Shipped': { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-300' },
  'Service Contacted':             { bg: 'bg-sky-50',    text: 'text-sky-700',    border: 'border-sky-300' },
  'Military':                      { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-300' },
  'TikTok Order':                  { bg: 'bg-teal-50',   text: 'text-teal-700',   border: 'border-teal-300' },
  'AMZ - Exotic Basket':           { bg: 'bg-teal-50',   text: 'text-teal-700',   border: 'border-teal-300' },
  'Beef Case':                     { bg: 'bg-stone-50',  text: 'text-stone-700',  border: 'border-stone-300' },
  'MOVE OVER':                     { bg: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-300' },
  'READY FOR SHIPDOT':             { bg: 'bg-stone-50',  text: 'text-stone-500',  border: 'border-stone-200' },
  'All Orders':                    { bg: 'bg-gray-50',   text: 'text-gray-400',   border: 'border-gray-200' },
  'TODAY':                         { bg: 'bg-blue-50',   text: 'text-blue-600',   border: 'border-blue-200' },
};

export const DEFAULT_UNCHECKED_TAGS = new Set([
  'KIKI Membership - 20th',
  'KIKI + KOOZIE',
]);

export const TAG_PRIORITY: Record<string, number> = {
  'Fraud Risk': 0,
  'TEST ORDER - DO NOT SHIP': 0,
  'OOS item': 1,
  'Backorder': 1,
  'Check Address': 2,
  'Express': 2,
  'KIKI Membership - 20th': 3,
  'KIKI + KOOZIE': 3,
  'Gift': 4,
  'Military': 4,
  'International - Discreet Packaging': 4,
  'Service Contacted': 5,
  'EMPLOYEE ORDER  - Mark As Shipped': 5,
  'Flavor Drop Bundle': 5,
  'TikTok Order': 6,
  'TODAY': 7,
  'MOVE OVER': 90,
  'READY FOR SHIPDOT': 91,
  'All Orders': 92,
};

