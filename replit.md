# Warehouse Fulfillment Application

## Overview

This is a warehouse fulfillment tool designed for ship.jerky.com that integrates with Shopify to manage and process orders. The application provides a streamlined interface for warehouse staff to search orders, view order details, and handle fulfillment tasks. It features a warm, approachable design adapted from the jerky_top_n_web theme while prioritizing readability and efficiency for warehouse environments.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework**: React with TypeScript using Vite as the build tool.

**UI Components**: The application uses shadcn/ui component library (New York style variant) built on Radix UI primitives. This provides a consistent, accessible component system with extensive customization through Tailwind CSS.

**Routing**: Wouter is used for client-side routing, providing a lightweight alternative to React Router.

**State Management**: TanStack Query (React Query) handles server state management, data fetching, and caching. This eliminates the need for a separate global state management solution for server data.

**Design System**: A custom warm earth-tone color palette inherited from jerky_top_n_web with warehouse-optimized typography for readability in varying lighting conditions. The design prioritizes large text sizes (order numbers at 32px, customer names at 24px) for quick scanning.

### Backend Architecture

**Server Framework**: Express.js running on Node.js with TypeScript.

**API Design**: RESTful API architecture with route handlers organized in `server/routes.ts`.

**Authentication**: Passwordless authentication using magic link tokens sent via email. Session management uses secure HTTP-only cookies with 30-day expiration. This approach prioritizes security while maintaining user convenience.

**Database ORM**: Drizzle ORM provides type-safe database operations with schema definitions in `shared/schema.ts`.

**File Uploads**: Multer middleware handles file uploads (avatars) with a 5MB limit, storing files locally in the `uploads` directory.

### Data Storage

**Database**: PostgreSQL via Neon serverless connection using WebSockets for edge compatibility.

**Schema Structure**:
- **users**: Warehouse staff authentication and profiles (email, handle, avatar)
- **magicLinkTokens**: Time-limited authentication tokens for passwordless login
- **sessions**: Active user sessions with token-based authentication
- **orders**: Shopify order data synchronized from the external API (stored as JSONB for flexibility)
- **products**: Normalized product data from Shopify (id, title, imageUrl, status, timestamps, soft-delete support)
- **productVariants**: Normalized product variant data (id, productId, sku, barCode, title, price, inventory, soft-delete support)

**Migration Strategy**: Drizzle Kit handles schema migrations with configuration pointing to the shared schema file.

### External Dependencies

**Shopify Integration**: The application integrates with Shopify's Admin API (version 2024-01) to fetch and synchronize order and product data. This requires:
- Custom app creation in Shopify admin
- Admin API access token with read_orders, read_products, read_customers, **write_products** scopes
  - **IMPORTANT**: The `write_products` scope is required to register product webhooks (products/create, products/update, products/delete)
  - After adding this scope, the Shopify app must be reinstalled to refresh the access token
- Environment variables: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_API_SECRET`
- Webhook registration for real-time updates (orders/create, orders/updated, products/create, products/update, products/delete)

**Webhook Processing**: Real-time synchronization uses an async queue-based architecture:
- Shopify order webhooks received at `/api/webhooks/shopify/orders`
- Shopify product webhooks received at `/api/webhooks/shopify/products`
- HMAC verification ensures webhook authenticity using `SHOPIFY_API_SECRET`
- Webhook payloads are queued to Upstash Redis for async processing
- Worker endpoint `/api/worker/process-webhooks` dequeues and processes webhooks in batches
- Environment-specific Upstash credentials (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) should be unsynced between dev and production

**Product Synchronization**:
- **Bootstrap**: On server startup, fetches existing products from Shopify Products Admin API (`/admin/api/2024-01/products.json`)
- **Webhooks**: Real-time updates via products/create, products/update, products/delete webhooks (requires `write_products` scope)
- **Variant Reconciliation**: When products are updated or deleted, variants are automatically soft-deleted or resurrected to stay in sync
- **Soft-Delete Architecture**: Products and variants use `deletedAt` timestamps instead of hard deletion for data integrity
- **Indexed Lookups**: Database indexes on `sku` and `bar_code` enable fast barcode scanning lookups for warehouse fulfillment workflows

**ShipStation Integration**: The application integrates with ShipStation V2 API to track shipments and manage fulfillment:
- Base URL: `https://api.shipstation.com`
- Authentication uses single API key in lowercase `api-key` header (V2 requirement)
- Environment variable: `SHIPSTATION_API_KEY` (production key from API Settings page)
- Webhook registration at `/v2/environment/webhooks` for shipment events
- Registered events: `fulfillment_shipped_v2`, `fulfillment_rejected_v2`, `track`, `batch`
- RSA-SHA256 signature verification using JWKS endpoint (api.shipengine.com/jwks) for webhook security
- Webhooks received at `/api/webhooks/shipstation/shipments`
- Order matching: ShipStation's `shipment_number` field contains the Shopify order number and is used to link shipments to orders
- **Automatic Bootstrap**: Server startup fetches existing shipments via `/v2/shipments` endpoint for first 10 orders (5-second timeout per order)
- **Webhook Architecture**:
  - `fulfillment_shipped_v2`: Creates/updates shipments with complete data (shipment_id + tracking number + order number)
  - `track`: Updates existing shipments that already have matching tracking numbers with latest tracking events
  - Track webhooks cannot create new shipments because they lack order information for safe matching
  - Shipments without tracking numbers are created by fulfillment webhooks or bootstrap, not track webhooks
- **Real-Time Notifications**: Order detail page shows toast notifications when shipment tracking is updated via WebSocket broadcasts

**Real-Time Updates**: WebSocket server provides live order updates to connected clients:
- WebSocket server runs alongside HTTP server on the same port at `/ws`
- Session-based authentication validates users during WebSocket upgrade
- Worker broadcasts order updates to all connected clients after processing webhooks
- Frontend automatically refreshes order list and shows toast notifications on updates
- Exponential backoff reconnection (1-30s) with automatic auth failure detection

**Email Service**: Nodemailer is used for sending magic link authentication emails. The transporter configuration needs to be set up in production with appropriate SMTP credentials.

**Database Service**: Neon serverless PostgreSQL database accessed via `DATABASE_URL` environment variable. The connection uses WebSocket protocol for serverless compatibility.

**Asset Storage**: User avatars are stored locally in the filesystem under the `/uploads` directory, served statically by Express.

### Authentication Flow

The application uses a passwordless authentication system to simplify access for warehouse staff:

1. User enters email address on login page
2. System generates a unique magic link token and sends email
3. User clicks link, token is verified and exchanged for a session
4. Session cookie provides authentication for subsequent requests
5. Expired tokens and sessions are cleaned up automatically

This approach eliminates password management overhead while maintaining security through time-limited tokens and secure session cookies.

### Design Decisions

**Monorepo Structure**: Client, server, and shared code (schema definitions) are co-located in a single repository with path aliases (`@/`, `@shared/`) for clean imports. This simplifies development and ensures type consistency between frontend and backend.

**Warehouse-Optimized UI**: Typography and spacing are intentionally larger than typical web applications to accommodate quick scanning in warehouse environments with varying lighting conditions. Single-purpose screens focus on one task at a time.

**JSONB for Orders**: Shopify order data is stored as JSONB in PostgreSQL rather than normalized tables. This provides flexibility to accommodate Shopify's evolving schema without frequent migrations, though it trades some query performance for development velocity.

**Session-Based Auth Over JWT**: HTTP-only session cookies were chosen over JWTs to prevent XSS attacks and enable server-side session revocation. The 30-day duration balances security with user convenience for warehouse staff who use the tool regularly.

**File Upload Strategy**: Avatar files are stored locally rather than using a cloud storage service. This keeps the infrastructure simple for a warehouse tool, though it would need to be reconsidered if the application scales horizontally.

**Async Product Bootstrap**: Product synchronization runs asynchronously after server startup using `setImmediate` to prevent blocking the application from accepting requests. The bootstrap process fetches 794+ products from Shopify in the background while the server is already available on port 5000. This ensures the application starts quickly (< 60s) and warehouse staff can begin working immediately, even if the product catalog takes a few minutes to fully synchronize.

### Product Catalog Features

**Products Page**: A warehouse-optimized product catalog interface accessible at `/products`:
- **Large Typography**: Product titles at 24px (text-2xl), variant counts at 30px (text-3xl), prices and inventory at 24px (text-2xl) for quick scanning in warehouse lighting
- **Two-Column Grid**: Optimized layout for desktop viewing with detailed product and variant information
- **Product Cards**: Each card displays product image, title, status badge, variant count, total inventory, and starting price
- **Variant Details**: Expandable section showing all variants with SKU, barcode, price, and individual inventory quantities
- **Search Functionality**: Filter products by name or ID for quick lookups
- **Warehouse-Critical Data**: SKUs (text-lg/18px) and barcodes (text-base/16px) are prominently displayed in monospace font for easy reading
- **Real-Time Sync**: Products automatically update when Shopify webhooks fire (create/update/delete events)
- **Inventory Display**: Shows aggregated inventory count across all variants plus per-variant quantities with color-coded badges

The Products page serves as both a catalog browser and a reference tool for warehouse staff to verify product information, check stock levels, and locate items by SKU or barcode during fulfillment operations.