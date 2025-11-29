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

export const config = {
  defaultEnvironment: 'production',
  
  oauth: {
    // Desktop app OAuth credentials (injected at build time via environment variables)
    // Get these from Google Cloud Console > APIs & Services > Credentials > Desktop OAuth client
    clientId: process.env.DESKTOP_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.DESKTOP_OAUTH_CLIENT_SECRET || '',
    // Use 127.0.0.1 (loopback) for desktop OAuth - simpler and more reliable
    redirectUri: 'http://127.0.0.1:8234',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  
  tokenRefreshInterval: 60 * 60 * 1000,
  wsReconnectInterval: 5000,
  wsHeartbeatInterval: 30000,
  
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
