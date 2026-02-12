import { trace, SpanStatusCode, type Span, context } from '@opentelemetry/api';

const tracer = trace.getTracer('ship-warehouse');

export const FEATURES = {
  webhooks: {
    name: 'Webhooks',
    description: 'Inbound webhook handlers for external service events',
    subfeatures: {
      shopify_orders: 'Shopify order create/update webhooks',
      shopify_refunds: 'Shopify refund webhooks',
      shopify_products: 'Shopify product create/update/delete webhooks',
      shipstation_track: 'ShipStation tracking status update webhooks',
      shipstation_ship: 'ShipStation shipment shipped/rejected webhooks',
      shipstation_batch: 'ShipStation batch completion webhooks',
      slashbin_orders: 'Slashbin order sync webhooks',
      slashbin_kit_mappings: 'Slashbin kit mapping sync webhooks',
    },
  },
  shipment_sync: {
    name: 'Shipment Sync',
    description: 'ShipStation shipment polling, ETL transformation, and record upsert',
    subfeatures: {
      unified_polling: 'Cursor-based polling from ShipStation API',
      etl_transform: 'ETL service transforming raw ShipStation data',
      shipment_upsert: 'Creating/updating shipment records in database',
      tracking_sync: 'Tracking status extraction during sync cycles',
    },
  },
  lifecycle: {
    name: 'Lifecycle',
    description: 'Order lifecycle state machine evaluation and side effects',
    subfeatures: {
      state_evaluation: 'State machine phase/subphase determination',
      side_effects: 'Lifecycle worker side effects (hydration, categorization, fingerprint, etc.)',
      backfill: 'Lifecycle backfill operations for bulk re-evaluation',
    },
  },
  rate_check: {
    name: 'Rate Check',
    description: 'Smart carrier rate analysis for shipping cost optimization',
    subfeatures: {
      smart_carrier_analysis: 'Individual shipment rate analysis via ShipStation',
      batch_runner: 'Manual batch rate analysis job processing',
    },
  },
  packing: {
    name: 'Packing',
    description: 'Order packing workflows for warehouse staff',
    subfeatures: {
      box_workflow: 'Boxing packing flow',
      bag_workflow: 'Bagging packing flow',
      label_print: 'Label generation and print queue',
    },
  },
  sessions: {
    name: 'Sessions',
    description: 'SkuVault wave picking session management',
    subfeatures: {
      skuvault_sync: 'SkuVault wave picking session data sync',
      session_management: 'Local session creation and order assignment',
      qc_scanning: 'QC scan verification against SkuVault',
    },
  },
  shopify_sync: {
    name: 'Shopify Sync',
    description: 'Shopify order and product data synchronization',
    subfeatures: {
      order_sync: 'Shopify order polling and sync worker',
      product_sync: 'Product catalog sync from Shopify',
    },
  },
  backfill: {
    name: 'Backfill',
    description: 'Historical data backfill operations',
    subfeatures: {
      order_backfill: 'Historical order backfill from Shopify',
      shipment_backfill: 'Shipment data backfill from ShipStation',
    },
  },
  shipstation_writes: {
    name: 'ShipStation Writes',
    description: 'Outbound writes to ShipStation with rate-limit-aware queue',
    subfeatures: {
      write_queue: 'PostgreSQL-backed queue processing for ShipStation writes',
      tag_updates: 'Tag add/remove operations on ShipStation shipments',
    },
  },
  inventory: {
    name: 'Inventory',
    description: 'Product catalog and inventory quantity tracking',
    subfeatures: {
      skuvault_products: 'Product catalog sync from SkuVault',
      quantity_tracking: 'Inventory quantity updates and availability calculations',
    },
  },
} as const;

export type FeatureKey = keyof typeof FEATURES;
export type SubfeatureKey<F extends FeatureKey> = keyof typeof FEATURES[F]['subfeatures'];

export interface CorrelationIds {
  orderNumber?: string;
  shipmentId?: string;
  sessionId?: string;
  localSessionId?: string;
  sku?: string;
  trackingNumber?: string;
  fingerprintId?: string;
  workstationId?: string;
  user?: string;
  queueItemId?: string;
  lifecyclePhase?: string;
  lifecycleSubphase?: string;
}

export function withSpan<T>(
  feature: FeatureKey,
  subfeature: string,
  operationName: string,
  fn: (span: Span) => Promise<T>,
  correlationIds?: CorrelationIds,
): Promise<T> {
  return tracer.startActiveSpan(`${feature}.${subfeature}.${operationName}`, async (span) => {
    try {
      span.setAttribute('app.feature', feature);
      span.setAttribute('app.subfeature', subfeature);
      span.setAttribute('app.operation', operationName);

      if (correlationIds) {
        for (const [key, value] of Object.entries(correlationIds)) {
          if (value !== undefined && value !== null) {
            span.setAttribute(`app.${key}`, value);
          }
        }
      }

      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function addCorrelationIds(span: Span, ids: CorrelationIds): void {
  for (const [key, value] of Object.entries(ids)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(`app.${key}`, value);
    }
  }
}

export function getCurrentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

export function tagCurrentSpan(feature: FeatureKey, subfeature: string, ids?: CorrelationIds): void {
  const span = getCurrentSpan();
  if (span) {
    span.setAttribute('app.feature', feature);
    span.setAttribute('app.subfeature', subfeature);
    if (ids) {
      addCorrelationIds(span, ids);
    }
  }
}
