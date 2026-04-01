import { db } from '../db';
import { sessionBuildQueue } from '@shared/schema';
import type { SessionBuildQueue } from '@shared/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import logger from '../utils/logger';
import { fulfillmentSessionService } from './fulfillment-session-service';

const POLL_INTERVAL_MS = 5000;
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 60000;

let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info', ctx?: Record<string, any>) {
  const prefix = '[SessionBuildQueue]';
  logger[level](`${prefix} ${msg}`, ctx || {});
}

export interface EnqueueSessionBuildOptions {
  userId: string;
  orderNumbers?: string[];
  stationType?: string;
}

export async function enqueueSessionBuild(options: EnqueueSessionBuildOptions): Promise<number> {
  const [inserted] = await db.insert(sessionBuildQueue).values({
    status: 'queued',
    userId: options.userId,
    orderNumbers: options.orderNumbers ?? null,
    stationType: options.stationType ?? null,
    progressPhase: null,
    progressPercent: 0,
    progressDetail: null,
    sessionsCreated: 0,
    shipmentsAssigned: 0,
    shipmentsSkipped: 0,
    result: null,
    error: null,
    retryCount: 0,
    maxRetries: 3,
    startedAt: null,
    completedAt: null,
  }).returning({ id: sessionBuildQueue.id });

  log(`Enqueued session build job #${inserted.id} for user ${options.userId}`);
  return inserted.id;
}

export async function getSessionBuildQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
}> {
  const rows = await db
    .select({
      status: sessionBuildQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(sessionBuildQueue)
    .groupBy(sessionBuildQueue.status);

  const stats = { queued: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === 'queued') stats.queued = row.count;
    else if (row.status === 'processing') stats.processing = row.count;
    else if (row.status === 'completed') stats.completed = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
  }
  return stats;
}

export async function getSessionBuildJobs(limit = 20): Promise<SessionBuildQueue[]> {
  return db
    .select()
    .from(sessionBuildQueue)
    .orderBy(asc(sessionBuildQueue.createdAt))
    .limit(limit);
}

async function updateJobProgress(
  jobId: number,
  phase: string,
  percent: number,
  detail: string,
  counts?: { sessionsCreated?: number; shipmentsAssigned?: number; shipmentsSkipped?: number }
) {
  const updates: Record<string, any> = {
    progressPhase: phase,
    progressPercent: percent,
    progressDetail: detail,
  };
  if (counts?.sessionsCreated !== undefined) updates.sessionsCreated = counts.sessionsCreated;
  if (counts?.shipmentsAssigned !== undefined) updates.shipmentsAssigned = counts.shipmentsAssigned;
  if (counts?.shipmentsSkipped !== undefined) updates.shipmentsSkipped = counts.shipmentsSkipped;

  await db.update(sessionBuildQueue)
    .set(updates)
    .where(eq(sessionBuildQueue.id, jobId));
}

async function handleJobFailure(job: SessionBuildQueue, errorMsg: string): Promise<void> {
  const newRetryCount = job.retryCount + 1;

  if (newRetryCount >= job.maxRetries) {
    log(`Job #${job.id} exhausted all ${job.maxRetries} retries: ${errorMsg}`, 'error');
    await db.update(sessionBuildQueue)
      .set({
        status: 'failed',
        error: errorMsg,
        retryCount: newRetryCount,
        completedAt: new Date(),
      })
      .where(eq(sessionBuildQueue.id, job.id));
  } else {
    const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, newRetryCount), MAX_BACKOFF_MS);
    const retryAfter = new Date(Date.now() + backoffMs);
    log(`Job #${job.id} failed (attempt ${newRetryCount}/${job.maxRetries}), will retry after ${Math.round(backoffMs / 1000)}s: ${errorMsg}`, 'warn');
    await db.update(sessionBuildQueue)
      .set({
        status: 'queued',
        error: errorMsg,
        retryCount: newRetryCount,
        retryAfter,
      })
      .where(eq(sessionBuildQueue.id, job.id));
  }
}

async function processNextSessionBuild(): Promise<boolean> {
  const now = new Date();
  const [job] = await db
    .select()
    .from(sessionBuildQueue)
    .where(
      and(
        eq(sessionBuildQueue.status, 'queued'),
        sql`(${sessionBuildQueue.retryAfter} IS NULL OR ${sessionBuildQueue.retryAfter} <= ${now})`
      )
    )
    .orderBy(asc(sessionBuildQueue.createdAt))
    .limit(1);

  if (!job) return false;

  await db.update(sessionBuildQueue)
    .set({ status: 'processing', startedAt: now, retryAfter: null })
    .where(eq(sessionBuildQueue.id, job.id));

  log(`Processing session build job #${job.id} (attempt ${job.retryCount + 1}/${job.maxRetries})`);

  try {
    const orderNumbers = job.orderNumbers as string[] | null;

    const result = await fulfillmentSessionService.buildSessions(job.userId, {
      stationType: job.stationType ?? undefined,
      orderNumbers: orderNumbers ?? undefined,
      onProgress: async (phase, percent, detail) => {
        await updateJobProgress(job.id, phase, percent, detail);
      },
    });

    if (!result.success) {
      const errorDetail = result.errors?.join('; ') || 'buildSessions returned success=false';
      await handleJobFailure(job, errorDetail);
      return true;
    }

    await db.update(sessionBuildQueue)
      .set({
        status: 'completed',
        completedAt: new Date(),
        result: result,
        error: null,
        progressPhase: 'completing',
        progressPercent: 100,
        progressDetail: `Done: ${result.sessionsCreated} sessions, ${result.shipmentsAssigned} shipments`,
        sessionsCreated: result.sessionsCreated,
        shipmentsAssigned: result.shipmentsAssigned,
        shipmentsSkipped: result.shipmentsSkipped,
      })
      .where(eq(sessionBuildQueue.id, job.id));

    log(`Job #${job.id} completed: ${result.sessionsCreated} sessions created, ${result.shipmentsAssigned} shipments assigned`);
    return true;

  } catch (err: any) {
    const errorMsg = err.message || 'Unknown error';
    await handleJobFailure(job, errorMsg);
    return true;
  }
}

async function recoverStaleProcessingJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
  const staleJobs = await db
    .select({ id: sessionBuildQueue.id })
    .from(sessionBuildQueue)
    .where(
      and(
        eq(sessionBuildQueue.status, 'processing'),
        sql`${sessionBuildQueue.startedAt} < ${cutoff}`
      )
    );

  if (staleJobs.length > 0) {
    for (const job of staleJobs) {
      await db.update(sessionBuildQueue)
        .set({ status: 'queued', error: 'Recovered from stale processing state' })
        .where(eq(sessionBuildQueue.id, job.id));
    }
    log(`Recovered ${staleJobs.length} stale processing job(s) back to queued`);
  }
}

async function pollLoop(): Promise<void> {
  while (workerRunning) {
    try {
      const processed = await processNextSessionBuild();
      if (!processed) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err: any) {
      log(`Poll loop error: ${err.message}`, 'error');
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

export function startSessionBuildQueueWorker() {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting session build queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopSessionBuildQueueWorker() {
  log('Stopping session build queue worker');
  workerRunning = false;
}
