/**
 * Shipment Lifecycle Service
 * 
 * Centralized service for updating shipment lifecycle phases.
 * All event handlers (webhooks, sync workers, internal actions) should
 * call this service to update lifecycle state, ensuring consistent
 * phase transitions across the entire system.
 * 
 * EVENT-DRIVEN ARCHITECTURE:
 * Instead of calling updateShipmentLifecycle() directly, producers should
 * call queueLifecycleEvaluation() to emit events. The lifecycle worker
 * consumes these events, runs the state machine, and triggers side effects.
 */

import { db } from "../db";
import { shipments, shipmentTags, type Shipment, type LifecyclePhase, type DecisionSubphase } from "@shared/schema";
import { eq, inArray, and } from "drizzle-orm";
import {
  deriveLifecyclePhase,
  statesAreEqual,
  formatTransition,
  type LifecycleUpdateResult,
  type ShipmentLifecycleData,
} from "./lifecycle-state-machine";
import {
  enqueueLifecycleEvent,
  enqueueLifecycleEventBatch,
  type LifecycleEventReason,
} from "../utils/queue";

/**
 * Update the lifecycle phase for a single shipment
 * 
 * This is the central function that all event handlers should call.
 * It derives the correct phase from shipment data and updates if changed.
 * 
 * @param shipmentId - The shipment ID to update
 * @param options - Optional configuration
 * @returns The update result with previous and new states
 */
export async function updateShipmentLifecycle(
  shipmentId: string,
  options: { 
    logTransition?: boolean;
    shipmentData?: Partial<ShipmentLifecycleData>;
  } = {}
): Promise<LifecycleUpdateResult | null> {
  const { logTransition = true, shipmentData } = options;

  // Load the shipment
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  if (!shipment) {
    console.warn(`[Lifecycle] Shipment not found: ${shipmentId}`);
    return null;
  }

  return updateShipmentLifecycleFromData(shipment, { logTransition, shipmentData });
}

/**
 * Update the lifecycle phase from shipment data (no database fetch)
 * 
 * Use this when you already have the shipment loaded.
 * 
 * @param shipment - The shipment record
 * @param options - Optional configuration
 * @returns The update result with previous and new states
 */
export async function updateShipmentLifecycleFromData(
  shipment: Shipment,
  options: { 
    logTransition?: boolean;
    shipmentData?: Partial<ShipmentLifecycleData>;
  } = {}
): Promise<LifecycleUpdateResult> {
  const { logTransition = true, shipmentData } = options;

  // Check if shipment has MOVE OVER tag in the database
  const moveOverTag = await db
    .select({ id: shipmentTags.id })
    .from(shipmentTags)
    .where(and(
      eq(shipmentTags.shipmentId, shipment.id),
      eq(shipmentTags.name, 'MOVE OVER')
    ))
    .limit(1);
  const hasMoveOverTag = moveOverTag.length > 0;

  // Merge any provided shipment data updates (for pre-save checks)
  const rawFulfillmentSessionId = shipmentData?.fulfillmentSessionId ?? shipment.fulfillmentSessionId;
  const effectiveData: ShipmentLifecycleData = {
    sessionStatus: shipmentData?.sessionStatus ?? shipment.sessionStatus,
    trackingNumber: shipmentData?.trackingNumber ?? shipment.trackingNumber,
    status: shipmentData?.status ?? shipment.status,
    shipmentStatus: shipmentData?.shipmentStatus ?? shipment.shipmentStatus,
    fingerprintStatus: shipmentData?.fingerprintStatus ?? shipment.fingerprintStatus,
    packagingTypeId: shipmentData?.packagingTypeId ?? shipment.packagingTypeId,
    fulfillmentSessionId: rawFulfillmentSessionId != null ? String(rawFulfillmentSessionId) : null,
    fingerprintId: shipmentData?.fingerprintId ?? shipment.fingerprintId,
    hasMoveOverTag,
    rateCheckStatus: shipmentData?.rateCheckStatus ?? shipment.rateCheckStatus,
    shipmentId: shipmentData?.shipmentId ?? shipment.shipmentId,
    shipToPostalCode: shipmentData?.shipToPostalCode ?? shipment.shipToPostalCode,
    serviceCode: shipmentData?.serviceCode ?? shipment.serviceCode,
  };

  // Derive the correct lifecycle state
  const derivedState = deriveLifecyclePhase(effectiveData);
  
  // Check if state changed
  const currentState = {
    phase: shipment.lifecyclePhase as LifecyclePhase | null,
    subphase: shipment.decisionSubphase as DecisionSubphase | null,
  };
  
  const changed = !statesAreEqual(currentState, derivedState);
  const now = new Date();

  const result: LifecycleUpdateResult = {
    shipmentId: shipment.id,
    orderNumber: shipment.orderNumber,
    changed,
    previousPhase: currentState.phase,
    previousSubphase: currentState.subphase,
    newPhase: derivedState.phase,
    newSubphase: derivedState.subphase,
    timestamp: now,
  };

  // Update if changed
  if (changed) {
    await db
      .update(shipments)
      .set({
        lifecyclePhase: derivedState.phase,
        decisionSubphase: derivedState.subphase,
        lifecyclePhaseChangedAt: now,
        updatedAt: now,
      })
      .where(eq(shipments.id, shipment.id));
  }

  // Log the transition
  if (logTransition && changed) {
    console.log(formatTransition(result));
  }

  return result;
}

/**
 * Update lifecycle for multiple shipments in batch
 * 
 * Useful for bulk operations like packaging assignment to fingerprints.
 * 
 * @param shipmentIds - Array of shipment IDs to update
 * @returns Array of update results
 */
export async function updateShipmentLifecycleBatch(
  shipmentIds: string[]
): Promise<LifecycleUpdateResult[]> {
  if (shipmentIds.length === 0) {
    return [];
  }

  const results: LifecycleUpdateResult[] = [];
  
  // Load all shipments using inArray
  const allShipments = await db
    .select()
    .from(shipments)
    .where(inArray(shipments.id, shipmentIds));

  // Process each shipment
  for (const shipment of allShipments) {
    const result = await updateShipmentLifecycleFromData(shipment, { logTransition: false });
    results.push(result);
  }

  // Log summary
  const changedCount = results.filter(r => r.changed).length;
  if (changedCount > 0) {
    console.log(`[Lifecycle] Batch update: ${changedCount}/${results.length} shipments changed phases`);
  }

  return results;
}

/**
 * Recalculate lifecycle for a shipment by order number
 * 
 * Convenience function for use in routes where order number is more accessible.
 * 
 * @param orderNumber - The order number to look up
 * @returns The update result or null if not found
 */
export async function updateShipmentLifecycleByOrderNumber(
  orderNumber: string
): Promise<LifecycleUpdateResult | null> {
  const [shipment] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.orderNumber, orderNumber))
    .limit(1);

  if (!shipment) {
    console.warn(`[Lifecycle] Shipment not found for order: ${orderNumber}`);
    return null;
  }

  return updateShipmentLifecycleFromData(shipment);
}

// ============================================================================
// EVENT-DRIVEN LIFECYCLE FUNCTIONS
// ============================================================================
// These functions queue lifecycle events for async processing instead of
// updating immediately. This enables reliable side-effect triggering.
// ============================================================================

/**
 * Queue a lifecycle evaluation for a single shipment
 * 
 * This is the preferred way to trigger lifecycle updates. Instead of
 * calling updateShipmentLifecycle() directly, emit an event that the
 * lifecycle worker will process asynchronously.
 * 
 * @param shipmentId - The shipment UUID (primary key)
 * @param reason - Why the evaluation is being triggered
 * @param orderNumber - Optional order number for logging
 * @param metadata - Optional extra context
 * @returns true if event was queued, false if already in queue
 */
export async function queueLifecycleEvaluation(
  shipmentId: string,
  reason: LifecycleEventReason,
  orderNumber?: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  return enqueueLifecycleEvent({
    shipmentId,
    reason,
    orderNumber,
    enqueuedAt: Date.now(),
    metadata,
  });
}

/**
 * Queue lifecycle evaluations for multiple shipments
 * 
 * Use this for batch operations like packaging assignment to fingerprints.
 * Events are deduplicated - if a shipment is already queued, it won't be
 * added again.
 * 
 * @param items - Array of shipment IDs and order numbers
 * @param reason - Why the evaluations are being triggered
 * @returns Number of events successfully queued
 */
export async function queueLifecycleEvaluationBatch(
  items: Array<{ shipmentId: string; orderNumber?: string }>,
  reason: LifecycleEventReason
): Promise<number> {
  const now = Date.now();
  const events = items.map(item => ({
    shipmentId: item.shipmentId,
    orderNumber: item.orderNumber,
    reason,
    enqueuedAt: now,
  }));
  return enqueueLifecycleEventBatch(events);
}
