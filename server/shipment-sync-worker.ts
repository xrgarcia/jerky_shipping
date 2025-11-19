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
  type ShipmentSyncMessage,
} from './utils/queue';
import { getShipmentsByOrderNumber } from './utils/shipstation-api';
import { shipmentSyncFailures, type InsertShipmentSyncFailure } from '@shared/schema';
import { broadcastOrderUpdate } from './websocket';

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
      const { orderNumber, reason, jobId } = message;
      
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
      
      // Add small delay between requests to be respectful to API
      if (processedCount < messages.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error: any) {
      // Log failure to dead letter queue
      await logShipmentSyncFailure({
        orderNumber: message.orderNumber,
        reason: message.reason,
        errorMessage: error.message || 'Unknown error',
        requestData: { message },
        responseData: error.response ? JSON.parse(JSON.stringify(error.response)) : null,
        retryCount: 0,
        failedAt: new Date(),
      });
      
      log(`❌ Failed to sync shipments for ${message.orderNumber}: ${error.message}`);
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
