# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The project aims to improve order processing and inventory management through real-time synchronization, a user-friendly interface, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture
### UI/UX Decisions
- **Design System**: Warm earth-tone palette, large typography for warehouse readability.
- **UI Components**: `shadcn/ui` (New York style variant) built on Radix UI, styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React with TypeScript (Vite), Wouter for routing, TanStack Query for server state management.
- **Backend**: Express.js with Node.js and TypeScript, RESTful API, Drizzle ORM for database interactions.
- **Authentication**: Passwordless via magic link tokens (email), secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL via Neon serverless connection, Drizzle Kit for migrations. Schema includes tables for users, authentication, orders, products, product variants, and order items. Comprehensive indexing strategy across all major tables for optimized query performance.
- **Normalized SkuVault Data Model**: SkuVault session data is normalized into relational columns instead of jsonb for single source of truth:
    - `shipments` table: firestoreDocumentId, sessionStatus, spotNumber, pickedByUserId/Name, pickStartedAt/EndedAt, savedCustomField2
    - `shipment_items` table: sv_* prefixed columns (svProductId, expectedQuantity, scannedQuantity, svPicked, svCompleted, svAuditStatus, svWarehouseLocation/Locations, svStockStatus, svAvailableQuantity, svNotFoundProduct, svIsSerialized, svPartNumber, svWeightPounds, svCode, svProductPictures)
    - Packing page uses `expectedQuantity` from SkuVault when available, falls back to ShipStation quantity
- **Core Features**:
    - **Order Management**: Synchronized product catalog, SkuVault wave picking session display, and SkuVault QC Integration for packing.
    - **Packing Page**: Single-warehouse MVP for order fulfillment with SkuVault QC validation, scan-first workflow, individual unit scanning, and comprehensive audit trails. Integrates with the print queue.
    - **Shipment Management**: Unified shipments page with workflow tabs (In Progress, Packing Queue, Shipped, All). Session info displayed inline on shipment cards. Tab-based filtering uses session status and ship date. Shipment details page with comprehensive metadata. Dual-ID Routing for all shipment-related API endpoints.
    - **Workflow Tabs**: 
        - **In Progress**: Orders currently being picked (sessionStatus = 'New' or 'Active')
        - **Packing Queue**: Orders ready to pack (sessionStatus = 'Closed' or 'Picked', no ship date yet)
        - **Shipped**: Orders that have been shipped (has ship date)
        - **All**: All shipments regardless of status
    - **Order Backfill System**: Fault-tolerant, task-based architecture for importing historical Shopify orders and ShipStation shipments, with Redis-queued processing, progress tracking, and WebSocket updates.
    - **Reporting & Analytics**: Reports page with business analytics dashboard (Gross Sales, Net Sales). PO Recommendations page with inventory recommendations querying a separate GCP PostgreSQL database.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing workflow with background worker, retry logic, and browser auto-print.
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, print queue status, and notifications.
    - **Saved Views System**: Customizable column views for PO Recommendations page stored in `saved_views` table.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: `ShopifyOrderETLService` and `ShipStationShipmentETLService` classes centralize data transformations for consistent processing.
- **Worker Coordination System**: Production-ready coordination between on-hold poll worker and backfill jobs using Redis-backed mutex.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback on failure.
- **Worker Coordination Resilience**: All coordinator operations wrapped in error handling with fail-safe semantics.

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning. Features automatic authentication with Redis-backed token caching.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database (primary).
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.