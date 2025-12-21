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

/** Session with joined station data */
export interface FulfillmentSessionWithStation extends FulfillmentSession {
  stationName: string | null;
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

      // 3. Batch into sessions (max 28 per session)
      const batches = this.createBatches(groups, MAX_ORDERS_PER_SESSION);

      console.log(`[FulfillmentSession] Created ${batches.length} session batches`);

      if (dryRun) {
        // Return preview without creating sessions
        result.sessionsCreated = batches.length;
        result.shipmentsAssigned = sessionableShipments.length;
        return result;
      }

      // 4. Create sessions and link shipments
      for (const batch of batches) {
        const session = await this.createSessionWithShipments(batch, userId);
        if (session) {
          result.sessions.push(session);
          result.sessionsCreated++;
          result.shipmentsAssigned += batch.shipmentIds.length;
        }
      }

      console.log(`[FulfillmentSession] Created ${result.sessionsCreated} sessions with ${result.shipmentsAssigned} shipments`);

    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      console.error('[FulfillmentSession] Error building sessions:', error);
    }

    return result;
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
  async getSessionById(sessionId: string): Promise<FulfillmentSession | null> {
    const [session] = await db
      .select()
      .from(fulfillmentSessions)
      .where(eq(fulfillmentSessions.id, sessionId))
      .limit(1);

    return session || null;
  }

  /**
   * Get all sessions with optional status filter, including station name
   */
  async getSessions(status?: FulfillmentSessionStatus): Promise<FulfillmentSessionWithStation[]> {
    const conditions = status ? [eq(fulfillmentSessions.status, status)] : [];

    const results = await db
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

    return results;
  }

  /**
   * Update session status with proper timestamp tracking
   */
  async updateSessionStatus(
    sessionId: string, 
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

      // Link shipments to session
      await db
        .update(shipments)
        .set({
          fulfillmentSessionId: session.id,
          updatedAt: new Date(),
        })
        .where(inArray(shipments.id, batch.shipmentIds));

      // Update lifecycle phase for linked shipments
      await updateShipmentLifecycleBatch(batch.shipmentIds);

      console.log(`[FulfillmentSession] Created session ${session.id} with ${batch.shipmentIds.length} shipments`);

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
