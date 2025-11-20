import { storage } from "./storage";
import {
  dequeueShopifyOrderSyncBatch,
  requeueShopifyOrderSyncMessages,
  type ShopifyOrderSyncMessage,
} from './utils/queue';
import { extractActualOrderNumber, extractShopifyOrderPrices } from './utils/shopify-utils';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shopify-sync] ${message}`);
}

const MAX_RETRY_COUNT = 3; // Maximum retries before giving up

/**
 * Process a batch of Shopify order sync messages
 * Returns the number of successfully processed messages
 */
export async function processShopifyOrderSyncBatch(batchSize: number): Promise<number> {
  const messages = await dequeueShopifyOrderSyncBatch(batchSize);
  
  if (messages.length === 0) {
    return 0;
  }

  log(`Processing ${messages.length} Shopify order sync message(s)`);
  let processedCount = 0;
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const retryCount = message.retryCount || 0;
    
    try {
      const { orderNumber } = message;
      
      log(`Fetching order ${orderNumber} from Shopify (attempt ${retryCount + 1}/${MAX_RETRY_COUNT})`);
      
      // Check if order already exists in database
      const existingOrder = await storage.getOrderByOrderNumber(orderNumber);
      if (existingOrder) {
        log(`✓ Order ${orderNumber} already exists in database, skipping`);
        processedCount++;
        continue;
      }
      
      // Fetch order from Shopify API by order number
      const shopifyOrder = await fetchShopifyOrderByOrderNumber(orderNumber);
      
      if (!shopifyOrder) {
        log(`⚠️  Order ${orderNumber} not found in Shopify`);
        
        // If we've exhausted retries, give up
        if (retryCount >= MAX_RETRY_COUNT - 1) {
          log(`❌ Max retries reached for order ${orderNumber}, giving up`);
          processedCount++;
          continue;
        }
        
        // Otherwise, requeue for retry
        const retryMessage: ShopifyOrderSyncMessage = {
          ...message,
          retryCount: retryCount + 1,
        };
        await requeueShopifyOrderSyncMessages([retryMessage]);
        log(`📥 Requeued order ${orderNumber} for retry (${retryCount + 1}/${MAX_RETRY_COUNT})`);
        processedCount++;
        continue;
      }
      
      // Transform Shopify order to our format
      const orderData = {
        id: shopifyOrder.id.toString(),
        orderNumber: extractActualOrderNumber(shopifyOrder),
        customerName: shopifyOrder.customer
          ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
          : "Guest",
        customerEmail: shopifyOrder.customer?.email || null,
        customerPhone: shopifyOrder.customer?.phone || null,
        shippingAddress: shopifyOrder.shipping_address || {},
        lineItems: shopifyOrder.line_items || [],
        fulfillmentStatus: shopifyOrder.fulfillment_status,
        financialStatus: shopifyOrder.financial_status,
        ...extractShopifyOrderPrices(shopifyOrder),
        createdAt: new Date(shopifyOrder.created_at),
        updatedAt: new Date(shopifyOrder.updated_at),
      };
      
      // Create the order in the database
      await storage.createOrder(orderData);
      
      // Create order items
      for (const lineItem of shopifyOrder.line_items) {
        await storage.createOrderItem({
          shopifyLineItemId: lineItem.id.toString(),
          orderId: orderData.id,
          productId: lineItem.product_id?.toString() || null,
          variantId: lineItem.variant_id?.toString() || null,
          quantity: lineItem.quantity,
          name: lineItem.name,
          sku: lineItem.sku || null,
          price: parseFloat(lineItem.price),
        });
      }
      
      log(`✓ Successfully imported order ${orderNumber} from Shopify`);
      processedCount++;
      
    } catch (error: any) {
      log(`❌ Error processing order ${message.orderNumber}: ${error.message}`);
      
      // If we've exhausted retries, give up
      if (retryCount >= MAX_RETRY_COUNT - 1) {
        log(`❌ Max retries reached for order ${message.orderNumber}, giving up`);
        processedCount++;
        continue;
      }
      
      // Otherwise, requeue for retry
      const retryMessage: ShopifyOrderSyncMessage = {
        ...message,
        retryCount: retryCount + 1,
      };
      await requeueShopifyOrderSyncMessages([retryMessage]);
      log(`📥 Requeued order ${message.orderNumber} for retry due to error (${retryCount + 1}/${MAX_RETRY_COUNT})`);
      processedCount++;
    }
  }
  
  log(`Processed ${processedCount} Shopify order sync message(s)`);
  return processedCount;
}

/**
 * Fetch a single order from Shopify by order number
 * Shopify API supports filtering by name (order number)
 */
async function fetchShopifyOrderByOrderNumber(orderNumber: string): Promise<any | null> {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  
  if (!shopDomain || !accessToken) {
    throw new Error('Shopify credentials not configured');
  }
  
  // Clean order number - remove # if present
  const cleanOrderNumber = orderNumber.replace(/^#/, '');
  
  // Shopify API supports searching by order name (which is the order number)
  // The 'name' parameter searches order numbers like #1001, #1002, etc.
  const url = `https://${shopDomain}/admin/api/2024-01/orders.json?name=${encodeURIComponent(cleanOrderNumber)}&status=any&limit=1`;
  
  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const orders = data.orders || [];
  
  // Return the first matching order (should only be one)
  return orders.length > 0 ? orders[0] : null;
}
