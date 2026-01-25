import { db } from "./db";
import { shipments, shipmentRateAnalysis, rateAnalysisJobs } from "@shared/schema";
import { eq, and, isNotNull, isNull, gte, desc } from "drizzle-orm";
import { smartCarrierRateService } from "./services/smart-carrier-rate-service";

const BATCH_SIZE = 50;
const DELAY_BETWEEN_SHIPMENTS_MS = 200;
const POLL_INTERVAL_MS = 10000;

let isRunning = false;
let workerInterval: ReturnType<typeof setInterval> | null = null;

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [rate-analysis-worker] ${message}`);
}

async function isJobCancelled(jobId: string): Promise<boolean> {
  const [job] = await db
    .select({ status: rateAnalysisJobs.status })
    .from(rateAnalysisJobs)
    .where(eq(rateAnalysisJobs.id, jobId));
  return job?.status === "cancelled";
}

async function getShipmentsForJob(daysBack: number | null): Promise<typeof shipments.$inferSelect[]> {
  const baseConditions = [
    isNotNull(shipments.serviceCode),
    isNotNull(shipments.shipToPostalCode),
    isNotNull(shipments.shipmentId)
  ];
  
  if (daysBack) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    baseConditions.push(gte(shipments.orderDate, cutoffDate));
  }
  
  const results = await db
    .select({ shipment: shipments })
    .from(shipments)
    .leftJoin(shipmentRateAnalysis, eq(shipments.shipmentId, shipmentRateAnalysis.shipmentId))
    .where(
      and(
        ...baseConditions,
        isNull(shipmentRateAnalysis.shipmentId)
      )
    );
  
  return results.map(r => r.shipment);
}

async function processJob(jobId: string): Promise<void> {
  log(`Processing rate analysis job ${jobId}`);
  
  try {
    const [job] = await db
      .update(rateAnalysisJobs)
      .set({ 
        status: "running", 
        startedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(rateAnalysisJobs.id, jobId))
      .returning();
    
    if (!job) {
      log(`Job ${jobId} not found`);
      return;
    }
    
    const shipmentsToAnalyze = await getShipmentsForJob(job.daysBack);
    const total = shipmentsToAnalyze.length;
    log(`Found ${total} shipments to analyze for job ${jobId} (${job.preset})`);
    
    await db
      .update(rateAnalysisJobs)
      .set({ shipmentsTotal: total, updatedAt: new Date() })
      .where(eq(rateAnalysisJobs.id, jobId));
    
    let analyzed = 0;
    let failed = 0;
    let totalSavings = 0;
    
    for (let i = 0; i < shipmentsToAnalyze.length; i += BATCH_SIZE) {
      if (await isJobCancelled(jobId)) {
        log(`Job ${jobId} was cancelled, stopping processing`);
        return;
      }
      
      const batch = shipmentsToAnalyze.slice(i, i + BATCH_SIZE);
      
      for (const shipment of batch) {
        try {
          const result = await smartCarrierRateService.analyzeAndSave(shipment);
          if (result.success && result.analysis) {
            analyzed++;
            const savings = parseFloat(result.analysis.costSavings || "0");
            if (savings > 0) {
              totalSavings += savings;
            }
          } else {
            failed++;
            // Log the first few failures in detail for debugging
            if (failed <= 3) {
              log(`Failed shipment ${shipment.shipmentId}: ${result.error}`);
            }
          }
        } catch (error: any) {
          failed++;
          if (failed <= 3) {
            log(`Exception analyzing shipment ${shipment.shipmentId}: ${error.message}`);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SHIPMENTS_MS));
      }
      
      await db
        .update(rateAnalysisJobs)
        .set({ 
          shipmentsAnalyzed: analyzed,
          shipmentsFailed: failed,
          savingsFound: totalSavings.toFixed(2),
          updatedAt: new Date()
        })
        .where(eq(rateAnalysisJobs.id, jobId));
      
      log(`Job ${jobId} progress: ${analyzed + failed}/${total} (${analyzed} analyzed, ${failed} failed)`);
    }
    
    await db
      .update(rateAnalysisJobs)
      .set({ 
        status: "completed",
        shipmentsAnalyzed: analyzed,
        shipmentsFailed: failed,
        savingsFound: totalSavings.toFixed(2),
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(rateAnalysisJobs.id, jobId));
    
    log(`Job ${jobId} completed: ${analyzed} analyzed, ${failed} failed, $${totalSavings.toFixed(2)} potential savings`);
    
  } catch (error: any) {
    log(`Job ${jobId} failed: ${error.message}`);
    await db
      .update(rateAnalysisJobs)
      .set({ 
        status: "failed",
        errorMessage: error.message,
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(rateAnalysisJobs.id, jobId));
  }
}

async function pollForJobs(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  
  try {
    const [pendingJob] = await db
      .select()
      .from(rateAnalysisJobs)
      .where(eq(rateAnalysisJobs.status, "pending"))
      .orderBy(desc(rateAnalysisJobs.createdAt))
      .limit(1);
    
    if (pendingJob) {
      await processJob(pendingJob.id);
    }
  } catch (error) {
    log(`Error polling for jobs: ${error}`);
  } finally {
    isRunning = false;
  }
}

export function startRateAnalysisBackfillWorker(): void {
  log("Starting rate analysis backfill worker");
  
  if (workerInterval) {
    clearInterval(workerInterval);
  }
  
  pollForJobs();
  workerInterval = setInterval(pollForJobs, POLL_INTERVAL_MS);
}

export function stopRateAnalysisBackfillWorker(): void {
  log("Stopping rate analysis backfill worker");
  
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
