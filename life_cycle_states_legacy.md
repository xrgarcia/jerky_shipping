# Lifecycle States - Legacy Implementation

This document describes the **legacy SQL-based tab criteria** that was used before switching to the lifecycle state machine. The old approach duplicated query conditions across multiple functions (`getShipmentTabCounts`, `getLifecycleTabCounts`) and didn't track decision subphases.

## Current Lifecycle Hierarchy

```
ready_to_fulfill → ready_to_session → awaiting_decisions → ready_to_pick → picking → packing_ready → on_dock
                                                                       ↘ picking_issues (exception path)
```

- **ready_to_fulfill**: On hold + MOVE OVER tag (waiting to be released from ShipStation hold)
- **ready_to_session**: Pending + MOVE OVER tag (released, ready for fingerprinting & sessioning)

## Legacy Tab Criteria

### Top-Level Tabs (`getShipmentTabCounts`)

| Tab | Legacy SQL Criteria |
|-----|---------------------|
| **Ready to Fulfill** | `shipmentStatus='on_hold'` + `MOVE OVER` tag + `sessionStatus IS NULL` + `status != 'cancelled'` |
| **Ready to Session** | `shipmentStatus='pending'` + `MOVE OVER` tag + `sessionStatus IS NULL` + `status != 'cancelled'` |
| **In Progress** | `sessionStatus='new'` OR `sessionStatus='active'` OR (`sessionStatus='closed'` + `trackingNumber IS NULL` + `shipmentStatus='pending'` + `status != 'cancelled'`) |
| **Shipped** | `shipmentStatus='label_purchased'` + `status='IT'` (In Transit) |
| **All** | Total count of all shipments |

### Lifecycle Tabs (`getLifecycleTabCounts`)

| Tab | Legacy SQL Criteria |
|-----|---------------------|
| **Ready to Fulfill** | `shipmentStatus='on_hold'` + `MOVE OVER` tag + `sessionStatus IS NULL` + `status != 'cancelled'` |
| **Ready to Session** | `shipmentStatus='pending'` + `MOVE OVER` tag + `sessionStatus IS NULL` + `status != 'cancelled'` |
| **Ready to Pick** | `sessionStatus='new'` + `trackingNumber IS NULL` |
| **Picking** | `sessionStatus='active'` + `trackingNumber IS NULL` |
| **Packing Ready** | `sessionStatus='closed'` + `trackingNumber IS NULL` + `shipmentStatus='pending'` + `status != 'cancelled'` |
| **On Dock** | `shipmentStatus='label_purchased'` + `status='AC'` (Accepted by carrier) |
| **Picking Issues** | `sessionStatus='inactive'` + `trackingNumber IS NULL` |

---

## Comparison: Legacy vs Current State Machine

### Key Differences

| Aspect | Legacy (SQL Queries) | Current (State Machine) |
|--------|---------------------|------------------------|
| **Source of Truth** | Duplicated SQL conditions in `storage.ts` | Single `lifecycle_phase` column computed by state machine |
| **On Hold vs Pending** | Both mixed into "Ready to Session" | Separated: `ready_to_fulfill` (on_hold) → `ready_to_session` (pending) |
| **Decision Tracking** | No subphases - orders just "ready" or not | Subphases track progression: `needs_categorization` → `needs_fingerprint` → `needs_packaging` → `needs_session` → ready_for_skuvault phase |
| **On Dock Detection** | Only `status='AC'` (Accepted) | Both `NY` (Not Yet) and `AC` (Accepted) statuses |
| **Packing Ready** | Required explicit `status != 'cancelled'` check | Relies on `sessionStatus='closed'` + `shipmentStatus='pending'` |
| **Tab Count Queries** | Each query duplicated full logic | Queries filter by `lifecycle_phase` column directly |

### Ready to Fulfill vs Ready to Session - Detailed Comparison

**Current State Machine - Ready to Fulfill (NEW):**
```typescript
// On hold + MOVE OVER tag - waiting to be released from ShipStation hold
if (shipment.shipmentStatus === 'on_hold' && 
    shipment.hasMoveOverTag === true && 
    !shipment.sessionStatus &&
    shipment.status !== 'cancelled') {
  return { phase: LIFECYCLE_PHASES.READY_TO_FULFILL, subphase };
}
```

**Current State Machine - Ready to Session:**
```typescript
// Pending + MOVE OVER tag - released, ready for fingerprinting & sessioning
if (shipment.shipmentStatus === 'pending' && 
    shipment.hasMoveOverTag === true && 
    !shipment.sessionStatus &&
    shipment.status !== 'cancelled') {
  return { phase: LIFECYCLE_PHASES.READY_TO_SESSION, subphase };
}
```

**Why Changed:** 
- `on_hold` is the status BEFORE fulfillment starts (orders waiting in ShipStation queue)
- `pending` is when orders are actually ready to be sessioned and processed
- Now we have two distinct phases: `ready_to_fulfill` for on_hold orders, `ready_to_session` for pending orders

### Decision Subphases (New in State Machine)

The state machine introduces subphases within `READY_TO_SESSION` and `AWAITING_DECISIONS` phases:

| Subphase | Criteria | Next Step |
|----------|----------|-----------|
| `needs_categorization` | No fingerprint status set | Categorize order type |
| `needs_fingerprint` | No fingerprint assigned | Match to existing fingerprint |
| `needs_packaging` | Has fingerprint, no packaging | Assign packaging type |
| `needs_session` | Has packaging, not in session | Ready for session building (terminal subphase) |

### On Dock Status Detection

**Legacy:** Only detected `status='AC'` (Accepted by carrier)

**Current:** Detects both:
- `NY` = Not Yet in System (label printed, waiting for carrier pickup)
- `AC` = Accepted by Carrier (carrier just picked it up)

Once status changes to `IT` (In Transit) or `DE` (Delivered), the order is considered past the dock phase.

---

## Migration Notes

The current system stores `lifecycle_phase` and `decision_subphase` directly on shipments. Tab counts now query this column instead of recomputing conditions:

```typescript
// Current approach - simple column filter
const readyToSessionResult = await db
  .select({ count: count() })
  .from(shipments)
  .where(eq(shipments.lifecyclePhase, 'ready_to_session'));
```

Benefits:
1. **Single source of truth** - State machine logic in one place
2. **Consistent calculations** - All parts of app use same derived state
3. **Decision tracking** - Subphases show where orders are stuck
4. **Easier debugging** - Can query lifecycle columns directly
