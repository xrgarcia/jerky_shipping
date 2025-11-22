import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import cookieParser from "cookie-parser";
import path from "path";
import { ensureWebhooksRegistered } from "./utils/shopify-webhook";
import { ensureShipStationWebhooksRegistered } from "./utils/shipstation-webhook";
import { setupWebSocket } from "./websocket";
import { storage } from "./storage";

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Set up WebSocket server
  setupWebSocket(server);
  log("WebSocket server initialized");

  // Broadcast comprehensive initial queue status to ensure clients get fresh data immediately after restart
  try {
    const { broadcastQueueStatus } = await import("./websocket");
    const { 
      getQueueLength, 
      getShipmentSyncQueueLength, 
      getShopifyOrderSyncQueueLength,
      getOldestShopifyQueueMessage,
      getOldestShipmentSyncQueueMessage,
      getOldestShopifyOrderSyncQueueMessage
    } = await import("./utils/queue");
    const { shipmentSyncFailures } = await import("@shared/schema");
    const { db } = await import("./db");
    const { count } = await import("drizzle-orm");
    
    const shopifyQueueLength = await getQueueLength();
    const shipmentSyncQueueLength = await getShipmentSyncQueueLength();
    const shopifyOrderSyncQueueLength = await getShopifyOrderSyncQueueLength();
    const oldestShopify = await getOldestShopifyQueueMessage();
    const oldestShipmentSync = await getOldestShipmentSyncQueueMessage();
    const oldestShopifyOrderSync = await getOldestShopifyOrderSyncQueueMessage();
    const failureCount = await db.select({ count: count() })
      .from(shipmentSyncFailures)
      .then(rows => rows[0]?.count || 0);
    const allBackfillJobs = await storage.getAllBackfillJobs();
    const activeBackfillJob = allBackfillJobs.find(j => j.status === 'running' || j.status === 'pending') || null;
    // Data health metrics are already in the correct format (dates as ISO strings)
    const dataHealth = await storage.getDataHealthMetrics();
    
    broadcastQueueStatus({
      shopifyQueue: shopifyQueueLength,
      shipmentSyncQueue: shipmentSyncQueueLength,
      shopifyOrderSyncQueue: shopifyOrderSyncQueueLength,
      shipmentFailureCount: failureCount,
      shopifyQueueOldestAt: oldestShopify?.enqueuedAt || null,
      shipmentSyncQueueOldestAt: oldestShipmentSync?.enqueuedAt || null,
      shopifyOrderSyncQueueOldestAt: oldestShopifyOrderSync?.enqueuedAt || null,
      backfillActiveJob: activeBackfillJob,
      onHoldWorkerStatus: 'sleeping', // Worker hasn't started yet, default to sleeping
      dataHealth,
    });
    log("Initial queue status broadcast sent");
  } catch (error) {
    console.error("Failed to broadcast initial queue status:", error);
  }

  // Determine webhook base URL based on environment
  const { getWebhookBaseUrl } = await import("./utils/webhook-url.js");
  const webhookBaseUrl = getWebhookBaseUrl();
  
  if (webhookBaseUrl) {
    const envName = process.env.REPLIT_DEPLOYMENT === '1' ? 'PRODUCTION' : 'DEV';
    log(`Webhook base URL (${envName}): ${webhookBaseUrl}`);
  } else {
    log('Warning: No valid webhook base URL detected - webhook registration will be skipped');
  }

  // Register Shopify webhooks on startup
  if (process.env.SHOPIFY_SHOP_DOMAIN && 
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN && 
      webhookBaseUrl) {
    try {
      log("Checking Shopify webhook registration...");
      await ensureWebhooksRegistered(
        process.env.SHOPIFY_SHOP_DOMAIN,
        process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        webhookBaseUrl
      );
      log("Shopify webhooks verified");
    } catch (error) {
      console.error("Failed to register Shopify webhooks:", error);
    }
  } else {
    log("Skipping Shopify webhook registration - missing configuration");
  }

  // Register ShipStation webhooks on startup
  if (process.env.SHIPSTATION_API_KEY && webhookBaseUrl) {
    try {
      log("Checking ShipStation webhook registration...");
      await ensureShipStationWebhooksRegistered(
        webhookBaseUrl
      );
      log("ShipStation webhooks verified");
    } catch (error) {
      console.error("Failed to register ShipStation webhooks:", error);
    }
  } else {
    log("Skipping ShipStation webhook registration - missing configuration");
  }

  // Start background worker to process queued webhooks
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { startBackgroundWorker } = await import("./background-worker");
    startBackgroundWorker(5000); // Process queue every 5 seconds
    
    // Start shipment sync worker to process shipment sync requests
    const { startShipmentSyncWorker } = await import("./shipment-sync-worker");
    startShipmentSyncWorker(10000); // Process shipment sync queue every 10 seconds
    
    // Start Shopify order sync worker to import missing orders
    const { startShopifyOrderSyncWorker } = await import("./shopify-sync-worker");
    startShopifyOrderSyncWorker(8000); // Process Shopify order sync queue every 8 seconds
    
    // Clear all coordination locks from previous server instance to prevent phantom locks
    log("Clearing all worker coordination locks...");
    const { workerCoordinator } = await import("./worker-coordinator");
    await workerCoordinator.clearAllLocks();
    log("Worker coordination locks cleared successfully");
    
    // Start on-hold shipments polling worker (supplements webhooks which don't fire for on_hold)
    const { startOnHoldPollWorker } = await import("./onhold-poll-worker");
    startOnHoldPollWorker(60000); // Poll for on_hold shipments every 1 minute
    
    // Resume any in-progress backfill jobs that were interrupted by server restart
    setImmediate(async () => {
      try {
        const { BackfillService } = await import("./services/backfill-service");
        const { storage } = await import("./storage");
        const backfillService = new BackfillService(storage);
        await backfillService.resumeInProgressJobs();
      } catch (error) {
        console.error("Failed to resume in-progress backfill jobs:", error);
      }
    });
  } else {
    log("Skipping background workers - Redis not configured");
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
    
    // Bootstrap products asynchronously after server starts
    if (process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
      setImmediate(async () => {
        try {
          log("Starting async product bootstrap from Shopify...");
          const { bootstrapProductsFromShopify } = await import("./utils/shopify-sync");
          await bootstrapProductsFromShopify();
          log("Product bootstrap completed");
        } catch (error) {
          console.error("Failed to bootstrap products from Shopify:", error);
        }
      });
    }
  });
})();
