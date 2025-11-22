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
- **Core Features**:
    - **Product Catalog**: Synchronized via Shopify webhooks, warehouse-optimized interface.
    - **SkuVault Sessions**: Displays wave picking sessions from SkuVault with advanced search and filtering.
    - **SkuVault QC Integration**: Quality Control API integration for product scanning and validation during fulfillment.
    - **Packing Page**: Single-warehouse MVP for order fulfillment with SkuVault QC validation, scan-first workflow, individual unit scanning, and comprehensive audit trails. Integrates with the print queue. All packing activities are logged to shipment_events table for performance analytics.
    - **Shipment Events Audit Trail**: Comprehensive event logging system tracking all packing station activities (order_scanned, order_loaded, product_scan_success, product_scan_failed, manual_verification, packing_completed) with timestamps and metadata for performance analytics and management reporting.
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
- **On-Hold Poll Worker**: Polls ShipStation for on-hold shipments every 1 minute (supplements webhooks which don't fire for on_hold status). Displays real-time running/sleeping/awaiting_backfill_job status on Operations dashboard.
- **Worker Coordination System**: Production-ready coordination between on-hold poll worker and backfill jobs to prevent API conflicts. Uses Redis-backed mutex with comprehensive error handling, fail-safe defaults, and status recovery broadcasts. WorkerCoordinator utility manages coordination state with lock tracking, TTL safety nets, and graceful degradation. All degraded states (backfill active, mutex contention, Redis errors) emit recovery signals to ensure UI stays synchronized.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback on failure.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.
- **Worker Coordination Resilience**: All coordinator operations wrapped in error handling with fail-safe semantics (skip poll on error, continue backfill on coordination failure). Status recovery pattern ensures UI receives both degraded and recovery broadcasts, preventing stuck states.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling and a multi-tier fallback strategy.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.