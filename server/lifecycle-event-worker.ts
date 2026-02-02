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
import { shipments, packagingTypes, featureFlags } from '@shared/schema';
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

        // Run rate analysis
        const result = await rateService.analyzeAndSave(shipment);
        
        if (result.success) {
          log(`Side effect: Rate check completed for ${orderNumber || shipmentId}`);
          sideEffectTriggeredCount++;
          return true;
        } else {
          log(`Side effect: Rate check failed for ${orderNumber || shipmentId}: ${result.error}`, 'warn');
          return false;
        }
      } catch (error: any) {
        log(`Side effect: Rate check error for ${shipmentId}: ${error.message}`, 'error');
        return false;
      }
    },
  },
};

/**
 * Reason-based side effects - triggered based on event reason + shipment state
 * Unlike subphase effects which trigger on entering a state, these trigger
 * when specific actions complete (e.g., fingerprint assigned with packaging)
 */
interface ReasonSideEffectConfig {
  enabled: boolean;
  reasons: LifecycleEventReason[];
  description: string;
  handler: (shipmentId: string, orderNumber?: string) => Promise<boolean>;
}

const reasonSideEffects: ReasonSideEffectConfig[] = [
  {
    enabled: true,
    reasons: ['fingerprint', 'packaging'],
    description: 'Sync package dimensions to ShipStation when packaging type is determined',
    handler: async (shipmentId: string, orderNumber?: string): Promise<boolean> => {
      try {
        // Check feature flag first
        const flagEnabled = await isFeatureFlagEnabled('auto_package_sync');
        if (!flagEnabled) {
          log(`Package sync: Feature flag disabled, skipping for ${orderNumber || shipmentId}`);
          return true; // Not an error, feature is just disabled
        }

        // Load the shipment with packaging type
        const [shipment] = await db
          .select()
          .from(shipments)
          .where(eq(shipments.id, shipmentId))
          .limit(1);

        if (!shipment) {
          log(`Package sync: Shipment not found ${shipmentId}`, 'warn');
          return false;
        }

        // Only proceed if shipment has a packagingTypeId
        if (!shipment.packagingTypeId) {
          log(`Package sync: No packagingTypeId set for ${orderNumber || shipmentId}, skipping`);
          return true; // Not an error, just nothing to do
        }

        // Look up the packaging type dimensions
        const [packagingType] = await db
          .select()
          .from(packagingTypes)
          .where(eq(packagingTypes.id, shipment.packagingTypeId))
          .limit(1);

        if (!packagingType) {
          log(`Package sync: Packaging type not found ${shipment.packagingTypeId}`, 'warn');
          return false;
        }

        // Check if we have dimensions
        if (!packagingType.dimensionLength || !packagingType.dimensionWidth || !packagingType.dimensionHeight) {
          log(`Package sync: Packaging type ${packagingType.name} missing dimensions, skipping ShipStation sync`);
          return true; // Not an error, some packages may not have dimensions
        }

        // Parse shipmentData to get the ShipStation payload
        const shipmentData = shipment.shipmentData as Record<string, any> | null;
        if (!shipmentData) {
          log(`Package sync: No shipmentData for ${orderNumber || shipmentId}, cannot sync to ShipStation`);
          return false;
        }

        // Build dimensions object with validation
        const length = parseFloat(packagingType.dimensionLength);
        const width = parseFloat(packagingType.dimensionWidth);
        const height = parseFloat(packagingType.dimensionHeight);

        // Validate dimensions are valid numbers
        if (!isFinite(length) || !isFinite(width) || !isFinite(height)) {
          log(`Package sync: Invalid dimensions for ${packagingType.name} (L:${packagingType.dimensionLength}, W:${packagingType.dimensionWidth}, H:${packagingType.dimensionHeight}), skipping`);
          return true; // Not an error, just skip
        }

        const packageDimensions = {
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
          return true;
        }

        // Call updateShipmentPackage
        const result = await shipmentService.updateShipmentPackage(
          shipment.shipmentId,
          shipmentData,
          packageDimensions,
          existingPackageName,
          shipment.status || 'pending'
        );

        if (result.success) {
          if (result.updated) {
            log(`Package sync: Updated ShipStation package for ${orderNumber || shipmentId} - ${packageDimensions.length}x${packageDimensions.width}x${packageDimensions.height}`);
            sideEffectTriggeredCount++;
          } else {
            log(`Package sync: Skipped ${orderNumber || shipmentId}: ${result.reason}`);
          }
          return true;
        } else {
          log(`Package sync: Failed for ${orderNumber || shipmentId}: ${result.error}`, 'warn');
          return false;
        }
      } catch (error: any) {
        log(`Package sync: Error for ${shipmentId}: ${error.message}`, 'error');
        return false;
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
    for (const reasonEffect of reasonSideEffects) {
      if (reasonEffect.enabled && reasonEffect.reasons.includes(event.reason)) {
        log(`Triggering reason-based side effect for ${orderRef}: ${reasonEffect.description}`);
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, SIDE_EFFECT_DELAY_MS));
        
        await reasonEffect.handler(event.shipmentId, event.orderNumber);
      }
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
