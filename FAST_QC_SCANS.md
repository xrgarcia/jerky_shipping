# Fast QC Scans Implementation Plan

## Overview

This document outlines the implementation plan for decoupling QC (Quality Control) scan validation from SkuVault API calls. The goal is to make product scans instantaneous by validating locally against cached data, then asynchronously syncing with SkuVault in the background.

## Problem Statement

### Current Flow (Synchronous)
When a warehouse worker scans a product barcode during packing:

```
Worker scans barcode
    ↓
Client calls POST /api/packing/qc-scan
    ↓
Server calls SkuVault getQCSalesByOrderNumber (if not cached)
    ↓
Server calls SkuVault passQCItem/passKitSaleItem ← BLOCKING
    ↓
Worker waits 200-2000ms for response
    ↓
Server inserts packing_log
    ↓
Server inserts shipment_event
    ↓
Server updates Redis cache
    ↓
Client shows success/failure
```

### Problems with Current Approach
1. **Latency**: Every scan waits for SkuVault API response (200-2000ms)
2. **Fragility**: SkuVault API issues block packing operations
3. **Wasted Resources**: Cache already has all data needed for validation
4. **Poor UX**: Workers experience variable response times

## Proposed Architecture

### New Flow (Local Validation + Async Sync)

```
Worker scans barcode
    ↓
Client calls POST /api/packing/qc-scan
    ↓
Server validates locally against cached lookupMap ← INSTANT
    ↓
[SINGLE DB TRANSACTION]
├── Insert packing_log
├── Insert shipment_event  
├── Insert qc_sync_outbox entry (passQCItem payload)
└── COMMIT
    ↓
Server updates Redis cache (scanned counts)
    ↓
Client shows success (~10-50ms total)
    ↓
[ASYNC - Worker Process]
├── Poll qc_sync_outbox for pending jobs
├── Call SkuVault passQCItem/passKitSaleItem
├── Retry with exponential backoff on failure
├── Mark outbox entry complete
└── Alert on exhausted retries
```

### Key Benefits
1. **Near-instant scans**: Validation is local, no network latency
2. **Fault tolerance**: SkuVault outages don't block packing
3. **Data integrity**: Transactional outbox guarantees no job loss
4. **Audit trail**: All operations logged before async sync
5. **Eventual consistency**: SkuVault always syncs, just not synchronously

## Data Model

### Existing Tables Used

#### packing_logs
Canonical audit trail for all packing actions.
```sql
packing_logs (
  id                    varchar PK
  user_id               varchar NOT NULL → users.id
  shipment_id           varchar NOT NULL → shipments.id
  order_number          text NOT NULL
  action                text NOT NULL  -- 'scan_order', 'scan_product', 'qc_pass', 'qc_fail', 'complete_order'
  product_sku           text           -- SKU scanned
  scanned_code          text           -- Actual barcode value
  skuvault_product_id   text           -- IdItem from SkuVault
  success               boolean NOT NULL
  error_message         text
  skuvault_raw_response jsonb          -- Full response for debugging
  created_at            timestamp NOT NULL DEFAULT now()
)
```

#### shipment_events
Shipment lifecycle events for dashboards and analytics.
```sql
shipment_events (
  id            varchar PK
  occurred_at   timestamp NOT NULL DEFAULT now()
  username      text NOT NULL      -- Email of user
  station       text NOT NULL      -- "packing", "bagging"
  station_id    text               -- UUID of workstation
  event_name    text NOT NULL      -- "order_scanned", "product_scan_success", "packing_completed"
  order_number  text               -- Links to shipments.order_number
  metadata      jsonb              -- Event-specific details
  skuvault_import boolean DEFAULT false
)
```

### New Table: qc_sync_outbox

Transactional outbox for guaranteed SkuVault passQCItem delivery.

```sql
CREATE TABLE qc_sync_outbox (
  id              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number    text NOT NULL,
  packing_log_id  varchar NOT NULL REFERENCES packing_logs(id),
  
  -- SkuVault passQCItem payload
  payload         jsonb NOT NULL,
  -- {
  --   type: 'passQCItem' | 'passKitSaleItem',
  --   IdSale: string,
  --   IdItem: string,
  --   Quantity: number,
  --   Sku: string,
  --   ScannedCode: string,
  --   KitId?: string  -- Only for kit components
  -- }
  
  -- Processing state
  status          text NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  last_attempt_at timestamp,
  next_attempt_at timestamp,          -- For backoff scheduling
  error_message   text,               -- Last error
  completed_at    timestamp,
  
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE INDEX qc_sync_outbox_status_next_attempt_idx 
  ON qc_sync_outbox(status, next_attempt_at) 
  WHERE status IN ('pending', 'failed');
  
CREATE INDEX qc_sync_outbox_order_number_idx 
  ON qc_sync_outbox(order_number);
```

### Cache Structure (Redis)

The QCSale cache already stores the necessary data:

```typescript
interface CachedQCSaleData {
  saleId: string;
  orderNumber: string;
  cachedAt: number;
  warmedAt: number;
  
  // Barcode → Item lookup for instant validation
  lookupMap: Record<string, {
    found: boolean;
    sku: string;
    code: string | null;
    title: string | null;
    quantity: number;           // Expected quantity
    itemId: string | null;
    saleId: string;
    isKitComponent: boolean;
    kitId?: string | null;
    kitSku?: string | null;
  }>;
  
  // Full QCSale for tracking progress
  qcSale: {
    SaleId: string;
    TotalItems: number;
    PassedItems: PassedItem[];  // Track what's been scanned
    Items: QCItem[];            // Expected items
  };
  
  // Shipment data (to avoid DB query)
  shipment: { ... } | null;
}
```

**Scanned Counts: Computed from PassedItems (No New Cache Field Needed)**

The existing `qcSale.PassedItems` array already tracks what has been scanned. Scanned counts are **computed on-demand** by aggregating this array:

```typescript
// Compute scanned counts from PassedItems (no separate storage needed)
function computeScannedCounts(passedItems: PassedItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of passedItems) {
    const sku = item.Sku.toUpperCase();
    counts[sku] = (counts[sku] || 0) + (item.Quantity || 1);
  }
  return counts;
}

// Usage in local validation
const scannedCounts = computeScannedCounts(cacheData.qcSale.PassedItems);
const currentCount = scannedCounts[lookupResult.sku.toUpperCase()] || 0;
const expectedQuantity = lookupResult.quantity;

if (currentCount >= expectedQuantity) {
  return { valid: false, errorCode: 'OVER_SCAN', ... };
}
```

**After a successful local validation**, we add to `PassedItems` via the existing `updateCacheAfterScan()` function (already implemented in `qcsale-cache-warmer.ts`). This keeps the cache consistent with what we're reporting to SkuVault.

**Order Completion Check:**
```typescript
function isOrderComplete(cacheData: CachedQCSaleData): boolean {
  const scannedCounts = computeScannedCounts(cacheData.qcSale.PassedItems);
  
  for (const item of cacheData.qcSale.Items) {
    const sku = item.Sku.toUpperCase();
    const expected = item.Quantity || 1;
    const scanned = scannedCounts[sku] || 0;
    
    if (scanned < expected) {
      return false;
    }
  }
  return true;
}
```

**Why compute vs store separately?**
- Single source of truth: `PassedItems` is authoritative
- No sync issues between two separate data structures
- `updateCacheAfterScan()` already maintains `PassedItems` atomically
- Computation is O(n) where n is number of passed items (typically <50), negligible overhead

## Implementation Steps

### Phase 1: Database Schema (Migration)

**File: `server/db/migrations/add_qc_sync_outbox.sql`**

1. Create the `qc_sync_outbox` table with schema above
2. Add indexes for efficient polling
3. Run migration via Drizzle Kit

**Drizzle Schema (shared/schema.ts):**
```typescript
export const qcSyncOutbox = pgTable("qc_sync_outbox", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderNumber: text("order_number").notNull(),
  packingLogId: varchar("packing_log_id").notNull().references(() => packingLogs.id),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at"),
  errorMessage: text("error_message"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  statusNextAttemptIdx: index("qc_sync_outbox_status_next_attempt_idx")
    .on(table.status, table.nextAttemptAt),
  orderNumberIdx: index("qc_sync_outbox_order_number_idx")
    .on(table.orderNumber),
}));
```

### Phase 2: Local Validation Service

**File: `server/services/local-qc-validator.ts`**

Create a service that validates scans against cached data:

```typescript
interface LocalValidationResult {
  valid: boolean;
  sku: string;
  itemId: string | null;
  saleId: string;
  quantity: number;
  isKitComponent: boolean;
  kitId: string | null;
  scannedCount: number;      // How many of this item already scanned
  expectedQuantity: number;  // How many needed
  error?: string;
  errorCode?: 'NOT_FOUND' | 'OVER_SCAN' | 'CACHE_MISS' | 'ORDER_NOT_READY';
}

export async function validateScanLocally(
  orderNumber: string,
  scannedCode: string
): Promise<LocalValidationResult>;

export async function incrementScannedCount(
  orderNumber: string,
  sku: string,
  quantity: number
): Promise<void>;

export async function getOrderProgress(
  orderNumber: string
): Promise<{
  totalItems: number;
  scannedItems: number;
  isComplete: boolean;
  itemProgress: Record<string, { scanned: number; expected: number }>;
}>;
```

**Implementation details:**
1. Fetch cache from Redis using `getWarmCacheKey(orderNumber)`
2. Look up scanned code in `lookupMap`
3. Check `scannedCounts[sku]` against `expectedQuantity`
4. Return validation result without any SkuVault API call

### Phase 3: Cache Update (Using Existing Function)

**File: `server/services/qcsale-cache-warmer.ts`**

**No new cache field needed.** The existing `updateCacheAfterScan()` function already:
1. Adds a new entry to `qcSale.PassedItems`
2. Updates the `cachedAt` timestamp
3. Saves back to Redis

After local validation succeeds, we call:
```typescript
await updateCacheAfterScan({
  orderNumber,
  sku: validation.sku,
  code: validation.code,
  scannedCode,
  quantity: 1,
  itemId: validation.itemId,
  kitId: validation.kitId,
  userName: userEmail,
});
```

**New helper functions to add (using existing PassedItems):**
```typescript
// Compute scanned counts from existing PassedItems array
export function computeScannedCounts(
  passedItems: PassedItem[]
): Record<string, number>;

// Check if all items have been scanned
export async function isOrderComplete(orderNumber: string): Promise<boolean>;

// Get detailed progress for UI
export async function getOrderProgress(orderNumber: string): Promise<{
  totalItems: number;
  scannedItems: number;
  isComplete: boolean;
  itemProgress: Record<string, { scanned: number; expected: number }>;
}>;
```

### Phase 4: Outbox Writer Service

**File: `server/services/qc-outbox.ts`**

Service to write to the transactional outbox:

```typescript
interface QCSyncJob {
  type: 'passQCItem' | 'passKitSaleItem';
  IdSale: string;
  IdItem: string;
  Quantity: number;
  Sku: string;
  ScannedCode: string;
  KitId?: string;
}

export async function enqueueQCSync(
  orderNumber: string,
  packingLogId: string,
  payload: QCSyncJob
): Promise<string>;  // Returns outbox entry ID
```

### Phase 5: Refactor Scan API Endpoint

**File: `server/routes.ts`**

Refactor `POST /api/packing/qc-scan` to use local validation:

```typescript
app.post("/api/packing/qc-scan", requireAuth, async (req, res) => {
  const { orderNumber, scannedCode, stationId, stationType } = req.body;
  const userEmail = req.user.email;
  
  // 1. LOCAL VALIDATION (instant)
  const validation = await validateScanLocally(orderNumber, scannedCode);
  
  if (!validation.valid) {
    // Log failed scan attempt
    await insertPackingLog({ ... , success: false, error: validation.error });
    return res.status(400).json({ 
      success: false, 
      error: validation.errorCode,
      message: validation.error 
    });
  }
  
  // 2. TRANSACTIONAL WRITE (all-or-nothing)
  const result = await db.transaction(async (tx) => {
    // Insert packing log
    const [packingLog] = await tx.insert(packingLogs).values({
      userId: req.user.id,
      shipmentId: validation.shipmentId,
      orderNumber,
      action: 'qc_pass',
      productSku: validation.sku,
      scannedCode,
      skuVaultProductId: validation.itemId,
      success: true,
    }).returning();
    
    // Insert shipment event
    await tx.insert(shipmentEvents).values({
      username: userEmail,
      station: stationType || 'packing',
      stationId,
      eventName: 'product_scan_success',
      orderNumber,
      metadata: { sku: validation.sku, itemId: validation.itemId },
    });
    
    // Insert outbox entry for async SkuVault sync
    await tx.insert(qcSyncOutbox).values({
      orderNumber,
      packingLogId: packingLog.id,
      payload: {
        type: validation.isKitComponent ? 'passKitSaleItem' : 'passQCItem',
        IdSale: validation.saleId,
        IdItem: validation.itemId,
        Quantity: 1,
        Sku: validation.sku,
        ScannedCode: scannedCode,
        KitId: validation.kitId,
      },
      status: 'pending',
      nextAttemptAt: new Date(), // Process immediately
    });
    
    return packingLog;
  });
  
  // 3. UPDATE CACHE (outside transaction - non-critical)
  await incrementScannedCount(orderNumber, validation.sku, 1);
  
  // 4. CHECK COMPLETION
  const progress = await getOrderProgress(orderNumber);
  
  // 5. RETURN SUCCESS (instant response)
  return res.json({
    success: true,
    sku: validation.sku,
    scannedCount: validation.scannedCount + 1,
    expectedQuantity: validation.expectedQuantity,
    orderProgress: progress,
  });
});
```

### Phase 6: Outbox Worker

**File: `server/workers/qc-sync-worker.ts`**

Background worker to process the outbox:

```typescript
const POLL_INTERVAL_MS = 1000;  // Check every second
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2000;   // 2s, 4s, 8s, 16s, 32s

async function processOutbox(): Promise<void> {
  // Fetch pending jobs ready for processing
  const jobs = await db.select()
    .from(qcSyncOutbox)
    .where(and(
      inArray(qcSyncOutbox.status, ['pending', 'failed']),
      or(
        isNull(qcSyncOutbox.nextAttemptAt),
        lte(qcSyncOutbox.nextAttemptAt, new Date())
      ),
      lt(qcSyncOutbox.attempts, qcSyncOutbox.maxAttempts)
    ))
    .limit(10)
    .for('update', { skipLocked: true });
  
  for (const job of jobs) {
    await processJob(job);
  }
}

async function processJob(job: QcSyncOutboxRow): Promise<void> {
  const payload = job.payload as QCSyncJob;
  
  try {
    // Call SkuVault API
    let result;
    if (payload.type === 'passKitSaleItem') {
      result = await skuVaultService.passKitSaleItem({
        KitId: payload.KitId,
        IdSale: payload.IdSale,
        Quantity: payload.Quantity,
        Sku: payload.Sku,
        ScannedCode: payload.ScannedCode,
      });
    } else {
      result = await skuVaultService.passQCItem({
        IdItem: payload.IdItem,
        IdSale: payload.IdSale,
        Quantity: payload.Quantity,
        Sku: payload.Sku,
        ScannedCode: payload.ScannedCode,
      });
    }
    
    if (result.Success) {
      // Mark completed
      await db.update(qcSyncOutbox)
        .set({ 
          status: 'completed', 
          completedAt: new Date(),
          attempts: job.attempts + 1,
          lastAttemptAt: new Date(),
        })
        .where(eq(qcSyncOutbox.id, job.id));
    } else {
      throw new Error(result.Errors?.join(', ') || 'Unknown SkuVault error');
    }
  } catch (error) {
    const newAttempts = job.attempts + 1;
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, newAttempts - 1);
    
    if (newAttempts >= MAX_ATTEMPTS) {
      // Exhausted retries - mark as failed, alert
      await db.update(qcSyncOutbox)
        .set({
          status: 'failed',
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          errorMessage: error.message,
        })
        .where(eq(qcSyncOutbox.id, job.id));
      
      // TODO: Alert via WebSocket/Slack
      console.error(`[QCSyncWorker] EXHAUSTED: Order ${job.orderNumber} failed after ${MAX_ATTEMPTS} attempts`);
    } else {
      // Schedule retry with backoff
      await db.update(qcSyncOutbox)
        .set({
          status: 'failed',
          attempts: newAttempts,
          lastAttemptAt: new Date(),
          nextAttemptAt: new Date(Date.now() + backoffMs),
          errorMessage: error.message,
        })
        .where(eq(qcSyncOutbox.id, job.id));
    }
  }
}

// Start worker loop
export function startQCSyncWorker(): void {
  setInterval(processOutbox, POLL_INTERVAL_MS);
  console.log('[QCSyncWorker] Started polling for QC sync jobs');
}
```

### Phase 7: Frontend Updates

**Files: `client/src/pages/packing.tsx`, `client/src/pages/bagging.tsx`**

Minimal changes needed - the API response format stays similar:

1. Remove any loading spinners that wait for "syncing with SkuVault"
2. Add optional status indicator for background sync (nice-to-have)
3. Handle new error codes from local validation

```typescript
// Example: Show sync status indicator
const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'error'>('synced');

// After successful scan
setSyncStatus('syncing');

// Listen for WebSocket confirmation (optional)
useEffect(() => {
  ws.on('qc_sync_complete', (data) => {
    if (data.orderNumber === currentOrder) {
      setSyncStatus('synced');
    }
  });
}, []);
```

### Phase 8: Monitoring & Observability

**File: `server/routes.ts` (new endpoint)**

Add endpoint for monitoring outbox health:

```typescript
app.get("/api/operations/qc-sync-status", requireAuth, async (req, res) => {
  const stats = await db.select({
    status: qcSyncOutbox.status,
    count: sql<number>`count(*)`,
  })
  .from(qcSyncOutbox)
  .groupBy(qcSyncOutbox.status);
  
  const oldestPending = await db.select()
    .from(qcSyncOutbox)
    .where(eq(qcSyncOutbox.status, 'pending'))
    .orderBy(qcSyncOutbox.createdAt)
    .limit(1);
  
  return res.json({
    stats: Object.fromEntries(stats.map(s => [s.status, s.count])),
    oldestPending: oldestPending[0]?.createdAt || null,
    healthy: stats.find(s => s.status === 'failed')?.count === 0,
  });
});
```

## Rollout Plan

### Phase 1: Shadow Mode (Low Risk)
1. Deploy outbox table and worker
2. Continue using synchronous SkuVault calls
3. ALSO write to outbox for comparison
4. Compare outbox results with synchronous results
5. Validate data consistency

### Phase 2: Async Mode (Feature Flag)
1. Add feature flag `FAST_QC_SCANS_ENABLED`
2. When enabled, use local validation + async sync
3. Roll out to one station first
4. Monitor for issues
5. Gradually expand

### Phase 3: Full Rollout
1. Enable for all stations
2. Remove synchronous code path
3. Monitor outbox queue depth
4. Set up alerts for failed syncs

## Error Handling

### Local Validation Errors

| Error Code | Meaning | User Message |
|------------|---------|--------------|
| `CACHE_MISS` | Order not in cache | "Loading order data..." (auto-warm) |
| `NOT_FOUND` | Barcode not recognized | "Product not found. Check barcode." |
| `OVER_SCAN` | Already scanned enough | "Already scanned 3 of 3" |
| `ORDER_NOT_READY` | Session not closed yet | "Order still being picked" |

### Async Sync Failures

If SkuVault sync fails after max retries:
1. Log to `qc_sync_outbox` with status='failed'
2. Alert operations team (Slack/email)
3. Order is still packable (our records are source of truth)
4. Manual intervention to fix SkuVault if needed

## Testing Checklist

- [ ] Local validation returns correct results for regular items
- [ ] Local validation returns correct results for kit components
- [ ] Over-scan protection works correctly
- [ ] Cache scanned counts persist across page reloads
- [ ] Outbox entries are created in same transaction as logs
- [ ] Worker processes pending entries within 5 seconds
- [ ] Worker retries with backoff on failure
- [ ] Worker marks exhausted entries as failed
- [ ] Frontend shows instant feedback
- [ ] Order completion detection works correctly
- [ ] Monitoring endpoint shows accurate stats

## Files to Create/Modify

### New Files
- `server/db/migrations/XXXX_add_qc_sync_outbox.sql`
- `server/services/local-qc-validator.ts`
- `server/services/qc-outbox.ts`
- `server/workers/qc-sync-worker.ts`

### Modified Files
- `shared/schema.ts` - Add qcSyncOutbox table
- `server/services/qcsale-cache-warmer.ts` - Add scannedCounts tracking
- `server/routes.ts` - Refactor /api/packing/qc-scan endpoint
- `server/index.ts` - Start QC sync worker
- `client/src/pages/packing.tsx` - Optional sync status UI
- `client/src/pages/bagging.tsx` - Optional sync status UI

## Success Metrics

1. **Scan latency**: Target <50ms (currently 200-2000ms)
2. **Sync success rate**: >99.9% of outbox entries complete successfully
3. **Sync delay**: 95% of syncs complete within 5 seconds
4. **Zero blocked operations**: SkuVault outages don't stop packing
