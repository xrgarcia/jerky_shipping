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
- **Sales Forecasting System**: The Forecasting page (`/forecasting`) displays sales data from the GCP reporting database with interactive filtering (channels, products, date ranges, categories, event types, assembled products, peak season). Features 5 chart types: Sales Revenue by Channel breakdown, Total Daily Sales Revenue YoY, Total Units Sold YoY, Kit Revenue YoY, Kit Units YoY. Summary metric cards show per-channel YoY Growth/Trend/Confidence. Chart annotations support click-to-add notes with timestamps and author tracking (stored in local Neon DB `chart_notes` table, NOT cached). All forecasting query data is cached in Upstash Redis with 1-hour TTL. Dates are stored and displayed in US Central time to match company operations.
- **Sales Forecasting Projection**: A `sales_forecasting` table in the local Neon database mirrors the `sales_metrics_lookup` schema. A daily job reads last year's actuals from `sales_metrics_lookup` and writes them as forecast rows projected 1 year into the future. Peak season date mapping uses `peak_season_dates` to compare peak-to-peak across years (since floating holidays like Father's Day and Easter shift dates year-to-year). All four peak seasons are mapped: Christmas, Father's Day, Easter, and Valentine's Day. Non-peak (baseline) dates use same-calendar-date comparison. YoY fields in forecast rows are set equal to current-year values (growth factor = 1.0) so projected charts appear flat. When a user selects a future date range on the Forecasting page, queries transparently pull from `sales_forecasting` instead of `sales_metrics_lookup`.
- **User Preferences System**: Generic namespace/key/JSONB-based `user_preferences` table with unique constraint on (userId, namespace, key). Reusable `useUserPreference<T>` hook (`client/src/hooks/use-user-preference.ts`) with debounced auto-save. API routes at `/api/user-preferences/:namespace/:key`. Used by Forecasting page to persist time range and channel selections. Available site-wide for any feature needing per-user settings.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: Standardized data transformations for Shopify orders and ShipStation shipments.
- **Worker Coordination System**: Redis-backed mutex for production-ready coordination of poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines cursor-based polling and a Webhook Processing Queue for real-time events.
- **Event-Driven Lifecycle Architecture**: Redis-backed queue system for reliable lifecycle state transitions with automated side effects, decoupled evaluation, error isolation, rate limiting, and centralized observability. Deduplication uses compound key `shipmentId:reason` so the same shipment can have multiple events queued for different reasons (e.g., `packaging` won't be dropped if `shipment_sync` is already queued).
- **Structured Logging**: Winston logger (`server/utils/logger.ts`) with `LOG_LEVEL` env var (default: `info`). Set to `debug` for full payload diagnostics. Uses `withOrder(orderNumber, shipmentId?, extras?)` helper for correlation context on every order-related log line.
- **Correlation ID Standard**: All log lines that touch an order/shipment include standardized correlation IDs so you can trace an order's full journey by searching for its order number. Standard identifiers:
  - `orderNumber` — unique order identifier across all sales channels (DB field: `name`)
  - `shipmentId` — ShipStation's unique shipment identifier (e.g. `se-123456`)
  - `sessionId` — SkuVault wave picking session ID
  - `localSessionId` — this system's session ID (groups orders for picking/packing)
  - `sku` — unique product identifier across all sales channels
  - `trackingNumber` — carrier tracking number for labeled shipments
  - `fingerprintId` — item-signature ID for packaging assignment
  - `workstationId` — packing station handling the order
  - `user` — warehouse staff member email performing the action
  - `queueItemId` — ShipStation write queue entry ID
  - `lifecyclePhase` / `subphase` — current pipeline position

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling. Lifecycle evaluation is gated in the ETL: new shipments skip lifecycle evaluation until their hold is released (on_hold → pending transition), which is the warehouse manager's signal that the order is ready to work. This prevents race conditions where the pipeline (QC explosion, package sync) fires before ShipStation's automation rules complete (~4 min after import). Fallback: if a shipment stays pending for 10+ minutes without ever hitting on_hold, lifecycle evaluation fires anyway.
- **Lifecycle State Machine**: `server/services/lifecycle-state-machine.ts` is the single source of truth for order status determination, with clear definitions for phases, subphases, and terminal states. Prevents backward phase transitions.
- **Decision Subphase Chain**: Within `fulfillment_prep`, a defined progression (`needs_hydration` → `needs_categorization` → `needs_fingerprint` → `needs_packaging` → `needs_rate_check` → `needs_session`) ensures proper evaluation order and hard gates for data integrity.
- **Kit Explosion Race Condition Prevention**: Multi-layered approach using caching, GCP sync, proactive hydration, and repair jobs.
- **Split/Merge Detection**: ETL service detects shipment item changes, triggering re-hydration and fingerprint recalculation.
- **Packing Completion Audit Logging**: All packing actions are logged.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}`.
- **Voided Label Handling**: Automatic new label creation, PDF validation, printing, and audit logging.
- **Product Categorization**: Distinction between kits (exploded into components at hydration) and assembled products (exploded only when out of stock).
- **Master Products Page (`/skuvault-products`)**: Local single source of truth for product catalog, synced hourly.
- **Automated Package Assignment**: Two-table architecture (`fingerprints` and `fingerprint_models`) for learning and applying packaging rules.
- **Two-Tier Inventory Tracking System**: `skuvault_products` table uses `quantity_on_hand`, `pending_quantity`, `allocated_quantity`, and `available_quantity`.
- **Shipping Cost Tracking**: Actual carrier costs stored in `shipments.shipping_cost`.
- **Two Status Fields Contract**: `shipment_status` (ShipStation's lifecycle) and `status` (carrier tracking code) are consistently managed by the ETL.
- **ETL-Based Tracking Status Sync**: Tracking status is extracted during natural sync cycles.
- **Stale Shipment Audit**: Maintenance job to identify and handle shipments stuck in pre-shipping phases or orphaned in ShipStation.
- **ShipStation Write Queue**: PostgreSQL-backed queue for reliable, rate-limit-aware ShipStation shipment writes with PATCH semantics, exponential backoff, and dead-lettering.
- **QC Explosion Queue**: PostgreSQL-backed queue (`qc_explosion_queue` table) for queue-driven QC hydration, replacing the former 60-second blind timer worker. Triggered by the lifecycle state machine's `needs_hydration` side effect. Features: deduplication, exponential backoff retry (handles race condition where ETL writes shipment before items), dead-lettering, lifecycle re-evaluation on success, and monitoring via the QC Explosion tab on the Lifecycle Phases page.

## External Dependencies
- **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
- **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and webhooks.
- **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, including automatic authentication, Redis-backed token caching, and a QCSale Cache Warmer Service.
- **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
- **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
- **Neon Database**: Serverless PostgreSQL database for primary data storage.
- **GCP PostgreSQL**: Separate reporting database used for purchase order recommendations, inventory forecasting analytics, and sales forecasting. Connected via `server/reporting-db.ts` using `REPORTING_DATABASE_URL` env var. Key tables:
  - **`sales_metrics_lookup`**: Materialized view refreshed daily, backfilled for the last 30 days (to account for refunds). All dates stored in US Central time. Contains per-SKU, per-channel, per-day sales data. Columns include: `sku`, `order_date`, `sales_channel`, `daily_sales_quantity`, `daily_sales_revenue`, `kit_daily_sales_quantity`, `kit_daily_sales_revenue`, `yoy_daily_sales_quantity`, `yoy_daily_sales_revenue`, `yoy_kit_daily_sales_quantity`, `yoy_kit_daily_sales_revenue`, `yoy_growth_factor`, `yoy_kit_growth_factor`, `trend_factor`, `confidence_level`, `calculated_confidence_factor`, `velocity_7_day`, `velocity_14_day`, `velocity_30_day`, `sales_1_to_14_days`, `sales_15_to_44_days`, `sales_45_to_74_days`, `sales_75_to_104_days`, `event_type`, `event_date`, `event_window_sales`, `event_ly_window_sales`, `is_peak_season`, `peak_season_name`, `days_to_peak`, `days_since_peak`, `peak_velocity_ratio`, `velocity_stability_score`, `growth_pattern_confidence`, `is_assembled_product`, `category`, `yoy_start_date`, `yoy_end_date`, `yoy_units_sold`, `yoy_revenue_sold`, `yoy_kit_units_sold`, `yoy_kit_revenue_sold`, `kit_sales_1_to_14_days`, `title`, `calculation_date`, `last_updated`.
  - **`peak_season_dates`**: Tracks peak season windows per year. Four peak seasons defined by `peak_season_types`: (1) Christmas — fixed, Nov 15–Dec 31, 47 days; (2) Father's Day — floating, 4 weeks before 3rd Sunday in June, 28 days; (3) Easter — floating, 3 weeks before Easter Sunday via Butcher's Algorithm, 21 days; (4) Valentine's Day — fixed, Jan 24–Feb 14, 21 days. Floating holidays (Father's Day, Easter) shift dates year-to-year, so peak-to-peak comparison across years is essential (aligned by position within peak window, not same-calendar-date). Already projected through 2028. Columns include: `id`, `peak_season_type_id` (1=Christmas, 2=Father's Day, 3=Easter, 4=Valentine's Day), `year`, `start_date`, `end_date`, `actual_peak_date`, `notes`, `avg_lead_time_days`, `total_units_sold`, `total_revenue`, `yoy_units_growth_rate`, `yoy_revenue_growth_rate`, `growth_factor`, `confidence_score`, `risk_level`, and purchasing recommendation fields. Note: `confidence_score` is currently `0.00` and `risk_level` is `HIGH` for all rows (known data quality gap — needs more historical PO data). Sales performance fields (`total_units_sold`, `total_revenue`, etc.) are NULL (disabled, redundant with `sales_metrics_lookup`).
- **Honeycomb**: Distributed tracing and metrics via OpenTelemetry (`server/instrumentation.ts`). Auto-instruments Express HTTP, pg database queries, and outbound HTTP. Service name: `ship-warehouse`.