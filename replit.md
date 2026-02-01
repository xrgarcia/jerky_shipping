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
- **Event-Driven Lifecycle Architecture**: Redis-backed queue system for reliable lifecycle state transitions with automated side effects.
    - **Why We Built It**: Decouples lifecycle evaluation from synchronous producers, enabling reliable side effects (like automatic rate checks), better error isolation, rate limiting to prevent API exhaustion, and centralized observability via the Operations Dashboard. Previously, lifecycle updates were scattered across many files with inconsistent error handling.
    - **Key Files**:
      - `server/lifecycle-event-worker.ts` - Queue consumer that processes lifecycle events and executes side effects
      - `server/services/lifecycle-service.ts` - Exposes `queueLifecycleEvaluation()` for producers
      - `server/services/lifecycle-state-machine.ts` - Pure logic that determines correct phase based on shipment state (no side effects)
      - `server/utils/queue.ts` - Redis queue primitives and `LifecycleEventReason` type
    - **Architecture Separation**: The state machine only *determines* what phase a shipment should be in (pure logic, no actions). The worker *executes* side effects based on the state machine's result. This separation keeps the state machine testable and predictable while allowing the worker to handle complex async operations like API calls.
    - **Queue Features**: FIFO processing, deduplication by shipmentId (prevents duplicate evaluations), retry with exponential backoff (max 3 attempts), 1-hour expiry on in-flight set to prevent stuck events
    - **Rate Limiting**: Processes 5 rate checks per worker cycle with 500ms delay between side effects to avoid ShipStation API exhaustion
    - **Side Effect Registry**: Automated actions triggered by state transitions:
      - `needs_rate_check` subphase → Triggers smart carrier rate analysis automatically
      - Future side effects can be added by registering handlers in the worker
    - **Producers** (all push to `queueLifecycleEvaluation()`):
      - `server/services/shipstation-shipment-etl-service.ts` - After ETL transforms shipment data
      - `server/unified-shipment-sync-worker.ts` - After sync worker updates shipments
      - `server/services/qc-item-hydrator.ts` - After hydrating QC items
      - `server/webhooks.ts` - After processing ShipStation webhooks
      - `server/background-worker.ts` - After processing tracking webhooks (reason: `webhook_tracking`)
      - `server/services/smart-carrier-rate-service.ts` - After completing rate analysis (reason: `rate_analysis`)
      - `server/lifecycle-repair-worker.ts` - Batch lifecycle repairs (reason: `lifecycle_repair`)
    - **Consumer**: Lifecycle event worker (`server/lifecycle-event-worker.ts`) polls queue, runs state machine, triggers registered side effects
    - **Event Reasons** (for logging/debugging):
      - `webhook` - ShipStation webhook triggered update
      - `webhook_tracking` - ShipStation tracking webhook update
      - `shipment_sync` - Unified shipment sync worker
      - `categorization` - Product categorized
      - `fingerprint` - Fingerprint assigned
      - `packaging` - Packaging type assigned
      - `session` - Added to fulfillment session
      - `rate_check` - Rate check triggered
      - `rate_analysis` - Smart carrier rate analysis completed
      - `lifecycle_repair` - Lifecycle repair worker batch operation
      - `manual` - Manual trigger from UI
      - `backfill` - Batch backfill operation
    - **Synchronous Exception**: Only `firestore-session-sync-worker.ts` uses synchronous lifecycle updates (via `updateShipmentLifecycle()`) because it requires pre-update shipmentData to detect session transitions
    - **Monitoring**: Operations Dashboard (`/operations`) shows real-time queue depth, worker status, and processing metrics via WebSocket updates

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling.
- **Tag Refresh Job**: Periodic re-validation of ShipStation tags for shipments in `ready_to_session` and `awaiting_decisions` phases. Runs after main poll cycle when caught up. Required because ShipStation's `modified_at` cursor doesn't update when only tags change.
- **Sessionable Order Status**: The lifecycle state machine treats only `pending` shipment status as valid for `READY_TO_SESSION` phase. The `on_hold` status indicates orders that are BEFORE fulfillment starts (waiting in ShipStation queue), while `pending` indicates orders ready to be sessioned.
- **Lifecycle State Machine Documentation**: See `life_cycle_states_legacy.md` for comparison of the legacy SQL-based tab criteria vs. the current state machine approach. The state machine (`server/services/lifecycle-state-machine.ts`) is the single source of truth for order status determination.
- **Kit Explosion Race Condition Prevention**: Multi-layered approach to ensure kits are properly exploded into component SKUs:
    1. **Lazy-Loading Kit Cache**: `isKit()` and `getKitComponents()` are async functions that use a cache-first pattern with automatic DB fallback on cache miss. Negative caching prevents repeated DB lookups for non-kit SKUs.
    2. **Hourly GCP Sync**: `syncKitMappingsFromGcp()` runs hourly to populate the cache with all kit mappings from the reporting database, with cache invalidation for updated SKUs.
    3. **Proactive Hydration in Session Sync**: When Firestore session sync sets `session_status`, checks if QC items exist and hydrates if missing. Catches shipments that bypass normal hydration flow.
    4. **Repair Job Endpoint**: `POST /api/collections/repair-unexploded-kits` detects and fixes shipments with un-exploded kit SKUs by deleting QC items and re-running hydration.
- **Split/Merge Detection**: The ETL service detects when shipment items change (due to order splits or merges in ShipStation) by comparing incoming items against existing ones using a normalized "SKU:QTY" fingerprint. When changes are detected:
    1. Existing `shipment_qc_items` are deleted to trigger re-hydration
    2. The `fingerprintId` is reset to null for re-calculation
    3. Changes are logged with old/new item fingerprints for debugging
- **Packing Completion Audit Logging**: All packing actions logged to `packing_logs` table.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}` for user guidance.
- **Voided Label Handling**: Automatic new label creation, PDF validation, printing to requesting worker's station, audit logging, and QC cache invalidation.
- **QC Completion Tracking**: `shipments.qc_completed` boolean flag and `qc_completed_at` timestamp.
- **ShipStation Label Creation Endpoints**: Differentiates between creating labels for existing and new shipments.
- **Product Categorization (Kits vs. Assembled Products)**: Distinction based on whether products are exploded into components in SkuVault's QC Sale API. A QC Validation Report identifies miscategorized products.
- **Master Products Page (`/skuvault-products`)**: Local single source of truth for product catalog data (`skuvault_products` table), synced hourly from a GCP reporting database via a 3-way merge strategy.
- **Packaging Types Sync Worker**: Hourly sync from ShipStation `/v2/packages` endpoint. Matches by `package_id` first (ShipStation's unique identifier), falls back to name matching for initial backfill. Only inserts/updates - never deletes. Preserves local `id`, `is_active`, and `stationType` fields.
    - **Two-Tier Inventory Tracking System**: Prevents premature inventory deduction so higher-priority orders don't show "out of stock" before warehouse managers build picking sessions. The `skuvault_products` table has four inventory fields:
      - `quantity_on_hand`: Snapshot from SkuVault (read-only, reset on daily sync)
      - `pending_quantity`: Orders hydrated but NOT yet in a session (does NOT reduce availability)
      - `allocated_quantity`: Orders actively in picking sessions (DOES reduce availability)
      - `available_quantity`: `quantity_on_hand - allocated_quantity` (what's truly available for new sessions)
    - **Inventory Flow**:
      1. **Order hydration** (`qc-item-hydrator.ts`): Increments `pending_quantity` only - availability unchanged
      2. **Session creation** (`firestore-session-sync-worker.ts`): Moves quantities from `pending` → `allocated`, decrements `available_quantity`
      3. **Daily sync** (`skuvault-products-sync-service.ts`): Resets all quantities to fresh SkuVault data (`pending_quantity` and `allocated_quantity` → 0)
- **PO Recommendations Page (`/po-recommendations`)**: Displays inventory forecasts, holiday planning, supplier filtering, and lead time considerations based on `vw_po_recommendations` from the reporting database.
- **Shipping Cost Tracking**: Actual carrier costs extracted from ShipStation labels API (`labels[0].shipment_cost.amount`) and stored in `shipments.shipping_cost`. This is what the company pays to carriers for label creation, distinct from customer-paid shipping which is stored in `shopify_orders.shipping_cost`. Enables cost analysis and margin calculations.

## External Dependencies
- **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
- **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and webhooks.
- **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, including automatic authentication, Redis-backed token caching, and a QCSale Cache Warmer Service.
- **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
- **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
- **Neon Database**: Serverless PostgreSQL database for primary data storage.
- **GCP PostgreSQL**: Separate reporting database used for purchase order recommendations and inventory forecasting analytics.