/**
 * Database Retry Utility
 * 
 * Provides retry logic with exponential backoff for database operations
 * to handle Neon serverless cold starts and transient connection issues.
 */

// Transient error codes that should trigger a retry
const TRANSIENT_ERROR_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

// Error messages that indicate transient issues
const TRANSIENT_ERROR_MESSAGES = [
  'Connection terminated',
  'Connection timeout',
  'connection was closed',
  'WebSocket was closed',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
];

interface RetryOptions {
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  factor?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  retries: 3,
  minTimeout: 1000,  // 1 second
  maxTimeout: 8000,  // 8 seconds
  factor: 2,         // exponential backoff multiplier
};

/**
 * Check if an error is transient and should be retried
 */
export function isTransientError(error: any): boolean {
  // Check error code (Postgres SQLSTATE)
  if (error?.code && TRANSIENT_ERROR_CODES.has(error.code)) {
    return true;
  }
  
  // Check error message patterns
  const message = error?.message || '';
  return TRANSIENT_ERROR_MESSAGES.some(pattern => message.includes(pattern));
}

/**
 * Sleep for a given duration with jitter
 */
function sleep(ms: number): Promise<void> {
  // Add 0-20% jitter to prevent thundering herd
  const jitter = ms * (Math.random() * 0.2);
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

/**
 * Calculate delay for a given attempt using exponential backoff
 */
function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, 'onRetry'>>): number {
  const delay = options.minTimeout * Math.pow(options.factor, attempt - 1);
  return Math.min(delay, options.maxTimeout);
}

/**
 * Execute a database operation with retry logic
 * 
 * @param operation - The async operation to execute
 * @param options - Retry configuration options
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 * 
 * @example
 * const result = await withRetry(
 *   () => db.select().from(users).where(eq(users.id, 1)),
 *   { retries: 3 }
 * );
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Don't retry if it's not a transient error
      if (!isTransientError(error)) {
        throw error;
      }
      
      // Don't retry if we've exhausted attempts
      if (attempt > opts.retries) {
        throw error;
      }
      
      // Calculate delay and wait
      const delay = calculateDelay(attempt, opts);
      
      // Call retry callback if provided
      if (options.onRetry) {
        options.onRetry(error, attempt);
      } else {
        console.warn(`[DB Retry] Attempt ${attempt} failed (${error.message}), retrying in ${delay}ms...`);
      }
      
      await sleep(delay);
    }
  }
  
  // This shouldn't be reached, but TypeScript needs it
  throw lastError || new Error('Unknown error in withRetry');
}

/**
 * Wrapper that provides a safe version of a function that won't throw on transient errors
 * Returns null instead of throwing, useful for non-critical operations
 * 
 * @example
 * const count = await withRetrySafe(() => storage.getShipmentSyncFailureCount());
 * // count is null if all retries failed, otherwise the actual count
 */
export async function withRetrySafe<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  defaultValue: T | null = null
): Promise<T | null> {
  try {
    return await withRetry(operation, options);
  } catch (error: any) {
    console.error(`[DB Retry] All retries exhausted: ${error.message}`);
    return defaultValue;
  }
}
