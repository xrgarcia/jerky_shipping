# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The design is adapted from the `jerky_top_n_web` theme, focusing on readability and efficiency in a warehouse environment. It aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface. Key capabilities include: streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status. The project's ambition is to enhance order processing efficiency and accuracy for ship.jerky.com.

**ShipStation API Optimization (Production-Ready)**: Reduces API calls by ~80% using fast-path database updates for existing order-linked shipments. All tracking webhooks are enqueued to the worker which checks the database first - if shipment exists and is linked to an order, status is updated from webhook data without calling ShipStation API. If fast-path fails or shipment doesn't exist, falls back to full API sync. Features unified status normalization helper (`normalizeShipmentStatus`), terminal status protection (delivered shipments never downgraded), structured DLQ error logging with full stack traces, and single-point dedupe cleanup in outer finally block to prevent race conditions.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
- **Design System**: Warm earth-tone palette from `jerky_top_n_web`, large typography (e.g., order numbers 32px, customer names 24px) for warehouse readability.
- **UI Components**: `shadcn/ui` (New York style variant) built on Radix UI, styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React with TypeScript (Vite), Wouter for routing, TanStack Query for server state management.
- **Backend**: Express.js with Node.js and TypeScript, RESTful API, Drizzle ORM for database interactions.
- **Authentication**: Passwordless via magic link tokens (email), secure HTTP-only session cookies.
- **Data Storage**: PostgreSQL via Neon serverless connection, Drizzle Kit for migrations. Schema includes tables for users, authentication, orders (Shopify and ShipStation data), products, and product variants.
- **Core Features**:
    - **Product Catalog**: Synchronized via Shopify webhooks, warehouse-optimized interface.
    - **SkuVault Sessions**: Displays wave picking sessions from SkuVault using a reverse-engineered API with manual authentication, advanced search, filtering, and detailed session views. Includes token caching in Redis and rate limiting to prevent anti-bot detection.
    - **Order Backfill System**: Imports historical Shopify orders and ShipStation shipments with comprehensive observability, heartbeat system, stage tracking, stuck job detection, and manual cancellation. Features intelligent rate limiting for ShipStation API and per-order error isolation.
    - **Background Worker**: Asynchronous webhook processor with mutex-based concurrency control for high-volume webhook ingestion.
    - **Shipment Sync Worker**: Dual-path asynchronous processor for enriching shipment data from ShipStation, handling tracking numbers and order numbers. Triggered by both ShipStation webhooks AND Shopify order webhooks for redundancy.
      - **Fast-Path Optimization (Production-Ready)**: When tracking webhooks arrive for existing order-linked shipments, updates status directly from webhook data without calling ShipStation API (~80% API reduction). Features:
        - Single-point dedupe cleanup in outer finally block (no race conditions)
        - Unified `normalizeShipmentStatus()` helper ensures consistent status normalization across all code paths:
          - DE (Delivered) → "delivered"
          - Other tracking codes → "in_transit"
          - Voided → "cancelled"
          - Default (new shipments) → "shipped"
        - Terminal status protection: delivered shipments never downgraded to in_transit
        - Automatic fallback to full API sync if fast-path fails (transient database/broadcast errors)
        - Structured DLQ error logging with full message + stack traces for both fast-path and API errors
      - **CRITICAL: Shipments can exist independently of orders** (nullable order_id) to handle multi-channel orders (Amazon, TikTok) that don't exist in Shopify. Creates shipments immediately even when order linkage fails, then triggers fire-and-forget Shopify order sync for best-effort order discovery. Prevents data loss for non-Shopify orders while maintaining order linkage for Shopify orders. Features intelligent deduplication using Redis SET to prevent duplicate processing of the same tracking number or order number - if already queued/processing, subsequent enqueue attempts are silently skipped. In-flight tracking is automatically cleaned up after processing completes. Includes robust rate limit handling and detailed failure logging to a dead letter queue.
    - **Shopify Order Sync Worker**: Fire-and-forget order import system triggered when shipments arrive for missing orders. Runs in background without blocking shipment creation. Features atomic deduplication using Redis SADD to prevent duplicate processing of the same order number - if already queued/processing, subsequent enqueue attempts are silently skipped. In-flight tracking is automatically cleaned up after processing completes. Runs every 8 seconds processing up to 10 orders per batch. Includes dead letter queue for logging failures after 3 retry attempts with full request/response data for debugging. Batch enqueue handles in-batch duplicates before checking Redis for existing queue entries.
    - **Shipments Page**: Displays all shipments with proper SQL LEFT JOIN to orders table for reliable order/customer data retrieval. Handles shipments without order linkage gracefully, displaying shipment_id as fallback identifier. Features orphaned shipment detection and labeling for shipments missing tracking numbers, ship dates, and shipment IDs. SQL sorting uses NULLS LAST to place orphaned shipments at the end when sorted by ship date. Advanced filters include an "orphaned" checkbox that filters for shipments missing ALL three fields using SQL WHERE condition with AND logic.
    - **Reports Page**: Business analytics dashboard with date range filtering, interactive charts, and metrics aligned to Central Standard Time (America/Chicago).
    - **Operations Dashboard**: Real-time queue monitoring (Shopify webhook queue, Shipment sync queue, Shopify order sync queue), worker status, backfill job status, Shopify credentials validation, safe webhook re-registration, and data health metrics via WebSockets. Provides interactive failures tables for both shipment sync failures and Shopify order sync failures with independent pagination/search state. Includes purge actions for queues and failure tables. Displays three queue cards in responsive grid layout with health status badges. Data health metrics include: orders missing shipments, shipments without orders, orphaned shipments, shipments without status, shipment sync failures count, and Shopify order sync failures count.
    - **Print Queue System**: Manages shipping label printing workflow with real-time status updates via WebSockets.
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, and notifications.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration for development and production, supporting independent webhook delivery and automatic rollback on failure.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup prevents dev/prod webhook duplication. REPLIT_DOMAINS is correctly parsed (comma-separated list, first domain only) and webhooks pointing to different base URLs are automatically deleted. URL parsing is wrapped in try/catch to handle malformed addresses gracefully.

## Known Issues and Troubleshooting

### Shipment Sync Failures

The dead letter queue logs all shipment sync failures for troubleshooting. There are two main types:

1. **"0 shipments found in ShipStation"** - Expected when:
   - Orders exist in Shopify but haven't shipped yet (fulfillment_status = null)
   - Rate limit exhausted before completing search
   - Order numbers don't exist in ShipStation (multi-channel orders from Amazon/TikTok)
   - **Logged with full data**: order number, API endpoint, rate limit status, shipments count

2. **"Could not extract shipment_id for tracking..."** - Historical issue from manual sync:
   - 43 tracking numbers from manual sync only had tracking_number field
   - Missing both label_url AND shipment_id fields needed for extraction
   - Cannot be processed without additional data
   - **Current webhooks work fine**: New ShipStation webhooks include label_url field
   - **No action needed**: These are legacy failures from incomplete data
   - **Shipment ID extraction works via**: 
     - `label_url` regex: `/labels/(se-[a-f0-9-]+)` extracts "se-594210232" from URL
     - Fallback to `shipment_id` field if present

### Order Filter SQL Optimization (Fixed)

**Issue**: Orders page "Has Shipment: No" filter was returning 0 results despite Operations dashboard showing 467 orders missing shipments.

**Root Cause**: SQL `NOT IN` with NULL values bug. The shipments table contains 301 shipments with NULL `order_id` (multi-channel orders from Amazon/TikTok). When using `NOT IN` with a subquery containing NULLs, SQL returns zero rows because NULL comparisons are treated as unknown.

**Fix**: Added `isNotNull(shipments.orderId)` filter to all shipment-related subqueries in `server/storage.ts`:
- hasShipment=true/false filters
- shipmentStatus filter
- carrierCode filter

This ensures only shipments linked to orders are checked, preventing NULL values from breaking the NOT IN clause. Query now correctly returns ~465 orders without shipments.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks for real-time updates.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment. Features a dual-path async queue system for webhook processing, intelligent rate limit handling, and a 5-tier fallback strategy for linking tracking numbers to orders. Handles multi-channel order numbers (e.g., Amazon, Shopify).
-   **SkuVault Integration**: Reverse-engineered web API for accessing wave picking session data, including HTML form login and token caching, with built-in rate limiting.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues. Manages three separate queues: Shopify webhooks, ShipStation shipment sync, and Shopify order sync.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.