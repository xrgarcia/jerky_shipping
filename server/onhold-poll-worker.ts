import { storage } from './storage';
import { enqueueShipmentSync } from './utils/queue';
import { db } from './db';
import { shipments } from '@shared/schema';
import { desc, eq, lt, and, asc } from 'drizzle-orm';
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
import { workerCoordinator } from './worker-coordinator';
import { getShipmentByShipmentId } from './utils/shipstation-api';

const log = (message: string) => console.log(`[onhold-poll] ${message}`);

// Global worker status - now includes awaiting_backfill_job
let workerStatus: 'sleeping' | 'running' | 'awaiting_backfill_job' = 'sleeping';

// Worker statistics
let workerStats = {
  totalProcessedCount: 0,
  lastProcessedCount: 0,
  workerStartedAt: new Date(),
  lastCompletedAt: null as Date | null,
  // Reverse sync stats
  reverseSyncProcessed: 0,
  reverseSyncUpdated: 0,
  lastReverseSyncAt: null as Date | null,
};

// Store the poll interval for use in reverse sync threshold calculation
let currentPollIntervalMs = 60000; // Default 1 minute

export function getOnHoldWorkerStatus(): 'sleeping' | 'running' | 'awaiting_backfill_job' {
  return workerStatus;
}

export function getOnHoldWorkerStats() {
  // Don't return stats until first poll completes (prevents "Never" on startup)
  if (workerStats.lastCompletedAt === null) {
    return undefined;
  }
  
  return {
    ...workerStats,
    status: workerStatus,
    reverseSyncProcessed: workerStats.reverseSyncProcessed,
    reverseSyncUpdated: workerStats.reverseSyncUpdated,
    lastReverseSyncAt: workerStats.lastReverseSyncAt?.toISOString() || null,
  };
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
    // Pipeline metrics for operations dashboard - included in every broadcast
    const pipeline = await storage.getPipelineMetrics();

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
      onHoldWorkerStats: {
        totalProcessedCount: workerStats.totalProcessedCount,
        lastProcessedCount: workerStats.lastProcessedCount,
        workerStartedAt: workerStats.workerStartedAt.toISOString(),
        lastCompletedAt: workerStats.lastCompletedAt?.toISOString() || null,
      },
      dataHealth,
      pipeline,
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
 * 1. Check if backfill job is active - if so, pause and wait
 * 2. Get the most recent on_hold shipment from our database
 * 3. Use that date as the floor (or default to 30 days ago)
 * 4. Fetch ALL pages of on_hold shipments since that date
 * 5. Queue each shipment with inline data (0 API calls per shipment!)
 */
export async function pollOnHoldShipments(): Promise<number> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    log('ShipStation API key not configured, skipping poll');
    return 0;
  }

  // Check coordinator status before attempting mutex acquisition
  try {
    const backfillActive = await workerCoordinator.isBackfillActive();
    
    if (backfillActive) {
      const jobId = await workerCoordinator.getActiveBackfillJobId();
      log(`Backfill job ${jobId} is active - pausing poll worker`);
      workerStatus = 'awaiting_backfill_job';
      await broadcastWorkerStatus();
      // Keep status as awaiting_backfill_job for a few seconds so UI can observe it
      await new Promise(resolve => setTimeout(resolve, 3000));
      workerStatus = 'sleeping';
      await broadcastWorkerStatus();
      return 0;
    }
  } catch (error) {
    log(`Failed to check coordinator status: ${error}`);
  }

  // Use mutex to prevent overlapping executions
  const result = await workerCoordinator.withPollMutex(async () => {
    try {
      workerStatus = 'running';
      await broadcastWorkerStatus();  // Notify frontend of status change
      
      // Fetch ALL on_hold shipments without date filtering
      // We previously used a date floor (modified_at_start) to minimize API calls, but this
      // caused shipments to be missed if they were put on hold more than 30 minutes ago.
      // With ~100 on_hold shipments typically, fetching all is acceptable.
    
    let totalQueued = 0;
    let page = 1;
    let hasMorePages = true;
    
    // Fetch all pages of on_hold shipments (no date filter - get everything)
    while (hasMorePages) {
      const url = `https://api.shipstation.com/v2/shipments?shipment_status=on_hold&sort_dir=desc&sort_by=modified_at&page_size=100&page=${page}`;
      
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
      
      // Log the full API response info for debugging
      log(`Page ${page}: Found ${pageShipments.length} on_hold shipment(s) (total: ${data.total || 'unknown'}, pages: ${data.pages || 'unknown'})`);
      
      // Log first few shipment_numbers for debugging
      if (page === 1 && pageShipments.length > 0) {
        const sampleNumbers = pageShipments.slice(0, 5).map((s: any) => s.shipment_number).join(', ');
        log(`Sample shipment_numbers from page 1: ${sampleNumbers}...`);
      }
      
      // If we got fewer than 100 shipments, this is the last page
      hasMorePages = pageShipments.length === 100;
      
      let pageQueued = 0;
      let skippedExisting = 0;
      let skippedNoNumber = 0;
      
      for (const shipmentData of pageShipments) {
        const orderNumber = shipmentData.shipment_number;
        const shipmentId = shipmentData.shipment_id;
        const trackingNumber = shipmentData.tracking_number;
        
        // Debug logging for specific shipment we're tracking
        const isDebugTarget = orderNumber === 'JK3825348884' || shipmentId === 'se-929114240';
        if (isDebugTarget) {
          log(`[DEBUG] Found target shipment: ${orderNumber} (${shipmentId})`);
        }
        
        if (!orderNumber) {
          log(`Skipping shipment ${shipmentId} - missing shipment_number`);
          skippedNoNumber++;
          continue;
        }
        
        // Check if we already have this shipment
        const existing = await storage.getShipmentByShipmentId(String(shipmentId));
        if (isDebugTarget) {
          log(`[DEBUG] ${orderNumber} existing check: ${existing ? 'found in DB' : 'NOT in DB'}`);
        }
        if (existing) {
          // Only queue if modified timestamp is newer than our last update
          const shipmentModified = new Date(shipmentData.modified_at);
          const ourUpdated = existing.updatedAt ? new Date(existing.updatedAt) : new Date(existing.createdAt);
          
          if (shipmentModified <= ourUpdated) {
            skippedExisting++;
            if (isDebugTarget) {
              log(`[DEBUG] ${orderNumber} skipped - already up to date`);
            }
            continue; // Skip - we already have the latest version
          }
        }
        
        // Queue for sync with inline shipment data
        const queueResult = await enqueueShipmentSync({
          orderNumber,
          shipmentId,
          trackingNumber,
          reason: 'manual',
          enqueuedAt: Date.now(),
          webhookData: shipmentData, // Pass shipment data directly (no API call needed!)
        });
        
        if (isDebugTarget) {
          log(`[DEBUG] ${orderNumber} enqueue result: ${queueResult ? 'SUCCESS' : 'FAILED'}`);
        }
        
        pageQueued++;
      }
      
      log(`Page ${page}: Queued ${pageQueued}, skipped ${skippedExisting} existing, ${skippedNoNumber} no number`);
      
      totalQueued += pageQueued;
      page++;
    }
    
    if (totalQueued > 0) {
      log(`Total: Queued ${totalQueued} on_hold shipment(s) across ${page - 1} page(s)`);
    } else {
      log(`No new on_hold shipments to queue`);
    }
    
      // Update worker statistics
      workerStats.lastProcessedCount = totalQueued;
      workerStats.totalProcessedCount += totalQueued;
      workerStats.lastCompletedAt = new Date();
      
      return totalQueued;
    } catch (error: any) {
      log(`Error polling on_hold shipments: ${error.message}`);
      return 0;
    } finally {
      // Delay before setting to sleeping so the UI can observe the "running" state
      // Without this delay, the running state is too brief for the UI to catch
      await new Promise(resolve => setTimeout(resolve, 3000));
      workerStatus = 'sleeping';
      await broadcastWorkerStatus();  // Notify frontend of status change
    }
  });

  // Handle case where mutex could not be acquired (Redis error or already locked)
  if (result === null) {
    log('Poll mutex not acquired (Redis error or already locked) - will retry next cycle');
    // Keep status as sleeping - mutex contention is normal, not a degraded state
    // The UI should just show that the worker is sleeping between poll attempts
    workerStatus = 'sleeping';
    await broadcastWorkerStatus();
    return 0;
  }

  return result;
}

/**
 * Reverse sync: Check shipments in our DB marked as on_hold that weren't updated recently.
 * If the on-hold poll worker just ran and a shipment wasn't touched, it means ShipStation
 * didn't return it in the on_hold query - so it's probably no longer on hold.
 * 
 * This function pages through ALL stale on_hold shipments and fetches their current status
 * from ShipStation, updating them if their status has changed.
 * 
 * @param staleThresholdMs - How old updatedAt must be to consider a shipment "stale"
 *                           Default: 2x poll interval (ensures poll had a chance to update it)
 */
export async function reverseSyncOnHoldShipments(staleThresholdMs?: number): Promise<{ checked: number; updated: number }> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    log('[reverse-sync] ShipStation API key not configured, skipping');
    return { checked: 0, updated: 0 };
  }

  // Use 2x poll interval as threshold to ensure the poll had a chance to update fresh shipments
  const threshold = staleThresholdMs ?? (currentPollIntervalMs * 2);
  const staleDate = new Date(Date.now() - threshold);
  
  log(`[reverse-sync] Looking for on_hold shipments not updated since ${staleDate.toISOString()}`);
  
  let totalChecked = 0;
  let totalUpdated = 0;
  let page = 1;
  const pageSize = 50;
  let hasMorePages = true;
  
  // Page through ALL stale on_hold shipments, processing oldest first
  while (hasMorePages) {
    // Find shipments in our DB that are marked on_hold but haven't been updated recently
    // ORDER BY updated_at ASC ensures we check the oldest (most stale) shipments first
    const staleOnHoldShipments = await db
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.shipmentStatus, 'on_hold'),
          lt(shipments.updatedAt, staleDate)
        )
      )
      .orderBy(asc(shipments.updatedAt))
      .limit(pageSize);
    
    if (staleOnHoldShipments.length === 0) {
      if (page === 1) {
        log('[reverse-sync] No stale on_hold shipments found');
      }
      hasMorePages = false;
      break;
    }
    
    log(`[reverse-sync] Page ${page}: Processing ${staleOnHoldShipments.length} stale on_hold shipment(s)`);
    
    let pageChecked = 0;
    let pageUpdated = 0;
    
    for (const shipment of staleOnHoldShipments) {
      if (!shipment.shipmentId) {
        // Touch updatedAt to prevent retrying shipments with no shipmentId
        await db
          .update(shipments)
          .set({ updatedAt: new Date() })
          .where(eq(shipments.id, shipment.id));
        continue;
      }
      
      try {
        // Fetch current status from ShipStation
        const result = await getShipmentByShipmentId(shipment.shipmentId);
        pageChecked++;
        
        if (!result.data) {
          log(`[reverse-sync] Shipment ${shipment.shipmentId} not found in ShipStation`);
          // Touch updatedAt to prevent tight retry loop on missing shipments
          await db
            .update(shipments)
            .set({ updatedAt: new Date() })
            .where(eq(shipments.id, shipment.id));
          continue;
        }
        
        const currentStatus = result.data.shipment_status;
        
        // If status has changed from on_hold, queue for sync
        if (currentStatus !== 'on_hold') {
          log(`[reverse-sync] Shipment ${shipment.shipmentId} (${shipment.orderNumber}) status changed: on_hold -> ${currentStatus}`);
          
          await enqueueShipmentSync({
            orderNumber: shipment.orderNumber || undefined,
            shipmentId: shipment.shipmentId,
            trackingNumber: result.data.tracking_number || shipment.trackingNumber || undefined,
            reason: 'manual',
            enqueuedAt: Date.now(),
            webhookData: result.data, // Pass full shipment data
          });
          
          pageUpdated++;
        } else {
          // Still on hold - update the updatedAt to prevent checking again next cycle
          await db
            .update(shipments)
            .set({ updatedAt: new Date() })
            .where(eq(shipments.id, shipment.id));
        }
        
        // Small delay to respect rate limits (100ms = max 600 requests/minute)
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error: any) {
        log(`[reverse-sync] Error checking shipment ${shipment.shipmentId}: ${error.message}`);
        // Touch updatedAt even on error to prevent tight retry loop
        try {
          await db
            .update(shipments)
            .set({ updatedAt: new Date() })
            .where(eq(shipments.id, shipment.id));
        } catch (dbError) {
          log(`[reverse-sync] Failed to update timestamp for shipment ${shipment.shipmentId}`);
        }
      }
    }
    
    totalChecked += pageChecked;
    totalUpdated += pageUpdated;
    
    log(`[reverse-sync] Page ${page} complete: checked ${pageChecked}, updated ${pageUpdated}`);
    
    // If we got fewer than pageSize, we've processed all stale shipments
    // Note: We query again each page because updatedAt gets bumped during processing,
    // so previously stale shipments are no longer in the result set
    if (staleOnHoldShipments.length < pageSize) {
      hasMorePages = false;
    } else {
      page++;
      // Add a small delay between pages to be nice to the database
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  log(`[reverse-sync] Complete: checked ${totalChecked}, updated ${totalUpdated} across ${page} page(s)`);
  
  // Update stats
  workerStats.reverseSyncProcessed += totalChecked;
  workerStats.reverseSyncUpdated += totalUpdated;
  workerStats.lastReverseSyncAt = new Date();
  
  return { checked: totalChecked, updated: totalUpdated };
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

  // Store poll interval for reverse sync threshold calculation
  currentPollIntervalMs = intervalMs;

  log(`On-hold poll worker started (interval: ${intervalMs}ms = ${intervalMs / 60000} minutes)`);
  
  const pollTask = async () => {
    try {
      // First: Poll for on_hold shipments (forward sync)
      await pollOnHoldShipments();
      
      // Then: Check stale on_hold shipments (reverse sync)
      // This catches shipments that fell off the on_hold query
      await reverseSyncOnHoldShipments();
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
