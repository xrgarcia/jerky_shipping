import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../shared/config';
import type { PrintJob, ConnectionInfo } from '../shared/types';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

// PRODUCTION: Unlimited reconnection attempts - warehouse apps MUST survive server restarts/deployments
const MAX_RECONNECT_ATTEMPTS = Infinity;
const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 30000;

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private token: string;
  private clientId: string;
  private wsUrl: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private subscribedStationId: string | null = null;
  private pendingStationSubscription: string | null = null;
  private isIntentionalClose = false;
  private isAuthenticated = false;
  private reconnectAttempt = 0;
  private lastError: string | null = null;
  private lastConnectedAt: string | null = null;
  
  constructor(token: string, clientId: string, wsUrl: string) {
    super();
    this.token = token;
    this.clientId = clientId;
    this.wsUrl = wsUrl;
  }
  
  getConnectionInfo(): ConnectionInfo {
    let status: ConnectionInfo['status'] = 'disconnected';
    
    if (this.ws?.readyState === WebSocket.OPEN) {
      status = 'connected';
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      status = 'connecting';
    } else if (this.reconnectTimer || (this.reconnectAttempt > 0 && !this.isIntentionalClose)) {
      // We're either actively waiting to reconnect (timer set) or we've started reconnection attempts
      status = 'reconnecting';
    }
    
    return {
      status,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
    };
  }
  
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    
    this.isIntentionalClose = false;
    this.isAuthenticated = false;
    
    try {
      console.log(`[WebSocket] Connecting to ${this.wsUrl}...`);
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Desktop-Client-Id': this.clientId,
        },
      });
      
      // Emit connecting status now that ws is created
      this.emit('status-change', this.getConnectionInfo());
      
      this.ws.on('open', () => {
        console.log('[WebSocket] Connected, waiting for authentication...');
        this.reconnectAttempt = 0;
        this.lastError = null;
        this.lastConnectedAt = new Date().toISOString();
        this.emit('connected');
        this.emit('status-change', this.getConnectionInfo());
        this.startHeartbeat();
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error);
        }
      });
      
      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || 'Unknown';
        console.log(`[WebSocket] Disconnected: ${code} ${reasonStr}`);
        this.stopHeartbeat();
        this.isAuthenticated = false;
        
        if (!this.isIntentionalClose) {
          this.lastError = `Connection closed: ${code} ${reasonStr}`;
          this.scheduleReconnect();
        } else {
          this.emit('disconnected');
          this.emit('status-change', this.getConnectionInfo());
        }
      });
      
      this.ws.on('error', (error) => {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[WebSocket] Error:', errorMsg);
        this.lastError = errorMsg;
        
        // Don't emit error for expected reconnection scenarios (502, connection refused, etc.)
        // These are normal during server restarts and will be handled by reconnection logic
        const isExpectedError = errorMsg.includes('502') || 
                                errorMsg.includes('503') || 
                                errorMsg.includes('ECONNREFUSED') ||
                                errorMsg.includes('ETIMEDOUT') ||
                                errorMsg.includes('Unexpected server response');
        
        if (!isExpectedError) {
          this.emit('error', error);
        }
        
        // Clean up the WebSocket to ensure we can reconnect
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch (e) {
            // Ignore terminate errors
          }
          this.ws = null;
        }
        
        // Schedule reconnect (close event may not fire on error)
        if (!this.isIntentionalClose && !this.reconnectTimer) {
          this.scheduleReconnect();
        }
      });
      
      // Handle unexpected upgrade errors (like 502 during server restart)
      this.ws.on('unexpected-response', (req, res) => {
        const statusCode = res.statusCode || 'unknown';
        console.log(`[WebSocket] Unexpected response: ${statusCode} (server may be restarting)`);
        this.lastError = `Server unavailable (${statusCode})`;
        
        // Clean up
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch (e) {
            // Ignore
          }
          this.ws = null;
        }
        
        // Schedule reconnect
        if (!this.isIntentionalClose && !this.reconnectTimer) {
          this.scheduleReconnect();
        }
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Connection failed';
      console.error('[WebSocket] Connection error:', errorMsg);
      this.lastError = errorMsg;
      this.scheduleReconnect();
    }
  }
  
  disconnect(): void {
    this.isIntentionalClose = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
  }
  
  subscribeToStation(stationId: string): void {
    this.subscribedStationId = stationId;
    
    if (this.isAuthenticated) {
      this.send({
        type: 'desktop:subscribe_station',
        stationId,
      });
    } else {
      this.pendingStationSubscription = stationId;
      console.log('[WebSocket] Queuing station subscription until authenticated');
    }
  }
  
  unsubscribeFromStation(): void {
    this.pendingStationSubscription = null;
    
    if (this.subscribedStationId) {
      if (this.isAuthenticated) {
        this.send({
          type: 'desktop:unsubscribe_station',
        });
      }
      this.subscribedStationId = null;
    }
  }
  
  sendJobUpdate(jobId: string, status: string, errorMessage?: string): void {
    this.send({
      type: 'desktop:job_status',
      jobId,
      status,
      errorMessage,
    });
  }
  
  private send(message: WebSocketMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
  
  private handleMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case 'desktop:authenticated':
        console.log('[WebSocket] Authenticated');
        this.isAuthenticated = true;
        this.reconnectAttempt = 0;
        this.lastError = null;
        this.emit('authenticated');
        // Emit status-change again now that we're fully authenticated
        this.emit('status-change', this.getConnectionInfo());
        
        if (this.pendingStationSubscription) {
          console.log('[WebSocket] Processing pending station subscription');
          this.send({
            type: 'desktop:subscribe_station',
            stationId: this.pendingStationSubscription,
          });
          this.pendingStationSubscription = null;
        } else if (this.subscribedStationId) {
          console.log('[WebSocket] Resubscribing to station after reconnect');
          this.send({
            type: 'desktop:subscribe_station',
            stationId: this.subscribedStationId,
          });
        }
        break;
        
      case 'desktop:subscribed':
        console.log(`[WebSocket] Subscribed to station ${message.stationId}`);
        this.emit('subscribed', message.stationId);
        break;
        
      case 'desktop:unsubscribed':
        console.log(`[WebSocket] Unsubscribed from station ${message.stationId}`);
        this.emit('unsubscribed', message.stationId);
        break;
        
      case 'desktop:job:new':
        console.log('[WebSocket] New print job received');
        this.emit('job:new', message.job as PrintJob);
        break;
        
      case 'desktop:job:update':
        console.log(`[WebSocket] Job update: ${message.jobId} -> ${message.status}`);
        this.emit('job:update', {
          jobId: message.jobId,
          status: message.status,
        });
        break;
        
      case 'desktop:heartbeat':
        break;
        
      case 'desktop:error':
        console.error('[WebSocket] Server error:', message.error);
        this.emit('server-error', message.error);
        break;
      
      case 'desktop:station:deleted':
        console.log(`[WebSocket] Station ${message.stationId} was deleted, forcing logout`);
        this.subscribedStationId = null;
        this.emit('station-deleted', {
          stationId: message.stationId,
          message: message.message || 'This station has been deleted.',
        });
        break;
        
      case 'desktop:station:updated':
        console.log(`[WebSocket] Station ${message.stationId} was updated`);
        this.emit('station-updated', {
          stationId: message.stationId,
          station: message.station as { id: string; name: string; location: string | null; isActive: boolean },
        });
        break;
        
      default:
        console.log('[WebSocket] Unknown message type:', message.type);
    }
  }
  
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'desktop:heartbeat' });
    }, config.wsHeartbeatInterval);
  }
  
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    
    this.reconnectAttempt++;
    
    // PRODUCTION: Never give up reconnecting - warehouse apps MUST survive server restarts/deployments
    // Exponential backoff with jitter, capped at MAX_RECONNECT_DELAY
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, Math.min(this.reconnectAttempt - 1, 10)) + Math.random() * 1000,
      MAX_RECONNECT_DELAY
    );
    
    console.log(`[WebSocket] Reconnecting in ${Math.round(delay)}ms... (attempt ${this.reconnectAttempt})`);
    
    // Set timer BEFORE emitting status-change so getConnectionInfo() returns 'reconnecting'
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    
    // Emit reconnecting status after timer is set
    this.emit('status-change', this.getConnectionInfo());
  }
  
  resetReconnectAttempts(): void {
    this.reconnectAttempt = 0;
    this.lastError = null;
  }
  
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
