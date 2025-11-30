# Warehouse Fulfillment Application

## Overview
This application is a warehouse fulfillment tool for ship.jerky.com, integrating with Shopify to manage orders. It provides a streamlined interface for warehouse staff to search orders, view details, and handle fulfillment tasks. The project aims to improve order processing and inventory management through real-time synchronization, a user-friendly interface, streamlined order management, real-time visibility into SkuVault wave picking sessions, efficient historical order backfill, comprehensive reporting, a print queue system for shipping labels, and real-time updates via WebSockets for order status.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture
### UI/UX Decisions
- **Design System**: Warm earth-tone palette, large typography for warehouse readability.
- **UI Components**: `shadcn/ui` (New York style variant) built on Radix UI, styled with Tailwind CSS.

### Technical Implementations
- **Frontend**: React with TypeScript (Vite), Wouter for routing, TanStack Query for server state management.
- **Backend**: Express.js with Node.js and TypeScript, RESTful API, Drizzle ORM for database interactions.
- **Authentication**: Google OAuth with domain restriction (@jerky.com only), secure HTTP-only session cookies. Users sign in with their Google Workspace account.
- **Data Storage**: PostgreSQL via Neon serverless connection, Drizzle Kit for migrations. Schema includes tables for users, authentication, orders, products, product variants, and order items. Comprehensive indexing strategy across all major tables for optimized query performance.
- **Normalized SkuVault Data Model**: SkuVault session data is normalized into relational columns instead of jsonb for single source of truth:
    - `shipments` table: firestoreDocumentId, sessionStatus, spotNumber, pickedByUserId/Name, pickStartedAt/EndedAt, savedCustomField2
    - `shipment_items` table: sv_* prefixed columns (svProductId, expectedQuantity, scannedQuantity, svPicked, svCompleted, svAuditStatus, svWarehouseLocation/Locations, svStockStatus, svAvailableQuantity, svNotFoundProduct, svIsSerialized, svPartNumber, svWeightPounds, svCode, svProductPictures)
    - Packing page uses `expectedQuantity` from SkuVault when available, falls back to ShipStation quantity
- **Core Features**:
    - **Order Management**: Synchronized product catalog, SkuVault wave picking session display, and SkuVault QC Integration for packing.
    - **Packing Page**: Single-warehouse MVP for order fulfillment with SkuVault QC validation, scan-first workflow, individual unit scanning, and comprehensive audit trails. Integrates with the print queue. Features daily station selection requirement:
        - **Web Packing Sessions**: Separate from desktop station sessions, stored in `web_packing_sessions` table
        - **Daily Expiration**: Sessions expire at midnight US Central time (calculated using date-fns-tz)
        - **Station Selection Modal**: Prompts user to select station before packing operations
        - **Action Gating**: All packing actions (order scan, product scan, manual verify, complete) require valid session
        - **Session Validation**: Both client and server validate session expiration
        - **Kit/Assembled Product Support**: SkuVault kit items are fully supported in the packing QC process:
            - Kit detection via `IsKit` flag and `KitProducts` array from SkuVault QC API
            - UI displays kit headers with purple "Kit" badge and instructional text ("Scan each component below")
            - Kit components are indented with purple "Kit Item" badge and show parent kit name
            - Component barcodes validated against `KitProducts[].Code`, `Sku`, and `PartNumber` fields
            - QC scan uses component's `Id` (not parent kit ID) for proper SkuVault quantity decrement
            - Legacy pattern matching fallback for kits without explicit `KitProducts` data
    - **Shipment Management**: Unified shipments page with workflow tabs (In Progress, Packing Queue, Shipped, All). Session info displayed inline on shipment cards. Tab-based filtering uses session status and ship date. Shipment details page with comprehensive metadata. Dual-ID Routing for all shipment-related API endpoints.
    - **Workflow Tabs**: 
        - **In Progress**: Orders currently being picked (sessionStatus = 'New' or 'Active')
        - **Packing Queue**: Orders ready to pack (sessionStatus = 'Closed' or 'Picked', no ship date yet)
        - **Shipped**: Orders that have been shipped (has ship date)
        - **All**: All shipments regardless of status
    - **Order Backfill System**: Fault-tolerant, task-based architecture for importing historical Shopify orders and ShipStation shipments, with Redis-queued processing, progress tracking, and WebSocket updates.
    - **Reporting & Analytics**: Reports page with business analytics dashboard (Gross Sales, Net Sales). PO Recommendations page with inventory recommendations querying a separate GCP PostgreSQL database.
    - **Operations Dashboard**: Real-time queue monitoring, worker status, backfill job status, and data health metrics via WebSockets.
    - **Print Queue System**: Automated shipping label printing workflow with background worker, retry logic, and browser auto-print.
    - **Desktop Printing System**: Three-tier architecture for native macOS printing:
        - **Database Schema**: `stations` (packing station locations), `printers` (discovered macOS printers), `desktop_clients` (authenticated Electron apps), `station_sessions` (20-hour user-station claims), `print_jobs` (job queue per station)
        - **API Endpoints**: REST API at `/api/desktop/*` for station/printer management, client registration, session claiming, and print job lifecycle
        - **Authentication**: Desktop apps authenticate via Google OAuth, receive API tokens (20-hour expiry), stored securely in macOS Keychain
        - **Station Sessions**: Users temporarily claim a physical station for their shift (20-hour expiry), not permanently assigned
        - **WebSocket Isolation**: Desktop clients use completely separate WebSocket channel from browser clients:
            - **Path**: `/ws/desktop` (vs `/ws` for browsers)
            - **Auth**: Bearer token in Authorization header (vs session cookie)
            - **Rooms**: `desktop:station:{stationId}` (isolated from browser rooms)
            - **Messages**: Namespaced types (`desktop:job:new`, `desktop:job:update`, `desktop:heartbeat`)
            - **Connection Tracking**: Separate maps from browser clients - bugs in one system won't affect the other
        - **Electron App**: Complete React-based desktop app in `desktop/` folder with:
            - **OAuth PKCE Flow**: Google OAuth with PKCE for secure desktop authentication
            - **Token Persistence**: Tokens stored securely in macOS Keychain via `keytar`
            - **WebSocket Client**: Connects to `/ws/desktop` with Bearer auth, automatic reconnect with exponential backoff (2s-30s), heartbeat every 30s
            - **Connection Status Indicator**: Visual indicator showing connection state:
                - Green dot + "Connected" when connected to server
                - Orange pulsing + "Retrying (N)..." during reconnection attempts
                - Yellow pulsing + "Connecting..." during initial connection
                - Red + "Disconnected" when connection lost after max retries (50)
            - **Station Management**: Users can create new stations or claim existing ones for 20-hour shifts
            - **Printer Discovery**: Native macOS printer discovery and registration
            - **Print Job Queue**: Real-time job delivery via WebSocket with status updates
            - **Session Persistence**: Station sessions and printer selection persist across app restarts:
                - Station ID saved to macOS Keychain alongside auth tokens
                - On startup, checks for existing active session via `/api/desktop/sessions/current`
                - Auto-restores station and printers without requiring reclaim
                - Falls back to reclaim if no active session exists
                - Clears stale data on any failure to prevent ghost states
            - **Environment Switching**: Dashboard UI allows switching between development/production environments while logged in; auto-triggers re-authentication with new server and reconnects WebSocket
            - **Graceful Shutdown**: Sends `desktop:going_offline` message with ACK confirmation before closing, ensuring server properly tracks station status
            - **Remote Configuration ("Mars Rover" Control)**: Desktop clients fetch timing settings from server on startup and receive real-time updates via WebSocket, eliminating need for desktop app redeployment:
                - **Configurable Parameters**: connectionTimeout, baseReconnectDelay, maxReconnectDelay, heartbeatInterval, reconnectInterval, tokenRefreshInterval, offlineTimeout
                - **Web Admin Page**: `/desktop-config` page with form to edit all 7 timing parameters with validation (minimum values enforced)
                - **Real-time Updates**: Changes broadcast via `desktop:config_update` WebSocket message to all connected clients
                - **Defensive Clamping**: Desktop runtime enforces minimum values as backstop even if server sends dangerous values
                - **File Menu**: "View Configuration" option (Cmd+, / Ctrl+,) shows current settings in read-only dialog
                - **Database Storage**: Single row in `desktop_config` table with ID 'default', tracks lastUpdatedBy and updatedAt
    - **Web-based Stations Management**: Full CRUD page at `/stations` for managing packing stations. When a station is deleted, active desktop sessions are automatically terminated and clients are notified via WebSocket (`desktop:station:deleted` message). Includes real-time connection status tracking:
        - Each station displays online/offline status with Wifi/WifiOff icons based on active WebSocket connections
        - Filter tabs (All/Online/Offline) with URL-based filtering via `?connection=online|offline`
        - Connection stats only count active stations (inactive stations excluded from health metrics)
    - **Operations Dashboard Station Monitoring**: Pipeline Metrics section includes Offline Stations card showing:
        - Count of active stations without WebSocket connections
        - Health badge (healthy/warning/critical) based on offline percentage
        - Click navigates to filtered stations list
    - **Real-Time Updates**: WebSocket server provides live order updates, queue status, print queue status, and notifications.
    - **Saved Views System**: Customizable column views for PO Recommendations page stored in `saved_views` table.
- **Monorepo Structure**: Client, server, and shared code co-located.
- **Centralized ETL Architecture**: `ShopifyOrderETLService` and `ShipStationShipmentETLService` classes centralize data transformations for consistent processing.
- **Worker Coordination System**: Production-ready coordination between on-hold poll worker and backfill jobs using Redis-backed mutex.
- **Webhook Environment Isolation**: Automatic orphaned webhook cleanup on startup.

### System Design Choices
- **Webhook Configuration**: Environment-aware webhook registration with automatic rollback on failure.
- **Worker Coordination Resilience**: All coordinator operations wrapped in error handling with fail-safe semantics.

## External Dependencies
-   **Shopify Integration**: Admin API (2024-01) for order, product, and customer data synchronization, utilizing webhooks.
-   **ShipStation Integration**: V2 API for shipment tracking and fulfillment, with robust rate limit handling.
-   **SkuVault Integration**: Reverse-engineered web API for wave picking session data and Quality Control (QC) scanning. Features automatic authentication with Redis-backed token caching.
    - **Product Lookup Types** (`shared/skuvault-types.ts`): Discriminated union type system for product classification:
        - `ProductType`: 'individual' | 'kit' | 'assembledProduct'
        - `ProductLookupEnvelope`: Full Zod schema for API response validation
        - `ProductDetails`: Discriminated union (IndividualProductDetails | KitProductDetails | AssembledProductDetails)
        - `transformProductLookup()`: Normalizes API response into typed ProductDetails
        - TODO comments for fields needing warehouse clarification: `IsSerialized`, `IsLotted`, `LotPrioritySetting`
    - **Service Methods**:
        - `getProductDetailsByCode()`: Returns typed ProductDetails discriminated union
        - `passKitQCItem()`: Marks kit components as QC passed with KitId tracking
        - Endpoints:
            - `GET /api/skuvault/qc/product-details/:searchTerm`: Lookup product with type classification
            - `POST /api/skuvault/qc/pass-item`: Mark individual items as QC passed
            - `POST /api/skuvault/qc/pass-kit-item`: Mark kit components as QC passed (includes KitId)
-   **Upstash Redis**: Used for asynchronous webhook and backfill job processing queues.
-   **Google OAuth**: For authentication, restricted to @jerky.com Google Workspace domain.
-   **Neon Database**: Serverless PostgreSQL database (primary).
-   **GCP PostgreSQL**: Separate reporting database for purchase order recommendations and inventory forecasting analytics.