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

export function broadcastQueueStatus(data: { 
  shopifyQueue: number; 
  shipmentSyncQueue: number; 
  shipmentFailureCount: number;
  shopifyQueueOldestAt?: number | null;
  shipmentSyncQueueOldestAt?: number | null;
  backfillActiveJob?: any | null;
  dataHealth?: {
    ordersWithoutShipments: number;
    recentOrdersWithoutShipments: number;
    paidOrdersWithoutShipments: number;
  };
}): void {
  if (!wss) {
    return;
  }

  const message = JSON.stringify({
    type: 'queue_status',
    data,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
