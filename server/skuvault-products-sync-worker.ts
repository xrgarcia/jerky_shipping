/**
 * SkuVault Products Sync Worker
 * 
 * Runs hourly to check for new product data in the reporting database.
 * When new data is detected (new stock_check_date), it triggers a full
 * refresh of the local skuvault_products table.
 * 
 * The reporting database refreshes once per day, so hourly checks ensure
 * we pick up new data within an hour of it becoming available.
 */

import {
  checkAndSync,
  getSyncStatus,
  syncSkuvaultProducts,
  syncPhysicalLocations,
} from './services/skuvault-products-sync-service';

const log = (message: string) => console.log(`[skuvault-products-worker] ${message}`);

// Worker status tracking
let workerStatus: 'sleeping' | 'running' = 'sleeping';
let workerStats = {
  totalRunsCount: 0,
  successfulSyncsCount: 0,
  lastRunAt: null as Date | null,
  lastSyncAt: null as Date | null,
  lastStockCheckDate: null as string | null,
  lastProductCount: 0,
  workerStartedAt: new Date(),
  // Location sync stats
  lastLocationSyncAt: null as Date | null,
  lastLocationSyncUpdated: 0,
  lastLocationSyncBrands: 0,
};

/**
 * Get current worker status
 */
export function getSkuvaultProductsWorkerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

/**
 * Get worker statistics
 */
export function getSkuvaultProductsWorkerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Run a sync check cycle
 */
async function runSyncCheck(): Promise<void> {
  if (workerStatus === 'running') {
    log('Already running, skipping this cycle');
    return;
  }
  
  workerStatus = 'running';
  workerStats.lastRunAt = new Date();
  workerStats.totalRunsCount++;
  
  try {
    log('Checking for new product data...');
    
    const result = await checkAndSync();
    
    if (result.synced) {
      workerStats.successfulSyncsCount++;
      workerStats.lastSyncAt = new Date();
      workerStats.lastStockCheckDate = result.stockCheckDate;
      workerStats.lastProductCount = result.productCount;
      log(`Sync completed: ${result.reason}`);
    } else {
      log(`No sync needed: ${result.reason}`);
    }
    
    // Always run physical location sync (independent of product catalog sync)
    log('Running physical location sync...');
    const locationResult = await syncPhysicalLocations();
    
    workerStats.lastLocationSyncAt = new Date();
    workerStats.lastLocationSyncUpdated = locationResult.locationsUpdated;
    workerStats.lastLocationSyncBrands = locationResult.brandsProcessed;
    
    if (locationResult.success) {
      log(`Location sync completed: ${locationResult.locationsUpdated} updated, ${locationResult.locationsUnchanged} unchanged`);
    } else {
      log(`Location sync completed with errors: ${locationResult.errors.join(', ')}`);
    }
    
  } catch (error) {
    log(`Error during sync check: ${error}`);
    console.error('[skuvault-products-worker] Full error:', error);
  } finally {
    workerStatus = 'sleeping';
  }
}

/**
 * Force a manual sync (bypasses date check)
 */
export async function forceSync(): Promise<{
  success: boolean;
  productCount: number;
  stockCheckDate: string | null;
  duration: number;
}> {
  if (workerStatus === 'running') {
    log('Worker is already running, cannot force sync');
    return {
      success: false,
      productCount: 0,
      stockCheckDate: null,
      duration: 0,
    };
  }
  
  workerStatus = 'running';
  
  try {
    log('Force sync initiated...');
    const result = await syncSkuvaultProducts();
    
    if (result.success) {
      workerStats.successfulSyncsCount++;
      workerStats.lastSyncAt = new Date();
      workerStats.lastStockCheckDate = result.stockCheckDate;
      workerStats.lastProductCount = result.productCount;
    }
    
    return result;
  } finally {
    workerStatus = 'sleeping';
  }
}

/**
 * Get current sync status from the service
 */
export async function getProductsSyncStatus() {
  return getSyncStatus();
}

/**
 * Start the SkuVault products sync worker
 * @param intervalMs Interval in milliseconds (default: 1 hour = 3600000ms)
 */
export function startSkuvaultProductsSyncWorker(intervalMs: number = 3600000): void {
  log(`Worker started (interval: ${intervalMs}ms = ${intervalMs / 3600000} hours)`);
  
  // Run immediately on startup
  setImmediate(() => runSyncCheck());
  
  // Then run on interval
  setInterval(() => runSyncCheck(), intervalMs);
}
