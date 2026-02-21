import { db } from '../db';
import { rateCheckQueue, shipments } from '@shared/schema';
import type { InsertRateCheckQueue } from '@shared/schema';
import { eq, and, lte, or, asc, sql } from 'drizzle-orm';
import logger, { withOrder } from '../utils/logger';
import { withSpan } from '../utils/tracing';
import { smartCarrierRateService } from './smart-carrier-rate-service';

const POLL_INTERVAL_MS = 5000;
const EXPONENTIAL_BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 300000;

let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info', ctx?: Record<string, any>) {
  const prefix = '[RateCheckQueue]';
  logger[level](`${prefix} ${msg}`, ctx || {});
}

function calculateBackoffMs(retryCount: number): number {
  const backoff = EXPONENTIAL_BACKOFF_BASE_MS * Math.pow(2, retryCount);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

export interface EnqueueRateCheckOptions {
  shipmentId: string;
  localShipmentId: string;
  orderNumber?: string;
  serviceCode?: string;
  destinationPostalCode?: string;
  maxRetries?: number;
}

export async function enqueueRateCheck(options: EnqueueRateCheckOptions): Promise<number> {
  const row: InsertRateCheckQueue = {
    shipmentId: options.shipmentId,
    localShipmentId: options.localShipmentId,
    orderNumber: options.orderNumber ?? null,
    serviceCode: options.serviceCode ?? null,
    destinationPostalCode: options.destinationPostalCode ?? null,
    status: 'queued',
    retryCount: 0,
    maxRetries: options.maxRetries ?? 5,
    lastError: null,
    nextRetryAt: null,
    processedAt: null,
    completedAt: null,
    httpStatusCode: null,
    httpResponse: null,
  };

  const [inserted] = await db.insert(rateCheckQueue).values(row).returning({ id: rateCheckQueue.id });
  log(`Enqueued rate check job #${inserted.id} for ${options.shipmentId}`, 'info', withOrder(options.orderNumber, options.shipmentId));
  return inserted.id;
}

export async function getRateCheckQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
}> {
  const rows = await db
    .select({
      status: rateCheckQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(rateCheckQueue)
    .groupBy(rateCheckQueue.status);

  const stats = { queued: 0, processing: 0, completed: 0, failed: 0, deadLetter: 0 };
  for (const row of rows) {
    if (row.status === 'queued') stats.queued = row.count;
    else if (row.status === 'processing') stats.processing = row.count;
    else if (row.status === 'completed') stats.completed = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
    else if (row.status === 'dead_letter') stats.deadLetter = row.count;
  }
  return stats;
}

async function processNextJob(): Promise<boolean> {
  const now = new Date();

  const [job] = await db
    .select()
    .from(rateCheckQueue)
    .where(
      or(
        eq(rateCheckQueue.status, 'queued'),
        and(
          eq(rateCheckQueue.status, 'failed'),
          lte(rateCheckQueue.nextRetryAt, now)
        )
      )
    )
    .orderBy(asc(rateCheckQueue.createdAt))
    .limit(1);

  if (!job) return false;

  return withSpan('rate_check', 'queue_worker', 'process_job', async (span) => {
    const orderNumber = job.orderNumber ?? undefined;
    const jobCtx = withOrder(orderNumber, job.shipmentId, { queueItemId: String(job.id) });

    await db.update(rateCheckQueue)
      .set({ status: 'processing', processedAt: now })
      .where(eq(rateCheckQueue.id, job.id));

    try {
      log(`Processing job #${job.id} for ${job.shipmentId} (attempt ${job.retryCount + 1}/${job.maxRetries})`, 'info', jobCtx);

      const [shipment] = await db
        .select()
        .from(shipments)
        .where(eq(shipments.id, job.localShipmentId))
        .limit(1);

      if (!shipment) {
        throw new Error(`Shipment not found in local DB: ${job.localShipmentId}`);
      }

      if (shipment.rateCheckStatus === 'complete' || shipment.rateCheckStatus === 'skipped') {
        log(`Job #${job.id}: Rate check already ${shipment.rateCheckStatus}, marking completed`, 'info', jobCtx);
        await db.update(rateCheckQueue)
          .set({
            status: 'completed',
            completedAt: new Date(),
            lastError: null,
          })
          .where(eq(rateCheckQueue.id, job.id));
        return true;
      }

      await db
        .update(shipments)
        .set({
          rateCheckStatus: 'pending',
          rateCheckAttemptedAt: new Date(),
          rateCheckError: null,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, job.localShipmentId));

      const result = await smartCarrierRateService.analyzeAndSave(shipment);

      if (result.skipped) {
        log(`Job #${job.id}: Rate check skipped for ${job.shipmentId}: ${result.error}`, 'info', jobCtx);
        await db.update(rateCheckQueue)
          .set({
            status: 'completed',
            completedAt: new Date(),
            lastError: result.error ?? null,
          })
          .where(eq(rateCheckQueue.id, job.id));

        await db
          .update(shipments)
          .set({
            rateCheckStatus: 'skipped',
            rateCheckError: result.error ?? null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, job.localShipmentId));

        try {
          const { queueLifecycleEvaluation } = await import('./lifecycle-service');
          await queueLifecycleEvaluation(job.localShipmentId, 'rate_check_skipped', orderNumber);
        } catch (lcErr: any) {
          log(`Job #${job.id} lifecycle re-eval after skip failed (non-fatal): ${lcErr.message}`, 'warn', jobCtx);
        }

        return true;
      }

      if (result.success) {
        await db.update(rateCheckQueue)
          .set({
            status: 'completed',
            completedAt: new Date(),
            lastError: null,
            httpStatusCode: 200,
            httpResponse: result.analysis ?? null,
          })
          .where(eq(rateCheckQueue.id, job.id));

        await db
          .update(shipments)
          .set({
            rateCheckStatus: 'complete',
            rateCheckError: null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, job.localShipmentId));

        try {
          const { queueLifecycleEvaluation } = await import('./lifecycle-service');
          await queueLifecycleEvaluation(job.localShipmentId, 'rate_check_queue_complete', orderNumber);
        } catch (lcErr: any) {
          log(`Job #${job.id} lifecycle re-eval failed (non-fatal): ${lcErr.message}`, 'warn', jobCtx);
        }

        log(`Job #${job.id} completed: rate check successful`, 'info', jobCtx);
        return true;
      } else {
        const errorMsg = result.error || 'Rate check returned unsuccessful result';
        const isRateLimit = errorMsg.toLowerCase().includes('429') || errorMsg.toLowerCase().includes('rate limit');
        const newRetryCount = isRateLimit ? job.retryCount : job.retryCount + 1;

        if (isRateLimit) {
          const waitMs = 65000;
          const nextRetry = new Date(Date.now() + waitMs);
          log(`Job #${job.id} rate limited, will retry at ${nextRetry.toISOString()}`, 'warn', jobCtx);
          await db.update(rateCheckQueue)
            .set({
              status: 'failed',
              lastError: `RATE_LIMITED: ${errorMsg}`,
              retryCount: newRetryCount,
              nextRetryAt: nextRetry,
              httpStatusCode: 429,
            })
            .where(eq(rateCheckQueue.id, job.id));
          return true;
        }

        if (newRetryCount >= job.maxRetries) {
          log(`Job #${job.id} exhausted all ${job.maxRetries} retries, dead-lettering: ${errorMsg}`, 'error', jobCtx);
          await db.update(rateCheckQueue)
            .set({
              status: 'dead_letter',
              lastError: errorMsg,
              retryCount: newRetryCount,
            })
            .where(eq(rateCheckQueue.id, job.id));

          await db.update(shipments)
            .set({
              rateCheckStatus: 'failed',
              rateCheckError: `Rate check queue exhausted after ${job.maxRetries} attempts: ${errorMsg}`,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, job.localShipmentId));
        } else {
          const backoffMs = calculateBackoffMs(newRetryCount);
          const nextRetry = new Date(Date.now() + backoffMs);
          log(`Job #${job.id} failed (attempt ${newRetryCount}/${job.maxRetries}), retrying at ${nextRetry.toISOString()}: ${errorMsg}`, 'warn', jobCtx);
          await db.update(rateCheckQueue)
            .set({
              status: 'failed',
              lastError: errorMsg,
              retryCount: newRetryCount,
              nextRetryAt: nextRetry,
            })
            .where(eq(rateCheckQueue.id, job.id));
        }

        return true;
      }

    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      const isRateLimit = errorMsg.toLowerCase().includes('429') || errorMsg.toLowerCase().includes('rate limit');
      const newRetryCount = isRateLimit ? job.retryCount : job.retryCount + 1;

      if (isRateLimit) {
        const waitMs = 65000;
        const nextRetry = new Date(Date.now() + waitMs);
        log(`Job #${job.id} rate limited (exception), will retry at ${nextRetry.toISOString()}`, 'warn', jobCtx);
        await db.update(rateCheckQueue)
          .set({
            status: 'failed',
            lastError: `RATE_LIMITED: ${errorMsg}`,
            retryCount: newRetryCount,
            nextRetryAt: nextRetry,
            httpStatusCode: 429,
          })
          .where(eq(rateCheckQueue.id, job.id));
        return true;
      }

      if (newRetryCount >= job.maxRetries) {
        log(`Job #${job.id} exhausted all ${job.maxRetries} retries (exception), dead-lettering: ${errorMsg}`, 'error', jobCtx);
        await db.update(rateCheckQueue)
          .set({
            status: 'dead_letter',
            lastError: errorMsg,
            retryCount: newRetryCount,
          })
          .where(eq(rateCheckQueue.id, job.id));

        await db.update(shipments)
          .set({
            rateCheckStatus: 'failed',
            rateCheckError: `Rate check queue exhausted after ${job.maxRetries} attempts: ${errorMsg}`,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, job.localShipmentId));
      } else {
        const backoffMs = calculateBackoffMs(newRetryCount);
        const nextRetry = new Date(Date.now() + backoffMs);
        log(`Job #${job.id} failed (attempt ${newRetryCount}/${job.maxRetries}, exception), retrying at ${nextRetry.toISOString()}: ${errorMsg}`, 'warn', jobCtx);
        await db.update(rateCheckQueue)
          .set({
            status: 'failed',
            lastError: errorMsg,
            retryCount: newRetryCount,
            nextRetryAt: nextRetry,
          })
          .where(eq(rateCheckQueue.id, job.id));
      }

      return true;
    }
  }, { orderNumber: job.orderNumber ?? undefined, shipmentId: job.shipmentId, queueItemId: String(job.id) });
}

async function recoverStaleProcessingJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const result = await db.update(rateCheckQueue)
    .set({ status: 'queued', lastError: 'Recovered from stale processing state (server restart)' })
    .where(
      and(
        eq(rateCheckQueue.status, 'processing'),
        lte(rateCheckQueue.processedAt, staleThreshold)
      )
    )
    .returning({ id: rateCheckQueue.id });

  if (result.length > 0) {
    log(`Recovered ${result.length} stale processing jobs back to queued`);
  }
  return result.length;
}

async function pollLoop() {
  while (workerRunning) {
    try {
      const processed = await processNextJob();
      if (!processed) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err: any) {
      log(`Poll loop error: ${err.message}`, 'error');
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

export function startRateCheckQueueWorker() {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting rate check queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopRateCheckQueueWorker() {
  log('Stopping rate check queue worker');
  workerRunning = false;
}
