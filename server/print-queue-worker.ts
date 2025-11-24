import { storage } from './storage';
import { db } from './db';
import { printQueue } from '@shared/schema';
import { eq, and, isNull, or } from 'drizzle-orm';
import { broadcastPrintQueueUpdate, broadcastQueueStatus } from './websocket';
import { getLabelsForShipment, createLabel as createShipStationLabel } from './utils/shipstation-api';

const log = (message: string) => console.log(`[print-queue] ${message}`);

// Retry configuration
const MAX_RETRIES = 5; // Maximum retry attempts before marking as failed
const BACKOFF_BASE_MS = 60000; // Base backoff: 1 minute

/**
 * Calculate exponential backoff delay in milliseconds
 * Returns delay in milliseconds for the given retry count
 */
function getBackoffDelay(retryCount: number): number {
  // Exponential backoff: 1min, 2min, 4min, 8min, 16min
  return BACKOFF_BASE_MS * Math.pow(2, retryCount);
}

/**
 * Check if a job is within its backoff period and should be skipped
 */
function isInBackoffPeriod(job: { retryCount: number; lastRetryAt: Date | null }): boolean {
  if (!job.lastRetryAt || job.retryCount === 0) {
    return false; // First attempt or no retry yet
  }
  
  const backoffDelay = getBackoffDelay(job.retryCount - 1); // Use previous retry count for delay
  const nextRetryTime = new Date(job.lastRetryAt.getTime() + backoffDelay);
  const now = new Date();
  
  return now < nextRetryTime;
}

/**
 * Handle job failure with retry logic
 * Returns true if job should be retried, false if permanently failed
 */
async function handleJobFailure(job: any, errorMessage: string): Promise<boolean> {
  const newRetryCount = job.retryCount + 1;
  
  // Check if we've exceeded max retries
  if (newRetryCount >= MAX_RETRIES) {
    // Mark as permanently failed
    log(`[${job.id}] Max retries exceeded, marking as failed`);
    const updatedJob = await storage.updatePrintJob(job.id, {
      status: 'failed',
      error: `Max retries (${MAX_RETRIES}) exceeded: ${errorMessage}`,
      retryCount: newRetryCount,
      lastRetryAt: new Date()
    });
    
    if (updatedJob) {
      broadcastPrintQueueUpdate({ 
        type: 'job_failed', 
        job: updatedJob 
      });
    }
    
    return false; // Do not retry
  } else {
    // Update retry count and backoff timestamp
    const nextBackoff = getBackoffDelay(newRetryCount);
    const nextRetryTime = new Date(Date.now() + nextBackoff);
    log(`[${job.id}] Retry scheduled for ${nextRetryTime.toISOString()} (attempt ${newRetryCount + 1}/${MAX_RETRIES})`);
    
    const updatedJob = await storage.updatePrintJob(job.id, {
      retryCount: newRetryCount,
      lastRetryAt: new Date(),
      error: `Retry ${newRetryCount}/${MAX_RETRIES}: ${errorMessage}`
    });
    
    if (updatedJob) {
      broadcastPrintQueueUpdate({ 
        type: 'job_retry_scheduled',
        job: updatedJob,
        nextRetryAt: nextRetryTime.toISOString()
      });
    }
    
    return true; // Retry later
  }
}

// Global worker status
let workerStatus: 'sleeping' | 'running' = 'sleeping';
let isProcessing = false; // Guard against overlapping executions

// Worker statistics
let workerStats = {
  totalProcessedCount: 0,
  lastProcessedCount: 0,
  workerStartedAt: new Date(),
  lastCompletedAt: null as Date | null,
};

export function getPrintQueueWorkerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

export function getPrintQueueWorkerStats() {
  // Don't return stats until first poll completes
  if (workerStats.lastCompletedAt === null) {
    return undefined;
  }
  
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Process print queue jobs
 * For each queued job:
 * 1. Check if labelUrl is already set (from packing completion)
 * 2. If not, fetch/create label from ShipStation
 * 3. Update job with labelUrl
 * 4. Broadcast update to frontend for auto-print
 */
export async function processPrintQueue(): Promise<number> {
  // Guard against overlapping executions - keep status as running
  if (isProcessing) {
    log('Previous processing still running, skipping this cycle');
    return 0;
  }
  
  isProcessing = true;
  
  try {
    workerStatus = 'running';
    
    // Get all queued jobs ordered by queue time (FIFO)
    const queuedJobs = await db
      .select()
      .from(printQueue)
      .where(eq(printQueue.status, 'queued'))
      .orderBy(printQueue.queuedAt)
      .limit(10); // Process up to 10 at a time

    if (queuedJobs.length === 0) {
      workerStats.lastProcessedCount = 0;
      workerStats.lastCompletedAt = new Date();
      log('No queued jobs to process');
      return 0;
    }

    log(`Processing ${queuedJobs.length} print job(s)`);
    let processedCount = 0;

    for (const job of queuedJobs) {
      try {
        // Check if job is in backoff period
        if (isInBackoffPeriod(job)) {
          const nextRetry = new Date(job.lastRetryAt!.getTime() + getBackoffDelay(job.retryCount - 1));
          log(`[${job.id}] In backoff period (retry ${job.retryCount}/${MAX_RETRIES}), next retry at ${nextRetry.toISOString()}`);
          continue; // Skip this job for now
        }
        
        // If job already has labelUrl, nothing to do (ready for print)
        if (job.labelUrl) {
          log(`[${job.id}] Already has labelUrl, ready for printing`);
          processedCount++;
          continue;
        }

        // Get the order to fetch shipments
        const order = await storage.getOrder(job.orderId);
        if (!order) {
          log(`[${job.id}] Order ${job.orderId} not found (attempt ${job.retryCount + 1}/${MAX_RETRIES})`);
          await handleJobFailure(job, 'Order not found');
          processedCount++;
          continue;
        }

        // Get shipments for this order
        const shipments = await storage.getShipmentsByOrderId(order.id);
        if (shipments.length === 0) {
          log(`[${job.id}] No shipments found for order ${order.orderNumber} (attempt ${job.retryCount + 1}/${MAX_RETRIES})`);
          await handleJobFailure(job, 'No shipment found');
          processedCount++;
          continue;
        }

        const shipment = shipments[0];

        // Validate shipment has ShipStation ID
        if (!shipment.shipmentId) {
          log(`[${job.id}] Shipment missing shipmentId (attempt ${job.retryCount + 1}/${MAX_RETRIES})`);
          await handleJobFailure(job, 'No ShipStation shipment ID');
          processedCount++;
          continue;
        }

        let labelUrl: string | null = null;

        // Check if shipment already has labelUrl in database
        if (shipment.labelUrl) {
          log(`[${job.id}] Using existing label from shipment: ${shipment.labelUrl}`);
          labelUrl = shipment.labelUrl;
        } else {
          // Try to fetch existing label from ShipStation
          log(`[${job.id}] Fetching labels from ShipStation for shipment ${shipment.shipmentId}`);
          const existingLabels = await getLabelsForShipment(shipment.shipmentId);
          
          if (existingLabels.length > 0) {
            log(`[${job.id}] Found ${existingLabels.length} existing label(s) in ShipStation`);
            const label = existingLabels[0];
            labelUrl = label.label_download?.href || label.label_download || null;
            
            if (labelUrl) {
              // Save label URL to shipment for future use
              await storage.updateShipment(shipment.id, { labelUrl });
              log(`[${job.id}] Saved label URL to shipment`);
            }
          } else {
            // No existing label - need to create one
            log(`[${job.id}] No existing label found, creating new label...`);
            
            if (!shipment.shipmentData) {
              log(`[${job.id}] Shipment missing shipmentData (attempt ${job.retryCount + 1}/${MAX_RETRIES})`);
              await handleJobFailure(job, 'No ShipStation data for label creation');
              processedCount++;
              continue;
            }

            // Strip ShipStation-managed fields
            const cleanShipmentData: any = { ...shipment.shipmentData };
            delete cleanShipmentData.shipment_id;
            delete cleanShipmentData.label_id;
            delete cleanShipmentData.created_at;
            delete cleanShipmentData.modified_at;

            const labelData = await createShipStationLabel(cleanShipmentData);
            labelUrl = labelData.label_download?.href || labelData.label_download || labelData.pdf_url || labelData.href || null;

            if (labelUrl) {
              await storage.updateShipment(shipment.id, { labelUrl });
              log(`[${job.id}] Created and saved new label`);
            }
          }
        }

        if (!labelUrl) {
          log(`[${job.id}] Failed to get label URL (attempt ${job.retryCount + 1}/${MAX_RETRIES})`);
          await handleJobFailure(job, 'No label URL returned from ShipStation');
          processedCount++;
          continue;
        }

        // Update print job with label URL and reset retry count on success
        const updatedJob = await storage.updatePrintJob(job.id, { 
          labelUrl,
          retryCount: 0, // Reset on success
          lastRetryAt: null, // Clear backoff
          error: null // Clear error
        });
        
        if (updatedJob) {
          log(`[${job.id}] Successfully updated job with label URL`);
          
          // Broadcast update to trigger auto-print in frontend
          broadcastPrintQueueUpdate({ 
            type: 'job_ready', 
            job: updatedJob 
          });
        }

        processedCount++;

      } catch (error: any) {
        log(`[${job.id}] Error processing job (attempt ${job.retryCount + 1}/${MAX_RETRIES}): ${error.message}`);
        await handleJobFailure(job, error.message || 'Unknown error');
        processedCount++;
      }
    }

    workerStats.totalProcessedCount += processedCount;
    workerStats.lastProcessedCount = processedCount;
    workerStats.lastCompletedAt = new Date();

    log(`Processed ${processedCount} job(s)`);
    return processedCount;

  } catch (error: any) {
    log(`Error in processPrintQueue: ${error.message}`);
    // Still update stats even on error
    workerStats.lastCompletedAt = new Date();
    return 0;
  } finally {
    workerStatus = 'sleeping';
    isProcessing = false;
    
    // Broadcast final status with stats
    const stats = getPrintQueueWorkerStats();
    broadcastQueueStatus({ 
      printQueueWorkerStatus: 'sleeping',
      printQueueWorkerStats: stats
    });
  }
}

// Interval management
let workerInterval: NodeJS.Timeout | undefined;

/**
 * Start the print queue worker
 * @param intervalMs - Polling interval in milliseconds (default: 10 seconds)
 */
export function startPrintQueueWorker(intervalMs: number = 10000): void {
  if (workerInterval) {
    log('Print queue worker already running');
    return;
  }

  log(`Worker started (interval: ${intervalMs}ms = ${intervalMs / 1000} seconds)`);
  
  // Process immediately on start, then on interval
  processPrintQueue();
  
  workerInterval = setInterval(() => {
    processPrintQueue();
  }, intervalMs);
}

/**
 * Stop the print queue worker
 */
export function stopPrintQueueWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = undefined;
    log('Print queue worker stopped');
  }
}
