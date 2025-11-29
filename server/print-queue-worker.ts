import { db } from './db';
import { printJobs, stations } from '@shared/schema';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import { broadcastPrintQueueUpdate, broadcastQueueStatus } from './websocket';

const log = (message: string) => console.log(`[print-queue] ${message}`);

// Staleness thresholds (in seconds)
const WARNING_THRESHOLD_SECONDS = 35;
const CRITICAL_THRESHOLD_SECONDS = 60;

// Health status type
export type JobHealthStatus = 'healthy' | 'warning' | 'critical';

export type StaleJobInfo = {
  id: string;
  stationId: string;
  stationName: string;
  status: string;
  ageSeconds: number;
  healthStatus: JobHealthStatus;
  createdAt: Date;
  sentAt: Date | null;
};

export type StaleJobsMetrics = {
  totalStale: number;
  warningCount: number;
  criticalCount: number;
  healthStatus: JobHealthStatus;
  staleJobs: StaleJobInfo[];
  lastCheckedAt: Date;
};

// Global worker status
let workerStatus: 'sleeping' | 'running' = 'sleeping';
let isProcessing = false;

// Cached stale jobs metrics
let staleJobsMetrics: StaleJobsMetrics = {
  totalStale: 0,
  warningCount: 0,
  criticalCount: 0,
  healthStatus: 'healthy',
  staleJobs: [],
  lastCheckedAt: new Date(),
};

// Worker statistics (field names match websocket.ts expected type)
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
  if (workerStats.lastCompletedAt === null) {
    return undefined;
  }
  
  return {
    ...workerStats,
    status: workerStatus,
  };
}

export function getStaleJobsMetrics(): StaleJobsMetrics {
  return staleJobsMetrics;
}

/**
 * Calculate the age of a job in seconds based on its status
 * - pending: time since createdAt (waiting for desktop pickup)
 * - sent: time since sentAt (desktop received but not printing)
 * - printing: time since sentAt (started but stuck)
 */
function calculateJobAgeSeconds(job: { status: string; createdAt: Date; sentAt: Date | null }): number {
  const now = Date.now();
  
  if (job.status === 'pending') {
    return (now - new Date(job.createdAt).getTime()) / 1000;
  }
  
  // For 'sent' and 'printing', use sentAt if available, otherwise createdAt
  if (job.sentAt) {
    return (now - new Date(job.sentAt).getTime()) / 1000;
  }
  
  return (now - new Date(job.createdAt).getTime()) / 1000;
}

/**
 * Determine health status based on age in seconds
 */
function getHealthStatus(ageSeconds: number): JobHealthStatus {
  if (ageSeconds >= CRITICAL_THRESHOLD_SECONDS) {
    return 'critical';
  }
  if (ageSeconds >= WARNING_THRESHOLD_SECONDS) {
    return 'warning';
  }
  return 'healthy';
}

/**
 * Core stale job calculation logic - reusable by both worker and API handlers
 * Returns computed metrics and whether status changed
 */
async function computeStaleJobMetrics(): Promise<{ metrics: StaleJobsMetrics; statusChanged: boolean; countChanged: boolean }> {
  // Get all non-terminal jobs (pending, sent, printing)
  const activeJobs = await db
    .select({
      id: printJobs.id,
      stationId: printJobs.stationId,
      status: printJobs.status,
      createdAt: printJobs.createdAt,
      sentAt: printJobs.sentAt,
      stationName: stations.name,
    })
    .from(printJobs)
    .leftJoin(stations, eq(printJobs.stationId, stations.id))
    .where(
      or(
        eq(printJobs.status, 'pending'),
        eq(printJobs.status, 'sent'),
        eq(printJobs.status, 'printing')
      )
    )
    .orderBy(desc(printJobs.createdAt));

  const staleJobs: StaleJobInfo[] = [];
  let warningCount = 0;
  let criticalCount = 0;

  for (const job of activeJobs) {
    const ageSeconds = calculateJobAgeSeconds({
      status: job.status,
      createdAt: job.createdAt,
      sentAt: job.sentAt,
    });
    
    const healthStatus = getHealthStatus(ageSeconds);
    
    if (healthStatus !== 'healthy') {
      staleJobs.push({
        id: job.id,
        stationId: job.stationId,
        stationName: job.stationName || 'Unknown Station',
        status: job.status,
        ageSeconds: Math.round(ageSeconds),
        healthStatus,
        createdAt: job.createdAt,
        sentAt: job.sentAt,
      });
      
      if (healthStatus === 'warning') {
        warningCount++;
      } else if (healthStatus === 'critical') {
        criticalCount++;
      }
    }
  }

  // Determine overall health status
  let overallHealth: JobHealthStatus = 'healthy';
  if (criticalCount > 0) {
    overallHealth = 'critical';
  } else if (warningCount > 0) {
    overallHealth = 'warning';
  }

  // Check if status changed from previous check
  const previousHealth = staleJobsMetrics.healthStatus;
  const statusChanged = previousHealth !== overallHealth;
  const countChanged = staleJobsMetrics.totalStale !== staleJobs.length;

  const metrics: StaleJobsMetrics = {
    totalStale: staleJobs.length,
    warningCount,
    criticalCount,
    healthStatus: overallHealth,
    staleJobs,
    lastCheckedAt: new Date(),
  };

  return { metrics, statusChanged, countChanged };
}

/**
 * Immediately refresh stale job metrics and broadcast update
 * Call this after any print job status change (complete, cancel, etc.)
 * Does NOT use worker lock - designed for instant API response
 */
export async function refreshStaleJobsMetrics(): Promise<StaleJobsMetrics> {
  try {
    const { metrics, statusChanged, countChanged } = await computeStaleJobMetrics();
    
    // Update cached metrics
    const previousHealth = staleJobsMetrics.healthStatus;
    staleJobsMetrics = metrics;

    // Log status
    if (metrics.staleJobs.length > 0) {
      log(`[Immediate] Found ${metrics.staleJobs.length} stale job(s): ${metrics.warningCount} warning, ${metrics.criticalCount} critical`);
    } else if (previousHealth !== 'healthy') {
      log(`[Immediate] All jobs recovered - queue is now healthy`);
    }

    // Always broadcast on immediate refresh (called after job status change)
    log(`[Immediate] Broadcasting stale jobs update: ${metrics.healthStatus} (${metrics.staleJobs.length} stale)`);
    broadcastPrintQueueUpdate({
      type: 'stale_jobs_update',
      metrics: staleJobsMetrics,
    });

    return staleJobsMetrics;
  } catch (error: any) {
    log(`[Immediate] Error refreshing stale jobs: ${error.message}`);
    return staleJobsMetrics;
  }
}

/**
 * Check for stale print jobs and update metrics (called by worker interval)
 * Broadcasts updates when stale jobs are detected or cleared
 */
export async function checkStaleJobs(): Promise<StaleJobsMetrics> {
  if (isProcessing) {
    log('Previous check still running, skipping this cycle');
    return staleJobsMetrics;
  }
  
  isProcessing = true;
  
  try {
    workerStatus = 'running';
    
    const { metrics, statusChanged, countChanged } = await computeStaleJobMetrics();

    // Update cached metrics
    const previousHealth = staleJobsMetrics.healthStatus;
    staleJobsMetrics = metrics;

    // Update worker stats
    workerStats.totalProcessedCount++;
    workerStats.lastProcessedCount = metrics.staleJobs.length;
    workerStats.lastCompletedAt = new Date();

    // Log stale job status
    if (metrics.staleJobs.length > 0) {
      log(`Found ${metrics.staleJobs.length} stale job(s): ${metrics.warningCount} warning, ${metrics.criticalCount} critical`);
    } else if (previousHealth !== 'healthy') {
      // Log recovery when transitioning from stale to healthy
      log(`All jobs recovered - queue is now healthy`);
    }

    // Broadcast update if status or count changed (including recovery to healthy)
    if (statusChanged || countChanged) {
      log(`Broadcasting stale jobs update: ${metrics.healthStatus} (${metrics.staleJobs.length} stale)`);
      broadcastPrintQueueUpdate({
        type: 'stale_jobs_update',
        metrics: staleJobsMetrics,
      });
    }

    return staleJobsMetrics;

  } catch (error: any) {
    log(`Error checking stale jobs: ${error.message}`);
    workerStats.lastCompletedAt = new Date();
    return staleJobsMetrics;
  } finally {
    workerStatus = 'sleeping';
    isProcessing = false;
    
    // Broadcast final status
    broadcastQueueStatus({
      printQueueWorkerStatus: 'sleeping',
      printQueueWorkerStats: getPrintQueueWorkerStats(),
    });
  }
}

// Interval management
let workerInterval: NodeJS.Timeout | undefined;

/**
 * Start the print queue stale job checker
 * @param intervalMs - Polling interval in milliseconds (default: 5 seconds for faster stale detection)
 */
export function startPrintQueueWorker(intervalMs: number = 5000): void {
  if (workerInterval) {
    log('Print queue worker already running');
    return;
  }

  log(`Stale job checker started (interval: ${intervalMs}ms = ${intervalMs / 1000} seconds)`);
  log(`Thresholds: warning >= ${WARNING_THRESHOLD_SECONDS}s, critical >= ${CRITICAL_THRESHOLD_SECONDS}s`);
  
  // Check immediately on start, then on interval
  checkStaleJobs();
  
  workerInterval = setInterval(() => {
    checkStaleJobs();
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
