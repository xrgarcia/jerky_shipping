import { storage } from './storage';
import { enqueueShipmentSync } from './utils/queue';
import { db } from './db';
import { shipments } from '@shared/schema';
import { desc, eq, asc } from 'drizzle-orm';
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
  // Reverse sync stats (cumulative)
  reverseSyncProcessed: 0,
  reverseSyncUpdated: 0,
  lastReverseSyncAt: null as Date | null,
};

// Real-time reverse sync progress tracking
let reverseSyncProgress = {
  inProgress: false,
  currentPage: 0,
  totalStaleAtStart: 0,
  checkedThisRun: 0,
  updatedThisRun: 0,
  startedAt: null as Date | null,
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
    // Real-time reverse sync progress
    reverseSyncProgress: {
      inProgress: reverseSyncProgress.inProgress,
      currentPage: reverseSyncProgress.currentPage,
      totalStaleAtStart: reverseSyncProgress.totalStaleAtStart,
      checkedThisRun: reverseSyncProgress.checkedThisRun,
      updatedThisRun: reverseSyncProgress.updatedThisRun,
      startedAt: reverseSyncProgress.startedAt?.toISOString() || null,
    },
  };
}

export function getReverseSyncProgress() {
  return {
    ...reverseSyncProgress,
    startedAt: reverseSyncProgress.startedAt?.toISOString() || null,
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
      reverseSyncProgress: {
        inProgress: reverseSyncProgress.inProgress,
        currentPage: reverseSyncProgress.currentPage,
        totalStaleAtStart: reverseSyncProgress.totalStaleAtStart,
        checkedThisRun: reverseSyncProgress.checkedThisRun,
        updatedThisRun: reverseSyncProgress.updatedThisRun,
        startedAt: reverseSyncProgress.startedAt?.toISOString() || null,
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
      
      // Fetch all on_hold shipments from ShipStation and push each onto the sync queue
      let totalQueued = 0;
      let page = 1;
      let hasMorePages = true;
      
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
        
        log(`Page ${page}: Found ${pageShipments.length} on_hold shipment(s)`);
        
        // If we got fewer than 100 shipments, this is the last page
        hasMorePages = pageShipments.length === 100;
        
        // Push each shipment onto the queue - let the sync worker handle everything else
        // CRITICAL: Deep-clone each shipment before enqueueing to prevent object reference sharing
        // Without cloning, all queued messages can end up with the same webhookData
        for (const shipment of pageShipments) {
          const shipmentSnapshot = JSON.parse(JSON.stringify(shipment));
          await enqueueShipmentSync({
            orderNumber: shipmentSnapshot.shipment_number,
            shipmentId: shipmentSnapshot.shipment_id,
            trackingNumber: shipmentSnapshot.tracking_number,
            reason: 'manual',
            enqueuedAt: Date.now(),
            webhookData: shipmentSnapshot,
          });
        }
        
        totalQueued += pageShipments.length;
        page++;
      }
      
      log(`Total: Queued ${totalQueued} on_hold shipment(s)`)
    
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
 * SIMPLIFIED Reverse sync: Check ALL on_hold shipments in our DB against ShipStation.
 * 
 * With only ~80-100 on_hold shipments at peak, we can afford to check ALL of them
 * each cycle without worrying about stale thresholds or timestamps.
 * 
 * Key behavior:
 * - Queries ALL shipments with status=on_hold in our DB
 * - Fetches each from ShipStation API to get current status
 * - Only updates DB if status ACTUALLY CHANGED (on_hold -> something else)
 * - Does NOT touch any records that are still on_hold (no timestamp bumping)
 * - This eliminates the "freshness" problem entirely
 */
export async function reverseSyncOnHoldShipments(): Promise<{ checked: number; updated: number }> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    log('[reverse-sync] ShipStation API key not configured, skipping');
    return { checked: 0, updated: 0 };
  }

  // Get ALL on_hold shipments from our DB - no stale threshold, no filtering
  const allOnHoldShipments = await db
    .select()
    .from(shipments)
    .where(eq(shipments.shipmentStatus, 'on_hold'))
    .orderBy(asc(shipments.createdAt)); // Process oldest first
  
  const totalCount = allOnHoldShipments.length;
  log(`[reverse-sync] Found ${totalCount} on_hold shipment(s) in DB - checking ALL against ShipStation`);
  
  if (totalCount === 0) {
    return { checked: 0, updated: 0 };
  }
  
  // Initialize progress tracking
  reverseSyncProgress = {
    inProgress: true,
    currentPage: 1,
    totalStaleAtStart: totalCount,
    checkedThisRun: 0,
    updatedThisRun: 0,
    startedAt: new Date(),
  };
  
  let checked = 0;
  let updated = 0;
  
  try {
    for (const shipment of allOnHoldShipments) {
      if (!shipment.shipmentId) {
        // Skip shipments without ShipStation ID - can't look them up
        continue;
      }
      
      try {
        // Fetch current status from ShipStation
        const result = await getShipmentByShipmentId(shipment.shipmentId);
        checked++;
        
        // Update progress
        reverseSyncProgress.checkedThisRun = checked;
        
        if (!result.data) {
          // Shipment not found in ShipStation - mark as cancelled
          log(`[reverse-sync] Shipment ${shipment.shipmentId} (${shipment.orderNumber}) not found in ShipStation - marking as cancelled`);
          await db
            .update(shipments)
            .set({ 
              shipmentStatus: 'cancelled',
              updatedAt: new Date()
            })
            .where(eq(shipments.id, shipment.id));
          updated++;
          reverseSyncProgress.updatedThisRun = updated;
          continue;
        }
        
        const currentStatus = result.data.shipment_status;
        
        // ONLY update if status actually changed
        if (currentStatus !== 'on_hold') {
          log(`[reverse-sync] Shipment ${shipment.shipmentId} (${shipment.orderNumber}) status changed: on_hold -> ${currentStatus}`);
          
          try {
            // CRITICAL: Deep-clone the API response data before enqueueing!
            // The ShipStation API client reuses/mutates the response object across calls.
            // Without cloning, all queued messages end up with the same (last fetched) data.
            const shipmentDataSnapshot = JSON.parse(JSON.stringify(result.data));
            
            // Queue for full sync to get all updated data
            await enqueueShipmentSync({
              orderNumber: shipment.orderNumber || undefined,
              shipmentId: shipment.shipmentId,
              trackingNumber: shipmentDataSnapshot.tracking_number || shipment.trackingNumber || undefined,
              reason: 'manual',
              enqueuedAt: Date.now(),
              webhookData: shipmentDataSnapshot,
            });
            updated++;
            reverseSyncProgress.updatedThisRun = updated;
          } catch (enqueueError: any) {
            log(`[reverse-sync] Failed to enqueue sync for ${shipment.shipmentId}: ${enqueueError.message}`);
          }
        }
        // If still on_hold, do NOTHING - don't touch any fields
        
        // Small delay to respect rate limits (100ms = max 600 requests/minute)
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error: any) {
        log(`[reverse-sync] Error checking shipment ${shipment.shipmentId}: ${error.message}`);
        // Continue to next shipment
      }
    }
    
    log(`[reverse-sync] Complete: checked ${checked}/${totalCount}, updated ${updated}`);
    
    // Update cumulative stats
    workerStats.reverseSyncProcessed += checked;
    workerStats.reverseSyncUpdated += updated;
    workerStats.lastReverseSyncAt = new Date();
    
    return { checked, updated };
  } finally {
    reverseSyncProgress.inProgress = false;
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

  // Store poll interval for reverse sync threshold calculation
  currentPollIntervalMs = intervalMs;

  log(`On-hold poll worker started (interval: ${intervalMs}ms = ${intervalMs / 60000} minutes)`);
  
  const pollTask = async () => {
    try {
      // First: Poll for on_hold shipments (forward sync)
      await pollOnHoldShipments();
      
      // Then: Check if any DB on_hold shipments have changed status in ShipStation (reverse sync)
      // Uses queue-based approach: detects status change -> enqueues to shipment-sync queue
      // Data corruption prevented via deep-clone before enqueueing (JSON.parse/stringify)
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
