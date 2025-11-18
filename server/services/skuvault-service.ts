/**
 * SkuVault Web Service
 * 
 * Service for SkuVault web interface integration using discovered API endpoints.
 * Handles authentication, token management, and session data extraction.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { parse } from 'node-html-parser';
import { 
  sessionsResponseSchema,
  parseSessionState,
  type SessionsResponse, 
  type ParsedSession, 
  type SessionData,
  SessionState 
} from '@shared/skuvault-types';

interface SkuVaultConfig {
  username: string;
  password: string;
  loginUrl: string;
  apiBaseUrl: string;
}

/**
 * In-memory token cache
 */
class TokenCache {
  private token: string | null = null;
  private lastRefresh: number = 0;
  private readonly TTL_MS = 3600000; // 1 hour

  set(token: string): void {
    this.token = token;
    this.lastRefresh = Date.now();
  }

  get(): string | null {
    if (!this.token) return null;
    
    // Check if token has expired
    if (Date.now() - this.lastRefresh > this.TTL_MS) {
      this.token = null;
      return null;
    }
    
    return this.token;
  }

  clear(): void {
    this.token = null;
    this.lastRefresh = 0;
  }

  isValid(): boolean {
    return this.get() !== null;
  }
}

/**
 * SkuVault Web Service
 * 
 * Provides methods to interact with SkuVault's web API including:
 * - Authentication and session management
 * - Fetching wave picking sessions
 * - Auto-retry on authentication errors
 */
export class SkuVaultService {
  private config: SkuVaultConfig;
  private client: AxiosInstance;
  private tokenCache: TokenCache;
  private isAuthenticated: boolean = false;

  constructor() {
    // Load configuration from environment
    this.config = {
      username: process.env.SKUVAULT_USERNAME || '',
      password: process.env.SKUVAULT_PASSWORD || '',
      loginUrl: 'https://app.skuvault.com/Account/Login',
      apiBaseUrl: 'https://api-wave.skuvault.com',
    };

    // Initialize HTTP client
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      withCredentials: true,
    });

    this.tokenCache = new TokenCache();
  }

  /**
   * Authenticate with SkuVault web interface
   * Performs login and extracts auth token from cookies
   */
  async login(): Promise<boolean> {
    try {
      console.log('[SkuVault] Starting login process...');

      // Check if we have a valid cached token
      if (this.tokenCache.isValid()) {
        console.log('[SkuVault] Using cached token');
        this.isAuthenticated = true;
        return true;
      }

      // Step 1: Get login page to extract form data
      const loginPageResponse = await this.client.get(this.config.loginUrl);
      
      if (loginPageResponse.status !== 200) {
        console.error('[SkuVault] Failed to load login page');
        return false;
      }

      // Step 2: Parse login form
      const html = parse(loginPageResponse.data);
      const form = html.querySelector('form');

      if (!form) {
        console.error('[SkuVault] Login form not found on page');
        return false;
      }

      // Step 3: Submit login credentials
      const loginData = new URLSearchParams({
        Email: this.config.username,
        Password: this.config.password,
      });

      const loginResponse = await this.client.post(
        this.config.loginUrl,
        loginData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          maxRedirects: 0,
          validateStatus: (status) => status < 400, // Accept redirects
        }
      );

      // Step 4: Extract auth token from cookies
      const cookies = loginResponse.headers['set-cookie'] || [];
      let authToken: string | null = null;

      for (const cookie of cookies) {
        // Look for .AspNetCore.Cookies or similar auth cookie
        if (cookie.includes('.AspNetCore.Cookies') || cookie.includes('AuthToken')) {
          const match = cookie.match(/([^=]+)=([^;]+)/);
          if (match) {
            authToken = match[2];
            break;
          }
        }
      }

      if (authToken) {
        this.tokenCache.set(authToken);
        this.isAuthenticated = true;
        console.log('[SkuVault] Login successful, token cached');
        
        // Set auth cookie for subsequent requests
        this.client.defaults.headers.common['Cookie'] = cookies.join('; ');
        return true;
      }

      // If no explicit auth token, check if login succeeded by response
      if (loginResponse.status >= 200 && loginResponse.status < 400) {
        // Store all cookies
        this.client.defaults.headers.common['Cookie'] = cookies.join('; ');
        this.isAuthenticated = true;
        console.log('[SkuVault] Login successful (session-based)');
        return true;
      }

      console.error('[SkuVault] Failed to extract auth token from login response');
      return false;

    } catch (error) {
      console.error('[SkuVault] Login error:', error);
      return false;
    }
  }

  /**
   * Make authenticated request with auto-retry on 401
   */
  private async makeAuthenticatedRequest<T>(
    method: 'GET' | 'POST',
    url: string,
    data?: any
  ): Promise<T> {
    try {
      const response = await this.client.request<T>({
        method,
        url,
        data,
      });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      
      // If 401, clear token and retry once with re-authentication
      if (axiosError.response?.status === 401) {
        console.log('[SkuVault] Received 401, re-authenticating...');
        this.tokenCache.clear();
        this.isAuthenticated = false;
        
        const loginSuccess = await this.login();
        if (!loginSuccess) {
          throw new Error('Re-authentication failed');
        }
        
        // Retry the request
        const retryResponse = await this.client.request<T>({
          method,
          url,
          data,
        });
        return retryResponse.data;
      }
      
      throw error;
    }
  }

  /**
   * Get all valid session states
   */
  private getAllSessionStates(): string[] {
    return Object.values(SessionState);
  }

  /**
   * Fetch wave picking sessions from SkuVault
   * 
   * @param states - Optional array of session states to filter by
   * @returns Array of parsed sessions
   */
  async getSessions(states?: SessionState[]): Promise<ParsedSession[]> {
    // Check credentials before attempting to authenticate
    if (!this.config.username || !this.config.password) {
      throw new Error('SKUVAULT_USERNAME and SKUVAULT_PASSWORD environment variables are required');
    }

    // Ensure we're authenticated
    if (!this.isAuthenticated) {
      const loginSuccess = await this.login();
      if (!loginSuccess) {
        throw new Error('Authentication failed');
      }
    }

    try {
      const statesToFetch = states || this.getAllSessionStates();
      
      // Call the sessions API endpoint
      const url = `${this.config.apiBaseUrl}/picklist/lists`;
      const requestData = {
        states: statesToFetch,
      };

      console.log('[SkuVault] Fetching sessions with states:', statesToFetch);

      const response = await this.makeAuthenticatedRequest<any>(
        'POST',
        url,
        requestData
      );

      // Validate response with Zod schema
      const validatedResponse = sessionsResponseSchema.parse(response);

      // Parse and transform sessions
      const sessions = validatedResponse.lists || [];
      const parsed = sessions.map(session => this.parseSession(session));

      console.log(`[SkuVault] Successfully fetched ${parsed.length} sessions`);
      return parsed;

    } catch (error) {
      console.error('[SkuVault] Error fetching sessions:', error);
      throw error;
    }
  }

  /**
   * Parse raw session data into simplified format
   */
  private parseSession(session: SessionData): ParsedSession {
    const extractedAt = Date.now() / 1000; // Unix timestamp

    return {
      sessionId: session.sequenceId || null,
      picklistId: session.picklistId || null,
      status: parseSessionState(session.state),
      createdDate: session.date || null,
      assignedUser: session.assigned?.name || null,
      userId: session.assigned?.userId || null,
      skuCount: session.skuCount || null,
      orderCount: session.orderCount || null,
      totalQuantity: session.totalQuantity || null,
      pickedQuantity: session.pickedQuantity || null,
      availableQuantity: session.availableQuantity || null,
      totalWeight: session.totalItemsWeight || null,
      viewUrl: session.picklistId 
        ? `https://app.skuvault.com/WavePicking/Picklist/${session.picklistId}`
        : null,
      extractedAt: extractedAt,
    };
  }

  /**
   * Logout and clear session
   */
  logout(): void {
    this.tokenCache.clear();
    this.isAuthenticated = false;
    delete this.client.defaults.headers.common['Cookie'];
    console.log('[SkuVault] Logged out, token cleared');
  }
}

// Export singleton instance
export const skuVaultService = new SkuVaultService();
