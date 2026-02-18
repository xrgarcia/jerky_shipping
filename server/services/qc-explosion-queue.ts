import { db } from '../db';
import { qcExplosionQueue, shipments } from '@shared/schema';
import type { InsertQcExplosionQueue } from '@shared/schema';
import { eq, and, lte, or, asc, sql } from 'drizzle-orm';
import logger, { withOrder } from '../utils/logger';
import { hydrateShipment, calculateFingerprint } from './qc-item-hydrator';

const POLL_INTERVAL_MS = 5000;
const EXPONENTIAL_BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 300000;

let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info', ctx?: Record<string, any>) {
  const prefix = '[QcExplosionQueue]';
  logger[level](`${prefix} ${msg}`, ctx || {});
}

function calculateBackoffMs(retryCount: number): number {
  const backoff = EXPONENTIAL_BACKOFF_BASE_MS * Math.pow(2, retryCount);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

export interface EnqueueQcExplosionOptions {
  shipmentId: string;
  orderNumber?: string;
  maxRetries?: number;
}

export async function enqueueQcExplosion(options: EnqueueQcExplosionOptions): Promise<number> {
  const existing = await db
    .select({ id: qcExplosionQueue.id, status: qcExplosionQueue.status })
    .from(qcExplosionQueue)
    .where(
      and(
        eq(qcExplosionQueue.shipmentId, options.shipmentId),
        or(
          eq(qcExplosionQueue.status, 'queued'),
          eq(qcExplosionQueue.status, 'processing')
        )
      )
    )
    .limit(1);

  if (existing.length > 0) {
    log(`Job already queued/processing (#${existing[0].id}) for shipment ${options.shipmentId}, skipping`, 'info', withOrder(options.orderNumber, options.shipmentId));
    return existing[0].id;
  }

  const row: InsertQcExplosionQueue = {
    shipmentId: options.shipmentId,
    orderNumber: options.orderNumber ?? null,
    status: 'queued',
    retryCount: 0,
    maxRetries: options.maxRetries ?? 5,
    lastError: null,
    nextRetryAt: null,
    processedAt: null,
    completedAt: null,
    itemsCreated: null,
    fingerprintStatus: null,
    fingerprintIsNew: null,
  };

  const [inserted] = await db.insert(qcExplosionQueue).values(row).returning({ id: qcExplosionQueue.id });
  log(`Enqueued QC explosion job #${inserted.id} for ${options.orderNumber || options.shipmentId}`, 'info', withOrder(options.orderNumber, options.shipmentId));
  return inserted.id;
}

export async function getQcExplosionQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
}> {
  const rows = await db
    .select({
      status: qcExplosionQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(qcExplosionQueue)
    .groupBy(qcExplosionQueue.status);

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
    .from(qcExplosionQueue)
    .where(
      or(
        eq(qcExplosionQueue.status, 'queued'),
        and(
          eq(qcExplosionQueue.status, 'failed'),
          lte(qcExplosionQueue.nextRetryAt, now)
        )
      )
    )
    .orderBy(asc(qcExplosionQueue.createdAt))
    .limit(1);

  if (!job) return false;

  const orderNumber = job.orderNumber ?? undefined;
  const jobCtx = withOrder(orderNumber, job.shipmentId, { queueItemId: String(job.id) });

  await db.update(qcExplosionQueue)
    .set({ status: 'processing', processedAt: now })
    .where(eq(qcExplosionQueue.id, job.id));

  try {
    log(`Processing job #${job.id} for ${job.orderNumber || job.shipmentId} (attempt ${job.retryCount + 1}/${job.maxRetries})`, 'info', jobCtx);

    const [shipment] = await db
      .select({ id: shipments.id, orderNumber: shipments.orderNumber, fingerprintStatus: shipments.fingerprintStatus })
      .from(shipments)
      .where(eq(shipments.id, job.shipmentId))
      .limit(1);

    if (!shipment) {
      throw new Error(`Shipment not found in local DB: ${job.shipmentId}`);
    }

    if (shipment.fingerprintStatus && ['complete', 'pending_categorization', 'missing_weight'].includes(shipment.fingerprintStatus)) {
      log(`Job #${job.id}: Hydration already done (fingerprintStatus=${shipment.fingerprintStatus}), marking completed`, 'info', jobCtx);
      await db.update(qcExplosionQueue)
        .set({
          status: 'completed',
          completedAt: new Date(),
          lastError: null,
          fingerprintStatus: shipment.fingerprintStatus,
        })
        .where(eq(qcExplosionQueue.id, job.id));
      return true;
    }

    const result = await hydrateShipment(job.shipmentId, shipment.orderNumber || 'unknown');

    if (result.error) {
      throw new Error(result.error);
    }

    let fpStatus = result.fingerprintStatus || null;
    let fpIsNew = result.fingerprintIsNew || false;

    if (!fpStatus) {
      const fpResult = await calculateFingerprint(job.shipmentId);
      fpStatus = fpResult.status;
      fpIsNew = fpResult.isNew || false;
    }

    await db.update(qcExplosionQueue)
      .set({
        status: 'completed',
        completedAt: new Date(),
        lastError: null,
        itemsCreated: result.itemsCreated,
        fingerprintStatus: fpStatus,
        fingerprintIsNew: fpIsNew,
      })
      .where(eq(qcExplosionQueue.id, job.id));

    try {
      const { queueLifecycleEvaluation } = await import('./lifecycle-service');
      await queueLifecycleEvaluation(job.shipmentId, 'qc_explosion_complete', orderNumber);
    } catch (lcErr: any) {
      log(`Job #${job.id} lifecycle re-eval failed (non-fatal): ${lcErr.message}`, 'warn', jobCtx);
    }

    log(`Job #${job.id} completed: ${result.itemsCreated} items created, fingerprint=${fpStatus}`, 'info', jobCtx);
    return true;

  } catch (err: any) {
    const errorMsg = err.message || 'Unknown error';
    const newRetryCount = job.retryCount + 1;

    if (newRetryCount >= job.maxRetries) {
      log(`Job #${job.id} exhausted all ${job.maxRetries} retries, dead-lettering: ${errorMsg}`, 'error', jobCtx);
      await db.update(qcExplosionQueue)
        .set({
          status: 'dead_letter',
          lastError: errorMsg,
          retryCount: newRetryCount,
        })
        .where(eq(qcExplosionQueue.id, job.id));
    } else {
      const backoffMs = calculateBackoffMs(newRetryCount);
      const nextRetry = new Date(Date.now() + backoffMs);
      log(`Job #${job.id} failed (attempt ${newRetryCount}/${job.maxRetries}), retrying at ${nextRetry.toISOString()}: ${errorMsg}`, 'warn', jobCtx);
      await db.update(qcExplosionQueue)
        .set({
          status: 'failed',
          lastError: errorMsg,
          retryCount: newRetryCount,
          nextRetryAt: nextRetry,
        })
        .where(eq(qcExplosionQueue.id, job.id));
    }

    return true;
  }
}

async function recoverStaleProcessingJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const result = await db.update(qcExplosionQueue)
    .set({ status: 'queued', lastError: 'Recovered from stale processing state (server restart)' })
    .where(
      and(
        eq(qcExplosionQueue.status, 'processing'),
        lte(qcExplosionQueue.processedAt, staleThreshold)
      )
    )
    .returning({ id: qcExplosionQueue.id });

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

export function startQcExplosionQueueWorker() {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting QC explosion queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopQcExplosionQueueWorker() {
  log('Stopping QC explosion queue worker');
  workerRunning = false;
}
