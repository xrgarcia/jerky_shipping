/**
 * QC Item Hydrator Worker
 * 
 * Scheduled worker that runs every 1 minute to populate shipment_qc_items
 * for "Ready to Fulfill" shipments (on_hold + MOVE OVER tag).
 * 
 * One-time hydration per shipment - once QC items exist, the shipment is skipped.
 */

import { runHydration, getHydrationStatus, backfillFootprints } from '../services/qc-item-hydrator';

const log = (message: string) => console.log(`[qc-hydrator-worker] ${message}`);

// Worker state
let workerStatus: 'sleeping' | 'running' = 'sleeping';
let workerInterval: NodeJS.Timeout | null = null;

// Worker statistics
let workerStats = {
  totalRunsCount: 0,
  lastRunAt: null as Date | null,
  lastRunStats: null as {
    shipmentsProcessed: number;
    shipmentsSkipped: number;
    totalItemsCreated: number;
    footprintsComplete: number;
    footprintsNew: number;
    footprintsPendingCategorization: number;
    errors: string[];
  } | null,
  workerStartedAt: new Date(),
};

/**
 * Get worker status for monitoring
 */
export function getQCHydratorWorkerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

/**
 * Get worker statistics for monitoring
 */
export function getQCHydratorWorkerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Main worker tick - runs hydration
 */
async function workerTick(): Promise<void> {
  if (workerStatus === 'running') {
    log('Previous run still in progress, skipping');
    return;
  }
  
  workerStatus = 'running';
  const startTime = Date.now();
  
  try {
    const stats = await runHydration(50); // Process up to 50 shipments per tick
    
    workerStats.totalRunsCount++;
    workerStats.lastRunAt = new Date();
    workerStats.lastRunStats = stats;
    
    // Only log if there was work to do
    if (stats.shipmentsProcessed > 0 || stats.errors.length > 0) {
      const duration = Date.now() - startTime;
      log(`Run #${workerStats.totalRunsCount}: ${stats.shipmentsProcessed} shipments, ${stats.totalItemsCreated} items in ${duration}ms`);
      
      if (stats.errors.length > 0) {
        log(`Errors: ${stats.errors.slice(0, 5).join('; ')}${stats.errors.length > 5 ? '...' : ''}`);
      }
    }
    
  } catch (error) {
    log(`Worker error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    workerStatus = 'sleeping';
  }
}

/**
 * Start the QC hydrator worker
 * @param intervalMs Interval in milliseconds (default: 1 minute = 60000ms)
 */
export function startQCHydratorWorker(intervalMs: number = 60000): void {
  if (workerInterval) {
    log('Worker already running');
    return;
  }
  
  log(`Worker started (interval: ${intervalMs}ms = ${intervalMs / 1000} seconds)`);
  workerStats.workerStartedAt = new Date();
  
  // Run backfill for shipments missing footprints (one-time on startup)
  setImmediate(async () => {
    log('Running footprint backfill on startup...');
    await backfillFootprints(500); // Process up to 500 shipments
    // Then run normal hydration tick
    await workerTick();
  });
  
  // Then run on interval
  workerInterval = setInterval(() => workerTick(), intervalMs);
}

/**
 * Stop the QC hydrator worker
 */
export function stopQCHydratorWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    log('Worker stopped');
  }
}

/**
 * Trigger a manual run of the hydrator
 */
export async function triggerManualHydration(batchSize: number = 50): Promise<{
  shipmentsProcessed: number;
  shipmentsSkipped: number;
  totalItemsCreated: number;
  footprintsComplete: number;
  footprintsNew: number;
  footprintsPendingCategorization: number;
  errors: string[];
}> {
  log('Manual hydration triggered');
  return await runHydration(batchSize);
}

/**
 * Get current hydration status for monitoring
 */
export async function getQCHydratorStatus(): Promise<{
  workerStatus: 'sleeping' | 'running';
  pendingCount: number;
  cacheStats: {
    productCount: number;
    kitCount: number;
    stockCheckDate: string | null;
    snapshotTimestamp: string | null;
  };
  workerStats: typeof workerStats;
}> {
  const hydrationStatus = await getHydrationStatus();
  return {
    workerStatus,
    pendingCount: hydrationStatus.pendingCount,
    cacheStats: hydrationStatus.cacheStats,
    workerStats,
  };
}
