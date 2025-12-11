# Warehouse Fulfillment Application

## Naming Convention
- **ship.** = This application (ship.jerky.com)
- **jerky.com** = The business name

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