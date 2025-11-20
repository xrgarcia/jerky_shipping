/**
 * Shipment Sync Worker
 * Processes shipment sync requests from Redis queue asynchronously
 * Handles ShipStation rate limiting and logs failures to dead letter queue
 */

import { storage } from './storage';
import { db } from './db';
import { 
  dequeueShipmentSyncBatch,
  getShipmentSyncQueueLength,
  getQueueLength,
  getOldestShopifyQueueMessage,
  getOldestShipmentSyncQueueMessage,
  getShopifyOrderSyncQueueLength,
  getOldestShopifyOrderSyncQueueMessage,
  requeueShipmentSyncMessages,
  enqueueShopifyOrderSync,
  removeShipmentSyncFromInflight,
  type ShipmentSyncMessage,
  type ShopifyOrderSyncMessage,
} from './utils/queue';
import { getShipmentsByOrderNumber } from './utils/shipstation-api';
import { linkTrackingToOrder, type TrackingData } from './utils/shipment-linkage';
import { shipmentSyncFailures, type InsertShipmentSyncFailure } from '@shared/schema';
import { broadcastOrderUpdate, broadcastQueueStatus } from './websocket';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shipment-sync] ${message}`);
}

const MAX_SHIPMENT_RETRY_COUNT = 3; // Maximum retries before giving up on shipment sync

/**
 * Process a batch of shipment sync messages
 * Returns the number of successfully processed messages
 */
export async function processShipmentSyncBatch(batchSize: number): Promise<number> {
  const messages = await dequeueShipmentSyncBatch(batchSize);
  
  if (messages.length === 0) {
    return 0;
  }

  log(`Processing ${messages.length} shipment sync message(s)`);
  let processedCount = 0;
  let shouldStopBatch = false;
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    
    try {
      const { orderNumber, trackingNumber, labelUrl, shipmentId, reason, jobId } = message;
      
      // Determine which path to use: tracking number or order number
      if (trackingNumber) {
        // PATH A: Tracking number path
        // Use linkTrackingToOrder to fetch shipment and find the order
        log(`Processing tracking number: ${trackingNumber}`);
        
        const trackingData: TrackingData = {
          tracking_number: trackingNumber,
          label_url: labelUrl,
          shipment_id: shipmentId,
        };
        
        const linkageResult = await linkTrackingToOrder(trackingData, storage);
        
        // Check rate limit AFTER API call and stop batch immediately if exhausted
        if (linkageResult.rateLimit) {
          const { remaining, reset, limit } = linkageResult.rateLimit;
          log(`[${trackingNumber}] API call made, ${remaining}/${limit} calls remaining`);
          
          // If we're out of quota, requeue remaining messages and stop batch
          if (remaining <= 0) {
            const waitTime = reset + 3; // Add 3 second buffer to ensure we're past the window
            log(`⚠️  Rate limit exhausted (0 remaining), will stop batch after this message. Next run in ${waitTime}s...`);
            shouldStopBatch = true;
          }
        }
        
        // Handle cases where shipmentData exists but order linkage failed
        if (linkageResult.error || !linkageResult.order) {
          // Check if we have shipment data even though order wasn't found
          if (linkageResult.shipmentData) {
            // Create shipment without order linkage (fire-and-forget Shopify sync)
            const shipmentData = linkageResult.shipmentData;
            
            // Validate shipment ID exists
            const rawShipmentId = shipmentData.shipment_id || shipmentData.shipmentId;
            if (!rawShipmentId) {
              log(`⚠️  [${trackingNumber}] Skipping shipment with missing ID`);
              await logShipmentSyncFailure({
                orderNumber: linkageResult.orderNumber || trackingNumber,
                reason,
                errorMessage: 'Shipment data missing shipment_id field',
                requestData: {
                  queueMessage: message,
                  originalWebhook: message.originalWebhook || null,
                },
                responseData: shipmentData,
                retryCount: 0,
                failedAt: new Date(),
              });
              processedCount++;
              
              if (shouldStopBatch) {
                const remainingMessages = messages.slice(i + 1);
                if (remainingMessages.length > 0) {
                  await requeueShipmentSyncMessages(remainingMessages);
                  log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
                }
                break;
              }
              continue;
            }
            
            // Create shipment without order linkage (orderId will be null)
            const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
            
            const shipmentRecord = {
              orderId: null, // No order linkage
              shipmentId: String(rawShipmentId),
              trackingNumber: trackingNumber,
              carrierCode: shipmentData.carrier_code || shipmentData.carrierCode || null,
              serviceCode: shipmentData.service_code || shipmentData.serviceCode || null,
              status: shipmentData.voided ? 'cancelled' : 'shipped',
              statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
              shipDate: shipmentData.ship_date ? new Date(shipmentData.ship_date) : null,
              shipmentData: shipmentData,
            };
            
            if (existingShipment) {
              await storage.updateShipment(existingShipment.id, shipmentRecord);
              log(`[${trackingNumber}] Updated shipment without order linkage`);
            } else {
              await storage.createShipment(shipmentRecord);
              log(`[${trackingNumber}] Created shipment without order linkage`);
            }
            
            // Fire-and-forget: Trigger Shopify order sync if we found an order number
            if (linkageResult.orderNumber) {
              log(`📤 Triggering fire-and-forget Shopify order sync for ${linkageResult.orderNumber}`);
              const shopifyMessage: ShopifyOrderSyncMessage = {
                orderNumber: linkageResult.orderNumber,
                reason: 'shipment-webhook',
                enqueuedAt: Date.now(),
                triggeringShipmentTracking: trackingNumber,
              };
              await enqueueShopifyOrderSync(shopifyMessage);
            }
            
            processedCount++;
            
            if (shouldStopBatch) {
              const remainingMessages = messages.slice(i + 1);
              if (remainingMessages.length > 0) {
                await requeueShipmentSyncMessages(remainingMessages);
                log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
              }
              break;
            }
            continue;
          }
          
          // No shipment data at all - log failure
          await logShipmentSyncFailure({
            orderNumber: linkageResult.orderNumber || trackingNumber,
            reason,
            errorMessage: linkageResult.error || 'Failed to link tracking to order',
            requestData: {
              queueMessage: message,
              originalWebhook: message.originalWebhook || null,
            },
            responseData: linkageResult.shipmentData,
            retryCount: 0,
            failedAt: new Date(),
          });
          processedCount++;
          
          if (shouldStopBatch) {
            const remainingMessages = messages.slice(i + 1);
            if (remainingMessages.length > 0) {
              await requeueShipmentSyncMessages(remainingMessages);
              log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
            }
            break;
          }
          continue;
        }
        
        // Successfully linked - create/update shipment
        const order = linkageResult.order;
        const shipmentData = linkageResult.shipmentData;
        
        // Validate shipment ID exists to prevent corrupting DB with "undefined" string
        const rawShipmentId = shipmentData.shipment_id || shipmentData.shipmentId;
        if (!rawShipmentId) {
          log(`⚠️  [${trackingNumber}] Skipping shipment with missing ID for order ${order.orderNumber}`);
          await logShipmentSyncFailure({
            orderNumber: order.orderNumber,
            reason,
            errorMessage: 'Shipment data missing shipment_id field',
            requestData: {
              queueMessage: message,
              originalWebhook: message.originalWebhook || null,
            },
            responseData: shipmentData,
            retryCount: 0,
            failedAt: new Date(),
          });
          processedCount++;
          
          // If we hit rate limit during this request, requeue remaining and stop
          if (shouldStopBatch) {
            const remainingMessages = messages.slice(i + 1);
            if (remainingMessages.length > 0) {
              await requeueShipmentSyncMessages(remainingMessages);
              log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
            }
            break;
          }
          continue;
        }
        
        const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        const shipmentRecord = {
          orderId: order.id,
          shipmentId: String(rawShipmentId),
          trackingNumber: trackingNumber,
          carrierCode: shipmentData.carrier_code || shipmentData.carrierCode || null,
          serviceCode: shipmentData.service_code || shipmentData.serviceCode || null,
          status: shipmentData.voided ? 'cancelled' : 'shipped',
          statusDescription: shipmentData.voided ? 'Shipment voided' : 'Shipment created',
          shipDate: shipmentData.ship_date ? new Date(shipmentData.ship_date) : null,
          shipmentData: shipmentData,
        };
        
        if (existingShipment) {
          await storage.updateShipment(existingShipment.id, shipmentRecord);
          log(`[${trackingNumber}] Updated shipment for order ${order.orderNumber}`);
        } else {
          await storage.createShipment(shipmentRecord);
          log(`[${trackingNumber}] Created shipment for order ${order.orderNumber}`);
        }
        
        // Broadcast order update via WebSocket
        broadcastOrderUpdate(order);
        
        processedCount++;
        
        // If we hit rate limit during this request, requeue remaining and stop
        if (shouldStopBatch) {
          const remainingMessages = messages.slice(i + 1);
          if (remainingMessages.length > 0) {
            await requeueShipmentSyncMessages(remainingMessages);
            log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
          }
          break;
        }
        
      } else if (orderNumber) {
        // PATH B: Order number path
        log(`Processing order number: ${orderNumber}`);
        
        // Fetch shipments from ShipStation (regardless of order existence)
        const { data: shipments, rateLimit } = await getShipmentsByOrderNumber(orderNumber);
        
        log(`[${orderNumber}] ${shipments.length} shipment(s) found, ${rateLimit.remaining}/${rateLimit.limit} API calls remaining`);
        
        // Log to dead letter queue for troubleshooting when 0 shipments found
        if (shipments.length === 0) {
          await logShipmentSyncFailure({
            orderNumber: orderNumber,
            reason: message.reason,
            errorMessage: `0 shipments found in ShipStation for order number ${orderNumber}`,
            requestData: {
              queueMessage: message,
              searchedOrderNumber: orderNumber,
              apiEndpoint: `v2/shipments?shipment_number=${orderNumber}`,
            },
            responseData: {
              shipmentsCount: 0,
              rateLimit: {
                limit: rateLimit.limit,
                remaining: rateLimit.remaining,
                reset: rateLimit.reset,
              },
            },
            retryCount: 0,
            failedAt: new Date(),
          });
          log(`📋 Logged to failures: 0 shipments found for ${orderNumber} (rate limit: ${rateLimit.remaining}/${rateLimit.limit})`);
        }
        
        // Find the order in our database (may be null for multi-channel orders)
        const order = await storage.getOrderByOrderNumber(orderNumber);
        
        // CRITICAL: Save shipments to database BEFORE checking rate limit
        // This ensures we don't waste API calls by fetching data then discarding it
        for (const shipmentData of shipments) {
          // ShipStation V2 API returns snake_case fields, handle both formats
          const data = shipmentData as any;
          
          // Validate shipment ID exists to prevent corrupting DB with "undefined" string
          const rawShipmentId = data.shipment_id || data.shipmentId;
          if (!rawShipmentId) {
            log(`⚠️  [${orderNumber}] Skipping shipment with missing ID: ${JSON.stringify(data)}`);
            continue;
          }
          
          const shipmentId = String(rawShipmentId);
          const trackingNumber = data.tracking_number || data.trackingNumber || null;
          const carrierCode = data.carrier_code || data.carrierCode || null;
          const serviceCode = data.service_code || data.serviceCode || null;
          const shipDate = data.ship_date || data.shipDate;
          const voided = data.voided || false;
          
          const existingShipment = await storage.getShipmentByShipmentId(shipmentId);
          
          const shipmentRecord = {
            orderId: order?.id || null, // Nullable order linkage
            shipmentId: shipmentId,
            trackingNumber: trackingNumber,
            carrierCode: carrierCode,
            serviceCode: serviceCode,
            status: voided ? 'cancelled' : 'shipped',
            statusDescription: voided ? 'Shipment voided' : 'Shipment created',
            shipDate: shipDate ? new Date(shipDate) : null,
            shipmentData: shipmentData,
          };

          if (existingShipment) {
            await storage.updateShipment(existingShipment.id, shipmentRecord);
            log(`[${orderNumber}] Updated shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          } else {
            await storage.createShipment(shipmentRecord);
            log(`[${orderNumber}] Created shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          }
        }
        
        // Fire-and-forget: Trigger Shopify order sync if order not found
        if (!order) {
          log(`📤 Triggering fire-and-forget Shopify order sync for ${orderNumber}`);
          const shopifyMessage: ShopifyOrderSyncMessage = {
            orderNumber,
            reason: 'shipment-webhook',
            enqueuedAt: Date.now(),
          };
          await enqueueShopifyOrderSync(shopifyMessage);
        }

        // Broadcast order update via WebSocket (if order exists)
        if (order) {
          broadcastOrderUpdate(order);
        }
        
        processedCount++;
        
        // Check rate limit AFTER saving data and mark to stop if exhausted
        if (rateLimit.remaining <= 0) {
          const waitTime = rateLimit.reset + 3; // Add 3 second buffer to ensure we're past the window
          log(`⚠️  Rate limit exhausted (${rateLimit.remaining} remaining), will stop batch after this message. Next run in ${waitTime}s...`);
          shouldStopBatch = true;
        }
        
      } else {
        // Invalid message - neither tracking number nor order number
        log(`⚠️  Invalid message: missing both orderNumber and trackingNumber`);
        processedCount++;
        
        // If we hit rate limit during a previous request, requeue remaining and stop
        if (shouldStopBatch) {
          const remainingMessages = messages.slice(i + 1);
          if (remainingMessages.length > 0) {
            await requeueShipmentSyncMessages(remainingMessages);
            log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
          }
          break;
        }
        continue;
      }
      
      // Add small delay between requests to be respectful to API
      if (processedCount < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error: any) {
      // Log failure to dead letter queue
      await logShipmentSyncFailure({
        orderNumber: message.orderNumber || message.trackingNumber || 'unknown',
        reason: message.reason,
        errorMessage: error.message || 'Unknown error',
        requestData: {
          queueMessage: message,
          originalWebhook: message.originalWebhook || null,
        },
        responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
        retryCount: 0,
        failedAt: new Date(),
      });
      
      log(`❌ Failed to sync shipments for ${message.orderNumber || message.trackingNumber}: ${error.message}`);
      processedCount++;
    } finally {
      // Always remove from in-flight set after processing (success or failure)
      await removeShipmentSyncFromInflight(message);
    }
    
    // If we should stop due to rate limits, requeue remaining unprocessed messages
    if (shouldStopBatch) {
      const remainingMessages = messages.slice(i + 1); // Get all messages after current index
      if (remainingMessages.length > 0) {
        await requeueShipmentSyncMessages(remainingMessages);
        log(`📥 Requeued ${remainingMessages.length} unprocessed message(s) due to rate limit`);
      }
      break; // Exit the loop now that unprocessed messages are safely back in queue
    }
  }

  return processedCount;
}

/**
 * Log a shipment sync failure to the dead letter queue
 */
async function logShipmentSyncFailure(failure: InsertShipmentSyncFailure): Promise<void> {
  try {
    await db.insert(shipmentSyncFailures).values(failure);
  } catch (error) {
    console.error('[shipment-sync] Failed to log failure to dead letter queue:', error);
  }
}

// Use globalThis to persist worker state across hot-reloads
declare global {
  var __shipmentSyncWorkerInterval: NodeJS.Timeout | undefined;
  var __shipmentSyncWorkerActiveRunId: number | null | undefined;
  var __shipmentSyncWorkerNextRunId: number | undefined;
}

/**
 * Start the shipment sync worker that processes shipment sync requests from the queue
 * Runs every intervalMs milliseconds
 * Uses singleton pattern to prevent duplicate workers on hot-reload
 * Uses activeRunId mutex (null = idle, number = active) to prevent overlapping batches
 */
export function startShipmentSyncWorker(intervalMs: number = 10000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__shipmentSyncWorkerInterval) {
    log('Shipment sync worker already running, skipping duplicate start');
    return globalThis.__shipmentSyncWorkerInterval;
  }

  // Initialize mutex only if undefined (don't clear in-flight batches)
  if (globalThis.__shipmentSyncWorkerActiveRunId === undefined) {
    globalThis.__shipmentSyncWorkerActiveRunId = null;
  }
  // Persist run ID counter so IDs never collide across stop/start cycles
  globalThis.__shipmentSyncWorkerNextRunId = globalThis.__shipmentSyncWorkerNextRunId ?? 0;
  
  log(`Shipment sync worker started (interval: ${intervalMs}ms, batch size: 50)`);
  
  const processQueue = async () => {
    // Check if a batch is already running
    if (globalThis.__shipmentSyncWorkerActiveRunId !== null) {
      return;
    }
    
    // Claim this run with a globally unique ID
    const myRunId = ++(globalThis.__shipmentSyncWorkerNextRunId!);
    globalThis.__shipmentSyncWorkerActiveRunId = myRunId;

    try {
      const startTime = Date.now();
      const queueLength = await getShipmentSyncQueueLength();
      
      if (queueLength > 0) {
        const processed = await processShipmentSyncBatch(50);
        const duration = Date.now() - startTime;
        
        if (processed > 0) {
          log(`Processed ${processed} shipment sync message(s) in ${duration}ms, ${queueLength - processed} remaining`);
        }
      }
      
      // Broadcast queue status via WebSocket
      const shopifyQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const shopifyOrderSyncQueueLength = await getShopifyOrderSyncQueueLength();
      const failureCount = await storage.getShipmentSyncFailureCount();
      const oldestShopify = await getOldestShopifyQueueMessage();
      const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
      const oldestShopifyOrderSync = await getOldestShopifyOrderSyncQueueMessage();
      
      // Get active backfill job
      const allBackfillJobs = await storage.getAllBackfillJobs();
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'in_progress' || j.status === 'pending') || null;
      
      // Get comprehensive data health metrics
      const dataHealth = await storage.getDataHealthMetrics();
      
      broadcastQueueStatus({
        shopifyQueue: shopifyQueueLength,
        shipmentSyncQueue: shipmentSyncQueueLength,
        shopifyOrderSyncQueue: shopifyOrderSyncQueueLength,
        shipmentFailureCount: failureCount,
        shopifyQueueOldestAt: oldestShopify.enqueuedAt,
        shipmentSyncQueueOldestAt: oldestShipmentSync.enqueuedAt,
        shopifyOrderSyncQueueOldestAt: oldestShopifyOrderSync.enqueuedAt,
        backfillActiveJob: activeBackfillJob,
        dataHealth,
      });
    } catch (error) {
      console.error("Shipment sync worker error:", error);
    } finally {
      // Only release the lock if we still own it (handles stop/start edge cases)
      if (globalThis.__shipmentSyncWorkerActiveRunId === myRunId) {
        globalThis.__shipmentSyncWorkerActiveRunId = null;
      }
    }
  };

  globalThis.__shipmentSyncWorkerInterval = setInterval(processQueue, intervalMs);
  return globalThis.__shipmentSyncWorkerInterval;
}

/**
 * Stop the shipment sync worker
 * Note: Does not clear activeRunId - let in-flight batches finish naturally
 */
export function stopShipmentSyncWorker(): void {
  if (globalThis.__shipmentSyncWorkerInterval) {
    clearInterval(globalThis.__shipmentSyncWorkerInterval);
    globalThis.__shipmentSyncWorkerInterval = undefined;
    // Don't clear activeRunId - let running batch finish and release the lock
    log('Shipment sync worker stopped');
  }
}
