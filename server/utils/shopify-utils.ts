/**
 * Extract all price fields from a Shopify order object
 * Helper to ensure consistent price field extraction across all data entry points
 * All price fields default to '0' to match schema constraints
 */
export function extractShopifyOrderPrices(shopifyOrder: any) {
  return {
    totalPrice: shopifyOrder.total_price || '0', // Legacy field for backwards compatibility
    orderTotal: shopifyOrder.total_price || '0',
    totalLineItemsPrice: shopifyOrder.total_line_items_price || '0', // GROSS SALES: Before ANY discounts
    subtotalPrice: shopifyOrder.subtotal_price || '0',
    currentTotalPrice: shopifyOrder.current_total_price || '0',
    currentSubtotalPrice: shopifyOrder.current_subtotal_price || '0', // NET SALES: After all discounts
    shippingTotal: shopifyOrder.total_shipping_price_set?.shop_money?.amount || '0',
    totalDiscounts: shopifyOrder.total_discounts || '0',
    currentTotalDiscounts: shopifyOrder.current_total_discounts || '0',
    totalTax: shopifyOrder.total_tax || '0',
    currentTotalTax: shopifyOrder.current_total_tax || '0',
    totalAdditionalFees: shopifyOrder.total_additional_fees_set?.shop_money?.amount || '0',
    currentTotalAdditionalFees: shopifyOrder.current_total_additional_fees_set?.shop_money?.amount || '0',
    totalOutstanding: shopifyOrder.total_outstanding || '0',
  };
}

/**
 * Extract the actual order number from any sales channel
 * - For Amazon orders: returns Amazon order number (e.g., "111-7320858-2210642")
 * - For direct Shopify orders: returns Shopify order number (e.g., "JK3825344788")
 * - For other marketplaces: returns their native order number format
 */
export function extractActualOrderNumber(shopifyOrder: any): string {
  // Method 1: Check fulfillments for Amazon marketplace data
  const fulfillments = shopifyOrder.fulfillments || [];
  for (const fulfillment of fulfillments) {
    // Amazon orders have gateway set to "amazon" and receipt contains marketplace data
    if (fulfillment.receipt?.marketplace_fulfillment_order_id) {
      return fulfillment.receipt.marketplace_fulfillment_order_id;
    }
    // Alternative: Some Amazon orders store it in the order_id field
    if (fulfillment.receipt?.order_id && /^\d{3}-\d{7}-\d{7}$/.test(fulfillment.receipt.order_id)) {
      return fulfillment.receipt.order_id;
    }
  }
  
  // Method 2: Check if source_name indicates Amazon marketplace
  if (shopifyOrder.source_name === 'amazon' && shopifyOrder.source_identifier) {
    return shopifyOrder.source_identifier;
  }
  
  // Method 3: Parse order name if it matches Amazon format (###-#######-#######)
  if (shopifyOrder.name && /^\d{3}-\d{7}-\d{7}$/.test(shopifyOrder.name)) {
    return shopifyOrder.name;
  }
  
  // Method 4: Default to Shopify order name, stripping the # prefix if present
  const shopifyOrderName = shopifyOrder.name || shopifyOrder.order_number || '';
  return shopifyOrderName.replace(/^#/, '');
}
