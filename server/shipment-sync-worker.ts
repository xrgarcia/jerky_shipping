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
  type ShipmentSyncMessage,
} from './utils/queue';
import { getShipmentsByOrderNumber } from './utils/shipstation-api';
import { linkTrackingToOrder, type TrackingData } from './utils/shipment-linkage';
import { shipmentSyncFailures, type InsertShipmentSyncFailure } from '@shared/schema';
import { broadcastOrderUpdate, broadcastQueueStatus } from './websocket';

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [shipment-sync] ${message}`);
}

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
  let rateLimitRemaining = 40; // ShipStation default
  let rateLimitReset = 60; // Default reset time in seconds
  
  for (const message of messages) {
    try {
      const { orderNumber, trackingNumber, reason, jobId } = message;
      
      // Determine which path to use: tracking number or order number
      if (trackingNumber) {
        // PATH A: Tracking number path
        // Use linkTrackingToOrder to fetch shipment and find the order
        log(`Processing tracking number: ${trackingNumber}`);
        
        // Check rate limiting before making API call
        if (rateLimitRemaining <= 2) {
          log(`⚠️  Low quota (${rateLimitRemaining} remaining), waiting ${rateLimitReset}s before next request...`);
          await new Promise(resolve => setTimeout(resolve, rateLimitReset * 1000));
          rateLimitRemaining = 40; // Reset after waiting
        }
        
        const trackingData: TrackingData = {
          tracking_number: trackingNumber,
        };
        
        const linkageResult = await linkTrackingToOrder(trackingData, storage);
        
        // Update rate limit tracking from linkage result
        if (linkageResult.rateLimit) {
          rateLimitRemaining = linkageResult.rateLimit.remaining;
          rateLimitReset = linkageResult.rateLimit.reset;
          log(`[${trackingNumber}] API call made, ${rateLimitRemaining}/${linkageResult.rateLimit.limit} calls remaining`);
        }
        
        if (linkageResult.error || !linkageResult.order || !linkageResult.shipmentData) {
          // Failed to link tracking to order
          await logShipmentSyncFailure({
            orderNumber: linkageResult.orderNumber || trackingNumber,
            reason,
            errorMessage: linkageResult.error || 'Failed to link tracking to order',
            requestData: { message },
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
        
        const existingShipment = await storage.getShipmentByTrackingNumber(trackingNumber);
        
        const shipmentRecord = {
          orderId: order.id,
          shipmentId: String(shipmentData.shipment_id || shipmentData.shipmentId),
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
        
      } else if (orderNumber) {
        // PATH B: Order number path (existing logic)
        log(`Processing order number: ${orderNumber}`);
        
        // Find the order in our database
        const order = await storage.getOrderByOrderNumber(orderNumber);
        
        if (!order) {
          // Order not found - log to dead letter queue
          await logShipmentSyncFailure({
            orderNumber,
            reason,
            errorMessage: `Order ${orderNumber} not found in database`,
            requestData: { message },
            responseData: null,
            retryCount: 0,
            failedAt: new Date(),
          });
          processedCount++;
          continue;
        }

        // Check rate limiting before making API call
        if (rateLimitRemaining <= 2) {
          log(`⚠️  Low quota (${rateLimitRemaining} remaining), waiting ${rateLimitReset}s before next request...`);
          await new Promise(resolve => setTimeout(resolve, rateLimitReset * 1000));
          rateLimitRemaining = 40; // Reset after waiting
        }

        // Fetch shipments from ShipStation
        const { data: shipments, rateLimit } = await getShipmentsByOrderNumber(orderNumber);
        
        // Update rate limit tracking
        rateLimitRemaining = rateLimit.remaining;
        rateLimitReset = rateLimit.reset;
        
        log(`[${orderNumber}] ${shipments.length} shipment(s) found, ${rateLimitRemaining}/${rateLimit.limit} API calls remaining`);

        // Update shipments in database
        for (const shipmentData of shipments) {
          const existingShipment = await storage.getShipmentByShipmentId(String(shipmentData.shipmentId));
          
          const shipmentRecord = {
            orderId: order.id,
            shipmentId: String(shipmentData.shipmentId),
            trackingNumber: shipmentData.trackingNumber || null,
            carrierCode: shipmentData.carrierCode || null,
            serviceCode: shipmentData.serviceCode || null,
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
        }

        // Broadcast order update via WebSocket
        broadcastOrderUpdate(order);
        
        processedCount++;
        
      } else {
        // Invalid message - neither tracking number nor order number
        log(`⚠️  Invalid message: missing both orderNumber and trackingNumber`);
        processedCount++;
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
        requestData: { message },
        responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
        retryCount: 0,
        failedAt: new Date(),
      });
      
      log(`❌ Failed to sync shipments for ${message.orderNumber || message.trackingNumber}: ${error.message}`);
      processedCount++;
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
      const webhookQueueLength = await getQueueLength();
      const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
      const failureCount = await storage.getShipmentSyncFailureCount();
      
      broadcastQueueStatus({
        webhookQueue: webhookQueueLength,
        shipmentSyncQueue: shipmentSyncQueueLength,
        shipmentFailureCount: failureCount,
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
