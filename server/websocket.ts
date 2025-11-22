import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';
import { URL } from 'url';
import { storage } from './storage';

let wss: WebSocketServer | null = null;
const SESSION_COOKIE_NAME = 'session_token';

// WebSocket rooms for separating broadcasts by page/context
type Room = 'home' | 'operations' | 'orders' | 'backfill' | 'default';
const rooms = new Map<Room, Set<WebSocket>>();
const clientRooms = new WeakMap<WebSocket, Room>();

// Initialize rooms
(['home', 'operations', 'orders', 'backfill', 'default'] as Room[]).forEach(room => {
  rooms.set(room, new Set());
});

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    // Extract room from query parameter (e.g., /ws?room=operations)
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const requestedRoom = url.searchParams.get('room') as Room | null;
    const room: Room = requestedRoom && rooms.has(requestedRoom) ? requestedRoom : 'default';
    
    if (url.pathname !== '/ws') {
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
        wss?.emit('connection', ws, { request, room });
      });
    } catch (error) {
      console.error('WebSocket upgrade error:', error);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, context: { request: IncomingMessage; room: Room }) => {
    const room = context.room || 'default';
    
    // Register client in room
    rooms.get(room)?.add(ws);
    clientRooms.set(ws, room);
    
    console.log(`WebSocket client connected to room: ${room}`);
    
    // Send cached queue status to newly connected operations clients
    if (room === 'operations' && globalThis.__lastQueueStatus?.['queue']) {
      try {
        const cachedData = JSON.parse(globalThis.__lastQueueStatus['queue']);
        const message = JSON.stringify({
          type: 'queue_status',
          data: cachedData,
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
          console.log(`Sent cached queue status to newly connected operations client`);
        }
      } catch (error) {
        console.error('Failed to send cached queue status to new client:', error);
      }
    }

    ws.on('close', () => {
      // Remove client from room
      const clientRoom = clientRooms.get(ws);
      if (clientRoom) {
        rooms.get(clientRoom)?.delete(ws);
        clientRooms.delete(ws);
      }
      console.log(`WebSocket client disconnected from room: ${room}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      // Clean up on error
      const clientRoom = clientRooms.get(ws);
      if (clientRoom) {
        rooms.get(clientRoom)?.delete(ws);
        clientRooms.delete(ws);
      }
    });
  });
}

// Helper to broadcast to specific room(s) asynchronously
function broadcastToRooms(targetRooms: Room[], message: string): void {
  setImmediate(() => {
    targetRooms.forEach(room => {
      const clients = rooms.get(room);
      if (!clients) return;
      
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(message);
          } catch (error) {
            console.error(`Error sending message to client in room ${room}:`, error);
          }
        }
      });
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

  // Broadcast to home, orders, and default rooms (not operations or backfill)
  broadcastToRooms(['home', 'orders', 'default'], message);
}

export function broadcastPrintQueueUpdate(data: any): void {
  if (!wss) {
    return;
  }

  const message = JSON.stringify({
    type: 'print_queue_update',
    data,
  });

  // Broadcast to home, orders, and default rooms (print queue is not on operations page)
  broadcastToRooms(['home', 'orders', 'default'], message);
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
  onHoldWorkerStatus?: 'sleeping' | 'running' | 'awaiting_backfill_job';
  dataHealth: {
    ordersMissingShipments: number;
    oldestOrderMissingShipmentAt: string | null;
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
  onHoldWorkerStatus?: 'sleeping' | 'running' | 'awaiting_backfill_job';
  dataHealth?: {
    ordersMissingShipments?: number;
    oldestOrderMissingShipmentAt?: string | null;
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
  // Guard against wss being null and clear entire cache to prevent stale data after restart
  if (!wss) {
    // Clear entire cache object to prevent any stale data from blocking future broadcasts
    globalThis.__lastQueueStatus = {};
    return;
  }

  // Get current on-hold worker status
  let currentOnHoldStatus: 'sleeping' | 'running' | 'awaiting_backfill_job' = 'sleeping';
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
      oldestOrderMissingShipmentAt: data.dataHealth?.oldestOrderMissingShipmentAt ?? null,
      shipmentsWithoutOrders: data.dataHealth?.shipmentsWithoutOrders ?? 0,
      orphanedShipments: data.dataHealth?.orphanedShipments ?? 0,
      shipmentsWithoutStatus: data.dataHealth?.shipmentsWithoutStatus ?? 0,
      shipmentSyncFailures: data.dataHealth?.shipmentSyncFailures ?? 0,
      ordersWithoutOrderItems: data.dataHealth?.ordersWithoutOrderItems ?? 0,
    },
  };

  // Cache last broadcast data to detect changes and prevent flashing
  if (!globalThis.__lastQueueStatus) {
    globalThis.__lastQueueStatus = {};
  }
  
  const cacheKey = JSON.stringify(canonicalData);
  const lastCacheKey = globalThis.__lastQueueStatus['queue'];
  
  // Only broadcast if data has actually changed
  if (cacheKey === lastCacheKey) {
    return;
  }
  
  globalThis.__lastQueueStatus['queue'] = cacheKey;

  const message = JSON.stringify({
    type: 'queue_status',
    data: canonicalData,
  });

  // Broadcast queue status to ALL rooms - all pages need queue/worker status
  broadcastToRooms(['home', 'operations', 'orders', 'backfill', 'default'], message);
}

// TypeScript global declarations
declare global {
  var __lastQueueStatus: Record<string, string> | undefined;
}
