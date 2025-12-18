# Ship. Smart Shipping Engine — Current Feature Under Development

## Feature Overview

**Ship.** is an intelligent decision layer that sits upstream of ShipStation and SkuVault. It automatically decides packaging, carrier/service, and packing station routing for every order before it enters the picking phase.

Today, managers manually make these decisions in SkuVault and have to understand complex rules about packaging, shipping costs, and physical station capacity. Ship. eliminates this by learning from decisions and automating the entire workflow.

**Business Impact:**
- Consistent shipping decisions (no tribal knowledge)
- Faster fulfillment (optimized session grouping)
- Lower costs (automatic rate selection)
- Reduced labor & training

---

## Key Concepts

### Collections
Groups of products with similar physical characteristics (size, shape, weight, packing behavior).

Examples:
- "2.5oz jerky"
- "8x8x3 gift box"
- "10-pack meat sticks"

**Source:** Product catalog from reporting PostgreSQL database. Managers create/manage collections in ship.

### Footprints
The "shape signature" of an order based on which collections it contains and quantities.

Example: "2 gift boxes + 5 small jerky bags"

**How it works:**
1. Order arrives with products from collections
2. Ship. calculates the order's footprint
3. If footprint is recognized, packaging is known instantly
4. If unknown, system asks a human to decide (one-time learning)
5. Decision is saved as a permanent rule (model)

### Packaging Types
The discrete set of boxes/bags jerky.com uses to fulfill orders. TBD: need complete inventory.

Examples:
- 12x12x8 box (Boxing Machine)
- 16x18 poly bag (Poly Bag Station)
- Custom boxes (Hand Pack Station)

### Models
Learned mappings of footprint → packaging type. These are permanent rules that ship. remembers.

---

## Three Packing Stations

Ship. routes orders to one of three physical warehouse locations based on packaging requirements:

| Station | Packaging | Workflow | Characteristics |
|---------|-----------|----------|-----------------|
| **Boxing Machine** | 12x12x8 boxes only | Automated | High throughput, zero decision-making |
| **Poly Bag Station** | 16x18 poly bags only | Fast manual | Standardized motions, identical operations |
| **Hand Pack Station** | Custom boxes, mixed orders | Manual QC | Odd-sized, fragile, mixed products |

---

## Session Terminology (Critical Clarity)

**SkuVault Sessions** = Just the picking phase
- Status: new → active → closed
- Managers create these manually in SkuVault

**jerky.com Sessions** = Full fulfillment lifecycle
- Span: "Ready to Pick" → "On the Dock" (done)
- Contains: picking + packing + QC + label generation
- Size: 28 orders per cart (physical cart capacity)
- Routed: Ship. sorts orders by packing station first, then optimizes within each lane

**Current flow:**
1. Manager creates SkuVault session (picking)
2. Workers pick items
3. Orders move to packing stations
4. Ship. will automate the packaging/station routing decisions managers currently make manually

---

## The Learning System

**Problem:** Not every footprint can be predicted upfront. Products change, new combinations emerge.

**Solution:** One-time human decision + permanent learning

**Flow:**
1. Order with unknown footprint arrives at ship.
2. System prompts manager: "What packaging for this order?"
3. Manager selects packaging type
4. System saves rule: footprint X → packaging Y
5. All future orders with footprint X automatically use packaging Y

---

## Current Integration Points

### Order Status & Holds
Today, holds are managed by updating ShipStation records:
- Add "MOVE OVER" tag to make order shippable
- Remove hold tag to release the order
- Ship. understands "shippable" = "MOVE OVER" tag + hold removed

Hold types (TBD): customer service holds, out-of-stock holds, others TBD

### SkuVault Integration
- Ship. receives wave picking sessions (SkuVault status: new/active/closed)
- Ship. does NOT create SkuVault sessions (managers do)
- Ship. provides packaging decisions for the full jerky.com session lifecycle

### ShipStation Integration
- Rate checking: Ship. pulls carrier/service costs from ShipStation
- Label generation: Ship. sends orders to ShipStation for label creation
- Status updates: MOVE OVER tag indicates order is ready

### Product Catalog
- Source: Reporting PostgreSQL database (separate from main app DB)
- Details needed: Product to collection mappings
- Manager UI to create/manage collections

---

## Implementation Phases

### Phase 1: Data Model & Core Concepts 🔄
Tasks:
- [x] Define product_collections schema (products → collection groupings)
- [x] Define product_collection_mappings schema (SKU → collection mappings)
- [x] Connect to reporting DB for product catalog (already done via reportingSql)
- [ ] Define Packaging Types schema (discrete box/bag types) — deferred to Phase 4
- [ ] Define Footprints schema (collection combos) — deferred to Phase 3
- [ ] Define Models schema (footprint → packaging mappings) — deferred to Phase 3

### Phase 2: Collection Management ✅
**Page:** `/collections` | **Sidebar:** "Collections"

**Layout:** Split-panel design
- Left panel: Collections list (master table CRUD)
- Right panel: Products in selected collection + product catalog search

**Data Sources:**
- `inventory_forecasts_daily` (latest stock_check_date) — product catalog
- `is_assembled_product` field — identify Kit/AP products (badge display)
- `product_collections` / `product_collection_mappings` — local DB tables

**UX Features:**
- Searchable product list with SKU, description, supplier, stock level
- Multi-select products for bulk assignment to collections
- "Select All" option to select all visible products at once
- Dropdown filters: Category, Supplier, Kit/AP (Yes/No/Either)
- Debounced search input to reduce UI bounce
- "Kit/AP" badge for assembled products
- Product count per collection in list
- "In Collection" badge indicator when SKU is already assigned
- Inline "New Collection" creation with modal (name + description)
- Empty state guidance for new users

Tasks:
- [x] Create /collections page with sidebar entry
- [x] Build collections list panel with CRUD (create, edit, delete)
- [x] Build products panel with search from inventory_forecasts_daily
- [x] Add product-to-collection assignment with multi-select
- [x] Add "Select All" for visible products
- [x] Add dropdown filters (Category, Supplier, Kit/AP)
- [x] Add debounced search to reduce UI bounce
- [x] Show Kit/AP badges using is_assembled_product field
- [x] Display product count per collection and "In Collection" indicators
- [x] Increase search limit to 500 products for full catalog visibility

### Phase 3: Footprint Detection & Learning ✅

**Goal:** Automatically determine packaging for orders based on their product collection composition.

**Core Tables:**
- `shipment_qc_items` — Exploded line items for each shipment with QC tracking
- `packaging_types` — Discrete set of packaging options (seeded from historical data)
- `footprints` — Unique "shape signatures" based on collection composition
- `footprint_models` — Learned rules mapping footprint → packaging type

**Data Sources for Explosion:**
- Kit components: `vw_internal_kit_component_inventory_latest` joined with `internal_inventory` for barcodes
- Non-kit products: `inventory_forecasts_daily` joined with `internal_inventory` for barcodes

**Barcode Lookups (Reporting DB):**
```sql
-- For kit components:
SELECT vw.*, ii.code as component_barcode
FROM vw_internal_kit_component_inventory_latest vw
JOIN internal_inventory ii ON ii.snapshot_timestamp = vw.snapshot_timestamp 
  AND ii.sku = vw.component_sku

-- For regular products:
SELECT ifd.*, ii.code as barcode
FROM inventory_forecasts_daily ifd
JOIN internal_inventory ii ON ii.sku = ifd.sku AND ii.snapshot_timestamp = ifd.stock_check_date
WHERE stock_check_date = (SELECT MAX(stock_check_date) FROM inventory_forecasts_daily)
```

**Schema Tasks:**
- [x] Create `shipment_qc_items` table (exploded items with QC tracking)
- [x] Create `packaging_types` table (discrete packaging options)
- [x] Create `footprints` table (unique collection combos)
- [x] Create `footprint_models` table (footprint → packaging rules)
- [x] Add fields to `shipments`: qc_station_id, footprint_id, packaging_type_id, packaging_decision_type
- [x] Seed `packaging_types` from historical `shipment_packages` data (10 types: boxes, poly bags, envelopes)

**Background Job Tasks:**
- [x] Build job to populate `shipment_qc_items` for new shipments
- [x] Explode kits using reporting DB kit mappings
- [x] Map SKUs to collections for footprint calculation
- [x] Calculate and assign footprint_id to shipments (via `calculateFootprint` in qc-item-hydrator.ts)

**Background Job Implementation Notes:**
- `product-catalog-cache.ts`: Redis caching for product catalog (701 products) and kit mappings (1662 entries)
- `qc-item-hydrator.ts`: Core explosion logic with kit component lookup and barcode resolution
- `qc-hydrator-worker.ts`: 60-second interval worker processing 50 shipments/run (~4.4s)
- Trigger: "Ready to Fulfill" shipments (on_hold status + "MOVE OVER" tag)
- Cache invalidation: Independent date-based (stock_check_date for products, snapshot_timestamp for kits)
- Coverage: 96% barcode resolution, ~45% collection mapping (ongoing - managers categorizing products)

**Footprint Calculation Logic:**
- [x] Aggregate exploded items by collection (uses `product_collection_mappings` as source of truth)
- [x] Generate canonical footprint signature (SHA256 hash of sorted collection composition JSON)
- [x] Match against existing footprints or create new
- [x] Mark shipment footprint_status: 'complete' or 'pending_categorization'

**Architecture Decision:** `product_collection_mappings` is the single source of truth for SKU → collection. Footprint calculation performs query-time lookups rather than relying on denormalized `collection_id` in `shipment_qc_items`.

### Phase 4: Packing Decisions UI ✅

**Page:** `/packing-decisions` | **Sidebar:** "Packing Decisions" (AlertTriangle icon)

**Goal:** Give managers visibility into uncategorized SKUs blocking footprint completion, and enable quick assignment to collections.

**Metrics Cards:**
- **SKUs in Orders** — X of Y categorized (with "Since [oldest order date]" subtitle in US Central time)
- **Shipments Complete** — X of Y with footprints calculated
- **Needs Categorization** — X SKUs blocking Y shipments

**Features:**
- [x] List uncategorized SKUs with shipment count (prioritized by most blocking)
- [x] Quick-assign dropdown to existing collections
- [x] "Create new collection" option inline
- [x] Auto-recalculate footprints when SKUs are assigned
- [x] React Query cache invalidation: Collections page updates → Packing Decisions refreshes
- [x] Clear terminology: "SKUs in orders" vs "products" (ordered items vs catalog)

**API Endpoints:**
- `GET /api/packing-decisions/uncategorized` — Stats + uncategorized SKU list
- `POST /api/packing-decisions/assign` — Assign SKU to collection, recalculate affected footprints

### Phase 5: Learned Footprints UI ✅

**Page:** `/footprints` | **Sidebar:** "Footprints" (below Packing Decisions)

**Goal:** Show managers what footprint patterns the system has learned, and allow them to assign packaging rules.

**Features:**
- [x] List unique footprints with human-readable collection composition (e.g., "Small Jerky (3) + Gift Box (1)")
- [x] Show shipment count per footprint (sorted by highest volume first)
- [x] Assign packaging type via inline dropdown
- [x] Visual indicators: green checkmark (assigned) vs amber warning (needs decision)
- [x] Station type badges (Boxing Machine / Poly Bag / Hand Pack)
- [x] Inline success/error feedback (non-intrusive, no toasts blocking UI)
- [x] Stats cards: Total Patterns, Packaging Assigned (% auto-routable), Needs Decision
- [x] Filter toggle: All / Needs Mapping / Mapped (client-side filtering)
- [x] Manage Packaging Types collapsible section (create/edit packaging types with station type assignment)

**API Endpoints:**
- `GET /api/footprints` — All footprints with shipment counts, packaging status, human-readable names
- `GET /api/packaging-types` — Active packaging types for dropdown
- `POST /api/footprints/:footprintId/assign` — Assign packaging type to footprint, update all linked shipments
- `POST /api/packaging-types` — Create new packaging type with name and station type
- `PATCH /api/packaging-types/:id` — Update packaging type (name, station type)

### Phase 6: Shipment Lifecycle Formalization ✅

**Goal:** Define the complete end-to-end shipment lifecycle with proper enums, state machines, and phase progression.

---

#### Lifecycle Overview

**High-Level Workflow View** (for business reporting):
| Status | Description |
|--------|-------------|
| **Ready to Fulfill** | Orders on hold with "MOVE OVER" tag, waiting for warehouse to start |
| **In Progress** | Orders actively moving through warehouse (spans multiple lifecycle phases) |
| **On the Way** | Labeled and handed to carrier |

**Detailed Lifecycle View** (warehouse operations):
| Phase | Description | Current Tracking | Exit Criteria |
|-------|-------------|------------------|---------------|
| **Awaiting Decisions** | New orders needing packing decisions | *Not yet formalized* | Assigned to fulfillment session |
| **Ready to Pick** | Session created in SkuVault, waiting to start | `sessionStatus = 'new'` | SkuVault session starts |
| **Picking** | Actively being picked | `sessionStatus = 'active'` | All items picked |
| **Packing Ready** | Picking complete, ready for packing | `sessionStatus = 'closed'` | Label printed |
| **On the Dock** | Labeled, waiting for carrier pickup | Has `trackingNumber` | Carrier pickup |
| **Picking Issues** | Exception requiring supervisor attention | `sessionStatus = 'inactive'` | Resolved |

---

#### "Awaiting Decisions" Subphases (NEW)

This is where Ship. does its work before orders enter the warehouse flow:

| Subphase | Description | Exit Criteria |
|----------|-------------|---------------|
| **Needs Categorization** | SKUs in order not yet assigned to collections | All SKUs categorized |
| **Needs Footprint** | Footprint not yet calculated | Footprint assigned |
| **Needs Packaging** | Footprint has no packaging type mapping | Packaging type assigned |
| **Needs Session** | Ready for sessioning but not yet grouped | Assigned to fulfillment session |
| **Ready for SkuVault** | In session, ready to push | Pushed to SkuVault |

---

#### Terminology Clarification

- **Fulfillment Session** = Ship.'s optimized grouping of orders for packing (end-to-end lifecycle)
- **SkuVault Session** = The picking session in SkuVault (just the picking phase)

A fulfillment session spans from packing decisions through to "On the Dock."

---

#### Infrastructure (Completed)

- [x] Add `stationType` field to `packaging_types` table (boxing_machine | poly_bag | hand_pack)
- [x] Add `stationType` field to `stations` table for physical station classification
- [x] Stations page: Station type selector dropdown with color-coded badges
- [x] Footprints page: Station type badges display on packaging types
- [x] Full routing chain established: Footprint → Packaging Type → Station Type → Physical Station

---

#### Implementation Tasks

**Step 1: Define Lifecycle Enum & State Machine** ✅
- [x] Create `shipmentLifecyclePhase` enum: `awaiting_decisions` | `ready_to_pick` | `picking` | `packing_ready` | `on_dock` | `picking_issues`
- [x] Create `decisionSubphase` enum: `needs_categorization` | `needs_footprint` | `needs_packaging` | `needs_session` | `ready_for_skuvault`
- [x] Add `lifecyclePhase`, `decisionSubphase`, `lifecyclePhaseChangedAt`, `fulfillmentSessionId` fields to shipments table
- [x] Create state machine logic for phase transitions (`server/services/lifecycle-state-machine.ts`)

---

#### Phase Transition Conditions & Triggers

**Exact Conditions for Each Lifecycle Phase:**

| Phase | Database Conditions | ShipStation/SkuVault Status |
|-------|--------------------|-----------------------------|
| **Awaiting Decisions** | No `sessionStatus` yet | Order not in SkuVault |
| **Ready to Pick** | `sessionStatus = 'new'` AND `trackingNumber IS NULL` | SkuVault session created, not started |
| **Picking** | `sessionStatus = 'active'` AND `trackingNumber IS NULL` | SkuVault session in progress |
| **Packing Ready** | `sessionStatus = 'closed'` AND `trackingNumber IS NULL` AND `shipmentStatus = 'pending'` | Picking complete |
| **On the Dock** | `trackingNumber IS NOT NULL` AND `status = 'AC'` | Accepted by carrier |
| **Picking Issues** | `sessionStatus = 'inactive'` | Requires supervisor attention |

**Event Sources That Trigger Transitions:**

| Event Source | Event | Transition |
|--------------|-------|------------|
| **Ship. Internal** | SKU categorized | Subphase: needs_categorization → needs_footprint |
| **Ship. Internal** | Footprint calculated | Subphase: needs_footprint → needs_packaging |
| **Ship. Internal** | Packaging assigned | Subphase: needs_packaging → needs_session |
| **Ship. Internal** | Fulfillment session created | Subphase: needs_session → ready_for_skuvault |
| **SkuVault Push** | Session pushed to SkuVault | awaiting_decisions → ready_to_pick |
| **Firestore Sync** | Session status = 'active' | ready_to_pick → picking |
| **Firestore Sync** | Session status = 'closed' | picking → packing_ready |
| **Firestore Sync** | Session status = 'inactive' | Any → picking_issues |
| **ShipStation Webhook** | Label created (tracking number) | packing_ready → on_dock |
| **ShipStation Webhook** | Status = 'AC' (carrier accepted) | Confirms on_dock |

---

#### Centralized Transition Logic

**Principle:** All code paths go through one function to determine lifecycle phase.

**Implementation:**

1. **`deriveLifecyclePhase(shipment)`** — Reads shipment data, returns the correct phase based on conditions above
2. **`updateShipmentLifecycle(shipmentId)`** — Central function that:
   - Loads the shipment from database
   - Calls `deriveLifecyclePhase()` to determine current phase
   - Updates `lifecyclePhase`, `decisionSubphase`, and `lifecyclePhaseChangedAt` fields
   - Logs the transition for audit trail
3. **Hook into all event handlers:**
   - ShipStation webhook processor → calls `updateShipmentLifecycle()`
   - Firestore sync worker → calls `updateShipmentLifecycle()`
   - Ship. packaging assignment → calls `updateShipmentLifecycle()`
   - Label print completion → calls `updateShipmentLifecycle()`

**Benefits:**
- Single source of truth for phase determination
- Seamless, automatic transitions regardless of event origin
- Audit trail of all phase changes via `lifecyclePhaseChangedAt`
- Easy to add new conditions or phases in one place

---

**Step 1b: Centralized Transition Function** ✅
- [x] Update `deriveLifecyclePhase()` with exact conditions (including `status = 'AC'` for on_dock)
- [x] Create `updateShipmentLifecycle(shipmentId)` function in storage or service layer
- [x] Hook into ShipStation webhook processor (via `shipstation-shipment-etl-service.ts` and `shipment-sync-worker.ts`)
- [x] Hook into Firestore/SkuVault sync worker (`firestore-session-sync-worker.ts`)
- [x] Hook into Ship. internal actions (packaging assignment in `routes.ts`, session creation in `fulfillment-session-service.ts`)

---

**Step 2: Auto Station Assignment** ✅
- [x] Added `assigned_station_id` field to shipments table (distinct from `qc_station_id` which records where order WAS packed)
- [x] When packaging type is assigned to footprint, look up station by `stationType`
- [x] Find active station matching that type (currently 1 per type)
- [x] Set `assigned_station_id` on all linked shipments automatically

**Step 3: Fulfillment Session Building** ✅
- [x] Created `fulfillment_sessions` table with:
  - id, name, sequenceNumber, stationId, stationType
  - orderCount, maxOrders (default 28), status enum
  - Timestamps: createdAt, readyAt, pickingStartedAt, packingStartedAt, completedAt
  - createdBy (audit trail)
- [x] `fulfillment_session_id` field already exists on shipments table
- [x] Created `FulfillmentSessionService` with clean OOP design:
  - `findSessionableShipments()` - finds shipments ready for sessioning
  - `groupShipmentsForBatching()` - groups by station type → footprint
  - `buildSessions()` - creates sessions and links shipments
  - `previewSessions()` - dry-run preview before building
  - `updateSessionStatus()` - status transitions with timestamps
- [x] Session building algorithm implemented:
  1. Query shipments with packaging + assignedStation, no existing session
  2. Sort by: station type priority → footprint → order number
  3. Batch into groups of max 28 orders per session
  4. Create session records and link shipments
- [x] API endpoints:
  - `GET /api/fulfillment-sessions/preview` - preview sessionable shipments
  - `POST /api/fulfillment-sessions/build` - build sessions (supports dryRun)
  - `GET /api/fulfillment-sessions` - list sessions with optional status filter
  - `GET /api/fulfillment-sessions/:id` - get session with shipments
  - `PATCH /api/fulfillment-sessions/:id/status` - update session status

**Step 4: Fulfillment Prep Dashboard** ✅
- [x] Renamed Footprints page to "Fulfillment Prep" dashboard
- [x] Added 3-tab workflow: Categorize SKUs → Assign Packaging → Build Sessions
- [x] Summary cards at top showing action items for each stage (clickable to switch tabs)
- [x] Categorize tab: Shows uncategorized products with collection assignment dropdown
- [x] Assign Packaging tab: Existing footprint → packaging assignment (preserved)
- [x] Build Sessions tab: Preview orders by station type, shows session count, "Build Sessions" button
- [x] Integrated with existing APIs + new session preview/build endpoints

**Step 5: Fulfillment Session Management UI** ✅
- [x] Session preview shows orders grouped by station type (in "Build Sessions" tab)
- [x] Preview shows: station type, order count, number of sessions to be created, footprint count
- [x] "Build Sessions" button triggers session creation
- [ ] Push confirmed sessions to SkuVault (deferred to Phase 8)

---

### Phase 7: Carrier Rate Integration ⬜
Tasks:
- [ ] Pull carrier/service rates from ShipStation
- [ ] Auto-select lowest-cost service meeting delivery promise
- [ ] Store selected rate with order

### Phase 8: Session Management UI ⬜
Tasks:
- [ ] Display ready-to-session orders
- [ ] Trigger session building
- [ ] Show session composition (station, packaging types, order count)
- [ ] Send confirmed sessions to SkuVault

### QC Integration (Parallel Track) 🔄
These tasks integrate with existing boxing/bagging pages:
- [x] Update `quantity_scanned` during packing (existing boxing/bagging pages)
- [x] Mark `qc_complete` when all items scanned
- [x] Push to SkuVault via passQCitem endpoint
- [x] Track `synced_to_skuvault` status

---

## Open Questions (For Future Sessions)

1. **Footprint Uniqueness:** Is footprint identified by collection types + quantities only, or are there other factors?
2. **Session Creation Trigger:** On-demand (manager clicks "build sessions") or automatic when thresholds are met?
3. **Session Optimization Metrics:** Beyond time + material handling, are there other factors? Zone proximity? Product mix?
4. **Customer Promise Timing:** How does ship. know what delivery timing was promised? Shopify shipping method? ShipStation data?
5. **Hold Types:** What are all the hold types? How are they released beyond the "MOVE OVER" tag?
6. **Packaging Inventory:** What is the complete, discrete set of packaging types jerky.com uses?
7. **Fallback Logic:** If a rate check fails or returns no valid services, what's the fallback?

---

## Notes for Future Sessions

- This feature spans multiple sessions—use this doc to track progress
- Each phase is a logical boundary; phases can be adjusted as we learn
- The reporting DB connection is critical; details will be provided when needed
- Packing stations already have UIs (boxing page + bagging page); ship. feeds data into them
- This is a greenfield feature (not replacing existing order management, layering on top)
