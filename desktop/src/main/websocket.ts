import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../shared/config';
import type { PrintJob } from '../shared/types';

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

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
  
  constructor(token: string, clientId: string, wsUrl: string) {
    super();
    this.token = token;
    this.clientId = clientId;
    this.wsUrl = wsUrl;
  }
  
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    
    this.isIntentionalClose = false;
    this.isAuthenticated = false;
    
    try {
      this.ws = new WebSocket(this.wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Desktop-Client-Id': this.clientId,
        },
      });
      
      this.ws.on('open', () => {
        console.log('[WebSocket] Connected, waiting for authentication...');
        this.emit('connected');
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
        console.log(`[WebSocket] Disconnected: ${code} ${reason}`);
        this.stopHeartbeat();
        this.emit('disconnected');
        
        if (!this.isIntentionalClose) {
          this.scheduleReconnect();
        }
      });
      
      this.ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error);
        this.emit('error', error);
      });
    } catch (error) {
      console.error('[WebSocket] Connection error:', error);
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
        this.emit('authenticated');
        
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
    console.log(`[WebSocket] Reconnecting in ${config.wsReconnectInterval}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, config.wsReconnectInterval);
  }
  
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
