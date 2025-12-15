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

### Phase 3: Footprint Detection & Learning 🔄

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

**Background Job Tasks:**
- [ ] Build job to populate `shipment_qc_items` for new shipments
- [ ] Explode kits using reporting DB kit mappings
- [ ] Map SKUs to collections for footprint calculation
- [ ] Calculate and assign footprint_id to shipments

**Footprint Calculation Logic:**
- [ ] Aggregate exploded items by collection
- [ ] Generate canonical footprint signature (e.g., `{"GiftBox": 2, "SmallJerky": 5}`)
- [ ] Match against existing footprints or create new

**Learning UI Tasks:**
- [ ] Morning decision page showing orders needing packaging
- [ ] Auto-apply known footprint models
- [ ] Prompt for unknown footprints → save as new model
- [ ] Track decision type: 'auto' vs 'manual'

**QC Integration:**
- [ ] Update `quantity_scanned` during packing
- [ ] Mark `qc_complete` when all items scanned
- [ ] Push to SkuVault via passQCitem endpoint
- [ ] Track `synced_to_skuvault` status

### Phase 4: Station Routing & Session Building ⬜
Tasks:
- [ ] Route orders to correct station based on packaging
- [ ] Validate no mixed stations in single session (all poly or all boxes, etc.)
- [ ] Group orders into optimized 28-order sessions within station lanes
- [ ] Optimize for: total time + material handling

### Phase 5: Carrier Rate Integration ⬜
Tasks:
- [ ] Pull carrier/service rates from ShipStation
- [ ] Auto-select lowest-cost service meeting delivery promise
- [ ] Store selected rate with order

### Phase 6: Session Management UI ⬜
Tasks:
- [ ] Display ready-to-session orders
- [ ] Trigger session building
- [ ] Show session composition (station, packaging types, order count)
- [ ] Send confirmed sessions to SkuVault

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
