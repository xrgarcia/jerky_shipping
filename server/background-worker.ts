import { dequeueWebhook, getQueueLength, getShipmentSyncQueueLength, enqueueShipmentSync, getOldestShopifyQueueMessage, getOldestShipmentSyncQueueMessage } from "./utils/queue";
import { fetchShipStationResource } from "./utils/shipstation-api";
import { extractActualOrderNumber, extractShopifyOrderPrices } from "./utils/shopify-utils";
import { shopifyOrderETL } from "./services/shopify-order-etl-service";
import { storage } from "./storage";
import { broadcastOrderUpdate, broadcastQueueStatus, type OrderEventType } from "./websocket";
import { log } from "./vite";
import { updateShipmentLifecycle } from "./services/lifecycle-service";
import { withRetrySafe } from "./utils/db-retry";

/**
 * Process a single batch of webhooks from the queue
 * Returns the number of webhooks processed
 */
export async function processWebhookBatch(maxBatchSize: number = 50): Promise<number> {
  let processedCount = 0;

  for (let i = 0; i < maxBatchSize; i++) {
    const webhookData = await dequeueWebhook();
    
    if (!webhookData) {
      break;
    }

    try {
      if (webhookData.type === 'order-id') {
        const orderId = webhookData.orderId;
        
        const order = await storage.getOrder(orderId);
        if (!order) {
          console.error(`Order ${orderId} not found in database during queue processing`);
          processedCount++;
          continue;
        }
        
        broadcastOrderUpdate(order);
        processedCount++;
      } else if (webhookData.type === 'shopify') {
        const shopifyOrder = webhookData.order;
        const topic = webhookData.topic as string;
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

        const existing = await storage.getOrder(orderData.id);
        const isNewOrder = !existing;
        
        if (existing) {
          await storage.updateOrder(orderData.id, orderData);
        } else {
          await storage.createOrder(orderData);
        }
        
        // Determine event type based on webhook topic and order state
        let eventType: OrderEventType = 'order_updated';
        if (topic === 'orders/create' || isNewOrder) {
          eventType = 'new_order';
        } else if (shopifyOrder.financial_status === 'paid' && existing?.financialStatus !== 'paid') {
          eventType = 'order_paid';
        }

        // Process refunds and line items using centralized ETL service
        await shopifyOrderETL.processOrder(shopifyOrder);

        // Check for shipments and link them if needed
        // This provides recovery when ShipStation webhooks are missed or delayed
        try {
          if (orderData.orderNumber) {
            // First check for shipments by order number (includes unlinked shipments)
            const shipmentsByNumber = await storage.getShipmentsByOrderNumber(orderData.orderNumber);
            
            // If we found shipments, link any that aren't already linked
            if (shipmentsByNumber.length > 0) {
              let linkedCount = 0;
              for (const shipment of shipmentsByNumber) {
                if (!shipment.orderId) {
                  await storage.updateShipment(shipment.id, { orderId: orderData.id });
                  linkedCount++;
                }
              }
              if (linkedCount > 0) {
                console.log(`[background-worker] Linked ${linkedCount} existing shipment(s) to order ${orderData.orderNumber}`);
              }
            }
            // DISABLED: Don't trigger ShipStation API calls from Shopify webhooks
            // ShipStation data comes from ShipStation webhooks only
          }
        } catch (shipmentCheckError) {
          // Don't fail order processing if shipment check fails
          console.error('[background-worker] Failed to check/enqueue shipments:', shipmentCheckError);
        }

        broadcastOrderUpdate(orderData, eventType);
      } else if (webhookData.type === 'shopify-product') {
        const shopifyProduct = webhookData.product;
        const topic = webhookData.topic;

        // Handle product deletion
        if (topic === 'products/delete') {
          await storage.softDeleteShopifyProduct(shopifyProduct.id.toString());
          // Soft delete all variants (including already deleted ones)
          const allVariants = await storage.getShopifyProductVariants(shopifyProduct.id.toString());
          for (const variant of allVariants) {
            await storage.softDeleteShopifyProductVariant(variant.id);
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

          await storage.upsertShopifyProduct(productData);

          // Get current variant IDs from Shopify
          const shopifyVariants = shopifyProduct.variants || [];
          const shopifyVariantIds = new Set(shopifyVariants.map((v: any) => v.id.toString()));

          // Get existing variants (including soft-deleted ones for reconciliation)
          const db = await import("./db").then(m => m.db);
          const { shopifyProductVariants } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const existingVariants = await db
            .select()
            .from(shopifyProductVariants)
            .where(eq(shopifyProductVariants.productId, shopifyProduct.id.toString()));

          // Soft-delete variants that are no longer in Shopify payload
          for (const existingVariant of existingVariants) {
            if (!shopifyVariantIds.has(existingVariant.id) && !existingVariant.deletedAt) {
              await storage.softDeleteShopifyProductVariant(existingVariant.id);
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

            await storage.upsertShopifyProductVariant(variantData);
          }

          console.log(`Upserted product ${shopifyProduct.id} with ${shopifyVariants.length} variants`);
        }
      } else if (webhookData.type === 'shipstation') {
        // Track webhooks - queue for async processing by shipment sync worker
        if (webhookData.resourceType === 'API_TRACK' && webhookData.data) {
          const trackingData = webhookData.data;
          const trackingNumber = trackingData.tracking_number;
          
          // Check if we already have this shipment
          const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
          
          if (existingShipment) {
            // Update existing shipment with latest tracking data from webhook (no API call!)
            const newStatus = trackingData.status_code ? String(trackingData.status_code).toUpperCase() : 'unknown';
            await storage.updateShipment(existingShipment.id, {
              carrierCode: trackingData.carrier_code || existingShipment.carrierCode,
              status: newStatus,
              statusDescription: trackingData.carrier_status_description || trackingData.status_description,
              shipDate: trackingData.ship_date ? new Date(trackingData.ship_date) : existingShipment.shipDate,
              shipmentData: trackingData,
            });
            
            console.log(`Updated shipment ${existingShipment.id} with tracking ${trackingNumber} from webhook`);
            
            // Update lifecycle phase based on new status
            await updateShipmentLifecycle(existingShipment.id, {
              shipmentData: { status: newStatus }
            });
            
            // Broadcast update to connected clients
            if (existingShipment.orderId) {
              const order = await storage.getOrder(existingShipment.orderId);
              if (order) {
                broadcastOrderUpdate(order);
              }
            }
          } else {
            // No existing shipment - queue for intelligent processing
            // Shipment sync worker will try to: (1) extract shipment ID from label URL, (2) lookup by order number, (3) DLQ
            console.log(`No shipment found for tracking ${trackingNumber} - queuing for intelligent shipment sync`);
            
            await enqueueShipmentSync({
              trackingNumber,
              labelUrl: trackingData.label_url, // Extract label URL for shipment ID extraction
              reason: 'webhook_tracking',
              enqueuedAt: Date.now(),
              webhookData: trackingData, // Pass webhook data directly (no API call needed!)
            });
          }
        } 
        // Fulfillment webhooks - intelligently use inline data or fallback to API
        else if (webhookData.resourceType === 'FULFILLMENT_V2') {
          let shipments = [];
          
          // OPTIMIZATION: Check if webhook contains inline shipment data (no API call needed!)
          if (webhookData.data && Array.isArray(webhookData.data.shipments)) {
            shipments = webhookData.data.shipments;
            console.log(`Using inline shipment data from FULFILLMENT_V2 webhook (${shipments.length} shipments) - no API call!`);
          } else if (webhookData.data && !Array.isArray(webhookData.data.shipments) && webhookData.data.shipment_id) {
            // Single shipment case
            shipments = [webhookData.data];
            console.log(`Using inline single shipment data from FULFILLMENT_V2 webhook - no API call!`);
          } else {
            // FALLBACK: Webhook only contains resource URL, need to fetch
            console.log(`FULFILLMENT_V2 webhook missing inline data - falling back to API call`);
            const resourceUrl = webhookData.resourceUrl;
            const shipmentResponse = await fetchShipStationResource(resourceUrl);
            shipments = shipmentResponse.shipments || [];
          }

          // Queue each shipment for processing
          for (const shipmentData of shipments) {
            // ShipStation uses 'shipment_number' field for the order number
            const orderNumber = shipmentData.shipment_number;
            
            if (orderNumber) {
              console.log(`Queueing order ${orderNumber} for shipment sync from FULFILLMENT_V2 webhook`);
              
              await enqueueShipmentSync({
                orderNumber,
                shipmentId: shipmentData.shipment_id,
                trackingNumber: shipmentData.tracking_number,
                reason: 'webhook_fulfillment',
                enqueuedAt: Date.now(),
                webhookData: shipmentData, // Pass shipment data directly from webhook!
              });
            } else {
              console.warn(`Shipment ${shipmentData.shipment_id} missing shipment_number field - cannot queue`);
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
  var __backgroundWorkerActiveRunId: number | null | undefined;
  var __backgroundWorkerNextRunId: number | undefined;
}

/**
 * Start the background worker that processes webhooks from the queue
 * Runs every intervalMs milliseconds
 * Uses singleton pattern to prevent duplicate workers on hot-reload
 * Uses activeRunId mutex (null = idle, number = active) to prevent overlapping batches
 */
export function startBackgroundWorker(intervalMs: number = 5000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__backgroundWorkerInterval) {
    log('Background worker already running, skipping duplicate start');
    return globalThis.__backgroundWorkerInterval;
  }

  // Initialize mutex only if undefined (don't clear in-flight batches)
  if (globalThis.__backgroundWorkerActiveRunId === undefined) {
    globalThis.__backgroundWorkerActiveRunId = null;
  }
  // Persist run ID counter so IDs never collide across stop/start cycles
  globalThis.__backgroundWorkerNextRunId = globalThis.__backgroundWorkerNextRunId ?? 0;
  
  log(`Background worker started (interval: ${intervalMs}ms, batch size: 50)`);
  
  const processQueue = async () => {
    // Check if a batch is already running
    if (globalThis.__backgroundWorkerActiveRunId !== null) {
      return;
    }
    
    // Claim this run with a globally unique ID
    const myRunId = ++(globalThis.__backgroundWorkerNextRunId!);
    globalThis.__backgroundWorkerActiveRunId = myRunId;

    try {
      const startTime = Date.now();
      const queueLength = await getQueueLength();
      
      if (queueLength > 0) {
        const processed = await processWebhookBatch(50);
        const duration = Date.now() - startTime;
        
        if (processed > 0) {
          log(`Background worker processed ${processed} webhook(s) in ${duration}ms, ${queueLength - processed} remaining`);
        }
      }
      
      // Broadcast queue status via WebSocket
      // Use withRetrySafe for database operations to handle transient connection issues
      const shopifyQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const failureCount = await withRetrySafe(() => storage.getShipmentSyncFailureCount(), {}, 0) ?? 0;
      const oldestShopify = await getOldestShopifyQueueMessage();
      const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
      
      // Get active backfill job (with retry)
      const allBackfillJobs = await withRetrySafe(() => storage.getAllBackfillJobs(), {}, []) ?? [];
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
      
      // Get comprehensive data health metrics (with retry)
      const dataHealth = await withRetrySafe(() => storage.getDataHealthMetrics()) ?? undefined;
      
      broadcastQueueStatus({
        shopifyQueue: shopifyQueueLength,
        shipmentSyncQueue: shipmentSyncQueueLength,
        shipmentFailureCount: failureCount,
        shopifyQueueOldestAt: oldestShopify.enqueuedAt,
        shipmentSyncQueueOldestAt: oldestShipmentSync.enqueuedAt,
        backfillActiveJob: activeBackfillJob,
        dataHealth,
      });
    } catch (error) {
      // Log but don't crash on transient errors - worker will retry on next interval
      console.error("Background worker error:", error);
    } finally {
      // Only release the lock if we still own it (handles stop/start edge cases)
      if (globalThis.__backgroundWorkerActiveRunId === myRunId) {
        globalThis.__backgroundWorkerActiveRunId = null;
      }
    }
  };

  globalThis.__backgroundWorkerInterval = setInterval(processQueue, intervalMs);
  return globalThis.__backgroundWorkerInterval;
}

/**
 * Stop the background worker
 * Note: Does not clear activeRunId - let in-flight batches finish naturally
 */
export function stopBackgroundWorker(): void {
  if (globalThis.__backgroundWorkerInterval) {
    clearInterval(globalThis.__backgroundWorkerInterval);
    globalThis.__backgroundWorkerInterval = undefined;
    // Don't clear activeRunId - let running batch finish and release the lock
    log('Background worker stopped');
  }
}
