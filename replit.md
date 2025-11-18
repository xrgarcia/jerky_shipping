# Warehouse Fulfillment Application

## Overview

This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The design is adapted from the `jerky_top_n_web` theme, focusing on readability and efficiency in a warehouse environment. It aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface.

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
    - `users`: Staff authentication, profiles.
    - `magicLinkTokens`: Authentication tokens.
    - `sessions`: User sessions.
    - `orders`: Shopify order data (JSONB).
    - `products`, `productVariants`: Normalized Shopify product/variant data (soft-delete support, indexes on `sku`, `bar_code`).
- **Migrations**: Drizzle Kit.

### Core Features

- **Product Catalog (`/products`)**: Warehouse-optimized interface with large typography, two-column grid, product cards, expandable variant details (SKU, barcode, inventory), and search functionality. Real-time sync via Shopify webhooks.
- **Order Backfill System (`/backfill`)**: Allows importing historical Shopify orders for any date range. Uses `backfillJobs` table, async processing via Upstash Redis queue, and Shopify API rate limiting. Provides UI with date pickers, real-time progress, and job history.
- **Print Queue System**: Auto-print functionality for shipping labels using Print.js library. Fixed bottom bar displays active print jobs across all pages. Features:
  - Automatic print dialog triggering when labels are created (no user interaction required)
  - Smart retry prevention with `failedJobsRef` tracking to avoid infinite API loops
  - Backend accepts both "queued" and "printing" status for job completion
  - Real-time status updates via WebSocket broadcasting
  - Jobs marked complete only after print dialog closes
  - Note: Print.js cannot distinguish between confirmed prints and user-canceled dialogs
- **Real-Time Updates**: WebSocket server (`/ws`) provides live order updates, authenticated via sessions. Frontend refreshes order list and shows toast notifications.
- **Price Field Storage**: Captures 13 distinct Shopify price/amount fields as text strings using `extractShopifyOrderPrices()` for consistency.
- **Monorepo Structure**: Client, server, and shared code co-located for simplified development and type consistency.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup to ensure quick application launch.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order and product data synchronization.
    -   Requires custom app, `read_orders`, `read_products`, `read_customers`, `write_products` scopes.
    -   Environment variables: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_API_SECRET`.
    -   Webhooks for `orders/create`, `orders/updated`, `products/create`, `products/update`, `products/delete` (processed asynchronously via Upstash Redis queue and worker).
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment.
    -   Base URL: `https://api.shipstation.com`.
    -   Authentication: `SHIPSTATION_API_KEY` (API key in `api-key` header).
    -   Webhooks registered at `/v2/environment/webhooks` for `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch` events.
    -   RSA-SHA256 signature verification.
    -   Webhook endpoint: `/api/webhooks/shipstation/shipments`.
    -   Order matching via ShipStation's `shipment_number` (contains Shopify order number).
    -   Bootstraps existing shipments on server startup.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
    -   Environment variables: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
-   **Nodemailer**: For sending magic link authentication emails (requires SMTP configuration).
-   **Neon Database**: Serverless PostgreSQL database accessed via `DATABASE_URL` (WebSocket protocol).