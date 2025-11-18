/**
 * SkuVault Web Service
 * 
 * Service for SkuVault web interface integration using reverse-engineered web API.
 * Handles authentication via web form login and session data extraction.
 * 
 * Authentication Flow:
 * 1. GET login page at app.skuvault.com/account/login
 * 2. POST credentials to extract sv-t cookie
 * 3. Use sv-t cookie value as Authorization token for API calls to lmdb.skuvault.com
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../utils/queue';
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
 * Redis-based token cache for SkuVault session token
 * Stores sv-t cookie value with 24-hour TTL for persistence across server restarts
 */
class TokenCache {
  private readonly REDIS_KEY = 'skuvault:session:token';
  private readonly TTL_SECONDS = 86400; // 24 hours

  async set(token: string): Promise<void> {
    const redis = getRedisClient();
    await redis.set(this.REDIS_KEY, token, { ex: this.TTL_SECONDS });
  }

  async get(): Promise<string | null> {
    const redis = getRedisClient();
    const token = await redis.get<string>(this.REDIS_KEY);
    return token;
  }

  async clear(): Promise<void> {
    const redis = getRedisClient();
    await redis.del(this.REDIS_KEY);
  }

  async isValid(): Promise<boolean> {
    const token = await this.get();
    return token !== null;
  }
}

/**
 * SkuVault Web Service
 * 
 * Provides methods to interact with SkuVault's web API including:
 * - Authentication via web form login
 * - Fetching wave picking sessions
 * - Auto-retry on authentication errors
 */
export class SkuVaultService {
  private config: SkuVaultConfig;
  private client: AxiosInstance;
  private cookieJar: CookieJar;
  private tokenCache: TokenCache;
  private isAuthenticated: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Load configuration from environment
    this.config = {
      username: process.env.SKUVAULT_USERNAME || '',
      password: process.env.SKUVAULT_PASSWORD || '',
      loginUrl: 'https://app.skuvault.com/account/login',
      apiBaseUrl: 'https://lmdb.skuvault.com',
    };

    // Create cookie jar for maintaining session cookies
    this.cookieJar = new CookieJar();

    // Initialize HTTP client with cookie jar and base headers
    this.client = wrapper(axios.create({
      jar: this.cookieJar,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
    }));

    this.tokenCache = new TokenCache();
  }

  /**
   * Authenticate with SkuVault web interface
   * Performs login via web form and extracts sv-t cookie as Authorization token
   */
  async login(): Promise<boolean> {
    try {
      console.log('[SkuVault] Starting login process...');
      console.log('[SkuVault] Username configured:', !!this.config.username, `(${this.config.username.length} chars)`);
      console.log('[SkuVault] Password configured:', !!this.config.password, `(${this.config.password.length} chars)`);

      // Check if we have a valid cached token
      if (await this.tokenCache.isValid()) {
        console.log('[SkuVault] Using cached token');
        this.isAuthenticated = true;
        return true;
      }

      // Step 1: GET login page to extract any CSRF tokens
      const loginPageResponse = await this.client.get(this.config.loginUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      
      if (loginPageResponse.status !== 200) {
        console.error('[SkuVault] Failed to load login page');
        return false;
      }

      // Step 2: Build form data with credentials
      const formData: Record<string, string> = {
        Email: this.config.username,
        Password: this.config.password,
      };

      // Check for CSRF token in the HTML response
      if (typeof loginPageResponse.data === 'string') {
        const csrfMatch = loginPageResponse.data.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
        if (csrfMatch) {
          formData.__RequestVerificationToken = csrfMatch[1];
          console.log('[SkuVault] Found CSRF token in login form');
        } else {
          console.log('[SkuVault] No CSRF token found in login form');
        }
      }

      const loginData = new URLSearchParams(formData);

      const loginResponse = await this.client.post(
        this.config.loginUrl,
        loginData.toString(),
        {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://app.skuvault.com',
            'Referer': 'https://app.skuvault.com/account/login',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
          },
          maxRedirects: 5,
          validateStatus: (status) => status < 400, // Accept success and redirects
        }
      );

      console.log('[SkuVault] Login response status:', loginResponse.status);
      console.log('[SkuVault] Login response URL:', loginResponse.request?.res?.responseUrl || 'N/A');

      // Check for successful login indicators
      const responseUrl = loginResponse.request?.res?.responseUrl || this.config.loginUrl;
      const responseHtml = typeof loginResponse.data === 'string' ? loginResponse.data : '';
      const hasSuccessfulRedirect = responseUrl.includes('dashboard') || responseUrl.includes('main');
      const hasMountPoint = responseHtml.includes('<div id="mount-point">');
      
      console.log('[SkuVault] Login success indicators:');
      console.log('  - Redirected to dashboard/main:', hasSuccessfulRedirect);
      console.log('  - Has mount-point div:', hasMountPoint);

      if (!hasSuccessfulRedirect && !hasMountPoint) {
        console.error('[SkuVault] Login appears to have failed - no success indicators found');
        // Still try to extract cookies in case the indicators are wrong
      }

      // Step 3: Extract sv-t cookie from CookieJar (not response headers)
      // axios-cookiejar-support stores cookies in the jar and removes them from headers
      let authToken: string | null = null;
      
      try {
        const cookies = await this.cookieJar.getCookies(this.config.loginUrl);
        console.log(`[SkuVault] Found ${cookies.length} cookies in jar`);
        
        for (const cookie of cookies) {
          if (cookie.key === 'sv-t') {
            const tokenValue = cookie.value;
            
            // Validate token is long enough (should be > 100 chars)
            if (tokenValue && tokenValue.length > 100) {
              authToken = tokenValue;
              console.log(`[SkuVault] Extracted sv-t token from jar (${tokenValue.length} chars)`);
              break;
            } else {
              console.warn(`[SkuVault] sv-t cookie found but too short (${tokenValue.length} chars)`);
            }
          }
        }
      } catch (jarError) {
        console.error('[SkuVault] Error reading from cookie jar:', jarError);
      }

      if (!authToken) {
        console.error('[SkuVault] Failed to extract sv-t cookie from cookie jar');
        
        // Check response body for error messages
        const responseText = typeof loginResponse.data === 'string' 
          ? loginResponse.data 
          : JSON.stringify(loginResponse.data);
        
        // Look for validation messages in the HTML
        const validationMatch = responseText.match(/class="validation-summary-errors"[^>]*>(.*?)<\/div>/s);
        const fieldErrorMatch = responseText.match(/class="field-validation-error"[^>]*>(.*?)<\/span>/);
        
        if (validationMatch) {
          console.error('[SkuVault] Validation error found:', validationMatch[1].replace(/<[^>]*>/g, '').trim().substring(0, 200));
        }
        if (fieldErrorMatch) {
          console.error('[SkuVault] Field validation error:', fieldErrorMatch[1].replace(/<[^>]*>/g, '').trim());
        }
        
        // Check for generic error keywords
        if (responseText.includes('error') || responseText.includes('invalid') || responseText.includes('incorrect')) {
          const errorContext = responseText.substring(
            Math.max(0, responseText.toLowerCase().indexOf('error') - 100),
            Math.min(responseText.length, responseText.toLowerCase().indexOf('error') + 200)
          );
          console.error('[SkuVault] Possible error in response:', errorContext.replace(/<[^>]*>/g, '').trim());
        }
        
        return false;
      }

      // Store token and mark as authenticated
      this.tokenCache.set(authToken);
      this.isAuthenticated = true;
      console.log('[SkuVault] Login successful, token cached');
      
      return true;

    } catch (error) {
      console.error('[SkuVault] Login error:', error);
      return false;
    }
  }

  /**
   * Get API headers with authentication and required fields
   */
  private getApiHeaders(): Record<string, string> {
    const token = this.tokenCache.get();
    if (!token) {
      throw new Error('No authentication token available');
    }

    return {
      'Authorization': `Token ${token}`,
      'Partition': 'default',
      'tid': Math.floor(Date.now() / 1000).toString(),
      'idempotency-key': uuidv4(),
      'dataread': 'true',
      'Content-Type': 'application/json',
    };
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
        headers: this.getApiHeaders(),
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
        
        // Retry the request with new token
        const retryResponse = await this.client.request<T>({
          method,
          url,
          data,
          headers: this.getApiHeaders(),
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

    // Wait for initialization if still in progress
    await this.waitForInit();

    // Ensure we're authenticated
    if (!this.isAuthenticated) {
      const loginSuccess = await this.login();
      if (!loginSuccess) {
        throw new Error('Authentication failed');
      }
    }

    try {
      const statesToFetch = states || this.getAllSessionStates();
      
      // Call the sessions API endpoint with correct format
      const url = `${this.config.apiBaseUrl}/wavepicking/get/sessions`;
      const requestData = {
        limit: 100,
        skip: 0,
        userId: '-2', // System-wide identifier for all users
        sort: [{ descending: false, field: 'createdDate' }],
        states: statesToFetch,
        saleId: { match: 'contains', value: '' }, // Empty for all sales
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
    console.log('[SkuVault] Logged out, token cleared');
  }
}

// Export singleton instance
export const skuVaultService = new SkuVaultService();
