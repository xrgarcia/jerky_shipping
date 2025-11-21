# Packing Page - Quality Control & Order Fulfillment

## Overview
The Packing Page is a warehouse-focused, scan-driven interface that allows staff to fulfill orders by scanning barcodes. The workflow starts by scanning an order barcode to load the shipment, then validates each product as it's scanned into the box, ensuring accuracy before shipping to customers.

## Purpose
Enable warehouse workers to:
- Scan order barcode to load shipment details
- Scan product barcodes as items are packed
- Validate that scanned items belong to the current order
- Track individual unit scans (qty 3 requires 3 separate scans)
- Mark items as quality-checked via SkuVault QC API
- Print shipping labels after completing packing
- Prevent shipping errors by catching mismatched items

## Backend API Endpoints

### Already Implemented

#### 1. Product Lookup
**Endpoint:** `GET /api/skuvault/qc/product/:searchTerm`
- **Purpose:** Validate a scanned barcode/SKU/part number
- **Authentication:** Required (warehouse staff login)
- **Parameters:** 
  - `searchTerm` - The scanned barcode, SKU, or part number
- **Success Response:**
  ```json
  {
    "Data": {
      "Id": "2838",
      "Code": "073608032322",
      "Sku": "JCB-SS-1-26",
      "Title": "Klement's Beef Snack Stick - .8 oz.",
      "Cost": { "Value": 0.45 },
      "Attributes": [...],
      "Classification": { ... },
      "Brand": { ... }
    },
    "Errors": [],
    "Messages": []
  }
  ```
- **Product Not Found:** Returns with empty Data or populated Errors array
- **Error Response:** 401 unauthorized, 500 server error

#### 2. Mark Item as QC Passed
**Endpoint:** `POST /api/skuvault/qc/pass-item`
- **Purpose:** Mark a scanned item as quality-checked for the order
- **Authentication:** Required
- **Request Body:**
  ```json
  {
    "IdItem": "2583",
    "Quantity": 1,
    "IdSale": "JK3825345017",
    "Note": null,
    "ScannedCode": "811007027019",
    "SerialNumber": ""
  }
  ```
  - `IdItem`: SkuVault product ID (from product lookup response)
  - `Quantity`: Always 1 (each scan represents one unit)
  - `IdSale`: Order number from shipments table (order_number field)
  - `ScannedCode`: The actual barcode scanned
  - `SerialNumber`: Optional, empty string if not applicable
  - `Note`: Optional notes about the scan
- **Success Response:**
  ```json
  {
    "Data": null,
    "Errors": [],
    "Success": true
  }
  ```
- **Error Response:** Contains populated Errors array

### To Be Implemented

#### 3. Get Shipment by Order Number
**Endpoint:** `GET /api/shipments/by-order-number/:orderNumber`
- **Purpose:** Load shipment details when order barcode is scanned
- **Authentication:** Required (warehouse staff)
- **Parameters:**
  - `orderNumber` - The scanned order number (matches `order_number` TEXT field in `shipments` table)

**Database Query (handles multiple shipments):**
```typescript
// Query shipments table - may return multiple results
const shipmentResults = await db
  .select()
  .from(shipments)
  .where(eq(shipments.orderNumber, orderNumber))
  .orderBy(desc(shipments.createdAt)); // Most recent first

if (shipmentResults.length === 0) {
  return res.status(404).json({ 
    error: "Order not found",
    orderNumber 
  });
}

// Handle multiple shipments (rare but possible)
if (shipmentResults.length > 1) {
  console.warn(`[Packing] Multiple shipments found for order ${orderNumber}, using most recent (${shipmentResults[0].id})`);
}

const shipment = shipmentResults[0]; // Use most recent

// Join shipment_items for expected product list
const items = await db
  .select()
  .from(shipmentItems)
  .where(eq(shipmentItems.shipmentId, shipment.id));
```

**Success Response Schema:**
```json
{
  "id": "uuid",
  "shipmentId": "se-123456",
  "orderNumber": "JK3825345017",
  "trackingNumber": "1Z999AA10123456784",
  "carrierCode": "ups_walleted",
  "serviceCode": "usps_ground_advantage",
  "labelUrl": "https://api.shipengine.com/v1/labels/se-123456",
  "shipToName": "John Doe",
  "shipToPhone": "+1234567890",
  "shipToAddressLine1": "123 Main St",
  "shipToAddressLine2": null,
  "shipToCity": "Springfield",
  "shipToState": "IL",
  "shipToPostalCode": "62701",
  "shipToCountry": "US",
  "orderDate": "2024-11-21T12:00:00Z",
  "shipmentStatus": "awaiting_shipment",
  "items": [
    {
      "id": "uuid",
      "shipmentId": "uuid",
      "sku": "JCB-SS-1-26",
      "name": "Klement's Beef Snack Stick - .8 oz.",
      "quantity": 3,
      "unitPrice": "1.99",
      "imageUrl": "https://cdn.shopify.com/...",
      "externalOrderItemId": "13467164328106"
    }
  ]
}
```

**Field Mapping (from shared/schema.ts):**
- `shipments.orderNumber` (TEXT) - Customer-facing order number
- `shipments.shipToName` (TEXT) - Customer name
- `shipments.shipToAddressLine1/2/3` (TEXT) - Shipping address
- `shipments.shipToCity/State/PostalCode/Country` (TEXT) - Location details
- `shipmentItems.sku` (TEXT) - Product SKU for validation
- `shipmentItems.quantity` (INTEGER) - Expected quantity to pack

**Important for QC Validation:**
- Each `shipmentItems` record has a `sku` field - this is matched against SkuVault product lookup
- Frontend validates scanned product SKU against `items[].sku` array
- **Note:** SkuVault uses its own product IDs (`IdItem`), not Shopify IDs
  - Product lookup API returns SkuVault `Data.Id` field
  - This `IdItem` value must be sent to `pass-item` API
  - SKU is used for frontend validation only

**Error Response:**
- `404`: Order not found with that order_number
- `401`: Unauthorized (redirect to login)
- `500`: Server error

## Warehouse Packing Workflow

### Phase 1: Scan Order Barcode
**User Action:** Warehouse staff scans the order barcode (printed on pick list or order slip)

**System Response:**
1. Calls `GET /api/shipments/by-order-number/:orderNumber`
2. Loads shipment with customer info and expected items
3. Displays order header with customer shipping details
4. Shows expected items list with quantities
5. Auto-focuses product scanner input
6. Initializes scan tracking state (0 scanned for each item)

**Error Handling:**
- Order not found → Show error "Order [number] not found", allow re-scan
- Network error → Show retry option
- Multiple orders with same number → Handle disambiguation (shouldn't happen)

### Phase 2: Scan Products
**User Action:** Staff scans each product barcode as items are placed in box

**For Each Scan:**
1. Input receives barcode from scanner
2. System calls `GET /api/skuvault/qc/product/:barcode`
3. System receives product details (SKU, name, ID)
4. **Frontend validation:**
   - Check if product SKU exists in expected items list
   - Check if more units of this SKU are still needed
5. Handle validation result (see Phase 3)

**Multi-Unit Handling:**
- Quantity 3 items = 3 separate scans
- Each scan increments the "scanned count" for that SKU
- Track: "2 of 3 scanned" for each item line
- Only mark item complete when scanned count = expected quantity

**Scan Tracking State Example:**
```javascript
{
  "JCB-SS-1-26": {
    expected: 3,
    scanned: 2,
    complete: false
  },
  "BEEF-STICK-2OZ": {
    expected: 1,
    scanned: 1,
    complete: true
  }
}
```

### Phase 3: Handle Scan Results

#### ✅ Valid Scan (Product in Order, Quantity Needed)
**System Actions:**
1. Show visual success indicator (green checkmark, border flash)
2. Play success audio tone (optional)
3. Call `POST /api/skuvault/qc/pass-item` with:
   - `IdItem`: Product ID from lookup response
   - `Quantity`: 1 (always single unit)
   - `IdSale`: Order number from shipment
   - `ScannedCode`: The barcode that was scanned
4. Increment scanned count for that SKU
5. Update UI to show progress (e.g., "2 of 3 scanned")
6. Mark item line as complete if all units scanned
7. Clear input, auto-focus for next scan

**UI Feedback:**
- Product name highlighted in green
- "✓ 2 of 3 scanned" badge
- Progress bar or counter
- Keep item visible in list with updated count

#### ❌ Invalid Scan - Wrong Product
**Triggers:**
- Product SKU not in expected items list
- Product exists in SkuVault but not needed for this order

**System Actions:**
1. Show prominent error alert (red, large)
2. Play error audio tone (optional vibration)
3. Display message:
   ```
   ❌ WRONG PRODUCT!
   
   Scanned: Klement's Beef Snack Stick - .8 oz.
   SKU: JCB-SS-1-26
   
   This item is NOT part of order JK3825345017
   
   Please scan the correct product or verify the order.
   ```
4. Do NOT call `pass-item` API
5. Keep input focused for re-scan
6. Log scan attempt for audit trail (optional)

**UI Feedback:**
- Full-screen or modal alert (hard to miss)
- Red border flash
- Item details to help staff identify mistake
- "Scan Again" or "Cancel Order" buttons

#### ❌ Invalid Scan - Already Complete
**Triggers:**
- Product SKU is in order but all units already scanned
- Example: Scanned 3rd unit when only 2 were ordered

**System Actions:**
1. Show warning alert (yellow/orange)
2. Display message:
   ```
   ⚠️ All Units Already Scanned
   
   Product: Beef Snack Stick
   SKU: JCB-SS-1-26
   
   Expected: 2 | Scanned: 2 ✓
   
   This item is complete. Do not pack additional units.
   ```
3. Do NOT call `pass-item` API
4. Allow staff to continue with other items

#### ⚠️ Product Not Found in SkuVault
**Triggers:**
- API returns empty Data or error
- Barcode doesn't exist in SkuVault system

**System Actions:**
1. Show warning alert
2. Display message:
   ```
   ⚠️ Barcode Not Found
   
   Scanned Code: 999999999999
   
   This barcode is not in the system.
   Please verify the barcode or contact supervisor.
   ```
3. Offer options: Re-scan, Manual Entry, Skip Item
4. Log for troubleshooting

### Phase 4: Complete Order
**Trigger:** All expected items have been scanned (all items marked complete)

**System Actions:**
1. Show completion modal/screen
2. Display summary:
   ```
   ✅ Order JK3825345017 Complete!
   
   Customer: John Doe
   Items Packed: 5 items (3 unique SKUs)
   
   [Print Shipping Label] [Start New Order]
   ```
3. Enable "Print Label" button
4. **Automatically queue label for printing** (if shipment has orderId)
   - Create print queue job for shipment
   - Broadcast WebSocket update to print queue UI
   - Show success message with print queue status
5. Optionally mark shipment status as "packed" or "ready_to_ship"
6. Clear state and return to order scan screen

**Print Integration (See "Print Queue Integration" section below for complete implementation):**
- Automatically queues label for printing if shipment has linked `orderId`
- For orphaned shipments (no `orderId`), provides manual print option
- Integrates with existing print queue system
- Real-time WebSocket updates

### Phase 5: Return to Start
**User Action:** Click "Start New Order" or press keyboard shortcut

**System Actions:**
1. Clear all state (order, items, scan counts)
2. Return to order barcode scan screen
3. Auto-focus order number input
4. Ready for next order

## Frontend Requirements

### Page Structure

#### Initial State: Order Scanner Screen
```
┌─────────────────────────────────────────┐
│  📦 Warehouse Packing Station           │
├─────────────────────────────────────────┤
│                                         │
│   Scan Order Barcode to Begin           │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  [Order Barcode Input]          │   │
│   │  Large, auto-focused            │   │
│   └─────────────────────────────────┘   │
│                                         │
│   Instructions:                         │
│   1. Scan order barcode                 │
│   2. Scan each product                  │
│   3. Print label when complete          │
│                                         │
└─────────────────────────────────────────┘
```

#### Active Packing State: Product Scanning
```
┌─────────────────────────────────────────────────────────┐
│  Order: JK3825345017                    [Cancel Order]  │
├─────────────────────────────────────────────────────────┤
│  Ship To: John Doe                                      │
│  123 Main St, Springfield, IL 62701                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Scan Product Barcode                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  [Product Barcode Input - Auto-focused]         │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Expected Items:                     Progress: 2/5      │
│  ┌───────────────────────────────────────────────────┐ │
│  │ ✓ Beef Snack Stick (JCB-SS-1-26)   [2 of 2] ✓    │ │
│  │ ○ Turkey Stick (TRK-SS-1-26)       [0 of 3]      │ │
│  │   ↑ Scan 3 more units                             │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  [Last Scan: ✓ Beef Snack Stick added]                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### UI Components

#### 1. Order Scanner Input
- **Purpose:** Capture order barcode scan
- **Features:**
  - Large font (24-30px)
  - Auto-focused on page load
  - Full-width or prominent placement
  - Clear placeholder: "Scan Order Barcode"
  - Submit on Enter (barcode scanner behavior)
  - Clear button
  - Loading state while fetching order

#### 2. Order Header
- **Purpose:** Display order and customer info
- **Content:**
  - Order number (prominent, 32px+)
  - Customer shipping name
  - Shipping address (city, state, zip)
  - Order date/time
  - Carrier and service (if available)
  - Cancel Order button

#### 3. Expected Items List
- **Purpose:** Show what needs to be packed
- **Layout:** Table or card grid
- **Columns:**
  - Status icon (✓ complete, ○ pending, ⏳ in progress)
  - Product image (thumbnail)
  - Product name + SKU
  - Progress: "2 of 3 scanned" or "Complete ✓"
  - Progress bar (optional visual)
- **Styling:**
  - Complete items: green background or checkmark
  - Pending items: neutral/gray
  - In-progress items: highlighted/pulsing
  - Current item being scanned: border highlight

#### 4. Product Scanner Input
- **Purpose:** Capture product barcode scans
- **Features:**
  - Large font (20-24px)
  - Always auto-focused (after each scan)
  - Full-width
  - Placeholder: "Scan Product Barcode"
  - Auto-submit on scan (Enter key)
  - Clear after successful scan
  - Disabled during API calls
  - Loading indicator

#### 5. Scan Feedback Area
- **Purpose:** Show real-time scan results
- **Success State:**
  - Green border flash
  - ✓ checkmark icon
  - Product name
  - "Added 1 of 3"
  - Fade out after 2-3 seconds
- **Error State:**
  - Red border/background
  - ❌ X icon
  - Error message
  - Product details (if found)
  - Persistent until dismissed or next scan
- **Loading State:**
  - Spinner
  - "Validating barcode..."

#### 6. Progress Indicators
- **Overall Progress:** "2 of 5 items packed"
- **Per-Item Progress:** "2 of 3 units scanned"
- **Visual:** Progress bars, percentages, or fraction display
- **Position:** Top of screen or in header

#### 7. Action Buttons
- **Cancel Order:** Return to order scan screen without completing
- **Print Label:** Enabled when all items scanned, triggers print queue
- **Start New Order:** After completion, clear and restart
- **Manual Entry:** Fallback for non-scannable items (optional)

#### 8. Completion Modal
- **Purpose:** Confirm successful packing
- **Content:**
  - ✅ Success icon
  - "Order Complete!" headline
  - Order number
  - Item summary
  - Customer name
  - Print Label button (primary action)
  - Start New Order button
- **Behavior:**
  - Modal overlay (prevents accidental actions)
  - Auto-focus Print Label button
  - Keyboard shortcuts (P for print, N for new)

### Technical Implementation

#### State Management
```typescript
interface PackingState {
  // Order data
  order: Shipment | null;
  orderNumber: string | null;
  
  // Scan tracking
  scanCounts: Record<string, {
    expected: number;
    scanned: number;
    complete: boolean;
  }>;
  
  // UI state
  currentScan: string;
  scanResult: 'success' | 'error' | 'not-found' | null;
  scanMessage: string;
  isLoading: boolean;
  
  // Completion
  isComplete: boolean;
}
```

#### Key Functions
```typescript
// Load order by scanned barcode
async function loadOrder(orderNumber: string): Promise<void>

// Validate and process product scan
async function processProductScan(barcode: string): Promise<void>

// Check if product belongs to order
function validateProductForOrder(sku: string): boolean

// Check if more units needed
function needsMoreUnits(sku: string): boolean

// Mark item as QC passed in SkuVault
async function markItemQCPassed(productId: string, barcode: string): Promise<void>

// Update scan count for SKU
function incrementScanCount(sku: string): void

// Check if all items complete
function isOrderComplete(): boolean

// Clear and restart
function resetPacking(): void

// Add to print queue
async function queueLabelForPrinting(shipmentId: string): Promise<void>
```

#### API Integration

**TanStack Query Hooks:**
```typescript
// GET /api/shipments/by-order-number/:orderNumber
const { data: order, isLoading, error } = useQuery({
  queryKey: ['/api/shipments/by-order-number', orderNumber],
  enabled: !!orderNumber
});

// GET /api/skuvault/qc/product/:barcode
const { mutate: lookupProduct } = useMutation({
  mutationFn: (barcode: string) => 
    fetch(`/api/skuvault/qc/product/${barcode}`).then(r => r.json()),
  onSuccess: (data) => handleProductLookup(data)
});

// POST /api/skuvault/qc/pass-item
const { mutate: passQCItem } = useMutation({
  mutationFn: (payload: QCPassItemRequest) =>
    apiRequest('/api/skuvault/qc/pass-item', { method: 'POST', body: payload }),
  onSuccess: () => handleQCPassSuccess()
});
```

### Keyboard & Scanner Support

#### Barcode Scanner Behavior
- Scanners typically type barcode + Enter key very quickly
- Input field should auto-submit on Enter
- Clear input after submission
- Auto-focus after processing
- Handle rapid successive scans (debounce/queue if needed)

#### Keyboard Shortcuts (Optional)
- `Ctrl + N`: Start New Order
- `Ctrl + P`: Print Label (when available)
- `Esc`: Cancel current order
- `F5`: Manual refresh (if needed)

### Warehouse Environment Adaptations

#### Visual Design
- **Large fonts:** 18px minimum, 24-32px for important info
- **High contrast:** Dark text on light backgrounds
- **Color coding:**
  - Green: Success, complete
  - Red: Error, wrong product
  - Yellow/Orange: Warning
  - Blue: Info, in-progress
- **Icons:** Large, clear icons for status
- **Spacing:** Generous padding for touch targets

#### Audio Feedback
- Success beep: Short, pleasant tone
- Error beep: Longer, distinct tone
- Completion chime: Celebratory sound
- Volume control (settings)
- Mute option

#### Performance
- **Fast response:** < 500ms for scans
- **Optimistic updates:** Update UI before API confirms
- **Offline handling:** Queue scans if network drops (future)
- **Error recovery:** Retry failed API calls

#### Accessibility
- Large touch targets (min 44x44px)
- Keyboard navigation
- Screen reader support
- High contrast mode
- Focus indicators

### Mobile & Device Support
- **Primary:** Desktop/tablet at packing stations
- **Secondary:** Handheld mobile scanners
- **Responsive:** Adapt to screen size
- **Orientation:** Primarily portrait for handhelds, landscape for stations

## Integration with Existing System

### Data Sources
- **Shipments table:** Query by `order_number` field
- **Shipment items:** Join to get expected product list
- **SkuVault API:** Product validation and QC pass marking
- **Print queue:** Existing system for label printing

### Database Schema (Existing)
```sql
-- Shipments table
CREATE TABLE shipments (
  id UUID PRIMARY KEY,
  shipment_id TEXT, -- ShipStation ID
  order_number TEXT, -- Scanned to load order
  tracking_number TEXT,
  customer_name TEXT,
  ship_to_name TEXT,
  ship_to_street1 TEXT,
  ship_to_city TEXT,
  ship_to_state TEXT,
  ship_to_postal_code TEXT,
  ...
);

-- Shipment items table
CREATE TABLE shipment_items (
  id UUID PRIMARY KEY,
  shipment_id UUID REFERENCES shipments(id),
  sku TEXT,
  name TEXT,
  quantity INTEGER, -- Expected quantity
  image_url TEXT,
  unit_price NUMERIC,
  ...
);
```

### New API Endpoint

#### GET /api/shipments/by-order-number/:orderNumber
**Complete Implementation:**
```typescript
app.get("/api/shipments/by-order-number/:orderNumber", requireAuth, async (req, res) => {
  try {
    const { orderNumber } = req.params;
    
    // Query shipments - handles multiple results
    const shipmentResults = await db
      .select()
      .from(shipments)
      .where(eq(shipments.orderNumber, orderNumber))
      .orderBy(desc(shipments.createdAt)); // Most recent first
    
    if (shipmentResults.length === 0) {
      return res.status(404).json({ 
        error: "Order not found",
        orderNumber 
      });
    }
    
    // Log warning if multiple shipments found (rare)
    if (shipmentResults.length > 1) {
      console.warn(`[Packing] Multiple shipments for order ${orderNumber}, using most recent (ID: ${shipmentResults[0].id})`);
    }
    
    const shipment = shipmentResults[0]; // Use most recent
    
    // Get shipment items
    const items = await db
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, shipment.id));
    
    res.json({
      ...shipment,
      items
    });
  } catch (error: any) {
    console.error("[Packing] Error fetching shipment:", error);
    res.status(500).json({ error: "Failed to fetch shipment" });
  }
});
```

### Navigation
- Add "Packing" link to main sidebar
- Route: `/pack`
- Icon: Package or box icon
- Position: After "Shipments" or in Operations section
- Authentication: Required (warehouse staff)

### Print Queue Integration

**Existing System (shared/schema.ts):**
```typescript
// Print queue table schema
export const printQueue = pgTable("print_queue", {
  id: varchar("id").primaryKey(),
  orderId: varchar("order_id").references(() => orders.id), // Foreign key to orders
  labelUrl: text("label_url"), // ShipStation label PDF/ZPL URL
  status: text("status").default("queued"), // queued, printing, printed, failed
  error: text("error"),
  queuedAt: timestamp("queued_at").defaultNow(),
  printedAt: timestamp("printed_at")
});
```

**Existing API Endpoints (server/routes.ts):**
- `GET /api/print-queue` - Get active print jobs (queued or printing)
- `POST /api/print-queue/:id/printing` - Mark job as printing
- `POST /api/print-queue/:id/complete` - Mark job as printed

**Storage Interface (server/storage.ts):**
```typescript
createPrintJob(job: InsertPrintQueue): Promise<PrintQueue>;
updatePrintJobStatus(id: string, status: string, printedAt?: Date): Promise<PrintQueue>;
getPrintJob(id: string): Promise<PrintQueue | undefined>;
getActivePrintJobs(): Promise<PrintQueue[]>;
getPrintJobsByOrderId(orderId: string): Promise<PrintQueue[]>;
deletePrintJob(id: string): Promise<void>;
```

**WebSocket Events (server/websocket.ts):**
- `broadcastPrintQueueUpdate({ type: 'job_printing', job })` - Notify when job status changes

**Packing Integration Implementation:**

When order packing is complete:
```typescript
// After all items scanned and QC passed
async function completeOrderPacking(shipment: Shipment) {
  // If shipment.orderId exists (linked to Shopify order)
  if (shipment.orderId) {
    const printJob = await storage.createPrintJob({
      orderId: shipment.orderId,
      labelUrl: shipment.labelUrl, // From ShipStation shipment
      status: "queued"
    });
    
    // Broadcast WebSocket update
    broadcastPrintQueueUpdate({ type: "job_added", job: printJob });
    
    return { printQueued: true, printJobId: printJob.id };
  }
  
  // If no orderId (orphaned shipment), skip print queue
  return { printQueued: false };
}
```

**Schema Constraint:** `print_queue.orderId` is `NOT NULL` - requires valid foreign key to `orders.id`

**Implementation Decision (MVP):**
Only queue labels for shipments with linked `orderId`:

**Complete API Route Implementation:**
```typescript
// Add to server/routes.ts
app.post("/api/packing/complete", requireAuth, async (req, res) => {
  try {
    const { shipmentId } = req.body;
    
    // Get shipment
    const shipment = await db
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    
    if (!shipment.length) {
      return res.status(404).json({ error: "Shipment not found" });
    }
    
    const shipmentData = shipment[0];
    
    // Check if shipment is linked to Shopify order
    if (!shipmentData.orderId) {
      console.warn(`[Packing] Shipment ${shipmentData.orderNumber} has no orderId - skipping print queue`);
      return res.json({ 
        success: true, 
        printQueued: false,
        message: "Order complete. Print label manually from shipment details.",
        labelUrl: shipmentData.labelUrl
      });
    }
    
    // Create print job
    const printJob = await storage.createPrintJob({
      orderId: shipmentData.orderId, // Non-null, safe to insert
      labelUrl: shipmentData.labelUrl,
      status: "queued"
    });
    
    // Broadcast WebSocket update
    broadcastPrintQueueUpdate({ 
      type: "job_added", 
      job: printJob 
    });
    
    res.json({ 
      success: true, 
      printQueued: true, 
      printJobId: printJob.id,
      message: "Order complete! Label queued for printing."
    });
  } catch (error: any) {
    console.error("[Packing] Error completing order:", error);
    res.status(500).json({ error: "Failed to complete order" });
  }
});
```

**Why this works:**
- Most shipments have `orderId` (linked via ShipStation → Shopify sync)
- Orphaned shipments (no `orderId`) still complete QC successfully
- User can manually print label from shipment details page
- No schema changes required for MVP
- Future enhancement can add `shipmentId` support if needed

**UI Behavior:**
- Shipment with `orderId`: "✓ Order complete! Label queued for printing. [View Print Queue]"
- Shipment without `orderId`: "✓ Order complete! [Print Label Manually]" (link to label URL)

**Post-MVP Enhancement:**
Extend print queue schema to support shipments without orders:
```typescript
// Migration to add nullable shipmentId
orderId: varchar("order_id").references(() => orders.id), // Now nullable
shipmentId: varchar("shipment_id").references(() => shipments.id), // New field
// Constraint: At least one of orderId or shipmentId must be present
```

## Security & Permissions

### Authentication (Existing System)

**Current Implementation (shared/schema.ts):**
```typescript
// Users table - warehouse staff accounts
export const users = pgTable("users", {
  id: varchar("id").primaryKey(),
  email: text("email").notNull().unique(),
  handle: text("handle").unique(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow()
});

// Sessions table - HTTP-only cookie sessions
export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow()
});
```

**Authentication Flow:**
1. User logs in via magic link (passwordless email authentication)
2. Session cookie set with 30-day expiration
3. All packing endpoints use `requireAuth` middleware
4. Middleware validates session token from cookie
5. Redirect to login if session invalid/expired

**Packing Page Route Protection:**
```typescript
// All API endpoints require authentication
app.get("/api/shipments/by-order-number/:orderNumber", requireAuth, handler);
app.get("/api/skuvault/qc/product/:searchTerm", requireAuth, handler);
app.post("/api/skuvault/qc/pass-item", requireAuth, handler);

// Frontend route also requires authenticated user
// Check in PackingPage component
const { user } = useUser(); // Context from auth system
if (!user) return <Navigate to="/login" />;
```

### Authorization

**Current State:**
- No role-based access control (all authenticated users have same permissions)
- All warehouse staff can access packing features

**Future Enhancements:**
1. **Role-Based Access:**
   - Add `role` field to `users` table: "admin", "packer", "viewer"
   - Restrict packing page to "packer" and "admin" roles
   - Create `requireRole(role)` middleware

2. **QC Audit Trail (MVP Requirement):**
   
   **Database Schema (add to shared/schema.ts):**
   ```typescript
   export const packingLogs = pgTable("packing_logs", {
     id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
     userId: varchar("user_id").notNull().references(() => users.id),
     shipmentId: varchar("shipment_id").notNull().references(() => shipments.id),
     orderNumber: text("order_number").notNull(),
     action: text("action").notNull(), // 'scan_order', 'scan_product', 'qc_pass', 'qc_fail', 'complete_order'
     productSku: text("product_sku"), // SKU scanned (null for scan_order/complete_order actions)
     scannedCode: text("scanned_code"), // Actual barcode value
     skuVaultProductId: text("skuvault_product_id"), // IdItem from SkuVault (null if not found)
     success: boolean("success").notNull(),
     errorMessage: text("error_message"),
     createdAt: timestamp("created_at").notNull().defaultNow(),
   }, (table) => ({
     shipmentIdIdx: index("packing_logs_shipment_id_idx").on(table.shipmentId),
     userIdIdx: index("packing_logs_user_id_idx").on(table.userId),
     createdAtIdx: index("packing_logs_created_at_idx").on(table.createdAt),
   }));

   export const insertPackingLogSchema = createInsertSchema(packingLogs).omit({
     id: true,
     createdAt: true,
   });

   export type InsertPackingLog = z.infer<typeof insertPackingLogSchema>;
   export type PackingLog = typeof packingLogs.$inferSelect;
   ```

   **Storage Interface Methods (add to IStorage in server/storage.ts):**
   ```typescript
   interface IStorage {
     // ... existing methods
     
     // Packing logs
     createPackingLog(log: InsertPackingLog): Promise<PackingLog>;
     getPackingLogsByShipment(shipmentId: string): Promise<PackingLog[]>;
     getPackingLogsByUser(userId: string, limit?: number): Promise<PackingLog[]>;
   }
   ```

   **Implementation (add to server/storage.ts):**
   ```typescript
   async createPackingLog(log: InsertPackingLog): Promise<PackingLog> {
     const result = await db.insert(packingLogs).values(log).returning();
     return result[0];
   }

   async getPackingLogsByShipment(shipmentId: string): Promise<PackingLog[]> {
     return await db
       .select()
       .from(packingLogs)
       .where(eq(packingLogs.shipmentId, shipmentId))
       .orderBy(desc(packingLogs.createdAt));
   }

   async getPackingLogsByUser(userId: string, limit = 100): Promise<PackingLog[]> {
     return await db
       .select()
       .from(packingLogs)
       .where(eq(packingLogs.userId, userId))
       .orderBy(desc(packingLogs.createdAt))
       .limit(limit);
   }
   ```

   **API Endpoints (add to server/routes.ts):**
   ```typescript
   // Create packing log entry
   app.post("/api/packing-logs", requireAuth, async (req, res) => {
     try {
       const user = req.user; // From requireAuth middleware
       
       const logData = {
         ...req.body,
         userId: user.id // Ensure userId comes from authenticated session
       };
       
       // Validate with Zod schema
       const validated = insertPackingLogSchema.parse(logData);
       
       const log = await storage.createPackingLog(validated);
       res.json({ success: true, log });
     } catch (error: any) {
       console.error("[Packing] Error creating packing log:", error);
       res.status(500).json({ error: "Failed to create packing log" });
     }
   });
   
   // Get packing logs for a shipment (admin/debugging)
   app.get("/api/packing-logs/shipment/:shipmentId", requireAuth, async (req, res) => {
     try {
       const logs = await storage.getPackingLogsByShipment(req.params.shipmentId);
       res.json({ logs });
     } catch (error: any) {
       console.error("[Packing] Error fetching packing logs:", error);
       res.status(500).json({ error: "Failed to fetch packing logs" });
     }
   });
   ```

   **Frontend Integration:**
   ```typescript
   // Log every scan attempt
   async function logPackingAction(
     action: 'scan_order' | 'scan_product' | 'qc_pass' | 'qc_fail' | 'complete_order',
     details: {
       shipmentId: string;
       orderNumber: string;
       productSku?: string;
       scannedCode?: string;
       skuVaultProductId?: string;
       success: boolean;
       errorMessage?: string;
     }
   ) {
     await apiRequest('/api/packing-logs', {
       method: 'POST',
       body: {
         userId: currentUser.id, // From auth context
         action,
         ...details
       }
     });
   }
   
   // Usage in packing flow
   await logPackingAction('scan_product', {
     shipmentId: shipment.id,
     orderNumber: shipment.orderNumber,
     productSku: product.Sku,
     scannedCode: barcode,
     skuVaultProductId: product.Id,
     success: true
   });
   ```

3. **Permissions:**
   - View packing queue: All warehouse staff
   - Pack orders: "packer" and "admin" roles
   - Reprint labels: "packer" and "admin" roles
   - View packing logs: "admin" only

### Data Validation
- Server-side validation of all inputs
- SQL injection prevention (parameterized queries)
- XSS prevention (sanitize inputs)
- Rate limiting on API endpoints

## Error Handling

### Network Errors
- Display: "Connection lost. Retrying..."
- Auto-retry with exponential backoff
- Manual retry button
- Queue scans locally (future enhancement)

### API Errors
- 401 Unauthorized: Redirect to login
- 404 Not Found: "Order not found" message
- 500 Server Error: "System error. Please contact support."
- Log errors for troubleshooting

### Scanner Issues
- No input received: "Scan not detected"
- Malformed barcode: "Invalid barcode format"
- Timeout: Clear input and allow re-scan

## Metrics & Analytics (Future)

### Key Metrics
- Orders packed per hour per user
- Average pack time per order
- Scan accuracy rate (valid vs invalid scans)
- Error rate by error type
- Most common incorrect scans
- Completion rate

### Reporting
- Daily packing report
- User performance
- Error analysis
- Identify problematic SKUs (frequent wrong scans)

## Testing Scenarios

### Happy Path
1. Scan valid order number → Order loads
2. Scan valid product → Success, count increments
3. Scan remaining products → All items complete
4. Click Print Label → Label queued
5. Start new order → Screen clears

### Error Cases
1. Scan non-existent order → "Order not found"
2. Scan wrong product → "Not in order" error
3. Scan extra unit → "Already complete" warning
4. Scan invalid barcode → "Not found in system"
5. Network failure → Retry mechanism

### Edge Cases
1. Multiple units of same product
2. Order with single item
3. Large order (20+ items)
4. Duplicate scans (same barcode twice quickly)
5. Switching orders mid-pack (cancel flow)

## Future Enhancements

### Phase 2 Features
- Batch packing (multiple orders)
- Mobile handheld scanner app
- Offline mode with sync
- Photo capture for damaged items
- Weight verification
- Box size recommendations

### Phase 3 Features
- Packing station assignment
- Multi-location/warehouse support
- Pick list integration
- Inventory adjustment on pack
- Custom packing instructions per order
- Returns/exchange handling

## Success Criteria

### MVP Launch
- ✅ Scan order barcode to load shipment
- ✅ Scan products with validation
- ✅ Track individual unit scans
- ✅ Visual feedback for success/errors
- ✅ Complete order and queue label
- ✅ Error handling and recovery

### User Adoption
- Warehouse staff trained on system
- Positive feedback on ease of use
- Reduced packing errors
- Faster order fulfillment
- Integration with existing workflow

### Performance
- < 500ms scan response time
- 99% API uptime
- < 1% error rate
- Support 50+ orders/hour per station

## Open Questions & Decisions Needed

1. **Print Integration Details:**
   - Auto-print on completion or manual button?
   - Support multiple printers per station?
   - Packing slip in addition to shipping label?

2. **Order Status Updates:**
   - Mark shipment status as "packed" in database?
   - Update timestamp for tracking?
   - Trigger notifications/webhooks?

3. **Multi-Order Handling:**
   - Allow switching orders mid-pack?
   - Warn before canceling in-progress order?
   - Save partial progress?

4. **Audit Trail:**
   - Log every scan attempt?
   - Track who packed each order?
   - Store scan timestamps?
   - Create packing_log table?

5. **Error Recovery:**
   - Allow manual SKU entry if barcode fails?
   - Override wrong-product warning (with confirmation)?
   - Supervisor unlock for exceptions?

6. **Device Support:**
   - Prioritize desktop or mobile first?
   - Support specific scanner hardware?
   - Require camera for manual barcode scanning?
