import { shell } from 'electron';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import os from 'os';
import { config, getEnvironment } from '../shared/config';
import type { User } from '../shared/types';

interface SavedAuth {
  token: string;
  clientId: string;
  serverUrl: string;
  environment?: string;
}

interface AuthResult {
  token: string;
  clientId: string;
  user: User;
  serverUrl: string;
  environment: string;
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function httpRequest(
  url: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            json: () => Promise.resolve(JSON.parse(data)),
          });
        });
      }
    );
    
    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export class AuthService {
  private store: Map<string, string> = new Map();
  
  constructor() {}
  
  getServerUrl(envName: string): string {
    return getEnvironment(envName).serverUrl;
  }
  
  async loadSavedAuth(): Promise<SavedAuth | null> {
    try {
      const keytar = await import('keytar');
      const tokenJson = await keytar.getPassword(
        config.keychainService,
        config.keychainAccount
      );
      
      if (!tokenJson) return null;
      
      const saved = JSON.parse(tokenJson) as SavedAuth;
      return saved;
    } catch (error) {
      console.error('Failed to load saved auth:', error);
      return null;
    }
  }
  
  async saveAuth(auth: SavedAuth): Promise<void> {
    try {
      const keytar = await import('keytar');
      await keytar.setPassword(
        config.keychainService,
        config.keychainAccount,
        JSON.stringify(auth)
      );
      console.log('[Auth] Saved authentication to keychain');
    } catch (error) {
      console.error('Failed to save auth to keychain:', error);
      this.store.set('auth', JSON.stringify(auth));
    }
  }
  
  async clearAuth(): Promise<void> {
    try {
      const keytar = await import('keytar');
      await keytar.deletePassword(config.keychainService, config.keychainAccount);
      console.log('[Auth] Cleared authentication from keychain');
    } catch (error) {
      console.error('Failed to clear auth:', error);
    }
    this.store.delete('auth');
  }
  
  async login(envName: string): Promise<AuthResult> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();
    const serverUrl = this.getServerUrl(envName);
    
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://localhost:8234`);
        
        if (url.pathname === '/oauth/callback') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');
          
          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>');
            server.close();
            reject(new Error(error));
            return;
          }
          
          if (returnedState !== state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Security Error</h1><p>State mismatch. Please try again.</p></body></html>');
            server.close();
            reject(new Error('State mismatch'));
            return;
          }
          
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
            server.close();
            reject(new Error('No authorization code'));
            return;
          }
          
          try {
            console.log('[Auth] Exchanging authorization code for token...');
            
            const tokenBody = new URLSearchParams({
              client_id: config.oauth.clientId,
              code,
              code_verifier: codeVerifier,
              grant_type: 'authorization_code',
              redirect_uri: config.oauth.redirectUri,
            }).toString();
            
            const tokenResponse = await httpRequest(config.oauth.tokenUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: tokenBody,
            });
            
            if (!tokenResponse.ok) {
              const errorData = await tokenResponse.json() as { error?: string };
              throw new Error(`Token exchange failed: ${errorData.error || tokenResponse.status}`);
            }
            
            const tokenData = await tokenResponse.json() as { id_token: string };
            const idToken = tokenData.id_token;
            
            console.log('[Auth] Token received, registering desktop client...');
            
            const registrationResponse = await httpRequest(
              `${serverUrl}/api/desktop/clients/register`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${idToken}`,
                },
                body: JSON.stringify({
                  machineId: this.getMachineId(),
                  machineName: os.hostname(),
                }),
              }
            );
            
            if (!registrationResponse.ok) {
              const errorData = await registrationResponse.json() as { error?: string };
              throw new Error(errorData.error || 'Registration failed');
            }
            
            const registration = await registrationResponse.json() as {
              id: string;
              apiToken: string;
              user: User;
            };
            
            const authResult: AuthResult = {
              token: registration.apiToken,
              clientId: registration.id,
              user: registration.user,
              serverUrl: serverUrl,
              environment: envName,
            };
            
            await this.saveAuth({
              token: authResult.token,
              clientId: authResult.clientId,
              serverUrl: serverUrl,
              environment: envName,
            });
            
            console.log('[Auth] Desktop client registered successfully');
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <head>
                  <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
                           background: #1a1a1a; color: #fff; 
                           display: flex; justify-content: center; align-items: center; 
                           height: 100vh; margin: 0; }
                    .container { text-align: center; }
                    h1 { color: #f07428; }
                    p { color: #999; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <h1>Successfully Signed In!</h1>
                    <p>Welcome, ${authResult.user.displayName}. You can close this window.</p>
                  </div>
                </body>
              </html>
            `);
            
            server.close();
            resolve(authResult);
          } catch (err) {
            console.error('[Auth] Login failed:', err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1><p>Authentication failed. Please try again.</p></body></html>');
            server.close();
            reject(err);
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      
      server.listen(8234, 'localhost', () => {
        const authUrl = new URL(config.oauth.authUrl);
        authUrl.searchParams.set('client_id', config.oauth.clientId);
        authUrl.searchParams.set('redirect_uri', config.oauth.redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', config.oauth.scope);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('hd', 'jerky.com');
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        
        console.log('[Auth] Opening browser for OAuth...');
        shell.openExternal(authUrl.toString());
      });
      
      server.on('error', (err) => {
        console.error('[Auth] Server error:', err);
        reject(err);
      });
      
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timeout'));
      }, 120000);
    });
  }
  
  private getMachineId(): string {
    const networkInterfaces = os.networkInterfaces();
    let macAddress = '';
    
    for (const name of Object.keys(networkInterfaces)) {
      const nets = networkInterfaces[name];
      if (nets) {
        for (const net of nets) {
          if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
            macAddress = net.mac;
            break;
          }
        }
      }
      if (macAddress) break;
    }
    
    const machineInfo = `${os.hostname()}-${macAddress || os.platform()}`;
    return crypto.createHash('sha256').update(machineInfo).digest('hex').slice(0, 32);
  }
}
