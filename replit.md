# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool integrated with Shopify for managing ship.jerky.com orders. It aims to enhance order processing and inventory management through real-time synchronization, a user-friendly interface for warehouse staff, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time order status updates. The project seeks to improve operational efficiency and provide a robust platform for e-commerce fulfillment.

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
    - **Packing Page**: Single-warehouse MVP with SkuVault QC validation, scan-first workflow, individual unit scanning, and audit trails, supporting kit/assembled products.
    - **Shipment Management**: Unified shipments page with dual-view mode:
        - **Workflow View**: Business process tabs (In Progress, Packing Queue, Shipped, All) for traditional fulfillment stages.
        - **Lifecycle View**: 6 warehouse flow tabs matching the actual process - All Shipments (default), Ready to Pick (new sessions), Picking (active sessions), Packing Ready (closed + no tracking, cache is warmed), On the Dock (closed + tracking + in-transit), Picking Issues (inactive sessions flagged for supervisor attention).
    - **Order Backfill System**: Fault-tolerant, task-based architecture for historical Shopify orders and ShipStation shipments, using Redis-queued processing and WebSocket updates.
    - **Reporting & Analytics**: Business analytics dashboard (Gross Sales, Net Sales) and PO Recommendations page querying a separate GCP PostgreSQL database.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing with background worker, retry logic, and browser auto-print.
    - **Desktop Printing System**: A three-tier architecture enabling native Windows printing with a dedicated Electron app for secure Google OAuth, WebSocket connectivity, station management, and remote configuration.
        - **Unified SumatraPDF Printing**: All printers use a bundled SumatraPDF.exe (v3.5.2, GPL-3 licensed) for consistent label printing. This follows ShipStation Connect's proven approach. Production path: `process.resourcesPath/bin/SumatraPDF.exe`. Dev path: `binaries/win/SumatraPDF.exe`. Command: `-print-to [printer] -silent [pdf]`.
        - **Temp File Management**: Labels are saved to `os.tmpdir()/jerky-ship-connect/label-{jobId}.pdf` with automatic cleanup after successful printing.
        - **WebSocket Connection Reliability**: Connection status shows 'connecting' until server authentication completes (not just socket open). Station subscription handles session/auth timing races via reactive subscription in updateState() and pendingStationSubscription queuing. Server logs detailed auth failure diagnostics for debugging.
    - **Web-based Stations Management**: CRUD interface at `/stations` with real-time connection status.
    - **Real-Time Updates**: WebSocket server provides live updates for orders, queues, and print status.
    - **Saved Views System**: Customizable column views for the PO Recommendations page.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: `ShopifyOrderETLService` and `ShipStationShipmentETLService` classes standardize data transformations.
- **Worker Coordination System**: Redis-backed mutex for production-ready coordination of poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines a cursor-based Unified Shipment Sync Worker for scheduled polling and a Webhook Processing Queue for real-time events to ensure 100% accurate ShipStation data.
    - **Webhook Processing Queue Priority System**: Two-tier priority system (high/low) to prevent webhook starvation.
- **Shopify → ShipStation Sync**: Shopify webhooks do NOT trigger ShipStation API calls; ShipStation data comes exclusively from ShipStation webhooks.
- **Unified Shipment Sync Worker Details**: Cursor-based sync with dynamic overlap, 7-day lookback, failure-safe advancement, immediate webhook triggers, and tracking backfill for unshipped orders.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling.
- **Packing Completion Audit Logging**: All packing actions are logged to the `packing_logs` table.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}` for user guidance.
- **ShipStation Label Creation Endpoints**: Differentiates between creating labels for existing shipments (`/v2/labels/shipment/{shipment_id}`) and new shipments (`/v2/labels`).

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling. Supported webhooks: `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch`. Uses `modified_at_start` and `modified_at_end` for date filtering.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, featuring automatic authentication, Redis-backed token caching, and a discriminated union type system.
    - **Kit Component Quantities**: SkuVault's `KitProducts[].Quantity` field is already the TOTAL quantity needed (pre-multiplied by kit quantity ordered). Do NOT multiply by parent kit quantity again. Example: Kit ordered x2 with 2 components (qty 1 each per kit) → each component's Quantity = 2.
    - **Kit Barcode Cache**: When building the barcode lookup cache, parent kit SKUs are excluded since only component barcodes are scannable. The cache only contains entries for individual components.
    - **Warehouse Session Lifecycle**: Deep understanding of SkuVault session statuses (`new`, `active`, `inactive`, `closed`) to manage picking, packing, and flagging for attention. Session flow: new (pick queue) → active (picking) → inactive (stuck/paused, FLAG) → closed+no tracking (WARM CACHE) → closed+has tracking (INVALIDATE CACHE).
    - **QCSale Cache Warmer Service**: Proactively pre-loads SkuVault QC Sale data AND shipment data for orders ready to be packed (sessionStatus='closed', trackingNumber IS NULL).
        - **Extended TTL**: 48-hour TTL for warmed entries to maximize cache hits during work shifts.
        - **Background Polling**: 30-second polling interval catches any orders missed by session sync triggers.
        - **Immediate Warming**: Hooks into Firestore session sync to warm cache immediately when sessions transition to 'closed' status. The sync worker uses a closed-session detection algorithm that compares DB non-closed sessions with current Firestore state to catch sessions that disappear from the active query (transitioned to closed). Uses `session.order_number` from Firestore as the authoritative source for order numbers.
        - **Shipment Data Caching**: Stores carrier, address, weight, dimensions, status, and sessionStatus alongside QCSale data to eliminate PostgreSQL queries during packing.
        - **Legacy Cache Upgrade**: Automatically detects cache entries missing the 'shipment' key (legacy format) and upgrades them on-demand with shipment data. Uses `!('shipment' in parsed)` to distinguish legacy entries from new entries with `shipment: null`.
        - **Cache Structure**: `{ saleId, orderNumber, lookupMap, qcSale, shipment: { carrier, address, weight, dimensions, status, tracking, sessionStatus, cacheWarmedAt } }`.
        - **Cache Invalidation**: Automatic invalidation when labels are created (tracking number assigned).
        - **Manual Refresh**: Refresh button on packing page for customer service order changes (gated to sessionStatus='closed' AND no trackingNumber).
        - **Metrics Tracking**: GET /api/operations/cache-warmer-status provides ordersWarmed, cacheHits, cacheMisses, invalidations, manualRefreshes, apiCallsSaved.
        - **API Endpoints**: POST /api/packing/refresh-cache/:orderNumber, GET /api/operations/cache-warmer-status, GET /api/operations/inactive-sessions.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
-   **Neon Database**: Serverless PostgreSQL database.
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.