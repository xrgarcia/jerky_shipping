import { firestoreStorage } from './firestore-storage';
import { db } from './db';
import { shipments, shipmentItems } from '@shared/schema';
import { eq, and, isNull, inArray, isNotNull } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import type { SkuVaultOrderSession, SkuVaultOrderSessionItem } from '@shared/firestore-schema';
import { onSessionClosed } from './services/qcsale-cache-warmer';

const log = (message: string) => console.log(`[firestore-session-sync] ${message}`);

// Worker state
let workerStatus: 'sleeping' | 'running' | 'error' = 'sleeping';
let syncIntervalId: NodeJS.Timeout | null = null;

// Worker statistics
let workerStats = {
  totalSynced: 0,
  lastSyncCount: 0,
  lastSyncAt: null as Date | null,
  workerStartedAt: new Date(),
  errorsCount: 0,
  lastError: null as string | null,
};

export function getFirestoreSessionSyncWorkerStatus() {
  return workerStatus;
}

export function getFirestoreSessionSyncWorkerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Sync SkuVault session items to shipment_items table
 * Matches by SKU and updates the sv_* fields
 */
async function syncSessionItemsToShipmentItems(
  shipmentId: string, 
  orderItems: SkuVaultOrderSessionItem[]
): Promise<number> {
  let updatedCount = 0;

  for (const item of orderItems) {
    if (!item.sku) continue;

    // Find existing shipment_item by shipmentId and SKU
    const existingItems = await db
      .select()
      .from(shipmentItems)
      .where(and(
        eq(shipmentItems.shipmentId, shipmentId),
        eq(shipmentItems.sku, item.sku)
      ))
      .limit(1);

    if (existingItems.length > 0) {
      // Update existing shipment_item with SkuVault data
      await db
        .update(shipmentItems)
        .set({
          svProductId: item.product_id,
          expectedQuantity: item.quantity,
          svPicked: item.picked,
          svCompleted: item.completed,
          svAuditStatus: item.audit_status,
          svWarehouseLocation: item.location,
          svWarehouseLocations: item.locations,
          svStockStatus: item.stock_status,
          svAvailableQuantity: item.available,
          svNotFoundProduct: item.not_found_product,
          svIsSerialized: item.is_serialized,
          svPartNumber: item.part_number,
          svWeightPounds: item.weight_pound?.toString() || null,
          svCode: item.code,
          svProductPictures: item.product_pictures,
          updatedAt: new Date(),
        })
        .where(eq(shipmentItems.id, existingItems[0].id));
      
      updatedCount++;
    }
    // Note: We don't create new shipment_items for SkuVault items that don't match
    // The shipment_items should already exist from ShipStation sync
  }

  return updatedCount;
}

/**
 * Sync a single session to the shipments table
 * Matches on order_number and updates session-related fields (normalized columns)
 */
async function syncSessionToShipment(session: SkuVaultOrderSession): Promise<boolean> {
  try {
    // Find shipment by order_number
    const existingShipments = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderNumber, session.order_number))
      .limit(1);

    if (existingShipments.length === 0) {
      // Shipment not found - this is expected for orders not yet in ShipStation
      log(`No shipment found for order ${session.order_number}, skipping`);
      return false;
    }

    const shipment = existingShipments[0];

    // Check if already synced with same session data (use firestoreDocumentId for change detection)
    if (shipment.sessionId === session.session_id.toString() && 
        shipment.firestoreDocumentId === session.document_id) {
      // Check if the updated timestamp AND session status match - skip only if both unchanged
      // CRITICAL: Always update when session_status differs to prevent stale lifecycle data
      const existingPickEnd = shipment.pickEndedAt?.toISOString();
      const newPickEnd = session.pick_end_datetime?.toISOString();
      const statusUnchanged = shipment.sessionStatus === session.session_status;
      if (existingPickEnd === newPickEnd && statusUnchanged) {
        return false; // No changes
      }
    }

    // Update shipment with normalized session data (no more jsonb)
    await db
      .update(shipments)
      .set({
        sessionId: session.session_id.toString(),
        sessionedAt: session.create_date,
        waveId: session.session_picklist_id || null,
        saleId: session.sale_id || null,
        firestoreDocumentId: session.document_id,
        sessionStatus: session.session_status,
        spotNumber: session.spot_number,
        pickedByUserId: session.picked_by_user_id,
        pickedByUserName: session.picked_by_user_name,
        pickStartedAt: session.pick_start_datetime,
        pickEndedAt: session.pick_end_datetime,
        savedCustomField2: session.saved_custom_field_2,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipment.id));

    // Sync session items to shipment_items table
    if (session.order_items && session.order_items.length > 0) {
      const itemsUpdated = await syncSessionItemsToShipmentItems(shipment.id, session.order_items);
      if (itemsUpdated > 0) {
        log(`Synced session ${session.session_id} to shipment ${shipment.orderNumber} (${itemsUpdated} items updated)`);
      } else {
        log(`Synced session ${session.session_id} to shipment ${shipment.orderNumber}`);
      }
    } else {
      log(`Synced session ${session.session_id} to shipment ${shipment.orderNumber}`);
    }

    // CACHE WARMING: When session becomes 'closed', proactively warm the QCSale cache
    // This dramatically reduces SkuVault API calls during active packing operations
    // See replit.md "Warehouse Session Lifecycle" for critical system knowledge
    // Normalize to lowercase - Firestore stores "Closed" with capital C
    if (session.session_status?.toLowerCase() === 'closed') {
      const hasTrackingNumber = !!shipment.trackingNumber;
      log(`Session ${session.session_id} is closed, triggering cache ${hasTrackingNumber ? 'invalidation' : 'warming'} for order ${session.order_number}`);
      // Fire and forget - don't block session sync on cache warming
      onSessionClosed(session.order_number, hasTrackingNumber).catch(err => {
        log(`Cache warming error for order ${session.order_number}: ${err.message}`);
      });
    }

    return true;
  } catch (error: any) {
    log(`Error syncing session ${session.session_id}: ${error.message}`);
    return false;
  }
}

/**
 * Detect sessions that have transitioned from non-closed to closed
 * This is critical because when a session becomes 'closed', it disappears from
 * our getNonClosedSessions() query. We need to:
 * 1. Find DB shipments that still show non-closed sessionStatus
 * 2. Check if their sessionId is in the Firestore non-closed set
 * 3. If NOT in the set, look up the session in Firestore to confirm it's closed
 * 4. Update DB and trigger cache warming for closed sessions
 */
async function detectClosedSessionTransitions(
  nonClosedSessionIds: Set<string>
): Promise<number> {
  // Find shipments in DB that still show non-closed sessionStatus
  const nonClosedStatuses = ['new', 'active', 'inactive'];
  const dbNonClosedShipments = await db
    .select({
      id: shipments.id,
      orderNumber: shipments.orderNumber,
      sessionId: shipments.sessionId,
      sessionStatus: shipments.sessionStatus,
      trackingNumber: shipments.trackingNumber,
    })
    .from(shipments)
    .where(
      and(
        inArray(shipments.sessionStatus, nonClosedStatuses),
        isNotNull(shipments.sessionId)
      )
    );

  let closedCount = 0;

  for (const shipment of dbNonClosedShipments) {
    if (!shipment.sessionId) continue;

    // Check if this session is still in the Firestore non-closed set
    if (nonClosedSessionIds.has(shipment.sessionId)) {
      continue; // Still non-closed, nothing to do
    }

    // Session is NOT in non-closed set - it must have transitioned to closed
    // Look it up in Firestore to confirm and get full data
    const firestoreSessions = await firestoreStorage.getSkuVaultOrderSessionByPicklistId(
      shipment.sessionId
    );

    if (firestoreSessions.length === 0) {
      // Session not found in Firestore - weird, skip
      log(`Session ${shipment.sessionId} for order ${shipment.orderNumber} not found in Firestore`);
      continue;
    }

    const session = firestoreSessions[0];
    // Normalize to lowercase - Firestore stores "Closed" with capital C
    if (session.session_status?.toLowerCase() === 'closed') {
      // Use session.order_number from Firestore as authoritative source
      // (shipment.orderNumber may be null for historical records)
      const orderNumber = session.order_number || shipment.orderNumber;
      
      // Confirmed closed! Update DB
      log(`Detected session ${session.session_id} transitioned to closed for order ${orderNumber}`);
      
      await db
        .update(shipments)
        .set({
          sessionStatus: 'closed',
          pickEndedAt: session.pick_end_datetime,
          updatedAt: new Date(),
        })
        .where(eq(shipments.id, shipment.id));

      // Trigger cache warming (only if we have a valid order number)
      if (orderNumber) {
        const hasTrackingNumber = !!shipment.trackingNumber;
        log(`Triggering cache ${hasTrackingNumber ? 'invalidation' : 'warming'} for closed session ${session.session_id}`);
        onSessionClosed(orderNumber, hasTrackingNumber).catch(err => {
          log(`Cache warming error for order ${orderNumber}: ${err.message}`);
        });
      } else {
        log(`Skipping cache warming for session ${session.session_id} - no order number available`);
      }

      closedCount++;
    }
  }

  if (closedCount > 0) {
    log(`Detected ${closedCount} session(s) that transitioned to closed`);
  }

  return closedCount;
}

/**
 * Main sync function - queries Firestore for ALL non-closed sessions
 * and compares with our database. Updates only if fields have changed.
 * Also detects sessions that have transitioned to 'closed'.
 * 
 * This is simpler and more reliable than cursor-based sync because:
 * - Firestore is the source of truth for session status
 * - We always catch status changes even if updated_date doesn't change
 * - No cursor management or timestamp tracking needed
 */
export async function syncFirestoreSessions(): Promise<number> {
  try {
    workerStatus = 'running';

    // Query Firestore for ALL non-closed sessions (new, active, inactive)
    log('Fetching all non-closed sessions from Firestore...');
    const sessions = await firestoreStorage.getNonClosedSessions();

    // Build a set of session IDs from Firestore for closed transition detection
    const nonClosedSessionIds = new Set<string>(
      sessions.map(s => s.session_id.toString())
    );

    log(`Found ${sessions.length} non-closed session(s) to check`);

    let syncedCount = 0;
    let skippedCount = 0;

    // Process each session - compare with DB and update if changed
    for (const session of sessions) {
      const synced = await syncSessionToShipment(session);
      if (synced) {
        syncedCount++;
      } else {
        skippedCount++;
      }
    }

    // CRITICAL: Also detect sessions that transitioned to 'closed'
    // These disappear from our non-closed query, so we need to find them
    const closedCount = await detectClosedSessionTransitions(nonClosedSessionIds);
    syncedCount += closedCount;

    // Update stats
    workerStats.totalSynced += syncedCount;
    workerStats.lastSyncCount = syncedCount;
    workerStats.lastSyncAt = new Date();

    log(`Synced ${syncedCount} sessions (${closedCount} closed), skipped ${skippedCount} unchanged`);

    workerStatus = 'sleeping';
    return syncedCount;
  } catch (error: any) {
    log(`Sync error: ${error.message}`);
    workerStats.errorsCount++;
    workerStats.lastError = error.message;
    workerStatus = 'error';
    throw error;
  }
}

/**
 * Initial sync - sync all non-closed sessions on startup
 * Uses the same logic as regular sync - no cursor needed
 */
export async function initialSync(): Promise<number> {
  try {
    log('Starting initial sync of non-closed sessions...');
    workerStatus = 'running';

    // Just use the regular sync - it fetches all non-closed sessions
    const syncedCount = await syncFirestoreSessions();

    log(`Initial sync complete: ${syncedCount} sessions synced`);
    return syncedCount;
  } catch (error: any) {
    log(`Initial sync error: ${error.message}`);
    workerStats.errorsCount++;
    workerStats.lastError = error.message;
    workerStatus = 'error';
    throw error;
  }
}

/**
 * Start the Firestore session sync worker
 * Polls every minute for new/updated sessions
 */
export async function startFirestoreSessionSyncWorker(): Promise<void> {
  log('Starting Firestore session sync worker...');
  
  // Check if Firebase is configured
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    log('FIREBASE_SERVICE_ACCOUNT not configured, worker disabled');
    return;
  }

  // Run initial sync in background (fire-and-forget) to not block server startup
  // This can take several minutes for large historical syncs
  initialSync().catch((error: any) => {
    log(`Initial sync failed (will retry on next poll): ${error.message}`);
  });

  // Start polling every minute
  const POLL_INTERVAL = 60 * 1000; // 1 minute
  
  syncIntervalId = setInterval(async () => {
    try {
      await syncFirestoreSessions();
    } catch (error: any) {
      log(`Poll error (will retry next interval): ${error.message}`);
    }
  }, POLL_INTERVAL);

  log(`Worker started, polling every ${POLL_INTERVAL / 1000} seconds`);
}

/**
 * Stop the worker (for graceful shutdown)
 */
export function stopFirestoreSessionSyncWorker(): void {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    log('Worker stopped');
  }
}

/**
 * Force a full re-sync of all sessions from Firestore
 * Simply re-runs the sync which queries all non-closed sessions
 */
export async function forceFullResync(): Promise<{ success: boolean; message: string; syncedCount?: number }> {
  try {
    log('Force re-sync requested');
    
    // Run sync which fetches all non-closed sessions
    const syncedCount = await syncFirestoreSessions();
    
    return {
      success: true,
      message: `Force re-sync complete: ${syncedCount} sessions synced`,
      syncedCount,
    };
  } catch (error: any) {
    log(`Force re-sync error: ${error.message}`);
    return {
      success: false,
      message: `Force re-sync failed: ${error.message}`,
    };
  }
}

/**
 * Get count of sessioned shipments (orders in packing queue)
 */
export async function getSessionedShipmentCount(): Promise<number> {
  const result = await db
    .select()
    .from(shipments)
    .where(
      and(
        isNull(shipments.trackingNumber), // Not yet shipped
        eq(shipments.sessionId, shipments.sessionId) // Has session (not null check)
      )
    );
  
  // Filter to only those with sessionId
  return result.filter(s => s.sessionId !== null).length;
}
