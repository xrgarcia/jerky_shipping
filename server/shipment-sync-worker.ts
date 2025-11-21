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
  enqueueShopifyOrderSync,
  enqueueShipmentSync,
  removeShipmentSyncFromInflight,
  type ShipmentSyncMessage,
  type ShopifyOrderSyncMessage,
} from './utils/queue';
import { getShipmentsByOrderNumber } from './utils/shipstation-api';
import { linkTrackingToOrder, type TrackingData } from './utils/shipment-linkage';
import { 
  extractOrderNumber,
  extractOrderDate,
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

/**
 * Extract ShipStation shipment_status field
 * Returns the raw shipment lifecycle status from ShipStation (on_hold, pending, shipped, cancelled, etc.)
 * Searches common nesting patterns as ShipStation API varies payload structure
 */
export function extractShipmentStatus(shipmentData: any): string | null {
  if (!shipmentData) return null;
  
  // Check top-level fields first
  if (shipmentData.shipment_status) return shipmentData.shipment_status;
  if (shipmentData.shipmentStatus) return shipmentData.shipmentStatus;
  
  // Check top-level advancedOptions (recent API versions, both camelCase and snake_case)
  if (shipmentData.advancedOptions?.shipmentStatus) {
    return shipmentData.advancedOptions.shipmentStatus;
  }
  if (shipmentData.advancedOptions?.shipment_status) {
    return shipmentData.advancedOptions.shipment_status;
  }
  if (shipmentData.advanced_options?.shipment_status) {
    return shipmentData.advanced_options.shipment_status;
  }
  if (shipmentData.advanced_options?.shipmentStatus) {
    return shipmentData.advanced_options.shipmentStatus;
  }
  
  // Check nested shipment object (common in webhook payloads)
  if (shipmentData.shipment) {
    if (shipmentData.shipment.shipment_status) return shipmentData.shipment.shipment_status;
    if (shipmentData.shipment.shipmentStatus) return shipmentData.shipment.shipmentStatus;
    
    // Check advancedOptions within nested shipment
    if (shipmentData.shipment.advancedOptions?.shipmentStatus) {
      return shipmentData.shipment.advancedOptions.shipmentStatus;
    }
    if (shipmentData.shipment.advancedOptions?.shipment_status) {
      return shipmentData.shipment.advancedOptions.shipment_status;
    }
    if (shipmentData.shipment.advanced_options?.shipment_status) {
      return shipmentData.shipment.advanced_options.shipment_status;
    }
    if (shipmentData.shipment.advanced_options?.shipmentStatus) {
      return shipmentData.shipment.advanced_options.shipmentStatus;
    }
    
    // Check double-nested shipment.shipment (some webhook variants)
    if (shipmentData.shipment.shipment) {
      if (shipmentData.shipment.shipment.shipment_status) return shipmentData.shipment.shipment.shipment_status;
      if (shipmentData.shipment.shipment.shipmentStatus) return shipmentData.shipment.shipment.shipmentStatus;
      
      // Check advancedOptions within double-nested shipment
      if (shipmentData.shipment.shipment.advancedOptions?.shipmentStatus) {
        return shipmentData.shipment.shipment.advancedOptions.shipmentStatus;
      }
      if (shipmentData.shipment.shipment.advancedOptions?.shipment_status) {
        return shipmentData.shipment.shipment.advancedOptions.shipment_status;
      }
      if (shipmentData.shipment.shipment.advanced_options?.shipment_status) {
        return shipmentData.shipment.shipment.advanced_options.shipment_status;
      }
      if (shipmentData.shipment.shipment.advanced_options?.shipmentStatus) {
        return shipmentData.shipment.shipment.advanced_options.shipmentStatus;
      }
    }
  }
  
  return null;
}

/**
 * Normalize ShipStation status codes to our internal status values
 * - Voided → "cancelled"
 * - DE (Delivered tracking code) → "delivered"
 * - Any other tracking code → "in_transit"
 * - on_hold shipment_status → "pending"
 * - Default → "shipped"
 */
function normalizeShipmentStatus(shipmentData: any): { status: string; statusDescription: string } {
  // Check if shipment is voided first
  if (shipmentData.voided) {
    return { status: 'cancelled', statusDescription: 'Shipment voided' };
  }
  
  // Check for tracking status code (from tracking webhooks) - highest priority
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
  
  // Check for ShipStation shipment_status (from API queries)
  const shipmentStatus = extractShipmentStatus(shipmentData);
  if (shipmentStatus === 'on_hold') {
    return { status: 'pending', statusDescription: 'On hold - awaiting warehouse processing' };
  }
  if (shipmentStatus === 'cancelled') {
    return { status: 'cancelled', statusDescription: 'Shipment cancelled' };
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
    log(`Error populating shipment items/tags for ${shipmentId}: ${error instanceof Error ? error.message : String(error)}`);
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
  
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    let fastPathError: Error | null = null;
    let removedFromInflight = false; // Track if we already removed from in-flight
    
    try {
      const { orderNumber, trackingNumber, labelUrl, shipmentId, trackingData: webhookTrackingData, reason, jobId, webhookData } = message;
      
      // OPTIMIZATION: If this message came from a webhook and includes inline data, use it directly (no API call!)
      const isWebhookMessage = reason === 'webhook_tracking' || reason === 'webhook_fulfillment';
      
      // Determine which path to use: tracking number or order number
      if (trackingNumber) {
        // PATH A: Tracking number path
        log(`Processing tracking number: ${trackingNumber}${isWebhookMessage ? ' (webhook)' : ''}`);
        
        // OPTIMIZATION: Check if we already have this shipment in our database
        const cachedShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        // If shipment exists AND is linked to an order, just update tracking status (skip API call)
        if (cachedShipment && cachedShipment.orderId && webhookTrackingData) {
          try {
            log(`[${trackingNumber}] Found existing shipment linked to order, updating status without API call`);
            
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
            
            // Extract order_date with multiple fallbacks:
            // 1. From merged shipmentData (includes tracking webhook + cached data)
            // 2. Directly from cached shipmentData JSONB (create_date/createDate)
            // 3. From cached order_date column (backfilled or previously extracted)
            const extractedOrderDate = 
              extractOrderDate(mergedShipmentData) || 
              (cachedShipment.shipmentData?.create_date ? new Date(cachedShipment.shipmentData.create_date) : null) ||
              (cachedShipment.shipmentData?.createDate ? new Date(cachedShipment.shipmentData.createDate) : null) ||
              cachedShipment.orderDate;
            
            // Build update object
            const updateData: any = {
              status: finalStatus,
              statusDescription: finalDescription,
              shipmentStatus: extractShipmentStatus(mergedShipmentData) || cachedShipment.shipmentStatus,
              shipDate: webhookTrackingData.ship_date ? new Date(webhookTrackingData.ship_date) : cachedShipment.shipDate,
              shipmentData: mergedShipmentData,
            };
            
            // Always explicitly set order_number (extracted, cached, or preserve existing)
            // This ensures backfilled values are maintained even if webhook lacks shipment_number
            if (extractedOrderNumber) {
              updateData.orderNumber = extractedOrderNumber;
            }
            
            // Always explicitly set order_date (extracted, cached, or preserve existing)
            // This ensures backfilled values are maintained even if webhook lacks create_date
            if (extractedOrderDate) {
              updateData.orderDate = extractedOrderDate;
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
            
            log(`[${trackingNumber}] Updated shipment status for order-linked shipment (0 API calls)`);
            processedCount++;
            continue; // Success - skip to next message without API call
          } catch (error: any) {
            // Store fast-path error and fall through to API sync fallback
            fastPathError = error;
            log(`Fast-path failed for ${trackingNumber}, falling back to full API sync: ${error.message}`);
            // Fall through to API sync below
          }
        }
        
        // INTELLIGENT WEBHOOK PROCESSING: Skip API call if we have webhook data
        if (isWebhookMessage && webhookData) {
          log(`[${trackingNumber}] Processing from webhook data (no API call)`);
          
          // Try to extract order number from webhook data
          const webhookOrderNumber = extractOrderNumber(webhookData);
          
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
                      
                      // Normalize status
                      const { status, statusDescription } = normalizeShipmentStatus(webhookData);
                      
                      // CRITICAL: Don't downgrade delivered shipments
                      const finalStatus = dbShipment.status === 'delivered' ? 'delivered' : status;
                      const finalDescription = dbShipment.status === 'delivered' 
                        ? dbShipment.statusDescription 
                        : statusDescription;
                      
                      // Update shipment with tracking info from webhook
                      const updateData: any = {
                        status: finalStatus,
                        statusDescription: finalDescription,
                        shipmentStatus: extractShipmentStatus(webhookData) || dbShipment.shipmentStatus,
                        shipDate: webhookData.ship_date ? new Date(webhookData.ship_date) : dbShipment.shipDate,
                        shipmentData: {
                          ...(dbShipment.shipmentData || {}),
                          latestTracking: webhookData,
                        },
                      };
                      
                      await storage.updateShipment(dbShipment.id, updateData);
                      
                      // Broadcast realtime update if shipment is linked to order
                      if (dbShipment.orderId) {
                        const order = await storage.getOrder(dbShipment.orderId);
                        if (order) {
                          broadcastOrderUpdate(order);
                        }
                      }
                      
                      log(`[${trackingNumber}] Updated shipment via label lookup (1 API call total)`);
                      processedCount++;
                      continue;
                    } else {
                      // Shipment doesn't exist in DB yet - fetch full data from ShipStation and create it
                      log(`[${trackingNumber}] Shipment not in DB, fetching from ShipStation via shipment_id: ${resolvedShipmentId}`);
                      
                      const { fetchShipStationResource } = await import('./utils/shipstation-api');
                      
                      // Fetch shipment data using shipment_id
                      const shipmentUrl = `https://api.shipstation.com/v2/shipments/${resolvedShipmentId}`;
                      const fullShipmentData = await fetchShipStationResource(shipmentUrl);
                      
                      // Extract order number from full shipment data
                      const orderNumber = extractOrderNumber(fullShipmentData);
                      
                      if (orderNumber) {
                        log(`[${trackingNumber}] Extracted order number from shipment: ${orderNumber}`);
                        
                        // Lookup order
                        const order = await storage.getOrderByOrderNumber(orderNumber);
                        
                        // Normalize status
                        const { status, statusDescription } = normalizeShipmentStatus(fullShipmentData);
                        
                        // Create shipment record
                        const shipmentRecord = {
                          orderId: order?.id || null,
                          shipmentId: String(resolvedShipmentId),
                          orderNumber,
                          orderDate: extractOrderDate(fullShipmentData),
                          trackingNumber,
                          carrierCode: fullShipmentData.carrier_code || fullShipmentData.carrierCode || null,
                          serviceCode: fullShipmentData.service_code || fullShipmentData.serviceCode || null,
                          status,
                          statusDescription,
                          shipmentStatus: extractShipmentStatus(fullShipmentData),
                          shipDate: fullShipmentData.ship_date ? new Date(fullShipmentData.ship_date) : null,
                          shipmentData: fullShipmentData,
                        };
                        
                        // Extract customer data from ship_to
                        extractShipToFields(fullShipmentData, shipmentRecord);
                        
                        // Extract enriched data
                        extractEnrichedShipmentFields(fullShipmentData, shipmentRecord);
                        
                        const createdShipment = await storage.createShipment(shipmentRecord);
                        
                        // Populate items and tags
                        await populateShipmentItemsAndTags(createdShipment.id, fullShipmentData);
                        
                        // Broadcast if linked to order
                        if (order) {
                          broadcastOrderUpdate(order);
                        }
                        
                        log(`[${trackingNumber}] Created shipment via label lookup (2 API calls total)`);
                        processedCount++;
                        continue;
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
            continue;
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
            continue;
          }
          
          // Normalize status
          const { status, statusDescription } = normalizeShipmentStatus(webhookData);
          
          const shipmentRecord = {
            orderId: order?.id || null, // Nullable for multi-channel orders
            shipmentId: String(rawShipmentId),
            orderNumber: webhookOrderNumber,
            orderDate: extractOrderDate(webhookData),
            trackingNumber: trackingNumber,
            carrierCode: webhookData.carrier_code || webhookData.carrierCode || null,
            serviceCode: webhookData.service_code || webhookData.serviceCode || null,
            status,
            statusDescription,
            shipmentStatus: extractShipmentStatus(webhookData),
            shipDate: webhookData.ship_date ? new Date(webhookData.ship_date) : null,
            shipmentData: webhookData,
          };
          
          let finalShipmentId: string;
          if (cachedShipment) {
            await storage.updateShipment(cachedShipment.id, shipmentRecord);
            finalShipmentId = cachedShipment.id;
            log(`[${trackingNumber}] Updated shipment from webhook (0 API calls)`);
          } else {
            const createdShipment = await storage.createShipment(shipmentRecord);
            finalShipmentId = createdShipment.id;
            log(`[${trackingNumber}] Created shipment from webhook (0 API calls)`);
          }
          
          // Populate items and tags if available
          await populateShipmentItemsAndTags(finalShipmentId, webhookData);
          
          // Broadcast update
          if (order) {
            broadcastOrderUpdate(order);
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
            
            // Normalize status using helper
            const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
            
            const shipmentRecord = {
              orderId: null, // No order linkage
              shipmentId: String(rawShipmentId),
              orderNumber: extractOrderNumber(shipmentData),
              orderDate: extractOrderDate(shipmentData),
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
        
        // Normalize status using helper
        const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
        
        const shipmentRecord = {
          orderId: order.id,
          shipmentId: String(rawShipmentId),
          orderNumber: extractOrderNumber(shipmentData),
          orderDate: extractOrderDate(shipmentData),
          trackingNumber: trackingNumber,
          carrierCode: shipmentData.carrier_code || shipmentData.carrierCode || null,
          serviceCode: shipmentData.service_code || shipmentData.serviceCode || null,
          status,
          statusDescription,
          shipmentStatus: extractShipmentStatus(shipmentData),
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
        
      } else if (orderNumber) {
        // PATH B: Order number path
        log(`Processing order number: ${orderNumber}${shipmentId ? ` (shipmentId: ${shipmentId})` : ''}${isWebhookMessage ? ' (webhook)' : ''}`);
        
        // INTELLIGENT WEBHOOK PROCESSING: Skip API call if we have webhook data
        if (isWebhookMessage && webhookData) {
          log(`[${orderNumber}] Processing from webhook data (no API call)`);
          
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
          
          // Normalize status
          const { status, statusDescription } = normalizeShipmentStatus(webhookData);
          
          const shipmentRecord = {
            orderId: order?.id || null, // Nullable for multi-channel
            shipmentId: String(rawShipmentId),
            orderNumber: extractOrderNumber(webhookData) || orderNumber,
            orderDate: extractOrderDate(webhookData),
            trackingNumber: shipmentTrackingNumber,
            carrierCode: webhookData.carrier_code || webhookData.carrierCode || null,
            serviceCode: webhookData.service_code || webhookData.serviceCode || null,
            status,
            statusDescription,
            shipmentStatus: extractShipmentStatus(webhookData),
            shipDate: webhookData.ship_date ? new Date(webhookData.ship_date) : null,
            ...extractShipToFields(webhookData), // Extract customer data
            ...extractReturnGiftFields(webhookData), // Extract return/gift data
            totalWeight: extractTotalWeight(webhookData), // Extract weight
            ...extractAdvancedOptions(webhookData), // Extract advanced options
            shipmentData: webhookData,
          };
          
          let finalShipmentId: string;
          if (existingShipment) {
            await storage.updateShipment(existingShipment.id, shipmentRecord);
            finalShipmentId = existingShipment.id;
            log(`[${orderNumber}] Updated shipment from webhook (0 API calls)`);
          } else {
            const createdShipment = await storage.createShipment(shipmentRecord);
            finalShipmentId = createdShipment.id;
            log(`[${orderNumber}] Created shipment from webhook (0 API calls)`);
          }
          
          // Populate items and tags
          await populateShipmentItemsAndTags(finalShipmentId, webhookData);
          
          // Broadcast update
          if (order) {
            broadcastOrderUpdate(order);
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
            removedFromInflight = true;
            
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
          
          // Normalize status using helper
          const { status, statusDescription } = normalizeShipmentStatus(shipmentData);
          
          const shipmentRecord = {
            orderId: order?.id || null, // Nullable order linkage
            shipmentId: shipmentId,
            orderNumber: extractOrderNumber(shipmentData),
            orderDate: extractOrderDate(shipmentData),
            trackingNumber: trackingNumber,
            carrierCode: carrierCode,
            serviceCode: serviceCode,
            status,
            statusDescription,
            shipmentStatus: extractShipmentStatus(shipmentData),
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
          broadcastOrderUpdate(order);
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
          removedFromInflight = true;
          
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
      // Only remove from in-flight if we haven't already (rate limit errors remove early to allow requeue)
      if (!removedFromInflight) {
        await removeShipmentSyncFromInflight(message);
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
      const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
      
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
