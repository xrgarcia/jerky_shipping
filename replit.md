# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The project aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface. Key capabilities include streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status.

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
- **Data Storage**: PostgreSQL via Neon serverless connection, Drizzle Kit for migrations. Schema includes tables for users, authentication, orders, products, product variants, and order items. The `order_items` table includes a `requiresShipping` boolean field (extracted from Shopify's `requires_shipping`) to distinguish physical products from non-shippable items like gift cards and digital downloads.
- **Database Performance Optimization**: Comprehensive indexing strategy with 27+ indexes across all major tables for optimized query performance:
    - **Orders table**: UNIQUE index on order_number (0.064ms lookup), composite index on (fulfillment_status, created_at) for filtered lists (0.397ms), financial_status index for data health metrics, GIN trigram indexes on order_number and customer_name for fuzzy ILIKE searches, temporal indexes on created_at/updated_at/last_synced_at DESC for efficient sorting
    - **Shipments table**: UNIQUE index on tracking_number (0.035ms lookup), order_id index (covering NULL values for orphaned shipment queries), composite index on (order_number, carrier_code) for webhook reconciliation, partial index on status for common statuses (delivered/in_transit/exception/pending), ship_date DESC index for chronological queries, orphaned shipments index for data health monitoring
    - **Order Items table**: Composite index on (order_id, requires_shipping) for efficient shippable item filtering in data health metrics
    - **Shipment Items table**: Index on external_order_item_id for webhook line item matching
    - **Operational tables**: Status and composite (status, queued_at) indexes on backfill_jobs and print_queue for worker polling
    - **PostgreSQL pg_trgm extension**: Automatically initialized on server startup for fuzzy text search with GIN trigram indexes, supporting partial order number and customer name searches. Extension creation is handled in `server/db.ts` for both development and production environments.
    - **Data Health Metrics Optimization**: Critical queries optimized to use ILIKE instead of LOWER() for case-insensitive comparisons, enabling index usage. Query execution times: orders missing shipments (~96ms), shipments without orders (~39ms), orphaned shipments (~21ms)
- **Core Features**:
    - **Product Catalog**: Synchronized via Shopify webhooks, warehouse-optimized interface.
    - **SkuVault Sessions**: Displays wave picking sessions from SkuVault with advanced search and filtering.
    - **SkuVault QC Integration**: Quality Control API integration for product scanning and validation during fulfillment. Comprehensive audit logging captures raw SkuVault API responses in `packing_logs.skuVaultRawResponse` (JSONB) for debugging integration issues and regulatory compliance.
    - **Packing Page**: Single-warehouse MVP for order fulfillment with SkuVault QC validation, scan-first workflow, individual unit scanning, and comprehensive audit trails. Integrates with the print queue. All packing activities are logged to shipment_events table for performance analytics.
    - **Shipment Events Audit Trail**: Comprehensive event logging system tracking all packing station activities (order_scanned, order_loaded, product_scan_success, product_scan_failed, manual_verification, packing_completed) with timestamps and metadata for performance analytics and management reporting.
    - **SkuVault API Audit Logging**: Complete raw API response capture in packing logs (JSONB column) for every product validation request. Enables debugging of integration issues, provides complete audit trail for quality control compliance, and facilitates troubleshooting of product synchronization gaps between systems.
    - **Order Backfill System**: Fault-tolerant, task-based architecture for importing historical Shopify orders and ShipStation shipments, with Redis-queued processing, progress tracking, and WebSocket updates.
    - **Background Worker**: Asynchronous webhook processor with mutex-based concurrency control.
    - **Shipment Sync Worker**: Dual-path asynchronous processor for enriching shipment data from ShipStation, handling tracking and order numbers. Optimizes webhook processing by treating them as patch operations and includes robust rate limit handling.
    - **Shopify Order Sync Worker**: Fire-and-forget order import system triggered when shipments arrive for missing orders.
    - **Normalized Shipment Data**: Shipment items and tags are normalized into dedicated tables for efficient querying and partial fulfillment tracking.
    - **ShipStation Customer Data Extraction**: Customer shipping information extracted into dedicated database columns for multi-channel order support.
    - **Order Number and Date Fields**: Customer-facing order numbers and shipment creation timestamps extracted from ShipStation into dedicated database columns for consistent tracking and accurate reporting.
    - **Enriched Shipment Data**: Comprehensive shipment metadata (return status, gift info, customer notes, total weight, advanced options) extracted from ShipStation webhooks.
    - **Shipments Page**: Shipment-centric warehouse interface displaying all shipments with customer info, shipping details, and actions. Includes advanced filters and manual sync capability.
    - **Shipment Details Page**: Warehouse-optimized detail view showing comprehensive shipment metadata, customer information, shipping details, special instructions, and itemized product lists.
    - **Dual-ID Routing**: All shipment-related API endpoints and frontend navigation support both ShipStation IDs and database UUIDs for seamless operation.
    - **Reports Page**: Business analytics dashboard with date range filtering, interactive charts, and metrics for Gross Sales and Net Sales, aligned to Central Standard Time.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets. The "Orders Missing Shipments" metric excludes orders with refunded/restocked/voided financial status (case-insensitive), orders with refunds in the order_refunds table, AND orders containing only non-shippable items (gift cards, digital products). Uses Shopify's `requires_shipping` field from each line item to automatically identify orders that don't need physical shipment. The metric is clickable to navigate to the Orders page with the "Has Shipment: No" filter applied (which applies the same exclusions).
    - **Print Queue System**: Manages shipping label printing workflow with real-time status updates via WebSockets.
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, and notifications.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup.
- **Centralized ETL Architecture**: 
    - `ShopifyOrderETLService` class centralizes all Shopify order transformations (orders, refunds, line items) following OOP principles with dependency injection. Single source of truth used by all ingestion paths: webhooks, sync workers, backfill jobs, and API endpoints.
    - `ShipStationShipmentETLService` class centralizes all ShipStation shipment transformations (shipments, items, tags) with automatic order linkage, order ID preservation on updates, and comprehensive field extraction. Used by webhooks, backfill jobs, and on-hold polling to eliminate code duplication and ensure consistent data processing.
- **On-Hold Poll Worker**: Polls ShipStation for on-hold shipments every 1 minute (supplements webhooks which don't fire for on_hold status). Displays real-time running/sleeping/awaiting_backfill_job status on Operations dashboard.
- **Worker Coordination System**: Production-ready coordination between on-hold poll worker and backfill jobs to prevent API conflicts. Uses Redis-backed mutex with comprehensive error handling, fail-safe defaults, and status recovery broadcasts. WorkerCoordinator utility manages coordination state with lock tracking, TTL safety nets, and graceful degradation. All degraded states (backfill active, mutex contention, Redis errors) emit recovery signals to ensure UI stays synchronized.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback on failure.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.
- **Worker Coordination Resilience**: All coordinator operations wrapped in error handling with fail-safe semantics (skip poll on error, continue backfill on coordination failure). Status recovery pattern ensures UI receives both degraded and recovery broadcasts, preventing stuck states.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and a multi-tier fallback strategy.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning. Features automatic authentication with Redis-backed token caching (24hr TTL), mutex-protected login to prevent concurrent authentication attempts, and graceful degradation when Redis is unavailable. Operations dashboard displays SkuVault credentials status with token last-refreshed timestamp and manual token rotation capability. **API Response Format**: All SkuVault QC API responses include anti-XSSI prefix `")]}',\n\r` that must be stripped before JSON parsing. Standard response structure: `{Data: {...}, Errors: [], Success: true}` with capital field names. Product lookup endpoint returns product data in `Data` field. QC pass endpoint returns `{Data: null, Errors: [], Success: true}` on successful validation. HTML responses indicate session expiration and trigger automatic re-authentication. **Real-Time Sync**: Packing workflow calls `getPickedQuantityForProductBySaleId` endpoint before each scan to check quantities already picked in SkuVault, auto-syncing local progress to prevent duplicate work across systems. Sync events logged to `shipment_events` table with complete metadata for audit trails.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.