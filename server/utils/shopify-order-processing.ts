/**
 * Shared ETL functions for processing Shopify orders
 * Used by both webhook handlers and backfill service
 */

import type { IStorage } from '../storage';

/**
 * Extract and store refunds from a Shopify order
 * Processes the refunds array and stores each refund in the database
 */
export async function processOrderRefunds(storage: IStorage, orderId: string, shopifyOrder: any) {
  const refunds = shopifyOrder.refunds || [];
  
  for (const refund of refunds) {
    try {
      // Calculate total refund amount from transactions
      const totalAmount = refund.transactions?.reduce((sum: number, txn: any) => {
        return sum + parseFloat(txn.amount || '0');
      }, 0) || 0;

      const refundData = {
        orderId: orderId,
        shopifyRefundId: refund.id.toString(),
        amount: totalAmount.toFixed(2),
        note: refund.note || null,
        refundedAt: new Date(refund.created_at),
        processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
      };

      await storage.upsertOrderRefund(refundData);
    } catch (error) {
      console.error(`Error processing refund ${refund.id} for order ${orderId}:`, error);
    }
  }
}

/**
 * Extract and store line items from a Shopify order
 * Processes the line_items array and stores each item in the database with comprehensive price fields
 * Stores full Shopify JSON structures plus calculated aggregates for efficient reporting
 */
export async function processOrderLineItems(storage: IStorage, orderId: string, shopifyOrder: any) {
  const lineItems = shopifyOrder.line_items || [];
  
  for (const item of lineItems) {
    try {
      // Calculate derived price fields
      const unitPrice = parseFloat(item.price || '0');
      const quantity = item.quantity || 0;
      const preDiscountPrice = (unitPrice * quantity).toFixed(2);
      const totalDiscount = item.total_discount || '0.00';
      const finalLinePrice = (parseFloat(preDiscountPrice) - parseFloat(totalDiscount)).toFixed(2);
      
      // Sum all tax amounts from tax_lines array
      const taxAmount = item.tax_lines?.reduce((sum: number, taxLine: any) => {
        return sum + parseFloat(taxLine.price || '0');
      }, 0) || 0;

      const itemData = {
        orderId: orderId,
        shopifyLineItemId: item.id.toString(),
        title: item.title || item.name || 'Unknown Item',
        sku: item.sku || null,
        variantId: item.variant_id ? item.variant_id.toString() : null,
        productId: item.product_id ? item.product_id.toString() : null,
        quantity: quantity,
        currentQuantity: item.current_quantity !== undefined ? item.current_quantity : null,
        
        // Core price fields (text strings for consistency)
        price: item.price || '0.00',
        totalDiscount: totalDiscount,
        
        // Full Shopify JSON structures (preserves currency and complete data)
        priceSetJson: item.price_set || null,
        totalDiscountSetJson: item.total_discount_set || null,
        taxLinesJson: item.tax_lines || null,
        
        // Tax information
        taxable: item.taxable !== undefined ? item.taxable : null,
        
        // Shipping information
        requiresShipping: item.requires_shipping !== undefined ? item.requires_shipping : null,
        
        // Calculated/extracted fields for easy querying
        priceSetAmount: item.price_set?.shop_money?.amount || '0',
        totalDiscountSetAmount: item.total_discount_set?.shop_money?.amount || '0',
        totalTaxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : '0',
        preDiscountPrice: preDiscountPrice,
        finalLinePrice: finalLinePrice,
      };

      await storage.upsertOrderItem(itemData);
    } catch (error) {
      console.error(`Error processing line item ${item.id} for order ${orderId}:`, error);
    }
  }
}
