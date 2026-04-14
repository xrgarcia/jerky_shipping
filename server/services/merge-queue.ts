import { db } from '../db';
import { orderMerges, shipments, shipmentItems } from '@shared/schema';
import { eq, and, sql, lte, asc, inArray } from 'drizzle-orm';
import { enqueueShipStationWrite, fetchCurrentShipment } from './shipstation-write-queue';
import { withSpan } from '../utils/tracing';

const POLL_INTERVAL_MS = 5000;
const LOG_PREFIX = '[MergeQueue]';
let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const ts = new Date().toLocaleTimeString();
  if (level === 'error') {
    console.error(`${ts} [${level}]${LOG_PREFIX} ${msg}`);
  } else if (level === 'warn') {
    console.warn(`${ts} [${level}]${LOG_PREFIX} ${msg}`);
  } else {
    console.log(`${ts} [${level}]${LOG_PREFIX} ${msg}`);
  }
}

async function processNextJob(): Promise<boolean> {
  return withSpan('merge_queue', 'merge_queue', 'process_job', async () => {
    return await db.transaction(async (tx) => {
      const parentRow = await tx.execute(sql`
        SELECT parent_shipment_id
        FROM order_merges
        WHERE state = 'queued'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      if (!parentRow.rows || parentRow.rows.length === 0) return false;

      const parentShipmentId = (parentRow.rows[0] as any).parent_shipment_id as string;

      const mergeRows = await tx
        .select()
        .from(orderMerges)
        .where(and(
          eq(orderMerges.parentShipmentId, parentShipmentId),
          eq(orderMerges.state, 'queued')
        ));

      if (mergeRows.length === 0) return false;

      const rowIds = mergeRows.map(r => r.id);
      const parentOrderNumber = mergeRows[0].parentOrderNumber;
      const parentLocalId = mergeRows[0].parentLocalId;

      log(`Processing merge: parent ${parentShipmentId} (${parentOrderNumber}) with ${mergeRows.length} children`);

      try {
        const currentShipment = await fetchCurrentShipment(parentShipmentId, parentOrderNumber);
        if (!currentShipment) {
          throw new Error(`Parent shipment ${parentShipmentId} not found in ShipStation (404)`);
        }

        const ssItems = currentShipment.data?.shipment_items || currentShipment.data?.items || [];
        const consolidatedItems = [...ssItems.map((item: any) => ({
          sku: item.sku || '',
          name: item.name || '',
          quantity: item.quantity || 1,
          unit_price: item.unit_price ?? 0,
          image_url: item.image_url || null,
        }))];

        for (const row of mergeRows) {
          const childItems = row.childItemsSnapshot as any[];
          if (Array.isArray(childItems)) {
            for (const ci of childItems) {
              consolidatedItems.push({
                sku: ci.sku || '',
                name: ci.name || '',
                quantity: ci.quantity || 1,
                unit_price: ci.unit_price ?? ci.unitPrice ?? 0,
                image_url: ci.image_url ?? ci.imageUrl ?? null,
              });
            }
          }
        }

        const writeJobId = await enqueueShipStationWrite({
          shipmentId: parentShipmentId,
          patchPayload: { items: consolidatedItems },
          reason: 'merge:update_parent',
          localShipmentId: parentLocalId,
          callbackAction: 'mark_merge_complete',
          orderNumber: parentOrderNumber,
        });

        const now = new Date();
        await tx
          .update(orderMerges)
          .set({
            state: 'processing',
            parentWriteQueueJobId: writeJobId,
            processedAt: now,
            updatedAt: now,
          })
          .where(inArray(orderMerges.id, rowIds));

        log(`Enqueued write job #${writeJobId} for parent ${parentShipmentId}, ${mergeRows.length} children now processing`);
        return true;

      } catch (err: any) {
        const errorMsg = err.message || 'Unknown error';
        log(`Failed to process merge for parent ${parentShipmentId}: ${errorMsg}`, 'error');

        const now = new Date();
        for (const row of mergeRows) {
          const newRetryCount = row.retryCount + 1;
          if (newRetryCount >= row.maxRetries) {
            await tx.update(orderMerges)
              .set({
                state: 'failed',
                lastError: errorMsg,
                retryCount: newRetryCount,
                updatedAt: now,
              })
              .where(eq(orderMerges.id, row.id));
          } else {
            const backoffMs = Math.min(1000 * Math.pow(2, newRetryCount), 300000);
            await tx.update(orderMerges)
              .set({
                lastError: errorMsg,
                retryCount: newRetryCount,
                nextRetryAt: new Date(Date.now() + backoffMs),
                updatedAt: now,
              })
              .where(eq(orderMerges.id, row.id));
          }
        }
        return true;
      }
    });
  });
}

async function recoverStaleProcessingJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
  const result = await db.update(orderMerges)
    .set({ state: 'queued', lastError: 'Recovered from stale processing state (server restart)', updatedAt: new Date() })
    .where(
      and(
        eq(orderMerges.state, 'processing'),
        lte(orderMerges.processedAt, staleThreshold)
      )
    )
    .returning({ id: orderMerges.id });

  if (result.length > 0) {
    log(`Recovered ${result.length} stale processing jobs back to queued`);
  }
  return result.length;
}

async function pollLoop() {
  while (workerRunning) {
    try {
      const processed = await processNextJob();
      if (!processed) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (err: any) {
      log(`Poll loop error: ${err.message}`, 'error');
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

export function startMergeQueueWorker() {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting merge queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopMergeQueueWorker() {
  log('Stopping merge queue worker');
  workerRunning = false;
}
