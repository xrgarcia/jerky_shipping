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
- **Sales Forecasting Projection**: A daily job projects last year's actuals into the `sales_forecasting` table, aligning peak seasons using `peak_season_dates`. Includes product enrichment fields like `is_kit`, `is_assembled_product`, `parent_sku`, and `parent_kit`.
- **Purchase Order Snapshots**: `purchase_order_snapshots` table (composite key: stock_check_date + sku) merges `skuvault_products` with `inventory_forecasts_daily` (IFD) from the GCP reporting DB. Snapshots are created on-demand when IFD and internal_inventory dates match and are newer than the latest local snapshot. Service: `server/services/purchase-order-snapshot-service.ts`. API: `/api/purchase-orders/{readiness,create-snapshot,dates,snapshot,project-sales,clear-projection}`. UI: Purchase Orders tab on `/forecasting/purchase-orders` with summary cards, search/filter, CSV export, snapshot date selector, and sales projection.
- **Sales Projection (Purchase Orders)**: User picks a future date via calendar; backend aggregates `sales_forecasting.daily_sales_quantity` and `kit_daily_sales_quantity` from today through that date, rolling up variants via `COALESCE(parent_sku, sku)`. Results stored in `projected_units_sold`, `projected_units_sold_from_kits`, and `sales_projection_date` columns on the snapshot. UI shows 3 conditional columns (Proj. Direct, Proj. Kits, Proj. Total) and includes them in CSV export.
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