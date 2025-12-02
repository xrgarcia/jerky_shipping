/**
 * Unified Shipment Sync Worker
 * 
 * Architecture Overview:
 * - Single incremental poller using modifyDate cursor (no Redis queue needed)
 * - Cursor stored in PostgreSQL sync_cursors table for crash recovery
 * - Webhooks trigger immediate poll sweep rather than queueing
 * - All shipments synced through single path ensuring consistency
 * 
 * Key Properties:
 * - Crash-safe: Cursor persisted in Postgres, resume from last position on restart
 * - No data loss: No in-flight queue messages to lose
 * - Single source of truth: All data flows through ShipStation API poll
 * - Rate-limit aware: Respects 40 calls/minute limit
 */

import { db } from './db';
import { syncCursors, shipments } from '@shared/schema';
import { eq, sql, and, isNull, lt, or } from 'drizzle-orm';
import { shipStationShipmentETL } from './services/shipstation-shipment-etl-service';
import { broadcastOrderUpdate } from './websocket';

// Configuration
const POLL_INTERVAL_MS = 60_000; // 60 seconds between polls
const MAX_PAGES_PER_POLL = 10; // Limit pages per poll cycle to stay under rate limits
const PAGE_SIZE = 100; // ShipStation max per page
const CURSOR_ID = 'shipstation:modified_at';
const LOOKBACK_HOURS = 168; // 7 days lookback for initial cursor

// Worker state
let isPolling = false;
let lastPollTime: Date | null = null;
let pollCount = 0;
let errorCount = 0;
let lastError: string | null = null;
let isRunning = false;
let pollTimer: NodeJS.Timeout | null = null;

// Webhook trigger for immediate poll
let immediatePolltrigger = false;

export interface WorkerStatus {
  isRunning: boolean;
  isPolling: boolean;
  lastPollTime: Date | null;
  pollCount: number;
  errorCount: number;
  lastError: string | null;
  cursorPosition: string | null;
  lastCursorUpdate: Date | null;
}

/**
 * Get current cursor position from database
 * Returns null if no cursor exists (will trigger initial backfill)
 */
async function getCursor(): Promise<{ cursorValue: string; lastSyncedAt: Date } | null> {
  const [cursor] = await db
    .select()
    .from(syncCursors)
    .where(eq(syncCursors.id, CURSOR_ID))
    .limit(1);
  
  if (!cursor) return null;
  
  return {
    cursorValue: cursor.cursorValue,
    lastSyncedAt: cursor.lastSyncedAt,
  };
}

/**
 * Update cursor position in database
 * Uses upsert to handle initial creation
 */
async function updateCursor(cursorValue: string, metadata?: Record<string, unknown>): Promise<void> {
  await db
    .insert(syncCursors)
    .values({
      id: CURSOR_ID,
      cursorValue,
      lastSyncedAt: new Date(),
      metadata: metadata || null,
    })
    .onConflictDoUpdate({
      target: syncCursors.id,
      set: {
        cursorValue,
        lastSyncedAt: new Date(),
        metadata: metadata || null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Get initial cursor value for first-time sync
 * Looks back LOOKBACK_HOURS from now
 */
function getInitialCursorValue(): string {
  const lookbackDate = new Date();
  lookbackDate.setHours(lookbackDate.getHours() - LOOKBACK_HOURS);
  return lookbackDate.toISOString();
}

/**
 * Sync a single shipment to database
 * Uses existing ETL service which handles items, tags, and database operations
 * Then updates sync tracking timestamps
 */
async function syncShipment(shipmentData: any): Promise<string> {
  const now = new Date();
  const modifiedAt = shipmentData.modified_at ? new Date(shipmentData.modified_at) : now;
  
  // Use existing ETL service - handles full upsert including items and tags
  const shipmentDbId = await shipStationShipmentETL.processShipment(shipmentData, null);
  
  // Update sync tracking timestamps
  await db
    .update(shipments)
    .set({
      lastShipstationSyncAt: now,
      shipstationModifiedAt: modifiedAt,
    })
    .where(eq(shipments.id, shipmentDbId));
  
  // Broadcast update via WebSocket
  broadcastOrderUpdate({
    type: 'shipment_synced',
    shipmentId: shipmentDbId,
    orderNumber: shipmentData.order_number || null,
    syncedAt: now.toISOString(),
  });
  
  return shipmentDbId;
}

/**
 * Fetch a page of shipments from ShipStation API
 * Uses modifyDateStart for incremental sync
 */
async function fetchShipmentPage(modifyDateStart: string, page: number): Promise<{
  shipments: any[];
  totalPages: number;
  hasMore: boolean;
}> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    throw new Error('ShipStation API credentials not configured');
  }
  
  const authHeader = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  
  // Build URL with proper V2 API parameters
  const params = new URLSearchParams({
    modified_at_start: modifyDateStart,
    page_size: PAGE_SIZE.toString(),
    page: page.toString(),
    sort_by: 'modified_at',
    sort_dir: 'asc', // Oldest first so we can update cursor progressively
  });
  
  const response = await fetch(
    `https://api.shipstation.com/v2/shipments?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json',
      },
    }
  );
  
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('RATE_LIMIT');
    }
    const errorText = await response.text();
    throw new Error(`ShipStation API error ${response.status}: ${errorText}`);
  }
  
  const data = await response.json();
  
  return {
    shipments: data.shipments || [],
    totalPages: data.pages || 1,
    hasMore: page < (data.pages || 1),
  };
}

/**
 * Main poll cycle - fetches all shipments modified since cursor
 */
async function pollCycle(): Promise<{
  shipmentsProcessed: number;
  pagesProcessed: number;
  newCursor: string | null;
  hitRateLimit: boolean;
}> {
  // Get current cursor or initialize
  let cursor = await getCursor();
  if (!cursor) {
    const initialCursor = getInitialCursorValue();
    await updateCursor(initialCursor);
    cursor = { cursorValue: initialCursor, lastSyncedAt: new Date() };
    console.log(`[UnifiedSync] Initialized cursor to ${initialCursor} (${LOOKBACK_HOURS}h lookback)`);
  }
  
  let currentPage = 1;
  let totalProcessed = 0;
  let pagesProcessed = 0;
  let latestModifiedAt = cursor.cursorValue;
  let hitRateLimit = false;
  
  console.log(`[UnifiedSync] Starting poll from cursor: ${cursor.cursorValue}`);
  
  try {
    while (currentPage <= MAX_PAGES_PER_POLL) {
      const pageResult = await fetchShipmentPage(cursor.cursorValue, currentPage);
      pagesProcessed++;
      
      // Process each shipment
      for (const shipment of pageResult.shipments) {
        try {
          await syncShipment(shipment);
          totalProcessed++;
          
          // Track latest modified_at for cursor update
          if (shipment.modified_at && shipment.modified_at > latestModifiedAt) {
            latestModifiedAt = shipment.modified_at;
          }
        } catch (err) {
          console.error(`[UnifiedSync] Error syncing shipment ${shipment.shipment_id}:`, err);
          // Continue processing other shipments
        }
      }
      
      console.log(`[UnifiedSync] Page ${currentPage}: processed ${pageResult.shipments.length} shipments`);
      
      // Check if we have more pages
      if (!pageResult.hasMore) {
        break;
      }
      
      currentPage++;
    }
  } catch (err: any) {
    if (err.message === 'RATE_LIMIT') {
      console.log(`[UnifiedSync] Hit rate limit after ${pagesProcessed} pages`);
      hitRateLimit = true;
    } else {
      throw err;
    }
  }
  
  // Update cursor if we processed any shipments
  if (totalProcessed > 0 && latestModifiedAt !== cursor.cursorValue) {
    await updateCursor(latestModifiedAt, {
      lastPollShipmentsProcessed: totalProcessed,
      lastPollPagesProcessed: pagesProcessed,
      lastPollAt: new Date().toISOString(),
    });
    console.log(`[UnifiedSync] Updated cursor to: ${latestModifiedAt}`);
  }
  
  return {
    shipmentsProcessed: totalProcessed,
    pagesProcessed,
    newCursor: latestModifiedAt !== cursor.cursorValue ? latestModifiedAt : null,
    hitRateLimit,
  };
}

/**
 * Main worker loop
 */
async function runPollLoop(): Promise<void> {
  if (isPolling) {
    console.log('[UnifiedSync] Poll already in progress, skipping');
    return;
  }
  
  isPolling = true;
  lastPollTime = new Date();
  pollCount++;
  
  try {
    const result = await pollCycle();
    
    console.log(`[UnifiedSync] Poll complete: ${result.shipmentsProcessed} shipments, ${result.pagesProcessed} pages`);
    
    // Broadcast status update - use existing queue status mechanism
    // The operations dashboard will fetch worker status via API
    
    lastError = null;
  } catch (err: any) {
    errorCount++;
    lastError = err.message || 'Unknown error';
    console.error('[UnifiedSync] Poll error:', err);
  } finally {
    isPolling = false;
  }
}

/**
 * Schedule next poll, checking for immediate trigger
 */
function scheduleNextPoll(): void {
  if (!isRunning) return;
  
  pollTimer = setTimeout(async () => {
    // Check for immediate trigger
    if (immediatePolltrigger) {
      console.log('[UnifiedSync] Immediate poll triggered by webhook');
      immediatePolltrigger = false;
    }
    
    await runPollLoop();
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

/**
 * Start the worker
 */
export async function startUnifiedShipmentSyncWorker(): Promise<void> {
  if (isRunning) {
    console.log('[UnifiedSync] Worker already running');
    return;
  }
  
  console.log('[UnifiedSync] Starting unified shipment sync worker');
  isRunning = true;
  
  // Run initial poll immediately
  await runPollLoop();
  
  // Schedule subsequent polls
  scheduleNextPoll();
  
  console.log(`[UnifiedSync] Worker started, polling every ${POLL_INTERVAL_MS / 1000}s`);
}

/**
 * Stop the worker
 */
export function stopUnifiedShipmentSyncWorker(): void {
  console.log('[UnifiedSync] Stopping unified shipment sync worker');
  isRunning = false;
  
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * Trigger an immediate poll (called by webhook handlers)
 */
export function triggerImmediatePoll(): void {
  console.log('[UnifiedSync] Immediate poll requested');
  immediatePolltrigger = true;
  
  // If worker is idle, run poll now
  if (!isPolling && isRunning) {
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    runPollLoop().then(() => scheduleNextPoll());
  }
}

/**
 * Get current worker status
 */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const cursor = await getCursor();
  
  return {
    isRunning,
    isPolling,
    lastPollTime,
    pollCount,
    errorCount,
    lastError,
    cursorPosition: cursor?.cursorValue || null,
    lastCursorUpdate: cursor?.lastSyncedAt || null,
  };
}

/**
 * Get statistics about sync freshness
 */
export async function getSyncStats(): Promise<{
  totalShipments: number;
  syncedLast5Minutes: number;
  syncedLast1Hour: number;
  neverSynced: number;
  onHoldCount: number;
  staleOnHoldCount: number;
}> {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  const [total] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments);
  
  const [last5Min] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(sql`${shipments.lastShipstationSyncAt} >= ${fiveMinutesAgo}`);
  
  const [last1Hour] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(sql`${shipments.lastShipstationSyncAt} >= ${oneHourAgo}`);
  
  const [neverSynced] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(isNull(shipments.lastShipstationSyncAt));
  
  const [onHold] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(eq(shipments.shipmentStatus, 'on_hold'));
  
  // Stale on-hold: synced more than 1 hour ago
  const [staleOnHold] = await db
    .select({ count: sql<number>`count(*)` })
    .from(shipments)
    .where(
      and(
        eq(shipments.shipmentStatus, 'on_hold'),
        or(
          isNull(shipments.lastShipstationSyncAt),
          lt(shipments.lastShipstationSyncAt, oneHourAgo)
        )
      )
    );
  
  return {
    totalShipments: Number(total.count) || 0,
    syncedLast5Minutes: Number(last5Min.count) || 0,
    syncedLast1Hour: Number(last1Hour.count) || 0,
    neverSynced: Number(neverSynced.count) || 0,
    onHoldCount: Number(onHold.count) || 0,
    staleOnHoldCount: Number(staleOnHold.count) || 0,
  };
}

/**
 * Force a full resync by resetting the cursor
 * WARNING: This will re-sync all shipments from the lookback period
 */
export async function forceFullResync(): Promise<void> {
  console.log('[UnifiedSync] Forcing full resync');
  
  const initialCursor = getInitialCursorValue();
  await updateCursor(initialCursor, {
    forcedResyncAt: new Date().toISOString(),
    reason: 'manual_trigger',
  });
  
  // Trigger immediate poll
  triggerImmediatePoll();
}
