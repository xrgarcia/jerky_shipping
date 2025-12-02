import { firestoreStorage } from './firestore-storage';
import { db } from './db';
import { shipments, shipmentItems } from '@shared/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import type { SkuVaultOrderSession, SkuVaultOrderSessionItem } from '@shared/firestore-schema';
import { onSessionClosed } from './services/qcsale-cache-warmer';

const log = (message: string) => console.log(`[firestore-session-sync] ${message}`);

// Worker state
let workerStatus: 'sleeping' | 'running' | 'error' = 'sleeping';
let lastSyncTimestamp: Date | null = null;
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
    lastSyncTimestamp: lastSyncTimestamp?.toISOString() || null,
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
    if (session.session_status === 'closed') {
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
 * Main sync function - polls Firestore and syncs to shipments table
 */
export async function syncFirestoreSessions(): Promise<number> {
  try {
    workerStatus = 'running';

    // Determine sync window - default to 5 minutes ago if no previous sync
    const sinceDatetime = lastSyncTimestamp || new Date(Date.now() - 5 * 60 * 1000);
    
    log(`Fetching sessions updated since ${sinceDatetime.toISOString()}`);

    // Fetch recently updated sessions from Firestore
    const sessions = await firestoreStorage.getSessionsUpdatedSince(sinceDatetime);
    
    if (sessions.length === 0) {
      log('No new sessions to sync');
      workerStats.lastSyncAt = new Date();
      workerStatus = 'sleeping';
      return 0;
    }

    log(`Found ${sessions.length} session(s) to sync`);

    let syncedCount = 0;
    let latestUpdateDate = sinceDatetime;

    // Process each session
    for (const session of sessions) {
      const synced = await syncSessionToShipment(session);
      if (synced) {
        syncedCount++;
      }
      
      // Track the latest update timestamp for next sync
      if (session.updated_date > latestUpdateDate) {
        latestUpdateDate = session.updated_date;
      }
    }

    // Update last sync timestamp to the latest session update time
    lastSyncTimestamp = latestUpdateDate;

    // Update stats
    workerStats.totalSynced += syncedCount;
    workerStats.lastSyncCount = syncedCount;
    workerStats.lastSyncAt = new Date();

    log(`Synced ${syncedCount} of ${sessions.length} sessions`);

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
 * Initial sync - sync all sessions from the past year
 * Called on worker startup to catch up on all historical data
 */
export async function initialSync(): Promise<number> {
  try {
    // Start from 1 year ago to capture all historical sessions
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    log(`Starting initial sync from ${oneYearAgo.toISOString()}...`);
    workerStatus = 'running';

    // Use pagination to handle large result sets
    let totalSynced = 0;
    let latestUpdateDate = oneYearAgo;
    let hasMore = true;
    let pageCount = 0;
    const BATCH_LIMIT = 500;

    while (hasMore) {
      pageCount++;
      log(`Fetching page ${pageCount} of sessions updated since ${latestUpdateDate.toISOString()}`);
      
      const sessions = await firestoreStorage.getSessionsUpdatedSince(latestUpdateDate, BATCH_LIMIT);
      
      if (sessions.length === 0) {
        hasMore = false;
        break;
      }

      log(`Page ${pageCount}: Found ${sessions.length} session(s)`);

      // Track the cursor before processing
      const previousCursor = latestUpdateDate.getTime();

      for (const session of sessions) {
        const synced = await syncSessionToShipment(session);
        if (synced) {
          totalSynced++;
        }
        
        if (session.updated_date > latestUpdateDate) {
          latestUpdateDate = session.updated_date;
        }
      }

      // If we got fewer than the limit, we've reached the end
      if (sessions.length < BATCH_LIMIT) {
        hasMore = false;
      } else if (latestUpdateDate.getTime() === previousCursor) {
        // Safety: if cursor didn't advance (all 500 sessions have same timestamp),
        // add 1ms to prevent infinite loop
        latestUpdateDate = new Date(latestUpdateDate.getTime() + 1);
        log(`Warning: Cursor didn't advance, adding 1ms buffer to prevent stuck pagination`);
      }
      
      // Log progress every page
      log(`Page ${pageCount} complete: ${totalSynced} total sessions synced so far`);
    }

    // Set the last sync timestamp to the latest update
    lastSyncTimestamp = latestUpdateDate;

    workerStats.totalSynced += totalSynced;
    workerStats.lastSyncCount = totalSynced;
    workerStats.lastSyncAt = new Date();

    log(`Initial sync complete: ${totalSynced} sessions synced across ${pageCount} page(s)`);
    workerStatus = 'sleeping';
    return totalSynced;
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
 * Resets the sync cursor and triggers initialSync to re-fetch everything
 * Useful for correcting stale data when Firestore documents weren't re-fetched
 */
export async function forceFullResync(): Promise<{ success: boolean; message: string; syncedCount?: number }> {
  try {
    log('Force re-sync requested - resetting sync cursor');
    
    // Reset the sync timestamp to force re-fetch all sessions
    lastSyncTimestamp = null;
    
    // Run initial sync which will fetch all sessions from past year
    const syncedCount = await initialSync();
    
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
