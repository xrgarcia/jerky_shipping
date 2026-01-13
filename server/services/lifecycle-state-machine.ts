/**
 * Shipment Lifecycle State Machine
 * 
 * Manages the progression of shipments through their lifecycle phases:
 * ready_to_session → awaiting_decisions → ready_to_pick → picking → packing_ready → on_dock
 *                                                               ↘ picking_issues (exception path)
 * 
 * READY_TO_SESSION: On hold + MOVE OVER tag + no session - fingerprinting & QC explosion happens here
 * 
 * Within AWAITING_DECISIONS, manages decision subphases:
 * needs_categorization → needs_fingerprint → needs_packaging → needs_session → ready_for_skuvault
 */

import {
  LIFECYCLE_PHASES,
  DECISION_SUBPHASES,
  LIFECYCLE_TRANSITIONS,
  DECISION_TRANSITIONS,
  type LifecyclePhase,
  type DecisionSubphase,
} from "@shared/schema";

export interface LifecycleState {
  phase: LifecyclePhase;
  subphase: DecisionSubphase | null;
}

export interface TransitionResult {
  success: boolean;
  error?: string;
  previousState: LifecycleState;
  newState: LifecycleState;
}

/**
 * Check if a lifecycle phase transition is valid
 */
export function canTransitionPhase(
  currentPhase: LifecyclePhase,
  targetPhase: LifecyclePhase
): boolean {
  const allowedTransitions = LIFECYCLE_TRANSITIONS[currentPhase];
  return allowedTransitions.includes(targetPhase);
}

/**
 * Check if a decision subphase transition is valid
 */
export function canTransitionSubphase(
  currentSubphase: DecisionSubphase,
  targetSubphase: DecisionSubphase
): boolean {
  const allowedTransitions = DECISION_TRANSITIONS[currentSubphase];
  return allowedTransitions.includes(targetSubphase);
}

/**
 * Shipment data required for lifecycle phase derivation
 */
export interface ShipmentLifecycleData {
  sessionStatus?: string | null;
  trackingNumber?: string | null;
  status?: string | null;           // ShipStation fulfillment status (e.g., 'AC' = accepted by carrier)
  shipmentStatus?: string | null;   // ShipStation shipment lifecycle status (on_hold, pending, etc.)
  fingerprintStatus?: string | null;
  packagingTypeId?: string | null;
  fulfillmentSessionId?: string | null;
  fingerprintId?: string | null;
  hasMoveOverTag?: boolean;         // Whether shipment has the "MOVE OVER" tag (for ready_to_session detection)
}

// Status codes that indicate package is on the dock (at the facility)
const ON_DOCK_STATUSES = ['NY', 'AC'];

/**
 * Determine the lifecycle phase based on shipment data
 * 
 * This derives the phase from existing shipment fields for backwards compatibility
 * with shipments that don't yet have explicit lifecyclePhase set.
 * 
 * Phase priority (checked in order):
 * 1. ON_DOCK - Has tracking number AND status IN ['NY', 'AC'] (labeled, at facility)
 * 2. PICKING_ISSUES - Session status is 'inactive'
 * 3. PACKING_READY - Session closed, no tracking yet, shipmentStatus='pending'
 * 4. PICKING - Session is 'active'
 * 5. READY_TO_PICK - Session is 'new'
 * 6. READY_TO_SESSION - On hold + MOVE OVER tag + no session (fingerprinting happens here)
 * 7. AWAITING_DECISIONS - Has fingerprint, needs packing decisions
 * 
 * Note: Status codes for tracking:
 * - NY = Not Yet in System (label created, waiting for carrier pickup)
 * - AC = Accepted by Carrier (carrier just picked it up)
 * - IT = In Transit (on the way to customer) - past ON_DOCK
 * - DE = Delivered (customer received) - past ON_DOCK
 */
export function deriveLifecyclePhase(shipment: ShipmentLifecycleData): LifecycleState {
  // ON_DOCK: Has tracking number AND status indicates it's still at/leaving the facility
  // Status 'NY' = label printed, waiting for carrier
  // Status 'AC' = carrier just accepted/picked up
  // Once status is 'IT' (In Transit) or 'DE' (Delivered), it's past the dock
  if (shipment.trackingNumber) {
    const status = shipment.status?.toUpperCase();
    if (!status || ON_DOCK_STATUSES.includes(status)) {
      return { phase: LIFECYCLE_PHASES.ON_DOCK, subphase: null };
    }
    // Has tracking but IT/DE status = shipped, past our lifecycle
    // Still return ON_DOCK as it's the terminal warehouse phase
    return { phase: LIFECYCLE_PHASES.ON_DOCK, subphase: null };
  }

  // PICKING_ISSUES: Session status is 'inactive' (supervisor attention needed)
  if (shipment.sessionStatus === 'inactive') {
    return { phase: LIFECYCLE_PHASES.PICKING_ISSUES, subphase: null };
  }

  // PACKING_READY: Session closed, no tracking yet, shipment still pending
  // The shipmentStatus='pending' check ensures we don't include cancelled shipments
  if (shipment.sessionStatus === 'closed' && shipment.shipmentStatus === 'pending') {
    return { phase: LIFECYCLE_PHASES.PACKING_READY, subphase: null };
  }

  // Also handle closed sessions without explicit pending status (backwards compatibility)
  if (shipment.sessionStatus === 'closed') {
    return { phase: LIFECYCLE_PHASES.PACKING_READY, subphase: null };
  }

  // PICKING: Session is active
  if (shipment.sessionStatus === 'active') {
    return { phase: LIFECYCLE_PHASES.PICKING, subphase: null };
  }

  // READY_TO_PICK: Session created, waiting to start
  if (shipment.sessionStatus === 'new') {
    return { phase: LIFECYCLE_PHASES.READY_TO_PICK, subphase: null };
  }

  // READY_TO_SESSION: On hold + MOVE OVER tag + no SkuVault session yet + not cancelled
  // This is where fingerprinting and QC item explosion should happen
  // Also derive subphase so session builder can find orders that are ready (needs_session)
  if (shipment.shipmentStatus === 'on_hold' && 
      shipment.hasMoveOverTag === true && 
      !shipment.sessionStatus &&
      shipment.status !== 'cancelled') {
    const subphase = deriveDecisionSubphase(shipment);
    return { phase: LIFECYCLE_PHASES.READY_TO_SESSION, subphase };
  }

  // AWAITING_DECISIONS: Has fingerprint, determine which subphase
  const subphase = deriveDecisionSubphase(shipment);
  return { phase: LIFECYCLE_PHASES.AWAITING_DECISIONS, subphase };
}

/**
 * Determine the decision subphase based on shipment data
 */
export function deriveDecisionSubphase(shipment: {
  fingerprintStatus?: string | null;
  fingerprintId?: string | null;
  packagingTypeId?: string | null;
  fulfillmentSessionId?: string | null;
  sessionStatus?: string | null;
}): DecisionSubphase {
  // READY_FOR_SKUVAULT: In fulfillment session, ready to push
  if (shipment.fulfillmentSessionId && !shipment.sessionStatus) {
    return DECISION_SUBPHASES.READY_FOR_SKUVAULT;
  }

  // NEEDS_SESSION: Has packaging but not in session yet
  if (shipment.packagingTypeId && !shipment.fulfillmentSessionId) {
    return DECISION_SUBPHASES.NEEDS_SESSION;
  }

  // NEEDS_PACKAGING: Has fingerprint but no packaging assigned
  if (shipment.fingerprintId && !shipment.packagingTypeId) {
    return DECISION_SUBPHASES.NEEDS_PACKAGING;
  }

  // NEEDS_FINGERPRINT: All SKUs categorized but no fingerprint yet
  if (shipment.fingerprintStatus === 'complete' && !shipment.fingerprintId) {
    return DECISION_SUBPHASES.NEEDS_FINGERPRINT;
  }

  // NEEDS_CATEGORIZATION: SKUs need collection assignment
  return DECISION_SUBPHASES.NEEDS_CATEGORIZATION;
}

/**
 * Get human-readable display name for a lifecycle phase
 */
export function getPhaseDisplayName(phase: LifecyclePhase): string {
  const displayNames: Record<LifecyclePhase, string> = {
    [LIFECYCLE_PHASES.READY_TO_SESSION]: 'Ready to Session',
    [LIFECYCLE_PHASES.AWAITING_DECISIONS]: 'Awaiting Decisions',
    [LIFECYCLE_PHASES.READY_TO_PICK]: 'Ready to Pick',
    [LIFECYCLE_PHASES.PICKING]: 'Picking',
    [LIFECYCLE_PHASES.PACKING_READY]: 'Packing Ready',
    [LIFECYCLE_PHASES.ON_DOCK]: 'On the Dock',
    [LIFECYCLE_PHASES.PICKING_ISSUES]: 'Picking Issues',
  };
  return displayNames[phase] || phase;
}

/**
 * Get human-readable display name for a decision subphase
 */
export function getSubphaseDisplayName(subphase: DecisionSubphase): string {
  const displayNames: Record<DecisionSubphase, string> = {
    [DECISION_SUBPHASES.NEEDS_CATEGORIZATION]: 'Needs Categorization',
    [DECISION_SUBPHASES.NEEDS_FINGERPRINT]: 'Needs Fingerprint',
    [DECISION_SUBPHASES.NEEDS_PACKAGING]: 'Needs Packaging',
    [DECISION_SUBPHASES.NEEDS_SESSION]: 'Needs Session',
    [DECISION_SUBPHASES.READY_FOR_SKUVAULT]: 'Ready for SkuVault',
  };
  return displayNames[subphase] || subphase;
}

/**
 * Check if a shipment is in a phase where it can be modified
 * (i.e., not yet in active picking or beyond)
 */
export function isModifiable(phase: LifecyclePhase): boolean {
  return phase === LIFECYCLE_PHASES.READY_TO_SESSION || 
         phase === LIFECYCLE_PHASES.AWAITING_DECISIONS;
}

/**
 * Get the next expected phase in the happy path
 */
export function getNextPhase(phase: LifecyclePhase): LifecyclePhase | null {
  const happyPath: LifecyclePhase[] = [
    LIFECYCLE_PHASES.READY_TO_SESSION,
    LIFECYCLE_PHASES.AWAITING_DECISIONS,
    LIFECYCLE_PHASES.READY_TO_PICK,
    LIFECYCLE_PHASES.PICKING,
    LIFECYCLE_PHASES.PACKING_READY,
    LIFECYCLE_PHASES.ON_DOCK,
  ];
  
  const currentIndex = happyPath.indexOf(phase);
  if (currentIndex === -1 || currentIndex === happyPath.length - 1) {
    return null;
  }
  return happyPath[currentIndex + 1];
}

/**
 * Get the next expected subphase in the happy path
 */
export function getNextSubphase(subphase: DecisionSubphase): DecisionSubphase | null {
  const happyPath: DecisionSubphase[] = [
    DECISION_SUBPHASES.NEEDS_CATEGORIZATION,
    DECISION_SUBPHASES.NEEDS_FINGERPRINT,
    DECISION_SUBPHASES.NEEDS_PACKAGING,
    DECISION_SUBPHASES.NEEDS_SESSION,
    DECISION_SUBPHASES.READY_FOR_SKUVAULT,
  ];
  
  const currentIndex = happyPath.indexOf(subphase);
  if (currentIndex === -1 || currentIndex === happyPath.length - 1) {
    return null;
  }
  return happyPath[currentIndex + 1];
}

/**
 * Calculate progress percentage through the lifecycle
 */
export function getLifecycleProgress(state: LifecycleState): number {
  const { phase, subphase } = state;
  
  // Main phases (6 total, excluding picking_issues)
  const phaseWeights: Record<LifecyclePhase, number> = {
    [LIFECYCLE_PHASES.READY_TO_SESSION]: 0,
    [LIFECYCLE_PHASES.AWAITING_DECISIONS]: 15,
    [LIFECYCLE_PHASES.READY_TO_PICK]: 30,
    [LIFECYCLE_PHASES.PICKING]: 50,
    [LIFECYCLE_PHASES.PACKING_READY]: 75,
    [LIFECYCLE_PHASES.ON_DOCK]: 100,
    [LIFECYCLE_PHASES.PICKING_ISSUES]: 50, // Same as picking (it's a branch)
  };
  
  let baseProgress = phaseWeights[phase];
  
  // Within AWAITING_DECISIONS, add subphase progress (0-25%)
  if (phase === LIFECYCLE_PHASES.AWAITING_DECISIONS && subphase) {
    const subphaseWeights: Record<DecisionSubphase, number> = {
      [DECISION_SUBPHASES.NEEDS_CATEGORIZATION]: 0,
      [DECISION_SUBPHASES.NEEDS_FINGERPRINT]: 5,
      [DECISION_SUBPHASES.NEEDS_PACKAGING]: 10,
      [DECISION_SUBPHASES.NEEDS_SESSION]: 15,
      [DECISION_SUBPHASES.READY_FOR_SKUVAULT]: 20,
    };
    baseProgress += subphaseWeights[subphase];
  }
  
  return baseProgress;
}

// ============================================================================
// LIFECYCLE UPDATE RESULT
// ============================================================================

export interface LifecycleUpdateResult {
  shipmentId: string;
  orderNumber: string;
  changed: boolean;
  previousPhase: LifecyclePhase | null;
  previousSubphase: DecisionSubphase | null;
  newPhase: LifecyclePhase;
  newSubphase: DecisionSubphase | null;
  timestamp: Date;
}

/**
 * Compare two lifecycle states for equality
 */
export function statesAreEqual(
  a: { phase: LifecyclePhase | null; subphase: DecisionSubphase | null },
  b: { phase: LifecyclePhase; subphase: DecisionSubphase | null }
): boolean {
  return a.phase === b.phase && a.subphase === b.subphase;
}

/**
 * Format a lifecycle transition for logging
 */
export function formatTransition(result: LifecycleUpdateResult): string {
  if (!result.changed) {
    return `[Lifecycle] ${result.orderNumber}: No change (${result.newPhase}${result.newSubphase ? '/' + result.newSubphase : ''})`;
  }
  
  const prevPhase = result.previousPhase || 'null';
  const prevSubphase = result.previousSubphase ? '/' + result.previousSubphase : '';
  const newSubphase = result.newSubphase ? '/' + result.newSubphase : '';
  
  return `[Lifecycle] ${result.orderNumber}: ${prevPhase}${prevSubphase} → ${result.newPhase}${newSubphase}`;
}
