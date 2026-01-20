# Warehouse Fulfillment Application

## Overview
This application (ship.) is the warehouse fulfillment tool for jerky.com, integrated with Shopify for order management. Its primary purpose is to enhance order processing and inventory management through real-time synchronization, a user-friendly interface for warehouse staff, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time order status updates. The project aims to improve operational efficiency and provide a robust platform for e-commerce fulfillment.

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
    - **Packing Page**: Supports both boxing (QC before print) and bagging (immediate print on scan) workflows with SkuVault QC validation, scan-first, individual unit scanning, and audit trails. Includes robust error handling for printing failures and printer pre-checks.
    - **Workstation Guard System**: Prevents packing at incorrect physical workstations using browser local storage for station ID tracking.
    - **Shipment Management**: Unified shipments page with Lifecycle, Workflow, and All shipments views.
    - **Order Backfill System**: Fault-tolerant, Redis-queued processing for historical Shopify orders and ShipStation shipments with WebSocket updates.
    - **Reporting & Analytics**: Business analytics dashboard, PO Recommendations page, and Packed Shipments Report with timing analytics.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing with background worker, retry logic, and browser auto-print.
    - **Desktop Printing System**: Three-tier architecture using an Electron app for native Windows printing with SumatraPDF.
    - **Web-based Stations Management**: CRUD interface at `/stations` with real-time connection status.
    - **Real-Time Updates**: WebSocket server for live updates on orders, queues, and print status.
    - **Saved Views System**: Customizable column views for the PO Recommendations page.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: Standardized data transformations for Shopify orders and ShipStation shipments.
- **Worker Coordination System**: Redis-backed mutex for production-ready coordination of poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines a cursor-based Unified Shipment Sync Worker for scheduled polling and a Webhook Processing Queue for real-time events.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling.
- **Tag Refresh Job**: Periodic re-validation of ShipStation tags for shipments in `ready_to_session` and `awaiting_decisions` phases. Runs after main poll cycle when caught up. Required because ShipStation's `modified_at` cursor doesn't update when only tags change.
- **Sessionable Order Status**: The lifecycle state machine treats only `pending` shipment status as valid for `READY_TO_SESSION` phase. The `on_hold` status indicates orders that are BEFORE fulfillment starts (waiting in ShipStation queue), while `pending` indicates orders ready to be sessioned.
- **Lifecycle State Machine Documentation**: See `life_cycle_states_legacy.md` for comparison of the legacy SQL-based tab criteria vs. the current state machine approach. The state machine (`server/services/lifecycle-state-machine.ts`) is the single source of truth for order status determination.
- **Kit Explosion Race Condition Prevention**: Multi-layered approach to ensure kits are properly exploded into component SKUs:
    1. **Kit Mappings Cache Age Check**: `ensureKitMappingsFresh()` checks cache age and forces reload if >5 minutes old, preventing stale mappings.
    2. **Proactive Hydration in Session Sync**: When Firestore session sync sets `session_status`, checks if QC items exist and hydrates if missing. Catches shipments that bypass normal hydration flow.
    3. **Repair Job Endpoint**: `POST /api/collections/repair-unexploded-kits` detects and fixes shipments with un-exploded kit SKUs by deleting QC items and re-running hydration with fresh mappings.
- **Packing Completion Audit Logging**: All packing actions logged to `packing_logs` table.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}` for user guidance.
- **Voided Label Handling**: Automatic new label creation, PDF validation, printing to requesting worker's station, audit logging, and QC cache invalidation.
- **QC Completion Tracking**: `shipments.qc_completed` boolean flag and `qc_completed_at` timestamp.
- **ShipStation Label Creation Endpoints**: Differentiates between creating labels for existing and new shipments.
- **Product Categorization (Kits vs. Assembled Products)**: Distinction based on whether products are exploded into components in SkuVault's QC Sale API. A QC Validation Report identifies miscategorized products.
- **Master Products Page (`/skuvault-products`)**: Local single source of truth for product catalog data (`skuvault_products` table), synced hourly from a GCP reporting database via a 3-way merge strategy.
    - **Real-Time Inventory Tracking**: `skuvault_products` now has two inventory fields:
      - `quantity_on_hand`: Snapshot from SkuVault (read-only, reset on daily sync)
      - `available_quantity`: Starts equal to `quantity_on_hand`, decremented when QC explosion creates items for pending orders. Reset on each daily sync.
- **PO Recommendations Page (`/po-recommendations`)**: Displays inventory forecasts, holiday planning, supplier filtering, and lead time considerations based on `vw_po_recommendations` from the reporting database.
- **Background Job System for Session Building**: Long-running session builds (90+ seconds due to SkuVault API calls) use a database-backed job system with real-time WebSocket progress updates. Features:
    - 5-step progress tracking: Finding orders → Grouping by station → Fetching SkuVault sale IDs → Creating sessions → Syncing to Firestore
    - Jobs persist across browser disconnects (job continues server-side)
    - Build button disabled during active job, re-enabled on failure for retry
    - Automatic redirect to Live tab on successful completion
    - Uses `background_jobs` table and `broadcastJobProgress()` WebSocket function

## External Dependencies
- **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
- **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and webhooks.
- **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, including automatic authentication, Redis-backed token caching, and a QCSale Cache Warmer Service.
- **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
- **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
- **Neon Database**: Serverless PostgreSQL database for primary data storage.
- **GCP PostgreSQL**: Separate reporting database used for purchase order recommendations and inventory forecasting analytics.