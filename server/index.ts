import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import cookieParser from "cookie-parser";
import path from "path";
import { ensureWebhooksRegistered } from "./utils/shopify-webhook";
import { ensureShipStationWebhooksRegistered } from "./utils/shipstation-webhook";
import { setupWebSocket } from "./websocket";

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

  // Register Shopify webhooks on startup
  if (process.env.SHOPIFY_SHOP_DOMAIN && 
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN && 
      process.env.WEBHOOK_BASE_URL) {
    try {
      log("Checking Shopify webhook registration...");
      await ensureWebhooksRegistered(
        process.env.SHOPIFY_SHOP_DOMAIN,
        process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        process.env.WEBHOOK_BASE_URL
      );
      log("Shopify webhooks verified");
    } catch (error) {
      console.error("Failed to register Shopify webhooks:", error);
    }
  } else {
    log("Skipping Shopify webhook registration - missing configuration");
  }

  // Register ShipStation webhooks on startup
  if (process.env.SHIPSTATION_API_KEY && process.env.WEBHOOK_BASE_URL) {
    try {
      log("Checking ShipStation webhook registration...");
      await ensureShipStationWebhooksRegistered(
        process.env.WEBHOOK_BASE_URL
      );
      log("ShipStation webhooks verified");
    } catch (error) {
      console.error("Failed to register ShipStation webhooks:", error);
    }
  } else {
    log("Skipping ShipStation webhook registration - missing configuration");
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
  });
})();
