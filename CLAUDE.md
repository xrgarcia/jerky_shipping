# CLAUDE.md — Ship. Smart Fulfillment System

## Project Overview

**Ship.** is a warehouse fulfillment platform for jerky.com that integrates Shopify, ShipStation, and SkuVault to automate packaging decisions, carrier selection, and packing station routing. The frontend is primarily built and maintained in Replit — Claude assists with **backend work** (API routes, services, workers, database, integrations).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript 5.6 (ES Modules) |
| Server | Express 4.21 |
| Frontend | React 18.3, Vite 5.4, Wouter 3.3 (routing), shadcn/ui, Tailwind CSS 3.4 |
| Database | PostgreSQL 16 via Neon serverless (`@neondatabase/serverless`) |
| ORM | Drizzle ORM 0.39 (type-safe SQL) |
| Reporting DB | GCP PostgreSQL via `postgres` (node-postgres), read-only |
| Queue | Upstash Redis (REST-based, serverless) |
| Real-time | WebSocket (`ws` library) |
| Auth | Google OAuth 2.0 (Passport.js), restricted to @jerky.com domain |
| Sessions | `express-session` + `connect-pg-simple` (PostgreSQL store, 30-day expiry) |
| State Mgmt | TanStack React Query 5 (server state), no Redux/Zustand |
| Monitoring | Honeycomb OpenTelemetry, Winston logging |
| Deployment | Replit (auto-deploy on push to main) |

## Directory Structure

```
client/                  # React frontend (Vite)
  src/
    pages/               # Route components (shipments, orders, packing, etc.)
    components/          # UI components (shadcn/ui in components/ui/)
    hooks/               # Custom React hooks
    lib/                 # queryClient, utils
server/                  # Express backend
  index.ts               # Entry point: middleware, vite setup, websocket, worker init
  routes.ts              # ALL API endpoints (~310 routes, single monolithic file)
  storage.ts             # Data access layer (100+ methods)
  db.ts                  # Drizzle ORM setup, Neon pool, heartbeat
  reporting-db.ts        # GCP reporting database connection
  reporting-storage.ts   # Analytics/forecasting queries
  websocket.ts           # WebSocket broadcast helpers
  services/              # Business logic services
  utils/                 # API clients, queue ops, helpers
  *-worker.ts            # Background workers (10+ workers)
shared/
  schema.ts              # Drizzle table definitions (60+ tables, 150+ indexes)
  firestore-schema.ts    # Firestore collection types
  reporting-schema.ts    # GCP reporting DB schema
  forecasting-types.ts   # Forecasting data types
  skuvault-types.ts      # SkuVault API response types
migrations/              # Drizzle auto-generated migrations
```

## Key Commands

```bash
npm run dev          # Start dev server (tsx + vite HMR) on port 5000
npm run build        # Vite builds client → dist/public, esbuild bundles server → dist/index.js
npm run start        # Production: NODE_ENV=production node dist/index.js
npm run check        # TypeScript type check
npm run db:push      # Push Drizzle schema changes to DATABASE_URL
```

## Database

### Connection
- **Primary**: Neon serverless PostgreSQL (`DATABASE_URL`). Pool: max 10, min 1, idle 5min, connect timeout 15s.
- **Reporting**: GCP PostgreSQL (`REPORTING_DATABASE_URL`). Read-only for analytics, forecasting, PO recommendations.
- **Heartbeat**: `SELECT 1` every 3 minutes, 6am–6pm Central only, to prevent Neon cold starts.

### Schema Location
All tables defined in `shared/schema.ts` using Drizzle ORM. Key entity groups:

- **Orders**: `orders`, `order_items`, `order_refunds`
- **Shipments**: `shipments`, `shipment_items`, `shipment_packages`, `shipment_qc_items`, `shipment_tags`, `shipment_events`, `shipment_rate_analysis`
- **Fulfillment**: `fulfillment_sessions`, `stations`, `station_sessions`, `packing_logs`
- **Printing**: `desktop_clients`, `printers`, `print_jobs`, `desktop_config`
- **Products**: `shopify_products`, `shopify_product_variants`, `skuvault_products`
- **Packaging**: `packaging_types`, `fingerprints`, `fingerprint_models`, `product_collections`, `product_collection_mappings`
- **Kit Mappings**: `kit_component_mappings`, `slashbin_orders`, `slashbin_order_items`
- **Auth**: `users`, `sessions`, `magic_link_tokens`, `saved_views`
- **Queues/Dead Letters**: `shipment_sync_failures`, `shopify_order_sync_failures`, `shipments_dead_letters`, `qc_explosion_queue`, `rate_check_queue`, `shipstation_write_queue`
- **Jobs**: `backfill_jobs`, `lifecycle_repair_jobs`, `rate_analysis_jobs`
- **Config**: `feature_flags`, `shipping_methods`, `sync_cursors`

### Migrations
```bash
npm run db:push   # Drizzle Kit pushes schema.ts changes directly to Neon
```

## API Architecture

All routes live in `server/routes.ts` (monolithic, ~310 endpoints). Key patterns:

- Every protected route uses `requireAuth` middleware (checks `req.session.userId`)
- Routes return JSON; paginated endpoints return `{ items, total, page, pageSize }`
- Filters parsed from `req.query`, applied as Drizzle `where(and(...))` clauses
- Error handling middleware catches exceptions and returns `{ message }` with status code

### Key Endpoint Groups
| Prefix | Purpose |
|--------|---------|
| `/api/auth/*` | Google OAuth, magic links, session management |
| `/api/orders/*` | Shopify order CRUD, search, backfill, CSV import |
| `/api/shipments/*` | ShipStation shipment CRUD, lifecycle, rate analysis |
| `/api/sessions/*` | Fulfillment/wave picking session management |
| `/api/qc/*` | QC item checklist, barcode scanning, completion |
| `/api/print-jobs/*` | Print queue management |
| `/api/desktop/*` | Desktop printing client auth, stations, printers, config |
| `/api/packaging-types/*` | Box/bag type management |
| `/api/collections/*` | Product collection management |
| `/api/fingerprints/*` | Fingerprint CRUD and model training |
| `/api/webhook/shopify` | Shopify webhooks (HMAC-verified) |
| `/api/webhook/shipstation` | ShipStation webhooks (HMAC-verified) |
| `/api/backfill/*` | Data import/recovery jobs |
| `/api/users/*` | User profile management |
| `/api/views/*` | Saved filter views |
| `/api/rate-analysis/*` | Smart carrier rate analysis |
| `/api/forecast` | Sales forecasting |
| `/api/po-recommendations` | Purchase order recommendations |

## Background Workers

Workers start in `initializeAfterListen()` after the server port opens. All defined as `*-worker.ts` files in `server/`.

| Worker | File | Purpose | Interval |
|--------|------|---------|----------|
| Webhook Queue | `background-worker.ts` | Process Shopify webhooks from Redis | 5s, batch 50 |
| Shipment Sync | `shipment-sync-worker.ts` | Process ShipStation events from Redis | Event-driven |
| Unified Sync | `unified-shipment-sync-worker.ts` | Poll ShipStation API (cursor-based) | 30s |
| Shopify Sync | `shopify-sync-worker.ts` | Fetch missing Shopify orders | Queue-driven |
| Lifecycle Events | `lifecycle-event-worker.ts` | Process state machine transitions | Queue-driven |
| Lifecycle Repair | `lifecycle-repair-worker.ts` | Fix stuck shipments | On-demand |
| Print Queue | `print-queue-worker.ts` | Fetch labels, detect stale jobs | 10s |
| Rate Backfill | `rate-analysis-backfill-worker.ts` | Background rate analysis | On-demand |
| SkuVault QC | `skuvault-qc-worker.ts` | Sync QC completion status | Periodic |
| SkuVault Products | `skuvault-products-sync-worker.ts` | Sync product catalog from GCP | Hourly |
| Firestore Sync | `firestore-session-sync-worker.ts` | Sync SkuVault sessions via Firebase | Real-time listener |
| PO Cache Warmer | `po-cache-warmer.ts` | Pre-warm PO recommendation cache | 6 hours |

### Queue System
- **Upstash Redis** (REST API): Shopify webhooks, ShipStation sync events, order sync, lifecycle events
- **PostgreSQL queues**: `qc_explosion_queue`, `rate_check_queue`, `shipstation_write_queue` (for reliable outbound writes)
- **Worker coordination**: Redis-based mutex prevents duplicate processing

## External Integrations

### Shopify (`server/utils/shopify-webhook.ts`)
- Admin API 2024-01: orders, products, customers
- Webhook verification: HMAC-SHA256
- Topics: `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/cancelled`, `products/update`

### ShipStation (`server/utils/shipstation-api.ts`)
- API V2 with `X-API-Key` auth
- Rate limit: 40 calls/minute (intelligent backoff via `X-Rate-Limit` headers)
- Key ops: shipment CRUD, label creation, carrier rate comparison
- Webhook verification: HMAC-SHA256

### SkuVault (`server/services/skuvault-service.ts`)
- **Reverse-engineered web API** (not officially documented)
- Auth: POST form login → extract `sv-t` cookie → use as Bearer token
- Token cached in Redis (24hr TTL)
- Lockout after 10 failed logins (tracked with TTL)
- Key ops: session queries, product lookup, QC pass/fail

### Firebase/Firestore (`server/firestore-storage.ts`)
- Service account auth (`FIREBASE_SERVICE_ACCOUNT` env var, JSON)
- Real-time `onSnapshot` listener for SkuVault session data
- Synced to PostgreSQL `shipments` table

## Lifecycle State Machine

Defined in `server/services/lifecycle-state-machine.ts` and `lifecycle-service.ts`.

**Phases**: `fulfillment_prep` → `ready_to_pick` → `picking` → `packing_ready` → `on_dock` → `in_transit` → `delivered` (also `cancelled`)

**Decision subphases** within phases: `needs_categorization`, `needs_fingerprint`, `needs_rate_check`, `needs_package`

Side effects trigger on transitions: QC hydration, fingerprinting, rate analysis, package dimension sync.

## WebSocket

Server broadcasts to connected browser clients via `server/websocket.ts`:
- `order_update` — order status changes
- `queue_status` — queue lengths, worker health
- `print_queue_update` — print job status, stale alerts
- `desktop_*` — desktop client config/station/printer updates

Desktop printing clients use a separate WebSocket with token-based auth.

## Import Path Aliases

```typescript
import { Button } from '@/components/ui/button'   // @/* → client/src/*
import { shipments } from '@shared/schema'         // @shared/* → shared/*
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon PostgreSQL connection string (required) |
| `REPORTING_DATABASE_URL` | GCP reporting DB |
| `SHOPIFY_SHOP_DOMAIN` | e.g., jerky.myshopify.com |
| `SHOPIFY_API_SECRET` | Webhook HMAC verification |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Admin API auth |
| `SHIPSTATION_API_KEY` | ShipStation auth |
| `UPSTASH_REDIS_REST_URL` | Redis queue endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth |
| `FIREBASE_SERVICE_ACCOUNT` | Firestore credentials (JSON) |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `HONEYCOMB_API_KEY` | OpenTelemetry tracing |
| `PORT` | Server port (default: 5000) |
| `NODE_ENV` | development / production |

## Conventions & Rules

1. **Backend focus**: Claude helps with `server/`, `shared/`, and backend logic. Frontend is primarily built in Replit.
2. **Monolithic routes file**: All API routes are in `server/routes.ts`. New routes go there too.
3. **Storage pattern**: Data access methods live in `server/storage.ts`. Routes call storage methods, not raw Drizzle queries.
4. **Service layer**: Complex business logic goes in `server/services/`. Services are stateless and imported directly.
5. **Worker pattern**: Background workers are standalone `*-worker.ts` files in `server/`. They're started in `initializeAfterListen()`.
6. **Schema changes**: Edit `shared/schema.ts`, then `npm run db:push` to apply.
7. **No automated tests**: Testing is manual via UI and server logs.
8. **Drizzle ORM**: All database queries use Drizzle — no raw SQL strings.
9. **Error handling**: Routes catch errors via Express middleware. Neon cold starts handled by `withRetrySafe()` in `server/utils/db-retry.ts`.
10. **Date handling**: Uses `date-fns` and `date-fns-tz`. Business hours are Central Time.
11. **Webhook security**: All inbound webhooks (Shopify, ShipStation) are HMAC-SHA256 verified.
12. **Queue reliability**: Dead letter tables catch failed sync operations. ShipStation writes use a PostgreSQL-backed retry queue.
13. **Connected MCP database**: Claude has read-only SQL access to the production database via the `jerky-postgres-db` MCP server. Use `mcp__jerky-postgres-db__query` to inspect live data when debugging.
