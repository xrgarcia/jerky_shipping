export interface Station {
  id: string;
  name: string;
  locationHint: string | null;
  isActive: boolean;
  defaultPrinterId: string | null;
  createdAt: string;
}

export interface Printer {
  id: string;
  name: string;
  systemName: string;
  isDefault: boolean;
  stationId: string | null;
  status: 'online' | 'offline' | 'error';
  lastSeenAt: string | null;
  createdAt: string;
}

export interface StationSession {
  id: string;
  stationId: string;
  userId: string;
  desktopClientId: string;
  startedAt: string;
  expiresAt: string;
  isActive: boolean;
}

export interface PrintJob {
  id: string;
  stationId: string;
  printerId: string | null;
  shipmentId: string;
  orderNumber: string;
  labelUrl: string;
  labelData: string | null;
  // Status lifecycle: pending -> picked_up -> sent -> completed/failed
  // pending: Job created, waiting for desktop to pick up
  // picked_up: Desktop received the job
  // sent: Job sent to printer spooler
  // completed: Print job finished successfully
  // failed: Print job failed (includes error message)
  status: 'pending' | 'picked_up' | 'sent' | 'completed' | 'failed';
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  printedAt: string | null;
  requestedBy: string | null; // Name of user who requested the print
}

export interface DesktopClient {
  id: string;
  userId: string;
  deviceName: string;
  lastActiveAt: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  clientId: string | null;
}

export interface ConnectionInfo {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  reconnectAttempt: number;
  lastError: string | null;
  lastConnectedAt: string | null;
}

export interface AppState {
  auth: AuthState;
  station: Station | null;
  session: StationSession | null;
  printers: Printer[];
  selectedPrinter: Printer | null;
  printersLoaded: boolean; // True after printers have been fetched from server
  printJobs: PrintJob[];
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  connectionInfo: ConnectionInfo;
  environment: string;
}

export interface EnvironmentInfo {
  name: string;
  label: string;
  serverUrl: string;
}

export interface RemoteConfig {
  connectionTimeout: number;
  baseReconnectDelay: number;
  maxReconnectDelay: number;
  heartbeatInterval: number;
  reconnectInterval: number;
  tokenRefreshInterval: number;
  offlineTimeout: number;
  updatedAt?: string;
}

export type IpcChannel = 
  | 'auth:login'
  | 'auth:logout'
  | 'auth:get-state'
  | 'station:list'
  | 'station:claim'
  | 'station:release'
  | 'station:create'
  | 'printer:discover'
  | 'printer:list'
  | 'printer:register'
  | 'printer:set-default'
  | 'print:queue'
  | 'print:status'
  | 'ws:connect'
  | 'ws:disconnect'
  | 'ws:status'
  | 'app:get-state'
  | 'app:get-config'
  | 'app:state-changed'
  | 'env:list'
  | 'env:get'
  | 'env:set';

export interface IpcRequest<T = unknown> {
  channel: IpcChannel;
  data?: T;
}

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
