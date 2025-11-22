/**
 * Worker Coordinator
 * Manages cross-worker state and coordination to prevent API conflicts
 * Uses Redis for shared state management
 */

import { getRedisClient } from './utils/queue';

const BACKFILL_LOCK_KEY = 'worker:backfill:active';
const BACKFILL_JOB_KEY = 'worker:backfill:job-id';
const POLL_MUTEX_KEY = 'worker:onhold-poll:mutex';

export class WorkerCoordinator {
  /**
   * Mark that a backfill job is starting
   * This signals other workers to pause API-heavy operations
   * Throws on Redis errors - caller should handle
   */
  async beginBackfill(jobId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      
      // Set flag with 24-hour TTL as safety net (jobs should complete in hours)
      await redis.set(BACKFILL_LOCK_KEY, 'true', { ex: 86400 });
      await redis.set(BACKFILL_JOB_KEY, jobId, { ex: 86400 });
      
      console.log(`[WorkerCoordinator] Backfill job ${jobId} started - signaling workers to pause`);
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to set backfill lock for job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Mark that a backfill job has completed
   * Allows other workers to resume normal operations
   * Logs but does not throw on Redis errors - cleanup is best effort
   */
  async endBackfill(): Promise<void> {
    try {
      const redis = getRedisClient();
      
      await redis.del(BACKFILL_LOCK_KEY);
      await redis.del(BACKFILL_JOB_KEY);
      
      console.log(`[WorkerCoordinator] Backfill completed - workers can resume`);
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to clear backfill lock:`, error);
    }
  }

  /**
   * Check if a backfill job is currently active
   * Returns false on Redis errors (fail-safe: allow workers to run)
   */
  async isBackfillActive(): Promise<boolean> {
    try {
      const redis = getRedisClient();
      const flag = await redis.get<string>(BACKFILL_LOCK_KEY);
      return flag === 'true';
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to check backfill status, assuming inactive:`, error);
      return false; // Fail-safe: assume no backfill active
    }
  }

  /**
   * Get the current active backfill job ID, if any
   * Returns null on Redis errors
   */
  async getActiveBackfillJobId(): Promise<string | null> {
    try {
      const redis = getRedisClient();
      const jobId = await redis.get<string>(BACKFILL_JOB_KEY);
      return jobId;
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to get active backfill job ID:`, error);
      return null;
    }
  }

  /**
   * Acquire mutex for on-hold poll execution
   * Returns false on Redis errors (fail-safe: skip this poll cycle)
   */
  async acquirePollMutex(): Promise<boolean> {
    try {
      const redis = getRedisClient();
      
      // Use SET NX (set if not exists) with 5 minute TTL as safety net
      // Poll should complete in seconds, but TTL prevents eternal locks
      const acquired = await redis.set(POLL_MUTEX_KEY, 'locked', {
        nx: true,  // Only set if doesn't exist
        ex: 300,   // 5 minute TTL
      });
      
      return acquired !== null;
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to acquire poll mutex:`, error);
      return false; // Fail-safe: skip this poll cycle
    }
  }

  /**
   * Release mutex for on-hold poll execution
   * Logs but does not throw on Redis errors - cleanup is best effort
   */
  async releasePollMutex(): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(POLL_MUTEX_KEY);
    } catch (error) {
      console.error(`[WorkerCoordinator] Failed to release poll mutex:`, error);
    }
  }

  /**
   * Execute a function with poll mutex protection
   * Automatically handles acquire/release and prevents overlapping executions
   * Returns null if mutex cannot be acquired (including Redis errors)
   */
  async withPollMutex<T>(fn: () => Promise<T>): Promise<T | null> {
    const acquired = await this.acquirePollMutex();
    
    if (!acquired) {
      console.log('[WorkerCoordinator] Poll mutex not acquired, skipping execution');
      return null;
    }

    try {
      return await fn();
    } finally {
      await this.releasePollMutex();
    }
  }
}

// Singleton instance
export const workerCoordinator = new WorkerCoordinator();
