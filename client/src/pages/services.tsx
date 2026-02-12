import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Webhook,
  RefreshCw,
  Activity,
  DollarSign,
  Package,
  Layers,
  ShoppingCart,
  Database,
  Send,
  Boxes,
} from "lucide-react";

const FEATURES = [
  {
    key: 'webhooks',
    name: 'Webhooks',
    description: 'Inbound webhook handlers for external service events',
    icon: Webhook,
    subfeatures: [
      { key: 'shopify_orders', label: 'Shopify Orders', description: 'Order create/update webhooks from Shopify' },
      { key: 'shopify_refunds', label: 'Shopify Refunds', description: 'Refund webhooks from Shopify' },
      { key: 'shopify_products', label: 'Shopify Products', description: 'Product create/update/delete webhooks from Shopify' },
      { key: 'shipstation_track', label: 'ShipStation Track', description: 'Tracking status update webhooks from ShipStation' },
      { key: 'shipstation_ship', label: 'ShipStation Ship', description: 'Shipment shipped/rejected webhooks from ShipStation' },
      { key: 'shipstation_batch', label: 'ShipStation Batch', description: 'Batch completion webhooks from ShipStation' },
      { key: 'slashbin_orders', label: 'Slashbin Orders', description: 'Order sync webhooks from Slashbin' },
      { key: 'slashbin_kit_mappings', label: 'Slashbin Kit Mappings', description: 'Kit mapping sync webhooks from Slashbin' },
    ],
  },
  {
    key: 'shipment_sync',
    name: 'Shipment Sync',
    description: 'ShipStation shipment polling, ETL transformation, and record upsert',
    icon: RefreshCw,
    subfeatures: [
      { key: 'unified_polling', label: 'Unified Polling', description: 'Cursor-based polling from ShipStation API' },
      { key: 'etl_transform', label: 'ETL Transform', description: 'ETL service transforming raw ShipStation data' },
      { key: 'shipment_upsert', label: 'Shipment Upsert', description: 'Creating/updating shipment records in database' },
      { key: 'tracking_sync', label: 'Tracking Sync', description: 'Tracking status extraction during sync cycles' },
    ],
  },
  {
    key: 'lifecycle',
    name: 'Lifecycle',
    description: 'Order lifecycle state machine evaluation and side effects',
    icon: Activity,
    subfeatures: [
      { key: 'state_evaluation', label: 'State Evaluation', description: 'State machine phase/subphase determination' },
      { key: 'side_effects', label: 'Side Effects', description: 'Lifecycle worker side effects (hydration, categorization, fingerprint, etc.)' },
      { key: 'backfill', label: 'Backfill', description: 'Lifecycle backfill operations for bulk re-evaluation' },
    ],
  },
  {
    key: 'rate_check',
    name: 'Rate Check',
    description: 'Smart carrier rate analysis for shipping cost optimization',
    icon: DollarSign,
    subfeatures: [
      { key: 'smart_carrier_analysis', label: 'Smart Carrier Analysis', description: 'Individual shipment rate analysis via ShipStation' },
      { key: 'batch_runner', label: 'Batch Runner', description: 'Manual batch rate analysis job processing' },
    ],
  },
  {
    key: 'packing',
    name: 'Packing',
    description: 'Order packing workflows for warehouse staff',
    icon: Package,
    subfeatures: [
      { key: 'box_workflow', label: 'Box Workflow', description: 'Boxing packing flow' },
      { key: 'bag_workflow', label: 'Bag Workflow', description: 'Bagging packing flow' },
      { key: 'label_print', label: 'Label Print', description: 'Label generation and print queue' },
    ],
  },
  {
    key: 'sessions',
    name: 'Sessions',
    description: 'SkuVault wave picking session management',
    icon: Layers,
    subfeatures: [
      { key: 'skuvault_sync', label: 'SkuVault Sync', description: 'SkuVault wave picking session data sync' },
      { key: 'session_management', label: 'Session Management', description: 'Local session creation and order assignment' },
      { key: 'qc_scanning', label: 'QC Scanning', description: 'QC scan verification against SkuVault' },
    ],
  },
  {
    key: 'shopify_sync',
    name: 'Shopify Sync',
    description: 'Shopify order and product data synchronization',
    icon: ShoppingCart,
    subfeatures: [
      { key: 'order_sync', label: 'Order Sync', description: 'Shopify order polling and sync worker' },
      { key: 'product_sync', label: 'Product Sync', description: 'Product catalog sync from Shopify' },
    ],
  },
  {
    key: 'backfill',
    name: 'Backfill',
    description: 'Historical data backfill operations',
    icon: Database,
    subfeatures: [
      { key: 'order_backfill', label: 'Order Backfill', description: 'Historical order backfill from Shopify' },
      { key: 'shipment_backfill', label: 'Shipment Backfill', description: 'Shipment data backfill from ShipStation' },
    ],
  },
  {
    key: 'shipstation_writes',
    name: 'ShipStation Writes',
    description: 'Outbound writes to ShipStation with rate-limit-aware queue',
    icon: Send,
    subfeatures: [
      { key: 'write_queue', label: 'Write Queue', description: 'PostgreSQL-backed queue processing for ShipStation writes' },
      { key: 'tag_updates', label: 'Tag Updates', description: 'Tag add/remove operations on ShipStation shipments' },
    ],
  },
  {
    key: 'inventory',
    name: 'Inventory',
    description: 'Product catalog and inventory quantity tracking',
    icon: Boxes,
    subfeatures: [
      { key: 'skuvault_products', label: 'SkuVault Products', description: 'Product catalog sync from SkuVault' },
      { key: 'quantity_tracking', label: 'Quantity Tracking', description: 'Inventory quantity updates and availability calculations' },
    ],
  },
];

export default function Services() {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" data-testid="page-services">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-services-title">System Services</h1>
        <p className="text-muted-foreground mt-1">
          All instrumented features and subfeatures tracked via OpenTelemetry in Honeycomb. 
          Use these feature names to filter traces and identify where errors are occurring.
        </p>
      </div>

      <div className="grid gap-4">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <Card key={feature.key} data-testid={`card-feature-${feature.key}`}>
              <CardHeader className="flex flex-row items-center gap-3 pb-3">
                <div className="flex items-center justify-center h-9 w-9 rounded-md bg-muted shrink-0">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg">{feature.name}</CardTitle>
                    <Badge variant="outline" className="font-mono text-xs">
                      {feature.key}
                    </Badge>
                  </div>
                  <CardDescription>{feature.description}</CardDescription>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {feature.subfeatures.length} subfeature{feature.subfeatures.length !== 1 ? 's' : ''}
                </Badge>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid gap-2 sm:grid-cols-2">
                  {feature.subfeatures.map((sub) => (
                    <div 
                      key={sub.key} 
                      className="flex items-start gap-3 p-3 rounded-md bg-muted/50"
                      data-testid={`subfeature-${feature.key}-${sub.key}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{sub.label}</span>
                          <Badge variant="outline" className="font-mono text-xs">
                            {sub.key}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{sub.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card data-testid="card-correlation-ids">
        <CardHeader>
          <CardTitle className="text-lg">Correlation IDs</CardTitle>
          <CardDescription>
            Standard identifiers attached to spans for tracing an order's full journey
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { key: 'orderNumber', description: 'Unique order identifier across all sales channels' },
              { key: 'shipmentId', description: "ShipStation's unique shipment identifier (e.g. se-123456)" },
              { key: 'sessionId', description: 'SkuVault wave picking session ID' },
              { key: 'localSessionId', description: "This system's session ID (groups orders for picking/packing)" },
              { key: 'sku', description: 'Unique product identifier across all sales channels' },
              { key: 'trackingNumber', description: 'Carrier tracking number for labeled shipments' },
              { key: 'fingerprintId', description: 'Item-signature ID for packaging assignment' },
              { key: 'workstationId', description: 'Packing station handling the order' },
              { key: 'user', description: 'Warehouse staff member email performing the action' },
              { key: 'queueItemId', description: 'ShipStation write queue entry ID' },
              { key: 'lifecyclePhase', description: 'Current pipeline phase position' },
              { key: 'lifecycleSubphase', description: 'Current pipeline subphase position' },
            ].map((id) => (
              <div key={id.key} className="p-3 rounded-md bg-muted/50" data-testid={`correlation-${id.key}`}>
                <code className="text-sm font-mono font-medium text-foreground">{id.key}</code>
                <p className="text-xs text-muted-foreground mt-0.5">{id.description}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
