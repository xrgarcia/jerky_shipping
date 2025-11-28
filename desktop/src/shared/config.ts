export const config = {
  serverUrl: process.env.SERVER_URL || 'https://ship.jerky.com',
  wsUrl: process.env.WS_URL || 'wss://ship.jerky.com/ws/desktop',
  
  oauth: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    redirectUri: 'http://localhost:8234/oauth/callback',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  
  tokenRefreshInterval: 60 * 60 * 1000,
  wsReconnectInterval: 5000,
  wsHeartbeatInterval: 30000,
  
  keychainService: 'com.jerkyship.connect',
  keychainAccount: 'api-token',
};
