/**
 * Fulfillment Session Service
 * 
 * Manages the creation and lifecycle of fulfillment sessions.
 * Sessions group orders by station type and optimize for efficient
 * picking and packing by batching similar orders together.
 * 
 * Design Principles:
 * - Single Responsibility: This service only handles session building/management
 * - Open/Closed: New sorting strategies can be added without modifying core logic
 * - Dependency Injection: Database access is injected for testability
 */

import { db } from "../db";
import { 
  shipments, 
  fulfillmentSessions, 
  stations,
  fingerprints,
  shipmentQcItems,
  DECISION_SUBPHASES,
  type Shipment, 
  type FulfillmentSession,
  type Station,
  type FulfillmentSessionStatus,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, asc, inArray, sql } from "drizzle-orm";
import { updateShipmentLifecycleBatch } from "./lifecycle-service";

// ============================================================================
// Types & Interfaces
// ============================================================================

/** Criteria for finding sessionable shipments */
export interface SessionableShipmentCriteria {
  hasPackaging: boolean;
  hasAssignedStation: boolean;
  noExistingSession: boolean;
  stationType?: string;
}

/** Grouped shipments ready for batching */
export interface ShipmentGroup {
  stationType: string;
  stationId: string | null;
  fingerprintId: string | null;
  shipments: SessionableShipment[];
}

/** Minimal shipment data needed for session building */
export interface SessionableShipment {
  id: string;
  orderNumber: string;
  fingerprintId: string | null;
  assignedStationId: string | null;
  packagingTypeId: string | null;
}

/** Result of session building operation */
export interface SessionBuildResult {
  success: boolean;
  sessionsCreated: number;
  shipmentsAssigned: number;
  sessions: FulfillmentSession[];
  errors: string[];
}

/** Session with joined station data and calculated weight */
export interface FulfillmentSessionWithStation extends FulfillmentSession {
  stationName: string | null;
  totalWeightOz: number | null;
  packedCount: number; // Number of orders that have been packed (have tracking or qcCompleted)
}

/** Preview of what a session will contain */
export interface SessionPreview {
  stationType: string;
  stationName: string | null;
  orderCount: number;
  fingerprintGroups: { fingerprintId: string | null; count: number }[];
}

// ============================================================================
// Constants
// ============================================================================

const MAX_ORDERS_PER_SESSION = 28; // Physical cart capacity

const STATION_TYPE_PRIORITY: Record<string, number> = {
  'boxing_machine': 1,
  'poly_bag': 2,
  'hand_pack': 3,
};

// ============================================================================
// Session Building Service
// ============================================================================

export class FulfillmentSessionService {
  /**
   * Find all shipments that are ready to be assigned to a session
   * 
   * Ready = in 'needs_session' subphase (has packaging, station, and no existing session)
   * 
   * Uses the lifecycle state machine to ensure only orders that have completed
   * all prior decision steps (categorization, fingerprint, packaging) are included.
   */
  async findSessionableShipments(
    stationType?: string
  ): Promise<SessionableShipment[]> {
    const conditions = [
      // Use lifecycle state machine - only orders waiting to be sessioned
      eq(shipments.decisionSubphase, DECISION_SUBPHASES.NEEDS_SESSION),
      // Safety checks (should already be true if in needs_session, but belt-and-suspenders)
      isNotNull(shipments.packagingTypeId),
      isNotNull(shipments.assignedStationId),
      isNull(shipments.fulfillmentSessionId),
    ];

    if (stationType) {
      const stationIds = await this.getStationIdsByType(stationType);
      if (stationIds.length > 0) {
        conditions.push(inArray(shipments.assignedStationId, stationIds));
      }
    }

    const results = await db
      .select({
        id: shipments.id,
        orderNumber: shipments.orderNumber,
        fingerprintId: shipments.fingerprintId,
        assignedStationId: shipments.assignedStationId,
        packagingTypeId: shipments.packagingTypeId,
      })
      .from(shipments)
      .where(and(...conditions))
      .orderBy(
        asc(shipments.assignedStationId),
        asc(shipments.fingerprintId),
        asc(shipments.orderNumber)
      );

    return results;
  }

  /**
   * Group shipments by station type and fingerprint for optimal batching
   * 
   * Sorting strategy:
   * 1. Station type (boxing_machine → poly_bag → hand_pack)
   * 2. Fingerprint (same fingerprint = same products = efficient picking)
   * 3. Order number (for consistent ordering)
   */
  async groupShipmentsForBatching(
    shipmentList: SessionableShipment[]
  ): Promise<ShipmentGroup[]> {
    // Get station info for each assigned station
    const stationIds = Array.from(new Set(shipmentList.map(s => s.assignedStationId).filter(Boolean))) as string[];
    const stationMap = await this.getStationMap(stationIds);

    // Group by stationType → fingerprint
    const groups = new Map<string, ShipmentGroup>();

    for (const shipment of shipmentList) {
      if (!shipment.assignedStationId) continue;

      const station = stationMap.get(shipment.assignedStationId);
      if (!station) continue;

      const groupKey = `${station.stationType}:${shipment.fingerprintId || 'null'}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          stationType: station.stationType || 'unknown',
          stationId: shipment.assignedStationId,
          fingerprintId: shipment.fingerprintId,
          shipments: [],
        });
      }

      groups.get(groupKey)!.shipments.push(shipment);
    }

    // Sort groups by station type priority, then fingerprint
    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
      const priorityA = STATION_TYPE_PRIORITY[a.stationType] ?? 99;
      const priorityB = STATION_TYPE_PRIORITY[b.stationType] ?? 99;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return (a.fingerprintId || '').localeCompare(b.fingerprintId || '');
    });

    return sortedGroups;
  }

  /**
   * Build sessions from grouped shipments
   * 
   * Each session contains up to MAX_ORDERS_PER_SESSION orders
   * Sessions are created per station type, preserving fingerprint grouping
   * 
   * NEW: First fills existing draft sessions before creating new ones
   */
  async buildSessions(
    userId: string,
    options: { stationType?: string; dryRun?: boolean } = {}
  ): Promise<SessionBuildResult> {
    const { stationType, dryRun = false } = options;

    const result: SessionBuildResult = {
      success: true,
      sessionsCreated: 0,
      shipmentsAssigned: 0,
      sessions: [],
      errors: [],
    };

    try {
      // 1. Find sessionable shipments
      const sessionableShipments = await this.findSessionableShipments(stationType);
      
      if (sessionableShipments.length === 0) {
        result.errors.push('No sessionable shipments found');
        return result;
      }

      console.log(`[FulfillmentSession] Found ${sessionableShipments.length} sessionable shipments`);

      // 2. Group by station type and fingerprint
      const groups = await this.groupShipmentsForBatching(sessionableShipments);

      // 3. Find existing draft sessions with available capacity
      const draftSessions = await this.getDraftSessionsWithCapacity();
      console.log(`[FulfillmentSession] Found ${draftSessions.length} existing draft sessions with capacity`);

      // 4. First fill existing draft sessions, then create new batches for remainder
      const { filledSessions, newBatches, shipmentsAddedToDrafts } = 
        await this.distributeToExistingAndNew(groups, draftSessions, MAX_ORDERS_PER_SESSION);

      console.log(`[FulfillmentSession] Adding ${shipmentsAddedToDrafts} shipments to existing drafts, creating ${newBatches.length} new sessions`);

      if (dryRun) {
        // Return preview without creating sessions
        result.sessionsCreated = newBatches.length;
        result.shipmentsAssigned = sessionableShipments.length;
        return result;
      }

      // 5. Add shipments to existing draft sessions
      for (const filled of filledSessions) {
        if (filled.shipmentIds.length > 0) {
          await this.addShipmentsToSession(filled.sessionId, filled.shipmentIds);
          result.shipmentsAssigned += filled.shipmentIds.length;
          // Fetch updated session to return
          const updatedSession = await this.getSessionById(filled.sessionId);
          if (updatedSession) {
            result.sessions.push(updatedSession);
          }
        }
      }

      // 6. Create new sessions for remaining shipments
      for (const batch of newBatches) {
        const session = await this.createSessionWithShipments(batch, userId);
        if (session) {
          result.sessions.push(session);
          result.sessionsCreated++;
          result.shipmentsAssigned += batch.shipmentIds.length;
        }
      }

      console.log(`[FulfillmentSession] Created ${result.sessionsCreated} new sessions, filled ${filledSessions.filter(f => f.shipmentIds.length > 0).length} existing drafts with ${result.shipmentsAssigned} total shipments`);

    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      console.error('[FulfillmentSession] Error building sessions:', error);
    }

    return result;
  }

  /**
   * Get all draft sessions that have capacity for more orders
   */
  private async getDraftSessionsWithCapacity(): Promise<{ id: number; stationType: string | null; orderCount: number; maxOrders: number }[]> {
    const sessions = await db
      .select({
        id: fulfillmentSessions.id,
        stationType: fulfillmentSessions.stationType,
        orderCount: fulfillmentSessions.orderCount,
        maxOrders: fulfillmentSessions.maxOrders,
      })
      .from(fulfillmentSessions)
      .where(
        and(
          eq(fulfillmentSessions.status, 'draft'),
          sql`${fulfillmentSessions.orderCount} < ${fulfillmentSessions.maxOrders}`
        )
      )
      .orderBy(asc(fulfillmentSessions.createdAt));

    return sessions;
  }

  /**
   * Distribute shipments to existing draft sessions first, then create new batches
   */
  private async distributeToExistingAndNew(
    groups: ShipmentGroup[],
    draftSessions: { id: number; stationType: string | null; orderCount: number; maxOrders: number }[],
    maxPerBatch: number
  ): Promise<{
    filledSessions: { sessionId: number; shipmentIds: string[] }[];
    newBatches: SessionBatch[];
    shipmentsAddedToDrafts: number;
  }> {
    const filledSessions: { sessionId: number; shipmentIds: string[] }[] = [];
    const newBatches: SessionBatch[] = [];
    let shipmentsAddedToDrafts = 0;

    // Group draft sessions by station type
    const draftsByStation = new Map<string, { id: number; capacity: number }[]>();
    for (const draft of draftSessions) {
      const stationType = draft.stationType || 'unknown';
      if (!draftsByStation.has(stationType)) {
        draftsByStation.set(stationType, []);
      }
      draftsByStation.get(stationType)!.push({
        id: draft.id,
        capacity: draft.maxOrders - draft.orderCount,
      });
    }

    // Group shipments by station type
    const byStationType = new Map<string, ShipmentGroup[]>();
    for (const group of groups) {
      if (!byStationType.has(group.stationType)) {
        byStationType.set(group.stationType, []);
      }
      byStationType.get(group.stationType)!.push(group);
    }

    // Process each station type
    for (const [stationType, stationGroups] of Array.from(byStationType.entries())) {
      // Flatten all shipments for this station type
      const allShipments = stationGroups.flatMap(g => g.shipments);
      let shipmentIndex = 0;

      // First, fill existing draft sessions for this station type
      const draftsForStation = draftsByStation.get(stationType) || [];
      for (const draft of draftsForStation) {
        if (shipmentIndex >= allShipments.length) break;
        
        const toAdd: string[] = [];
        while (toAdd.length < draft.capacity && shipmentIndex < allShipments.length) {
          toAdd.push(allShipments[shipmentIndex].id);
          shipmentIndex++;
        }

        if (toAdd.length > 0) {
          filledSessions.push({ sessionId: draft.id, shipmentIds: toAdd });
          shipmentsAddedToDrafts += toAdd.length;
        }
      }

      // Remaining shipments go to new batches
      let currentBatch: SessionBatch | null = null;
      while (shipmentIndex < allShipments.length) {
        if (!currentBatch || currentBatch.shipmentIds.length >= maxPerBatch) {
          currentBatch = {
            stationType,
            stationId: stationGroups[0]?.stationId || null,
            shipmentIds: [],
          };
          newBatches.push(currentBatch);
        }
        currentBatch.shipmentIds.push(allShipments[shipmentIndex].id);
        shipmentIndex++;
      }
    }

    return { filledSessions, newBatches, shipmentsAddedToDrafts };
  }

  /**
   * Add shipments to an existing session
   */
  private async addShipmentsToSession(sessionId: number, shipmentIds: string[]): Promise<void> {
    // Get current max spot for this session to continue numbering
    const [maxSpotResult] = await db
      .select({ maxSpot: sql<number>`COALESCE(MAX(${shipments.smartSessionSpot}), 0)` })
      .from(shipments)
      .where(eq(shipments.fulfillmentSessionId, sessionId));
    
    let nextSpot = (maxSpotResult?.maxSpot || 0) + 1;

    // Link shipments to session with sequential spot numbers
    for (const shipmentId of shipmentIds) {
      await db
        .update(shipments)
        .set({
          fulfillmentSessionId: sessionId,
          smartSessionSpot: nextSpot,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, shipmentId));
      nextSpot++;
    }

    // Update order count on session
    await db
      .update(fulfillmentSessions)
      .set({
        orderCount: sql`${fulfillmentSessions.orderCount} + ${shipmentIds.length}`,
        updatedAt: new Date(),
      })
      .where(eq(fulfillmentSessions.id, sessionId));

    // Update lifecycle phase for linked shipments
    await updateShipmentLifecycleBatch(shipmentIds);

    console.log(`[FulfillmentSession] Added ${shipmentIds.length} shipments to existing session ${sessionId} (spots ${(maxSpotResult?.maxSpot || 0) + 1}-${nextSpot - 1})`);
  }

  /**
   * Preview what sessions would be created without actually creating them
   */
  async previewSessions(stationType?: string): Promise<SessionPreview[]> {
    const sessionableShipments = await this.findSessionableShipments(stationType);
    const groups = await this.groupShipmentsForBatching(sessionableShipments);
    
    // Get station names
    const stationIds = Array.from(new Set(groups.map(g => g.stationId).filter(Boolean))) as string[];
    const stationMap = await this.getStationMap(stationIds);

    // Aggregate by station type
    const previewMap = new Map<string, SessionPreview>();

    for (const group of groups) {
      const stationType = group.stationType;
      
      if (!previewMap.has(stationType)) {
        const station = group.stationId ? stationMap.get(group.stationId) : null;
        previewMap.set(stationType, {
          stationType,
          stationName: station?.name || null,
          orderCount: 0,
          fingerprintGroups: [],
        });
      }

      const preview = previewMap.get(stationType)!;
      preview.orderCount += group.shipments.length;
      preview.fingerprintGroups.push({
        fingerprintId: group.fingerprintId,
        count: group.shipments.length,
      });
    }

    return Array.from(previewMap.values());
  }

  /**
   * Get a session by ID with related data
   */
  async getSessionById(sessionId: number): Promise<FulfillmentSession | null> {
    const [session] = await db
      .select()
      .from(fulfillmentSessions)
      .where(eq(fulfillmentSessions.id, sessionId))
      .limit(1);

    return session || null;
  }

  /**
   * Get all sessions with optional status filter, including station name and total weight
   */
  async getSessions(status?: FulfillmentSessionStatus): Promise<FulfillmentSessionWithStation[]> {
    const conditions = status ? [eq(fulfillmentSessions.status, status)] : [];

    const sessions = await db
      .select({
        id: fulfillmentSessions.id,
        name: fulfillmentSessions.name,
        sequenceNumber: fulfillmentSessions.sequenceNumber,
        stationId: fulfillmentSessions.stationId,
        stationType: fulfillmentSessions.stationType,
        orderCount: fulfillmentSessions.orderCount,
        maxOrders: fulfillmentSessions.maxOrders,
        status: fulfillmentSessions.status,
        createdAt: fulfillmentSessions.createdAt,
        updatedAt: fulfillmentSessions.updatedAt,
        readyAt: fulfillmentSessions.readyAt,
        pickingStartedAt: fulfillmentSessions.pickingStartedAt,
        packingStartedAt: fulfillmentSessions.packingStartedAt,
        completedAt: fulfillmentSessions.completedAt,
        createdBy: fulfillmentSessions.createdBy,
        stationName: stations.name,
      })
      .from(fulfillmentSessions)
      .leftJoin(stations, eq(fulfillmentSessions.stationId, stations.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(fulfillmentSessions.createdAt));

    // Calculate total weight for each session from QC items
    const sessionIds = sessions.map(s => s.id);
    if (sessionIds.length === 0) {
      return sessions.map(s => ({ ...s, totalWeightOz: null, packedCount: 0 }));
    }

    // Get total weight and packed count per session
    // Packed = has tracking number OR qcCompleted
    const [weightResults, packedResults] = await Promise.all([
      // Weight per session (sum of weight_value * quantity_expected for all items)
      db
        .select({
          sessionId: shipments.fulfillmentSessionId,
          totalWeight: sql<number>`COALESCE(SUM(${shipmentQcItems.weightValue} * ${shipmentQcItems.quantityExpected}), 0)`.as('total_weight'),
        })
        .from(shipments)
        .innerJoin(shipmentQcItems, eq(shipmentQcItems.shipmentId, shipments.id))
        .where(inArray(shipments.fulfillmentSessionId, sessionIds))
        .groupBy(shipments.fulfillmentSessionId),
      
      // Packed count per session (orders with tracking or qcCompleted)
      db
        .select({
          sessionId: shipments.fulfillmentSessionId,
          packedCount: sql<number>`COUNT(*) FILTER (WHERE ${shipments.trackingNumber} IS NOT NULL OR ${shipments.qcCompleted} = true)`.as('packed_count'),
        })
        .from(shipments)
        .where(inArray(shipments.fulfillmentSessionId, sessionIds))
        .groupBy(shipments.fulfillmentSessionId),
    ]);

    // Create maps of session ID to weight and packed count
    const weightMap = new Map<number, number>();
    for (const row of weightResults) {
      if (row.sessionId) {
        weightMap.set(row.sessionId, Number(row.totalWeight) || 0);
      }
    }
    
    const packedMap = new Map<number, number>();
    for (const row of packedResults) {
      if (row.sessionId) {
        packedMap.set(row.sessionId, Number(row.packedCount) || 0);
      }
    }

    // Merge weight and packed data into sessions
    return sessions.map(session => ({
      ...session,
      totalWeightOz: weightMap.get(session.id) || null,
      packedCount: packedMap.get(session.id) || 0,
    }));
  }

  /**
   * Update session status with proper timestamp tracking
   */
  async updateSessionStatus(
    sessionId: number, 
    newStatus: FulfillmentSessionStatus
  ): Promise<FulfillmentSession | null> {
    const updateData: Partial<FulfillmentSession> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    // Set appropriate timestamp based on status
    switch (newStatus) {
      case 'ready':
        updateData.readyAt = new Date();
        break;
      case 'picking':
        updateData.pickingStartedAt = new Date();
        break;
      case 'packing':
        updateData.packingStartedAt = new Date();
        break;
      case 'completed':
        updateData.completedAt = new Date();
        break;
    }

    const [updated] = await db
      .update(fulfillmentSessions)
      .set(updateData)
      .where(eq(fulfillmentSessions.id, sessionId))
      .returning();

    return updated || null;
  }

  /**
   * Bulk update session status for multiple sessions at once
   */
  async bulkUpdateSessionStatus(
    sessionIds: number[], 
    newStatus: FulfillmentSessionStatus
  ): Promise<{ updated: number; errors: string[] }> {
    if (sessionIds.length === 0) {
      return { updated: 0, errors: [] };
    }

    const updateData: Partial<FulfillmentSession> = {
      status: newStatus,
      updatedAt: new Date(),
    };

    // Set appropriate timestamp based on status
    switch (newStatus) {
      case 'ready':
        updateData.readyAt = new Date();
        break;
      case 'picking':
        updateData.pickingStartedAt = new Date();
        break;
      case 'packing':
        updateData.packingStartedAt = new Date();
        break;
      case 'completed':
        updateData.completedAt = new Date();
        break;
    }

    const results = await db
      .update(fulfillmentSessions)
      .set(updateData)
      .where(inArray(fulfillmentSessions.id, sessionIds))
      .returning({ id: fulfillmentSessions.id });

    return { 
      updated: results.length, 
      errors: [] 
    };
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private async getStationIdsByType(stationType: string): Promise<string[]> {
    const stationList = await db
      .select({ id: stations.id })
      .from(stations)
      .where(and(
        eq(stations.stationType, stationType),
        eq(stations.isActive, true)
      ));

    return stationList.map(s => s.id);
  }

  private async getStationMap(stationIds: string[]): Promise<Map<string, Station>> {
    if (stationIds.length === 0) return new Map();

    const stationList = await db
      .select()
      .from(stations)
      .where(inArray(stations.id, stationIds));

    return new Map(stationList.map(s => [s.id, s]));
  }

  /**
   * Create batches of shipments respecting max session size
   */
  private createBatches(
    groups: ShipmentGroup[], 
    maxPerBatch: number
  ): SessionBatch[] {
    const batches: SessionBatch[] = [];
    
    // Process each station type separately
    const byStationType = new Map<string, ShipmentGroup[]>();
    for (const group of groups) {
      if (!byStationType.has(group.stationType)) {
        byStationType.set(group.stationType, []);
      }
      byStationType.get(group.stationType)!.push(group);
    }

    for (const [stationType, stationGroups] of Array.from(byStationType.entries())) {
      let currentBatch: SessionBatch | null = null;

      for (const group of stationGroups) {
        for (const shipment of group.shipments) {
          if (!currentBatch || currentBatch.shipmentIds.length >= maxPerBatch) {
            // Start new batch
            currentBatch = {
              stationType,
              stationId: group.stationId,
              shipmentIds: [],
            };
            batches.push(currentBatch);
          }

          currentBatch.shipmentIds.push(shipment.id);
        }
      }
    }

    return batches;
  }

  /**
   * Create a session and link shipments to it
   */
  private async createSessionWithShipments(
    batch: SessionBatch,
    userId: string
  ): Promise<FulfillmentSession | null> {
    try {
      // Get next sequence number for today
      const sequenceNumber = await this.getNextSequenceNumber();

      // Create session
      const [session] = await db
        .insert(fulfillmentSessions)
        .values({
          stationType: batch.stationType,
          stationId: batch.stationId,
          orderCount: batch.shipmentIds.length,
          status: 'draft',
          sequenceNumber,
          createdBy: userId,
        })
        .returning();

      if (!session) return null;

      // Link shipments to session with sequential spot numbers
      let spot = 1;
      for (const shipmentId of batch.shipmentIds) {
        await db
          .update(shipments)
          .set({
            fulfillmentSessionId: session.id,
            smartSessionSpot: spot,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, shipmentId));
        spot++;
      }

      // Update lifecycle phase for linked shipments
      await updateShipmentLifecycleBatch(batch.shipmentIds);

      console.log(`[FulfillmentSession] Created session ${session.id} with ${batch.shipmentIds.length} shipments (spots 1-${spot - 1})`);

      return session;
    } catch (error) {
      console.error('[FulfillmentSession] Error creating session:', error);
      return null;
    }
  }

  private async getNextSequenceNumber(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [result] = await db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${fulfillmentSessions.sequenceNumber}), 0)` })
      .from(fulfillmentSessions)
      .where(sql`${fulfillmentSessions.createdAt} >= ${today}`);

    return (result?.maxSeq || 0) + 1;
  }
}

/** Internal type for batch creation */
interface SessionBatch {
  stationType: string;
  stationId: string | null;
  shipmentIds: string[];
}

// Export singleton instance
export const fulfillmentSessionService = new FulfillmentSessionService();
