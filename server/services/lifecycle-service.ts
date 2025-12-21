/**
 * Shipment Lifecycle Service
 * 
 * Centralized service for updating shipment lifecycle phases.
 * All event handlers (webhooks, sync workers, internal actions) should
 * call this service to update lifecycle state, ensuring consistent
 * phase transitions across the entire system.
 */

import { db } from "../db";
import { shipments, type Shipment, type LifecyclePhase, type DecisionSubphase } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import {
  deriveLifecyclePhase,
  statesAreEqual,
  formatTransition,
  type LifecycleUpdateResult,
  type ShipmentLifecycleData,
} from "./lifecycle-state-machine";

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

  // Merge any provided shipment data updates (for pre-save checks)
  const effectiveData: ShipmentLifecycleData = {
    sessionStatus: shipmentData?.sessionStatus ?? shipment.sessionStatus,
    trackingNumber: shipmentData?.trackingNumber ?? shipment.trackingNumber,
    status: shipmentData?.status ?? shipment.status,
    shipmentStatus: shipmentData?.shipmentStatus ?? shipment.shipmentStatus,
    fingerprintStatus: shipmentData?.fingerprintStatus ?? shipment.fingerprintStatus,
    packagingTypeId: shipmentData?.packagingTypeId ?? shipment.packagingTypeId,
    fulfillmentSessionId: shipmentData?.fulfillmentSessionId ?? shipment.fulfillmentSessionId,
    fingerprintId: shipmentData?.fingerprintId ?? shipment.fingerprintId,
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
