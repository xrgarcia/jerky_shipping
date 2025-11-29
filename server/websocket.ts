import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';
import { URL } from 'url';
import { createHash } from 'crypto';
import { storage } from './storage';

let wss: WebSocketServer | null = null;
const SESSION_COOKIE_NAME = 'session_token';

// WebSocket rooms for separating broadcasts by page/context (BROWSER CLIENTS)
type Room = 'home' | 'operations' | 'orders' | 'backfill' | 'default';
const rooms = new Map<Room, Set<WebSocket>>();
const clientRooms = new WeakMap<WebSocket, Room>();

// Initialize browser rooms
(['home', 'operations', 'orders', 'backfill', 'default'] as Room[]).forEach(room => {
  rooms.set(room, new Set());
});

// ============================================================================
// DESKTOP PRINTING WEBSOCKET (COMPLETELY ISOLATED)
// ============================================================================

// Desktop client connections - separate from browser clients
interface DesktopConnection {
  ws: WebSocket;
  clientId: string;
  userId: string;
  stationId: string | null;
  lastHeartbeat: Date;
}

// Map of stationId -> Set of connections (one station can have one active client)
const desktopStationConnections = new Map<string, DesktopConnection>();
// Map of clientId -> connection for quick lookup
const desktopClientConnections = new Map<string, DesktopConnection>();

// Hash token for lookup
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Authenticate desktop client from Bearer token
async function authenticateDesktopClient(authHeader: string | undefined): Promise<{ clientId: string; userId: string } | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const tokenHash = hashToken(token);

  try {
    const client = await storage.getDesktopClientByAccessToken(tokenHash);
    if (!client) {
      return null;
    }

    // Check token expiry
    if (new Date() > new Date(client.accessTokenExpiresAt)) {
      return null;
    }

    return { clientId: client.id, userId: client.userId };
  } catch (error) {
    console.error('[Desktop WS] Auth error:', error);
    return null;
  }
}

// Handle desktop client WebSocket connection
function handleDesktopConnection(ws: WebSocket, clientId: string, userId: string): void {
  const connection: DesktopConnection = {
    ws,
    clientId,
    userId,
    stationId: null,
    lastHeartbeat: new Date(),
  };

  desktopClientConnections.set(clientId, connection);
  console.log(`[Desktop WS] Client ${clientId} connected`);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'desktop:connected',
    clientId,
  }));
  
  // Send authenticated message - the client waits for this before resubscribing to stations
  ws.send(JSON.stringify({
    type: 'desktop:authenticated',
    clientId,
  }));
  console.log(`[Desktop WS] Client ${clientId} authenticated`);

  // Handle incoming messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleDesktopMessage(connection, message);
    } catch (error) {
      console.error('[Desktop WS] Message parse error:', error);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    console.log(`[Desktop WS] Client ${clientId} disconnected`);
    cleanupDesktopConnection(connection);
  });

  ws.on('error', (error) => {
    console.error(`[Desktop WS] Client ${clientId} error:`, error);
    cleanupDesktopConnection(connection);
  });
}

// Helper to safely cleanup a desktop connection without affecting other clients
function cleanupDesktopConnection(connection: DesktopConnection): void {
  // Only remove from station map if THIS exact connection (same socket) is still the active one
  // This prevents a reconnecting client or new client from being kicked when old socket closes
  if (connection.stationId) {
    const activeConnection = desktopStationConnections.get(connection.stationId);
    if (activeConnection && activeConnection.ws === connection.ws) {
      desktopStationConnections.delete(connection.stationId);
    }
  }
  
  // Only remove from client map if THIS exact connection (same socket) is still the active one
  const activeClientConnection = desktopClientConnections.get(connection.clientId);
  if (activeClientConnection && activeClientConnection.ws === connection.ws) {
    desktopClientConnections.delete(connection.clientId);
  }
}

// Handle messages from desktop clients
async function handleDesktopMessage(connection: DesktopConnection, message: any): Promise<void> {
  switch (message.type) {
    case 'desktop:heartbeat':
      connection.lastHeartbeat = new Date();
      connection.ws.send(JSON.stringify({ type: 'desktop:heartbeat_ack' }));
      break;

    case 'desktop:subscribe_station':
      // Client wants to receive jobs for a station
      const stationId = message.stationId;
      if (!stationId) {
        connection.ws.send(JSON.stringify({ 
          type: 'desktop:error', 
          error: 'Missing stationId' 
        }));
        return;
      }

      // Verify the client has an active session for this station
      const session = await storage.getActiveSessionByDesktopClient(connection.clientId);
      if (!session || session.stationId !== stationId) {
        connection.ws.send(JSON.stringify({ 
          type: 'desktop:error', 
          error: 'No active session for this station' 
        }));
        return;
      }

      // Remove from old station if any (safely, only if we're the exact active socket)
      if (connection.stationId && connection.stationId !== stationId) {
        const activeConnection = desktopStationConnections.get(connection.stationId);
        if (activeConnection && activeConnection.ws === connection.ws) {
          desktopStationConnections.delete(connection.stationId);
        }
      }

      // Subscribe to new station
      connection.stationId = stationId;
      desktopStationConnections.set(stationId, connection);
      
      connection.ws.send(JSON.stringify({ 
        type: 'desktop:subscribed', 
        stationId 
      }));
      console.log(`[Desktop WS] Client ${connection.clientId} subscribed to station ${stationId}`);
      break;

    case 'desktop:unsubscribe_station':
      if (connection.stationId) {
        const oldStationId = connection.stationId;
        // Only remove from map if we're the exact active socket for this station
        const activeConnection = desktopStationConnections.get(oldStationId);
        if (activeConnection && activeConnection.ws === connection.ws) {
          desktopStationConnections.delete(oldStationId);
        }
        connection.stationId = null;
        connection.ws.send(JSON.stringify({ 
          type: 'desktop:unsubscribed', 
          stationId: oldStationId 
        }));
      }
      break;

    default:
      console.log(`[Desktop WS] Unknown message type: ${message.type}`);
  }
}

// Broadcast a print job to the desktop client subscribed to a station
export function broadcastDesktopPrintJob(stationId: string, job: any): void {
  const connection = desktopStationConnections.get(stationId);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    console.log(`[Desktop WS] No active connection for station ${stationId}`);
    return;
  }

  try {
    connection.ws.send(JSON.stringify({
      type: 'desktop:job:new',
      job,
    }));
    console.log(`[Desktop WS] Sent job ${job.id} to station ${stationId}`);
  } catch (error) {
    console.error(`[Desktop WS] Error sending job to station ${stationId}:`, error);
  }
}

// Broadcast job status update to desktop client
export function broadcastDesktopJobUpdate(stationId: string, jobId: string, status: string, data?: any): void {
  const connection = desktopStationConnections.get(stationId);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    connection.ws.send(JSON.stringify({
      type: 'desktop:job:update',
      jobId,
      status,
      ...data,
    }));
  } catch (error) {
    console.error(`[Desktop WS] Error sending job update to station ${stationId}:`, error);
  }
}

// Get desktop connection stats
export function getDesktopConnectionStats(): { totalClients: number; stationsWithClients: number } {
  return {
    totalClients: desktopClientConnections.size,
    stationsWithClients: desktopStationConnections.size,
  };
}

// Broadcast station deletion to the desktop client - forces logout
export function broadcastDesktopStationDeleted(stationId: string): void {
  const connection = desktopStationConnections.get(stationId);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    console.log(`[Desktop WS] No active connection for station ${stationId} to notify of deletion`);
    return;
  }

  try {
    connection.ws.send(JSON.stringify({
      type: 'desktop:station:deleted',
      stationId,
      message: 'This station has been deleted. You will be logged out.',
    }));
    console.log(`[Desktop WS] Notified client of station ${stationId} deletion`);
    
    // Clean up the connection after notification
    desktopStationConnections.delete(stationId);
    connection.stationId = null;
  } catch (error) {
    console.error(`[Desktop WS] Error notifying station ${stationId} deletion:`, error);
  }
}

// Broadcast station update to the desktop client - updates station details in real-time
export function broadcastDesktopStationUpdated(stationId: string, station: { id: string; name: string; locationHint: string | null; isActive: boolean }): void {
  const connection = desktopStationConnections.get(stationId);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    console.log(`[Desktop WS] No active connection for station ${stationId} to notify of update`);
    return;
  }

  try {
    connection.ws.send(JSON.stringify({
      type: 'desktop:station:updated',
      stationId,
      station: {
        id: station.id,
        name: station.name,
        location: station.locationHint,
        isActive: station.isActive,
      },
    }));
    console.log(`[Desktop WS] Notified client of station ${stationId} update`);
  } catch (error) {
    console.error(`[Desktop WS] Error notifying station ${stationId} update:`, error);
  }
}

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    
    // ========================================
    // DESKTOP CLIENT WEBSOCKET (ISOLATED)
    // Path: /ws/desktop
    // Auth: Bearer token in Authorization header
    // ========================================
    if (url.pathname === '/ws/desktop') {
      try {
        const authHeader = request.headers.authorization;
        const authResult = await authenticateDesktopClient(authHeader);
        
        if (!authResult) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss?.handleUpgrade(request, socket, head, (ws) => {
          // Handle desktop connection separately - NOT emitting to main 'connection' event
          handleDesktopConnection(ws, authResult.clientId, authResult.userId);
        });
      } catch (error) {
        console.error('[Desktop WS] Upgrade error:', error);
        socket.destroy();
      }
      return;
    }
    
    // ========================================
    // BROWSER CLIENT WEBSOCKET
    // Path: /ws
    // Auth: Session cookie
    // ========================================
    if (url.pathname !== '/ws') {
      return;
    }

    // Extract room from query parameter (e.g., /ws?room=operations)
    const requestedRoom = url.searchParams.get('room') as Room | null;
    const room: Room = requestedRoom && rooms.has(requestedRoom) ? requestedRoom : 'default';

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

  // Browser client connection handler (room-based)
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
  onHoldWorkerStats?: {
    totalProcessedCount: number;
    lastProcessedCount: number;
    workerStartedAt: string;
    lastCompletedAt: string | null;
  };
  firestoreSessionSyncWorkerStatus?: 'sleeping' | 'running' | 'error';
  firestoreSessionSyncWorkerStats?: {
    totalSynced: number;
    lastSyncCount: number;
    lastSyncAt: string | null;
    lastSyncTimestamp: string | null;
    workerStartedAt: string;
    errorsCount: number;
    lastError: string | null;
  };
  pipeline?: {
    sessionedToday: number;
    inPackingQueue: number;
    shippedToday: number;
    oldestQueuedSessionAt: string | null;
  };
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
  onHoldWorkerStats?: {
    totalProcessedCount: number;
    lastProcessedCount: number;
    workerStartedAt: string;
    lastCompletedAt: string | null;
  };
  printQueueWorkerStatus?: 'sleeping' | 'running';
  printQueueWorkerStats?: {
    totalProcessedCount: number;
    lastProcessedCount: number;
    workerStartedAt: Date;
    lastCompletedAt: Date | null;
    status: 'sleeping' | 'running';
  };
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
  skuvaultQCQueue?: {
    length: number;
    status: 'sleeping' | 'running' | 'error';
    stats: {
      totalProcessed: number;
      successCount: number;
      failCount: number;
      lastProcessedAt: Date | null;
      workerStartedAt: Date;
      errorsCount: number;
      lastError: string | null;
    };
  };
  firestoreSessionSyncWorkerStatus?: 'sleeping' | 'running' | 'error';
  firestoreSessionSyncWorkerStats?: {
    totalSynced: number;
    lastSyncCount: number;
    lastSyncAt: string | null;
    lastSyncTimestamp: string | null;
    workerStartedAt: string;
    errorsCount: number;
    lastError: string | null;
  };
  pipeline?: {
    sessionedToday: number;
    inPackingQueue: number;
    shippedToday: number;
    oldestQueuedSessionAt: string | null;
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

  // Get worker stats if available
  let workerStats = undefined;
  try {
    const { getOnHoldWorkerStats } = require('./onhold-poll-worker');
    workerStats = getOnHoldWorkerStats();
  } catch (error) {
    // Worker not initialized yet
  }

  // Get cached state to merge with (prevents flashing when partial updates are sent)
  let cachedState: Partial<QueueStatusData> = {};
  if (!globalThis.__lastQueueStatus) {
    globalThis.__lastQueueStatus = {};
  }
  if (globalThis.__lastQueueStatus['queue']) {
    try {
      cachedState = JSON.parse(globalThis.__lastQueueStatus['queue']);
    } catch (error) {
      // Invalid cache, start fresh
    }
  }

  // Merge incoming data with cached state, then apply defaults
  // This prevents flashing when one worker sends partial updates
  const canonicalData: QueueStatusData = {
    shopifyQueue: data.shopifyQueue ?? data.shopifyQueueLength ?? cachedState.shopifyQueue ?? 0,
    shipmentSyncQueue: data.shipmentSyncQueue ?? data.shipmentSyncQueueLength ?? cachedState.shipmentSyncQueue ?? 0,
    shopifyOrderSyncQueue: data.shopifyOrderSyncQueue ?? data.shopifyOrderSyncQueueLength ?? cachedState.shopifyOrderSyncQueue ?? 0,
    shipmentFailureCount: data.shipmentFailureCount ?? data.failureCount ?? cachedState.shipmentFailureCount ?? 0,
    shopifyQueueOldestAt: data.shopifyQueueOldestAt ?? data.oldestShopify?.enqueuedAt ?? cachedState.shopifyQueueOldestAt ?? null,
    shipmentSyncQueueOldestAt: data.shipmentSyncQueueOldestAt ?? data.oldestShipmentSync?.enqueuedAt ?? cachedState.shipmentSyncQueueOldestAt ?? null,
    shopifyOrderSyncQueueOldestAt: data.shopifyOrderSyncQueueOldestAt ?? data.oldestShopifyOrderSync?.enqueuedAt ?? cachedState.shopifyOrderSyncQueueOldestAt ?? null,
    // For backfillActiveJob: only update if explicitly provided (not undefined)
    // This prevents other workers from accidentally clearing the backfill job
    backfillActiveJob: data.backfillActiveJob !== undefined 
      ? data.backfillActiveJob 
      : (data.activeBackfillJob !== undefined 
        ? data.activeBackfillJob 
        : cachedState.backfillActiveJob ?? null),
    onHoldWorkerStatus: data.onHoldWorkerStatus ?? currentOnHoldStatus,
    onHoldWorkerStats: data.onHoldWorkerStats ?? workerStats,
    // Firestore session sync worker - preserve from cache if not provided
    firestoreSessionSyncWorkerStatus: data.firestoreSessionSyncWorkerStatus ?? cachedState.firestoreSessionSyncWorkerStatus,
    firestoreSessionSyncWorkerStats: data.firestoreSessionSyncWorkerStats ?? cachedState.firestoreSessionSyncWorkerStats,
    // Pipeline metrics - preserve from cache if not provided (prevents flashing)
    pipeline: data.pipeline ?? cachedState.pipeline,
    dataHealth: {
      ordersMissingShipments: data.dataHealth?.ordersMissingShipments ?? cachedState.dataHealth?.ordersMissingShipments ?? 0,
      oldestOrderMissingShipmentAt: data.dataHealth?.oldestOrderMissingShipmentAt ?? cachedState.dataHealth?.oldestOrderMissingShipmentAt ?? null,
      shipmentsWithoutOrders: data.dataHealth?.shipmentsWithoutOrders ?? cachedState.dataHealth?.shipmentsWithoutOrders ?? 0,
      orphanedShipments: data.dataHealth?.orphanedShipments ?? cachedState.dataHealth?.orphanedShipments ?? 0,
      shipmentsWithoutStatus: data.dataHealth?.shipmentsWithoutStatus ?? cachedState.dataHealth?.shipmentsWithoutStatus ?? 0,
      shipmentSyncFailures: data.dataHealth?.shipmentSyncFailures ?? cachedState.dataHealth?.shipmentSyncFailures ?? 0,
      ordersWithoutOrderItems: data.dataHealth?.ordersWithoutOrderItems ?? cachedState.dataHealth?.ordersWithoutOrderItems ?? 0,
    },
  };

  // Cache last broadcast data to detect changes and prevent duplicate broadcasts
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
