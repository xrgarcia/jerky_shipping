/**
 * Webhook Processing Queue Worker (shipment-sync-worker)
 * 
 * PURPOSE:
 * This worker processes real-time ShipStation webhook events from a Redis queue.
 * It is ONE HALF of the Dual Shipment Sync Architecture:
 * 
 *   1. Unified Shipment Sync Worker (unified-shipment-sync-worker.ts)
 *      - Cursor-based polling of ShipStation API on a schedule
 *      - Ensures 100% data coverage by systematically processing all changes
 *      - Primary mechanism for catching missed or delayed updates
 * 
 *   2. THIS WORKER (shipment-sync-worker.ts)
 *      - Processes webhook events from Redis queue for sub-minute freshness
 *      - Handles: tracking updates, fulfillment events, backfill jobs, manual syncs
 *      - Provides real-time responsiveness to ShipStation events
 * 
 * The two systems are complementary - the unified worker guarantees coverage,
 * while this webhook queue provides immediate response to live events.
 * 
 * QUEUE STRUCTURE:
 * - High Priority (shipstation:shipment-sync:high): Webhooks, backfill, manual triggers
 * - Low Priority (shipstation:shipment-sync:low): Reverse sync verification
 * 
 * FEATURES:
 * - ShipStation rate limit handling with intelligent backoff
 * - Dead letter queue for failed messages (logged to shipment_sync_failures table)
 * - Inline webhook data optimization (skip API calls when data is in webhook payload)
 * - Parallel processing for reverse sync batches (40x speedup)
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
  enqueueShopifyOrderSync,
  enqueueShipmentSync,
  removeShipmentSyncFromInflight,
  clearShipmentSyncInflight,
  type ShipmentSyncMessage,
  type ShopifyOrderSyncMessage,
} from './utils/queue';
import { getShipmentsByOrderNumber, getShipmentByShipmentId } from './utils/shipstation-api';
import { linkTrackingToOrder, type TrackingData } from './utils/shipment-linkage';
import { 
  shipmentSyncFailures, 
  type InsertShipmentSyncFailure 
} from '@shared/schema';
import { broadcastOrderUpdate, broadcastQueueStatus, type OrderEventType } from './websocket';
import { withRetrySafe } from './utils/db-retry';
import { shipStationShipmentETL } from './services/shipstation-shipment-etl-service';
import { updateShipmentLifecycle } from './services/lifecycle-service';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shipment-sync] ${message}`);
}

/**
 * Check if an error is a rate limit error (429 status or rate limit message)
 */
function isRateLimitError(error: any): boolean {
  // Check for 429 status code
  if (error.response?.status === 429 || error.status === 429) {
    return true;
  }
  
  // Check for rate limit keywords in error message
  const errorMessage = (error.message || '').toLowerCase();
  return errorMessage.includes('rate limit') || 
         errorMessage.includes('too many requests') ||
         errorMessage.includes('429');
}

/**
 * Sleep/wait until the rate limit resets
 * @param resetSeconds - Seconds until rate limit resets (relative time, not absolute timestamp)
 */
async function waitForRateLimitReset(resetSeconds: number): Promise<void> {
  // ShipStation returns reset as relative seconds from now, not absolute Unix timestamp
  // Ensure we have a proper number (header might be a string)
  const resetValue = Number(resetSeconds);
  
  if (isNaN(resetValue)) {
    log(`Invalid reset value received: ${resetSeconds}, defaulting to 60s wait`);
    await new Promise(resolve => setTimeout(resolve, 60000));
    return;
  }
  
  const waitTimeSeconds = resetValue + 3; // Add 3 second buffer
  
  // Defensive logging to catch header format shifts
  log(`Rate limit exhausted. Waiting ${waitTimeSeconds}s until reset...`);
  
  if (waitTimeSeconds > 0 && waitTimeSeconds < 300) { // Sanity check: don't wait more than 5 minutes
    await new Promise(resolve => setTimeout(resolve, waitTimeSeconds * 1000));
    log(`Rate limit reset. Resuming processing...`);
  } else if (waitTimeSeconds >= 300) {
    log(`Calculated wait time (${waitTimeSeconds}s) exceeds 5 minutes, likely a header format issue. Waiting 60s instead.`);
    await new Promise(resolve => setTimeout(resolve, 60000));
  } else {
    log(`Invalid wait time (${waitTimeSeconds}s), continuing immediately`);
  }
}


const MAX_SHIPMENT_RETRY_COUNT = 3; // Maximum retries before giving up on shipment sync

// ShipStation rate limit is 40 requests per minute window
const SHIPSTATION_RATE_LIMIT = 40;

/**
 * Result of processing a single shipment sync message
 * Used to control cleanup behavior in the main loop
 */
interface ProcessingResult {
  processed: boolean;           // Whether the message was processed (success or logged to DLQ)
  shouldRequeue: boolean;       // Whether to requeue the message (e.g., rate limit)
  requeuedMessage?: ShipmentSyncMessage; // The message to requeue (with updated retry count)
  waitForRateLimit?: number;    // Seconds to wait for rate limit reset
  breakBatch?: boolean;         // Whether to break out of batch processing
}

/**
 * Result of a single reverse sync verification
 */
interface ReverseSyncResult {
  message: ShipmentSyncMessage;
  success: boolean;
  statusChanged: boolean;
  error?: string;
  rateLimit?: { remaining: number; reset: number; limit: number };
  isRateLimited?: boolean;  // True if this request was rate limited
}

/**
 * Process a single reverse sync message (for parallel execution)
 * Returns result without side effects on rate limit waiting
 */
async function processReverseSyncMessage(message: ShipmentSyncMessage): Promise<ReverseSyncResult> {
  const { orderNumber, shipmentId } = message;
  
  if (!shipmentId) {
    return { message, success: false, statusChanged: false, error: 'Missing shipmentId' };
  }
  
  try {
    // Fetch current status from ShipStation
    const { data: shipmentData, rateLimit } = await getShipmentByShipmentId(shipmentId);
    
    // Get the DB shipment record for timestamp updates
    const dbShipment = await storage.getShipmentByShipmentId(shipmentId);
    
    if (!shipmentData) {
      // Shipment not found in ShipStation - mark as cancelled
      if (dbShipment) {
        await storage.updateShipment(dbShipment.id, {
          shipmentStatus: 'cancelled',
          reverseSyncLastCheckedAt: new Date(),
        });
        // Update lifecycle phase after status change
        await updateShipmentLifecycle(dbShipment.id, { logTransition: true });
        log(`[reverse-sync] [${shipmentId}] Not found in ShipStation - marked as cancelled`);
      }
      return { message, success: true, statusChanged: true, rateLimit };
    }
    
    const currentStatus = shipmentData.shipment_status;
    
    // If still on_hold, just update the timestamp to prevent re-enqueueing
    if (currentStatus === 'on_hold') {
      if (dbShipment) {
        await storage.updateShipment(dbShipment.id, {
          reverseSyncLastCheckedAt: new Date(),
        });
      }
      return { message, success: true, statusChanged: false, rateLimit };
    }
    
    // Status changed! Process the full update using ETL service
    log(`[reverse-sync] [${shipmentId}] Status changed: on_hold -> ${currentStatus}`);
    
    // Find the order in our database (may be null for multi-channel orders)
    const order = orderNumber ? await storage.getOrderByOrderNumber(orderNumber) : null;
    
    // Use ETL service to process the shipment with fresh data
    await shipStationShipmentETL.processShipment(shipmentData, order?.id || null);
    
    // Update the timestamp after ETL processing
    if (dbShipment) {
      await storage.updateShipment(dbShipment.id, {
        reverseSyncLastCheckedAt: new Date(),
      });
    }
    
    // Broadcast update if we have an order - status changed from on_hold
    if (order) {
      broadcastOrderUpdate(order, 'hold_released');
    }
    
    return { message, success: true, statusChanged: true, rateLimit };
    
  } catch (error: any) {
    // Check if this is a rate limit error
    const rateLimited = isRateLimitError(error);
    
    return { 
      message, 
      success: false, 
      statusChanged: false, 
      error: error.message,
      isRateLimited: rateLimited,
      // If rate limited, provide default wait time of 60 seconds
      rateLimit: rateLimited ? { remaining: 0, reset: 60, limit: 40 } : undefined
    };
  }
}

/**
 * Process reverse sync messages in parallel batches
 * Uses full rate limit quota (40 requests) per batch, then waits for reset
 */
async function processReverseSyncBatch(messages: ShipmentSyncMessage[]): Promise<number> {
  if (messages.length === 0) return 0;
  
  log(`[reverse-sync] Processing ${messages.length} messages in parallel batches of ${SHIPSTATION_RATE_LIMIT}`);
  
  let processedCount = 0;
  let messagesRemaining = [...messages];
  
  while (messagesRemaining.length > 0) {
    // Take up to SHIPSTATION_RATE_LIMIT messages for this batch
    const batchMessages = messagesRemaining.slice(0, SHIPSTATION_RATE_LIMIT);
    messagesRemaining = messagesRemaining.slice(SHIPSTATION_RATE_LIMIT);
    
    log(`[reverse-sync] Firing ${batchMessages.length} parallel API requests...`);
    
    // Fire all API requests in parallel
    const results = await Promise.allSettled(
      batchMessages.map(msg => processReverseSyncMessage(msg))
    );
    
    // Process results and collect rate limit info
    let lowestRateLimit: { remaining: number; reset: number } | null = null;
    let successCount = 0;
    let errorCount = 0;
    let statusChangedCount = 0;
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const message = batchMessages[i];
      
      if (result.status === 'fulfilled') {
        const { success, statusChanged, error, rateLimit } = result.value;
        
        if (success) {
          successCount++;
          if (statusChanged) statusChangedCount++;
        } else {
          errorCount++;
          // Log error to DLQ
          await logShipmentSyncFailure({
            orderNumber: message.orderNumber || 'unknown',
            reason: 'reverse_sync',
            errorMessage: error || 'Unknown error',
            requestData: { shipmentId: message.shipmentId, message },
            responseData: null,
            retryCount: message.retryCount || 0,
            failedAt: new Date(),
          });
        }
        
        // Track lowest rate limit remaining
        if (rateLimit && (!lowestRateLimit || rateLimit.remaining < lowestRateLimit.remaining)) {
          lowestRateLimit = { remaining: rateLimit.remaining, reset: rateLimit.reset };
        }
        
        processedCount++;
      } else {
        // Promise rejected (unexpected error)
        errorCount++;
        log(`[reverse-sync] Unexpected error for ${message.shipmentId}: ${result.reason}`);
        
        await logShipmentSyncFailure({
          orderNumber: message.orderNumber || 'unknown',
          reason: 'reverse_sync',
          errorMessage: `Promise rejected: ${result.reason}`,
          requestData: { shipmentId: message.shipmentId, message },
          responseData: null,
          retryCount: message.retryCount || 0,
          failedAt: new Date(),
        });
        
        processedCount++;
      }
      
      // Clean up in-flight tracking
      try {
        await removeShipmentSyncFromInflight(message);
      } catch (cleanupError: any) {
        log(`[WARN] Failed to remove message from in-flight set: ${cleanupError.message}`);
      }
    }
    
    log(`[reverse-sync] Batch complete: ${successCount} success (${statusChangedCount} changed), ${errorCount} errors`);
    
    // If we have more messages AND rate limit is exhausted, wait for reset
    if (messagesRemaining.length > 0 && lowestRateLimit && lowestRateLimit.remaining <= 0) {
      const waitSeconds = lowestRateLimit.reset || 60;
      log(`[reverse-sync] Rate limit exhausted. Waiting ${waitSeconds}s before next batch...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      log(`[reverse-sync] Rate limit reset. Continuing with ${messagesRemaining.length} remaining messages...`);
    }
  }
  
  return processedCount;
}

/**
 * Process a batch of shipment sync messages
 * Returns the number of successfully processed messages
 * 
 * ARCHITECTURE NOTE: Each message is processed with guaranteed in-flight cleanup.
 * The cleanup happens in the main loop's finally block, NOT inside the processing logic.
 * This ensures no code path can skip cleanup, regardless of how processing exits.
 */
export async function processShipmentSyncBatch(batchSize: number): Promise<number> {
  const messages = await dequeueShipmentSyncBatch(batchSize);
  
  if (messages.length === 0) {
    return 0;
  }

  log(`Processing ${messages.length} shipment sync message(s)`);
  
  // Debug: Log which specific messages are being processed
  const messageKeys = messages.map(m => m.orderNumber || m.trackingNumber || m.shipmentId || 'unknown');
  log(`[DEBUG] Message keys in batch: ${messageKeys.join(', ')}`);
  
  // OPTIMIZATION: Separate reverse sync messages for parallel processing
  const reverseSyncMessages = messages.filter(m => m.reason === 'reverse_sync' && m.shipmentId);
  const otherMessages = messages.filter(m => !(m.reason === 'reverse_sync' && m.shipmentId));
  
  let processedCount = 0;
  
  // Process reverse sync messages in parallel (up to 40 at a time)
  if (reverseSyncMessages.length > 0) {
    const reverseSyncProcessed = await processReverseSyncBatch(reverseSyncMessages);
    processedCount += reverseSyncProcessed;
  }
  
  // Process non-reverse-sync messages sequentially (webhooks, backfill, etc.)
  for (let i = 0; i < otherMessages.length; i++) {
    const message = otherMessages[i];
    let fastPathError: Error | null = null;
    let skipInflightCleanup = false; // Only true if we requeue (need key to stay for dedupe)
    
    try {
      const { orderNumber, trackingNumber, labelUrl, shipmentId, trackingData: webhookTrackingData, reason, jobId, webhookData } = message;
      
      // OPTIMIZATION: If this message includes inline webhookData, we can use it directly (no API call!)
      // This applies to webhooks AND polling workers that fetch data upfront
      const hasInlineData = !!webhookData;
      
      // Determine which path to use: tracking number or order number
      if (trackingNumber) {
        // PATH A: Tracking number path
        log(`Processing tracking number: ${trackingNumber}${hasInlineData ? ' (inline data)' : ''}`);
        
        // OPTIMIZATION: Check if we already have this shipment in our database
        const cachedShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        // If shipment exists AND is linked to an order, just update tracking status (skip API call)
        if (cachedShipment && cachedShipment.orderId && webhookTrackingData) {
          try {
            log(`[${trackingNumber}] Found existing shipment linked to order, updating status without API call`);
            
            // Merge latest shipmentData for processing
            const mergedShipmentData = {
              ...(cachedShipment.shipmentData || {}),
              latestTracking: webhookTrackingData,
            };
            
            // Build updated shipment record using ETL service
            const updatedRecord = shipStationShipmentETL.buildShipmentRecord(mergedShipmentData, cachedShipment.orderId);
            
            // CRITICAL: Don't downgrade delivered shipments to in_transit
            // Once delivered, always delivered (terminal status)
            const finalStatus = cachedShipment.status === 'delivered' ? 'delivered' : updatedRecord.status;
            const finalDescription = cachedShipment.status === 'delivered' 
              ? cachedShipment.statusDescription 
              : updatedRecord.statusDescription;
            
            // Build update object, preserving critical backfilled data
            const updateData: any = {
              ...updatedRecord,
              status: finalStatus,
              statusDescription: finalDescription,
              // Preserve backfilled values if ETL service couldn't extract them
              orderNumber: updatedRecord.orderNumber || cachedShipment.orderNumber,
              orderDate: updatedRecord.orderDate || cachedShipment.orderDate,
            };
            
            // Update shipment with latest tracking info from webhook
            // NOTE: Don't extract ship_to in fast path - tracking webhooks don't include it
            // and extracting empty data would overwrite existing customer columns
            await storage.updateShipment(cachedShipment.id, updateData);
            
            // Broadcast realtime update to WebSocket clients
            const order = await storage.getOrder(cachedShipment.orderId);
            if (order) {
              broadcastOrderUpdate(order, 'tracking_received');
            }
            
            log(`[${trackingNumber}] Updated shipment status for order-linked shipment (0 API calls)`);
            processedCount++;
            continue; // Success - cleanup happens in finally block
          } catch (error: any) {
            // Store fast-path error and fall through to API sync fallback
            fastPathError = error;
            log(`Fast-path failed for ${trackingNumber}, falling back to full API sync: ${error.message}`);
            // Fall through to API sync below
          }
        }
        
        // INTELLIGENT INLINE DATA PROCESSING: Skip API call if we have inline data
        if (hasInlineData && webhookData) {
          log(`[${trackingNumber}] Processing from inline data (no API call)`);
          
          // Try to extract order number from webhook data using ETL service
          const tempRecord = shipStationShipmentETL.buildShipmentRecord(webhookData, null);
          const webhookOrderNumber = tempRecord.orderNumber;
          
          if (!webhookOrderNumber) {
            // No order number in webhook - try to resolve shipment via label_id before giving up
            let resolvedShipment = null;
            
            if (labelUrl) {
              try {
                // Extract label_id from labelUrl (e.g., "https://api.shipengine.com/v1/labels/se-593961362" -> "se-593961362")
                const labelIdMatch = labelUrl.match(/\/labels\/(se-[a-zA-Z0-9_-]+)(?:\?|$)/);
                const labelId = labelIdMatch ? labelIdMatch[1] : null;
                
                if (labelId) {
                  log(`[${trackingNumber}] Attempting to resolve shipment via label_id: ${labelId}`);
                  
                  // Import getLabelByLabelId from shipstation-api
                  const { getLabelByLabelId } = await import('./utils/shipstation-api');
                  
                  // Get label data which includes shipment_id
                  const labelData = await getLabelByLabelId(labelId);
                  const resolvedShipmentId = labelData.shipment_id;
                  
                  if (resolvedShipmentId) {
                    log(`[${trackingNumber}] Got shipment_id from label API: ${resolvedShipmentId}`);
                    
                    // Look up shipment by shipment_id
                    const dbShipment = await storage.getShipmentByShipmentId(String(resolvedShipmentId));
                    
                    if (dbShipment) {
                      log(`[${trackingNumber}] Found shipment in DB via label lookup, updating tracking`);
                      
                      // Merge latest tracking data
                      const mergedData = {
                        ...(dbShipment.shipmentData || {}),
                        latestTracking: webhookData,
                      };
                      
                      // Build updated record using ETL service
                      const updatedRecord = shipStationShipmentETL.buildShipmentRecord(mergedData, dbShipment.orderId);
                      
                      // CRITICAL: Don't downgrade delivered shipments
                      const finalStatus = dbShipment.status === 'delivered' ? 'delivered' : updatedRecord.status;
                      const finalDescription = dbShipment.status === 'delivered' 
                        ? dbShipment.statusDescription 
                        : updatedRecord.statusDescription;
                      
                      // Update shipment with tracking info from webhook
                      const updateData: any = {
                        ...updatedRecord,
                        status: finalStatus,
                        statusDescription: finalDescription,
                      };
                      
                      await storage.updateShipment(dbShipment.id, updateData);
                      
                      // Broadcast realtime update if shipment is linked to order
                      if (dbShipment.orderId) {
                        const order = await storage.getOrder(dbShipment.orderId);
                        if (order) {
                          broadcastOrderUpdate(order, 'tracking_received');
                        }
                      }
                      
                      log(`[${trackingNumber}] Updated shipment via label lookup (1 API call total)`);
                      processedCount++;
                      continue; // Cleanup happens in finally block
                    } else {
                      // Shipment doesn't exist in DB yet - fetch full data from ShipStation and create it
                      log(`[${trackingNumber}] Shipment not in DB, fetching from ShipStation via shipment_id: ${resolvedShipmentId}`);
                      
                      const { fetchShipStationResource } = await import('./utils/shipstation-api');
                      
                      // Fetch shipment data using shipment_id
                      const shipmentUrl = `https://api.shipstation.com/v2/shipments/${resolvedShipmentId}`;
                      const fullShipmentData = await fetchShipStationResource(shipmentUrl);
                      
                      // Build shipment record using ETL service to extract order number and other fields
                      const tempRecord = shipStationShipmentETL.buildShipmentRecord(fullShipmentData, null);
                      const orderNumber = tempRecord.orderNumber;
                      
                      if (orderNumber) {
                        log(`[${trackingNumber}] Extracted order number from shipment: ${orderNumber}`);
                        
                        // Lookup order
                        const order = await storage.getOrderByOrderNumber(orderNumber);
                        
                        // Use ETL service to process complete shipment (creates record + items + tags)
                        const finalShipmentId = await shipStationShipmentETL.processShipment(fullShipmentData, order?.id || null);
                        
                        // Broadcast if linked to order
                        if (order) {
                          broadcastOrderUpdate(order, 'shipment_created');
                        }
                        
                        log(`[${trackingNumber}] Created shipment via label lookup (2 API calls total)`);
                        processedCount++;
                        continue; // Cleanup happens in finally block
                      } else {
                        log(`[${trackingNumber}] No order number in fetched shipment data`);
                        // Fall through to DLQ
                      }
                    }
                  }
                }
              } catch (error: any) {
                // Label lookup failed - continue to DLQ
                log(`[${trackingNumber}] Label lookup failed: ${error.message}`);
              }
            }
            
            // Could not resolve via label lookup - log to DLQ for manual review
            await logShipmentSyncFailure({
              orderNumber: trackingNumber, // Use tracking number as identifier
              reason,
              errorMessage: 'Tracking webhook has no order number and label lookup failed',
              requestData: {
                queueMessage: message,
                trackingNumber,
                labelUrl,
                shipmentId,
              },
              responseData: webhookData,
              retryCount: 0,
              failedAt: new Date(),
            });
            log(`[${trackingNumber}] Logged to DLQ: no order number in webhook data and label lookup failed`);
            processedCount++;
            continue; // Cleanup happens in finally block
          }
          
          // We have an order number - lookup order and create/update shipment
          const order = await storage.getOrderByOrderNumber(webhookOrderNumber);
          
          // Validate shipment ID
          const rawShipmentId = webhookData.shipment_id || webhookData.shipmentId || shipmentId;
          if (!rawShipmentId) {
            await logShipmentSyncFailure({
              orderNumber: webhookOrderNumber,
              reason,
              errorMessage: 'Webhook shipment data missing shipment_id field',
              requestData: { queueMessage: message },
              responseData: webhookData,
              retryCount: 0,
              failedAt: new Date(),
            });
            processedCount++;
            continue; // Cleanup happens in finally block
          }
          
          // Use ETL service to process complete shipment (creates/updates record + items + tags)
          const finalShipmentId = await shipStationShipmentETL.processShipment(webhookData, order?.id || null);
          
          if (cachedShipment) {
            log(`[${trackingNumber}] Updated shipment from webhook (0 API calls)`);
          } else {
            log(`[${trackingNumber}] Created shipment from webhook (0 API calls)`);
          }
          
          // Broadcast update - use 'shipment_created' for new shipments, 'shipment_synced' for updates
          if (order) {
            broadcastOrderUpdate(order, cachedShipment ? 'shipment_synced' : 'shipment_created');
          }
          
          processedCount++;
          continue; // Success - skip API call!
        }
        
        // FALLBACK: Proceed with API call (for backfill, manual sync, or webhook without inline data)
        log(`[${trackingNumber}] ${cachedShipment ? 'Shipment exists but not linked to order' : 'New shipment'}, calling ShipStation API`);
        
        const trackingData: TrackingData = {
          tracking_number: trackingNumber,
          label_url: labelUrl,
          shipment_id: shipmentId,
        };
        
        const linkageResult = await linkTrackingToOrder(trackingData, storage);
        
        // Check rate limit AFTER API call and break if exhausted
        if (linkageResult.rateLimit) {
          const { remaining, reset, limit } = linkageResult.rateLimit;
          log(`[${trackingNumber}] API call made, ${remaining}/${limit} calls remaining`);
          
          // If we're out of quota, break out of batch processing
          // The worker will wait before the next batch cycle
          if (remaining <= 0) {
            log(`Rate limit exhausted after processing ${processedCount + 1} message(s). Breaking batch to wait for reset.`);
            processedCount++; // Count this message as processed
            await waitForRateLimitReset(reset);
            break; // Exit the batch loop - remaining messages will be processed in next cycle
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
              log(`[${trackingNumber}] Skipping shipment with missing ID`);
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
              continue;
            }
            
            // Create shipment without order linkage (orderId will be null)
            const existingShipmentOrphan = await storage.getShipmentByTrackingNumber(trackingNumber);
            
            // Use ETL service to process complete shipment (creates/updates record + items + tags)
            const finalShipmentId = await shipStationShipmentETL.processShipment(shipmentData, null);
            
            if (existingShipmentOrphan) {
              log(`[${trackingNumber}] Updated shipment without order linkage`);
            } else {
              log(`[${trackingNumber}] Created shipment without order linkage`);
            }
            
            // Fire-and-forget: Trigger Shopify order sync if we found an order number
            if (linkageResult.orderNumber) {
              log(`Triggering fire-and-forget Shopify order sync for ${linkageResult.orderNumber}`);
              const shopifyMessage: ShopifyOrderSyncMessage = {
                orderNumber: linkageResult.orderNumber,
                reason: 'shipment-webhook',
                enqueuedAt: Date.now(),
                triggeringShipmentTracking: trackingNumber,
              };
              await enqueueShopifyOrderSync(shopifyMessage);
            }
            
            processedCount++;
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
          continue;
        }
        
        // Successfully linked - create/update shipment
        const order = linkageResult.order;
        const shipmentData = linkageResult.shipmentData;
        
        // Validate shipment ID exists to prevent corrupting DB with "undefined" string
        const rawShipmentId = shipmentData.shipment_id || shipmentData.shipmentId;
        if (!rawShipmentId) {
          log(`[${trackingNumber}] Skipping shipment with missing ID for order ${order.orderNumber}`);
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
          continue;
        }
        
        const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        // Use ETL service to process complete shipment (creates/updates record + items + tags)
        const finalShipmentId = await shipStationShipmentETL.processShipment(shipmentData, order.id);
        
        if (existingShipment) {
          log(`[${trackingNumber}] Updated shipment for order ${order.orderNumber}`);
        } else {
          log(`[${trackingNumber}] Created shipment for order ${order.orderNumber}`);
        }
        
        // Broadcast order update via WebSocket
        broadcastOrderUpdate(order, existingShipment ? 'shipment_synced' : 'shipment_created');
        
        processedCount++;
        
      } else if (orderNumber) {
        // PATH B: Order number path
        log(`Processing order number: ${orderNumber}${shipmentId ? ` (shipmentId: ${shipmentId})` : ''}${hasInlineData ? ' (inline data)' : ''}`);
        
        // INTELLIGENT INLINE DATA PROCESSING: Skip API call if we have inline data
        if (hasInlineData && webhookData) {
          log(`[${orderNumber}] Processing from inline data (no API call)`);
          
          // Validate shipment ID
          const rawShipmentId = webhookData.shipment_id || webhookData.shipmentId || shipmentId;
          if (!rawShipmentId) {
            await logShipmentSyncFailure({
              orderNumber,
              reason,
              errorMessage: 'Webhook shipment data missing shipment_id field',
              requestData: { queueMessage: message },
              responseData: webhookData,
              retryCount: 0,
              failedAt: new Date(),
            });
            processedCount++;
            continue;
          }
          
          const shipmentTrackingNumber = webhookData.tracking_number || webhookData.trackingNumber || trackingNumber || null;
          
          // Find order (may be null for multi-channel)
          const order = await storage.getOrderByOrderNumber(orderNumber);
          
          // Check if shipment exists
          const existingShipment = shipmentTrackingNumber 
            ? await storage.getShipmentByTrackingNumber(shipmentTrackingNumber)
            : await storage.getShipmentByShipmentId(String(rawShipmentId));
          
          // Use ETL service to process complete shipment (creates/updates record + items + tags)
          // DEBUG: Log the webhookData shipment_id and order_number before ETL
          const webhookShipmentId = webhookData.shipment_id || webhookData.shipmentId;
          const webhookOrderNum = webhookData.shipment_number || webhookData.order_number || webhookData.orderNumber;
          log(`[${orderNumber}] [DEBUG] webhookData has shipment_id=${webhookShipmentId}, order_number=${webhookOrderNum}`);
          
          const finalShipmentId = await shipStationShipmentETL.processShipment(webhookData, order?.id || null);
          
          if (existingShipment) {
            log(`[${orderNumber}] Updated shipment from webhook (0 API calls)`);
          } else {
            log(`[${orderNumber}] Created shipment from webhook (0 API calls)`);
          }
          
          // Broadcast update - use 'shipment_created' for new shipments, 'shipment_synced' for updates
          if (order) {
            broadcastOrderUpdate(order, existingShipment ? 'shipment_synced' : 'shipment_created');
          }
          
          processedCount++;
          continue; // Success - skip API call!
        }
        
        // FALLBACK: Fetch shipments from ShipStation API (for backfill, manual sync, or webhook without inline data)
        log(`[${orderNumber}] Calling ShipStation API to fetch shipments`);
        const { data: shipments, rateLimit } = await getShipmentsByOrderNumber(orderNumber);
        
        log(`[${orderNumber}] ${shipments.length} shipment(s) found, ${rateLimit.remaining}/${rateLimit.limit} API calls remaining`);
        
        // Handle 0 shipments found scenario
        if (shipments.length === 0) {
          // Check if this came from a Shopify webhook (order updated but not shipped yet)
          const isShopifyWebhook = message.reason === 'webhook' && 
                                    message.originalWebhook?.source === 'shopify';
          
          if (isShopifyWebhook) {
            // This is expected - Shopify order updated but hasn't shipped yet
            // Log quietly and continue (no DLQ entry)
            log(`[${orderNumber}] Order not shipped yet (Shopify webhook-triggered check, 0 shipments found)`);
            processedCount++;
            continue;
          }
          
          // For other contexts (backfill, manual sync), log to DLQ for investigation
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
          log(`Logged to failures: 0 shipments found for ${orderNumber} (rate limit: ${rateLimit.remaining}/${rateLimit.limit})`);
          processedCount++;
          continue;
        }
        
        // If shipmentId is provided, filter to only that specific shipment
        // This prevents duplicate processing when multiple shipments share the same order number
        let shipmentsToProcess = shipments;
        let targetShipmentNotFound = false;
        
        if (shipmentId) {
          const matchingShipment = shipments.find((s: any) => {
            const sid = s.shipment_id || s.shipmentId;
            return sid && String(sid) === shipmentId;
          });
          
          if (matchingShipment) {
            shipmentsToProcess = [matchingShipment];
            log(`[${orderNumber}] Filtered to specific shipment ${shipmentId}`);
          } else {
            // Target shipment not in API response - likely propagation delay
            // Requeue the message instead of removing from inflight
            targetShipmentNotFound = true;
            log(`[${orderNumber}] Target shipment ${shipmentId} not found in API response (${shipments.length} shipment(s) returned)`);
            
            // Remove from inflight BEFORE requeueing to avoid dedupe blocking
            await removeShipmentSyncFromInflight(message);
            skipInflightCleanup = true;
            
            // Requeue with backoff (increment retry count)
            const retryCount = (message.retryCount || 0) + 1;
            const maxRetries = 5;
            
            if (retryCount <= maxRetries) {
              const requeuedMessage = { ...message, retryCount };
              await enqueueShipmentSync(requeuedMessage);
              log(`[${orderNumber}] Requeued message for shipment ${shipmentId} (retry ${retryCount}/${maxRetries})`);
            } else {
              // Max retries exceeded, log to DLQ
              await logShipmentSyncFailure({
                orderNumber,
                reason: message.reason,
                errorMessage: `Target shipment ${shipmentId} not found after ${maxRetries} retries`,
                requestData: {
                  queueMessage: message,
                  searchedOrderNumber: orderNumber,
                  targetShipmentId: shipmentId,
                },
                responseData: {
                  shipmentsReturned: shipments.length,
                  shipmentIds: shipments.map((s: any) => s.shipment_id || s.shipmentId),
                },
                retryCount,
                failedAt: new Date(),
              });
              log(`[${orderNumber}] Max retries exceeded for shipment ${shipmentId}, logged to DLQ`);
            }
            
            // Skip processing for this message (will be retried or moved to DLQ)
            processedCount++;
            continue;
          }
        }
        
        // Find the order in our database (may be null for multi-channel orders)
        const order = await storage.getOrderByOrderNumber(orderNumber);
        
        // CRITICAL: Save shipments to database BEFORE checking rate limit
        // This ensures we don't waste API calls by fetching data then discarding it
        for (const shipmentData of shipmentsToProcess) {
          // ShipStation V2 API returns snake_case fields, handle both formats
          const data = shipmentData as any;
          
          // Validate shipment ID exists to prevent corrupting DB with "undefined" string
          const rawShipmentId = data.shipment_id || data.shipmentId;
          if (!rawShipmentId) {
            log(`[${orderNumber}] Skipping shipment with missing ID: ${JSON.stringify(data)}`);
            continue;
          }
          
          const shipmentId = String(rawShipmentId);
          const trackingNumber = data.tracking_number || data.trackingNumber || null;
          const carrierCode = data.carrier_code || data.carrierCode || null;
          const serviceCode = data.service_code || data.serviceCode || null;
          const shipDate = data.ship_date || data.shipDate;
          const voided = data.voided || false;
          
          const existingShipment = await storage.getShipmentByShipmentId(shipmentId);
          
          // Use ETL service to process complete shipment (creates/updates record + items + tags)
          const finalShipmentId = await shipStationShipmentETL.processShipment(shipmentData, order?.id || null);

          if (existingShipment) {
            log(`[${orderNumber}] Updated shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          } else {
            log(`[${orderNumber}] Created shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          }
        }
        
        // Fire-and-forget: Trigger Shopify order sync if order not found
        if (!order) {
          log(`Triggering fire-and-forget Shopify order sync for ${orderNumber}`);
          const shopifyMessage: ShopifyOrderSyncMessage = {
            orderNumber,
            reason: 'shipment-webhook',
            enqueuedAt: Date.now(),
          };
          await enqueueShopifyOrderSync(shopifyMessage);
        }

        // Broadcast order update via WebSocket (if order exists)
        if (order) {
          broadcastOrderUpdate(order, 'shipment_synced');
        }
        
        processedCount++;
        
        // Check rate limit AFTER saving data and wait if exhausted
        if (rateLimit.remaining <= 0) {
          await waitForRateLimitReset(rateLimit.reset);
        }
        
      } else {
        // Invalid message - neither tracking number nor order number
        log(`Invalid message: missing both orderNumber and trackingNumber`);
        processedCount++;
        continue;
      }
      
      // Add small delay between requests to be respectful to API
      if (processedCount < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error: any) {
      // Combine fast-path and API fallback errors if both failed
      const trackingId = message.orderNumber || message.trackingNumber || 'unknown';
      
      // Check if this is a rate limit error - if so, requeue and wait
      if (isRateLimitError(error)) {
        log(`Rate limit error for ${trackingId}, attempting to requeue message`);
        
        try {
          // CRITICAL: Remove from in-flight BEFORE requeueing to avoid dedupe blocking
          await removeShipmentSyncFromInflight(message);
          skipInflightCleanup = true;
          
          // Now requeue the message so it's not lost
          const enqueued = await enqueueShipmentSync(message);
          
          if (!enqueued) {
            // Enqueue returned false - message is already in queue/inflight elsewhere
            // This is a race condition: we removed from inflight but another process enqueued it
            // Log to DLQ as safety net to prevent message loss
            log(`Failed to requeue ${trackingId}: already in queue, logging to DLQ as safety net`);
            
            await logShipmentSyncFailure({
              orderNumber: trackingId,
              reason: message.reason,
              errorMessage: `Rate limit error + requeue blocked by dedupe (possible race condition)`,
              requestData: {
                queueMessage: message,
                originalWebhook: message.originalWebhook || null,
                errors: {
                  rateLimitError: {
                    message: error.message || 'Unknown rate limit error',
                    stack: error.stack || null,
                  },
                },
              },
              responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
              retryCount: 0,
              failedAt: new Date(),
            });
            
            processedCount++;
          } else {
            // Successfully requeued
            log(`Message ${trackingId} requeued successfully`);
            
            // Extract reset time from error headers if available
            const resetSeconds = error.response?.headers?.['x-rate-limit-reset'] || 60;
            
            // Wait for rate limit to reset before continuing with next message
            await waitForRateLimitReset(resetSeconds);
            
            log(`Rate limit reset complete, continuing batch processing`);
            // Don't increment processedCount - message will be reprocessed later
          }
        } catch (requeueError: any) {
          // If requeueing infrastructure fails, log to dead letter queue as fallback
          log(`Failed to requeue ${trackingId}: ${requeueError.message}, logging to DLQ`);
          
          await logShipmentSyncFailure({
            orderNumber: trackingId,
            reason: message.reason,
            errorMessage: `Rate limit error + requeue failed: ${requeueError.message}`,
            requestData: {
              queueMessage: message,
              originalWebhook: message.originalWebhook || null,
              errors: {
                rateLimitError: {
                  message: error.message || 'Unknown rate limit error',
                  stack: error.stack || null,
                },
                requeueError: {
                  message: requeueError.message,
                  stack: requeueError.stack || null,
                }
              },
            },
            responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
            retryCount: 0,
            failedAt: new Date(),
          });
          
          processedCount++;
        }
      } else {
        // Non-rate-limit error: log to dead letter queue
        
        // Build structured error data
        const errorData: any = {
          apiError: {
            message: error.message || 'Unknown error',
            stack: error.stack || null,
          }
        };
        
        // If fast-path failed before API sync, include both errors
        if (fastPathError) {
          errorData.fastPathError = {
            message: fastPathError.message,
            stack: fastPathError.stack || null,
          };
        }
        
        // Create combined error message for logs
        const errorMessage = fastPathError 
          ? `Fast-path failed: ${fastPathError.message}; API fallback failed: ${error.message}`
          : error.message || 'Unknown error';
        
        // Log failure to dead letter queue with structured errors
        await logShipmentSyncFailure({
          orderNumber: trackingId,
          reason: message.reason,
          errorMessage,
          requestData: {
            queueMessage: message,
            originalWebhook: message.originalWebhook || null,
            errors: errorData, // Structured error objects with stacks
          },
          responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
          retryCount: 0,
          failedAt: new Date(),
        });
        
        log(`Failed to sync shipments for ${trackingId}: ${errorMessage}`);
        processedCount++;
      }
    } finally {
      // CRITICAL: This is the single cleanup point for all message processing paths.
      // Only skip cleanup when we've explicitly requeued the message (skipInflightCleanup = true).
      // The finally block ALWAYS runs after try/catch, including after `continue` statements.
      if (!skipInflightCleanup) {
        try {
          await removeShipmentSyncFromInflight(message);
        } catch (cleanupError: any) {
          // Log but don't throw - cleanup failure shouldn't crash the worker
          log(`[WARN] Failed to remove message from in-flight set: ${cleanupError.message}`);
        }
      }
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
export async function startShipmentSyncWorker(intervalMs: number = 10000): Promise<NodeJS.Timeout> {
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
  
  // CRITICAL: Clear stale in-flight entries from previous/crashed runs
  // This prevents shipments from being permanently blocked in deduplication
  try {
    const clearedCount = await clearShipmentSyncInflight();
    if (clearedCount > 0) {
      log(`Cleared ${clearedCount} stale in-flight entries from previous runs`);
    }
  } catch (error: any) {
    log(`[WARN] Failed to clear in-flight entries on startup: ${error.message}`);
  }
  
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
      // Use withRetrySafe for database operations to handle transient connection issues
      const shopifyQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const shopifyOrderSyncQueueLength = await getShopifyOrderSyncQueueLength();
      const failureCount = await withRetrySafe(() => storage.getShipmentSyncFailureCount(), {}, 0) ?? 0;
      const oldestShopify = await getOldestShopifyQueueMessage();
      const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
      const oldestShopifyOrderSync = await getOldestShopifyOrderSyncQueueMessage();
      
      // Get active backfill job (with retry)
      const allBackfillJobs = await withRetrySafe(() => storage.getAllBackfillJobs(), {}, []) ?? [];
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
      
      // Get comprehensive data health metrics (with retry)
      const dataHealth = await withRetrySafe(() => storage.getDataHealthMetrics()) ?? undefined;
      // Pipeline metrics for operations dashboard (with retry)
      const pipeline = await withRetrySafe(() => storage.getPipelineMetrics()) ?? undefined;
      
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
        pipeline,
      });
    } catch (error) {
      // Log but don't crash on transient errors - worker will retry on next interval
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
