import { db } from '../db';
import { shipments, shipmentItems, shipmentQcItems, mergeGroups, mergeGroupMembers, mergeGroupQueue } from '@shared/schema';
import type { Shipment } from '@shared/schema';
import { eq, and, or, lte, asc, inArray, notInArray, isNull, ne, sql } from 'drizzle-orm';
import logger from '../utils/logger';

const POLL_INTERVAL_MS = 5000;
const EXPONENTIAL_BACKOFF_BASE_MS = 5000;
const MAX_BACKOFF_MS = 300000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

const MERGEABLE_PHASES = [
  'ready_to_fulfill',
  'ready_to_session',
  'fulfillment_prep',
  'ready_for_skuvault',
];

// Maximum time window for grouping orders to the same address.
// 72 hours covers Fri–Sun orders for Monday warehouse processing.
// Also used as hardcoded INTERVAL in the matches query — keep in sync.
const MAX_MERGE_WINDOW_HOURS = 72;

let workerRunning = false;

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info', ctx?: Record<string, any>) {
  const prefix = '[MergeGroupQueue]';
  logger[level](`${prefix} ${msg}`, ctx || {});
}

function calculateBackoffMs(retryCount: number): number {
  return Math.min(EXPONENTIAL_BACKOFF_BASE_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS);
}

export async function enqueueMergeGroupEval(options: { shipmentId: string; orderNumber?: string }): Promise<number> {
  const [job] = await db.insert(mergeGroupQueue).values({
    shipmentId: options.shipmentId,
    orderNumber: options.orderNumber || null,
    status: 'queued',
    retryCount: 0,
    maxRetries: 5,
  }).returning({ id: mergeGroupQueue.id });

  log(`Enqueued merge group eval for shipment ${options.shipmentId}`, 'info', { shipmentId: options.shipmentId, orderNumber: options.orderNumber });
  return job.id;
}

export async function enqueueMergeGroupEvalIfNeeded(shipmentId: string, orderNumber?: string): Promise<boolean> {
  const [shipment] = await db
    .select({ mergeGroupId: shipments.mergeGroupId, mergeRole: shipments.mergeRole })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);

  if (!shipment) return false;

  if (shipment.mergeGroupId) {
    const [group] = await db
      .select({ state: mergeGroups.state })
      .from(mergeGroups)
      .where(eq(mergeGroups.id, shipment.mergeGroupId))
      .limit(1);

    if (group && ['merge_complete', 'all_sessioned'].includes(group.state)) {
      return false;
    }
  }

  const [existing] = await db
    .select({ id: mergeGroupQueue.id })
    .from(mergeGroupQueue)
    .where(and(
      eq(mergeGroupQueue.shipmentId, shipmentId),
      inArray(mergeGroupQueue.status, ['queued', 'processing'])
    ))
    .limit(1);

  if (existing) return false;

  await enqueueMergeGroupEval({ shipmentId, orderNumber });
  return true;
}

export async function getMergeGroupQueueStats(): Promise<{
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
}> {
  const results = await db
    .select({
      status: mergeGroupQueue.status,
      count: sql<number>`count(*)::int`,
    })
    .from(mergeGroupQueue)
    .groupBy(mergeGroupQueue.status);

  const stats = { queued: 0, processing: 0, completed: 0, failed: 0, deadLetter: 0 };
  for (const row of results) {
    if (row.status === 'queued') stats.queued = row.count;
    else if (row.status === 'processing') stats.processing = row.count;
    else if (row.status === 'completed') stats.completed = row.count;
    else if (row.status === 'failed') stats.failed = row.count;
    else if (row.status === 'dead_letter') stats.deadLetter = row.count;
  }
  return stats;
}

function buildGroupKey(shipment: Shipment): string | null {
  const email = shipment.shipToEmail?.toUpperCase();
  const address = shipment.shipToAddressLine1?.toUpperCase();
  const city = shipment.shipToCity?.toUpperCase();
  const state = shipment.shipToState?.toUpperCase();
  const zip = shipment.shipToPostalCode?.toUpperCase();

  if (!email || !address || !city || !state || !zip) return null;

  return `${email}|${address}|${city}|${state}|${zip}`;
}

function isSuperset(
  parentItems: Array<{ sku: string | null; quantity: number }>,
  allOriginalItems: Array<{ sku: string; quantity: number }>
): boolean {
  const required = new Map<string, number>();
  for (const item of allOriginalItems) {
    required.set(item.sku, (required.get(item.sku) || 0) + item.quantity);
  }

  const parentMap = new Map<string, number>();
  for (const item of parentItems) {
    if (item.sku) parentMap.set(item.sku, (parentMap.get(item.sku) || 0) + item.quantity);
  }

  for (const [sku, qty] of required) {
    if ((parentMap.get(sku) || 0) < qty) return false;
  }
  return true;
}

async function addMemberIfNew(groupId: number, shipment: Shipment): Promise<void> {
  const [existing] = await db
    .select({ id: mergeGroupMembers.id })
    .from(mergeGroupMembers)
    .where(eq(mergeGroupMembers.shipmentId, shipment.id))
    .limit(1);

  if (existing) return;

  const items = await db
    .select({ sku: shipmentItems.sku, quantity: shipmentItems.quantity })
    .from(shipmentItems)
    .where(eq(shipmentItems.shipmentId, shipment.id));

  const physicalItems = items.filter(i => i.sku !== null);

  await db.insert(mergeGroupMembers).values({
    mergeGroupId: groupId,
    shipmentId: shipment.id,
    orderNumber: shipment.orderNumber || '',
    role: 'undetermined',
    originalItemCount: physicalItems.length,
    originalItems: physicalItems.map(i => ({ sku: i.sku, quantity: i.quantity })),
  });

  await db.update(shipments)
    .set({ mergeGroupId: groupId, updatedAt: new Date() })
    .where(eq(shipments.id, shipment.id));

  await db.update(mergeGroups)
    .set({
      memberCount: sql`${mergeGroups.memberCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(mergeGroups.id, groupId));
}

async function deriveGroupState(groupId: number): Promise<void> {
  const [group] = await db.select().from(mergeGroups).where(eq(mergeGroups.id, groupId)).limit(1);
  if (!group || ['merge_complete', 'all_sessioned'].includes(group.state)) return;

  const members = await db.select().from(mergeGroupMembers)
    .where(eq(mergeGroupMembers.mergeGroupId, groupId));

  const memberData = await Promise.all(members.map(async (m) => {
    const currentItems = await db
      .select({ sku: shipmentItems.sku, quantity: shipmentItems.quantity })
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, m.shipmentId));

    const [shipment] = await db
      .select({ fulfillmentSessionId: shipments.fulfillmentSessionId })
      .from(shipments)
      .where(eq(shipments.id, m.shipmentId))
      .limit(1);

    return {
      member: m,
      currentItems: currentItems.filter(i => i.sku !== null),
      currentItemCount: currentItems.filter(i => i.sku !== null).length,
      hasSession: !!shipment?.fulfillmentSessionId,
    };
  }));

  if (memberData.every(d => d.hasSession)) {
    await db.update(mergeGroups).set({
      state: 'all_sessioned',
      closedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(mergeGroups.id, groupId));
    log(`Group ${groupId} → all_sessioned (all members have sessions)`);
    return;
  }

  let parentCandidate = null;
  for (const d of memberData) {
    if (d.currentItemCount > d.member.originalItemCount) {
      parentCandidate = d;
      break;
    }
  }

  if (!parentCandidate) return;

  const allOriginalItems: Array<{ sku: string; quantity: number }> = [];
  for (const d of memberData) {
    const originals = d.member.originalItems as Array<{ sku: string; quantity: number }>;
    allOriginalItems.push(...originals);
  }

  const isComplete = isSuperset(parentCandidate.currentItems, allOriginalItems);

  if (isComplete) {
    const now = new Date();

    await db.update(mergeGroups).set({
      state: 'merge_complete',
      parentShipmentId: parentCandidate.member.shipmentId,
      mergeCompleteAt: now,
      closedAt: now,
      updatedAt: now,
    }).where(eq(mergeGroups.id, groupId));

    for (const d of memberData) {
      const role = d.member.shipmentId === parentCandidate.member.shipmentId ? 'parent' : 'child';
      await db.update(mergeGroupMembers).set({ role, updatedAt: now })
        .where(eq(mergeGroupMembers.id, d.member.id));

      await db.update(shipments).set({ mergeRole: role, updatedAt: now })
        .where(eq(shipments.id, d.member.shipmentId));
    }

    log(`Group ${groupId} → merge_complete (parent: ${parentCandidate.member.orderNumber})`);

    const parentShipmentId = parentCandidate.member.shipmentId;
    const parentOrderNumber = parentCandidate.member.orderNumber;

    await db.delete(shipmentQcItems)
      .where(eq(shipmentQcItems.shipmentId, parentShipmentId));

    await db.update(shipments).set({
      fingerprintStatus: null,
      fingerprintId: null,
      packagingTypeId: null,
      rateCheckStatus: null,
      rateCheckError: null,
      rateCheckAttemptedAt: null,
      updatedAt: now,
    }).where(eq(shipments.id, parentShipmentId));

    log(`Reset parent ${parentOrderNumber} decision pipeline for re-hydration`);

    const { queueLifecycleEvaluation } = await import('./lifecycle-service');
    await queueLifecycleEvaluation(parentShipmentId, 'merge_parent_reset', parentOrderNumber);

    for (const d of memberData) {
      if (d.member.shipmentId !== parentCandidate.member.shipmentId) {
        await queueLifecycleEvaluation(d.member.shipmentId, 'merge_child', d.member.orderNumber);
      }
    }
  } else {
    await db.update(mergeGroups).set({
      state: 'merge_started',
      parentShipmentId: parentCandidate.member.shipmentId,
      mergeStartedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(mergeGroups.id, groupId));

    await db.update(mergeGroupMembers).set({ role: 'parent', updatedAt: new Date() })
      .where(eq(mergeGroupMembers.id, parentCandidate.member.id));

    for (const d of memberData) {
      if (d.member.shipmentId !== parentCandidate.member.shipmentId) {
        await db.update(mergeGroupMembers).set({ role: 'child', updatedAt: new Date() })
          .where(eq(mergeGroupMembers.id, d.member.id));
      }
    }

    log(`Group ${groupId} → merge_started (parent candidate: ${parentCandidate.member.orderNumber})`);

    if (group.state === 'detected') {
      const parentShipmentId = parentCandidate.member.shipmentId;
      const parentOrderNumber = parentCandidate.member.orderNumber;

      await db.delete(shipmentQcItems)
        .where(eq(shipmentQcItems.shipmentId, parentShipmentId));

      await db.update(shipments).set({
        fingerprintStatus: null,
        fingerprintId: null,
        packagingTypeId: null,
        assignedStationId: null,
        rateCheckStatus: null,
        rateCheckError: null,
        rateCheckAttemptedAt: null,
        updatedAt: new Date(),
      }).where(eq(shipments.id, parentShipmentId));

      log(`Reset parent ${parentOrderNumber} decision pipeline for re-hydration (merge_started)`);

      const { queueLifecycleEvaluation } = await import('./lifecycle-service');
      await queueLifecycleEvaluation(parentShipmentId, 'merge_parent_reset', parentOrderNumber);
    }
  }
}

async function evaluateMergeGroup(triggerShipmentId: string): Promise<void> {
  const [trigger] = await db.select().from(shipments)
    .where(eq(shipments.id, triggerShipmentId)).limit(1);
  if (!trigger) return;

  if (trigger.lifecyclePhase && !MERGEABLE_PHASES.includes(trigger.lifecyclePhase)) return;

  let groupId = trigger.mergeGroupId;
  if (groupId) {
    const [group] = await db.select().from(mergeGroups)
      .where(eq(mergeGroups.id, groupId)).limit(1);
    if (group && ['merge_complete', 'all_sessioned'].includes(group.state)) return;
    if (group) {
      await deriveGroupState(group.id);
      return;
    }
  }

  const key = buildGroupKey(trigger);
  if (!key) return;

  const [existingGroup] = await db.select().from(mergeGroups)
    .where(and(
      eq(mergeGroups.groupKey, key),
      notInArray(mergeGroups.state, ['merge_complete', 'all_sessioned'])
    )).limit(1);

  if (existingGroup) {
    // Time boundary: don't add orders to groups detected more than MAX_MERGE_WINDOW_HOURS ago.
    // Prevents repeat customers' historical orders from inflating the group.
    const hoursSinceDetection = (Date.now() - new Date(existingGroup.detectedAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceDetection > MAX_MERGE_WINDOW_HOURS) {
      log(`Skipping add to group ${existingGroup.id} — detected ${hoursSinceDetection.toFixed(1)}h ago, exceeds ${MAX_MERGE_WINDOW_HOURS}h window`, 'info', { groupId: existingGroup.id, triggerShipmentId });
      return;
    }
    await addMemberIfNew(existingGroup.id, trigger);
    await deriveGroupState(existingGroup.id);
    return;
  }

  const matches = await db.select().from(shipments)
    .where(and(
      sql`UPPER(${shipments.shipToEmail}) = ${trigger.shipToEmail?.toUpperCase()}`,
      sql`UPPER(${shipments.shipToAddressLine1}) = ${trigger.shipToAddressLine1?.toUpperCase()}`,
      sql`UPPER(${shipments.shipToCity}) = ${trigger.shipToCity?.toUpperCase()}`,
      sql`UPPER(${shipments.shipToState}) = ${trigger.shipToState?.toUpperCase()}`,
      sql`UPPER(${shipments.shipToPostalCode}) = ${trigger.shipToPostalCode?.toUpperCase()}`,
      ne(shipments.id, triggerShipmentId),
      or(
        isNull(shipments.lifecyclePhase),
        inArray(shipments.lifecyclePhase, MERGEABLE_PHASES)
      ),
      or(
        isNull(shipments.mergeGroupId),
        inArray(shipments.mergeGroupId,
          db.select({ id: mergeGroups.id }).from(mergeGroups)
            .where(notInArray(mergeGroups.state, ['merge_complete', 'all_sessioned']))
        )
      ),
      // Time boundary: only group orders placed within MAX_MERGE_WINDOW_HOURS (72h) of each other.
      // Covers Fri–Sun weekend orders for Monday processing.
      // Uses hardcoded INTERVAL to avoid sql.raw() — keep in sync with MAX_MERGE_WINDOW_HOURS constant.
      sql`${shipments.orderDate} > ${trigger.orderDate}::timestamptz - INTERVAL '72 hours'`,
      sql`${shipments.orderDate} < ${trigger.orderDate}::timestamptz + INTERVAL '72 hours'`,
    ));

  if (matches.length === 0) return;

  let newGroup;
  try {
    [newGroup] = await db.insert(mergeGroups).values({
      groupKey: key,
      state: 'detected',
      memberCount: matches.length + 1,
      matchEmail: trigger.shipToEmail?.toUpperCase() || '',
      matchAddress: trigger.shipToAddressLine1?.toUpperCase() || '',
      matchCity: trigger.shipToCity?.toUpperCase() || '',
      matchState: trigger.shipToState?.toUpperCase() || '',
      matchZip: trigger.shipToPostalCode?.toUpperCase() || '',
    }).returning();
  } catch (err: any) {
    if (err.code === '23505') {
      const [existing] = await db.select().from(mergeGroups)
        .where(eq(mergeGroups.groupKey, key)).limit(1);
      if (existing) {
        await addMemberIfNew(existing.id, trigger);
        await deriveGroupState(existing.id);
        return;
      }
    }
    throw err;
  }

  const allShipments = [trigger, ...matches];
  for (const s of allShipments) {
    const items = await db
      .select({ sku: shipmentItems.sku, quantity: shipmentItems.quantity })
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, s.id));

    const physicalItems = items.filter(i => i.sku !== null);

    await db.insert(mergeGroupMembers).values({
      mergeGroupId: newGroup.id,
      shipmentId: s.id,
      orderNumber: s.orderNumber || '',
      role: 'undetermined',
      originalItemCount: physicalItems.length,
      originalItems: physicalItems.map(i => ({ sku: i.sku, quantity: i.quantity })),
    });

    await db.update(shipments)
      .set({ mergeGroupId: newGroup.id, updatedAt: new Date() })
      .where(eq(shipments.id, s.id));
  }

  log(`Created merge group ${newGroup.id} with ${allShipments.length} members (key: ${key})`);

  await deriveGroupState(newGroup.id);
}

async function processNextJob(): Promise<boolean> {
  const jobs = await db.select().from(mergeGroupQueue)
    .where(or(
      eq(mergeGroupQueue.status, 'queued'),
      and(
        eq(mergeGroupQueue.status, 'failed'),
        lte(mergeGroupQueue.nextRetryAt, new Date())
      )
    ))
    .orderBy(asc(mergeGroupQueue.createdAt))
    .limit(1);

  if (!jobs.length) return false;

  const job = jobs[0];

  await db.update(mergeGroupQueue)
    .set({ status: 'processing', processedAt: new Date() })
    .where(eq(mergeGroupQueue.id, job.id));

  try {
    await evaluateMergeGroup(job.shipmentId);

    await db.update(mergeGroupQueue)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(mergeGroupQueue.id, job.id));
    return true;
  } catch (error: any) {
    const retryCount = job.retryCount + 1;
    if (retryCount >= job.maxRetries) {
      await db.update(mergeGroupQueue)
        .set({ status: 'dead_letter', lastError: error.message, retryCount })
        .where(eq(mergeGroupQueue.id, job.id));
      log(`Job ${job.id} dead-lettered after ${retryCount} retries: ${error.message}`, 'error', { shipmentId: job.shipmentId });
    } else {
      const backoff = calculateBackoffMs(retryCount);
      await db.update(mergeGroupQueue)
        .set({
          status: 'failed',
          lastError: error.message,
          retryCount,
          nextRetryAt: new Date(Date.now() + backoff),
        })
        .where(eq(mergeGroupQueue.id, job.id));
      log(`Job ${job.id} failed (retry ${retryCount}/${job.maxRetries}): ${error.message}`, 'warn', { shipmentId: job.shipmentId });
    }
    return true;
  }
}

async function recoverStaleProcessingJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const result = await db.update(mergeGroupQueue)
    .set({ status: 'queued', lastError: 'Recovered from stale processing state (server restart)' })
    .where(
      and(
        eq(mergeGroupQueue.status, 'processing'),
        lte(mergeGroupQueue.processedAt, staleThreshold)
      )
    )
    .returning({ id: mergeGroupQueue.id });

  if (result.length > 0) {
    log(`Recovered ${result.length} stale processing jobs back to queued`);
  }
  return result.length;
}

async function pollLoop(): Promise<void> {
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

export function startMergeGroupQueueWorker(): void {
  if (workerRunning) {
    log('Worker already running, skipping');
    return;
  }

  workerRunning = true;
  log('Starting merge group queue worker');

  recoverStaleProcessingJobs().then(() => {
    pollLoop();
  }).catch(err => {
    log(`Failed to start worker: ${err.message}`, 'error');
    workerRunning = false;
  });
}

export function stopMergeGroupQueueWorker(): void {
  log('Stopping merge group queue worker');
  workerRunning = false;
}
