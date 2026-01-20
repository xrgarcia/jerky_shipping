/**
 * Background Job Service
 * 
 * Manages long-running background jobs with step-by-step progress tracking.
 * Jobs are persisted to the database and can be polled or receive WebSocket updates.
 */

import { db } from "../db";
import { 
  backgroundJobs, 
  JOB_STATUS, 
  JOB_TYPES,
  type BackgroundJob, 
  type JobStep, 
  type JobStatus,
  type JobType,
} from "@shared/schema";
import { eq } from "drizzle-orm";

// ============================================================================
// Job Progress Helper
// ============================================================================

/**
 * Helper class for updating job progress during execution
 */
export class JobProgress {
  private jobId: string;
  private steps: JobStep[];
  private currentIndex: number;
  private onUpdate?: (job: BackgroundJob) => void;

  constructor(jobId: string, steps: string[], onUpdate?: (job: BackgroundJob) => void) {
    this.jobId = jobId;
    this.currentIndex = 0;
    this.onUpdate = onUpdate;
    this.steps = steps.map(name => ({
      name,
      status: 'pending' as const,
    }));
  }

  /**
   * Start the next step
   */
  async startStep(message?: string): Promise<void> {
    if (this.currentIndex < this.steps.length) {
      this.steps[this.currentIndex] = {
        ...this.steps[this.currentIndex],
        status: 'running',
        message,
        startedAt: new Date().toISOString(),
      };
      await this.save();
    }
  }

  /**
   * Complete the current step and optionally move to next
   */
  async completeStep(message?: string): Promise<void> {
    if (this.currentIndex < this.steps.length) {
      this.steps[this.currentIndex] = {
        ...this.steps[this.currentIndex],
        status: 'completed',
        message: message || this.steps[this.currentIndex].message,
        completedAt: new Date().toISOString(),
      };
      this.currentIndex++;
      await this.save();
    }
  }

  /**
   * Update the current step's message without changing status
   */
  async updateMessage(message: string): Promise<void> {
    if (this.currentIndex < this.steps.length) {
      this.steps[this.currentIndex] = {
        ...this.steps[this.currentIndex],
        message,
      };
      await this.save();
    }
  }

  /**
   * Mark the current step as failed
   */
  async failStep(message: string): Promise<void> {
    if (this.currentIndex < this.steps.length) {
      this.steps[this.currentIndex] = {
        ...this.steps[this.currentIndex],
        status: 'failed',
        message,
        completedAt: new Date().toISOString(),
      };
      await this.save();
    }
  }

  /**
   * Save current progress to database
   */
  private async save(): Promise<void> {
    const [updated] = await db
      .update(backgroundJobs)
      .set({
        steps: this.steps,
        currentStepIndex: this.currentIndex,
      })
      .where(eq(backgroundJobs.id, this.jobId))
      .returning();
    
    if (updated && this.onUpdate) {
      this.onUpdate(updated);
    }
  }

  /**
   * Get current step index
   */
  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Get all steps
   */
  getSteps(): JobStep[] {
    return this.steps;
  }
}

// ============================================================================
// Background Job Service
// ============================================================================

export const backgroundJobService = {
  /**
   * Create a new background job
   */
  async createJob(
    type: JobType,
    userId: string,
    steps: string[],
    input?: Record<string, any>
  ): Promise<BackgroundJob> {
    const jobSteps: JobStep[] = steps.map(name => ({
      name,
      status: 'pending',
    }));

    const [job] = await db
      .insert(backgroundJobs)
      .values({
        type,
        userId,
        status: JOB_STATUS.PENDING,
        steps: jobSteps,
        currentStepIndex: 0,
        input: input || {},
      })
      .returning();

    return job;
  },

  /**
   * Get a job by ID
   */
  async getJob(jobId: string): Promise<BackgroundJob | null> {
    const [job] = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, jobId));
    
    return job || null;
  },

  /**
   * Mark job as started (running)
   */
  async startJob(jobId: string): Promise<BackgroundJob | null> {
    const [updated] = await db
      .update(backgroundJobs)
      .set({
        status: JOB_STATUS.RUNNING,
        startedAt: new Date(),
      })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    
    return updated || null;
  },

  /**
   * Mark job as completed with result
   */
  async completeJob(
    jobId: string, 
    result: Record<string, any>
  ): Promise<BackgroundJob | null> {
    const [updated] = await db
      .update(backgroundJobs)
      .set({
        status: JOB_STATUS.COMPLETED,
        result,
        completedAt: new Date(),
      })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    
    return updated || null;
  },

  /**
   * Mark job as failed with error message
   */
  async failJob(
    jobId: string, 
    errorMessage: string
  ): Promise<BackgroundJob | null> {
    const [updated] = await db
      .update(backgroundJobs)
      .set({
        status: JOB_STATUS.FAILED,
        errorMessage,
        completedAt: new Date(),
      })
      .where(eq(backgroundJobs.id, jobId))
      .returning();
    
    return updated || null;
  },

  /**
   * Create a progress helper for a job
   */
  createProgress(
    jobId: string, 
    steps: string[],
    onUpdate?: (job: BackgroundJob) => void
  ): JobProgress {
    return new JobProgress(jobId, steps, onUpdate);
  },
};
