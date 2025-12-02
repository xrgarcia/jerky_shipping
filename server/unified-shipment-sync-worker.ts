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
import { syncCursors, shipments, shipmentSyncFailures } from '@shared/schema';
import { eq, sql, and, isNull, lt, or, count } from 'drizzle-orm';
import { shipStationShipmentETL } from './services/shipstation-shipment-etl-service';
import { broadcastOrderUpdate, broadcastQueueStatus, type OrderEventType } from './websocket';
import { 
  getQueueLength, 
  getShipmentSyncQueueLength, 
  getShopifyOrderSyncQueueLength,
  getOldestShopifyQueueMessage,
  getOldestShipmentSyncQueueMessage,
  getOldestShopifyOrderSyncQueueMessage
} from './utils/queue';
import { storage } from './storage';

// Configuration
const POLL_INTERVAL_MS = 60_000; // 60 seconds between polls
const MAX_PAGES_PER_POLL = 10; // Limit pages per poll cycle to stay under rate limits
const PAGE_SIZE = 100; // ShipStation max per page
const CURSOR_ID = 'shipstation:modified_at';
const LOOKBACK_HOURS = 168; // 7 days lookback for initial cursor
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';

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
  credentialsConfigured: boolean;
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
  
  // Update sync tracking timestamps and fetch the order number from DB
  const [updatedShipment] = await db
    .update(shipments)
    .set({
      lastShipstationSyncAt: now,
      shipstationModifiedAt: modifiedAt,
    })
    .where(eq(shipments.id, shipmentDbId))
    .returning({ orderNumber: shipments.orderNumber });
  
  // Broadcast update via WebSocket with shipment_synced event type
  // Use the order number from the database record (properly extracted by ETL)
  const orderNumber = updatedShipment?.orderNumber || null;
  if (orderNumber) {
    broadcastOrderUpdate({
      type: 'shipment_synced',
      orderNumber,
      syncedAt: now.toISOString(),
    }, 'shipment_synced');
  }
  
  return shipmentDbId;
}

/**
 * Fetch a page of shipments from ShipStation API
 * Uses modifyDateStart for incremental sync
 * Uses the same api-key header authentication as the rest of the codebase
 */
async function fetchShipmentPage(modifyDateStart: string, page: number): Promise<{
  shipments: any[];
  totalPages: number;
  hasMore: boolean;
}> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    throw new Error('SHIPSTATION_API_KEY environment variable is not set');
  }
  
  // Build URL with proper V2 API parameters
  const params = new URLSearchParams({
    modified_at_start: modifyDateStart,
    page_size: PAGE_SIZE.toString(),
    page: page.toString(),
    sort_by: 'modified_at',
    sort_dir: 'asc', // Oldest first so we can update cursor progressively
  });
  
  // ShipStation V2 API uses api-key header (lowercase) - same as rest of codebase
  const response = await fetch(
    `${SHIPSTATION_API_BASE}/v2/shipments?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        'api-key': apiKey,
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
 * 
 * DESIGN DECISIONS (crash-safety):
 * 1. Individual shipment failures do NOT block cursor advancement. We still advance
 *    the cursor to prevent infinite loops, but log failures for later retry.
 * 2. When MAX_PAGES is reached, we advance cursor to processed point and flag
 *    that more pages remain - caller should schedule immediate follow-up.
 * 3. 30-second overlap on cursor protects against clock drift and concurrent modifications.
 */
async function pollCycle(): Promise<{
  shipmentsProcessed: number;
  shipmentsErrored: number;
  pagesProcessed: number;
  newCursor: string | null;
  hitRateLimit: boolean;
  hasMorePages: boolean;
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
  let totalErrored = 0;
  let pagesProcessed = 0;
  let hitRateLimit = false;
  let hasMorePages = false;
  
  // Track timestamps separately for success and failure
  // We can only advance cursor up to (but not past) the EARLIEST failure
  const successTimestamps: string[] = [];
  let earliestFailureTimestamp: string | null = null;
  
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
          // Track successful timestamps for cursor advancement
          if (shipment.modified_at) {
            successTimestamps.push(shipment.modified_at);
          }
        } catch (err) {
          totalErrored++;
          console.error(`[UnifiedSync] Error syncing shipment ${shipment.shipment_id}:`, err);
          // Track earliest failure - cursor cannot advance past this
          if (shipment.modified_at) {
            if (!earliestFailureTimestamp || shipment.modified_at < earliestFailureTimestamp) {
              earliestFailureTimestamp = shipment.modified_at;
            }
          }
        }
      }
      
      console.log(`[UnifiedSync] Page ${currentPage}: processed ${pageResult.shipments.length} shipments (${totalErrored} errors so far)`);
      
      // Check if we have more pages
      if (!pageResult.hasMore) {
        break;
      }
      
      // Check if we've hit MAX_PAGES - flag for immediate follow-up
      if (currentPage >= MAX_PAGES_PER_POLL) {
        hasMorePages = true;
        console.log(`[UnifiedSync] Reached MAX_PAGES (${MAX_PAGES_PER_POLL}), more pages remain - will continue in next poll`);
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
  
  // SAFE CURSOR ADVANCEMENT:
  // We can only advance cursor up to (but NOT past) the earliest failure.
  // This ensures failed shipments are retried on the next poll.
  // 
  // OVERLAP STRATEGY:
  // - When catching up (hasMorePages): NO overlap to ensure forward progress
  // - When fully caught up: 30-second overlap for safety
  // - When failures exist: cursor stops just before the earliest failure
  let newCursor: string | null = null;
  
  if (successTimestamps.length > 0) {
    // Sort timestamps to find the latest successful one
    successTimestamps.sort();
    let latestSuccessTimestamp = successTimestamps[successTimestamps.length - 1];
    
    // CRITICAL: If there were failures, cap cursor at just before the earliest failure
    // This ensures the failed shipment is re-fetched on the next poll
    if (earliestFailureTimestamp && earliestFailureTimestamp <= latestSuccessTimestamp) {
      // Set cursor to 1 second before the earliest failure to ensure it's re-fetched
      const failureDate = new Date(earliestFailureTimestamp);
      failureDate.setSeconds(failureDate.getSeconds() - 1);
      latestSuccessTimestamp = failureDate.toISOString();
      console.log(`[UnifiedSync] Capping cursor before earliest failure: ${earliestFailureTimestamp}`);
    }
    
    const latestDate = new Date(latestSuccessTimestamp);
    
    // Only apply overlap when fully caught up and no failures
    if (!hasMorePages && !earliestFailureTimestamp) {
      latestDate.setSeconds(latestDate.getSeconds() - 30);
    }
    const safeCursor = latestDate.toISOString();
    
    // Only advance if the safe cursor is newer than current cursor
    if (safeCursor > cursor.cursorValue) {
      await updateCursor(safeCursor, {
        lastPollShipmentsProcessed: totalProcessed,
        lastPollShipmentsErrored: totalErrored,
        lastPollPagesProcessed: pagesProcessed,
        lastPollAt: new Date().toISOString(),
        hasMorePages,
        earliestFailureTimestamp,
      });
      const overlapNote = earliestFailureTimestamp 
        ? 'capped before failure'
        : hasMorePages 
          ? 'no overlap for catch-up' 
          : 'with 30s safety overlap';
      console.log(`[UnifiedSync] Updated cursor to: ${safeCursor} (${overlapNote})`);
      newCursor = safeCursor;
    }
  } else if (earliestFailureTimestamp) {
    // All shipments failed - don't advance cursor at all
    console.log(`[UnifiedSync] All ${totalErrored} shipments failed - cursor NOT advanced`);
  }
  
  if (totalErrored > 0) {
    console.log(`[UnifiedSync] Warning: ${totalErrored} shipments failed to sync - will retry on next poll`);
  }
  
  return {
    shipmentsProcessed: totalProcessed,
    shipmentsErrored: totalErrored,
    pagesProcessed,
    newCursor,
    hitRateLimit,
    hasMorePages,
  };
}

/**
 * Main worker loop
 * Returns true if there are more pages to process (immediate follow-up needed)
 */
async function runPollLoop(): Promise<boolean> {
  if (isPolling) {
    console.log('[UnifiedSync] Poll already in progress, skipping');
    return false;
  }
  
  isPolling = true;
  lastPollTime = new Date();
  pollCount++;
  
  let needsImmediateFollowup = false;
  
  try {
    const result = await pollCycle();
    
    console.log(`[UnifiedSync] Poll complete: ${result.shipmentsProcessed} processed, ${result.shipmentsErrored} errors, ${result.pagesProcessed} pages`);
    
    // Flag for immediate follow-up if more pages remain
    needsImmediateFollowup = result.hasMorePages;
    
    lastError = null;
  } catch (err: any) {
    errorCount++;
    lastError = err.message || 'Unknown error';
    console.error('[UnifiedSync] Poll error:', err);
  } finally {
    isPolling = false;
    // Broadcast updated status via WebSocket after each poll
    await broadcastWorkerStatus();
  }
  
  return needsImmediateFollowup;
}

/**
 * Schedule next poll, checking for immediate trigger
 * Uses short delay when catching up or when webhook requested immediate poll
 * 
 * IMMEDIACY GUARANTEE: The immediatePolltrigger flag is checked HERE
 * (after poll completion) so webhooks received during polling trigger
 * another poll immediately, not after 60s.
 */
function scheduleNextPoll(immediateFollowup: boolean = false): void {
  if (!isRunning) return;
  
  // Clear any existing timer
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  
  // Check if webhook requested immediate poll during our last cycle
  const webhookTriggered = immediatePolltrigger;
  if (webhookTriggered) {
    console.log('[UnifiedSync] Webhook triggered immediate poll during last cycle');
    immediatePolltrigger = false;
  }
  
  // Use short delay for catch-up OR webhook trigger, normal interval otherwise
  const shouldPollImmediately = immediateFollowup || webhookTriggered;
  const delay = shouldPollImmediately ? 1000 : POLL_INTERVAL_MS; // 1s vs 60s
  
  if (immediateFollowup) {
    console.log('[UnifiedSync] More pages remain, scheduling immediate follow-up poll');
  }
  
  pollTimer = setTimeout(async () => {
    const needsFollowup = await runPollLoop();
    scheduleNextPoll(needsFollowup);
  }, delay);
}

/**
 * Start the worker
 */
export async function startUnifiedShipmentSyncWorker(): Promise<void> {
  if (isRunning) {
    console.log('[UnifiedSync] Worker already running');
    return;
  }
  
  // Check credentials at startup and log for debugging
  const credentials = checkCredentialsConfigured();
  console.log('[UnifiedSync] Credential check:', credentials.configured ? 'OK' : `MISSING - ${credentials.error}`);
  
  console.log('[UnifiedSync] Starting unified shipment sync worker');
  isRunning = true;
  
  // Run initial poll immediately
  const needsFollowup = await runPollLoop();
  
  // Schedule subsequent polls (with immediate follow-up if needed)
  scheduleNextPoll(needsFollowup);
  
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
 * 
 * RELIABILITY: This function MUST wake a dormant worker - it cannot just set a flag
 * and hope the timer picks it up. If the worker is idle (not polling), we clear
 * the timer and start a poll immediately.
 */
export function triggerImmediatePoll(): void {
  if (!isRunning) {
    console.log('[UnifiedSync] Worker not running, cannot trigger immediate poll');
    return;
  }
  
  console.log('[UnifiedSync] Immediate poll requested');
  
  // If currently polling, just set the flag - the next schedule will see it
  if (isPolling) {
    console.log('[UnifiedSync] Currently polling, will trigger again after completion');
    immediatePolltrigger = true;
    return;
  }
  
  // Worker is idle - clear timer and poll immediately
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  
  // Immediately start poll and reschedule after
  console.log('[UnifiedSync] Waking idle worker for immediate poll');
  runPollLoop().then((needsFollowup) => {
    // Check if another immediate trigger came in while we were polling
    const shouldFollowup = needsFollowup || immediatePolltrigger;
    immediatePolltrigger = false;
    scheduleNextPoll(shouldFollowup);
  });
}

/**
 * Check if ShipStation API credentials are configured
 * Uses the same api-key pattern as the rest of the codebase
 */
function checkCredentialsConfigured(): { configured: boolean; error: string | null } {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    return { configured: false, error: 'SHIPSTATION_API_KEY not configured' };
  }
  return { configured: true, error: null };
}

/**
 * Get current worker status
 */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const cursor = await getCursor();
  const credentials = checkCredentialsConfigured();
  
  // Debug log for credential check
  console.log('[UnifiedSync] Status check - credentialsConfigured:', credentials.configured, 'error:', credentials.error);
  
  // If credentials are not configured, always show as error state
  const effectiveError = !credentials.configured 
    ? credentials.error 
    : lastError;
  
  return {
    isRunning,
    isPolling,
    lastPollTime,
    pollCount,
    errorCount,
    lastError: effectiveError,
    cursorPosition: cursor?.cursorValue || null,
    lastCursorUpdate: cursor?.lastSyncedAt || null,
    credentialsConfigured: credentials.configured,
  };
}

/**
 * Broadcast worker status via WebSocket
 * Called after each poll cycle to update the Operations dashboard in real-time
 */
async function broadcastWorkerStatus(): Promise<void> {
  try {
    const status = await getWorkerStatus();
    const stats = await getSyncStats();
    
    // Get current queue stats to include in broadcast
    const shopifyQueueLength = await getQueueLength();
    const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
    const shopifyOrderSyncQueueLength = await getShopifyOrderSyncQueueLength();
    const oldestShopify = await getOldestShopifyQueueMessage();
    const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
    const oldestShopifyOrderSync = await getOldestShopifyOrderSyncQueueMessage();
    const failureCount = await db.select({ count: count() })
      .from(shipmentSyncFailures)
      .then(rows => rows[0]?.count || 0);
    const allBackfillJobs = await storage.getAllBackfillJobs();
    const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
    const dataHealth = await storage.getDataHealthMetrics();
    const pipeline = await storage.getPipelineMetrics();
    
    broadcastQueueStatus({
      shopifyQueue: shopifyQueueLength,
      shipmentSyncQueue: shipmentSyncQueueLength,
      shopifyOrderSyncQueue: shopifyOrderSyncQueueLength,
      shipmentFailureCount: failureCount,
      shopifyQueueOldestAt: oldestShopify?.enqueuedAt || null,
      shipmentSyncQueueOldestAt: oldestShipmentSync?.enqueuedAt || null,
      shopifyOrderSyncQueueOldestAt: oldestShopifyOrderSync?.enqueuedAt || null,
      backfillActiveJob: activeBackfillJob,
      dataHealth,
      pipeline,
      unifiedSyncWorker: {
        isRunning: status.isRunning,
        isPolling: status.isPolling,
        lastPollTime: status.lastPollTime?.toISOString() || null,
        pollCount: status.pollCount,
        errorCount: status.errorCount,
        lastError: status.lastError,
        cursorPosition: status.cursorPosition,
        lastCursorUpdate: status.lastCursorUpdate?.toISOString() || null,
        credentialsConfigured: status.credentialsConfigured,
        syncStats: stats,
      },
    });
  } catch (error) {
    console.error('[UnifiedSync] Error broadcasting worker status:', error);
  }
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
