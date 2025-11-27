import { firestoreStorage } from './firestore-storage';
import { db } from './db';
import { shipments } from '@shared/schema';
import { eq, isNull, and } from 'drizzle-orm';
import { broadcastQueueStatus } from './websocket';
import type { SkuVaultOrderSession } from '@shared/firestore-schema';

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
 * Sync a single session to the shipments table
 * Matches on order_number and updates session-related fields
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

    // Check if already synced with same session data
    if (shipment.sessionId === session.session_id.toString()) {
      // Already synced - check if updated_date changed
      const existingData = shipment.skuvaultSessionData as any;
      if (existingData?.updated_date === session.updated_date.toISOString()) {
        return false; // No changes
      }
    }

    // Update shipment with session data
    await db
      .update(shipments)
      .set({
        sessionId: session.session_id.toString(),
        sessionedAt: session.create_date,
        waveId: session.session_picklist_id || null,
        saleId: session.sale_id || null,
        skuvaultSessionData: {
          document_id: session.document_id,
          session_status: session.session_status,
          spot_number: session.spot_number,
          picked_by_user_id: session.picked_by_user_id,
          picked_by_user_name: session.picked_by_user_name,
          pick_start_datetime: session.pick_start_datetime?.toISOString() || null,
          pick_end_datetime: session.pick_end_datetime?.toISOString() || null,
          create_date: session.create_date.toISOString(),
          updated_date: session.updated_date.toISOString(),
          order_items: session.order_items,
        },
        updatedAt: new Date(),
      })
      .where(eq(shipments.id, shipment.id));

    log(`Synced session ${session.session_id} to shipment ${shipment.orderNumber}`);
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
 * Initial sync - sync all sessions from today
 * Called on worker startup to catch up
 */
export async function initialSync(): Promise<number> {
  try {
    log('Starting initial sync of today\'s sessions...');
    workerStatus = 'running';

    const sessions = await firestoreStorage.getTodaysSessions();
    
    if (sessions.length === 0) {
      log('No sessions today');
      workerStatus = 'sleeping';
      return 0;
    }

    log(`Found ${sessions.length} session(s) from today`);

    let syncedCount = 0;
    let latestUpdateDate = new Date(0);

    for (const session of sessions) {
      const synced = await syncSessionToShipment(session);
      if (synced) {
        syncedCount++;
      }
      
      if (session.updated_date > latestUpdateDate) {
        latestUpdateDate = session.updated_date;
      }
    }

    // Set the last sync timestamp to the latest update
    if (latestUpdateDate.getTime() > 0) {
      lastSyncTimestamp = latestUpdateDate;
    } else {
      lastSyncTimestamp = new Date();
    }

    workerStats.totalSynced += syncedCount;
    workerStats.lastSyncCount = syncedCount;
    workerStats.lastSyncAt = new Date();

    log(`Initial sync complete: ${syncedCount} sessions synced`);
    workerStatus = 'sleeping';
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

  try {
    // Run initial sync to catch up on today's sessions
    await initialSync();
  } catch (error: any) {
    log(`Initial sync failed (will retry): ${error.message}`);
  }

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
