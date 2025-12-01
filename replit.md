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
        - **Electron App**: A React-based desktop application handling secure Google OAuth (PKCE), token persistence in macOS Keychain, robust WebSocket connectivity, station management, printer discovery, print job queue management, session persistence, environment switching, graceful shutdown, and remote configuration ("Mars Rover" Control) for dynamic timing settings.
    - **Web-based Stations Management**: CRUD interface at `/stations` with real-time connection status tracking and automatic termination of desktop sessions on station deletion.
    - **Real-Time Updates**: WebSocket server provides live updates for orders, queues, print status, and notifications.
    - **Saved Views System**: Customizable column views for the PO Recommendations page.
- **Monorepo Structure**: Client, server, and shared code are co-located.
- **Centralized ETL Architecture**: `ShopifyOrderETLService` and `ShipStationShipmentETLService` classes standardize data transformations.
- **Worker Coordination System**: Production-ready coordination for poll workers and backfill jobs using Redis-backed mutex.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics for all coordinator operations.
- **On-Hold Shipment Refresh Strategy**: ShipStation does not provide webhooks for hold status changes. The on-hold poll worker queries `shipment_status=on_hold` to detect new holds, but when holds are removed, shipments drop out of that query. To prevent stale hold data from blocking packing, the packing completion endpoint refreshes shipment data from ShipStation when the cached `hold_until_date` is present, then updates the database via the ETL service before proceeding.
- **ShipStation Label Creation Endpoints**: ShipStation V2 API has two distinct label creation endpoints:
    - `POST /v2/labels/shipment/{shipment_id}` - For EXISTING shipments. Takes shipment_id in URL path, body contains only label format options. This is what we use in packing completion to avoid creating duplicate shipments.
    - `POST /v2/labels` - For creating NEW shipments with labels inline. The body contains full shipment data but shipment_id MUST be null/empty (ShipStation rejects requests with shipment_id because this endpoint creates new shipments).

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling. Supported webhooks: `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch`. Note: ShipStation V2 does NOT support `fulfillment_created_v2` or `fulfillment_canceled_v2` events - on-hold status changes must be tracked via the background poll worker.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, featuring automatic authentication and Redis-backed token caching. Includes a discriminated union type system for product classification and optimized QC scan API with a cache-with-fallback pattern.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
-   **Neon Database**: Serverless PostgreSQL database.
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.