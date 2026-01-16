import { firestoreStorage } from './firestore-storage';
import { db } from './db';
import { shipments, shipmentItems, shipmentQcItems } from '@shared/schema';
import { eq, and, isNull, inArray, isNotNull, exists, sql, notExists } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import type { SkuVaultOrderSession, SkuVaultOrderSessionItem } from '@shared/firestore-schema';
import { onSessionClosed, isPackingReady, isPackingReadyWithReason, buildShipmentContext, type ShipmentContext } from './services/qcsale-cache-warmer';
import { updateShipmentLifecycle } from './services/lifecycle-service';
import { hydrateShipment, calculateFingerprint } from './services/qc-item-hydrator';
import { ensureKitMappingsFresh } from './services/kit-mappings-cache';

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
    // Find shipment by order_number AND shipment_id for precise matching
    // This handles cases where one order may have multiple shipments
    const existingShipments = await db
      .select()
      .from(shipments)
      .where(and(
        eq(shipments.orderNumber, session.order_number),
        eq(shipments.shipmentId, session.shipment_id)
      ))
      .limit(1);

    if (existingShipments.length === 0) {
      // Shipment not found - this is expected for orders not yet in ShipStation
      log(`No shipment found for order ${session.order_number} with shipmentId ${session.shipment_id}, skipping`);
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
    const normalizedSessionStatus = session.session_status?.toLowerCase() || null;
    await db
      .update(shipments)
      .set({
        sessionId: session.session_id.toString(),
        sessionedAt: session.create_date,
        waveId: session.session_picklist_id || null,
        saleId: session.sale_id || null,
        firestoreDocumentId: session.document_id,
        sessionStatus: normalizedSessionStatus,
        spotNumber: session.spot_number?.toString() ?? null,
        pickedByUserId: session.picked_by_user_id?.toString() ?? null,
        pickedByUserName: session.picked_by_user_name,
        pickStartedAt: session.pick_start_datetime,
        pickEndedAt: session.pick_end_datetime,
        savedCustomField2: session.saved_custom_field_2,
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipment.id));

    // Update lifecycle phase based on new session status
    await updateShipmentLifecycle(shipment.id, {
      shipmentData: { sessionStatus: normalizedSessionStatus }
    });

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
    
    // PROACTIVE HYDRATION: If this shipment doesn't have QC items yet, hydrate now
    // This catches shipments that bypassed the normal hydration flow (e.g., racing conditions)
    const existingQcItems = await db
      .select({ id: shipmentQcItems.id })
      .from(shipmentQcItems)
      .where(eq(shipmentQcItems.shipmentId, shipment.id))
      .limit(1);
    
    if (existingQcItems.length === 0) {
      try {
        log(`Proactive hydration: ${shipment.orderNumber} has session but no QC items, hydrating...`);
        await ensureKitMappingsFresh();
        const hydrationResult = await hydrateShipment(shipment.id, shipment.orderNumber || 'unknown');
        if (hydrationResult.error) {
          log(`Proactive hydration error for ${shipment.orderNumber}: ${hydrationResult.error}`);
        } else {
          log(`Proactive hydration complete for ${shipment.orderNumber}: ${hydrationResult.itemsCreated} items created, fingerprint ${hydrationResult.fingerprintStatus}`);
        }
      } catch (hydrationErr: any) {
        log(`Proactive hydration failed for ${shipment.orderNumber}: ${hydrationErr.message}`);
      }
    }

    // CACHE WARMING DISABLED: Bypassing cache entirely - packing pages go direct to SkuVault API
    // When session becomes 'closed', we used to warm the QCSale cache here.
    // Keeping the session sync logic but removing cache warming.
    // if (session.session_status?.toLowerCase() === 'closed') {
    //   const shipmentContext = buildShipmentContext({
    //     ...shipment,
    //     sessionId: shipment.sessionId || session.session_id.toString(),
    //   }, 'closed');
    //   onSessionClosed(session.order_number, shipmentContext).catch(err => {
    //     log(`Cache warming error for order ${session.order_number}: ${err.message}`);
    //   });
    // }

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
      shipmentStatus: shipments.shipmentStatus,
      cacheWarmedAt: shipments.cacheWarmedAt,
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

      // Update lifecycle phase based on new session status
      await updateShipmentLifecycle(shipment.id, {
        shipmentData: { sessionStatus: 'closed' }
      });

      // CACHE WARMING DISABLED: Bypassing cache entirely - packing pages go direct to SkuVault API
      // if (orderNumber) {
      //   const shipmentContext = buildShipmentContext(shipment, 'closed');
      //   onSessionClosed(orderNumber, shipmentContext).catch(err => {
      //     log(`Cache warming error for order ${orderNumber}: ${err.message}`);
      //   });
      // }

      closedCount++;
    }
  }

  if (closedCount > 0) {
    log(`Detected ${closedCount} session(s) that transitioned to closed`);
  }

  return closedCount;
}

/**
 * Ensure closed sessions that are packing-ready have been warmed
 * This catches the gap where a session was already closed in DB but 
 * the warming failed or was skipped (e.g., worker restart)
 * 
 * CRITICAL FIX: Also validates that shipments with cacheWarmedAt actually have
 * entries in Redis. If Redis evicted/expired the cache but cacheWarmedAt is set,
 * we clear the stale timestamp and re-warm.
 */
async function ensureClosedSessionsWarmed(): Promise<number> {
  // Find ALL packing-ready shipments (closed, no tracking, pending status)
  // We'll check Redis to determine which ones actually need warming
  const packingReadyStatuses = ['pending', 'label_pending'];
  const packingReadyShipments = await db
    .select({
      id: shipments.id,
      orderNumber: shipments.orderNumber,
      sessionId: shipments.sessionId,
      trackingNumber: shipments.trackingNumber,
      shipmentStatus: shipments.shipmentStatus,
      cacheWarmedAt: shipments.cacheWarmedAt,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.sessionStatus, 'closed'),
        isNull(shipments.trackingNumber),
        inArray(shipments.shipmentStatus, packingReadyStatuses),
        isNotNull(shipments.sessionId)
      )
    )
    .limit(100); // Check up to 100 per cycle

  if (packingReadyShipments.length === 0) {
    return 0;
  }

  // Import Redis client to verify cache entries actually exist
  const { getRedisClient } = await import('./utils/queue');
  const redis = getRedisClient();
  const WARM_CACHE_KEY_PREFIX = 'skuvault:qcsale:warm:';

  // Separate into: never warmed, and potentially stale (has timestamp but maybe no Redis entry)
  const neverWarmed: typeof packingReadyShipments = [];
  const potentiallyStale: typeof packingReadyShipments = [];

  for (const shipment of packingReadyShipments) {
    if (!shipment.cacheWarmedAt) {
      neverWarmed.push(shipment);
    } else {
      potentiallyStale.push(shipment);
    }
  }

  // Check Redis for potentially stale entries (batch check for efficiency)
  let staleCount = 0;
  const staleShipments: typeof packingReadyShipments = [];
  
  if (potentiallyStale.length > 0) {
    // Batch check Redis keys using pipeline for efficiency
    const shipmentsByKey = new Map<string, typeof packingReadyShipments[0]>();
    const keysToCheck: string[] = [];
    
    for (const shipment of potentiallyStale) {
      if (!shipment.orderNumber) continue;
      const warmKey = `${WARM_CACHE_KEY_PREFIX}${shipment.orderNumber}`;
      keysToCheck.push(warmKey);
      shipmentsByKey.set(warmKey, shipment);
    }
    
    // Batch exists check - Upstash Redis supports exists with multiple keys
    // Check in batches of 20 to avoid overwhelming Redis
    const BATCH_SIZE = 20;
    for (let i = 0; i < keysToCheck.length; i += BATCH_SIZE) {
      const batchKeys = keysToCheck.slice(i, i + BATCH_SIZE);
      // Check each key in parallel within the batch
      const existsResults = await Promise.all(
        batchKeys.map(key => redis.exists(key))
      );
      
      for (let j = 0; j < batchKeys.length; j++) {
        if (existsResults[j] === 0) {
          const shipment = shipmentsByKey.get(batchKeys[j])!;
          staleShipments.push(shipment);
          staleCount++;
        }
      }
    }
    
    // Clear cacheWarmedAt for stale entries BEFORE warming
    // This moves them to "never-warmed" bucket so failed warms don't cause endless Redis checks
    if (staleShipments.length > 0) {
      const staleIds = staleShipments.map(s => s.id);
      await db.update(shipments)
        .set({ cacheWarmedAt: null })
        .where(inArray(shipments.id, staleIds));
      log(`Found ${staleCount} stale cache entries (cacheWarmedAt set but Redis missing), cleared timestamps`);
    }
  }

  // Combine never-warmed and stale shipments for warming
  const shipmentsToWarm = [...neverWarmed, ...staleShipments].slice(0, 50); // Limit to 50 per cycle

  if (shipmentsToWarm.length === 0) {
    return 0;
  }

  log(`Found ${shipmentsToWarm.length} packing-ready shipments needing cache (${neverWarmed.length} new, ${staleShipments.length} stale), warming...`);
  
  let warmedCount = 0;
  for (const shipment of shipmentsToWarm) {
    if (!shipment.orderNumber) continue;
    
    // Use buildShipmentContext to ensure all required fields are included
    // Override sessionStatus to 'closed' since the query already filters for sessionStatus='closed'
    const shipmentContext = buildShipmentContext(shipment, 'closed');
    
    try {
      await onSessionClosed(shipment.orderNumber, shipmentContext);
      warmedCount++;
    } catch (err: any) {
      log(`Failed to warm cache for ${shipment.orderNumber}: ${err.message}`);
    }
  }
  
  log(`Warmed cache for ${warmedCount}/${shipmentsToWarm.length} packing-ready shipments`);
  return warmedCount;
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

    // CACHE WARMING DISABLED: Bypassing cache entirely - packing pages go direct to SkuVault API
    // The safety net that warmed packing-ready shipments is no longer needed.
    // const ensuredCount = await ensureClosedSessionsWarmed();
    const ensuredCount = 0;

    // Update stats
    workerStats.totalSynced += syncedCount;
    workerStats.lastSyncCount = syncedCount;
    workerStats.lastSyncAt = new Date();

    // Enhanced logging for cache state visibility
    const cacheLogPart = ensuredCount > 0 ? `, ${ensuredCount} cache-warmed` : '';
    log(`Synced ${syncedCount} sessions (${closedCount} closed${cacheLogPart}), skipped ${skippedCount} unchanged`);

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

/**
 * Re-import ALL sessions (including closed) from a given start date.
 * Paginates through sessions 500 at a time to avoid memory issues.
 * This is used to backfill sessions that were missed because their
 * shipment didn't exist when the session closed.
 */
export async function reimportAllSessions(
  startDate: Date
): Promise<{ success: boolean; message: string; totalSynced: number; pagesProcessed: number }> {
  const BATCH_SIZE = 500;
  let totalSynced = 0;
  let pagesProcessed = 0;
  let currentStartDate = startDate;
  let hasMore = true;

  try {
    log(`Starting reimport of ALL sessions from ${startDate.toISOString()}`);
    workerStatus = 'running';

    while (hasMore) {
      pagesProcessed++;
      log(`Fetching page ${pagesProcessed} of sessions since ${currentStartDate.toISOString()}...`);

      const sessions = await firestoreStorage.getSessionsUpdatedSince(currentStartDate, BATCH_SIZE);
      
      if (sessions.length === 0) {
        log(`No more sessions found, reimport complete`);
        hasMore = false;
        workerStatus = 'sleeping';
        break;
      }

      log(`Processing ${sessions.length} sessions from page ${pagesProcessed}...`);

      let pageSynced = 0;
      for (const session of sessions) {
        const synced = await syncSessionToShipment(session);
        if (synced) {
          pageSynced++;
          totalSynced++;
        }
      }

      log(`Page ${pagesProcessed}: synced ${pageSynced} of ${sessions.length} sessions`);

      // Update running stats so UI can see progress
      workerStats.totalSynced += pageSynced;
      workerStats.lastSyncCount = pageSynced;
      workerStats.lastSyncAt = new Date();

      // If we got fewer than BATCH_SIZE, we've reached the end
      if (sessions.length < BATCH_SIZE) {
        log(`Last page had ${sessions.length} sessions (less than ${BATCH_SIZE}), reimport complete`);
        hasMore = false;
      } else {
        // Move cursor to the last session's updated_date for next page
        const lastSession = sessions[sessions.length - 1];
        // Ensure updated_date is a valid Date object before calling getTime()
        const lastUpdatedDate = lastSession.updated_date instanceof Date 
          ? lastSession.updated_date 
          : new Date(lastSession.updated_date);
        
        if (lastUpdatedDate && !isNaN(lastUpdatedDate.getTime())) {
          // Add 1ms to avoid re-fetching the same session
          currentStartDate = new Date(lastUpdatedDate.getTime() + 1);
        } else {
          // Fallback: if no valid updated_date, stop to avoid infinite loop
          log(`Warning: Last session has no valid updated_date, stopping pagination`);
          hasMore = false;
        }
      }
    }

    workerStatus = 'sleeping';
    const message = `Reimport complete: ${totalSynced} sessions synced across ${pagesProcessed} pages`;
    log(message);

    return {
      success: true,
      message,
      totalSynced,
      pagesProcessed,
    };
  } catch (error: any) {
    const errorMsg = `Reimport error on page ${pagesProcessed}: ${error.message}`;
    log(errorMsg);
    workerStats.errorsCount++;
    workerStats.lastError = error.message;
    workerStatus = 'error';

    return {
      success: false,
      message: errorMsg,
      totalSynced,
      pagesProcessed,
    };
  }
}
