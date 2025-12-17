/**
 * Shipment Lifecycle State Machine
 * 
 * Manages the progression of shipments through their lifecycle phases:
 * awaiting_decisions → ready_to_pick → picking → packing_ready → on_dock
 *                                            ↘ picking_issues (exception path)
 * 
 * Within AWAITING_DECISIONS, manages decision subphases:
 * needs_categorization → needs_footprint → needs_packaging → needs_session → ready_for_skuvault
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
 * Determine the lifecycle phase based on shipment data
 * 
 * This derives the phase from existing shipment fields for backwards compatibility
 * with shipments that don't yet have explicit lifecyclePhase set.
 */
export function deriveLifecyclePhase(shipment: {
  sessionStatus?: string | null;
  trackingNumber?: string | null;
  status?: string | null;
  footprintStatus?: string | null;
  packagingTypeId?: string | null;
  fulfillmentSessionId?: string | null;
  footprintId?: string | null;
}): LifecycleState {
  // ON_DOCK: Has tracking number (labeled, waiting for carrier)
  if (shipment.trackingNumber) {
    return { phase: LIFECYCLE_PHASES.ON_DOCK, subphase: null };
  }

  // PICKING_ISSUES: Session status is 'inactive' (supervisor attention needed)
  if (shipment.sessionStatus === 'inactive') {
    return { phase: LIFECYCLE_PHASES.PICKING_ISSUES, subphase: null };
  }

  // PACKING_READY: Session closed, no tracking yet
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

  // AWAITING_DECISIONS: Determine which subphase
  const subphase = deriveDecisionSubphase(shipment);
  return { phase: LIFECYCLE_PHASES.AWAITING_DECISIONS, subphase };
}

/**
 * Determine the decision subphase based on shipment data
 */
export function deriveDecisionSubphase(shipment: {
  footprintStatus?: string | null;
  footprintId?: string | null;
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

  // NEEDS_PACKAGING: Has footprint but no packaging assigned
  if (shipment.footprintId && !shipment.packagingTypeId) {
    return DECISION_SUBPHASES.NEEDS_PACKAGING;
  }

  // NEEDS_FOOTPRINT: All SKUs categorized but no footprint yet
  if (shipment.footprintStatus === 'complete' && !shipment.footprintId) {
    return DECISION_SUBPHASES.NEEDS_FOOTPRINT;
  }

  // NEEDS_CATEGORIZATION: SKUs need collection assignment
  return DECISION_SUBPHASES.NEEDS_CATEGORIZATION;
}

/**
 * Get human-readable display name for a lifecycle phase
 */
export function getPhaseDisplayName(phase: LifecyclePhase): string {
  const displayNames: Record<LifecyclePhase, string> = {
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
    [DECISION_SUBPHASES.NEEDS_FOOTPRINT]: 'Needs Footprint',
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
  return phase === LIFECYCLE_PHASES.AWAITING_DECISIONS;
}

/**
 * Get the next expected phase in the happy path
 */
export function getNextPhase(phase: LifecyclePhase): LifecyclePhase | null {
  const happyPath: LifecyclePhase[] = [
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
    DECISION_SUBPHASES.NEEDS_FOOTPRINT,
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
  
  // Main phases (5 total, excluding picking_issues)
  const phaseWeights: Record<LifecyclePhase, number> = {
    [LIFECYCLE_PHASES.AWAITING_DECISIONS]: 0,
    [LIFECYCLE_PHASES.READY_TO_PICK]: 25,
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
      [DECISION_SUBPHASES.NEEDS_FOOTPRINT]: 5,
      [DECISION_SUBPHASES.NEEDS_PACKAGING]: 10,
      [DECISION_SUBPHASES.NEEDS_SESSION]: 15,
      [DECISION_SUBPHASES.READY_FOR_SKUVAULT]: 20,
    };
    baseProgress += subphaseWeights[subphase];
  }
  
  return baseProgress;
}
