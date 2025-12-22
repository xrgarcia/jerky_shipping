# Warehouse Fulfillment Application

## Naming Convention
- **ship.** = This application (ship.jerky.com)
- **jerky.com** = The business name

## Current Feature Under Development
See **CURRENT_FEATURE.md** for the Smart Shipping Engine feature specification, implementation phases, and progress tracking.

## Database SQL Scripts

GIN trigram indexes and other advanced PostgreSQL features are managed via manual SQL scripts in `/scripts/sql/` rather than Drizzle ORM (which doesn't correctly handle GIN operator classes).

**After deployment, run these scripts in order:**
1. `scripts/sql/20251213_enable_pg_trgm.sql` - Enable the pg_trgm extension
2. `scripts/sql/20251213_add_trigram_indexes.sql` - Add GIN trigram indexes for fast ILIKE search

See `/scripts/sql/README.md` for the full process and applied scripts log.

## Database Deployment Process

**How schema changes reach production:**

1. **Development:** Run `npm run db:push` to sync Drizzle schema (`shared/schema.ts`) to the development database
2. **Publish:** When you publish, Replit automatically applies structural changes (new tables, columns) to the production database
3. **Manual SQL scripts:** For features Drizzle can't handle (GIN indexes, extensions), run scripts manually via the Database pane after publishing

**Important notes:**
- Brief downtime may occur during publishing while database changes are applied
- Non-backward compatible changes (dropping columns with data) require careful planning
- Always test schema changes in development before publishing

## Overview
This application (ship.) is the warehouse fulfillment tool for jerky.com, integrated with Shopify for order management. It aims to enhance order processing and inventory management through real-time synchronization, a user-friendly interface for warehouse staff, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time order status updates. The project seeks to improve operational efficiency and provide a robust platform for e-commerce fulfillment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture
### UI/UX Decisions
The UI/UX features a warm earth-tone palette and large typography for warehouse readability, utilizing `shadcn/ui` (New York style) built on Radix UI and styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, and TanStack Query.
- **Backend**: Express.js with Node.js and TypeScript, exposing a RESTful API. Drizzle ORM for database interactions.
- **Authentication**: Google OAuth (restricted to @jerky.com domain) with secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle Kit for migrations.
- **Core Features**:
    - **Order Management**: Synchronized product catalog, SkuVault wave picking session display, and QC integration for packing.
    - **Packing Page (Boxing/Bagging)**: Supports a single-warehouse MVP with SkuVault QC validation, scan-first workflow, individual unit scanning, and audit trails. The bagging workflow includes immediate label printing on scan, robust error handling for printing failures, and printer pre-checks.
        - **Boxing page** → Used for Boxing Machine AND Hand Pack stations (QC before print workflow)
        - **Bagging page** → Used for Poly Bag Station (immediate print on scan workflow)
    - **Workstation Guard System**: Prevents workers from packing at incorrect physical workstations using browser local storage for station ID tracking and mismatch detection with a blocking UI.
    - **Shipment Management**: Unified shipments page with three navigation modes: Lifecycle View (default, 5 tabs for warehouse lifecycle), Workflow View (3 business process tabs), and All shipments view.
    - **Order Backfill System**: Fault-tolerant, task-based architecture for historical Shopify orders and ShipStation shipments, using Redis-queued processing and WebSocket updates.
    - **Reporting & Analytics**: Business analytics dashboard (Gross Sales, Net Sales) and PO Recommendations page. Includes a Packed Shipments Report with comprehensive timing analytics (overall, per-user, per-day, per-order).
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing with background worker, retry logic, and browser auto-print.
    - **Desktop Printing System**: A three-tier architecture for native Windows printing using an Electron app, WebSocket connectivity, and unified SumatraPDF printing for consistency.
    - **Web-based Stations Management**: CRUD interface at `/stations` with real-time connection status.
    - **Real-Time Updates**: WebSocket server provides live updates for orders, queues, and print status.
    - **Saved Views System**: Customizable column views for the PO Recommendations page.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: Standardized data transformations for Shopify orders and ShipStation shipments.
- **Worker Coordination System**: Redis-backed mutex for production-ready coordination of poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines a cursor-based Unified Shipment Sync Worker for scheduled polling and a Webhook Processing Queue for real-time events, with a two-tier priority system for webhooks.
- **Shopify → ShipStation Sync**: ShipStation data comes exclusively from ShipStation webhooks; Shopify webhooks do not trigger ShipStation API calls.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling.
- **Packing Completion Audit Logging**: All packing actions are logged to the `packing_logs` table.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}` for user guidance.
- **Voided Label Handling**: When reprinting a voided label, the system automatically creates a new label, validates the PDF format, prints to the requesting worker's station, logs an audit trail, and invalidates the QC cache.
- **QC Completion Tracking**: `shipments.qc_completed` boolean flag and `qc_completed_at` timestamp track packing QC completion for both boxing and bagging workflows.
- **ShipStation Label Creation Endpoints**: Differentiates between creating labels for existing and new shipments.

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and support for `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch` webhooks.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, featuring automatic authentication, Redis-backed token caching, and a discriminated union type system. Includes a QCSale Cache Warmer Service to proactively pre-load and cache SkuVault QC Sale data and shipment data for orders ready to be packed, with a 48-hour TTL and automatic invalidation.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
-   **Neon Database**: Serverless PostgreSQL database for primary data storage.
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.

### Kits vs Assembled Products (APs) - Critical Distinction

**Kits** = Products built at fulfillment time by the picker. They are **EXPLODED** into individual components in SkuVault's QC Sale API. The picker grabs each component separately.
- Should have `product_category = 'kit'`
- SkuVault returns the individual components (not the parent kit SKU)

**Assembled Products (APs)** = Pre-built products that ship as-is. They are **NOT exploded**.
- Have `is_assembled_product = true`
- SkuVault returns the parent SKU (not components)
- Example: JCB1042-K (a pre-assembled gift box)

**Common Data Quality Issue:** A product may be miscategorized - marked as an AP (`is_assembled_product = true`) but SkuVault is exploding it like a kit. This indicates a SkuVault configuration error where the product should either:
1. Be recategorized as a kit (`product_category = 'kit'`), OR
2. Have SkuVault stop exploding it if it's truly pre-built

The QC Validation Report (`/reports/qc-validation`) helps identify these miscategorized products by comparing local data against SkuVault's live QC Sale API response.

### SkuVault Products (Centralized Product Catalog)
The `skuvault_products` table is the local single source of truth for product catalog data, synced hourly from the GCP reporting database.

**Data Sources (3-way merge):**
1. `internal_kit_inventory` — Kit/AP products (~1662 SKUs) - imported first
2. `inventory_forecasts_daily` — Parent/individual products (~701 SKUs) - merged second, fills gaps
3. `product_variants` — Variant products where sku != primary_sku (~372 SKUs) - added third

**Merge Strategy:**
- Kits are imported first as the base layer
- Parent products fill in missing fields without overwriting existing values
- Variants are added as new products with `parent_sku` referencing their parent
- Conflicts are logged (when non-null values differ between sources)

**Key Fields:**
- `sku` (PK), `product_title`, `barcode`, `product_category`, `is_assembled_product`, `unit_cost`
- `parent_sku` — For variant products, references the parent SKU (null for kits/parents)
- `weight_value` (real/decimal), `weight_unit` — Product weight with decimal precision
- `product_image_url` — Resolved via waterfall: productVariants → shipmentItems → null
- `stock_check_date` — Date of the data snapshot from reporting database

**Sync Worker:**
- `server/skuvault-products-sync-worker.ts` — Runs hourly, checks for new `stock_check_date`
- `server/services/skuvault-products-sync-service.ts` — 3-way merge logic with conflict logging
- Truncate-and-reload strategy (fast, no incremental complexity)
- Redis tracks last synced date to avoid redundant syncs
- ~2539 products synced in ~2 seconds (1662 kits + 505 new parents + 372 variants)

**Product Lookup Services:**
- `server/services/product-lookup.ts` — Direct database queries to `skuvault_products` table
  - `getProduct(sku)` — Single product lookup
  - `getProductsBatch(skus)` — Batch product lookup (more efficient for multiple products)
  - Used by QC item hydrator for boxing/bagging pages
- `server/services/kit-mappings-cache.ts` — Kit→component mappings from GCP `vw_internal_kit_component_inventory_latest`
  - Redis-cached with automatic refresh
  - `getKitComponents(sku)` — Get component SKUs for a kit
  - `getKitMappingsStats()` — Cache statistics for monitoring

### Reporting Database Schema
The reporting database (`REPORTING_DATABASE_URL`) is a separate GCP PostgreSQL instance used for analytics and product catalog data. Connection is established via `server/reporting-db.ts` using the `reportingSql` client.

**Key Tables:**
- `inventory_forecasts_daily` — Daily product catalog snapshot (~701 SKUs), synced nightly from SkuVault. Contains product details, stock levels, and the `is_assembled_product` flag.
- `vw_internal_kit_component_inventory_latest` — View showing kit/AP (Assembled Product) to component mappings. Each row represents one component of a kit with `sku` (parent), `component_sku`, and `component_quantity`.

**Usage:**
- **PO Recommendations**: Uses `vw_po_recommendations` view for purchase order suggestions
- **Collection Management (Ship.)**: Managers use product catalog data to assign products to collections for footprint detection
- **SkuVault Products Sync**: Hourly sync populates local `skuvault_products` table for fast product lookups

**Important Note:** For live order processing, the SkuVault API provides already-exploded order line items with barcodes (via the QC Sale endpoint used by boxing/bagging pages). Ship. does not need to perform kit explosion at runtime—SkuVault handles this.

### PO Recommendations Page (`/po-recommendations`)
Helps managers identify products that need reordering based on sales velocity, lead times, and upcoming holidays.

**Data Source:** `vw_po_recommendations` view from reporting database (Redis-cached snapshots)

**Key Features:**
- **Inventory Forecasting**: 90-day forecast based on base/projected velocity and growth rates
- **Holiday Planning**: Shows upcoming holiday seasons with countdown and recommended quantities
- **Supplier Filtering**: Multi-select filter by supplier
- **Assembled Product Toggle**: Show/hide APs (Assembled Products)
- **Lead Time Consideration**: Factors in supplier lead times for reorder timing
- **Saved Views**: Users can save/load column configurations, filters, and sort preferences
- **Calculation Steps**: Click any SKU to see the detailed calculation breakdown

**Available Columns:**
- Core: SKU, Supplier, Title, Lead Time, Current Stock, Recommended Qty
- Velocity: Base Velocity, Projected Velocity, Growth Rate, 90-Day Forecast
- Inventory: Days Cover, Qty Incoming, Kit Velocity, Individual Velocity
- Adjustments: Case Adjustment, MOQ Applied, Is Assembled Product
- Holiday: Next Holiday Days, Holiday Rec Qty, Holiday Season, Holiday Start Date