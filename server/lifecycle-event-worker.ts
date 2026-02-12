/**
 * Lifecycle Event Worker
 * 
 * EVENT-DRIVEN ARCHITECTURE:
 * This worker consumes lifecycle events from a Redis queue, runs the
 * state machine to derive the correct phase/subphase, updates the database,
 * and triggers side effects based on state transitions.
 * 
 * FLOW:
 *   Producer (webhook, sync, user action) 
 *     → queueLifecycleEvaluation()
 *     → Redis Queue
 *     → This Worker
 *     → State Machine (deriveLifecyclePhase)
 *     → Side Effects (subphase-based and reason-based)
 * 
 * SIDE EFFECTS - TWO TYPES:
 * 
 * 1. SUBPHASE-BASED (sideEffectsRegistry):
 *    Triggered when a shipment ENTERS a specific subphase:
 *    - NEEDS_RATE_CHECK → Run smart carrier rate analysis
 * 
 * 2. REASON-BASED (reasonSideEffects):
 *    Triggered based on the event reason, regardless of subphase:
 *    - fingerprint/packaging → Sync package dimensions to ShipStation
 *      (when packagingTypeId is set, updates ShipStation with box dimensions)
 * 
 * FEATURES:
 * - FIFO processing with deduplication
 * - Retry with exponential backoff (max 3 retries)
 * - Graceful shutdown handling
 * - Rate limiting to avoid overwhelming external APIs
 */

import {
  dequeueLifecycleEvent,
  completeLifecycleEvent,
  retryLifecycleEvent,
  enqueueLifecycleEvent,
  getLifecycleQueueLength,
  getLifecycleInflightCount,
  type LifecycleEvent,
  type LifecycleEventReason,
} from './utils/queue';
import logger, { withOrder } from './utils/logger';
import { updateShipmentLifecycle } from './services/lifecycle-service';
import { type LifecycleUpdateResult } from './services/lifecycle-state-machine';
import { withSpan, tagCurrentSpan } from './utils/tracing';
import { SmartCarrierRateService } from './services/smart-carrier-rate-service';
import { db } from './db';
import { shipments, packagingTypes, featureFlags, fingerprintModels, shipmentSyncFailures } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { DECISION_SUBPHASES } from '@shared/schema';

// Feature flag helper - checks if a feature is enabled in the database
async function isFeatureFlagEnabled(key: string): Promise<boolean> {
  try {
    const [flag] = await db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .limit(1);
    return flag?.enabled ?? false;
  } catch (error) {
    log(`Feature flag check error for ${key}: ${error}`, 'warn');
    return false; // Default to disabled on error
  }
}

async function logPackageSyncFailureToDLQ(
  shipmentId: string,
  shipstationShipmentId: string | null,
  orderNumber: string,
  errorMessage: string,
  retryCount: number,
  metadata?: Record<string, any>
): Promise<void> {
  try {
    await db.insert(shipmentSyncFailures).values({
      shipstationShipmentId,
      orderNumber,
      reason: 'package_sync',
      errorMessage,
      requestData: metadata ?? null,
      retryCount,
      failedAt: new Date(),
    });
    log(`Package sync DLQ: Logged failure for ${orderNumber} (shipment ${shipmentId})`, 'info', withOrder(orderNumber, shipmentId));
  } catch (dlqError: any) {
    log(`Package sync DLQ: Failed to log entry for ${orderNumber}: ${dlqError.message}`, 'error', withOrder(orderNumber, shipmentId));
  }
}

function log(message: string, level: 'info' | 'warn' | 'error' = 'info', ctx?: Record<string, any>) {
  const prefix = '[lifecycle-worker]';
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    logger.info(`${prefix} ${message}`, ctx || {});
  }
}

// Worker state
let isRunning = false;
let isShuttingDown = false;
let processedCount = 0;
let sideEffectTriggeredCount = 0;
let lastPollTime: Date | null = null;

// Recent transitions ring buffer for monitoring
const MAX_RECENT_TRANSITIONS = 100;
interface RecentTransition {
  timestamp: Date;
  orderNumber: string;
  shipmentId: string;
  previousPhase: string | null;
  previousSubphase: string | null;
  newPhase: string;
  newSubphase: string | null;
  changed: boolean;
  reason: string;
  sideEffectTriggered: string | null;
  sideEffectResult: 'success' | 'failed' | 'skipped' | null;
}
const recentTransitions: RecentTransition[] = [];
let errorCount = 0;
let lastErrorMessage: string | null = null;
let lastErrorTime: Date | null = null;

// Rate limit side effects to avoid overwhelming ShipStation API
const RATE_CHECK_BATCH_SIZE = 5; // Process this many rate checks per cycle
const POLL_INTERVAL_MS = 2000; // Check queue every 2 seconds
const IDLE_POLL_INTERVAL_MS = 10000; // When queue is empty, check less frequently
const SIDE_EFFECT_DELAY_MS = 500; // Delay between side effect executions

// Shared service instances for reuse
const rateService = new SmartCarrierRateService();

/**
 * Side effect registry - maps state transitions to automated actions
 */
interface SideEffectConfig {
  enabled: boolean;
  handler: (shipmentId: string, orderNumber?: string) => Promise<boolean>;
  description: string;
}

const sideEffectsRegistry: Record<string, SideEffectConfig> = {
  // When a shipment needs a rate check, automatically run one
  [DECISION_SUBPHASES.NEEDS_RATE_CHECK]: {
    enabled: true,
    description: 'Enqueue rate check to dedicated queue',
    handler: async (shipmentId: string, orderNumber?: string): Promise<boolean> => {
      try {
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipmentId))
          .limit(1);

        if (!shipment) {
          log(`Side effect: Shipment not found ${shipmentId}`, 'warn');
          return false;
        }

        if (shipment.rateCheckStatus === 'complete' || shipment.rateCheckStatus === 'skipped') {
          log(`Side effect: Rate check already ${shipment.rateCheckStatus} for ${orderNumber || shipmentId}`);
          return true;
        }

        if (shipment.rateCheckStatus === 'pending') {
          log(`Side effect: Rate check already pending for ${orderNumber || shipmentId}`);
          return true;
        }

        const { enqueueRateCheck } = await import('./services/rate-check-queue');
        const jobId = await enqueueRateCheck({
          shipmentId: shipment.shipmentId!,
          localShipmentId: shipmentId,
          orderNumber: orderNumber,
          serviceCode: shipment.serviceCode ?? undefined,
          destinationPostalCode: shipment.shipToPostalCode ?? undefined,
        });

        log(`Side effect: Enqueued rate check job #${jobId} for ${orderNumber || shipmentId}`);
        sideEffectTriggeredCount++;
        return true;
      } catch (error: any) {
        log(`Side effect: Error enqueuing rate check for ${shipmentId}: ${error.message}`, 'error');
        return false;
      }
    },
  },
};

/**
 * Result from a reason-based side effect
 */
interface ReasonSideEffectResult {
  success: boolean;
  shouldRetry: boolean;
  shouldRequeue: boolean;
  error?: string;
}

/**
 * Reason-based side effects - triggered based on event reason + shipment state
 * Unlike subphase effects which trigger on entering a state, these trigger
 * when specific actions complete (e.g., fingerprint assigned with packaging)
 */
interface ReasonSideEffectConfig {
  enabled: boolean;
  reasons: LifecycleEventReason[];
  description: string;
  supportsRetry: boolean;
  handler: (shipmentId: string, orderNumber?: string, retryCount?: number, metadata?: Record<string, any>) => Promise<ReasonSideEffectResult>;
}

const MAX_PACKAGE_SYNC_RETRIES = 3;

const reasonSideEffects: ReasonSideEffectConfig[] = [
  {
    enabled: true,
    reasons: ['fingerprint', 'packaging', 'packaging_model_assign', 'packaging_bulk_assign', 'manual_package_sync'],
    description: 'Sync package dimensions to ShipStation when packaging type is determined',
    supportsRetry: true,
    handler: async (shipmentId: string, orderNumber?: string, retryCount: number = 0, metadata?: Record<string, any>): Promise<ReasonSideEffectResult> => {
      const ref = orderNumber || shipmentId;
      const alreadyRequeued = metadata?.packageSyncRequeued === true;
      try {
        const flagEnabled = await isFeatureFlagEnabled('auto_package_sync');
        if (!flagEnabled) {
          log(`Package sync: Feature flag disabled, skipping for ${ref}`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        // Load the shipment with packaging type
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipmentId))
          .limit(1);

        if (!shipment) {
          log(`Package sync: Shipment not found ${shipmentId}`, 'warn');
          return { success: false, shouldRetry: false, shouldRequeue: false, error: 'Shipment not found' };
        }

        // If shipment doesn't have a packagingTypeId, try to get it from the fingerprint model
        let packagingTypeIdToSync = shipment.packagingTypeId;
        
        if (!packagingTypeIdToSync && shipment.fingerprintId) {
          // Look up the fingerprint model (learned rule: fingerprint → packaging type)
          const [model] = await db
            .select({ packagingTypeId: fingerprintModels.packagingTypeId })
            .from(fingerprintModels)
            .where(eq(fingerprintModels.fingerprintId, shipment.fingerprintId))
            .limit(1);
          
          if (model?.packagingTypeId) {
            // Copy packaging type from fingerprint model to shipment
            log(`Package sync: Copying packagingTypeId from fingerprint model to shipment ${orderNumber || shipmentId}`);
            await db.update(shipments)
              .set({ 
                packagingTypeId: model.packagingTypeId,
                requiresManualPackage: false,
                packageAssignmentError: null
              })
              .where(eq(shipments.id, shipmentId));
            packagingTypeIdToSync = model.packagingTypeId;
          }
        }
        
        if (!packagingTypeIdToSync) {
          log(`Package sync: No packagingTypeId set for ${ref}, skipping`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        const [packagingType] = await db
          .select()
          .from(packagingTypes)
          .where(eq(packagingTypes.id, packagingTypeIdToSync))
          .limit(1);

        if (!packagingType) {
          log(`Package sync: Packaging type not found ${packagingTypeIdToSync}`, 'warn');
          return { success: false, shouldRetry: false, shouldRequeue: false, error: `Packaging type ${packagingTypeIdToSync} not found` };
        }

        if (!packagingType.dimensionLength || !packagingType.dimensionWidth || !packagingType.dimensionHeight) {
          log(`Package sync: Packaging type ${packagingType.name} missing dimensions, skipping ShipStation sync`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        const shipmentData = shipment.shipmentData as Record<string, any> | null;
        if (!shipmentData) {
          log(`Package sync: No shipmentData for ${ref}, cannot sync to ShipStation`);
          return { success: false, shouldRetry: retryCount < MAX_PACKAGE_SYNC_RETRIES, shouldRequeue: false, error: 'No shipmentData available' };
        }

        const length = parseFloat(packagingType.dimensionLength);
        const width = parseFloat(packagingType.dimensionWidth);
        const height = parseFloat(packagingType.dimensionHeight);

        if (!isFinite(length) || !isFinite(width) || !isFinite(height)) {
          log(`Package sync: Invalid dimensions for ${packagingType.name} (L:${packagingType.dimensionLength}, W:${packagingType.dimensionWidth}, H:${packagingType.dimensionHeight}), skipping`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        if (!packagingType.packageId) {
          log(`Package sync: Packaging type ${packagingType.name} missing ShipStation package_id, skipping sync`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        const packageInfo = {
          packageId: packagingType.packageId,
          name: packagingType.name,
          length,
          width,
          height,
          unit: packagingType.dimensionUnit || 'inch',
        };

        const existingPkg = shipmentData.packages?.[0];
        const existingPackageName = existingPkg?.name || existingPkg?.package_name || null;
        
        const isDefaultPackage = !existingPackageName || existingPackageName.toLowerCase() === 'package';
        if (!isDefaultPackage) {
          log(`Package sync: Shipment ${ref} has custom package "${existingPackageName}" set, skipping`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        if (shipment.shipmentStatus !== 'pending') {
          log(`Package sync: Shipment ${ref} status is "${shipment.shipmentStatus}", not "pending", skipping`);
          return { success: true, shouldRetry: false, shouldRequeue: false };
        }

        const patchPayload: Record<string, any> = {
          packages: [{
            package_id: packageInfo.packageId,
            $remove: ['shipment_package_id', 'package_code', 'dimensions', 'name', 'package_name'],
          }],
        };

        const { enqueueShipStationWrite } = await import('./services/shipstation-write-queue');
        const jobId = await enqueueShipStationWrite({
          shipmentId: shipment.shipmentId!,
          patchPayload,
          reason: 'package_sync',
          localShipmentId: shipmentId,
          callbackAction: 'clear_manual_package_flag',
          orderNumber: shipment.orderNumber ?? undefined,
        });

        log(`Package sync: Enqueued write job #${jobId} for ${ref} - ${packageInfo.name} (${packageInfo.packageId})`);
        sideEffectTriggeredCount++;
        return { success: true, shouldRetry: false, shouldRequeue: false };

      } catch (error: any) {
        const errorMsg = error.message || 'Unknown error';
        log(`Package sync: Error enqueuing for ${ref}: ${errorMsg}`, 'error');
        
        return { success: false, shouldRetry: false, shouldRequeue: false, error: errorMsg };
      }
    },
  },
];

/**
 * Process a single lifecycle event
 */
async function processEvent(event: LifecycleEvent): Promise<boolean> {
  const orderRef = event.orderNumber ? `#${event.orderNumber}` : event.shipmentId;
  
  return withSpan('lifecycle', 'state_evaluation', 'process_event', async (span) => {
  try {
    // Run the state machine to update lifecycle
    const result = await updateShipmentLifecycle(event.shipmentId, { logTransition: true });
    
    if (!result) {
      log(`Shipment not found: ${event.shipmentId}`, 'warn', withOrder(event.orderNumber, event.shipmentId));
      return true; // Don't retry if shipment doesn't exist
    }

    // If state changed and there's a side effect for the new subphase, trigger it
    if (result.changed && result.newSubphase) {
      const sideEffect = sideEffectsRegistry[result.newSubphase];
      
      if (sideEffect?.enabled) {
        tagCurrentSpan('lifecycle', 'side_effects', { shipmentId: event.shipmentId, orderNumber: event.orderNumber });
        log(`Triggering side effect for ${orderRef}: ${sideEffect.description}`, 'info', withOrder(event.orderNumber, event.shipmentId, { subphase: result.newSubphase }));
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, SIDE_EFFECT_DELAY_MS));
        
        // Execute side effect (fire and forget for now - don't block queue)
        await sideEffect.handler(event.shipmentId, event.orderNumber);
      }
    }

    let needsRetry = false;
    let needsRequeue = false;
    for (const reasonEffect of reasonSideEffects) {
      if (reasonEffect.enabled && reasonEffect.reasons.includes(event.reason)) {
        log(`Triggering reason-based side effect for ${orderRef}: ${reasonEffect.description}`, 'info', withOrder(event.orderNumber, event.shipmentId));
        
        await new Promise(resolve => setTimeout(resolve, SIDE_EFFECT_DELAY_MS));
        
        const effectResult = await reasonEffect.handler(event.shipmentId, event.orderNumber, event.retryCount || 0, event.metadata);
        
        if (!effectResult.success && effectResult.shouldRetry && reasonEffect.supportsRetry) {
          log(`Reason-based side effect needs retry for ${orderRef}: ${effectResult.error}`);
          needsRetry = true;
        }
        
        if (!effectResult.success && effectResult.shouldRequeue) {
          needsRequeue = true;
        }
      }
    }
    
    // One-time re-queue: all retries exhausted but handler wants another round
    // The requeued event gets a fresh retryCount=0 but carries packageSyncRequeued=true
    // to prevent infinite loops (handler checks this flag and won't request another re-queue)
    if (needsRequeue) {
      try {
        await completeLifecycleEvent(event.shipmentId, event.reason);
        const requeuedEvent: LifecycleEvent = {
          shipmentId: event.shipmentId,
          orderNumber: event.orderNumber,
          reason: event.reason,
          enqueuedAt: Date.now(),
          retryCount: 0,
          metadata: { ...event.metadata, packageSyncRequeued: true },
        };
        const enqueued = await enqueueLifecycleEvent(requeuedEvent);
        if (enqueued) {
          log(`Re-queued package sync for ${orderRef} (one-time re-queue, fresh retry cycle)`);
        } else {
          log(`Re-queue skipped for ${orderRef} (already in queue)`, 'warn');
        }
      } catch (requeueError: any) {
        log(`Failed to re-queue package sync for ${orderRef}: ${requeueError.message}, flagging for manual intervention`, 'error');
        const failureMsg3 = `Re-queue failed: ${requeueError.message}`;
        await db.update(shipments)
          .set({ 
            requiresManualPackage: true, 
            packageAssignmentError: failureMsg3
          })
          .where(eq(shipments.id, event.shipmentId));
        await logPackageSyncFailureToDLQ(event.shipmentId, null, event.orderNumber || orderRef, failureMsg3, 0, { phase: 'requeue_failed' });
      }
      return true;
    }
    
    if (needsRetry) {
      return false;
    }

    // Record transition in ring buffer
    const transition: RecentTransition = {
      timestamp: new Date(),
      orderNumber: event.orderNumber || 'unknown',
      shipmentId: event.shipmentId,
      previousPhase: result.previousPhase,
      previousSubphase: result.previousSubphase,
      newPhase: result.newPhase,
      newSubphase: result.newSubphase,
      changed: result.changed,
      reason: event.reason,
      sideEffectTriggered: null,
      sideEffectResult: null,
    };
    
    // Track side effect info
    if (result.changed && result.newSubphase) {
      const sideEffect = sideEffectsRegistry[result.newSubphase];
      if (sideEffect?.enabled) {
        transition.sideEffectTriggered = sideEffect.description;
        transition.sideEffectResult = 'success';
      }
    }
    
    recentTransitions.unshift(transition);
    if (recentTransitions.length > MAX_RECENT_TRANSITIONS) {
      recentTransitions.pop();
    }

    processedCount++;
    return true;

  } catch (error: any) {
    log(`Error processing event for ${orderRef}: ${error.message}`, 'error');
    errorCount++;
    lastErrorMessage = error.message;
    lastErrorTime = new Date();
    return false;
  }
  }, { shipmentId: event.shipmentId, orderNumber: event.orderNumber });
}

/**
 * Process events from the queue in a loop
 */
async function processQueue(): Promise<void> {
  while (isRunning && !isShuttingDown) {
    lastPollTime = new Date();
    
    try {
      // Check queue length for logging
      const queueLength = await getLifecycleQueueLength();
      
      if (queueLength === 0) {
        // Queue is empty, poll less frequently
        await new Promise(resolve => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
        continue;
      }

      // Process events in batches to allow side effects time
      let batchProcessed = 0;
      
      while (batchProcessed < RATE_CHECK_BATCH_SIZE && !isShuttingDown) {
        const event = await dequeueLifecycleEvent();
        
        if (!event) {
          break; // Queue is empty
        }

        const success = await processEvent(event);

        if (success) {
          // Mark as complete - remove from in-flight set
          await completeLifecycleEvent(event.shipmentId, event.reason);
        } else {
          // Retry with backoff
          const retried = await retryLifecycleEvent(event);
          if (!retried) {
            // Max retries exceeded, mark as complete to remove from in-flight
            await completeLifecycleEvent(event.shipmentId, event.reason);
            log(`Event dropped after max retries: ${event.shipmentId}`, 'error', withOrder(event.orderNumber, event.shipmentId));
          }
        }

        batchProcessed++;
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    } catch (error: any) {
      log(`Queue processing error: ${error.message}`, 'error');
      // Wait before retrying to avoid tight error loop
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Start the lifecycle event worker
 */
export function startLifecycleWorker(): void {
  if (isRunning) {
    log('Worker already running', 'warn');
    return;
  }

  isRunning = true;
  isShuttingDown = false;
  processedCount = 0;
  sideEffectTriggeredCount = 0;

  log('Starting lifecycle event worker...');

  // Start processing queue
  processQueue().catch(error => {
    log(`Worker crashed: ${error.message}`, 'error');
    isRunning = false;
  });
}

/**
 * Stop the lifecycle event worker gracefully
 */
export function stopLifecycleWorker(): void {
  if (!isRunning) {
    log('Worker not running', 'warn');
    return;
  }

  log('Stopping lifecycle event worker...');
  isShuttingDown = true;
  isRunning = false;
}

/**
 * Get worker status for operations dashboard
 */
export async function getLifecycleWorkerStatus(): Promise<{
  running: boolean;
  shuttingDown: boolean;
  processedCount: number;
  sideEffectTriggeredCount: number;
  queueLength: number;
  inflightCount: number;
  lastPollTime: Date | null;
  recentTransitions: RecentTransition[];
  errorCount: number;
  lastErrorMessage: string | null;
  lastErrorTime: Date | null;
}> {
  const [queueLength, inflightCount] = await Promise.all([
    getLifecycleQueueLength(),
    getLifecycleInflightCount(),
  ]);

  return {
    running: isRunning,
    shuttingDown: isShuttingDown,
    processedCount,
    sideEffectTriggeredCount,
    queueLength,
    inflightCount,
    lastPollTime,
    recentTransitions,
    errorCount,
    lastErrorMessage,
    lastErrorTime,
  };
}

/**
 * Check if worker is running
 */
export function isLifecycleWorkerRunning(): boolean {
  return isRunning;
}
