import oauthCredentials from './oauth-credentials.json';

export interface Environment {
  name: string;
  label: string;
  serverUrl: string;
  wsUrl: string;
}

export const environments: Environment[] = [
  {
    name: 'production',
    label: 'Production',
    serverUrl: 'https://ship.jerky.com',
    wsUrl: 'wss://ship.jerky.com/ws/desktop',
  },
  {
    name: 'development',
    label: 'Development',
    serverUrl: process.env.DEV_SERVER_URL || 'https://1f8cebf8-fa54-4dcf-bc3c-deca6dff5a67-00-29c45pwlm2dgg.janeway.replit.dev',
    wsUrl: process.env.DEV_WS_URL || 'wss://1f8cebf8-fa54-4dcf-bc3c-deca6dff5a67-00-29c45pwlm2dgg.janeway.replit.dev/ws/desktop',
  },
];

export const getEnvironment = (name: string): Environment => {
  return environments.find(e => e.name === name) || environments[0];
};

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

const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
  connectionTimeout: 15000,
  baseReconnectDelay: 2000,
  maxReconnectDelay: 30000,
  heartbeatInterval: 30000,
  reconnectInterval: 5000,
  tokenRefreshInterval: 3600000,
  offlineTimeout: 1000,
};

const MIN_VALUES: RemoteConfig = {
  connectionTimeout: 5000,
  baseReconnectDelay: 1000,
  maxReconnectDelay: 5000,
  heartbeatInterval: 10000,
  reconnectInterval: 1000,
  tokenRefreshInterval: 300000,
  offlineTimeout: 500,
};

function clampConfig(config: Partial<RemoteConfig>): Partial<RemoteConfig> {
  const clamped: Partial<RemoteConfig> = {};
  
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'number' && key in MIN_VALUES) {
      const minValue = MIN_VALUES[key as keyof RemoteConfig];
      if (typeof minValue === 'number') {
        clamped[key as keyof RemoteConfig] = Math.max(value, minValue) as any;
        if (value < minValue) {
          console.warn(`[RuntimeConfig] Clamping ${key} from ${value} to minimum ${minValue}`);
        }
      }
    } else {
      (clamped as any)[key] = value;
    }
  }
  
  return clamped;
}

class RuntimeConfig {
  private _remoteConfig: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG };
  private _listeners: Array<(config: RemoteConfig) => void> = [];
  
  get remoteConfig(): RemoteConfig {
    return { ...this._remoteConfig };
  }
  
  get connectionTimeout(): number {
    return this._remoteConfig.connectionTimeout;
  }
  
  get baseReconnectDelay(): number {
    return this._remoteConfig.baseReconnectDelay;
  }
  
  get maxReconnectDelay(): number {
    return this._remoteConfig.maxReconnectDelay;
  }
  
  get heartbeatInterval(): number {
    return this._remoteConfig.heartbeatInterval;
  }
  
  get reconnectInterval(): number {
    return this._remoteConfig.reconnectInterval;
  }
  
  get tokenRefreshInterval(): number {
    return this._remoteConfig.tokenRefreshInterval;
  }
  
  get offlineTimeout(): number {
    return this._remoteConfig.offlineTimeout;
  }
  
  updateFromRemote(config: Partial<RemoteConfig>): void {
    const clampedConfig = clampConfig(config);
    const oldConfig = { ...this._remoteConfig };
    this._remoteConfig = { ...this._remoteConfig, ...clampedConfig };
    
    console.log('[RuntimeConfig] Updated from remote (clamped):', clampedConfig);
    console.log('[RuntimeConfig] New config:', this._remoteConfig);
    
    this._listeners.forEach(listener => {
      try {
        listener(this._remoteConfig);
      } catch (error) {
        console.error('[RuntimeConfig] Listener error:', error);
      }
    });
  }
  
  onUpdate(listener: (config: RemoteConfig) => void): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener);
    };
  }
  
  reset(): void {
    this._remoteConfig = { ...DEFAULT_REMOTE_CONFIG };
    console.log('[RuntimeConfig] Reset to defaults');
  }
}

export const runtimeConfig = new RuntimeConfig();

export const config = {
  defaultEnvironment: 'production',
  
  oauth: {
    clientId: oauthCredentials.clientId,
    clientSecret: oauthCredentials.clientSecret,
    redirectUri: 'http://127.0.0.1:8234',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  
  get tokenRefreshInterval(): number {
    return runtimeConfig.tokenRefreshInterval;
  },
  get wsReconnectInterval(): number {
    return runtimeConfig.reconnectInterval;
  },
  get wsHeartbeatInterval(): number {
    return runtimeConfig.heartbeatInterval;
  },
  
  keychainService: 'com.jerkyship.connect',
  keychainAccount: 'api-token',
  settingsAccount: 'app-settings',
};

export const getCurrentServerUrl = (envName: string): string => {
  return getEnvironment(envName).serverUrl;
};

export const getCurrentWsUrl = (envName: string): string => {
  return getEnvironment(envName).wsUrl;
};

export async function fetchRemoteConfig(serverUrl: string, token: string): Promise<RemoteConfig | null> {
  try {
    console.log('[RemoteConfig] Fetching from server...');
    const response = await fetch(`${serverUrl}/api/desktop/config`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    
    if (!response.ok) {
      console.error('[RemoteConfig] Fetch failed:', response.status, response.statusText);
      return null;
    }
    
    const data = await response.json() as RemoteConfig;
    console.log('[RemoteConfig] Received:', data);
    return data;
  } catch (error) {
    console.error('[RemoteConfig] Fetch error:', error);
    return null;
  }
}
