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

**Migration Strategy**: Drizzle Kit handles schema migrations with configuration pointing to the shared schema file.

### External Dependencies

**Shopify Integration**: The application integrates with Shopify's Admin API (version 2024-01) to fetch and synchronize order data. This requires:
- Custom app creation in Shopify admin
- Admin API access token with read_orders, read_products, read_customers scopes
- Environment variables: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_API_SECRET`
- Webhook registration for real-time order updates (orders/create, orders/updated)

**Webhook Processing**: Real-time order synchronization uses an async queue-based architecture:
- Shopify webhooks are received at `/api/webhooks/shopify/orders`
- HMAC verification ensures webhook authenticity using `SHOPIFY_API_SECRET`
- Webhook payloads are queued to Upstash Redis for async processing
- Worker endpoint `/api/worker/process-webhooks` dequeues and processes orders in batches
- Environment-specific Upstash credentials (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) should be unsynced between dev and production

**ShipStation Integration**: The application integrates with ShipStation V2 API to track shipments and manage fulfillment:
- Base URL: `https://api.shipstation.com`
- Authentication uses single API key in lowercase `api-key` header (V2 requirement)
- Environment variable: `SHIPSTATION_API_KEY` (production key from API Settings page)
- Webhook registration at `/v2/environment/webhooks` for shipment events
- Supported events: `fulfillment_shipped_v2`, `fulfillment_created_v2`, `fulfillment_updated_v2`, `fulfillment_canceled_v2`, `track`, `batch`, and others
- RSA-SHA256 signature verification using JWKS endpoint for webhook security
- Webhooks received at `/api/webhooks/shipstation/shipments`

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