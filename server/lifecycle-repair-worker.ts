import { db } from "./db";
import { shipments, lifecycleRepairJobs } from "@shared/schema";
import { eq, or, and, ne } from "drizzle-orm";
import { updateShipmentLifecycleFromData } from "./services/lifecycle-service";

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 10000;

let isRunning = false;
let workerInterval: ReturnType<typeof setInterval> | null = null;

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [lifecycle-repair-worker] ${message}`);
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ status: lifecycleRepairJobs.status })
    .from(lifecycleRepairJobs)
    .where(eq(lifecycleRepairJobs.id, jobId));
  return job?.status === "cancelled";
}

async function getStaleShipments(): Promise<typeof shipments.$inferSelect[]> {
  const results = await db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.lifecyclePhase, 'on_dock'),
        or(
          ne(shipments.status, 'pending'),
          ne(shipments.shipmentStatus, 'pending')
        )
      )
    );
  
  return results;
}

async function processJob(jobId: string): Promise<void> {
  log(`Processing lifecycle repair job ${jobId}`);
  
  try {
    const [job] = await db
      .update(lifecycleRepairJobs)
      .set({ 
        status: "running", 
        startedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(lifecycleRepairJobs.id, jobId))
      .returning();
    
    if (!job) {
      log(`Job ${jobId} not found`);
      return;
    }
    
    const shipmentsToRepair = await getStaleShipments();
    const total = shipmentsToRepair.length;
    log(`Found ${total} shipments to repair for job ${jobId}`);
    
    await db
      .update(lifecycleRepairJobs)
      .set({ shipmentsTotal: total, updatedAt: new Date() })
      .where(eq(lifecycleRepairJobs.id, jobId));
    
    let repaired = 0;
    let failed = 0;
    const phaseChanges: Record<string, number> = {};
    
    for (let i = 0; i < shipmentsToRepair.length; i += BATCH_SIZE) {
      if (await isJobCancelled(jobId)) {
        log(`Job ${jobId} was cancelled, stopping processing`);
        return;
      }
      
      const batch = shipmentsToRepair.slice(i, i + BATCH_SIZE);
      
      for (const shipment of batch) {
        try {
          const result = await updateShipmentLifecycleFromData(shipment, { logTransition: false });
          
          if (result.changed) {
            repaired++;
            const transition = `${result.previousPhase} -> ${result.newPhase}`;
            phaseChanges[transition] = (phaseChanges[transition] || 0) + 1;
          }
        } catch (error: any) {
          failed++;
          log(`Error repairing shipment ${shipment.id}: ${error.message}`);
        }
      }
      
      await db
        .update(lifecycleRepairJobs)
        .set({
          shipmentsRepaired: repaired,
          shipmentsFailed: failed,
          updatedAt: new Date(),
        })
        .where(eq(lifecycleRepairJobs.id, jobId));
      
      log(`Progress: ${i + batch.length}/${total} processed, ${repaired} repaired, ${failed} failed`);
    }
    
    await db
      .update(lifecycleRepairJobs)
      .set({
        status: "completed",
        shipmentsRepaired: repaired,
        shipmentsFailed: failed,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(lifecycleRepairJobs.id, jobId));
    
    log(`Job ${jobId} completed: ${repaired} repaired, ${failed} failed`);
    log(`Phase transitions: ${JSON.stringify(phaseChanges)}`);
    
  } catch (error: any) {
    log(`Error processing job ${jobId}: ${error.message}`);
    await db
      .update(lifecycleRepairJobs)
      .set({
        status: "failed",
        errorMessage: error.message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(lifecycleRepairJobs.id, jobId));
  }
}

async function pollForJobs(): Promise<void> {
  if (isRunning) return;
  
  try {
    const [pendingJob] = await db
      .select()
      .from(lifecycleRepairJobs)
      .where(eq(lifecycleRepairJobs.status, "pending"))
      .orderBy(lifecycleRepairJobs.createdAt)
      .limit(1);
    
    if (pendingJob) {
      isRunning = true;
      await processJob(pendingJob.id);
      isRunning = false;
    }
  } catch (error: any) {
    log(`Error polling for jobs: ${error.message}`);
    isRunning = false;
  }
}

export function startLifecycleRepairWorker(): void {
  if (workerInterval) {
    log("Worker already started");
    return;
  }
  
  log("Starting lifecycle repair worker");
  workerInterval = setInterval(pollForJobs, POLL_INTERVAL_MS);
  pollForJobs();
}

export function stopLifecycleRepairWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    log("Lifecycle repair worker stopped");
  }
}
