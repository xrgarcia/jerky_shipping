import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

const HONEYCOMB_API_KEY = process.env.HONEYCOMB_API_KEY;
const OTEL_DEBUG = process.env.OTEL_DEBUG === 'true';

if (OTEL_DEBUG) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

if (!HONEYCOMB_API_KEY) {
  console.warn('[OpenTelemetry] HONEYCOMB_API_KEY not set — tracing disabled');
} else {
  const headers = {
    'x-honeycomb-team': HONEYCOMB_API_KEY,
  };

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'ship-warehouse',
  });

  const traceExporter = new OTLPTraceExporter({
    url: 'https://api.honeycomb.io/v1/traces',
    headers,
  });

  const metricExporter = new OTLPMetricExporter({
    url: 'https://api.honeycomb.io/v1/metrics',
    headers,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.log('[OpenTelemetry] Tracing initialized → Honeycomb (ship-warehouse)');

  const verifyExport = async () => {
    try {
      const response = await fetch('https://api.honeycomb.io/1/auth', {
        headers: { 'X-Honeycomb-Team': HONEYCOMB_API_KEY },
      });
      if (response.ok) {
        const data = await response.json() as any;
        console.log(`[OpenTelemetry] Honeycomb auth verified — team: ${data.team?.slug || 'unknown'}, environment: ${data.environment?.slug || 'unknown'}`);
      } else {
        console.error(`[OpenTelemetry] Honeycomb auth FAILED — status ${response.status}. Check HONEYCOMB_API_KEY.`);
      }
    } catch (err: any) {
      console.error(`[OpenTelemetry] Honeycomb connectivity check failed: ${err.message}`);
    }
  };
  verifyExport();

  process.on('SIGTERM', () => {
    sdk.shutdown().then(() => {
      console.log('[OpenTelemetry] SDK shut down');
    });
  });
}
