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
- **Core Features**: Order management, packing page supporting boxing/bagging workflows, workstation guard system, shipment management, order backfill system, reporting & analytics, operations dashboard, print queue system, desktop printing via Electron, web-based stations management, real-time updates via WebSockets, and customizable saved views.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: Standardized data transformations for Shopify orders and ShipStation shipments.
- **Worker Coordination System**: Redis-backed mutex for production-ready coordination of poll workers and backfill jobs.
- **Dual Shipment Sync Architecture**: Combines cursor-based polling and a Webhook Processing Queue for real-time events.
- **Event-Driven Lifecycle Architecture**: Redis-backed queue system for reliable lifecycle state transitions with automated side effects, decoupled evaluation, error isolation, rate limiting, and centralized observability.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback.
- **Worker Coordination Resilience**: Error handling with fail-safe semantics.
- **On-Hold Shipment Handling**: Managed by the Unified Shipment Sync Worker's cursor-based polling.
- **Tag Refresh Job**: Periodic re-validation of ShipStation tags for specific shipment phases.
- **Sessionable Order Status**: Lifecycle state machine treats `pending` shipment status as valid for `READY_TO_SESSION` phase.
- **Lifecycle State Machine Documentation**: `server/services/lifecycle-state-machine.ts` is the single source of truth for order status determination.
- **Kit Explosion Race Condition Prevention**: Multi-layered approach using lazy-loading cache, hourly GCP sync, proactive hydration, and a repair job endpoint.
- **Split/Merge Detection**: ETL service detects shipment item changes using a normalized "SKU:QTY" fingerprint, triggering re-hydration and fingerprint recalculation.
- **Packing Completion Audit Logging**: All packing actions are logged to `packing_logs` table.
- **Packing Error Handling**: Structured error responses with `{code, message, resolution}` for user guidance.
- **Voided Label Handling**: Automatic new label creation, PDF validation, printing to requesting worker, audit logging, and QC cache invalidation.
- **QC Completion Tracking**: `shipments.qc_completed` boolean flag and `qc_completed_at` timestamp.
- **ShipStation Label Creation Endpoints**: Differentiates label creation for existing versus new shipments.
- **Product Categorization**: Distinction between kits and assembled products based on SkuVault's QC Sale API behavior.
- **Master Products Page (`/skuvault-products`)**: Local single source of truth for product catalog data, synced hourly from a GCP reporting database.
- **Packaging Types Sync Worker**: Hourly sync from ShipStation `/v2/packages` endpoint, preserving local `id`, `is_active`, and `stationType` fields.
- **Automated Package Assignment**: Two-table architecture where `fingerprints` stores order item signatures and `fingerprint_models` stores learned rules (fingerprint → packaging type). When a user assigns a packaging type via UI, the endpoint creates/updates the fingerprint_model AND directly updates all shipments with that fingerprint. The lifecycle event worker can also copy packagingTypeId from fingerprint_models to shipments when missing, then syncs dimensions to ShipStation (respecting status guardrails - only "pending" shipments can be updated).
- **Fingerprint Needs-Mapping Filter**: The Packaging tab only shows fingerprints needing assignment for shipments in `lifecycle_phase = 'ready_to_session'` (MOVE OVER tag + pending status). This excludes on-hold orders, shipped orders, and orders without MOVE OVER tag from the actionable queue.
- **Two-Tier Inventory Tracking System**: `skuvault_products` table uses `quantity_on_hand`, `pending_quantity`, `allocated_quantity`, and `available_quantity` to prevent premature inventory deduction.
- **PO Recommendations Page (`/po-recommendations`)**: Displays inventory forecasts, holiday planning, supplier filtering, and lead time considerations from a reporting database view.
- **Shipping Cost Tracking**: Actual carrier costs from ShipStation labels API are stored in `shipments.shipping_cost` for cost analysis.

## External Dependencies
- **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, using webhooks.
- **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and webhooks.
- **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning, including automatic authentication, Redis-backed token caching, and a QCSale Cache Warmer Service.
- **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
- **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
- **Neon Database**: Serverless PostgreSQL database for primary data storage.
- **GCP PostgreSQL**: Separate reporting database used for purchase order recommendations and inventory forecasting analytics.