/**
 * Shipment Lifecycle State Machine
 * 
 * Manages the progression of shipments through their lifecycle phases:
 * ready_to_fulfill → ready_to_session → awaiting_decisions → ready_to_pick → picking → packing_ready → on_dock
 *                                                                        ↘ picking_issues (exception path)
 * 
 * READY_TO_FULFILL: On hold + MOVE OVER tag - waiting to be released from ShipStation hold
 * READY_TO_SESSION: Pending + MOVE OVER tag + no session - fingerprinting & QC explosion happens here
 * ON_DOCK: Order has been packaged and is on the dock awaiting pickup from carrier
 *          Requires: shipmentStatus='label_purchased' AND status IN ('NY', 'AC')
 * IN_TRANSIT: Package is on its way to customer
 *             Requires: status IN ('IT', 'shipped') — tracking status takes precedence
 * DELIVERED: Package has been delivered to customer
 *            Requires: status IN ('DE', 'SP') — tracking status takes precedence
 *            DE = Delivered to final address
 *            SP = Service Point — delivered to a collection location (locker or pickup point)
 * CANCELLED: Order has been cancelled
 *            Requires: status='cancelled' — terminal state
 * PROBLEM: Shipment has a carrier problem — terminal, becomes customer service case
 *          Requires: status IN ('UN', 'EX')
 *          UN = Unknown — carrier has no tracking information available
 *          EX = Exception — an unexpected event (e.g., weather delay, damaged label, or incorrect address) has occurred
 * 
 * Within AWAITING_DECISIONS, manages decision subphases:
 * needs_hydration → needs_categorization → needs_fingerprint → needs_packaging → needs_rate_check → needs_session → ready_for_skuvault
 */

import {
  LIFECYCLE_PHASES,
  DECISION_SUBPHASES,
  LIFECYCLE_TRANSITIONS,
  DECISION_TRANSITIONS,
  type LifecyclePhase,
  type DecisionSubphase,
} from "@shared/schema";
import { RateCheckEligibility } from './rate-check-eligibility';

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
  fulfillmentSessionId?: string | number | null; // Local fulfillment session ID
  fingerprintId?: string | null;
  hasMoveOverTag?: boolean;         // Whether shipment has the "MOVE OVER" tag (for ready_to_session detection)
  rateCheckStatus?: string | null;  // Rate check status: 'pending' | 'complete' | 'failed' | 'skipped' | null
  shipmentId?: string | null;       // ShipStation shipment ID (for rate check eligibility)
  shipToPostalCode?: string | null; // Destination postal code (for rate check eligibility)
  serviceCode?: string | null;      // Shipping service code (for rate check eligibility)
}

// Status codes where tracking status (status field) takes precedence over shipmentStatus
const DELIVERED_STATUSES = ['DE', 'SP'];
const IN_TRANSIT_STATUSES = ['IT', 'SHIPPED'];
const ON_DOCK_STATUSES = ['NY', 'AC', 'NEW'];
const PROBLEM_STATUSES = ['UN', 'EX'];

/**
 * Determine the lifecycle phase based on shipment data
 * 
 * This derives the phase from existing shipment fields for backwards compatibility
 * with shipments that don't yet have explicit lifecyclePhase set.
 * 
 * KEY PRINCIPLE: Tracking status takes precedence over shipmentStatus.
 * If tracking says delivered, that's the truth regardless of shipmentStatus.
 * 
 * Phase priority (checked in order):
 * 1. CANCELLED - status='cancelled' (terminal, regardless of shipmentStatus)
 * 2. DELIVERED - status='DE' (terminal, regardless of shipmentStatus)
 * 3. IN_TRANSIT - status IN ('IT', 'shipped') (regardless of shipmentStatus)
 * 4. PROBLEM - status IN ('SP', 'UN', 'EX') (terminal, regardless of shipmentStatus)
 * 5. ON_DOCK - status IN ('NY', 'AC', 'new') AND shipmentStatus='label_purchased'
 * 6. READY_TO_FULFILL - shipmentStatus='on_hold' AND hasMoveOverTag
 * 7. PICKING_ISSUES - sessionStatus='inactive'
 * 8. PACKING_READY - sessionStatus='closed' AND no tracking AND shipmentStatus='pending'
 * 9. PICKING - sessionStatus='active'
 * 10. READY_TO_PICK - sessionStatus='new'
 * 11. SESSION_CREATED - has fulfillmentSessionId, no sessionStatus, shipmentStatus='pending'
 * 12. READY_TO_SESSION - shipmentStatus='pending' AND hasMoveOverTag AND no session
 * 13. AWAITING_DECISIONS - Default fallback
 */
export function deriveLifecyclePhase(shipment: ShipmentLifecycleData): LifecycleState {
  const status = shipment.status?.toUpperCase();
  
  // ========================================================================
  // STATUS-BASED PHASES (tracking status takes precedence)
  // ========================================================================
  
  // CANCELLED: Order has been cancelled - terminal state
  if (status === 'CANCELLED') {
    return { phase: LIFECYCLE_PHASES.CANCELLED, subphase: null };
  }
  
  // DELIVERED: Package has been delivered
  if (status && DELIVERED_STATUSES.includes(status)) {
    return { phase: LIFECYCLE_PHASES.DELIVERED, subphase: null };
  }
  
  // IN_TRANSIT: Package is on its way to customer (includes legacy 'shipped' status)
  if (status && IN_TRANSIT_STATUSES.includes(status)) {
    return { phase: LIFECYCLE_PHASES.IN_TRANSIT, subphase: null };
  }
  
  // PROBLEM: Shipment has a carrier problem - terminal, becomes customer service case
  // UN = Unknown (no tracking info), EX = Exception (weather delay, damaged label, incorrect address)
  if (status && PROBLEM_STATUSES.includes(status)) {
    return { phase: LIFECYCLE_PHASES.PROBLEM, subphase: null };
  }
  
  // ON_DOCK: Label purchased, waiting for carrier pickup (NY/AC/new)
  if (shipment.shipmentStatus === 'label_purchased' && 
      status && 
      ON_DOCK_STATUSES.includes(status)) {
    return { phase: LIFECYCLE_PHASES.ON_DOCK, subphase: null };
  }

  // ========================================================================
  // OPERATIONAL PHASES (based on shipmentStatus and session state)
  // ========================================================================

  // READY_TO_FULFILL: On hold + MOVE OVER tag (regardless of session state)
  // This MUST be checked BEFORE session-based phases to properly reset orders that go back to on_hold
  if (shipment.shipmentStatus === 'on_hold' && 
      shipment.hasMoveOverTag === true) {
    const subphase = deriveDecisionSubphase(shipment);
    return { phase: LIFECYCLE_PHASES.READY_TO_FULFILL, subphase };
  }

  // PICKING_ISSUES: Session status is 'inactive' (supervisor attention needed)
  if (shipment.sessionStatus === 'inactive') {
    return { phase: LIFECYCLE_PHASES.PICKING_ISSUES, subphase: null };
  }

  // PACKING_READY: Session closed, no tracking yet, shipment still pending
  if (shipment.sessionStatus === 'closed' && 
      !shipment.trackingNumber &&
      shipment.shipmentStatus === 'pending') {
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

  // SESSION_CREATED: Has a local fulfillment session but no SkuVault session yet
  if (shipment.fulfillmentSessionId && 
      !shipment.sessionStatus &&
      shipment.shipmentStatus === 'pending') {
    return { phase: LIFECYCLE_PHASES.SESSION_CREATED, subphase: null };
  }

  // READY_TO_SESSION: Pending + MOVE OVER tag + no session
  if (shipment.shipmentStatus === 'pending' && 
      shipment.hasMoveOverTag === true && 
      !shipment.sessionStatus &&
      !shipment.fulfillmentSessionId) {
    const subphase = deriveDecisionSubphase(shipment);
    return { phase: LIFECYCLE_PHASES.READY_TO_SESSION, subphase };
  }

  // AWAITING_DECISIONS: Default fallback - needs categorization/fingerprint/packaging/session
  const subphase = deriveDecisionSubphase(shipment);
  return { phase: LIFECYCLE_PHASES.AWAITING_DECISIONS, subphase };
}

/**
 * Determine the decision subphase based on shipment data
 * 
 * Each subphase maps to a specific, actionable condition — no catch-all defaults.
 * The check order goes from most-advanced to least-advanced so shipments land
 * in the furthest subphase they've reached.
 */
export function deriveDecisionSubphase(shipment: {
  fingerprintStatus?: string | null;
  fingerprintId?: string | null;
  packagingTypeId?: string | null;
  fulfillmentSessionId?: string | number | null;
  sessionStatus?: string | null;
  rateCheckStatus?: string | null;
  shipmentId?: string | null;
  shipToPostalCode?: string | null;
  serviceCode?: string | null;
}): DecisionSubphase {
  // READY_FOR_SKUVAULT: In fulfillment session, ready to push
  if (shipment.fulfillmentSessionId && !shipment.sessionStatus) {
    return DECISION_SUBPHASES.READY_FOR_SKUVAULT;
  }

  // NEEDS_RATE_CHECK: Rate check not yet complete or failed (can retry)
  // Must be evaluated BEFORE NEEDS_SESSION so orders can't skip rate checking
  // Eligible statuses to proceed: 'complete', 'skipped'
  // Statuses that stay in needs_rate_check: null, 'pending', 'failed'
  const rateCheckComplete = shipment.rateCheckStatus === 'complete' || shipment.rateCheckStatus === 'skipped';
  if (!rateCheckComplete) {
    const eligibility = RateCheckEligibility.checkBasicRequirements(shipment);
    if (eligibility.eligible) {
      return DECISION_SUBPHASES.NEEDS_RATE_CHECK;
    }
  }

  // NEEDS_SESSION: Has packaging, rate check done, but not in session yet
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

  // NEEDS_CATEGORIZATION: Hydrated but some SKUs not in a geometry collection
  // Only when fingerprintStatus is explicitly 'pending_categorization' (set by the hydrator)
  if (shipment.fingerprintStatus === 'pending_categorization') {
    return DECISION_SUBPHASES.NEEDS_CATEGORIZATION;
  }

  // NEEDS_HYDRATION: No QC items created yet (fingerprintStatus is NULL or any other unrecognized value)
  // This is an automated step — the hydrator will create shipment_qc_items
  return DECISION_SUBPHASES.NEEDS_HYDRATION;
}

/**
 * Get human-readable display name for a lifecycle phase
 */
export function getPhaseDisplayName(phase: LifecyclePhase): string {
  const displayNames: Record<LifecyclePhase, string> = {
    [LIFECYCLE_PHASES.READY_TO_FULFILL]: 'Ready to Fulfill',
    [LIFECYCLE_PHASES.READY_TO_SESSION]: 'Ready to Session',
    [LIFECYCLE_PHASES.SESSION_CREATED]: 'Session Created',
    [LIFECYCLE_PHASES.AWAITING_DECISIONS]: 'Awaiting Decisions',
    [LIFECYCLE_PHASES.READY_TO_PICK]: 'Ready to Pick',
    [LIFECYCLE_PHASES.PICKING]: 'Picking',
    [LIFECYCLE_PHASES.PACKING_READY]: 'Packing Ready',
    [LIFECYCLE_PHASES.ON_DOCK]: 'On the Dock',
    [LIFECYCLE_PHASES.IN_TRANSIT]: 'In Transit',
    [LIFECYCLE_PHASES.DELIVERED]: 'Delivered',
    [LIFECYCLE_PHASES.CANCELLED]: 'Cancelled',
    [LIFECYCLE_PHASES.PROBLEM]: 'Problem',
    [LIFECYCLE_PHASES.PICKING_ISSUES]: 'Picking Issues',
  };
  return displayNames[phase] || phase;
}

/**
 * Get human-readable display name for a decision subphase
 */
export function getSubphaseDisplayName(subphase: DecisionSubphase): string {
  const displayNames: Record<DecisionSubphase, string> = {
    [DECISION_SUBPHASES.NEEDS_HYDRATION]: 'Needs Hydration',
    [DECISION_SUBPHASES.NEEDS_CATEGORIZATION]: 'Needs Categorization',
    [DECISION_SUBPHASES.NEEDS_FINGERPRINT]: 'Needs Fingerprint',
    [DECISION_SUBPHASES.NEEDS_PACKAGING]: 'Needs Packaging',
    [DECISION_SUBPHASES.NEEDS_RATE_CHECK]: 'Needs Rate Check',
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
    DECISION_SUBPHASES.NEEDS_HYDRATION,
    DECISION_SUBPHASES.NEEDS_CATEGORIZATION,
    DECISION_SUBPHASES.NEEDS_FINGERPRINT,
    DECISION_SUBPHASES.NEEDS_PACKAGING,
    DECISION_SUBPHASES.NEEDS_RATE_CHECK,
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
  
  // Main phases (7 total, excluding picking_issues)
  const phaseWeights: Record<LifecyclePhase, number> = {
    [LIFECYCLE_PHASES.READY_TO_FULFILL]: 0,
    [LIFECYCLE_PHASES.READY_TO_SESSION]: 5,
    [LIFECYCLE_PHASES.SESSION_CREATED]: 10,
    [LIFECYCLE_PHASES.AWAITING_DECISIONS]: 15,
    [LIFECYCLE_PHASES.READY_TO_PICK]: 30,
    [LIFECYCLE_PHASES.PICKING]: 50,
    [LIFECYCLE_PHASES.PACKING_READY]: 75,
    [LIFECYCLE_PHASES.ON_DOCK]: 90,
    [LIFECYCLE_PHASES.IN_TRANSIT]: 95,
    [LIFECYCLE_PHASES.DELIVERED]: 100,
    [LIFECYCLE_PHASES.CANCELLED]: 100, // Terminal state
    [LIFECYCLE_PHASES.PROBLEM]: 100, // Terminal state
    [LIFECYCLE_PHASES.PICKING_ISSUES]: 50, // Same as picking (it's a branch)
  };
  
  let baseProgress = phaseWeights[phase];
  
  // Within AWAITING_DECISIONS, add subphase progress (0-25%)
  if (phase === LIFECYCLE_PHASES.AWAITING_DECISIONS && subphase) {
    const subphaseWeights: Record<DecisionSubphase, number> = {
      [DECISION_SUBPHASES.NEEDS_HYDRATION]: 0,
      [DECISION_SUBPHASES.NEEDS_CATEGORIZATION]: 3,
      [DECISION_SUBPHASES.NEEDS_FINGERPRINT]: 6,
      [DECISION_SUBPHASES.NEEDS_PACKAGING]: 9,
      [DECISION_SUBPHASES.NEEDS_RATE_CHECK]: 12,
      [DECISION_SUBPHASES.NEEDS_SESSION]: 16,
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
