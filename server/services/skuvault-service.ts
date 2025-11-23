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
  SessionState,
  type SessionFilters,
  MatchType,
  productLookupResponseSchema,
  type ProductLookupResponse,
  type QCPassItemRequest,
  qcPassItemResponseSchema,
  type QCPassItemResponse,
  saleInformationResponseSchema,
  type SaleInformation,
  type SaleInformationResponse,
  pickedQuantityResponseSchema,
  type PickedQuantityResponse
} from '@shared/skuvault-types';

interface SkuVaultConfig {
  username: string;
  password: string;
  loginUrl: string;
  apiBaseUrl: string;
}

/**
 * Custom error class for SkuVault API errors
 * Preserves detailed error messages from SkuVault for display in UI
 */
export class SkuVaultError extends Error {
  constructor(
    message: string,
    public statusCode: number = 401,
    public details?: any
  ) {
    super(message);
    this.name = 'SkuVaultError';
  }
}

/**
 * Redis-based token cache for SkuVault session token
 * Stores sv-t cookie value with 24-hour TTL for persistence across server restarts
 * Tracks last refresh timestamp for monitoring
 * Gracefully degrades if Redis is unavailable (forces re-login)
 */
class TokenCache {
  private readonly REDIS_KEY = 'skuvault:session:token';
  private readonly TIMESTAMP_KEY = 'skuvault:session:token:timestamp';
  private readonly TTL_SECONDS = 86400; // 24 hours

  async set(token: string): Promise<void> {
    try {
      const redis = getRedisClient();
      const now = new Date().toISOString();
      
      // Store token and timestamp atomically
      await redis.set(this.REDIS_KEY, token, { ex: this.TTL_SECONDS });
      await redis.set(this.TIMESTAMP_KEY, now, { ex: this.TTL_SECONDS });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for token cache (token will not persist): ${errorMsg}`);
      // Graceful degradation: continue without caching
    }
  }

  async get(): Promise<string | null> {
    try {
      const redis = getRedisClient();
      const token = await redis.get<string>(this.REDIS_KEY);
      return token;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for token cache (forcing re-authentication): ${errorMsg}`);
      return null; // Force re-authentication
    }
  }

  async getLastRefreshed(): Promise<string | null> {
    try {
      const redis = getRedisClient();
      const timestamp = await redis.get<string>(this.TIMESTAMP_KEY);
      return timestamp;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for timestamp retrieval: ${errorMsg}`);
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(this.REDIS_KEY);
      await redis.del(this.TIMESTAMP_KEY);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for token cache clear: ${errorMsg}`);
      // Graceful degradation: continue without clearing
    }
  }

  async isValid(): Promise<boolean> {
    const token = await this.get();
    return token !== null;
  }
}

/**
 * Redis-based lockout cache for SkuVault account lockouts
 * Stores lockout end timestamp when account is temporarily locked
 * Gracefully degrades if Redis is unavailable (assumes no lockout)
 */
class LockoutCache {
  private readonly REDIS_KEY = 'skuvault:lockout:endtime';

  async setLockout(durationMinutes: number): Promise<void> {
    try {
      const redis = getRedisClient();
      const endTime = Date.now() + (durationMinutes * 60 * 1000);
      const ttlSeconds = durationMinutes * 60;
      
      await redis.set(this.REDIS_KEY, endTime.toString(), { ex: ttlSeconds });
      console.log(`[SkuVault] Lockout set for ${durationMinutes} minutes (until ${new Date(endTime).toISOString()})`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for lockout cache (lockout will not persist): ${errorMsg}`);
      // Graceful degradation: continue without storing lockout
    }
  }

  async getLockoutEndTime(): Promise<number | null> {
    try {
      const redis = getRedisClient();
      const endTimeStr = await redis.get<string>(this.REDIS_KEY);
      if (!endTimeStr) return null;
      
      const endTime = parseInt(endTimeStr, 10);
      // If lockout has expired, return null
      if (endTime <= Date.now()) {
        await this.clear();
        return null;
      }
      
      return endTime;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for lockout cache (assuming no lockout): ${errorMsg}`);
      return null; // Assume no lockout (degraded but functional)
    }
  }

  async getRemainingSeconds(): Promise<number> {
    const endTime = await this.getLockoutEndTime();
    if (!endTime) return 0;
    
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  async isLockedOut(): Promise<boolean> {
    const endTime = await this.getLockoutEndTime();
    // getLockoutEndTime() already returns null for expired lockouts
    return endTime !== null;
  }

  async clear(): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(this.REDIS_KEY);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[SkuVault] Redis unavailable for lockout cache clear: ${errorMsg}`);
      // Graceful degradation: continue without clearing
    }
  }
}

/**
 * Parse SkuVault error message to detect and extract lockout duration
 * Returns duration in minutes, or null if no lockout detected
 */
function parseLockoutDuration(errorText: string): number | null {
  // Regex pattern to match both "minutes", "minute", and "minute(s)"
  const minutePattern = /minute(?:s|\(s\))?/i;
  
  // Try various patterns to extract the lockout duration
  
  // Pattern 1: "locked for the next X minutes/minute(s)"
  let match = errorText.match(new RegExp(`locked.*?next\\s+(\\d+)\\s+${minutePattern.source}`, 'i'));
  if (match) {
    return parseInt(match[1], 10);
  }
  
  // Pattern 2: "locked for X minutes/minute(s)" (without "next")
  match = errorText.match(new RegExp(`locked.*?for\\s+(\\d+)\\s+${minutePattern.source}`, 'i'));
  if (match) {
    return parseInt(match[1], 10);
  }
  
  // Pattern 3: "try again in X minutes/minute(s)"
  match = errorText.match(new RegExp(`try\\s+again.*?in\\s+(\\d+)\\s+${minutePattern.source}`, 'i'));
  if (match) {
    return parseInt(match[1], 10);
  }
  
  // Pattern 4: "wait X minutes/minute(s)"
  match = errorText.match(new RegExp(`wait\\s+(\\d+)\\s+${minutePattern.source}`, 'i'));
  if (match) {
    return parseInt(match[1], 10);
  }
  
  // Pattern 5: "locked out for X minute(s)"
  match = errorText.match(new RegExp(`locked\\s+out.*?for\\s+(\\d+)\\s+${minutePattern.source}`, 'i'));
  if (match) {
    return parseInt(match[1], 10);
  }
  
  // Fallback: Look for "temporarily locked" or "account is locked" without explicit duration
  if (errorText.match(/temporarily\s+locked/i) || errorText.match(/account\s+(is\s+)?locked/i)) {
    console.log('[SkuVault] Generic lockout message detected, assuming 30 minutes');
    return 30;
  }
  
  return null;
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
  private lockoutCache: LockoutCache;
  private isAuthenticated: boolean = false;
  private lastRequestTime: number = 0;
  private readonly RATE_LIMIT_DELAY_MS = 2000; // 2 seconds between requests
  private loginMutex: Promise<boolean> | null = null; // Prevent concurrent login attempts

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
    this.lockoutCache = new LockoutCache();
  }

  /**
   * Apply rate limiting to prevent triggering anti-bot protection
   * Ensures minimum 2-second delay between API requests
   */
  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.RATE_LIMIT_DELAY_MS) {
      const delayNeeded = this.RATE_LIMIT_DELAY_MS - timeSinceLastRequest;
      console.log(`[SkuVault] Rate limiting: waiting ${delayNeeded}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, delayNeeded));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Initialize authentication on server startup
   * Checks Redis for valid token and auto-authenticates if needed
   * Should be called once when server starts
   */
  async initializeAuthentication(): Promise<void> {
    try {
      console.log('[SkuVault] Initializing authentication...');
      
      // Always check if we have a valid cached token (even if credentials missing)
      if (await this.tokenCache.isValid()) {
        console.log('[SkuVault] Found valid token in Redis, marking as authenticated');
        this.isAuthenticated = true;
        return;
      }

      // Check if credentials are configured before attempting login
      if (!this.config.username || !this.config.password) {
        console.warn('[SkuVault] No cached token and credentials not configured, authentication will be required on first request');
        return;
      }

      // No valid token, perform initial login
      console.log('[SkuVault] No valid token found, performing initial login...');
      await this.ensureAuthenticated();
      console.log('[SkuVault] Authentication initialization complete');
    } catch (error) {
      console.error('[SkuVault] Failed to initialize authentication:', error);
      // Don't throw - let individual requests handle re-authentication
    }
  }

  /**
   * Ensure we're authenticated, with mutex protection to prevent concurrent logins
   * Automatically called by service methods before making API requests
   */
  private async ensureAuthenticated(): Promise<void> {
    // Check credentials before attempting authentication
    if (!this.config.username || !this.config.password) {
      throw new Error('SKUVAULT_USERNAME and SKUVAULT_PASSWORD environment variables are required');
    }

    // If already authenticated, we're good
    if (this.isAuthenticated) {
      return;
    }

    // If there's already a login in progress, wait for it
    if (this.loginMutex) {
      console.log('[SkuVault] Login already in progress, waiting...');
      await this.loginMutex;
      return;
    }

    // Start login and store the promise
    this.loginMutex = this.login();
    
    try {
      const success = await this.loginMutex;
      if (!success) {
        throw new Error('Authentication failed');
      }
    } finally {
      // Clear the mutex
      this.loginMutex = null;
    }
  }

  /**
   * Authenticate with SkuVault web interface
   * Performs login via web form and extracts sv-t cookie as Authorization token
   */
  async login(): Promise<boolean> {
    try {
      console.log('[SkuVault] Starting login process...');

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
        throw new SkuVaultError(
          'Failed to load SkuVault login page. Please try again later.',
          503
        );
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
        const validationMatch = responseText.match(/class="validation-summary-errors"[^>]*>([\s\S]*?)<\/div>/);
        const fieldErrorMatch = responseText.match(/class="field-validation-error"[^>]*>(.*?)<\/span>/);
        
        let errorMessage = '';
        
        if (validationMatch) {
          errorMessage = validationMatch[1].replace(/<[^>]*>/g, '').trim();
          console.error('[SkuVault] Validation error found:', errorMessage.substring(0, 200));
        }
        if (fieldErrorMatch) {
          const fieldError = fieldErrorMatch[1].replace(/<[^>]*>/g, '').trim();
          errorMessage = errorMessage || fieldError;
          console.error('[SkuVault] Field validation error:', fieldError);
        }
        
        // Check for lockout and parse duration
        const lockoutDuration = parseLockoutDuration(errorMessage || responseText);
        if (lockoutDuration) {
          await this.lockoutCache.setLockout(lockoutDuration);
          console.log(`[SkuVault] Account locked out for ${lockoutDuration} minutes`);
          throw new SkuVaultError(
            errorMessage || `Account locked out for ${lockoutDuration} minutes. Please try again later.`,
            429,
            { lockoutMinutes: lockoutDuration }
          );
        }
        
        // Check for generic error keywords
        if (responseText.includes('error') || responseText.includes('invalid') || responseText.includes('incorrect')) {
          const errorContext = responseText.substring(
            Math.max(0, responseText.toLowerCase().indexOf('error') - 100),
            Math.min(responseText.length, responseText.toLowerCase().indexOf('error') + 200)
          );
          console.error('[SkuVault] Possible error in response:', errorContext.replace(/<[^>]*>/g, '').trim());
        }
        
        // Throw error with the parsed message or a generic one
        throw new SkuVaultError(
          errorMessage || 'Failed to authenticate with SkuVault. Please check your credentials.',
          401
        );
      }

      // Store token and mark as authenticated
      await this.tokenCache.set(authToken);
      this.isAuthenticated = true;
      console.log('[SkuVault] Login successful, token cached in Redis');
      
      return true;

    } catch (error) {
      // Re-throw SkuVaultError instances as-is to preserve detailed error messages
      if (error instanceof SkuVaultError) {
        throw error;
      }
      
      // Wrap other errors in SkuVaultError
      console.error('[SkuVault] Login error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error during login';
      throw new SkuVaultError(
        `Login failed: ${message}`,
        500
      );
    }
  }

  /**
   * Get API headers with authentication and required fields
   */
  private async getApiHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenCache.get();
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
   * Applies rate limiting before each request to prevent triggering anti-bot protection
   */
  private async makeAuthenticatedRequest<T>(
    method: 'GET' | 'POST',
    url: string,
    data?: any
  ): Promise<T> {
    // Apply rate limiting before request
    await this.applyRateLimit();
    
    try {
      const headers = await this.getApiHeaders();
      const response = await this.client.request<T>({
        method,
        url,
        data,
        headers,
      });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      
      // If 401, clear token and retry once with re-authentication (using mutex)
      if (axiosError.response?.status === 401) {
        console.log('[SkuVault] Received 401, re-authenticating...');
        await this.tokenCache.clear();
        this.isAuthenticated = false;
        
        // Use ensureAuthenticated to benefit from mutex protection
        await this.ensureAuthenticated();
        
        // Retry the request with new token (rate limiting already applied above)
        const retryHeaders = await this.getApiHeaders();
        const retryResponse = await this.client.request<T>({
          method,
          url,
          data,
          headers: retryHeaders,
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
   * Fetch wave picking sessions from SkuVault with search, filter, sort, and pagination
   * 
   * @param filters - Optional search and filter parameters
   * @returns Array of parsed sessions
   */
  async getSessions(filters?: SessionFilters): Promise<ParsedSession[]> {
    // Ensure we're authenticated (automatically handled by initialization on startup)
    await this.ensureAuthenticated();

    try {
      // Build base payload with defaults
      const statesToFetch = filters?.states || this.getAllSessionStates();
      const limit = filters?.limit || 100;
      const skip = filters?.skip || 0;
      const sortDescending = filters?.sortDescending ?? false;
      
      // Call the sessions API endpoint with correct format
      const url = `${this.config.apiBaseUrl}/wavepicking/get/sessions`;
      const requestData: any = {
        limit,
        skip,
        userId: '-2', // System-wide identifier for all users
        sort: [{ descending: sortDescending, field: 'createdDate' }],
        states: statesToFetch,
      };

      // Add optional search filters if provided
      if (filters?.sessionId) {
        requestData.sequenceId = { 
          match: MatchType.EXACT, 
          value: filters.sessionId.toString() 
        };
      }

      if (filters?.picklistId) {
        requestData.picklistId = { 
          match: MatchType.CONTAINS, 
          value: filters.picklistId 
        };
      }

      if (filters?.orderNumber) {
        // Order numbers are embedded in saleId field
        requestData.saleId = { 
          match: MatchType.CONTAINS, 
          value: filters.orderNumber 
        };
      }

      console.log('[SkuVault] Fetching sessions with filters:', JSON.stringify(filters, null, 2));
      console.log('[SkuVault] Request payload to SkuVault API:', JSON.stringify(requestData, null, 2));

      const response = await this.makeAuthenticatedRequest<any>(
        'POST',
        url,
        requestData
      );

      // Validate response with Zod schema
      const validatedResponse = sessionsResponseSchema.parse(response);

      // Parse and transform sessions
      const sessions = validatedResponse.lists || [];
      
      // Log response details for debugging
      console.log(`[SkuVault] Successfully fetched ${sessions.length} sessions`);
      if (sessions.length > 0 && filters?.orderNumber) {
        console.log('[SkuVault] Session match details for order search:');
        sessions.forEach((session: any) => {
          // Log the entire session object to see all fields returned by SkuVault
          console.log(`  - Session ${session.sequenceId}:`, JSON.stringify(session, null, 2));
        });
      }
      
      const parsed = sessions.map(session => this.parseSession(session));
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
      userId: session.assigned?.userId?.toString() || null,
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
   * Get detailed picklist directions for a specific session
   * Fetches comprehensive picking information including orders, items, locations, and history
   * 
   * @param picklistId - The picklist ID to fetch directions for
   * @returns DirectionsResponse with picklist info, directions, and history
   */
  async getSessionDirections(picklistId: string): Promise<any> {
    // Ensure we're authenticated (automatically handled by initialization on startup)
    await this.ensureAuthenticated();

    try {
      const url = `${this.config.apiBaseUrl}/wavepicking/get/${picklistId}/directions`;
      console.log(`[SkuVault] Fetching directions for picklist ${picklistId}`);
      
      const response = await this.makeAuthenticatedRequest<any>('GET', url);
      
      // Extract and assign spot numbers (1-based order position in picklist)
      const orders = response?.picklist?.orders || [];
      orders.forEach((order: any, index: number) => {
        // Assign spot number as 1-based index (1st order = #1, 2nd = #2, etc.)
        order.spot_number = index + 1;
      });
      
      const orderIds = orders.map((order: any) => order.id).filter(Boolean);
      const sessionId = response?.picklist?.sequenceId;
      
      console.log(`[SkuVault] Successfully fetched directions for picklist ${picklistId} (Session ${sessionId})`);
      console.log(`[SkuVault] This session contains ${orderIds.length} order(s):`, orderIds);
      
      return response;

    } catch (error) {
      console.error(`[SkuVault] Error fetching directions for picklist ${picklistId}:`, error);
      throw error;
    }
  }

  /**
   * Get current lockout status
   * Returns lockout information including whether locked out and time remaining
   */
  async getLockoutStatus(): Promise<{
    isLockedOut: boolean;
    remainingSeconds: number;
    endTime: number | null;
  }> {
    const isLockedOut = await this.lockoutCache.isLockedOut();
    const remainingSeconds = await this.lockoutCache.getRemainingSeconds();
    const endTime = await this.lockoutCache.getLockoutEndTime();
    
    return {
      isLockedOut,
      remainingSeconds,
      endTime,
    };
  }

  /**
   * Quality Control Methods
   * 
   * NOTE: QC endpoints use app.skuvault.com instead of lmdb.skuvault.com
   * These methods use cookie-based authentication (sv-t cookie from login)
   * instead of the Token-based auth used by the wave picking API.
   * 
   * If authentication issues occur, we may need to adjust the implementation.
   */

  /**
   * Strip anti-XSSI prefix from SkuVault API responses and parse JSON
   * SkuVault prepends ")]}',\n\r" to JSON responses for security (Cross-Site Script Inclusion prevention)
   * If HTML is returned (session expired), throws error to trigger re-authentication
   */
  private stripAntiXSSIPrefix(responseText: string): any {
    // Check if response is HTML (indicates session expiration/not authenticated)
    const trimmedResponse = responseText.trim().toLowerCase();
    if (trimmedResponse.startsWith('<!doctype') || trimmedResponse.startsWith('<html')) {
      throw new Error('Received HTML response instead of JSON - session likely expired');
    }
    
    const prefix = ")]}',\n\r";
    if (responseText.startsWith(prefix)) {
      const cleanedJson = responseText.substring(prefix.length);
      return JSON.parse(cleanedJson);
    }
    // If no prefix found, try parsing as-is
    return JSON.parse(responseText);
  }

  /**
   * Make authenticated request to app.skuvault.com for QC operations
   * Uses cookie-based authentication (sv-t cookie set during login)
   * Includes all necessary headers to match browser AJAX requests
   */
  private async makeQCRequest<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    data?: any
  ): Promise<T> {
    // Ensure we're authenticated before making request
    await this.ensureAuthenticated();
    
    // Apply rate limiting before request
    await this.applyRateLimit();
    
    try {
      // Build full URL to app.skuvault.com
      const url = `https://app.skuvault.com${endpoint}`;
      
      // Build headers to match browser AJAX requests
      const headers: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://app.skuvault.com/sales/QualityControl',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://app.skuvault.com',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      };
      
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json;charset=UTF-8';
      }
      
      const response = await this.client.request({
        method,
        url,
        data,
        headers,
        responseType: 'text', // Get response as text to manually strip anti-XSSI prefix
      });
      
      // Strip anti-XSSI prefix and parse JSON
      return this.stripAntiXSSIPrefix(response.data);
    } catch (error) {
      const axiosError = error as AxiosError;
      const initialError = error instanceof Error ? error.message : String(error);
      
      // If 401 OR HTML response (session expired), try re-authenticating once (using mutex)
      const isSessionExpired = axiosError.response?.status === 401 || 
                               initialError.includes('Received HTML response');
      
      if (isSessionExpired) {
        console.log('[SkuVault QC] Session expired (401 or HTML response), attempting re-authentication...');
        await this.tokenCache.clear();
        this.isAuthenticated = false;
        
        // Use ensureAuthenticated to benefit from mutex protection
        await this.ensureAuthenticated();
        
        // Retry the request once (rate limiting already applied above)
        try {
          const retryUrl = `https://app.skuvault.com${endpoint}`;
          const retryHeaders: Record<string, string> = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://app.skuvault.com/sales/QualityControl',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://app.skuvault.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          };
          
          if (method === 'POST') {
            retryHeaders['Content-Type'] = 'application/json;charset=UTF-8';
          }
          
          const retryResponse = await this.client.request({
            method,
            url: retryUrl,
            data,
            headers: retryHeaders,
            responseType: 'text', // Get response as text to manually strip anti-XSSI prefix
          });
          
          // Strip anti-XSSI prefix and parse JSON
          return this.stripAntiXSSIPrefix(retryResponse.data);
        } catch (retryError) {
          const retryAxiosError = retryError as AxiosError;
          const errorMessage = retryAxiosError.response?.data 
            ? JSON.stringify(retryAxiosError.response.data)
            : retryAxiosError.message;
          console.error(`[SkuVault QC] Retry failed after re-authentication: ${errorMessage}`);
          throw new SkuVaultError(
            `QC request failed after re-authentication: ${errorMessage}`,
            retryAxiosError.response?.status || 500,
            retryAxiosError.response?.data
          );
        }
      }
      
      // Handle other errors by wrapping in SkuVaultError
      const errorMessage = axiosError.response?.data 
        ? JSON.stringify(axiosError.response.data)
        : axiosError.message;
      console.error(`[SkuVault QC] Request error: ${errorMessage}`);
      throw new SkuVaultError(
        `QC request failed: ${errorMessage}`,
        axiosError.response?.status || 500,
        axiosError.response?.data
      );
    }
  }

  /**
   * Look up a product by barcode, SKU, or part number
   * Used to validate scanned codes during QC process
   * 
   * @param searchTerm - Barcode, SKU, or part number to search for
   * @returns Product information and raw API response (for audit logging)
   */
  async getProductByCode(searchTerm: string): Promise<{ product: ProductLookupResponse | null; rawResponse: any }> {
    // Ensure we're authenticated (automatically handled by initialization on startup)
    await this.ensureAuthenticated();

    try {
      const endpoint = `/products/product/getProductOrKitByCodeOrSkuOrPartNumber?SearchTerm=${encodeURIComponent(searchTerm)}`;
      console.log(`[SkuVault QC] Looking up product with search term: ${searchTerm}`);
      
      const response = await this.makeQCRequest<any>('GET', endpoint);
      
      // Log the raw response for debugging and audit purposes
      console.log(`[SkuVault QC] Raw API response for "${searchTerm}":`, JSON.stringify(response, null, 2));
      
      // SkuVault wraps product data in a Data field: { Errors: [], Messages: [], Data: {...product...} }
      const productData = response?.Data;
      
      // If no product found, SkuVault returns null/empty Data
      if (!productData || !productData.Id) {
        console.log(`[SkuVault QC] No product found for search term: ${searchTerm}`);
        return { product: null, rawResponse: response };
      }
      
      // Map SkuVault API field names to our schema (Id -> IdItem for consistency with QC pass endpoint)
      const mappedProduct = {
        IdItem: productData.Id,
        Sku: productData.Sku,
        Code: productData.Code,
        PartNumber: productData.PartNumber,
        Description: productData.Title,
        IsKit: productData.IsKit,
        WeightPound: productData.WeightValue,
        ProductPictures: productData.Pictures?.map((p: any) => p.Url) || [],
      };
      
      // Validate mapped product data with Zod schema
      const validatedResponse = productLookupResponseSchema.parse(mappedProduct);
      
      console.log(`[SkuVault QC] Product found: ${validatedResponse.Sku} (IdItem: ${validatedResponse.IdItem})`);
      return { product: validatedResponse, rawResponse: response };

    } catch (error) {
      console.error(`[SkuVault QC] Error looking up product ${searchTerm}:`, error);
      throw error;
    }
  }

  /**
   * Mark an item as QC passed for a specific order
   * 
   * @param itemData - QC pass item request data
   * @returns Response indicating success or failure
   */
  async passQCItem(itemData: QCPassItemRequest): Promise<QCPassItemResponse> {
    // Ensure we're authenticated (automatically handled by initialization on startup)
    await this.ensureAuthenticated();

    try {
      const endpoint = '/sales/QualityControl/passItem';
      console.log(`[SkuVault QC] Marking item as QC passed:`, {
        IdItem: itemData.IdItem,
        Quantity: itemData.Quantity,
        IdSale: itemData.IdSale,
        ScannedCode: itemData.ScannedCode,
      });
      
      const response = await this.makeQCRequest<any>('POST', endpoint, itemData);
      
      // SkuVault returns: {"Data": null, "Errors": [], "Success": true}
      // Parse and validate the response
      const validatedResponse = qcPassItemResponseSchema.parse(response);
      
      console.log(`[SkuVault QC] Item QC passed successfully, response:`, validatedResponse);
      return validatedResponse;

    } catch (error) {
      console.error(`[SkuVault QC] Error passing QC item:`, error);
      throw error;
    }
  }

  /**
   * Get sale information by SaleId or order number
   * Endpoint: GET /sales/Sale/getSaleInformation?Id={id}
   * 
   * @param id - SaleId (e.g., "1-352444-5-13038-138162-JK3825346033") or order number to try
   * @returns Sale information if found, null otherwise
   */
  async getSaleInformation(id: string): Promise<SaleInformation | null> {
    await this.ensureAuthenticated();

    try {
      const url = `${this.config.apiBaseUrl}/sales/Sale/getSaleInformation?Id=${encodeURIComponent(id)}`;
      console.log(`[SkuVault Sale] Looking up sale with id:`, id);
      
      const response = await this.makeAuthenticatedRequest<any>('GET', url);
      
      // Parse and validate the response
      const validatedResponse = saleInformationResponseSchema.parse(response);
      
      if (validatedResponse.Data) {
        console.log(`[SkuVault Sale] Found sale:`, {
          SaleId: validatedResponse.Data.SaleId,
          OrderId: validatedResponse.Data.OrderId,
          Status: validatedResponse.Data.Status,
        });
        return validatedResponse.Data;
      }
      
      console.log(`[SkuVault Sale] No sale found for id:`, id);
      return null;

    } catch (error) {
      console.error(`[SkuVault Sale] Error looking up sale:`, error);
      return null; // Return null instead of throwing to allow graceful degradation
    }
  }

  /**
   * Get picked quantity for a product in a specific sale
   * Endpoint: GET /inventory/item/getPickedQuantityForProductBySaleId?CodeOrSku={sku}&SaleId={saleId}
   * 
   * Returns how many units have already been picked/QC'd in SkuVault for this product in this sale
   * Used for sync validation - prevents duplicate scans across systems
   * 
   * @param codeOrSku - Product barcode, SKU, or code
   * @param saleId - Full SkuVault SaleId (e.g., "1-352444-5-13038-138162-JK3825346033")
   * @returns Number of units already picked, or null if error/not found
   */
  async getPickedQuantityForProduct(codeOrSku: string, saleId: string): Promise<number | null> {
    await this.ensureAuthenticated();

    try {
      const url = `${this.config.apiBaseUrl}/inventory/item/getPickedQuantityForProductBySaleId?CodeOrSku=${encodeURIComponent(codeOrSku)}&SaleId=${encodeURIComponent(saleId)}`;
      console.log(`[SkuVault Sync] Checking picked quantity:`, { codeOrSku, saleId });
      
      const response = await this.makeAuthenticatedRequest<any>('GET', url);
      
      // Parse and validate the response
      const validatedResponse = pickedQuantityResponseSchema.parse(response);
      
      const pickedQuantity = validatedResponse.Data ?? 0;
      console.log(`[SkuVault Sync] Picked quantity for ${codeOrSku}: ${pickedQuantity}`);
      
      return pickedQuantity;

    } catch (error) {
      console.error(`[SkuVault Sync] Error getting picked quantity:`, error);
      return null; // Return null instead of throwing to allow graceful degradation
    }
  }

  /**
   * Get QC Sales data by order number
   * Endpoint: GET /sales/QualityControl/getQCSales?SearchTerm={orderNumber}
   * 
   * Returns QC sale data including:
   * - Sale ID (eliminates need for separate lookup)
   * - Expected items to scan
   * - Items already passed QC in SkuVault
   * - Items that failed QC
   * 
   * @param orderNumber - ShipStation order number to search for
   * @returns QCSale if found, null if not found or error
   */
  async getQCSalesByOrderNumber(orderNumber: string): Promise<import('@shared/skuvault-types').QCSale | null> {
    await this.ensureAuthenticated();

    try {
      // QC Sales endpoint is only available on app.skuvault.com, not lmdb.skuvault.com
      const url = `https://app.skuvault.com/sales/QualityControl/getQCSales?SearchTerm=${encodeURIComponent(orderNumber)}`;
      console.log(`[SkuVault QC Sales] Looking up order:`, orderNumber);
      
      // Apply rate limiting
      await this.applyRateLimit();
      
      // Make request manually to control response parsing (axios auto-parses JSON but can't handle anti-XSSI prefix)
      const headers = await this.getApiHeaders();
      const response = await this.client.request({
        method: 'GET',
        url,
        headers,
        transformResponse: [], // Prevent axios from auto-parsing - we'll handle it manually
      });
      
      // Response.data will be a raw string since we disabled transformResponse
      let rawData = response.data as string;
      console.log(`[SkuVault QC Sales] Raw response (first 200 chars):`, rawData.substring(0, 200));
      
      // Check if response is HTML (session expired - SkuVault redirects to login page)
      if (rawData.trim().startsWith('<!doctype') || rawData.trim().startsWith('<html')) {
        console.log('[SkuVault QC Sales] Received HTML response (session expired), re-authenticating...');
        await this.tokenCache.clear();
        this.isAuthenticated = false;
        await this.ensureAuthenticated();
        
        // Retry the request with new token
        const retryHeaders = await this.getApiHeaders();
        const retryResponse = await this.client.request({
          method: 'GET',
          url,
          headers: retryHeaders,
          transformResponse: [],
        });
        rawData = retryResponse.data as string;
        console.log(`[SkuVault QC Sales] Retry response (first 200 chars):`, rawData.substring(0, 200));
      }
      
      // SkuVault returns responses with anti-XSSI prefix - strip it if present
      if (rawData.startsWith(")]}',")) {
        rawData = rawData.substring(6); // Remove ")]}',\n"
        console.log(`[SkuVault QC Sales] Stripped anti-XSSI prefix`);
      }
      
      // Parse JSON
      const parsedData = JSON.parse(rawData);
      
      // Parse and validate the response
      const { qcSalesResponseSchema } = await import('@shared/skuvault-types');
      const validatedResponse = qcSalesResponseSchema.parse(parsedData);
      
      // Check for errors in the response
      if (validatedResponse.Errors && validatedResponse.Errors.length > 0) {
        console.error(`[SkuVault QC Sales] Errors in response:`, validatedResponse.Errors);
        throw new SkuVaultError(
          `SkuVault errors: ${validatedResponse.Errors.join(', ')}`,
          400,
          validatedResponse.Errors
        );
      }
      
      // Extract the first QC sale from the array
      const qcSales = validatedResponse.Data?.QcSales;
      if (!qcSales || qcSales.length === 0) {
        console.log(`[SkuVault QC Sales] No QC sale found for order:`, orderNumber);
        return null;
      }
      
      const qcSale = qcSales[0]; // Take first match
      console.log(`[SkuVault QC Sales] Found QC sale:`, {
        SaleId: qcSale.SaleId,
        OrderId: qcSale.OrderId,
        Status: qcSale.Status,
        TotalItems: qcSale.TotalItems,
        PassedItems: qcSale.PassedItems?.length ?? 0,
        FailedItems: qcSale.FailedItems?.length ?? 0,
      });
      
      return qcSale;

    } catch (error) {
      if (error instanceof SkuVaultError) {
        throw error; // Re-throw SkuVault errors
      }
      
      // SkuVault QC endpoint returns 404 with valid JSON data wrapped in anti-XSSI prefix
      const axiosError = error as any;
      if (axiosError?.response?.status === 404 && axiosError?.response?.data) {
        try {
          console.log(`[SkuVault QC Sales] Got 404 response, attempting to parse body`);
          let responseData = axiosError.response.data;
          
          // Strip anti-XSSI prefix if present
          if (typeof responseData === 'string' && responseData.startsWith(")]}',")) {
            responseData = responseData.substring(6); // Remove ")]}',\n"
            console.log(`[SkuVault QC Sales] Stripped anti-XSSI prefix from response`);
          }
          
          // Parse JSON if it's a string
          const parsedData = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
          
          // Log the full response for debugging
          console.log(`[SkuVault QC Sales] Parsed 404 response:`, JSON.stringify(parsedData, null, 2));
          
          // Validate the parsed response
          const { qcSalesResponseSchema } = await import('@shared/skuvault-types');
          const validatedResponse = qcSalesResponseSchema.parse(parsedData);
          
          // Check for errors in the parsed response
          if (validatedResponse.Errors && validatedResponse.Errors.length > 0) {
            console.error(`[SkuVault QC Sales] Errors in 404 response:`, validatedResponse.Errors);
            return null;
          }
          
          // Extract the first QC sale from the array
          const qcSales = validatedResponse.Data?.QcSales;
          if (!qcSales || qcSales.length === 0) {
            console.log(`[SkuVault QC Sales] No QC sale found in 404 response for order:`, orderNumber);
            return null;
          }
          
          const qcSale = qcSales[0]; // Take first match
          console.log(`[SkuVault QC Sales] Successfully parsed QC sale from 404 response:`, {
            SaleId: qcSale.SaleId,
            OrderId: qcSale.OrderId,
            Status: qcSale.Status,
            TotalItems: qcSale.TotalItems,
            PassedItems: qcSale.PassedItems?.length ?? 0,
            FailedItems: qcSale.FailedItems?.length ?? 0,
          });
          
          return qcSale;
        } catch (parseError) {
          console.error(`[SkuVault QC Sales] Failed to parse 404 response body:`, parseError);
        }
      }
      
      console.error(`[SkuVault QC Sales] Error looking up order:`, error);
      return null; // Return null for other errors to allow graceful degradation
    }
  }

  /**
   * Get token metadata for operations dashboard
   * Returns authentication status and last refresh timestamp
   */
  async getTokenMetadata(): Promise<{
    isValid: boolean;
    lastRefreshed: string | null;
    credentialsConfigured: boolean;
  }> {
    const isValid = await this.tokenCache.isValid();
    const lastRefreshed = await this.tokenCache.getLastRefreshed();
    const credentialsConfigured = !!(this.config.username && this.config.password);

    return {
      isValid,
      lastRefreshed,
      credentialsConfigured,
    };
  }

  /**
   * Force token rotation (manual refresh)
   * Clears existing token and performs fresh login
   */
  async rotateToken(): Promise<void> {
    console.log('[SkuVault] Manual token rotation requested');
    
    // Clear existing token
    await this.tokenCache.clear();
    this.isAuthenticated = false;
    
    // Perform fresh login
    await this.ensureAuthenticated();
    
    console.log('[SkuVault] Token rotation complete');
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    await this.tokenCache.clear();
    this.isAuthenticated = false;
    console.log('[SkuVault] Logged out, token cleared from Redis');
  }
}

// Export singleton instance
export const skuVaultService = new SkuVaultService();
