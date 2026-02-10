import { db } from '../db';
import { shipstationWriteQueue, shipments } from '@shared/schema';
import type { InsertShipstationWriteQueue } from '@shared/schema';
import { eq, and, lte, or, isNull, asc, sql } from 'drizzle-orm';
import { resolveCarrierIdFromServiceCode } from '../utils/shipstation-api';

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

const POLL_INTERVAL_MS = 5000;
const MIN_RATE_LIMIT_REMAINING = 3;
const EXPONENTIAL_BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 300000; // 5 minutes

const READ_ONLY_FIELDS = [
  'shipment_id',
  'created_at',
  'modified_at',
  'label_id',
  'shipment_status',
  'label_status',
  'tracking_number',
  'label_download',
  'form_download',
  'insurance_claim',
];

let rateLimitRemaining = 40;
let rateLimitResetAt = 0;
let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const prefix = '[SSWriteQueue]';
  if (level === 'error') console.error(`${prefix} ${msg}`);
  else if (level === 'warn') console.warn(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

function extractRateLimitFromHeaders(headers: Headers) {
  rateLimitRemaining = parseInt(headers.get('X-Rate-Limit-Remaining') || '40');
  const resetSeconds = parseInt(headers.get('X-Rate-Limit-Reset') || '0');
  if (resetSeconds > 0) {
    rateLimitResetAt = Date.now() + (resetSeconds * 1000);
  }
}

function calculateBackoffMs(retryCount: number): number {
  const backoff = EXPONENTIAL_BACKOFF_BASE_MS * Math.pow(2, retryCount);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

export interface EnqueueWriteOptions {
  shipmentId: string;
  patchPayload: Record<string, any>;
  reason: string;
  localShipmentId?: string;
  callbackAction?: string;
  maxRetries?: number;
}

export async function enqueueShipStationWrite(options: EnqueueWriteOptions): Promise<number> {
  const row: InsertShipstationWriteQueue = {
    shipmentId: options.shipmentId,
    patchPayload: options.patchPayload,
    reason: options.reason,
    status: 'queued',
    retryCount: 0,
    maxRetries: options.maxRetries ?? 5,
    localShipmentId: options.localShipmentId ?? null,
    callbackAction: options.callbackAction ?? null,
    lastError: null,
    nextRetryAt: null,
    processedAt: null,
    completedAt: null,
  };

  const [inserted] = await db.insert(shipstationWriteQueue).values(row).returning({ id: shipstationWriteQueue.id });
  log(`Enqueued write job #${inserted.id} for ${options.shipmentId} (${options.reason})`);
  return inserted.id;
}

export async function getWriteQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
}> {
  const rows = await db
    .select({
      status: shipstationWriteQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(shipstationWriteQueue)
    .groupBy(shipstationWriteQueue.status);

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

async function fetchCurrentShipment(shipmentId: string): Promise<{ data: any; headers: Headers } | null> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY not configured');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  extractRateLimitFromHeaders(response.headers);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
    throw new RateLimitError(`Rate limited on GET`, retryAfter);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GET shipment failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return { data, headers: response.headers };
}

function applyPatch(currentShipment: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const merged = { ...currentShipment };

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'packages' && Array.isArray(value) && Array.isArray(merged.packages)) {
      merged.packages = merged.packages.map((existingPkg: any, index: number) => {
        const patchPkg = value[index];
        if (!patchPkg) return existingPkg;
        const mergedPkg = { ...existingPkg, ...patchPkg };
        if (patchPkg.$remove && Array.isArray(patchPkg.$remove)) {
          for (const fieldToRemove of patchPkg.$remove) {
            delete mergedPkg[fieldToRemove];
          }
          delete mergedPkg.$remove;
        }
        return mergedPkg;
      });
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function stripReadOnlyFields(payload: Record<string, any>): Record<string, any> {
  const cleaned = { ...payload };
  for (const field of READ_ONLY_FIELDS) {
    delete cleaned[field];
  }

  if (cleaned.ship_from === null && cleaned.warehouse_id === null) {
    cleaned.ship_from = {
      name: "Jerky.com",
      phone: "",
      company_name: "Jerky.com",
      address_line1: "3600 NW 10th St",
      city_locality: "Oklahoma City",
      state_province: "OK",
      postal_code: "73107",
      country_code: "US",
    };
    delete cleaned.warehouse_id;
  } else {
    if (cleaned.ship_from === null) delete cleaned.ship_from;
    if (cleaned.warehouse_id === null) delete cleaned.warehouse_id;
  }

  return cleaned;
}

async function resolveCarrierIfNeeded(payload: Record<string, any>): Promise<void> {
  if (payload.service_code && !payload.carrier_id) {
    try {
      const resolved = await resolveCarrierIdFromServiceCode(payload.service_code);
      if (resolved) {
        payload.carrier_id = resolved;
        log(`Resolved carrier_id "${resolved}" from service_code "${payload.service_code}"`);
      }
    } catch (err: any) {
      log(`Could not resolve carrier_id for service_code "${payload.service_code}": ${err.message}`, 'warn');
    }
  }
}

async function putShipment(shipmentId: string, payload: Record<string, any>): Promise<void> {
  if (!SHIPSTATION_API_KEY) {
    throw new Error('SHIPSTATION_API_KEY not configured');
  }

  const url = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipmentId)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'api-key': SHIPSTATION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  extractRateLimitFromHeaders(response.headers);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
    throw new RateLimitError(`Rate limited on PUT`, retryAfter);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PUT shipment failed: ${response.status} ${errorText}`);
  }
}

class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function runCallbackAction(job: typeof shipstationWriteQueue.$inferSelect): Promise<void> {
  if (!job.callbackAction || !job.localShipmentId) return;

  try {
    if (job.callbackAction === 'clear_manual_package_flag') {
      await db.update(shipments)
        .set({ requiresManualPackage: false, packageAssignmentError: null })
        .where(eq(shipments.id, job.localShipmentId));
      log(`Callback: Cleared manual package flag for shipment ${job.localShipmentId}`);
    }
  } catch (err: any) {
    log(`Callback action "${job.callbackAction}" failed for job #${job.id}: ${err.message}`, 'warn');
  }
}

async function processNextJob(): Promise<boolean> {
  const now = new Date();

  const [job] = await db
    .select()
    .from(shipstationWriteQueue)
    .where(
      and(
        or(
          eq(shipstationWriteQueue.status, 'queued'),
          and(
            eq(shipstationWriteQueue.status, 'failed'),
            lte(shipstationWriteQueue.nextRetryAt, now)
          )
        )
      )
    )
    .orderBy(asc(shipstationWriteQueue.createdAt))
    .limit(1);

  if (!job) return false;

  await db.update(shipstationWriteQueue)
    .set({ status: 'processing', processedAt: now })
    .where(eq(shipstationWriteQueue.id, job.id));

  try {
    log(`Processing job #${job.id}: ${job.reason} for ${job.shipmentId} (attempt ${job.retryCount + 1}/${job.maxRetries})`);

    const currentShipment = await fetchCurrentShipment(job.shipmentId);
    if (!currentShipment) {
      throw new Error(`Shipment ${job.shipmentId} not found in ShipStation`);
    }

    const patch = job.patchPayload as Record<string, any>;
    const merged = applyPatch(currentShipment.data, patch);
    const cleaned = stripReadOnlyFields(merged);
    await resolveCarrierIfNeeded(cleaned);

    await putShipment(job.shipmentId, cleaned);

    await db.update(shipstationWriteQueue)
      .set({ status: 'completed', completedAt: new Date(), lastError: null })
      .where(eq(shipstationWriteQueue.id, job.id));

    log(`Job #${job.id} completed successfully for ${job.shipmentId}`);

    await runCallbackAction(job);
    return true;

  } catch (err: any) {
    const isRateLimit = err instanceof RateLimitError;
    const newRetryCount = isRateLimit ? job.retryCount : job.retryCount + 1;
    const errorMsg = err.message || 'Unknown error';

    if (isRateLimit) {
      const waitMs = err.retryAfterSeconds * 1000 + 1000;
      const nextRetry = new Date(Date.now() + waitMs);
      log(`Job #${job.id} rate limited, will retry at ${nextRetry.toISOString()} (not counting as failure)`, 'warn');
      await db.update(shipstationWriteQueue)
        .set({
          status: 'failed',
          lastError: `RATE_LIMITED: ${errorMsg}`,
          retryCount: newRetryCount,
          nextRetryAt: nextRetry,
        })
        .where(eq(shipstationWriteQueue.id, job.id));

      rateLimitRemaining = 0;
      rateLimitResetAt = Date.now() + waitMs;
      return true;
    }

    if (newRetryCount >= job.maxRetries) {
      log(`Job #${job.id} exhausted all ${job.maxRetries} retries, moving to dead letter: ${errorMsg}`, 'error');
      await db.update(shipstationWriteQueue)
        .set({
          status: 'dead_letter',
          lastError: errorMsg,
          retryCount: newRetryCount,
        })
        .where(eq(shipstationWriteQueue.id, job.id));

      if (job.localShipmentId) {
        try {
          await db.update(shipments)
            .set({
              requiresManualPackage: true,
              packageAssignmentError: `Write queue failed after ${job.maxRetries} attempts: ${errorMsg}`,
            })
            .where(eq(shipments.id, job.localShipmentId));
        } catch (e) {
          log(`Failed to flag shipment ${job.localShipmentId} for manual intervention: ${e}`, 'error');
        }
      }
    } else {
      const backoffMs = calculateBackoffMs(newRetryCount);
      const nextRetry = new Date(Date.now() + backoffMs);
      log(`Job #${job.id} failed (attempt ${newRetryCount}/${job.maxRetries}), retrying at ${nextRetry.toISOString()}: ${errorMsg}`, 'warn');
      await db.update(shipstationWriteQueue)
        .set({
          status: 'failed',
          lastError: errorMsg,
          retryCount: newRetryCount,
          nextRetryAt: nextRetry,
        })
        .where(eq(shipstationWriteQueue.id, job.id));
    }

    return true;
  }
}

async function shouldWaitForRateLimit(): Promise<boolean> {
  if (rateLimitRemaining < MIN_RATE_LIMIT_REMAINING && rateLimitResetAt > Date.now()) {
    const waitMs = rateLimitResetAt - Date.now();
    log(`Rate limit low (${rateLimitRemaining} remaining), waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise(resolve => setTimeout(resolve, waitMs + 500));
    return true;
  }
  return false;
}

async function recoverStaleProcessingJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const result = await db.update(shipstationWriteQueue)
    .set({ status: 'queued', lastError: 'Recovered from stale processing state (server restart)' })
    .where(
      and(
        eq(shipstationWriteQueue.status, 'processing'),
        lte(shipstationWriteQueue.processedAt, staleThreshold)
      )
    )
    .returning({ id: shipstationWriteQueue.id });

  if (result.length > 0) {
    log(`Recovered ${result.length} stale processing jobs back to queued`);
  }
  return result.length;
}

async function pollLoop() {
  while (workerRunning) {
    try {
      await shouldWaitForRateLimit();
      const processed = await processNextJob();
      if (!processed) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (err: any) {
      log(`Poll loop error: ${err.message}`, 'error');
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

export function startShipStationWriteQueueWorker() {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting ShipStation write queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopShipStationWriteQueueWorker() {
  log('Stopping ShipStation write queue worker');
  workerRunning = false;
}
