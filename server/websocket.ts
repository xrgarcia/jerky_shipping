import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';
import { storage } from './storage';

let wss: WebSocketServer | null = null;
const SESSION_COOKIE_NAME = 'session_token';

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    if (request.url !== '/ws') {
      return;
    }

    try {
      const cookies = request.headers.cookie ? parseCookie(request.headers.cookie) : {};
      const sessionToken = cookies[SESSION_COOKIE_NAME];

      if (!sessionToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const session = await storage.getSession(sessionToken);
      const expiresAt = session?.expiresAt ? new Date(session.expiresAt) : null;
      
      if (!session || !expiresAt || expiresAt < new Date()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const user = await storage.getUserById(session.userId);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss?.handleUpgrade(request, socket, head, (ws) => {
        wss?.emit('connection', ws, request);
      });
    } catch (error) {
      console.error('WebSocket upgrade error:', error);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('WebSocket client connected');

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}

export function broadcastOrderUpdate(order: any): void {
  if (!wss) {
    return;
  }

  const message = JSON.stringify({
    type: 'order_update',
    order,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

export function broadcastPrintQueueUpdate(data: any): void {
  if (!wss) {
    return;
  }

  const message = JSON.stringify({
    type: 'print_queue_update',
    data,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Canonical queue status structure
export type QueueStatusData = {
  shopifyQueue: number;
  shipmentSyncQueue: number;
  shopifyOrderSyncQueue: number;
  shipmentFailureCount: number;
  shopifyQueueOldestAt: number | null;
  shipmentSyncQueueOldestAt: number | null;
  shopifyOrderSyncQueueOldestAt: number | null;
  backfillActiveJob: any | null;
  onHoldWorkerStatus?: 'sleeping' | 'running';
  dataHealth: {
    ordersMissingShipments: number;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    ordersWithoutOrderItems: number;
  };
};

export function broadcastQueueStatus(data: { 
  shopifyQueue?: number;
  shopifyQueueLength?: number;
  shipmentSyncQueue?: number;
  shipmentSyncQueueLength?: number;
  shopifyOrderSyncQueue?: number;
  shopifyOrderSyncQueueLength?: number;
  shipmentFailureCount?: number;
  failureCount?: number;
  shopifyQueueOldestAt?: number | null;
  shipmentSyncQueueOldestAt?: number | null;
  shopifyOrderSyncQueueOldestAt?: number | null;
  oldestShopify?: { enqueuedAt?: number | null };
  oldestShipmentSync?: { enqueuedAt?: number | null };
  oldestShopifyOrderSync?: { enqueuedAt?: number | null };
  backfillActiveJob?: any | null;
  activeBackfillJob?: any | null;
  onHoldWorkerStatus?: 'sleeping' | 'running';
  dataHealth?: {
    ordersMissingShipments?: number;
    shipmentsWithoutOrders?: number;
    orphanedShipments?: number;
    shipmentsWithoutStatus?: number;
    shipmentSyncFailures?: number;
    ordersWithoutOrderItems?: number;
    // Legacy fields for backwards compatibility
    ordersWithoutShipments?: number;
    recentOrdersWithoutShipments?: number;
    paidOrdersWithoutShipments?: number;
  };
}): void {
  if (!wss) {
    return;
  }

  // Get current on-hold worker status
  let currentOnHoldStatus: 'sleeping' | 'running' = 'sleeping';
  try {
    const { getOnHoldWorkerStatus } = require('./onhold-poll-worker');
    currentOnHoldStatus = getOnHoldWorkerStatus();
  } catch (error) {
    // Worker not initialized yet
  }

  // Normalize to canonical format
  const canonicalData: QueueStatusData = {
    shopifyQueue: data.shopifyQueue ?? data.shopifyQueueLength ?? 0,
    shipmentSyncQueue: data.shipmentSyncQueue ?? data.shipmentSyncQueueLength ?? 0,
    shopifyOrderSyncQueue: data.shopifyOrderSyncQueue ?? data.shopifyOrderSyncQueueLength ?? 0,
    shipmentFailureCount: data.shipmentFailureCount ?? data.failureCount ?? 0,
    shopifyQueueOldestAt: data.shopifyQueueOldestAt ?? data.oldestShopify?.enqueuedAt ?? null,
    shipmentSyncQueueOldestAt: data.shipmentSyncQueueOldestAt ?? data.oldestShipmentSync?.enqueuedAt ?? null,
    shopifyOrderSyncQueueOldestAt: data.shopifyOrderSyncQueueOldestAt ?? data.oldestShopifyOrderSync?.enqueuedAt ?? null,
    backfillActiveJob: data.backfillActiveJob ?? data.activeBackfillJob ?? null,
    onHoldWorkerStatus: data.onHoldWorkerStatus ?? currentOnHoldStatus,
    dataHealth: {
      ordersMissingShipments: data.dataHealth?.ordersMissingShipments ?? 0,
      shipmentsWithoutOrders: data.dataHealth?.shipmentsWithoutOrders ?? 0,
      orphanedShipments: data.dataHealth?.orphanedShipments ?? 0,
      shipmentsWithoutStatus: data.dataHealth?.shipmentsWithoutStatus ?? 0,
      shipmentSyncFailures: data.dataHealth?.shipmentSyncFailures ?? 0,
      ordersWithoutOrderItems: data.dataHealth?.ordersWithoutOrderItems ?? 0,
    },
  };

  const message = JSON.stringify({
    type: 'queue_status',
    data: canonicalData,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
