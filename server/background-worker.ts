import { dequeueWebhook, getQueueLength } from "./utils/queue";
import { fetchShipStationResource } from "./utils/shipstation-api";
import { linkTrackingToOrder } from "./utils/shipment-linkage";
import { storage } from "./storage";
import { broadcastOrderUpdate } from "./websocket";
import { log } from "./vite";

/**
 * Extract all price fields from a Shopify order object
 * Helper to ensure consistent price field extraction across all data entry points
 * All price fields default to '0' to match schema constraints
 */
function extractShopifyOrderPrices(shopifyOrder: any) {
  return {
    totalPrice: shopifyOrder.total_price || '0', // Legacy field for backwards compatibility
    orderTotal: shopifyOrder.total_price || '0',
    subtotalPrice: shopifyOrder.subtotal_price || '0',
    currentTotalPrice: shopifyOrder.current_total_price || '0',
    currentSubtotalPrice: shopifyOrder.current_subtotal_price || '0',
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
 * Extract and store refunds from a Shopify order
 * Processes the refunds array and stores each refund in the database
 */
async function processOrderRefunds(orderId: string, shopifyOrder: any) {
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
async function processOrderLineItems(orderId: string, shopifyOrder: any) {
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

/**
 * Process a single batch of webhooks from the queue
 * Returns the number of webhooks processed
 */
export async function processWebhookBatch(maxBatchSize: number = 10): Promise<number> {
  let processedCount = 0;

  for (let i = 0; i < maxBatchSize; i++) {
    const webhookData = await dequeueWebhook();
    
    if (!webhookData) {
      break;
    }

    try {
      if (webhookData.type === 'order-id') {
        const orderId = webhookData.orderId;
        const jobId = webhookData.jobId;
        
        const order = await storage.getOrder(orderId);
        if (!order) {
          console.error(`Order ${orderId} not found in database during queue processing`);
          
          // If this is a backfill job, increment failed count so job can complete
          if (jobId) {
            await storage.incrementBackfillFailed(jobId, 1);
            
            const job = await storage.getBackfillJob(jobId);
            if (job && job.totalOrders > 0 && job.processedOrders + job.failedOrders >= job.totalOrders) {
              await storage.updateBackfillJob(jobId, {
                status: "completed",
              });
            }
          }
          
          processedCount++;
          continue;
        }
        
        if (jobId) {
          await storage.incrementBackfillProgress(jobId, 1);
          
          const job = await storage.getBackfillJob(jobId);
          if (job && job.totalOrders > 0 && job.processedOrders + job.failedOrders >= job.totalOrders) {
            await storage.updateBackfillJob(jobId, {
              status: "completed",
            });
          }
        }
        
        broadcastOrderUpdate(order);
        processedCount++;
      } else if (webhookData.type === 'shopify' || webhookData.type === 'backfill') {
        const shopifyOrder = webhookData.order;
        const orderData = {
          id: shopifyOrder.id.toString(),
          orderNumber: shopifyOrder.name || shopifyOrder.order_number,
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

        const existing = await storage.getOrder(orderData.id);
        
        if (existing) {
          await storage.updateOrder(orderData.id, orderData);
        } else {
          await storage.createOrder(orderData);
        }

        // Process refunds from Shopify order
        await processOrderRefunds(orderData.id, shopifyOrder);

        // Process line items from Shopify order
        await processOrderLineItems(orderData.id, shopifyOrder);

        // Update backfill job progress if this is a backfill webhook
        // Count every order processed (new or updated) because the queue ensures no duplicates per job
        if (webhookData.type === 'backfill' && webhookData.jobId) {
          await storage.incrementBackfillProgress(webhookData.jobId, 1);
          
          // Check if job is complete (only if totalOrders has been set)
          const job = await storage.getBackfillJob(webhookData.jobId);
          if (job && job.totalOrders > 0 && job.processedOrders + job.failedOrders >= job.totalOrders) {
            await storage.updateBackfillJob(webhookData.jobId, {
              status: "completed",
            });
          }
        }

        broadcastOrderUpdate(orderData);
      } else if (webhookData.type === 'shopify-product') {
        const shopifyProduct = webhookData.product;
        const topic = webhookData.topic;

        // Handle product deletion
        if (topic === 'products/delete') {
          await storage.softDeleteProduct(shopifyProduct.id.toString());
          // Soft delete all variants (including already deleted ones)
          const allVariants = await storage.getProductVariants(shopifyProduct.id.toString());
          for (const variant of allVariants) {
            await storage.softDeleteProductVariant(variant.id);
          }
          console.log(`Soft deleted product ${shopifyProduct.id} and its variants`);
        } else {
          // Handle product create/update
          const productData = {
            id: shopifyProduct.id.toString(),
            title: shopifyProduct.title,
            imageUrl: shopifyProduct.image?.src || shopifyProduct.images?.[0]?.src || null,
            status: shopifyProduct.status || 'active',
            shopifyCreatedAt: new Date(shopifyProduct.created_at),
            shopifyUpdatedAt: new Date(shopifyProduct.updated_at),
            deletedAt: null, // Resurrect product if previously deleted
          };

          await storage.upsertProduct(productData);

          // Get current variant IDs from Shopify
          const shopifyVariants = shopifyProduct.variants || [];
          const shopifyVariantIds = new Set(shopifyVariants.map((v: any) => v.id.toString()));

          // Get existing variants (including soft-deleted ones for reconciliation)
          const db = await import("./db").then(m => m.db);
          const { productVariants } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const existingVariants = await db
            .select()
            .from(productVariants)
            .where(eq(productVariants.productId, shopifyProduct.id.toString()));

          // Soft-delete variants that are no longer in Shopify payload
          for (const existingVariant of existingVariants) {
            if (!shopifyVariantIds.has(existingVariant.id) && !existingVariant.deletedAt) {
              await storage.softDeleteProductVariant(existingVariant.id);
            }
          }

          // Upsert all current variants (resurrect if previously deleted)
          for (const variant of shopifyVariants) {
            const variantData = {
              id: variant.id.toString(),
              productId: shopifyProduct.id.toString(),
              sku: variant.sku || null,
              barCode: variant.barcode || null,
              title: variant.title || 'Default',
              imageUrl: variant.image_id 
                ? shopifyProduct.images?.find((img: any) => img.id === variant.image_id)?.src || null
                : null,
              price: variant.price,
              inventoryQuantity: variant.inventory_quantity || 0,
              shopifyCreatedAt: new Date(variant.created_at),
              shopifyUpdatedAt: new Date(variant.updated_at),
              deletedAt: null, // Resurrect variant if previously deleted
            };

            await storage.upsertProductVariant(variantData);
          }

          console.log(`Upserted product ${shopifyProduct.id} with ${shopifyVariants.length} variants`);
        }
      } else if (webhookData.type === 'shipstation') {
        // Track webhooks contain tracking data directly in the payload
        if (webhookData.resourceType === 'API_TRACK' && webhookData.trackingData) {
          const trackingData = webhookData.trackingData;
          const trackingNumber = trackingData.tracking_number;
          
          // Find existing shipment by tracking number
          // Note: We can only safely match by tracking number. The label_url points to ShipEngine API
          // which requires separate auth credentials we don't have. Shipments without tracking numbers
          // will be created/updated by fulfillment_shipped_v2 webhooks which contain complete data.
          const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
          
          if (existingShipment) {
            // Update existing shipment with latest tracking data
            await storage.updateShipment(existingShipment.id, {
              carrierCode: trackingData.carrier_code || existingShipment.carrierCode,
              status: trackingData.status_code || 'unknown',
              statusDescription: trackingData.carrier_status_description || trackingData.status_description,
              shipDate: trackingData.ship_date ? new Date(trackingData.ship_date) : existingShipment.shipDate,
              shipmentData: trackingData,
            });
            
            console.log(`Updated shipment ${existingShipment.id} with tracking ${trackingNumber}`);
            
            // Broadcast update to connected clients
            const order = await storage.getOrder(existingShipment.orderId);
            if (order) {
              broadcastOrderUpdate(order);
            }
          } else {
            // No existing shipment found - use shipment linkage to find and create it
            console.log(`No shipment found for tracking ${trackingNumber} - fetching from ShipStation`);
            
            const linkageResult = await linkTrackingToOrder(trackingData, storage);
            
            if (linkageResult.error) {
              console.error(linkageResult.error);
            } else if (linkageResult.order && linkageResult.shipmentData) {
              // Create the shipment record with complete data from shipment and tracking
              const shipmentRecord = {
                orderId: linkageResult.order.id,
                shipmentId: linkageResult.shipmentData.shipment_id,
                trackingNumber: trackingNumber,
                carrierCode: trackingData.carrier_code || linkageResult.shipmentData.carrier_code,
                serviceCode: linkageResult.shipmentData.service_code,
                status: trackingData.status_code === 'DE' ? 'delivered' : 'in_transit',
                statusDescription: trackingData.status_description || 'In Transit',
                shipDate: linkageResult.shipmentData.ship_date ? new Date(linkageResult.shipmentData.ship_date) : null,
                shipmentData: {
                  ...linkageResult.shipmentData,
                  latestTracking: trackingData,
                },
              };
              
              await storage.createShipment(shipmentRecord);
              console.log(`Created shipment ${trackingNumber} for order ${linkageResult.order.orderNumber}`);
              
              // Broadcast update to connected clients
              broadcastOrderUpdate(linkageResult.order);
            }
          }
        } 
        // Fulfillment webhooks need to fetch full shipment data
        else if (webhookData.resourceType === 'FULFILLMENT_V2') {
          const resourceUrl = webhookData.resourceUrl;
          const shipmentResponse = await fetchShipStationResource(resourceUrl);
          const shipments = shipmentResponse.shipments || [];

          for (const shipmentData of shipments) {
            // ShipStation uses 'shipment_number' field for the order number
            const orderNumber = shipmentData.shipment_number;
            const order = await storage.getOrderByOrderNumber(orderNumber);
            
            if (order) {
              const existingShipment = await storage.getShipmentByTrackingNumber(shipmentData.trackingNumber);
              
              const shipmentRecord = {
                orderId: order.id,
                shipmentId: shipmentData.shipmentId?.toString(),
                trackingNumber: shipmentData.trackingNumber,
                carrierCode: shipmentData.carrierCode,
                serviceCode: shipmentData.serviceCode,
                status: shipmentData.voided ? 'cancelled' : 'shipped',
                statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
                shipDate: shipmentData.shipDate ? new Date(shipmentData.shipDate) : null,
                shipmentData: shipmentData,
              };

              if (existingShipment) {
                await storage.updateShipment(existingShipment.id, shipmentRecord);
              } else {
                await storage.createShipment(shipmentRecord);
              }

              broadcastOrderUpdate(order);
            }
          }
        }
      }

      processedCount++;
    } catch (error) {
      console.error("Error processing individual webhook:", error);
    }
  }

  return processedCount;
}

// Use globalThis to persist worker state across hot-reloads
declare global {
  var __backgroundWorkerInterval: NodeJS.Timeout | undefined;
}

/**
 * Start the background worker that processes webhooks from the queue
 * Runs every intervalMs milliseconds
 * Uses singleton pattern to prevent duplicate workers on hot-reload
 */
export function startBackgroundWorker(intervalMs: number = 5000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__backgroundWorkerInterval) {
    log('Background worker already running, skipping duplicate start');
    return globalThis.__backgroundWorkerInterval;
  }

  log(`Background worker started (interval: ${intervalMs}ms)`);
  
  const processQueue = async () => {
    try {
      const queueLength = await getQueueLength();
      
      if (queueLength > 0) {
        const processed = await processWebhookBatch(10);
        if (processed > 0) {
          log(`Background worker processed ${processed} webhook(s), ${queueLength - processed} remaining`);
        }
      }
    } catch (error) {
      console.error("Background worker error:", error);
    }
  };

  globalThis.__backgroundWorkerInterval = setInterval(processQueue, intervalMs);
  return globalThis.__backgroundWorkerInterval;
}

/**
 * Stop the background worker
 */
export function stopBackgroundWorker(): void {
  if (globalThis.__backgroundWorkerInterval) {
    clearInterval(globalThis.__backgroundWorkerInterval);
    globalThis.__backgroundWorkerInterval = undefined;
    log('Background worker stopped');
  }
}
