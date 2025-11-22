import { storage } from './storage';
import { enqueueShipmentSync } from './utils/queue';
import { db } from './db';
import { shipments } from '@shared/schema';
import { desc, eq } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import { 
  getQueueLength, 
  getShipmentSyncQueueLength,
  getShopifyOrderSyncQueueLength,
  getOldestShopifyQueueMessage,
  getOldestShipmentSyncQueueMessage,
  getOldestShopifyOrderSyncQueueMessage
} from './utils/queue';
import { shipmentSyncFailures } from '@shared/schema';
import { count } from 'drizzle-orm';

const log = (message: string) => console.log(`[onhold-poll] ${message}`);

// Global worker status
let workerStatus: 'sleeping' | 'running' = 'sleeping';

export function getOnHoldWorkerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

// Helper to broadcast queue stats with worker status
async function broadcastWorkerStatus() {
  try {
    const shopifyQueueLength = await getQueueLength();
    const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
    const shopifyOrderSyncQueueLength = await getShopifyOrderSyncQueueLength();
    const oldestShopify = await getOldestShopifyQueueMessage();
    const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
    const oldestShopifyOrderSync = await getOldestShopifyOrderSyncQueueMessage();
    const failureCount = await db.select({ count: count() })
      .from(shipmentSyncFailures)
      .then(rows => rows[0]?.count || 0);
    const allBackfillJobs = await storage.getAllBackfillJobs();
    const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
    const dataHealth = await storage.getDataHealthMetrics();

    broadcastQueueStatus({
      shopifyQueue: shopifyQueueLength,
      shipmentSyncQueue: shipmentSyncQueueLength,
      shopifyOrderSyncQueue: shopifyOrderSyncQueueLength,
      shipmentFailureCount: failureCount,
      shopifyQueueOldestAt: oldestShopify?.enqueuedAt || null,
      shipmentSyncQueueOldestAt: oldestShipmentSync?.enqueuedAt || null,
      shopifyOrderSyncQueueOldestAt: oldestShopifyOrderSync?.enqueuedAt || null,
      backfillActiveJob: activeBackfillJob,
      onHoldWorkerStatus: workerStatus,
      dataHealth,
    });
  } catch (error) {
    // Don't crash the worker if broadcast fails
    log(`Error broadcasting worker status: ${error}`);
  }
}

/**
 * Poll ShipStation for on_hold shipments and enqueue them for processing
 * This worker supplements webhooks which don't fire for on_hold shipments
 * 
 * Strategy:
 * 1. Get the most recent on_hold shipment from our database
 * 2. Use that date as the floor (or default to 30 days ago)
 * 3. Fetch ALL pages of on_hold shipments since that date
 * 4. Queue each shipment with inline data (0 API calls per shipment!)
 */
export async function pollOnHoldShipments(): Promise<number> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    log('ShipStation API key not configured, skipping poll');
    return 0;
  }

  try {
    workerStatus = 'running';
    await broadcastWorkerStatus();  // Notify frontend of status change
    // Get the most recent on_hold shipment from our database
    const mostRecentOnHold = await db
      .select()
      .from(shipments)
      .where(eq(shipments.shipmentStatus, 'on_hold'))
      .orderBy(desc(shipments.updatedAt))
      .limit(1);
    
    // Use most recent on_hold shipment date as floor, or default to 30 days ago
    let modifiedSince: string;
    if (mostRecentOnHold.length > 0 && mostRecentOnHold[0].updatedAt) {
      modifiedSince = new Date(mostRecentOnHold[0].updatedAt).toISOString();
      log(`Using most recent on_hold shipment date as floor: ${modifiedSince}`);
    } else {
      modifiedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      log(`No on_hold shipments in DB, using 30 day lookback: ${modifiedSince}`);
    }
    
    let totalQueued = 0;
    let page = 1;
    let hasMorePages = true;
    
    // Fetch all pages of on_hold shipments
    while (hasMorePages) {
      const url = `https://api.shipstation.com/v2/shipments?shipment_status=on_hold&modified_date_start=${modifiedSince}&page_size=100&page=${page}`;
      
      log(`Fetching page ${page} of on_hold shipments...`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`ShipStation API error: ${response.statusText}`);
      }

      const data = await response.json();
      const pageShipments = data.shipments || [];
      
      log(`Page ${page}: Found ${pageShipments.length} on_hold shipment(s)`);
      
      // If we got fewer than 100 shipments, this is the last page
      hasMorePages = pageShipments.length === 100;
      
      let pageQueued = 0;
      for (const shipmentData of pageShipments) {
        const orderNumber = shipmentData.shipment_number;
        const shipmentId = shipmentData.shipment_id;
        const trackingNumber = shipmentData.tracking_number;
        
        if (!orderNumber) {
          log(`Skipping shipment ${shipmentId} - missing shipment_number`);
          continue;
        }
        
        // Check if we already have this shipment
        const existing = await storage.getShipmentByShipmentId(String(shipmentId));
        if (existing) {
          // Only queue if modified timestamp is newer than our last update
          const shipmentModified = new Date(shipmentData.modified_at);
          const ourUpdated = existing.updatedAt ? new Date(existing.updatedAt) : new Date(existing.createdAt);
          
          if (shipmentModified <= ourUpdated) {
            continue; // Skip - we already have the latest version
          }
        }
        
        // Queue for sync with inline shipment data
        await enqueueShipmentSync({
          orderNumber,
          shipmentId,
          trackingNumber,
          reason: 'onhold_poll',
          enqueuedAt: Date.now(),
          webhookData: shipmentData, // Pass shipment data directly (no API call needed!)
        });
        
        pageQueued++;
      }
      
      if (pageQueued > 0) {
        log(`Page ${page}: Queued ${pageQueued} shipment(s)`);
      }
      
      totalQueued += pageQueued;
      page++;
    }
    
    if (totalQueued > 0) {
      log(`Total: Queued ${totalQueued} on_hold shipment(s) across ${page - 1} page(s)`);
    } else {
      log(`No new on_hold shipments to queue`);
    }
    
    return totalQueued;
  } catch (error: any) {
    log(`Error polling on_hold shipments: ${error.message}`);
    return 0;
  } finally {
    workerStatus = 'sleeping';
    await broadcastWorkerStatus();  // Notify frontend of status change
  }
}

/**
 * Start the on_hold shipments polling worker
 */
export function startOnHoldPollWorker(intervalMs: number = 300000): NodeJS.Timeout {
  // Prevent duplicate workers (survives hot-reload)
  if (globalThis.__onHoldPollWorkerInterval) {
    log('On-hold poll worker already running, skipping duplicate start');
    return globalThis.__onHoldPollWorkerInterval;
  }

  log(`On-hold poll worker started (interval: ${intervalMs}ms = ${intervalMs / 60000} minutes)`);
  
  const pollTask = async () => {
    try {
      await pollOnHoldShipments();
    } catch (error) {
      console.error("On-hold poll worker error:", error);
    }
  };

  // Run immediately on startup, then every interval
  pollTask();
  
  const interval = setInterval(pollTask, intervalMs);
  globalThis.__onHoldPollWorkerInterval = interval;
  
  return interval;
}

/**
 * Stop the on_hold poll worker
 */
export function stopOnHoldPollWorker(): void {
  if (globalThis.__onHoldPollWorkerInterval) {
    clearInterval(globalThis.__onHoldPollWorkerInterval);
    globalThis.__onHoldPollWorkerInterval = undefined;
    log('On-hold poll worker stopped');
  }
}

// TypeScript global declarations
declare global {
  var __onHoldPollWorkerInterval: NodeJS.Timeout | undefined;
}
