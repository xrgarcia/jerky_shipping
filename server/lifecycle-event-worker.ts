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
  getLifecycleQueueLength,
  getLifecycleInflightCount,
  type LifecycleEvent,
  type LifecycleEventReason,
} from './utils/queue';
import { updateShipmentLifecycle } from './services/lifecycle-service';
import { type LifecycleUpdateResult } from './services/lifecycle-state-machine';
import { SmartCarrierRateService } from './services/smart-carrier-rate-service';
import { ShipStationShipmentService } from './services/shipstation-shipment-service';
import { db } from './db';
import { storage } from './storage';
import { shipments, packagingTypes, featureFlags, fingerprintModels } from '@shared/schema';
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

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = `${timestamp} [lifecycle-worker]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Worker state
let isRunning = false;
let isShuttingDown = false;
let processedCount = 0;
let sideEffectTriggeredCount = 0;
let lastPollTime: Date | null = null;

// Rate limit side effects to avoid overwhelming ShipStation API
const RATE_CHECK_BATCH_SIZE = 5; // Process this many rate checks per cycle
const POLL_INTERVAL_MS = 2000; // Check queue every 2 seconds
const IDLE_POLL_INTERVAL_MS = 10000; // When queue is empty, check less frequently
const SIDE_EFFECT_DELAY_MS = 500; // Delay between side effect executions

// Shared service instances for reuse
const rateService = new SmartCarrierRateService();
const shipmentService = new ShipStationShipmentService(storage);

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
    description: 'Auto-run smart carrier rate analysis',
    handler: async (shipmentId: string, orderNumber?: string): Promise<boolean> => {
      try {
        // Load the shipment
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipmentId))
          .limit(1);

        if (!shipment) {
          log(`Side effect: Shipment not found ${shipmentId}`, 'warn');
          return false;
        }

        // Skip if already complete or skipped
        if (shipment.rateCheckStatus === 'complete' || shipment.rateCheckStatus === 'skipped') {
          log(`Side effect: Rate check already ${shipment.rateCheckStatus} for ${orderNumber || shipmentId}`);
          return true;
        }

        // Skip if already pending (avoid duplicate processing)
        if (shipment.rateCheckStatus === 'pending') {
          log(`Side effect: Rate check already pending for ${orderNumber || shipmentId}`);
          return true;
        }

        // Mark as pending before starting
        await db
          .update(shipments)
          .set({
            rateCheckStatus: 'pending',
            rateCheckAttemptedAt: new Date(),
            rateCheckError: null,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipmentId));

        // Run rate analysis
        const result = await rateService.analyzeAndSave(shipment);
        
        if (result.success) {
          // Mark as complete
          await db
            .update(shipments)
            .set({
              rateCheckStatus: 'complete',
              rateCheckError: null,
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, shipmentId));
          
          log(`Side effect: Rate check completed for ${orderNumber || shipmentId}`);
          sideEffectTriggeredCount++;
          return true;
        } else {
          // Mark as failed with error
          await db
            .update(shipments)
            .set({
              rateCheckStatus: 'failed',
              rateCheckError: result.error || 'Unknown error',
              updatedAt: new Date(),
            })
            .where(eq(shipments.id, shipmentId));
          
          log(`Side effect: Rate check failed for ${orderNumber || shipmentId}: ${result.error}`, 'warn');
          return false;
        }
      } catch (error: any) {
        // Mark as failed with error
        await db
          .update(shipments)
          .set({
            rateCheckStatus: 'failed',
            rateCheckError: error.message || 'Exception during rate check',
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipmentId));
        
        log(`Side effect: Rate check error for ${shipmentId}: ${error.message}`, 'error');
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
  shouldRetry: boolean;  // If false and success is false, we've given up
  error?: string;        // Error message for logging/flagging
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
  supportsRetry: boolean;  // If true, failed results can trigger event retry
  handler: (shipmentId: string, orderNumber?: string, retryCount?: number) => Promise<ReasonSideEffectResult>;
}

const MAX_PACKAGE_SYNC_RETRIES = 3;

const reasonSideEffects: ReasonSideEffectConfig[] = [
  {
    enabled: true,
    reasons: ['fingerprint', 'packaging'],
    description: 'Sync package dimensions to ShipStation when packaging type is determined',
    supportsRetry: true,
    handler: async (shipmentId: string, orderNumber?: string, retryCount: number = 0): Promise<ReasonSideEffectResult> => {
      try {
        // Check feature flag first
        const flagEnabled = await isFeatureFlagEnabled('auto_package_sync');
        if (!flagEnabled) {
          log(`Package sync: Feature flag disabled, skipping for ${orderNumber || shipmentId}`);
          return { success: true, shouldRetry: false }; // Not an error, feature is just disabled
        }

        // Load the shipment with packaging type
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipmentId))
          .limit(1);

        if (!shipment) {
          log(`Package sync: Shipment not found ${shipmentId}`, 'warn');
          return { success: false, shouldRetry: false, error: 'Shipment not found' };
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
        
        // Only proceed if we have a packagingTypeId to sync
        if (!packagingTypeIdToSync) {
          log(`Package sync: No packagingTypeId set for ${orderNumber || shipmentId}, skipping`);
          return { success: true, shouldRetry: false }; // Not an error, just nothing to do
        }

        // Look up the packaging type dimensions
        const [packagingType] = await db
          .select()
          .from(packagingTypes)
          .where(eq(packagingTypes.id, packagingTypeIdToSync))
          .limit(1);

        if (!packagingType) {
          log(`Package sync: Packaging type not found ${packagingTypeIdToSync}`, 'warn');
          return { success: false, shouldRetry: false, error: `Packaging type ${packagingTypeIdToSync} not found` };
        }

        // Check if we have dimensions
        if (!packagingType.dimensionLength || !packagingType.dimensionWidth || !packagingType.dimensionHeight) {
          log(`Package sync: Packaging type ${packagingType.name} missing dimensions, skipping ShipStation sync`);
          return { success: true, shouldRetry: false }; // Not an error, some packages may not have dimensions
        }

        // Parse shipmentData to get the ShipStation payload
        const shipmentData = shipment.shipmentData as Record<string, any> | null;
        if (!shipmentData) {
          log(`Package sync: No shipmentData for ${orderNumber || shipmentId}, cannot sync to ShipStation`);
          return { success: false, shouldRetry: retryCount < MAX_PACKAGE_SYNC_RETRIES, error: 'No shipmentData available' };
        }

        // Build dimensions object with validation
        const length = parseFloat(packagingType.dimensionLength);
        const width = parseFloat(packagingType.dimensionWidth);
        const height = parseFloat(packagingType.dimensionHeight);

        // Validate dimensions are valid numbers
        if (!isFinite(length) || !isFinite(width) || !isFinite(height)) {
          log(`Package sync: Invalid dimensions for ${packagingType.name} (L:${packagingType.dimensionLength}, W:${packagingType.dimensionWidth}, H:${packagingType.dimensionHeight}), skipping`);
          return { success: true, shouldRetry: false }; // Not an error, just skip
        }

        // Check if we have the ShipStation package_id (required for proper package assignment)
        if (!packagingType.packageId) {
          log(`Package sync: Packaging type ${packagingType.name} missing ShipStation package_id, skipping sync`);
          return { success: true, shouldRetry: false };
        }

        // Build package info object with all required fields for ShipStation
        const packageInfo = {
          packageId: packagingType.packageId,  // ShipStation package_id (e.g., "se-168574")
          name: packagingType.name,            // Package name (e.g., "Poly Bagger")
          length,
          width,
          height,
          unit: packagingType.dimensionUnit || 'inch',
        };

        // Get existing package info from shipmentData for guardrail check
        const existingPkg = shipmentData.packages?.[0];
        const existingPackageName = existingPkg?.name || existingPkg?.package_name || null;
        
        // Guardrail: only allow overwrite if package_name is null/empty OR equals "Package" (case-insensitive)
        // If a specific package name was set (not default), someone intentionally changed it - don't overwrite
        const isDefaultPackage = !existingPackageName || existingPackageName.toLowerCase() === 'package';
        if (!isDefaultPackage) {
          log(`Package sync: Shipment ${orderNumber || shipmentId} has custom package "${existingPackageName}" set, skipping`);
          return { success: true, shouldRetry: false };
        }

        // Call updateShipmentPackage - use shipmentStatus (ShipStation status), not status (internal lifecycle)
        const result = await shipmentService.updateShipmentPackage(
          shipment.shipmentId,
          shipmentData,
          packageInfo,
          existingPackageName,
          shipment.shipmentStatus || 'pending'
        );

        if (result.success) {
          if (result.updated) {
            log(`Package sync: Updated ShipStation package for ${orderNumber || shipmentId} - ${packageInfo.name} (${packageInfo.length}x${packageInfo.width}x${packageInfo.height})`);
            sideEffectTriggeredCount++;
            // Clear any previous error flag since we succeeded
            await db.update(shipments)
              .set({ requiresManualPackage: false, packageAssignmentError: null })
              .where(eq(shipments.id, shipmentId));
          } else {
            log(`Package sync: Skipped ${orderNumber || shipmentId}: ${result.reason}`);
          }
          return { success: true, shouldRetry: false };
        } else {
          const errorMsg = result.error || 'Unknown ShipStation error';
          log(`Package sync: Failed for ${orderNumber || shipmentId} (attempt ${retryCount + 1}/${MAX_PACKAGE_SYNC_RETRIES}): ${errorMsg}`, 'warn');
          
          // Check if we should retry or give up
          const shouldRetry = retryCount < MAX_PACKAGE_SYNC_RETRIES - 1;
          
          if (!shouldRetry) {
            // Max retries exhausted - flag the shipment for manual intervention
            log(`Package sync: Max retries exceeded for ${orderNumber || shipmentId}, flagging for manual package assignment`, 'error');
            await db.update(shipments)
              .set({ 
                requiresManualPackage: true, 
                packageAssignmentError: `Failed after ${MAX_PACKAGE_SYNC_RETRIES} attempts: ${errorMsg}` 
              })
              .where(eq(shipments.id, shipmentId));
          }
          
          return { success: false, shouldRetry, error: errorMsg };
        }
      } catch (error: any) {
        const errorMsg = error.message || 'Unknown error';
        log(`Package sync: Error for ${shipmentId} (attempt ${retryCount + 1}/${MAX_PACKAGE_SYNC_RETRIES}): ${errorMsg}`, 'error');
        
        // Check if we should retry or give up
        const shouldRetry = retryCount < MAX_PACKAGE_SYNC_RETRIES - 1;
        
        if (!shouldRetry) {
          // Max retries exhausted - flag the shipment for manual intervention
          log(`Package sync: Max retries exceeded for ${shipmentId}, flagging for manual package assignment`, 'error');
          await db.update(shipments)
            .set({ 
              requiresManualPackage: true, 
              packageAssignmentError: `Failed after ${MAX_PACKAGE_SYNC_RETRIES} attempts: ${errorMsg}` 
            })
            .where(eq(shipments.id, shipmentId));
        }
        
        return { success: false, shouldRetry, error: errorMsg };
      }
    },
  },
];

/**
 * Process a single lifecycle event
 */
async function processEvent(event: LifecycleEvent): Promise<boolean> {
  const orderRef = event.orderNumber ? `#${event.orderNumber}` : event.shipmentId;
  
  try {
    // Run the state machine to update lifecycle
    const result = await updateShipmentLifecycle(event.shipmentId, { logTransition: true });
    
    if (!result) {
      log(`Shipment not found: ${event.shipmentId}`, 'warn');
      return true; // Don't retry if shipment doesn't exist
    }

    // If state changed and there's a side effect for the new subphase, trigger it
    if (result.changed && result.newSubphase) {
      const sideEffect = sideEffectsRegistry[result.newSubphase];
      
      if (sideEffect?.enabled) {
        log(`Triggering side effect for ${orderRef}: ${sideEffect.description}`);
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, SIDE_EFFECT_DELAY_MS));
        
        // Execute side effect (fire and forget for now - don't block queue)
        await sideEffect.handler(event.shipmentId, event.orderNumber);
      }
    }

    // Check reason-based side effects (triggered by specific event reasons)
    let needsRetry = false;
    for (const reasonEffect of reasonSideEffects) {
      if (reasonEffect.enabled && reasonEffect.reasons.includes(event.reason)) {
        log(`Triggering reason-based side effect for ${orderRef}: ${reasonEffect.description}`);
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, SIDE_EFFECT_DELAY_MS));
        
        // Pass retry count so handler knows which attempt this is
        const effectResult = await reasonEffect.handler(event.shipmentId, event.orderNumber, event.retryCount || 0);
        
        // If side effect failed and supports retry, we need to retry the whole event
        if (!effectResult.success && effectResult.shouldRetry && reasonEffect.supportsRetry) {
          log(`Reason-based side effect needs retry for ${orderRef}: ${effectResult.error}`);
          needsRetry = true;
        }
      }
    }
    
    // If any reason-based side effect needs retry, signal failure to trigger retry
    if (needsRetry) {
      return false;
    }

    processedCount++;
    return true;

  } catch (error: any) {
    log(`Error processing event for ${orderRef}: ${error.message}`, 'error');
    return false;
  }
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
          await completeLifecycleEvent(event.shipmentId);
        } else {
          // Retry with backoff
          const retried = await retryLifecycleEvent(event);
          if (!retried) {
            // Max retries exceeded, mark as complete to remove from in-flight
            await completeLifecycleEvent(event.shipmentId);
            log(`Event dropped after max retries: ${event.shipmentId}`, 'error');
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
  };
}

/**
 * Check if worker is running
 */
export function isLifecycleWorkerRunning(): boolean {
  return isRunning;
}
