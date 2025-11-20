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
import { 
  extractOrderNumber,
  extractShipToFields,
  extractReturnGiftFields,
  extractTotalWeight,
  extractAdvancedOptions,
} from './utils/shipment-extraction';
import { 
  shipmentSyncFailures, 
  shipmentItems, 
  shipmentTags, 
  orderItems,
  type InsertShipmentSyncFailure 
} from '@shared/schema';
import { broadcastOrderUpdate, broadcastQueueStatus } from './websocket';
import { eq, inArray } from 'drizzle-orm';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shipment-sync] ${message}`);
}

/**
 * Normalize ShipStation status codes to our internal status values
 * - DE (Delivered) → "delivered"
 * - Any other tracking code → "in_transit"
 * - Voided → "cancelled"
 * - Default → "shipped"
 */
function normalizeShipmentStatus(shipmentData: any): { status: string; statusDescription: string } {
  // Check if shipment is voided first
  if (shipmentData.voided) {
    return { status: 'cancelled', statusDescription: 'Shipment voided' };
  }
  
  // Check for tracking status code (from tracking webhooks)
  const statusCode = shipmentData.status_code || shipmentData.statusCode;
  if (statusCode) {
    if (statusCode === 'DE') {
      return {
        status: 'delivered',
        statusDescription: shipmentData.status_description || shipmentData.statusDescription || 'Delivered'
      };
    }
    return {
      status: 'in_transit',
      statusDescription: shipmentData.status_description || shipmentData.statusDescription || 'In transit'
    };
  }
  
  // Default for newly created shipments without tracking updates
  return { status: 'shipped', statusDescription: 'Shipment created' };
}

/**
 * Populate normalized shipment_items and shipment_tags tables from shipmentData JSONB
 * Deletes existing entries and re-creates from current shipmentData to ensure consistency
 */
async function populateShipmentItemsAndTags(shipmentId: string, shipmentData: any) {
  if (!shipmentData) return;

  try {
    // Delete existing entries for this shipment (ensure clean state)
    await db.delete(shipmentItems).where(eq(shipmentItems.shipmentId, shipmentId));
    await db.delete(shipmentTags).where(eq(shipmentTags.shipmentId, shipmentId));

    // Extract and insert items
    if (shipmentData.items && Array.isArray(shipmentData.items)) {
      // Batch fetch all order items to avoid N+1 queries
      // Normalize to strings since ShipStation may return numeric IDs
      const externalOrderItemIds = shipmentData.items
        .map((item: any) => item.external_order_item_id)
        .filter((id: any) => id != null)
        .map((id: any) => String(id));

      const orderItemsMap = new Map<string, string>();
      if (externalOrderItemIds.length > 0) {
        const matchingOrderItems = await db
          .select()
          .from(orderItems)
          .where(inArray(orderItems.shopifyLineItemId, externalOrderItemIds));

        for (const orderItem of matchingOrderItems) {
          // Normalize both sides to string for comparison
          orderItemsMap.set(String(orderItem.shopifyLineItemId), orderItem.id);
        }
      }

      // Build items to insert with batch-resolved order item IDs
      const itemsToInsert = shipmentData.items.map((item: any) => {
        // Normalize to string before lookup
        const externalId = item.external_order_item_id ? String(item.external_order_item_id) : null;
        const orderItemId = externalId ? (orderItemsMap.get(externalId) || null) : null;

        return {
          shipmentId,
          orderItemId,
          sku: item.sku || null,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unit_price?.toString() || null,
          externalOrderItemId: externalId, // Store as string
          imageUrl: item.image_url || null,
        };
      });

      if (itemsToInsert.length > 0) {
        await db.insert(shipmentItems).values(itemsToInsert);
      }
    }

    // Extract and insert tags
    if (shipmentData.tags && Array.isArray(shipmentData.tags)) {
      const tagsToInsert = shipmentData.tags.map((tag: any) => ({
        shipmentId,
        name: tag.name,
        color: tag.color || null,
        tagId: tag.tag_id || null,
      }));

      if (tagsToInsert.length > 0) {
        await db.insert(shipmentTags).values(tagsToInsert);
      }
    }
  } catch (error) {
    log(`⚠️  Error populating shipment items/tags for ${shipmentId}: ${error instanceof Error ? error.message : String(error)}`);
    // Don't throw - this is a non-critical operation that shouldn't break the main flow
  }
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
    let fastPathError: Error | null = null;
    
    try {
      const { orderNumber, trackingNumber, labelUrl, shipmentId, trackingData: webhookTrackingData, reason, jobId } = message;
      
      // Determine which path to use: tracking number or order number
      if (trackingNumber) {
        // PATH A: Tracking number path
        log(`Processing tracking number: ${trackingNumber}`);
        
        // OPTIMIZATION: Check if we already have this shipment in our database
        const cachedShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        // If shipment exists AND is linked to an order, just update tracking status (skip API call)
        if (cachedShipment && cachedShipment.orderId && webhookTrackingData) {
          try {
            log(`[${trackingNumber}] ⚡ Found existing shipment linked to order, updating status without API call`);
            
            // Normalize status using helper
            const { status, statusDescription } = normalizeShipmentStatus(webhookTrackingData);
            
            // CRITICAL: Don't downgrade delivered shipments to in_transit
            // Once delivered, always delivered (terminal status)
            const finalStatus = cachedShipment.status === 'delivered' ? 'delivered' : status;
            const finalDescription = cachedShipment.status === 'delivered' 
              ? cachedShipment.statusDescription 
              : statusDescription;
            
            // Merge latest shipmentData for extraction
            const mergedShipmentData = {
              ...(cachedShipment.shipmentData || {}),
              latestTracking: webhookTrackingData,
            };
            
            // Extract order_number with multiple fallbacks:
            // 1. From merged shipmentData (includes tracking webhook + cached data)
            // 2. Directly from cached shipmentData JSONB (in case field was missed)
            // 3. From cached order_number column (backfilled or previously extracted)
            const extractedOrderNumber = 
              extractOrderNumber(mergedShipmentData) || 
              cachedShipment.shipmentData?.shipment_number || 
              cachedShipment.shipmentData?.shipmentNumber ||
              cachedShipment.orderNumber;
            
            // Build update object
            const updateData: any = {
              status: finalStatus,
              statusDescription: finalDescription,
              shipDate: webhookTrackingData.ship_date ? new Date(webhookTrackingData.ship_date) : cachedShipment.shipDate,
              shipmentData: mergedShipmentData,
            };
            
            // Always explicitly set order_number (extracted, cached, or preserve existing)
            // This ensures backfilled values are maintained even if webhook lacks shipment_number
            if (extractedOrderNumber) {
              updateData.orderNumber = extractedOrderNumber;
            }
            
            // Update shipment with latest tracking info from webhook
            // NOTE: Don't extract ship_to in fast path - tracking webhooks don't include it
            // and extracting empty data would overwrite existing customer columns
            await storage.updateShipment(cachedShipment.id, updateData);
            
            // Broadcast realtime update to WebSocket clients
            const order = await storage.getOrder(cachedShipment.orderId);
            if (order) {
              broadcastOrderUpdate(order);
            }
            
            log(`[${trackingNumber}] ✓ Updated shipment status for order-linked shipment (0 API calls)`);
            processedCount++;
            continue; // Success - skip to next message without API call
          } catch (error: any) {
            // Store fast-path error and fall through to API sync fallback
            fastPathError = error;
            log(`⚠️  Fast-path failed for ${trackingNumber}, falling back to full API sync: ${error.message}`);
            // Fall through to API sync below
          }
        }
        
        // Proceed with API call (either because shipment doesn't exist, isn't linked, or fast-path failed)
        log(`[${trackingNumber}] ${cachedShipment ? 'Shipment exists but not linked to order' : 'New shipment'}, calling ShipStation API`);
        
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
            const existingShipmentOrphan = await storage.getShipmentByTrackingNumber(trackingNumber);
            
            // Normalize status using helper
            const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
            
            const shipmentRecord = {
              orderId: null, // No order linkage
              shipmentId: String(rawShipmentId),
              orderNumber: extractOrderNumber(shipmentData),
              trackingNumber: trackingNumber,
              carrierCode: shipmentData.carrier_code || shipmentData.carrierCode || null,
              serviceCode: shipmentData.service_code || shipmentData.serviceCode || null,
              status,
              statusDescription,
              shipDate: shipmentData.ship_date ? new Date(shipmentData.ship_date) : null,
              ...extractShipToFields(shipmentData), // Extract ship_to customer data
              ...extractReturnGiftFields(shipmentData), // Extract return and gift data
              totalWeight: extractTotalWeight(shipmentData), // Extract total weight
              ...extractAdvancedOptions(shipmentData), // Extract all advanced_options fields
              shipmentData: shipmentData,
            };
            
            let finalShipmentId: string;
            if (existingShipmentOrphan) {
              await storage.updateShipment(existingShipmentOrphan.id, shipmentRecord);
              finalShipmentId = existingShipmentOrphan.id;
              log(`[${trackingNumber}] Updated shipment without order linkage`);
            } else {
              const createdShipment = await storage.createShipment(shipmentRecord);
              finalShipmentId = createdShipment.id;
              log(`[${trackingNumber}] Created shipment without order linkage`);
            }
            
            // Populate normalized shipment items and tags tables
            await populateShipmentItemsAndTags(finalShipmentId, shipmentData);
            
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
        
        // Normalize status using helper
        const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
        
        const shipmentRecord = {
          orderId: order.id,
          shipmentId: String(rawShipmentId),
          orderNumber: extractOrderNumber(shipmentData),
          trackingNumber: trackingNumber,
          carrierCode: shipmentData.carrier_code || shipmentData.carrierCode || null,
          serviceCode: shipmentData.service_code || shipmentData.serviceCode || null,
          status,
          statusDescription,
          shipDate: shipmentData.ship_date ? new Date(shipmentData.ship_date) : null,
          ...extractShipToFields(shipmentData), // Extract ship_to customer data
          ...extractReturnGiftFields(shipmentData), // Extract return and gift data
          totalWeight: extractTotalWeight(shipmentData), // Extract total weight
          ...extractAdvancedOptions(shipmentData), // Extract all advanced_options fields
          shipmentData: shipmentData,
        };
        
        let finalShipmentId: string;
        if (existingShipment) {
          await storage.updateShipment(existingShipment.id, shipmentRecord);
          finalShipmentId = existingShipment.id;
          log(`[${trackingNumber}] Updated shipment for order ${order.orderNumber}`);
        } else {
          const createdShipment = await storage.createShipment(shipmentRecord);
          finalShipmentId = createdShipment.id;
          log(`[${trackingNumber}] Created shipment for order ${order.orderNumber}`);
        }
        
        // Populate normalized shipment items and tags tables
        await populateShipmentItemsAndTags(finalShipmentId, shipmentData);
        
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
          
          // Normalize status using helper
          const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
          
          const shipmentRecord = {
            orderId: order?.id || null, // Nullable order linkage
            shipmentId: shipmentId,
            orderNumber: extractOrderNumber(shipmentData),
            trackingNumber: trackingNumber,
            carrierCode: carrierCode,
            serviceCode: serviceCode,
            status,
            statusDescription,
            shipDate: shipDate ? new Date(shipDate) : null,
            ...extractShipToFields(shipmentData), // Extract ship_to customer data
            ...extractReturnGiftFields(shipmentData), // Extract return and gift data
            totalWeight: extractTotalWeight(shipmentData), // Extract total weight
            ...extractAdvancedOptions(shipmentData), // Extract all advanced_options fields
            shipmentData: shipmentData,
          };

          let finalShipmentId: string;
          if (existingShipment) {
            await storage.updateShipment(existingShipment.id, shipmentRecord);
            finalShipmentId = existingShipment.id;
            log(`[${orderNumber}] Updated shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          } else {
            const createdShipment = await storage.createShipment(shipmentRecord);
            finalShipmentId = createdShipment.id;
            log(`[${orderNumber}] Created shipment ${shipmentId}${order ? ` for order ${order.orderNumber}` : ' (no order linkage)'}`);
          }
          
          // Populate normalized shipment items and tags tables
          await populateShipmentItemsAndTags(finalShipmentId, shipmentData);
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
      // Combine fast-path and API fallback errors if both failed
      const trackingId = message.orderNumber || message.trackingNumber || 'unknown';
      
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
      
      log(`❌ Failed to sync shipments for ${trackingId}: ${errorMessage}`);
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
