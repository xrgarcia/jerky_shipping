# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The design is adapted from the `jerky_top_n_web` theme, focusing on readability and efficiency in a warehouse environment. It aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface. Key capabilities include: streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status. The project's ambition is to enhance order processing efficiency and accuracy for ship.jerky.com.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
- **Design System**: Warm earth-tone palette from `jerky_top_n_web`, large typography for warehouse readability.
- **UI Components**: `shadcn/ui` (New York style variant) built on Radix UI, styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React with TypeScript (Vite), Wouter for routing, TanStack Query for server state management.
- **Backend**: Express.js with Node.js and TypeScript, RESTful API, Drizzle ORM for database interactions.
- **Authentication**: Passwordless via magic link tokens (email), secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL via Neon serverless connection, Drizzle Kit for migrations. Schema includes tables for users, authentication, orders (Shopify and ShipStation data), products, and product variants.
- **Core Features**:
    - **Product Catalog**: Synchronized via Shopify webhooks, warehouse-optimized interface.
    - **SkuVault Sessions**: Displays wave picking sessions from SkuVault using a reverse-engineered API with manual authentication, advanced search, filtering, and detailed session views. Includes token caching and rate limiting.
    - **Order Backfill System**: Imports historical Shopify orders and ShipStation shipments with comprehensive observability, heartbeat system, stage tracking, stuck job detection, and manual cancellation. Features intelligent rate limiting for ShipStation API and per-order error isolation.
    - **Background Worker**: Asynchronous webhook processor with mutex-based concurrency control.
    - **Shipment Sync Worker**: Dual-path asynchronous processor for enriching shipment data from ShipStation, handling tracking numbers and order numbers. Triggered by both ShipStation and Shopify webhooks for redundancy. Includes fast-path optimization for existing order-linked shipments (reduces API calls), unified status normalization, terminal status protection, structured DLQ error logging, and single-point dedupe cleanup. Shipments can exist independently of orders to handle multi-channel orders.
    - **Shopify Order Sync Worker**: Fire-and-forget order import system triggered when shipments arrive for missing orders. Runs in background with atomic deduplication.
    - **Normalized Shipment Data**: Shipment items and tags are normalized into dedicated `shipment_items` and `shipment_tags` tables for efficient querying and partial fulfillment tracking. Includes batch migration, N+1 query prevention, type safety, and automatic population.
    - **ShipStation Customer Data Extraction**: Customer shipping information from ShipStation's `ship_to` field is extracted into dedicated database columns for multi-channel order support.
    - **Order Number Field**: Customer-facing order numbers (e.g., "JK3825345229") extracted from ShipStation's `shipment_number` field into dedicated `order_number` column. Provides consistent multi-channel order tracking regardless of whether order exists in Shopify database. Includes automatic extraction in all webhook paths (full-sync and fast-path), and historical backfill (824/1,430 shipments populated). UI displays order number for both linked and unlinked shipments.
    - **Enriched Shipment Data**: Comprehensive shipment metadata extracted from ShipStation webhooks into dedicated columns including return status (`is_return`), gift information (`is_gift`, `notes_for_gift`), customer notes (`notes_from_buyer`), total weight (concatenated value+unit), and all 26 `advanced_options` fields (billing details, special handling flags like `contains_alcohol`, `saturday_delivery`, `non_machinable`, custom fields, etc.). Automatic extraction in all webhook paths, fast-path preservation via partial updates, and historical backfill (824/1,430 shipments populated). UI displays badges for return/gift status, special handling flags, weight, and highlights gift messages and buyer notes.
    - **Shipments Page**: Displays all shipments with proper SQL LEFT JOIN to orders table, handling shipments without order linkage gracefully. Shows order number from dedicated column when order isn't linked to Shopify. Displays return/gift badges, special handling indicators (Saturday delivery, contains alcohol), total weight, gift messages, and buyer notes. Includes orphaned shipment detection and advanced filters.
    - **Reports Page**: Business analytics dashboard with date range filtering, interactive charts, and metrics aligned to Central Standard Time.
    - **Operations Dashboard**: Real-time queue monitoring (Shopify webhook queue, Shipment sync queue, Shopify order sync queue), worker status, backfill job status, Shopify credentials validation, safe webhook re-registration, and data health metrics via WebSockets. Provides interactive failures tables and purge actions.
    - **Print Queue System**: Manages shipping label printing workflow with real-time status updates via WebSockets.
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, and notifications.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration for development and production, supporting independent webhook delivery and automatic rollback on failure.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup prevents dev/prod webhook duplication.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks for real-time updates.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment. Features a dual-path async queue system for webhook processing, intelligent rate limit handling, and a 5-tier fallback strategy for linking tracking numbers to orders.
-   **SkuVault Integration**: Reverse-engineered web API for accessing wave picking session data, including HTML form login and token caching, with built-in rate limiting.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues. Manages three separate queues: Shopify webhooks, ShipStation shipment sync, and Shopify order sync.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.