# Warehouse Fulfillment Application

## Overview
This application (ship.) is the warehouse fulfillment tool for jerky.com, integrated with Shopify for order management. Its primary purpose is to enhance order processing and inventory management through real-time synchronization, a user-friendly interface for warehouse staff, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time order status updates. The project aims to improve operational efficiency and provide a robust platform for e-commerce fulfillment.

## User Preferences
Preferred communication style: Simple, everyday language.
Important: The production database is the source of truth. Tactical data fixes must be applied to production, not the development database. Development database changes have no effect on real operations. When fixing specific records or data issues, always target the production database.

## System Architecture
### UI/UX Decisions
The UI/UX features a warm earth-tone palette and large typography for warehouse readability, utilizing `shadcn/ui` (New York style) built on Radix UI and styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React, TypeScript, Vite, Wouter for routing, and TanStack Query.
- **Backend**: Express.js with Node.js and TypeScript, exposing a RESTful API. Drizzle ORM for database interactions.
- **Authentication**: Google OAuth (restricted to @jerky.com domain) with secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL (Neon serverless) with Drizzle Kit for migrations.
- **Core Features**: Order management, packing page supporting boxing/bagging workflows, workstation guard system, shipment management, order backfill system, reporting & analytics, operations dashboard, print queue system, desktop printing via Electron, web-based stations management, real-time updates via WebSockets, customizable saved views, and sales forecasting.
- **Sales Forecasting System**: Displays sales data from the GCP reporting database with interactive filtering and 5 chart types. Features chart annotations, and queries are cached in Upstash Redis with 1-hour TTL. Dates are in US Central time.
- **Sales Forecasting Projection**: A daily job projects last year's actuals into the `sales_forecasting` table, aligning peak seasons using `peak_season_dates`. Includes product enrichment fields like `is_kit`, `is_assembled_product`, `parent_sku`, and `parent_kit`. Service: `forecast-generation-service.ts`.
- **`sales_forecasting` Column Year Semantics**: The table mirrors the `sales_metrics_lookup` schema and is populated using prior-year actuals projected onto future dates. Each column group represents a different year of data:
  - **`daily_*` columns** (`daily_sales_quantity`, `daily_sales_revenue`, `kit_daily_sales_quantity`, `kit_daily_sales_revenue`): last year's actuals (e.g. 2025) on the equivalent date. These are the primary smart/blended projection values used for purchasing decisions.
  - **`yoy_*` columns** (`yoy_daily_sales_quantity`, `yoy_daily_sales_revenue`, `yoy_kit_daily_sales_quantity`, `yoy_kit_daily_sales_revenue`): two years ago actuals (e.g. 2024), using the same-day offset for peak season alignment. Example: projecting Feb 26, 2026 uses Feb 26, 2024 sales in the `yoy_*` fields.
  - **`curr_*` columns** (`curr_daily_sales_quantity`, `curr_daily_sales_revenue`, `curr_kit_daily_sales_quantity`, `curr_kit_daily_sales_revenue`): not tied to a calendar year — derived from the most recent 14 consecutive baseline days in `sales_metrics_lookup`. NULL on all non-baseline rows.
- **Dual-Mode Forecasting Strategy**: The forecast uses two different strategies depending on `event_type`:
  - **Peak/holiday seasons** (`event_type != 'baseline'`, e.g. Valentine's Day, Christmas): The best projection is **year-over-year** — last year's actual sales aligned to the equivalent peak season window. The `curr_*` velocity fields are explicitly NULL on these rows; they are not used.
  - **Baseline periods** (`event_type = 'baseline'`): The best projection is **14-day sales velocity** — a rolling average of recent baseline-only sales. The 4 `curr_*` columns (`curr_daily_sales_quantity`, `curr_daily_sales_revenue`, `curr_kit_daily_sales_quantity`, `curr_kit_daily_sales_revenue`) are populated only on baseline rows. On every worker run (even early-exit), `loadCurrentVelocity()` finds the most recent consecutive 14-day baseline window (using the `date - ROW_NUMBER()` grouping trick within the last 180 days of GCP `sales_metrics_lookup`), averages those 4 fields per sku + sales_channel, and `bulkUpdateCurrentVelocity()` writes them to `sales_forecasting` where `event_type = 'baseline'`, then explicitly NULLs out any non-baseline rows that have stale velocity values.
- **Purchase Order Snapshots**: `purchase_order_snapshots` table (composite key: stock_check_date + sku) merges `skuvault_products` with `inventory_forecasts_daily` (IFD) from the GCP reporting DB. Snapshots are created on-demand when IFD and internal_inventory dates match and are newer than the latest local snapshot. Service: `server/services/purchase-order-snapshot-service.ts`. API: `/api/purchase-orders/{readiness,create-snapshot,dates,snapshot,config}`. UI: Purchase Orders tab on `/forecasting/purchase-orders` with summary cards, search/filter, CSV export, snapshot date selector, algorithm dropdown, and projection window picker.
- **Purchase Order Config**: `purchase_order_config` table (single global row, id='global') persists PO tab settings across sessions: `active_snapshot_date`, `active_projection_method` (default 'yoy'), `velocity_window_start`, `velocity_window_end`, `low_stock_threshold` (default 0), `default_lead_time`, `safety_stock_days` (default 0), `growth_factor_method` (default 'none'), `updated_at`. API: GET/PATCH `/api/purchase-orders/config`. Frontend auto-initializes state from config on load and persists changes.
- **Growth Factor Adjustment**: A dropdown in the PO toolbar (to the right of the projection algorithm selector) applies a per-SKU growth multiplier to projection columns client-side. Options: `none` (no adjustment), `trend` (trend_factor), `yoy` (yoy_growth_rate), `smart` (max of both). Growth factors are fetched from `GET /api/purchase-orders/growth-factors`, which queries GCP `sales_metrics_lookup` at `MAX(order_date)`, computing a weighted average (weighted by `daily_sales_quantity`) of `trend_factor` and `yoy_growth_rate` per SKU across all channels. Result is cached in Redis (`po:growth-factors`, 1-hour TTL). Multiplication is applied client-side: `adjDirect = round(proj_direct * factor)`, `adjKits = round(proj_kits * factor)`, `adjTotal = adjDirect + adjKits`, `rec_purchase = adjTotal − total_stock`. When a factor is active, the raw (unadjusted) value is shown in muted text below the adjusted value in each projection cell. The selected method is persisted to `purchase_order_config.growth_factor_method`.
- **Purchase Order SKU Notes**: `purchase_order_sku_notes` table (`sku` PK, `notes` text, `updated_at`). Stores per-SKU markdown notes that persist across snapshot dates. API: `GET /api/purchase-orders/sku-notes` (returns `Record<string,string>` map), `PUT /api/purchase-orders/sku-notes/:sku` (upserts). UI: "Notes" column (icon-only, first column in PO table) — `MessageSquare` icon filled/highlighted when notes exist, ghost when empty. Clicking opens a modal with Edit (monospace textarea) and Preview (react-markdown rendered) tabs. Package: `react-markdown`.
- **On-the-Fly Purchase Order Projections**: No stored projection values — projections are computed dynamically by `getSnapshot(date, method, windowStart, windowEnd)` via a LEFT JOIN subquery against `sales_forecasting` over the user-selected date range. Three algorithms, all rolling up via `COALESCE(parent_sku, sku)`:
  - **YoY**: `SUM(daily_sales_quantity)` + `SUM(kit_daily_sales_quantity)` — last year's actuals aligned to peak season
  - **14-Day Velocity**: `SUM(COALESCE(curr_daily_sales_quantity, 0))` + `SUM(COALESCE(curr_kit_daily_sales_quantity, 0))` — recent 14-day baseline rolling average; peak days contribute 0
  - **Smart Blend**: `SUM(COALESCE(curr_daily_sales_quantity, daily_sales_quantity))` — uses velocity for baseline days, YoY for peak days
  - API returns computed columns: `proj_direct`, `proj_kits`, `proj_total`, `rec_purchase` (= proj_total − total_stock). UI shows these 4 conditional columns when a projection window is selected. The algorithm dropdown and projection window dates are persisted to config automatically.
- **User Preferences System**: Generic namespace/key/JSONB-based `user_preferences` table with a reusable `useUserPreference<T>` hook for persisting per-user settings.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: Standardized data transformations for Shopify orders and ShipStation shipments.
- **Worker Coordination System**: Redis-backed mutex for coordinating poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines cursor-based polling and a Webhook Processing Queue for real-time events.
- **Event-Driven Lifecycle Architecture**: Redis-backed queue system for reliable lifecycle state transitions with automated side effects, deduplication, error isolation, and rate limiting.
- **Structured Logging**: Winston logger with `withOrder` helper for correlation context.
- **Correlation ID Standard**: Standardized identifiers (`orderNumber`, `shipmentId`, `sessionId`, etc.) for tracing.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling; lifecycle evaluation is gated until hold release to prevent race conditions.
- **Lifecycle State Machine**: `server/services/lifecycle-state-machine.ts` is the single source of truth for order status determination, preventing backward phase transitions.
- **Decision Subphase Chain**: A defined progression within `fulfillment_prep` ensures proper evaluation order and data integrity.
- **Kit Explosion Race Condition Prevention**: Multi-layered approach using caching, GCP sync, proactive hydration, and repair jobs.
- **Split/Merge Detection**: ETL service detects shipment item changes, triggering re-hydration and fingerprint recalculation.
- **Packing Completion Audit Logging**: All packing actions are logged.
- **Packing Error Handling**: Structured error responses.
- **Voided Label Handling**: Automatic new label creation, PDF validation, printing, and audit logging.
- **Product Categorization**: Distinction between kits and assembled products.
- **Master Products Page (`/skuvault-products`)**: Local single source of truth for product catalog, synced hourly.
- **Automated Package Assignment**: Two-table architecture (`fingerprints` and `fingerprint_models`) for learning and applying packaging rules.
- **Two-Tier Inventory Tracking System**: `skuvault_products` table uses `quantity_on_hand`, `pending_quantity`, `allocated_quantity`, and `available_quantity`.
- **Shipping Cost Tracking**: Actual carrier costs stored in `shipments.shipping_cost`.
- **Two Status Fields Contract**: `shipment_status` (ShipStation) and `status` (carrier tracking code) consistently managed by ETL.
- **ETL-Based Tracking Status Sync**: Tracking status is extracted during natural sync cycles.
- **Stale Shipment Audit**: Maintenance job to identify and handle stuck shipments.
- **ShipStation Write Queue**: PostgreSQL-backed queue for reliable, rate-limit-aware ShipStation shipment writes.
- **QC Explosion Queue**: PostgreSQL-backed queue (`qc_explosion_queue` table) for queue-driven QC hydration, replacing the former 60-second blind timer worker.

## External Dependencies
- **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
- **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and webhooks.
- **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning.
- **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
- **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
- **Neon Database**: Serverless PostgreSQL database for primary data storage.
- **GCP PostgreSQL**: Separate reporting database used for purchase order recommendations, inventory forecasting analytics, and sales forecasting. Key tables include `sales_metrics_lookup` and `peak_season_dates`.
- **Honeycomb**: Distributed tracing and metrics via OpenTelemetry (`server/instrumentation.ts`).