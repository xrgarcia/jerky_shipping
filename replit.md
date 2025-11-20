# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The design is adapted from the `jerky_top_n_web` theme, focusing on readability and efficiency in a warehouse environment. It aims to improve order processing and inventory management through real-time synchronization and a user-friendly interface. Key capabilities include: streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status. The project's ambition is to enhance order processing efficiency and accuracy for ship.jerky.com.

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
    - **Shipment Sync Worker**: Dual-path asynchronous processor for enriching shipment data from ShipStation, handling tracking numbers and order numbers. Includes robust rate limit handling and detailed failure logging to a dead letter queue.
    - **Shipments Page**: Displays all shipments with proper SQL LEFT JOIN to orders table for reliable order/customer data retrieval. UI always displays shipment_id as fallback identifier when order linkage is missing. Replaced previous in-memory join (limited to 50 orders) with efficient SQL query.
    - **Reports Page**: Business analytics dashboard with date range filtering, interactive charts, and metrics aligned to Central Standard Time (America/Chicago).
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, Shopify credentials validation, safe webhook re-registration, and data health metrics via WebSockets. Provides interactive failures table and purge actions.
    - **Print Queue System**: Manages shipping label printing workflow with real-time status updates via WebSockets.
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, and notifications.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Async Product Bootstrap**: Products synchronize asynchronously on server startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration for development and production, supporting independent webhook delivery and automatic rollback on failure.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup prevents dev/prod webhook duplication. REPLIT_DOMAINS is correctly parsed (comma-separated list, first domain only) and webhooks pointing to different base URLs are automatically deleted. URL parsing is wrapped in try/catch to handle malformed addresses gracefully.

## External Dependencies

-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks for real-time updates.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment. Features a dual-path async queue system for webhook processing, intelligent rate limit handling, and a 5-tier fallback strategy for linking tracking numbers to orders. Handles multi-channel order numbers (e.g., Amazon, Shopify).
-   **SkuVault Integration**: Reverse-engineered web API for accessing wave picking session data, including HTML form login and token caching, with built-in rate limiting.
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Nodemailer**: For sending magic link authentication emails.
-   **Neon Database**: Serverless PostgreSQL database.