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
    - `orderRefunds`: Refund tracking with indexed `refunded_at` column for scalable date range queries (separate table chosen over JSONB for performance at scale).
    - `orderItems`: Normalized order line items with comprehensive price fields for product-level sales reporting. Stores both raw Shopify JSON structures (priceSetJson, totalDiscountSetJson, taxLinesJson) preserving multi-currency data and calculated aggregates (priceSetAmount, totalDiscountSetAmount, totalTaxAmount, preDiscountPrice, finalLinePrice) for efficient querying. Includes SKU index for fast variant lookup. Populated by webhooks, sync, and backfill endpoints using consistent extraction logic.
    - `products`, `productVariants`: Normalized Shopify product/variant data (soft-delete support, indexes on `sku`, `bar_code`).
- **Migrations**: Drizzle Kit.

### Core Features

- **Product Catalog (`/products`)**: Warehouse-optimized interface with large typography, two-column grid, product cards, expandable variant details (SKU, barcode, inventory), and search functionality. Real-time sync via Shopify webhooks.
- **Order Backfill System (`/backfill`)**: Allows importing historical Shopify orders for any date range. Uses `backfillJobs` table, async processing via Upstash Redis queue, and Shopify API rate limiting. Provides UI with date pickers, real-time progress, and job history.
- **Reports Page (`/reports`)**: Business analytics dashboard for shipping managers. Features date range filtering (default: last 30 days), interactive line chart showing order totals by day, and summary widgets for key metrics: total orders, fulfilled orders, shipping revenue (customer-paid shipping costs), total revenue, product value, and returns. Includes detailed breakdown cards for revenue components and order status distribution. Uses segmented TanStack Query cache keys for efficient data refetching. All date handling uses **Central Standard Time (America/Chicago timezone)** for consistent reporting regardless of server location. Refunded orders are excluded from revenue calculations, chart data, and status counts, but tracked separately in Returns widget.
  - **Refund Tracking**: Separate `orderRefunds` table with indexed `refunded_at` timestamp enables efficient date range queries for large datasets. Reports API filters refunds by refund date (not order creation date) to match Shopify's reporting. Webhook processing automatically extracts and stores refunds from Shopify orders. Backfill endpoint (`/api/refunds/backfill`) populates historical refund data with cursor-based pagination and Shopify rate limit handling.
  - **CST Timezone Implementation**: Frontend stores dates as `yyyy-MM-dd` strings (single source of truth) and uses three helper utilities: (1) `toCalendarDate` converts strings to Date for Calendar component using `parse`, (2) `toCstDateString` extracts calendar day components directly (no timezone conversion) to preserve clicked dates across all user timezones, (3) `toCstMidnightUtc` converts CST strings to Date using `fromZonedTime` for display formatting. All date labels use `formatInTimeZone` to display CST dates. Backend receives `yyyy-MM-dd` strings and interprets them as CST using `fromZonedTime` for 00:00:00 start and 23:59:59.999 end times. This approach ensures calendar selections, API queries, chart labels, and data grouping remain stable and CST-aligned regardless of browser or server timezone.
- **Print Queue System**: Manual print workflow for shipping labels. Fixed bottom bar displays active print jobs across all pages. Features:
  - Manual "Print Now" button opens label PDF in new tab for printing
  - "Done" button marks jobs complete and removes them from queue
  - Queue shows both "queued" and "printing" status jobs for visibility
  - Real-time status updates via WebSocket broadcasting (2-second polling)
  - Order detail page shows "Print Label" button when shipment exists, "Create Shipping Label" otherwise
  - Print Label button finds most recent shipment with label URL
  - PDF proxy endpoint (`/api/labels/proxy`) handles CORS for ShipStation PDFs
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

## Future Enhancements

### ShipStation Connect Auto-Print Integration

**Trigger phrase:** `"re-implement shipstation connect"`

**User Requirements:**
1. One-click printing - User clicks "Create Shipping Label" once
2. Print queue bar appears at bottom of screen
3. Job shows in queue with visible status changes
4. Job automatically disappears when printing completes

**How It Works:**
- Install ShipStation Connect desktop application on warehouse computers
- Connect monitors ShipStation API for new labels created by our application
- Automatically sends labels to configured thermal printers (Zebra, DYMO, etc.)
- Status lifecycle: `queued` → `printing` (when Connect receives) → `printed` (auto-removes from queue)
- Print queue bar provides real-time visual feedback throughout entire process
- No manual "Print Now" or "Done" buttons required

**Implementation Differences:**

| Current Manual System | ShipStation Connect (Future) |
|----------------------|------------------------------|
| 1. Create label | 1. Create label |
| 2. Manual "Print Now" click | 2. Auto-prints via Connect |
| 3. PDF opens in new tab | 3. Sends directly to printer |
| 4. User prints via browser | 4. No browser interaction |
| 5. Manual "Done" click | 5. Auto-removes when complete |

**Technical Implementation Notes:**
- Backend creates label via ShipStation V2 API
- ShipStation Connect app detects new label and auto-prints
- Webhook from ShipStation confirms print completion
- Backend updates job status to `printed` and removes from queue
- Print queue bar shows status progression automatically
- Works with existing `printJobs` table and WebSocket broadcasting
- Supports multiple printers and warehouse locations