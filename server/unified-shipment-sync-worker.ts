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
import { smartCarrierRateService } from './services/smart-carrier-rate-service';
import { broadcastOrderUpdate, broadcastQueueStatus, type OrderEventType } from './websocket';
import { 
  getQueueLength, 
  getShipmentSyncQueueLength, 
  getShopifyOrderSyncQueueLength,
  getOldestShopifyQueueMessage,
  getOldestShipmentSyncQueueMessage,
  getOldestShopifyOrderSyncQueueMessage,
  incrementShipmentSyncFailureCount,
  clearShipmentSyncFailureCount,
  isShipmentDeadLettered,
  markShipmentAsDeadLettered,
} from './utils/queue';
import { storage } from './storage';

// Configuration
const POLL_INTERVAL_MS = 60_000; // 60 seconds between polls
const MAX_PAGES_PER_POLL = 10; // Limit pages per poll cycle to stay under rate limits
const PAGE_SIZE = 100; // ShipStation max per page
const CURSOR_ID = 'shipstation:modified_at';
const LOOKBACK_HOURS = 168; // 7 days lookback for initial cursor
const SHIPSTATION_API_BASE = 'https://api.shipstation.com';
const TRACKING_BACKFILL_BATCH_SIZE = 10; // Max shipments to backfill per poll cycle
const TRACKING_BACKFILL_MIN_AGE_HOURS = 48; // Only backfill shipments older than 2 days
const LABEL_FETCH_RETRY_MAX = 2; // Max retries for label fetch per shipment
const MAX_SYNC_FAILURES_BEFORE_DEADLETTER = 3; // Dead-letter after this many failed attempts
const MAX_POLL_DURATION_MS = 5 * 60 * 1000; // 5 minute maximum poll duration - self-healing timeout

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
 * Also triggers smart carrier rate analysis for cost optimization
 */
async function syncShipment(shipmentData: any): Promise<string> {
  const now = new Date();
  const modifiedAt = shipmentData.modified_at ? new Date(shipmentData.modified_at) : now;
  
  // Use existing ETL service - handles full upsert including items and tags
  const shipmentDbId = await shipStationShipmentETL.processShipment(shipmentData, null);
  
  // Update sync tracking timestamps and fetch shipment data for rate analysis
  const [updatedShipment] = await db
    .update(shipments)
    .set({
      lastShipstationSyncAt: now,
      shipstationModifiedAt: modifiedAt,
    })
    .where(eq(shipments.id, shipmentDbId))
    .returning();
  
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
  
  // Trigger smart carrier rate analysis (non-blocking)
  // Only analyze if shipment has the required data
  if (updatedShipment && updatedShipment.shipmentId && updatedShipment.serviceCode && updatedShipment.shipToPostalCode) {
    smartCarrierRateService.analyzeAndSave(updatedShipment).catch(err => {
      console.error(`[UnifiedSync] Rate analysis failed for ${updatedShipment.shipmentId}:`, err.message);
    });
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
 * Fetch labels for a batch of shipments and attach tracking_number to each
 * The /v2/shipments endpoint does NOT include tracking numbers - they come from /v2/labels
 * This function makes one API call per shipment to fetch its labels
 * 
 * Modifies shipments in place by attaching tracking_number and labels
 * Returns count of shipments that got tracking numbers
 */
async function fetchLabelsForShipments(shipmentsToEnrich: any[]): Promise<{
  withTracking: number;
  errors: number;
  hitRateLimit: boolean;
}> {
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) {
    console.error('[UnifiedSync] Cannot fetch labels - SHIPSTATION_API_KEY not configured');
    return { withTracking: 0, errors: shipmentsToEnrich.length, hitRateLimit: false };
  }
  
  let withTracking = 0;
  let errors = 0;
  let hitRateLimit = false;
  
  for (const shipment of shipmentsToEnrich) {
    const shipmentId = shipment.shipment_id;
    if (!shipmentId) continue;
    
    let retryCount = 0;
    
    while (retryCount <= LABEL_FETCH_RETRY_MAX) {
      try {
        const labelUrl = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipmentId)}`;
        
        const response = await fetch(labelUrl, {
          method: 'GET',
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
          },
        });
        
        // Handle 429 rate limit
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
          if (retryCount < LABEL_FETCH_RETRY_MAX) {
            console.log(`[UnifiedSync] Rate limited (429) fetching labels for ${shipmentId}, waiting ${retryAfter}s...`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 1000));
            retryCount++;
            continue;
          } else {
            console.log('[UnifiedSync] Hit rate limit during label fetch, stopping batch');
            hitRateLimit = true;
            return { withTracking, errors, hitRateLimit };
          }
        }
        
        if (response.ok) {
          const labelData = await response.json();
          const labels = labelData.labels || [];
          if (labels.length > 0) {
            // Attach tracking number and labels to shipment data
            shipment.tracking_number = labels[0].tracking_number || null;
            shipment.labels = labels;
            if (shipment.tracking_number) {
              withTracking++;
            }
          }
        } else {
          // Non-429 error
          console.log(`[UnifiedSync] Failed to fetch labels for shipment ${shipmentId}: ${response.status}`);
          errors++;
        }
        
        break; // Success or non-retryable error
      } catch (err: any) {
        console.log(`[UnifiedSync] Error fetching labels for ${shipmentId}: ${err.message}`);
        errors++;
        break;
      }
    }
  }
  
  return { withTracking, errors, hitRateLimit };
}

/**
 * Backfill tracking numbers for shipped shipments that are missing tracking
 * Only processes shipments older than TRACKING_BACKFILL_MIN_AGE_HOURS (2 days)
 * This runs after the main poll cycle and processes a small batch to avoid rate limits
 * 
 * EXCLUDES:
 * - shipment_status='label_purchased' (label printed but not picked up by carrier - expected to have no tracking)
 * - shipment_status='on_hold' (shipments on hold don't have tracking yet)
 * 
 * Returns number of shipments updated
 */
async function backfillMissingTracking(): Promise<{ processed: number; updated: number; errors: number }> {
  // Query shipments that:
  // 1. Have status='shipped' but no tracking number
  // 2. Are older than 2 days (to allow normal sync to work first)
  // 3. Have a shipment_id we can look up
  // 4. NOT label_purchased or on_hold (those legitimately don't have tracking yet)
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - TRACKING_BACKFILL_MIN_AGE_HOURS);
  
  const shipmentsToBackfill = await db
    .select({
      id: shipments.id,
      shipmentId: shipments.shipmentId,
      orderNumber: shipments.orderNumber,
      createdAt: shipments.createdAt,
      shipmentStatus: shipments.shipmentStatus,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.status, 'shipped'),
        isNull(shipments.trackingNumber),
        sql`${shipments.shipmentId} IS NOT NULL`,
        lt(shipments.createdAt, cutoffDate),
        sql`(${shipments.shipmentStatus} IS NULL OR ${shipments.shipmentStatus} NOT IN ('label_purchased', 'on_hold'))`
      )
    )
    .orderBy(shipments.createdAt)
    .limit(TRACKING_BACKFILL_BATCH_SIZE);
  
  if (shipmentsToBackfill.length === 0) {
    return { processed: 0, updated: 0, errors: 0 };
  }
  
  console.log(`[UnifiedSync] Backfilling tracking for ${shipmentsToBackfill.length} shipped shipments without tracking`);
  
  let processed = 0;
  let updated = 0;
  let errors = 0;
  const apiKey = process.env.SHIPSTATION_API_KEY;
  
  if (!apiKey) {
    console.error('[UnifiedSync] Cannot backfill tracking - SHIPSTATION_API_KEY not configured');
    return { processed: 0, updated: 0, errors: 0 };
  }
  
  for (const shipment of shipmentsToBackfill) {
    processed++;
    
    try {
      // FIXED: Fetch labels directly - the /v2/shipments/{id} endpoint does NOT include tracking numbers
      // Tracking numbers ONLY come from the /v2/labels endpoint
      const labelUrl = `${SHIPSTATION_API_BASE}/v2/labels?shipment_id=${encodeURIComponent(shipment.shipmentId!)}`;
      
      const labelResponse = await fetch(labelUrl, {
        method: 'GET',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });
      
      if (labelResponse.status === 429) {
        console.log('[UnifiedSync] Hit rate limit during tracking backfill, stopping batch');
        break;
      }
      
      if (!labelResponse.ok) {
        console.error(`[UnifiedSync] Failed to fetch labels for shipment ${shipment.shipmentId}: ${labelResponse.status}`);
        errors++;
        continue;
      }
      
      const labelData = await labelResponse.json();
      const labels = labelData.labels || [];
      
      if (labels.length > 0) {
        const trackingNumber = labels[0].tracking_number || null;
        
        if (trackingNumber) {
          // Update the shipment record directly with the tracking number
          await db
            .update(shipments)
            .set({
              trackingNumber: trackingNumber,
            })
            .where(eq(shipments.id, shipment.id));
          
          updated++;
          console.log(`[UnifiedSync] Backfilled tracking ${trackingNumber} for order ${shipment.orderNumber}`);
        }
      }
      
    } catch (err) {
      console.error(`[UnifiedSync] Error backfilling shipment ${shipment.shipmentId}:`, err);
      errors++;
    }
  }
  
  if (updated > 0 || errors > 0) {
    console.log(`[UnifiedSync] Tracking backfill complete: ${processed} processed, ${updated} updated, ${errors} errors`);
  }
  
  return { processed, updated, errors };
}

// Configuration for tag refresh
const TAG_REFRESH_BATCH_SIZE = 10; // Max shipments to refresh tags for per poll cycle

/**
 * Refresh tags for shipments in pre-fingerprinting phases to catch tag removals
 * 
 * PURPOSE: ShipStation's modified_at cursor doesn't update when ONLY tags change.
 * This means if a "MOVE OVER" tag is removed, our cursor-based sync won't catch it.
 * This job specifically re-fetches tags for shipments that are in lifecycle phases
 * where the MOVE OVER tag matters (ready_to_session, awaiting_decisions).
 * 
 * TRIGGERS: After main poll cycle when caught up (same as tracking backfill)
 * 
 * Returns number of shipments with tag changes detected
 */
async function refreshTagsForPreSessionShipments(): Promise<{ processed: number; updated: number; errors: number }> {
  const { shipmentTags, LIFECYCLE_PHASES } = await import('@shared/schema');
  const { updateShipmentLifecycle } = await import('./services/lifecycle-service');
  
  // Find shipments in phases where MOVE OVER tag matters:
  // - ready_to_session: On hold + MOVE OVER tag - fingerprinting happens here
  // - awaiting_decisions: Has fingerprint, may still be sensitive to tag changes
  const shipmentsToRefresh = await db
    .select({
      id: shipments.id,
      shipmentId: shipments.shipmentId,
      orderNumber: shipments.orderNumber,
      lifecyclePhase: shipments.lifecyclePhase,
    })
    .from(shipments)
    .where(
      and(
        sql`${shipments.shipmentId} IS NOT NULL`,
        or(
          eq(shipments.lifecyclePhase, LIFECYCLE_PHASES.READY_TO_SESSION),
          eq(shipments.lifecyclePhase, LIFECYCLE_PHASES.AWAITING_DECISIONS)
        )
      )
    )
    .orderBy(shipments.updatedAt)
    .limit(TAG_REFRESH_BATCH_SIZE);
  
  if (shipmentsToRefresh.length === 0) {
    return { processed: 0, updated: 0, errors: 0 };
  }
  
  const apiKey = process.env.SHIPSTATION_API_KEY;
  if (!apiKey) {
    return { processed: 0, updated: 0, errors: 0 };
  }
  
  let processed = 0;
  let updated = 0;
  let errors = 0;
  
  for (const shipment of shipmentsToRefresh) {
    processed++;
    
    try {
      // Fetch current shipment data from ShipStation to get latest tags
      const url = `${SHIPSTATION_API_BASE}/v2/shipments/${encodeURIComponent(shipment.shipmentId!)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });
      
      if (response.status === 429) {
        console.log('[UnifiedSync] Hit rate limit during tag refresh, stopping batch');
        break;
      }
      
      if (!response.ok) {
        errors++;
        continue;
      }
      
      const shipmentData = await response.json();
      const freshTags = shipmentData.tags || [];
      
      // Get current local tags
      const localTags = await db
        .select({ name: shipmentTags.name })
        .from(shipmentTags)
        .where(eq(shipmentTags.shipmentId, shipment.id));
      
      const freshTagNames = new Set(freshTags.map((t: any) => t.name?.trim()).filter(Boolean));
      const localTagNames = new Set(localTags.map(t => t.name));
      
      // Check if tags differ
      const hasMoveOverLocally = localTagNames.has('MOVE OVER');
      const hasMoveOverInShipStation = freshTagNames.has('MOVE OVER');
      
      if (hasMoveOverLocally !== hasMoveOverInShipStation) {
        console.log(`[UnifiedSync] Tag change detected for ${shipment.orderNumber}: MOVE OVER ${hasMoveOverLocally ? 'removed' : 'added'} in ShipStation`);
        
        // Update tags: delete all and re-insert from ShipStation
        await db.delete(shipmentTags).where(eq(shipmentTags.shipmentId, shipment.id));
        
        if (freshTags.length > 0) {
          const tagsToInsert = freshTags
            .filter((tag: any) => tag && (tag.name || tag.tag_id))
            .map((tag: any) => ({
              shipmentId: shipment.id,
              name: tag.name?.trim() || `Tag ${tag.tag_id}`,
              color: tag.color || null,
              tagId: tag.tag_id?.toString() || null,
            }));
          
          if (tagsToInsert.length > 0) {
            await db.insert(shipmentTags).values(tagsToInsert);
          }
        }
        
        // Re-evaluate lifecycle phase with updated tags
        await updateShipmentLifecycle(shipment.id, { logTransition: true });
        
        updated++;
      }
      
    } catch (err) {
      console.error(`[UnifiedSync] Error refreshing tags for ${shipment.orderNumber}:`, err);
      errors++;
    }
  }
  
  if (updated > 0) {
    console.log(`[UnifiedSync] Tag refresh complete: ${processed} checked, ${updated} with tag changes, ${errors} errors`);
  }
  
  return { processed, updated, errors };
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
      
      // CRITICAL: Fetch labels for each shipment BEFORE processing
      // The /v2/shipments endpoint does NOT include tracking numbers - they come from /v2/labels
      if (pageResult.shipments.length > 0) {
        const labelResult = await fetchLabelsForShipments(pageResult.shipments);
        
        if (labelResult.hitRateLimit) {
          console.log(`[UnifiedSync] Hit rate limit during label fetch on page ${currentPage}`);
          hitRateLimit = true;
          // Still process what we have - some shipments may have tracking now
        }
        
        if (labelResult.withTracking > 0) {
          console.log(`[UnifiedSync] Page ${currentPage}: fetched labels, ${labelResult.withTracking}/${pageResult.shipments.length} have tracking`);
        }
      }
      
      // Process each shipment (now with labels/tracking attached)
      for (const shipment of pageResult.shipments) {
        const shipmentId = shipment.shipment_id;
        const modifiedAt = shipment.modified_at || '';
        
        // Skip already dead-lettered shipments - check database by shipmentId only
        // This handles cases where modifiedAt changes but shipment is still dead-lettered
        if (shipmentId) {
          const dbDeadLetter = await storage.getShipmentsDeadLetter(shipmentId);
          if (dbDeadLetter) {
            // Silently skip - no need to log every time, just advance cursor
            if (modifiedAt) {
              successTimestamps.push(modifiedAt);
            }
            continue;
          }
          
          // Also check Redis as secondary mechanism (for recently dead-lettered before DB write)
          if (modifiedAt) {
            const redisDeadLettered = await isShipmentDeadLettered(shipmentId, modifiedAt);
            if (redisDeadLettered) {
              successTimestamps.push(modifiedAt);
              continue;
            }
          }
        }
        
        try {
          await syncShipment(shipment);
          totalProcessed++;
          // Track successful timestamps for cursor advancement
          if (modifiedAt) {
            successTimestamps.push(modifiedAt);
            // Clear any previous failure count on success
            if (shipmentId) {
              await clearShipmentSyncFailureCount(shipmentId, modifiedAt);
            }
          }
        } catch (err: any) {
          totalErrored++;
          const errorMessage = err?.message || 'Unknown error';
          console.error(`[UnifiedSync] Error syncing shipment ${shipmentId}:`, err);
          
          // Track failure in Redis and check if we should dead-letter
          if (shipmentId && modifiedAt) {
            const failureCount = await incrementShipmentSyncFailureCount(shipmentId, modifiedAt);
            
            if (failureCount >= MAX_SYNC_FAILURES_BEFORE_DEADLETTER) {
              // Dead-letter this shipment
              console.log(`[UnifiedSync] Dead-lettering shipment ${shipmentId} after ${failureCount} failures`);
              
              try {
                // Insert into shipmentSyncFailures table
                await db.insert(shipmentSyncFailures).values({
                  shipstationShipmentId: shipmentId,
                  modifiedAt: modifiedAt,
                  orderNumber: shipment.order_number || 'unknown',
                  reason: 'unified_sync',
                  errorMessage: errorMessage,
                  requestData: shipment,
                  retryCount: failureCount,
                  failedAt: new Date(),
                }).onConflictDoNothing(); // Don't fail if already exists
                
                // Mark as dead-lettered in Redis
                await markShipmentAsDeadLettered(shipmentId, modifiedAt);
                await clearShipmentSyncFailureCount(shipmentId, modifiedAt);
                
                // IMPORTANT: Dead-lettered shipments don't block cursor advancement
                // Treat them as "processed" for cursor purposes
                successTimestamps.push(modifiedAt);
                console.log(`[UnifiedSync] Shipment ${shipmentId} moved to dead-letter queue, cursor can advance past it`);
              } catch (dlErr) {
                console.error(`[UnifiedSync] Failed to dead-letter shipment ${shipmentId}:`, dlErr);
                // If dead-lettering fails, still track as failure to block cursor
                if (!earliestFailureTimestamp || modifiedAt < earliestFailureTimestamp) {
                  earliestFailureTimestamp = modifiedAt;
                }
              }
            } else {
              // Not yet at dead-letter threshold - track as failure to block cursor
              console.log(`[UnifiedSync] Shipment ${shipmentId} failed (attempt ${failureCount}/${MAX_SYNC_FAILURES_BEFORE_DEADLETTER})`);
              if (!earliestFailureTimestamp || modifiedAt < earliestFailureTimestamp) {
                earliestFailureTimestamp = modifiedAt;
              }
            }
          } else {
            // No shipmentId or modifiedAt - can't track properly, just log
            console.warn(`[UnifiedSync] Shipment missing ID or modified_at, cannot track failure`);
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
    // Self-healing timeout: If pollCycle hangs (e.g., due to DB connection issues),
    // forcefully abort after MAX_POLL_DURATION_MS to reset the isPolling flag
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Poll timeout exceeded (${MAX_POLL_DURATION_MS / 1000}s) - aborting to allow recovery`));
      }, MAX_POLL_DURATION_MS);
    });
    
    const result = await Promise.race([pollCycle(), timeoutPromise]);
    
    console.log(`[UnifiedSync] Poll complete: ${result.shipmentsProcessed} processed, ${result.shipmentsErrored} errors, ${result.pagesProcessed} pages`);
    
    // Flag for immediate follow-up if more pages remain
    needsImmediateFollowup = result.hasMorePages;
    
    // Run maintenance jobs ONLY when we're caught up (not during catch-up)
    // This prevents using API quota during high-priority sync
    if (!needsImmediateFollowup && !result.hitRateLimit) {
      try {
        await backfillMissingTracking();
      } catch (backfillErr) {
        console.error('[UnifiedSync] Tracking backfill error (non-fatal):', backfillErr);
      }
      
      // Refresh tags for pre-session shipments to catch tag removals
      // ShipStation's modified_at doesn't update when only tags change
      try {
        await refreshTagsForPreSessionShipments();
      } catch (tagRefreshErr) {
        console.error('[UnifiedSync] Tag refresh error (non-fatal):', tagRefreshErr);
      }
    }
    
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
  
  // Immediately broadcast the updated cursor so UI reflects the change
  await broadcastWorkerStatus();
  
  // Trigger immediate poll
  triggerImmediatePoll();
}

/**
 * Force a resync with custom lookback days
 * WARNING: This will re-sync all shipments from the specified lookback period
 */
export async function forceResyncWithDays(days: number): Promise<void> {
  console.log(`[UnifiedSync] Forcing resync with ${days}-day lookback`);
  
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - days);
  const cursorValue = lookbackDate.toISOString();
  
  await updateCursor(cursorValue, {
    forcedResyncAt: new Date().toISOString(),
    reason: `manual_trigger_${days}_days`,
    lookbackDays: days,
  });
  
  // Immediately broadcast the updated cursor so UI reflects the change
  await broadcastWorkerStatus();
  
  // Trigger immediate poll
  triggerImmediatePoll();
}
