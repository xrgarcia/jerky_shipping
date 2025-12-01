import { storage } from './storage';
import { enqueueShipmentSync, enqueueShipmentSyncBatch } from './utils/queue';
import { db } from './db';
import { shipments } from '@shared/schema';
import { desc, eq, asc, or, isNull, lt, sql, inArray, gt, and } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import { 
  getQueueLength, 
  getShipmentSyncQueueLength,
  getShipmentSyncQueueLengthByPriority,
  getShopifyOrderSyncQueueLength,
  getOldestShopifyQueueMessage,
  getOldestShipmentSyncQueueMessage,
  getOldestShopifyOrderSyncQueueMessage
} from './utils/queue';
import { shipmentSyncFailures } from '@shared/schema';
import { count } from 'drizzle-orm';
import { workerCoordinator } from './worker-coordinator';

const log = (message: string) => console.log(`[onhold-poll] ${message}`);

// Skip re-queuing shipments that were synced within this window
// This prevents queue flooding when poll runs frequently
const FORWARD_SYNC_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

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
        
        // OPTIMIZATION: Filter out shipments that were recently synced
        // This prevents queue flooding when poll runs every 60 seconds
        const freshnessThreshold = new Date(Date.now() - FORWARD_SYNC_FRESHNESS_MS);
        
        // Get list of ShipStation IDs from this page
        const shipmentIds = pageShipments
          .map((s: any) => s.shipment_id)
          .filter((id: string | null) => id);
        
        // Batch query to find which shipments were recently synced
        let recentlySyncedIds = new Set<string>();
        if (shipmentIds.length > 0) {
          const recentShipments = await db
            .select({ shipmentId: shipments.shipmentId })
            .from(shipments)
            .where(
              and(
                inArray(shipments.shipmentId, shipmentIds),
                gt(shipments.updatedAt, freshnessThreshold)
              )
            );
          recentlySyncedIds = new Set(recentShipments.map(s => s.shipmentId).filter((id): id is string => id !== null));
        }
        
        // Push each shipment onto the queue - let the sync worker handle everything else
        // CRITICAL: Deep-clone each shipment before enqueueing to prevent object reference sharing
        // Without cloning, all queued messages can end up with the same webhookData
        let pageQueued = 0;
        let pageSkipped = 0;
        
        for (const shipment of pageShipments) {
          // Skip if recently synced (within last 5 minutes)
          if (shipment.shipment_id && recentlySyncedIds.has(shipment.shipment_id)) {
            pageSkipped++;
            continue;
          }
          
          const shipmentSnapshot = JSON.parse(JSON.stringify(shipment));
          await enqueueShipmentSync({
            orderNumber: shipmentSnapshot.shipment_number,
            shipmentId: shipmentSnapshot.shipment_id,
            trackingNumber: shipmentSnapshot.tracking_number,
            reason: 'manual',
            enqueuedAt: Date.now(),
            webhookData: shipmentSnapshot,
          });
          pageQueued++;
        }
        
        if (pageSkipped > 0) {
          log(`Page ${page}: Queued ${pageQueued}, skipped ${pageSkipped} (recently synced)`);
        }
        
        totalQueued += pageQueued;
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
 * Queue-based reverse sync: Enqueue on_hold shipments that haven't been checked recently.
 * 
 * This is now a simple "enqueue and let the sync worker handle it" approach:
 * - Queries shipments with status=on_hold in our DB that haven't been verified in 5+ minutes
 * - Batch enqueues them to the shipment-sync queue with reason='reverse_sync'
 * - Dedup naturally filters out shipments already queued by forward sync
 * - The sync worker handles rate limiting, API calls, and status comparison
 * 
 * Time-based filtering prevents the same shipments from being re-enqueued every poll cycle:
 * - reverseSyncLastCheckedAt is updated by the sync worker when it verifies a shipment
 * - Only shipments with NULL or stale (>6 hours) reverseSyncLastCheckedAt are enqueued
 * 
 * Benefits:
 * - No API calls in reverse sync (no rate limit contention)
 * - Single place for rate limit handling (shipment-sync worker)
 * - Time-based filtering prevents redundant re-enqueueing
 * - Progress is automatic as queue drains over time
 * 
 * MICRO-BATCH STRATEGY (added Dec 2025):
 * - Only enqueue 10 shipments per cycle (not all 1,400)
 * - Only enqueue if low-priority queue is empty (LLEN check)
 * - Use 6-hour freshness window (not 5 minutes)
 * - Full rotation through all on_hold shipments takes ~2.5 hours at 10/min
 */
const REVERSE_SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours - only re-check shipments not verified in 6 hours
const REVERSE_SYNC_BATCH_SIZE = 10; // Only enqueue 10 shipments per cycle

export async function reverseSyncOnHoldShipments(): Promise<{ queued: number; skipped: number }> {
  // GATE: Check if low-priority queue is empty before adding more
  // This prevents flooding - if previous batch isn't processed, don't add more
  const queueLengths = await getShipmentSyncQueueLengthByPriority();
  if (queueLengths.low > 0) {
    log(`[reverse-sync] Low-priority queue has ${queueLengths.low} messages, skipping this cycle (waiting for queue to drain)`);
    return { queued: 0, skipped: 0 };
  }
  
  // Calculate the threshold time - shipments checked before this time are "stale"
  const staleThreshold = new Date(Date.now() - REVERSE_SYNC_COOLDOWN_MS);
  
  // Get on_hold shipments that need verification (never checked OR checked > 6 hours ago)
  // Use reverseSyncLastCheckedAt as progress cursor - oldest unchecked first
  const allOnHoldShipments = await db
    .select()
    .from(shipments)
    .where(
      sql`${shipments.shipmentStatus} = 'on_hold' AND (
        ${shipments.reverseSyncLastCheckedAt} IS NULL OR 
        ${shipments.reverseSyncLastCheckedAt} < ${staleThreshold}
      )`
    )
    .orderBy(
      // NULL values first (never checked), then oldest checked
      sql`${shipments.reverseSyncLastCheckedAt} IS NOT NULL`,
      asc(shipments.reverseSyncLastCheckedAt)
    )
    .limit(REVERSE_SYNC_BATCH_SIZE); // Only fetch the batch we need
  
  const batchCount = allOnHoldShipments.length;
  
  if (batchCount === 0) {
    log('[reverse-sync] No stale on_hold shipments to verify (all checked within 6 hours)');
    return { queued: 0, skipped: 0 };
  }
  
  // Filter to only shipments with ShipStation ID (can't sync without it)
  const syncableShipments = allOnHoldShipments.filter(s => s.shipmentId);
  const skippedNoId = batchCount - syncableShipments.length;
  
  if (syncableShipments.length === 0) {
    log(`[reverse-sync] ${batchCount} on_hold shipments in batch, but none have ShipStation ID`);
    return { queued: 0, skipped: batchCount };
  }
  
  // Build messages for batch enqueue
  const messages = syncableShipments.map(shipment => ({
    reason: 'reverse_sync' as const,
    orderNumber: shipment.orderNumber || undefined,
    shipmentId: shipment.shipmentId!,
    trackingNumber: shipment.trackingNumber || undefined,
    enqueuedAt: Date.now(),
  }));
  
  // Batch enqueue - dedup will filter out shipments already in queue from forward sync
  const enqueuedCount = await enqueueShipmentSyncBatch(messages);
  const dedupedCount = syncableShipments.length - enqueuedCount;
  
  log(`[reverse-sync] Enqueued ${enqueuedCount} of ${batchCount} on_hold shipments (batch of ${REVERSE_SYNC_BATCH_SIZE}, ${dedupedCount} already in queue, ${skippedNoId} missing ID)`);
  
  // Update stats
  workerStats.reverseSyncProcessed += enqueuedCount;
  workerStats.lastReverseSyncAt = new Date();
  
  // Update progress tracking for UI
  reverseSyncProgress = {
    inProgress: false, // Not really "in progress" anymore - just enqueued
    currentPage: 1,
    totalStaleAtStart: batchCount,
    checkedThisRun: 0, // Will be updated by sync worker
    updatedThisRun: enqueuedCount,
    startedAt: new Date(),
  };
  
  return { queued: enqueuedCount, skipped: dedupedCount + skippedNoId };
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
      
      // Re-enabled with micro-batch strategy (Dec 2025):
      // - Only enqueues 10 shipments per cycle
      // - Checks if low-priority queue is empty before adding more
      // - Uses 6-hour freshness window
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
