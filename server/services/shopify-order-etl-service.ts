/**
 * ShopifyOrderETLService
 * 
 * Centralized service for extracting, transforming, and loading Shopify order data.
 * Follows OOP principles with dependency injection for storage and logging.
 * Used by all ingestion paths: webhooks, sync workers, backfill jobs, and API endpoints.
 */

import { storage } from '../storage';
import type { IStorage } from '../storage';
import type { InsertOrderRefund, InsertOrderItem } from '@shared/schema';

export class ShopifyOrderETLService {
  constructor(private readonly storage: IStorage) {}

  /**
   * Main orchestration method: Process a complete Shopify order
   * Handles order metadata, refunds, and line items in a single transaction
   */
  async processOrder(shopifyOrder: any): Promise<void> {
    const orderId = shopifyOrder.id.toString();
    
    // Process refunds first (they reference the order)
    await this.processOrderRefunds(orderId, shopifyOrder);
    
    // Process line items with all fields including requiresShipping
    await this.processOrderLineItems(orderId, shopifyOrder);
  }

  /**
   * Extract and persist order refunds from Shopify order payload
   */
  async processOrderRefunds(orderId: string, shopifyOrder: any): Promise<void> {
    const refunds = shopifyOrder.refunds || [];
    
    for (const refund of refunds) {
      try {
        // Calculate total refund amount from transactions
        const totalAmount = refund.transactions?.reduce((sum: number, txn: any) => {
          return sum + parseFloat(txn.amount || '0');
        }, 0) || 0;

        const refundData: Omit<InsertOrderRefund, 'id' | 'createdAt' | 'updatedAt'> = {
          orderId: orderId,
          shopifyRefundId: refund.id.toString(),
          amount: totalAmount.toFixed(2),
          note: refund.note || null,
          refundedAt: new Date(refund.created_at),
          processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
        };

        await this.storage.upsertOrderRefund(refundData);
      } catch (error) {
        console.error(`[ShopifyOrderETL] Error processing refund ${refund.id} for order ${orderId}:`, error);
      }
    }
  }

  /**
   * Extract and persist order line items from Shopify order payload
   * Includes comprehensive price fields, tax information, and requiresShipping flag
   */
  async processOrderLineItems(orderId: string, shopifyOrder: any): Promise<void> {
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

        const itemData: Omit<InsertOrderItem, 'id' | 'createdAt' | 'updatedAt'> = {
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
          
          // Shipping information - CRITICAL for filtering non-shippable items
          requiresShipping: item.requires_shipping !== undefined ? item.requires_shipping : null,
          
          // Calculated/extracted fields for easy querying
          priceSetAmount: item.price_set?.shop_money?.amount || '0',
          totalDiscountSetAmount: item.total_discount_set?.shop_money?.amount || '0',
          totalTaxAmount: taxAmount > 0 ? taxAmount.toFixed(2) : '0',
          preDiscountPrice: preDiscountPrice,
          finalLinePrice: finalLinePrice,
        };

        await this.storage.upsertOrderItem(itemData);
      } catch (error) {
        console.error(`[ShopifyOrderETL] Error processing line item ${item.id} for order ${orderId}:`, error);
      }
    }
  }
}

// Export singleton instance for convenience
export const shopifyOrderETL = new ShopifyOrderETLService(storage);
