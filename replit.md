# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The design is adapted from the `jerky_top_n_web` theme, focusing on readability and efficiency in a warehouse environment. It aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface. Key capabilities include:
- Streamlined order management with Shopify integration.
- Real-time visibility into SkuVault wave picking sessions.
- Efficient historical order backfill system.
- Comprehensive reporting with CST timezone alignment.
- A print queue system for shipping labels.
- Real-time updates via WebSockets for order status.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React with TypeScript (Vite).
- **UI Components**: `shadcn/ui` (New York style variant) built on Radix UI, styled with Tailwind CSS.
- **Routing**: Wouter.
- **State Management**: TanStack Query for server state, data fetching, and caching.
- **Design System**: Warm earth-tone palette from `jerky_top_n_web`, large typography (e.g., order numbers 32px, customer names 24px) for warehouse readability.

### Backend
- **Server Framework**: Express.js with Node.js and TypeScript.
- **API Design**: RESTful API, handlers in `server/routes.ts`.
- **Authentication**: Passwordless via magic link tokens (email), secure HTTP-only session cookies (30-day expiration).
- **Database ORM**: Drizzle ORM, schema in `shared/schema.ts`.
- **File Uploads**: Multer for local avatar storage (`/uploads`), 5MB limit.

### Data Storage
- **Database**: PostgreSQL via Neon serverless connection (WebSockets).
- **Schema**:
    - `users`, `magicLinkTokens`, `sessions`: For authentication and user management.
    - `orders`, `orderRefunds`, `orderItems`: Store Shopify order, refund, and line item data. `orderRefunds` uses an indexed `refunded_at` column for scalable date range queries. `orderItems` stores normalized line item data with comprehensive price fields and SKU index. The `order_number` field stores the actual order number from any sales channel (e.g., "JK3825344788" for Shopify orders, "111-7320858-2210642" for Amazon orders), enabling unified order tracking across all channels.
    - `products`, `productVariants`: Normalized Shopify product/variant data with soft-delete support and indexes on `sku`, `bar_code`.
- **Migrations**: Drizzle Kit.

### Core Features
- **Product Catalog (`/products`)**: Warehouse-optimized interface for product and variant details with search functionality. Synchronized via Shopify webhooks.
- **SkuVault Sessions (`/sessions`)**: Displays wave picking sessions from SkuVault using a reverse-engineered web API. Features:
  - Manual authentication via "Connect to SkuVault" button to avoid anti-bot detection
  - Session list view with metrics (orders, SKUs, quantities, weight, status)
  - Advanced search and filtering capabilities:
    - Search by Session ID (exact match), Picklist ID (contains), or Order Number (contains)
    - Multi-select state filtering (8 states: active, inactive, new, readyToShip, closed, picked, shipped, cancelled)
    - Sort toggle (newest/oldest by creation date)
    - Pagination with configurable page size (default 50) and Previous/Next navigation
  - Detailed session view modal showing:
    - Picklist summary (status, assigned user, counts, weight)
    - All orders in the session with spot numbers (1-based order position in picklist for warehouse picking workflow)
    - Line items for each order with product images (64x64px), SKU, description, location, picked/total quantities
  - Product images fetched from local database by matching SKUs with productVariants table
  - Token cached in Redis with 24-hour TTL for persistence across server restarts
  - Rate limiting (2-second delay between requests) prevents triggering anti-bot protection
  - Lockout countdown timer displays remaining time when account is temporarily locked
- **Order Backfill System (`/backfill`)**: Imports historical Shopify orders AND their shipments from ShipStation using an ID-only queueing mechanism to optimize memory usage. Features intelligent rate limiting that monitors ShipStation API headers (X-Rate-Limit-Remaining, X-Rate-Limit-Reset) to avoid hitting rate limits. Includes a UI with progress tracking and job history.
- **Background Worker**: Asynchronous webhook processor with mutex-based concurrency control. Processes 50 webhooks per batch (5-second intervals), preventing overlapping executions via globally unique run IDs. Optimized for high-volume webhook ingestion with ~5x performance improvement over previous 10-item batches.
- **Shipment Sync Worker**: Dual-path async processor (10s intervals, 50 batches) that enriches shipment data from ShipStation:
  - **Path A (Tracking Number)**: Receives tracking number from track webhooks → calls `linkTrackingToOrder()` → fetches shipment by ID → finds order via 5-tier fallback → creates/updates shipment
  - **Path B (Order Number)**: Receives order number from fulfillment webhooks → fetches shipments via `getShipmentsByOrderNumber()` → creates/updates all shipments for order
  - Both paths produce identical enriched shipment records with symmetric rate-limit protection
  - **Rate Limit Handling**: Reads ShipStation's actual `X-Rate-Limit-*` headers after each API call instead of manual tracking. When quota exhausted (remaining ≤ 0), worker breaks out of batch processing and lets next run (10s later) start fresh. This enables burst processing of ~40 orders when quota available.
  - Failures logged to `shipmentSyncFailures` dead letter queue for monitoring
  - Webhook handlers queue messages instead of making synchronous ShipStation API calls, improving response times and preventing rate limit violations
- **Reports Page (`/reports`)**: Business analytics dashboard with date range filtering, interactive charts, and summary widgets for key metrics (orders, revenue, shipping, returns). All reporting is aligned to **Central Standard Time (America/Chicago timezone)**. Includes detailed revenue breakdown and robust refund tracking.
- **Print Queue System**: Manages shipping label printing workflow, displaying active print jobs with real-time status updates via WebSockets.
- **Real-Time Updates**: WebSocket server (`/ws`) provides live order updates, queue status (Shopify queue, shipment sync queue, failure count), and notifications.
- **Price Field Storage**: Captures 13 distinct Shopify price/amount fields consistently as text strings.
- **Monorepo Structure**: Client, server, and shared code are co-located.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup for quick application launch.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization. Utilizes webhooks for real-time updates.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment. Uses async dual-path queue system for webhook processing:
    -   **Dual-Path Shipment Sync**: Track and fulfillment webhooks queue to shipment sync worker instead of processing synchronously:
        - **Track Webhooks** (`API_TRACK`): Extract tracking number → queue for async processing → worker calls `linkTrackingToOrder()` with 5-tier fallback strategy
        - **Fulfillment Webhooks** (`FULFILLMENT_V2`): Extract order numbers → queue for async processing → worker calls `getShipmentsByOrderNumber()`
        - Both paths produce identical enriched shipment records, with symmetric rate-limit protection
        - Centralizes all ShipStation API calls in shipment sync worker for better rate limit management
    -   **Rate Limit Handling**: Reads ShipStation's actual `X-Rate-Limit-Remaining/Reset/Limit` headers after each API call instead of manual tracking. When quota exhausted (remaining ≤ 0), worker breaks out of batch processing loop instead of waiting. Next run (10s later) starts fresh, enabling burst processing of ~40 orders when quota available.
    -   **Tracking Linkage Strategy**: 5-tier fallback for linking tracking numbers to orders:
        1. Extract shipment ID from `label_url` (format: `se-XXXXXXX` or `se-UUID`)
        2. Fetch full shipment details from ShipStation `/v2/shipments?shipment_id={id}` with rate limit headers
        3. Find order using multiple fallback methods: `order_number` (matches any channel), `orderId`, `orderKey`, `external_shipment_id`, fulfillment API
        4. Create shipment record with complete tracking data linked to order
        5. Implemented via shared `linkTrackingToOrder()` utility in `server/utils/shipment-linkage.ts`
    -   **Multi-Channel Order Numbers**: The `order_number` field stores the actual order number from any sales channel. For Amazon orders, the system extracts the Amazon order number (e.g., "111-7320858-2210642") from Shopify fulfillment data instead of using Shopify's internal order number, enabling seamless shipment tracking across all channels.
-   **SkuVault Integration**: Reverse-engineered web API for accessing wave picking session data, including HTML form login and token caching. Rate limiting (2-second delay between requests) prevents triggering anti-bot protection.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.

## Webhook Configuration

The application uses environment-aware webhook registration to support both development and production simultaneously:

-   **Development (REPLIT_DEPLOYMENT not set)**: Auto-detects dev workspace URL from `REPLIT_DOMAINS` environment variable.
-   **Production (REPLIT_DEPLOYMENT=1)**: Uses hardcoded production URL `https://jerkyshippping.replit.app`.
-   **Manual Override**: `WEBHOOK_BASE_URL` environment variable takes precedence if explicitly set (must be a valid http/https URL).

Both environments register their own webhooks to Shopify and ShipStation, allowing independent webhook delivery to dev and production. Invalid or empty webhook URLs trigger explicit warnings and skip registration gracefully.