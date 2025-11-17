import { dequeueWebhook, getQueueLength } from "./utils/queue";
import { fetchShipStationResource } from "./utils/shipstation-api";
import { storage } from "./storage";
import { broadcastOrderUpdate } from "./websocket";
import { log } from "./vite";

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
      if (webhookData.type === 'shopify') {
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
          totalPrice: shopifyOrder.total_price,
          createdAt: new Date(shopifyOrder.created_at),
          updatedAt: new Date(shopifyOrder.updated_at),
        };

        const existing = await storage.getOrder(orderData.id);
        if (existing) {
          await storage.updateOrder(orderData.id, orderData);
        } else {
          await storage.createOrder(orderData);
        }

        broadcastOrderUpdate(orderData);
      } else if (webhookData.type === 'shipstation') {
        // Track webhooks contain tracking data directly in the payload
        if (webhookData.resourceType === 'API_TRACK' && webhookData.trackingData) {
          const trackingData = webhookData.trackingData;
          const trackingNumber = trackingData.tracking_number;
          
          // Find existing shipment by tracking number
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
            // No existing shipment found - it will be created when fulfillment_shipped_v2 webhook arrives
            console.log(`No existing shipment found for tracking ${trackingNumber} - waiting for fulfillment webhook`);
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
