# CLAUDE.md — Ship. Smart Fulfillment System

## Project Overview

**Ship.** is a warehouse fulfillment platform for jerky.com that integrates Shopify, ShipStation, and SkuVault to automate packaging decisions, carrier selection, and packing station routing.

**Communication style**: Simple, everyday language. No jargon unless necessary.

**Critical rule**: The production database is the source of truth. Data fixes must target production, not the development database. Dev database changes have no effect on real operations.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript 5.6 (ES Modules, strict mode) |
| Server | Express 4.21 |
| Frontend | React 18.3, Vite 5.4, Wouter 3.3 (routing), shadcn/ui (New York style), Tailwind CSS 3.4 |
| Database | PostgreSQL 16 via Neon serverless (`@neondatabase/serverless`) |
| ORM | Drizzle ORM 0.39 (type-safe SQL) + Drizzle-Zod for validation |
| Reporting DB | GCP PostgreSQL via `postgres` (node-postgres), read-only |
| Queue | Upstash Redis (REST-based, serverless) |
| Real-time | WebSocket (`ws` library) with room-based routing |
| Auth | Google OAuth 2.0 (Passport.js), restricted to @jerky.com domain |
| Sessions | `express-session` + `connect-pg-simple` (PostgreSQL store, 30-day expiry) |
| State Mgmt | TanStack React Query 5 (server state), URL params (filter state), localStorage (workstation) |
| Forms | React Hook Form + Zod resolvers |
| Charts | Recharts 2.15 |
| Icons | Lucide React, react-icons |
| Date/Time | date-fns + date-fns-tz (Central Time for business hours) |
| Monitoring | Honeycomb OpenTelemetry, Winston logging |
| Deployment | Replit (auto-deploy on push to main) |

## Directory Structure

```
client/                  # React frontend (Vite)
  src/
    main.tsx             # Entry point: React DOM render
    App.tsx              # QueryClientProvider → auth check → sidebar layout → routes
    index.css            # Tailwind layers + custom elevation utilities
    pages/               # ~30 route components (shipments, orders, packing, forecasting, etc.)
    components/          # Custom components + shadcn/ui (48 components in components/ui/)
    hooks/               # Custom hooks (use-toast, use-forecasting, use-user-preference, use-inactivity-timeout)
    lib/                 # queryClient.ts (API fetch wrapper), utils.ts (cn helper), workstation-guard.ts
server/                  # Express backend
  index.ts               # Entry point: middleware, vite setup, websocket, worker init
  routes.ts              # ALL API endpoints (~310 routes, single monolithic file, ~16K lines)
  storage.ts             # Data access layer (IStorage interface, 150+ methods, ~4K lines)
  db.ts                  # Drizzle ORM setup, Neon pool, heartbeat (6am-6pm Central)
  reporting-db.ts        # GCP reporting database connection (read-only)
  reporting-storage.ts   # Analytics/forecasting queries
  websocket.ts           # Browser + desktop WebSocket with room-based routing
  services/              # 24 business logic services (stateless, imported directly)
  utils/                 # API clients, queue ops, logger, db-retry, webhook verification
  *-worker.ts            # Background workers (12+ workers)
shared/
  schema.ts              # Drizzle table definitions (60+ tables, 150+ indexes)
  firestore-schema.ts    # Firestore collection types
  reporting-schema.ts    # GCP reporting DB types
  forecasting-types.ts   # Forecasting enums, API response types
  skuvault-types.ts      # SkuVault API types (Zod-validated, discriminated unions)
migrations/              # Drizzle auto-generated migrations
```

## Key Commands

```bash
npm run dev          # Start dev server (tsx + vite HMR) on port 5000
npm run build        # Vite builds client → dist/public, esbuild bundles server → dist/index.js
npm run start        # Production: NODE_ENV=production node dist/index.js
npm run check        # TypeScript type check
npm run db:push      # Push Drizzle schema changes directly to DATABASE_URL (no migration files)
```

## Database

### Connection
- **Primary**: Neon serverless PostgreSQL (`DATABASE_URL`). Pool: max 10, min 1, idle 5min, connect timeout 15s. Uses `ws` library for WebSocket connection.
- **Reporting**: GCP PostgreSQL (`REPORTING_DATABASE_URL`). Read-only for analytics, forecasting, PO recommendations. Pool: max 10, idle 20s, keep_alive 30s. Uses tagged template literals for queries.
- **Heartbeat**: `SELECT 1` every 3 minutes, 6am–6pm Central only, to prevent Neon cold starts.

### Schema Location
All tables defined in `shared/schema.ts` using Drizzle ORM.

**Key entity groups:**
- **Orders**: `orders`, `order_items`, `order_refunds`
- **Shipments**: `shipments`, `shipment_items`, `shipment_packages`, `shipment_qc_items`, `shipment_tags`, `shipment_events`, `shipment_rate_analysis`
- **Fulfillment**: `fulfillment_sessions`, `stations`, `station_sessions`, `packing_logs`
- **Printing**: `desktop_clients`, `printers`, `print_jobs`, `desktop_config`
- **Products**: `shopify_products`, `shopify_product_variants`, `skuvault_products`
- **Packaging**: `packaging_types`, `fingerprints`, `fingerprint_models`, `product_collections`, `product_collection_mappings`
- **Kit Mappings**: `kit_component_mappings`, `slashbin_orders`, `slashbin_order_items`
- **Auth**: `users`, `sessions`, `magic_link_tokens`, `saved_views`, `user_preferences`
- **Queues/Dead Letters**: `shipment_sync_failures`, `shopify_order_sync_failures`, `shipments_dead_letters`, `qc_explosion_queue`, `rate_check_queue`, `shipstation_write_queue`
- **Jobs**: `backfill_jobs`, `lifecycle_repair_jobs`, `rate_analysis_jobs`
- **Config**: `feature_flags`, `shipping_methods`, `sync_cursors`

### Schema Conventions

**Primary keys:**
- Most tables: `varchar("id").primaryKey().default(sql\`gen_random_uuid()\`)`
- Some tables use serial int (e.g., `fulfillmentSessions`), natural keys (e.g., `skuvaultProducts` uses SKU), or composite keys (e.g., `purchaseOrderSnapshots` uses stock_check_date + sku)

**Timestamps:**
- `timestamp("created_at").notNull().defaultNow()` for creation
- Nullable timestamps for optional events (e.g., `completedAt`, `expiresAt`)
- Null = "not yet done" semantics

**Enums — two patterns:**
```typescript
// 1. Object-based constants (preferred for lifecycle/decision tracking)
export const LIFECYCLE_PHASES = { READY_TO_FULFILL: 'ready_to_fulfill', ... } as const;
export type LifecyclePhase = typeof LIFECYCLE_PHASES[keyof typeof LIFECYCLE_PHASES];

// 2. TypeScript native enums (used in Zod validation)
export enum SessionState { ACTIVE = "active", INACTIVE = "inactive", ... }
```

**Foreign keys:** `varchar("column_name").references(() => targetTable.id)` — nullable for optional relationships, some with `onDelete: "cascade"`.

**Indexes — 150+ across 60+ tables:**
- Unique indexes on identifiers: `uniqueIndex("shipments_shipment_id_idx").on(table.shipmentId)`
- Partial indexes for filtered queries: `.where(sql\`status IN ('delivered','in_transit')\`)`
- Composite indexes for common WHERE + ORDER BY: `.on(table.orderNumber, table.carrierCode)`
- DESC ordering for recent-first queries: `.on(table.createdAt.desc().nullsLast())`

**Type exports:**
```typescript
export const insertShipmentSchema = createInsertSchema(shipments)
  .omit({ id: true, createdAt: true })
  .extend({ shipDate: z.coerce.date().optional().or(z.null()) });
export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipments.$inferSelect;
```

**Monetary fields**: Stored as `text` (not numeric) to match Shopify API string format and avoid decimal precision issues. Only use `numeric(precision, scale)` when calculations are needed (e.g., rate analysis cost savings).

**JSON storage**: `jsonb` for complex objects (Shopify line items, shipping addresses, metadata, raw API responses).

## Server Architecture

### Bootstrap Sequence (server/index.ts)

1. Global error handlers for Neon connection issues
2. Express setup with JSON parser + `rawBody` capture (for HMAC webhook verification)
3. Request logging middleware for all `/api` routes
4. `initializeDatabase()` — creates `pg_trgm` extension
5. Lazy import of storage (after extension exists)
6. Route registration
7. Global error middleware
8. Vite setup (development only)
9. WebSocket setup
10. **Port opens** (port 5000) — health checks pass immediately
11. `setImmediate(() => initializeAfterListen())` — all expensive work deferred:
    - Broadcast initial queue status
    - Register Shopify/ShipStation webhooks
    - Start 20+ background workers (conditional on env vars)

**Design principle**: Port opens fast so Replit health checks pass, then heavy initialization happens after.

### API Architecture (server/routes.ts)

All ~310 routes live in one monolithic file. Key patterns:

**Authentication:**
```typescript
app.get("/api/endpoint", requireAuth, async (req, res) => {
  const user = (req as any).user;
  // ...
  res.json({ data });
});
```

**Pagination response format:**
```typescript
{ items: T[], total: number, page: number, pageSize: number }
```

**Filter parsing:** Query params parsed from `req.query`, normalized to arrays when needed, applied as Drizzle `where(and(...))` clauses.

**Error handling:** Try/catch in each route + global Express error middleware. Returns `{ error: "User-friendly message" }` with status code.

**Batch endpoints (N+1 prevention):** `/api/shipments/packages/batch` accepts array of IDs, returns Map as JSON object. Max 100 items per batch.

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
| `/api/packing-decisions/*` | Uncategorized SKU assignment |
| `/api/fulfillment-sessions/*` | Session building/preview |
| `/api/purchase-orders/*` | PO snapshots and projections |

### Data Access Layer (server/storage.ts)

**Pattern:** Interface-based (`IStorage`) with `DatabaseStorage` implementation. Exported as singleton: `export const storage = new DatabaseStorage()`.

```typescript
// CRUD
async createOrder(order: InsertOrder): Promise<Order> {
  const result = await db.insert(orders).values(order).returning();
  return result[0];
}

// Filtered queries with dynamic WHERE clauses
const whereClauses: SQL[] = [];
if (filters.search) whereClauses.push(or(...searchConditions));
const result = await db.select().from(orders).where(and(...whereClauses));

// Upsert
await db.insert(table).values(data).onConflictDoUpdate({ target: table.id, set: data }).returning();

// Batch queries (returns Map)
async getShipmentPackagesBatch(ids: string[]): Promise<Map<string, ShipmentPackage[]>> { ... }
```

**Rules:** Routes call storage methods — never raw Drizzle queries. All mutations use `.returning()`.

### Service Layer (server/services/)

24 stateless services imported directly. Key patterns:

**Lifecycle (event-driven):** Three-tier API — direct update, single queue, batch queue. `queueLifecycleEvaluation()` is preferred over direct `updateShipmentLifecycle()`.

**State machine (pure function):** `deriveLifecyclePhase(shipment)` takes data, returns phase — no I/O. Demotion guard prevents backwards transitions.

**ETL (ShipStation):** Class-based with dependency injection. Smart three-tier lookup (tracking → shipmentId → orderNumber). Preservation guards prevent overwriting real data with placeholders.

### Background Workers (server/*-worker.ts)

Workers start in `initializeAfterListen()` after the port opens. All conditional on Redis env vars.

| Worker | File | Purpose | Interval |
|--------|------|---------|----------|
| Webhook Queue | `background-worker.ts` | Process Shopify webhooks from Redis | 5s, batch 50 |
| Shipment Sync | `shipment-sync-worker.ts` | Process ShipStation events from Redis | 10s, batch 50 |
| Unified Sync | `unified-shipment-sync-worker.ts` | Poll ShipStation API (cursor-based) | 30s |
| Shopify Sync | `shopify-sync-worker.ts` | Fetch missing Shopify orders | 8s, queue-driven |
| Lifecycle Events | `lifecycle-event-worker.ts` | Process state machine transitions | Queue-driven |
| Lifecycle Repair | `lifecycle-repair-worker.ts` | Fix stuck shipments | On-demand |
| Print Queue | `print-queue-worker.ts` | Fetch labels, detect stale jobs | 10s |
| Rate Backfill | `rate-analysis-backfill-worker.ts` | Background rate analysis | On-demand |
| SkuVault QC | `skuvault-qc-worker.ts` | Sync QC completion status | Periodic |
| SkuVault Products | `skuvault-products-sync-worker.ts` | Sync product catalog from GCP | Hourly |
| Firestore Sync | `firestore-session-sync-worker.ts` | Sync SkuVault sessions via Firebase | Real-time listener |
| PO Cache Warmer | `po-cache-warmer.ts` | Pre-warm PO recommendation cache | 6 hours |

**Worker pattern:**
- `isProcessing` guard prevents concurrent runs
- Batch dequeue from Redis (high-priority first, then low)
- Error isolation per item (failed item doesn't stop batch)
- Rate limit detection → wait + requeue
- Dead letter tables for retry exhaustion

### Queue System
- **Upstash Redis** (REST API): Shopify webhooks, ShipStation sync events, order sync, lifecycle events. Priority routing (high/low queues). Deduplication via Redis SADD.
- **PostgreSQL queues**: `qc_explosion_queue`, `rate_check_queue`, `shipstation_write_queue` (reliable outbound writes with `FOR UPDATE SKIP LOCKED`).
- **Worker coordination**: Redis-based mutex prevents duplicate processing.

### WebSocket (server/websocket.ts)

**Browser clients:** Room-based routing (home, operations, orders, backfill, default). Session cookie authentication.

**Desktop clients:** Separate WebSocket path with token-based auth (Bearer token). Station subscription model. Heartbeat tracking.

**Broadcast message types:**
- `order_update` — order status changes
- `queue_status` — queue lengths, worker health
- `print_queue_update` — print job status, stale alerts
- `desktop_*` — desktop client config/station/printer updates

### Utilities (server/utils/)

**Logger (`logger.ts`):** Winston with correlation context via `withOrder(orderNumber, shipmentId, extras)`. Timestamp format: `h:mm:ss A`. All logs include JSON metadata.

**DB Retry (`db-retry.ts`):** `withRetry()` for exponential backoff (3 retries, 1-8s range, 20% jitter). `withRetrySafe()` returns null on exhaustion. Detects transient Neon errors by code and message patterns.

**Queue (`queue.ts`):** Redis queue operations with priority routing, deduplication, batch dequeue, inline webhook data optimization.

**ShipStation API (`shipstation-api.ts`):** Rate limit handling (40 req/min), intelligent backoff via `X-Rate-Limit` headers.

**Webhook verification:** HMAC-SHA256 for both Shopify and ShipStation webhooks, using `rawBody` captured in middleware.

## Frontend Architecture

### App Bootstrap (client/src/App.tsx)

Three provider layers: `QueryClientProvider` → `TooltipProvider` → `AppContent`.

**Auth flow:** `useQuery(["/api/auth/me"])` checks session → unauthorized redirects to `/login` → authenticated redirects from `/login` to `/shipments`. Auto-logout after 10 min inactivity (warns at 9 min).

**Layout:** shadcn/ui `SidebarProvider` with ~40 menu items across sections. Wouter `<Route>` components for ~45 routes.

### Routing (Wouter 3.3)

- `useLocation()` — get/set current location
- `useSearch()` — parse URL query strings
- `useRoute(path)` — match routes with params (e.g., `/shipments/:id`)
- `Link` component for navigation
- Complex pages sync filter state to URL via `history.replaceState()` (avoids history pollution)

### State Management

| Layer | Tool | Usage |
|-------|------|-------|
| Server data | TanStack React Query 5 | `useQuery()` for reads, `useMutation()` for writes |
| Filter state | URL query params | Synced bidirectionally with React state via `useSearch()` |
| UI state | React `useState()` | Modals, form inputs, local toggles |
| Persistent prefs | `useUserPreference` hook | Per-user settings via `/api/user-preferences` (500ms debounce) |
| Workstation | localStorage | Station assignment with midnight TTL |

**TanStack Query config (`lib/queryClient.ts`):**
- `staleTime: Infinity` — manual invalidation only via `queryClient.invalidateQueries()`
- `refetchOnWindowFocus: false`, `retry: false`
- Custom `apiRequest()` wraps `fetch()` with `credentials: "include"`, 401 → redirect to `/login`
- Default `queryFn` joins `queryKey` array elements as URL string

### Page Pattern

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { Order } from "@shared/schema";

export default function OrdersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch data
  const { data, isLoading } = useQuery<OrdersResponse>({
    queryKey: ["/api/orders", search, filters, page],
    queryFn: async () => { /* build query string, fetch */ }
  });

  // Mutations
  const mutation = useMutation({
    mutationFn: (data) => apiRequest("POST", "/api/endpoint", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      toast({ title: "Success" });
    },
    onError: (error) => toast({ title: "Error", variant: "destructive" })
  });

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <Card>
        <CardHeader><CardTitle>Orders</CardTitle></CardHeader>
        <CardContent>{/* table/list */}</CardContent>
      </Card>
    </div>
  );
}
```

### Components

**Custom (5):** `app-sidebar.tsx`, `session-detail-dialog.tsx`, `shipment-choice-dialog.tsx`, `already-packed-dialog.tsx`, `view-manager.tsx`.

**shadcn/ui (48):** New York style, built on Radix UI. Variant system via `class-variance-authority`. All use `cn()` utility to merge Tailwind classes. Located in `components/ui/`.

### Custom Hooks (client/src/hooks/)

- **`use-toast.ts`** — Reducer-based toast queue (1 visible, effectively permanent until dismissed)
- **`use-forecasting.ts`** — 10 hooks for sales data, revenue time series, chart notes, summary metrics
- **`use-user-preference.ts`** — Persists UI preferences with 500ms debounce. Uses namespace/key/JSONB pattern
- **`use-inactivity-timeout.tsx`** — Ref-based architecture for session timeout (10 min threshold, 1 min warning dialog)

### Styling

**Design system:** Warm earth-tone palette. CSS custom properties (HSL) for theming. Dark mode support via class selector.

**Key colors:** Primary green (`hsl(80 61% 35%)`), secondary orange/brown, destructive red. Status colors for online/away/busy/offline.

**Custom CSS utilities:** `.hover-elevate`, `.active-elevate` (pseudo-element overlays), `.animate-pulse-border` (scanning feedback).

**Typography:** Georgia serif for headings, system sans-serif for body. Large sizes for warehouse readability (order numbers: 32px monospace).

### Import Patterns

```typescript
// Path aliases
import { Button } from '@/components/ui/button';     // @/* → client/src/*
import { shipments } from '@shared/schema';           // @shared/* → shared/*
import logo from '@assets/logo.png';                  // @assets/* → attached_assets/*

// React Query
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Routing
import { useLocation, useSearch, Link } from "wouter";

// Icons
import { Package, Truck, Search } from "lucide-react";

// Types (always use `import type` for type-only imports)
import type { Order, Shipment } from "@shared/schema";

// Date handling
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { toZonedTime } from "date-fns-tz";
```

## External Integrations

### Shopify (`server/utils/shopify-webhook.ts`)
- Admin API 2024-01: orders, products, customers
- Webhook verification: HMAC-SHA256
- Topics: `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/cancelled`, `products/update`
- Cursor-based pagination via Link header

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
- Zod-validated response types with discriminated unions for product types

### Firebase/Firestore (`server/firestore-storage.ts`)
- Service account auth (`FIREBASE_SERVICE_ACCOUNT` env var, JSON)
- Real-time `onSnapshot` listener for SkuVault session data
- Synced to PostgreSQL `shipments` table

## Lifecycle State Machine

Defined in `server/services/lifecycle-state-machine.ts` and `lifecycle-service.ts`.

**Phases (11):**
```
ready_to_fulfill → ready_to_session → ready_for_skuvault → fulfillment_prep
    → ready_to_pick → picking → packing_ready → on_dock → in_transit → delivered
                     ↘ picking_issues (exception path)
cancelled (terminal)
```

**Decision subphases within fulfillment_prep:**
```
needs_hydration → needs_categorization → needs_fingerprint
    → needs_packaging → needs_rate_check → needs_session
```

**Key design rules:**
- `deriveLifecyclePhase()` is a pure function — same input always produces same output
- Demotion guard prevents backwards transitions (e.g., delivered → on_dock blocked)
- Side effects trigger on transitions: QC hydration, fingerprinting, rate analysis, package dimension sync
- Split/merge detection in ETL triggers re-hydration and fingerprint recalculation
- `queueLifecycleEvaluation()` preferred over direct `updateShipmentLifecycle()` for async processing

## Key Design Decisions

- **Two status fields on shipments**: `shipment_status` (from ShipStation API) and `status` (carrier tracking code). Both managed by ETL — never set manually.
- **Product categorization**: Distinguishes between **kits** (bundles sold as one SKU, exploded into components for picking) and **assembled products** (pre-built items). Fields: `is_kit`, `is_assembled_product`, `parent_sku`, `parent_kit`.
- **Kit explosion race condition prevention**: Multi-layered approach using caching, GCP sync, proactive hydration, and repair jobs.
- **Automated package assignment**: Two-table architecture — `fingerprints` (order composition signatures via SHA256 hash) and `fingerprint_models` (learned packaging rules).
- **Two-tier inventory tracking**: `skuvault_products` tracks `quantity_on_hand`, `pending_quantity`, `allocated_quantity`, and `available_quantity`.
- **Shipping cost tracking**: Actual carrier costs stored in `shipments.shipping_cost`.
- **Correlation ID standard**: Use `orderNumber`, `shipmentId`, `sessionId` consistently for log tracing. Winston `withOrder` helper provides correlation context.
- **Purchase order snapshots**: `purchase_order_snapshots` (composite key: `stock_check_date` + `sku`) merges `skuvault_products` with `inventory_forecasts_daily` from GCP.
- **Sales forecasting**: Daily job projects last year's actuals into `sales_forecasting` table, aligning peak seasons via `peak_season_dates`. Cached in Redis with 1-hour TTL. All dates in US Central time.
- **On-hold shipment handling**: Managed by Unified Sync Worker's cursor-based polling; lifecycle evaluation gated until hold release to prevent race conditions.
- **User preferences**: Generic namespace/key/JSONB-based `user_preferences` table with reusable `useUserPreference<T>` hook for persisting per-user settings.
- **Deferred startup**: All expensive initialization happens after port opens (via `setImmediate`) so Replit health checks pass immediately.

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

### General
1. **Monolithic routes file**: All API routes are in `server/routes.ts`. New routes go there too.
2. **Storage pattern**: Data access methods live in `server/storage.ts`. Routes call storage methods, not raw Drizzle queries. All mutations use `.returning()`.
3. **Service layer**: Complex business logic goes in `server/services/`. Services are stateless and imported directly. Class-based services use constructor injection.
4. **Worker pattern**: Background workers are standalone `*-worker.ts` files in `server/`. They're started in `initializeAfterListen()`. Use `isProcessing` guard, batch dequeue, error isolation per item.
5. **Schema changes**: Edit `shared/schema.ts`, then `npm run db:push` to apply.
6. **No automated tests**: Testing is manual via UI and server logs.
7. **Drizzle ORM**: All database queries use Drizzle — no raw SQL strings.
8. **Error handling**: Routes use try/catch + global Express middleware. Workers isolate errors per item. Neon cold starts handled by `withRetrySafe()` in `server/utils/db-retry.ts`.
9. **Date handling**: Uses `date-fns` and `date-fns-tz`. Business hours are Central Time.
10. **Webhook security**: All inbound webhooks (Shopify, ShipStation) are HMAC-SHA256 verified using `rawBody`.
11. **Queue reliability**: Dead letter tables catch failed sync operations. ShipStation writes use a PostgreSQL-backed retry queue with `FOR UPDATE SKIP LOCKED`.
12. **Structured logging**: Winston logger with `withOrder` helper for correlation context. Use standardized correlation IDs (`orderNumber`, `shipmentId`, `sessionId`).

### Frontend
13. **TanStack Query as default**: All API data fetched via `useQuery()` with manual invalidation (`staleTime: Infinity`). Mutations use `useMutation()` with `onSuccess` → `queryClient.invalidateQueries()`.
14. **URL state for filters**: Complex pages (Orders, Shipments) sync filter state to URL params via `history.replaceState()`. Use `useSearch()` from Wouter.
15. **shadcn/ui components**: Use existing components from `components/ui/`. New components use Radix UI primitives + `cn()` utility for Tailwind class merging.
16. **API calls**: Use `apiRequest()` from `lib/queryClient.ts` for mutations. Default `queryFn` joins queryKey as URL. Always include `credentials: "include"`.
17. **Toast notifications**: Use `useToast()` hook. Show success on mutations, destructive variant for errors.
18. **Type imports**: Use `import type` for type-only imports from `@shared/schema`.

### Database
19. **Connected MCP database**: Claude has read-only SQL access to the production database via the `jerky-postgres-db` MCP server. Use `mcp__jerky-postgres-db__query` to inspect live data when debugging.
