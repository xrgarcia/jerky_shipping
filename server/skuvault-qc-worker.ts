import { 
  dequeueSkuVaultQCSyncBatch, 
  removeSkuVaultQCFromInflight,
  requeueSkuVaultQCSyncMessages,
  getSkuVaultQCSyncQueueLength,
  type SkuVaultQCSyncMessage 
} from './utils/queue';
import { skuVaultService, SkuVaultError } from './services/skuvault-service';
import { broadcastQueueStatus } from './websocket';

const log = (message: string) => console.log(`[skuvault-qc] ${message}`);

// Worker state
let workerStatus: 'sleeping' | 'running' | 'error' = 'sleeping';
let workerIntervalId: NodeJS.Timeout | null = null;

// Worker statistics
let workerStats = {
  totalProcessed: 0,
  successCount: 0,
  failCount: 0,
  lastProcessedAt: null as Date | null,
  workerStartedAt: new Date(),
  errorsCount: 0,
  lastError: null as string | null,
};

const MAX_RETRIES = 3;
const BATCH_SIZE = 10;

export function getSkuVaultQCWorkerStatus() {
  return workerStatus;
}

export function getSkuVaultQCWorkerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Process a single QC sync message - send scan to SkuVault
 */
async function processQCMessage(message: SkuVaultQCSyncMessage): Promise<boolean> {
  try {
    log(`Processing QC scan: ${message.sku} x${message.quantity} for order ${message.orderNumber}`);
    
    // Call SkuVault QC API to mark item as scanned
    const success = await skuVaultService.scanQCItem(
      message.saleId,
      message.sku,
      message.quantity
    );
    
    if (success) {
      log(`QC scan successful: ${message.sku} for ${message.orderNumber}`);
      workerStats.successCount++;
      return true;
    } else {
      log(`QC scan failed: ${message.sku} for ${message.orderNumber} (no error thrown)`);
      workerStats.failCount++;
      return false;
    }
  } catch (error: any) {
    log(`QC scan error for ${message.sku}: ${error.message}`);
    workerStats.errorsCount++;
    workerStats.lastError = error.message;
    
    // Check if it's an auth error (should re-authenticate)
    if (error instanceof SkuVaultError && error.statusCode === 401) {
      log('SkuVault authentication expired, will retry after re-auth');
      return false;
    }
    
    return false;
  }
}

/**
 * Main worker function - processes QC queue
 */
async function processQueue(): Promise<void> {
  if (workerStatus === 'running') {
    return; // Already running
  }
  
  workerStatus = 'running';
  
  try {
    const queueLength = await getSkuVaultQCSyncQueueLength();
    
    if (queueLength === 0) {
      workerStatus = 'sleeping';
      return;
    }
    
    log(`Processing ${Math.min(queueLength, BATCH_SIZE)} of ${queueLength} QC sync messages`);
    
    // Dequeue batch of messages
    const messages = await dequeueSkuVaultQCSyncBatch(BATCH_SIZE);
    
    if (messages.length === 0) {
      workerStatus = 'sleeping';
      return;
    }
    
    const toRequeue: SkuVaultQCSyncMessage[] = [];
    
    for (const message of messages) {
      // Check retry count
      if ((message.retryCount || 0) >= MAX_RETRIES) {
        log(`Dropping message after ${MAX_RETRIES} retries: ${message.sku} for ${message.orderNumber}`);
        await removeSkuVaultQCFromInflight(message);
        workerStats.failCount++;
        continue;
      }
      
      const success = await processQCMessage(message);
      
      if (success) {
        await removeSkuVaultQCFromInflight(message);
        workerStats.totalProcessed++;
      } else {
        // Add to requeue list
        toRequeue.push(message);
      }
    }
    
    // Requeue failed messages
    if (toRequeue.length > 0) {
      log(`Requeueing ${toRequeue.length} failed message(s) for retry`);
      await requeueSkuVaultQCSyncMessages(toRequeue);
    }
    
    workerStats.lastProcessedAt = new Date();
    
    // Broadcast queue status update
    try {
      broadcastQueueStatus({
        skuvaultQCQueue: {
          length: await getSkuVaultQCSyncQueueLength(),
          status: workerStatus,
          stats: workerStats,
        }
      });
    } catch (e) {
      // Ignore broadcast errors
    }
    
    workerStatus = 'sleeping';
  } catch (error: any) {
    log(`Worker error: ${error.message}`);
    workerStats.errorsCount++;
    workerStats.lastError = error.message;
    workerStatus = 'error';
    
    // Reset to sleeping after a brief pause
    setTimeout(() => {
      workerStatus = 'sleeping';
    }, 5000);
  }
}

/**
 * Start the SkuVault QC worker
 * @param intervalMs - How often to check the queue (default: 5 seconds)
 */
export function startSkuVaultQCWorker(intervalMs: number = 5000): void {
  log(`Worker started (interval: ${intervalMs}ms)`);
  
  workerStats.workerStartedAt = new Date();
  
  // Initial run
  processQueue().catch(err => {
    log(`Initial queue processing failed: ${err.message}`);
  });
  
  // Start polling
  workerIntervalId = setInterval(() => {
    processQueue().catch(err => {
      log(`Queue processing failed: ${err.message}`);
    });
  }, intervalMs);
}

/**
 * Stop the worker (for graceful shutdown)
 */
export function stopSkuVaultQCWorker(): void {
  if (workerIntervalId) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
    log('Worker stopped');
  }
}
