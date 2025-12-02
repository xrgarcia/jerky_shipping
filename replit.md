# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool designed to integrate with Shopify for managing orders for ship.jerky.com. It aims to enhance order processing and inventory management through features like real-time synchronization, a user-friendly interface for warehouse staff, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time order status updates via WebSockets. The project's vision is to significantly improve operational efficiency and provide a robust platform for e-commerce fulfillment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture
### UI/UX Decisions
The UI/UX employs a warm earth-tone palette and large typography for optimal readability in a warehouse environment. It utilizes `shadcn/ui` (New York style variant) built on Radix UI and styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: Developed with React, TypeScript, Vite, Wouter for routing, and TanStack Query for server state management.
- **Backend**: Implemented using Express.js with Node.js and TypeScript, exposing a RESTful API. Drizzle ORM handles database interactions.
- **Authentication**: Google OAuth (restricted to @jerky.com domain) with secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL (via Neon serverless connection) with Drizzle Kit for migrations. The schema includes users, authentication, orders, products, product variants, order items, and normalized SkuVault session data.
- **Core Features**:
    - **Order Management**: Synchronized product catalog, SkuVault wave picking session display, and QC integration for packing.
    - **Packing Page**: Single-warehouse MVP with SkuVault QC validation, scan-first workflow, individual unit scanning, and audit trails. Includes daily station selection, action gating, session validation, and comprehensive support for kit/assembled products.
    - **Shipment Management**: Unified shipments page with workflow tabs (In Progress, Packing Queue, Shipped, All), inline session info, and dual-ID routing for API endpoints.
    - **Order Backfill System**: Fault-tolerant, task-based architecture for historical Shopify orders and ShipStation shipments, utilizing Redis-queued processing and WebSocket updates.
    - **Reporting & Analytics**: Business analytics dashboard (Gross Sales, Net Sales) and PO Recommendations page querying a separate GCP PostgreSQL database.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing with background worker, retry logic, and browser auto-print.
    - **Desktop Printing System**: A three-tier architecture enabling native macOS printing, comprising database schemas for stations, printers, and jobs; REST API endpoints (`/api/desktop/*`); Google OAuth-based authentication for desktop apps; station sessions; and isolated WebSocket communication (`/ws/desktop`).
        - **Electron App**: A React-based desktop application handling secure Google OAuth (PKCE), token persistence in macOS Keychain, robust WebSocket connectivity with automatic token refresh, station management, printer discovery, print job queue management, session persistence, environment switching, graceful shutdown, and remote configuration ("Mars Rover" Control) for dynamic timing settings. Includes silent token refresh to survive server restarts without manual intervention (requires one-time re-login after update to capture refresh token).
    - **Web-based Stations Management**: CRUD interface at `/stations` with real-time connection status tracking and automatic termination of desktop sessions on station deletion.
    - **Real-Time Updates**: WebSocket server provides live updates for orders, queues, print status, and notifications.
    - **Saved Views System**: Customizable column views for the PO Recommendations page.
- **Monorepo Structure**: Client, server, and shared code are co-located.
- **Centralized ETL Architecture**: `ShopifyOrderETLService` and `ShipStationShipmentETLService` classes standardize data transformations.
- **Worker Coordination System**: Production-ready coordination for poll workers and backfill jobs using Redis-backed mutex.
- **Dual Shipment Sync Architecture**: Two complementary systems ensure 100% accurate ShipStation data:
    1. **Unified Shipment Sync Worker** (cursor-based polling): Systematically polls ShipStation API on a schedule to catch all changes. Uses cursor stored in `sync_cursors` table for crash-safe recovery. This is the primary mechanism for ensuring complete data coverage.
    2. **Webhook Processing Queue** (real-time events): Processes ShipStation webhook events as they arrive for sub-minute freshness. Handles tracking updates, fulfillment events, and manual triggers. See `shipment-sync-worker.ts`.
- **Webhook Processing Queue Priority System**: The webhook queue uses a two-tier priority system to prevent webhook starvation:
    - **High Priority** (`shipstation:shipment-sync:high`): Webhooks (often have inline data, skip API calls), backfill, and manual triggers
    - **Low Priority** (`shipstation:shipment-sync:low`): Reverse sync messages (always require API calls for verification)
    - Worker dequeues from high priority first, then low, ensuring webhooks are processed promptly even during reverse sync cycles
    - Requeue function preserves FIFO ordering within each priority level using RPUSH with reverse
- **Shopify → ShipStation Sync DISABLED**: Shopify webhooks do NOT trigger ShipStation API calls. ShipStation data comes exclusively from ShipStation webhooks. This prevents queue flooding when Shopify order volume is high.
- **Unified Shipment Sync Worker Details** (Dec 2025): Part of the Dual Shipment Sync Architecture (see above). Implementation details:
    - **Cursor-based sync**: Uses `sync_cursors` table to track last processed `modified_at` timestamp
    - **7-day lookback**: Initial cursor starts 168 hours in the past for comprehensive catch-up
    - **Dynamic overlap**: 30-second overlap when caught up, no overlap when catching up to ensure forward progress
    - **Failure-safe advancement**: Cursor caps at earliest failed shipment, guaranteeing retry on next poll
    - **Immediate webhook triggers**: ShipStation webhooks wake idle worker for sub-minute freshness
    - **MAX_PAGES handling**: When 10 pages processed, schedules 1-second follow-up to continue
    - **Credential detection**: Gracefully detects missing SHIPSTATION_API_SECRET and surfaces in Operations dashboard
    - **Tracking Backfill**: After each poll cycle (when not catching up), fetches 10 shipments with `status='shipped'` but no tracking that are older than 48 hours. Excludes shipments with `shipment_status='label_purchased'` or `on_hold` since those legitimately don't have tracking yet. Updates their data from ShipStation API.
    - API endpoints: `/api/operations/unified-sync-status`, `/api/operations/trigger-unified-sync`, `/api/operations/force-unified-resync`
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics for all coordinator operations.
- **On-Hold Shipment Handling**: ShipStation does not provide webhooks for hold status changes (V2 API only supports 4 events: `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch`). The Unified Shipment Sync Worker handles on-hold status changes via its cursor-based polling - any shipment that gets put on hold or released from hold will have its `modified_at` timestamp updated, which the worker will catch on its next poll cycle.
- **Packing Completion Audit Logging**: The packing completion endpoint (`POST /api/packing/complete`) logs all actions to the `packing_logs` table:
    - `complete_order_start` - Initial request with shipment ID and station
    - `fetch_existing_labels` / `label_fetched_existing` - Label lookup from ShipStation
    - `label_create_attempt` / `label_created` - New label creation
    - `label_creation_error` - Label creation failures with full error details
    - `complete_order_success` - Successful completion with print job ID
    - `complete_order_failed` / `complete_order_unexpected_error` - All failure paths with actionable error codes
- **Packing Error Handling**: All packing completion errors return structured responses with `{code, message, resolution}` for user-actionable guidance. The frontend displays these errors inline and blocks page transition until the user acknowledges the error.
- **ShipStation Label Creation Endpoints**: ShipStation V2 API has two distinct label creation endpoints:
    - `POST /v2/labels/shipment/{shipment_id}` - For EXISTING shipments. Takes shipment_id in URL path, body contains only label format options. This is what we use in packing completion to avoid creating duplicate shipments.
    - `POST /v2/labels` - For creating NEW shipments with labels inline. The body contains full shipment data but shipment_id MUST be null/empty (ShipStation rejects requests with shipment_id because this endpoint creates new shipments).

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling. Supported webhooks: `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch`. Note: ShipStation V2 does NOT support `fulfillment_created_v2` or `fulfillment_canceled_v2` events - on-hold status changes are handled by the Unified Shipment Sync Worker's cursor-based polling.
    - **CRITICAL API Parameter**: ShipStation V2 API uses `modified_at_start` and `modified_at_end` for date filtering (NOT `modified_date_start`). ShipStation silently ignores invalid parameters without error, making debugging difficult. Always verify parameters against official documentation.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, featuring automatic authentication and Redis-backed token caching. Includes a discriminated union type system for product classification and optimized QC scan API with a cache-with-fallback pattern.

### CRITICAL: Warehouse Session Lifecycle (SkuVault Sessions)
This is the core warehouse workflow that governs order fulfillment. The system MUST understand this lifecycle deeply.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SKUVAULT SESSION LIFECYCLE                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   SESSION STATUS    │  TRACKING   │  WAREHOUSE STATE       │  SYSTEM ACTION│
│   ──────────────────┼─────────────┼────────────────────────┼───────────────│
│   "new"             │  -          │  Ready to be picked    │  Pick queue   │
│   "active"          │  -          │  Being picked now      │  In progress  │
│   "inactive"        │  -          │  ⚠️ PAUSED/STUCK       │  FLAG IT!     │
│   "closed"          │  NULL       │  ✅ READY TO PACK      │  WARM CACHE   │
│   "closed"          │  Has value  │  Ready for carrier     │  INVALIDATE   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  CACHE WARMING STRATEGY:                                                    │
│  ────────────────────────                                                   │
│  Target: sessionStatus='closed' AND trackingNumber IS NULL                  │
│  These orders have been PICKED and are waiting at the packing station.      │
│                                                                             │
│  Warming Triggers:                                                          │
│  • Session transitions to "closed" + no tracking → Warm cache immediately   │
│  • Background poll every 30s catches any missed orders                      │
│  • Uses extended TTL (10-15 min) vs standard 2-minute cache                 │
│                                                                             │
│  Invalidation Triggers:                                                     │
│  • Label created (tracking number assigned) → Invalidate immediately        │
│  • Order shipped → Remove from warm cache                                   │
│                                                                             │
│  Manual Refresh:                                                            │
│  • Button on packing page for "closed + no tracking" orders only            │
│  • Used when customer service makes order changes (rare but critical)       │
│  • Forces fresh SkuVault API call and re-caches data                        │
│                                                                             │
│  Flagging for Attention:                                                    │
│  • "inactive" sessions need supervisor attention (stuck mid-pick)           │
│  • Surface in Operations Dashboard with warning indicator                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Session Status Definitions:**
- **new**: Order has been sessioned and is in the pick queue, waiting to be picked
- **active**: Order is currently being picked by a warehouse worker
- **inactive**: Order was being picked but picker paused/abandoned it. REQUIRES ATTENTION.
- **closed**: Order picking is complete. If no tracking number, it's ready to pack. If has tracking, it's ready for carrier pickup.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
-   **Neon Database**: Serverless PostgreSQL database.
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.