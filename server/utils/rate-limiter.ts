/**
 * Smart Rate Limiter for ShipStation API
 * Uses X-Rate-Limit headers to intelligently throttle requests
 */

import type { RateLimitInfo } from './shipstation-api';

/**
 * Check rate limit and wait if needed
 * Only waits when approaching limit (< 5 remaining)
 * 
 * @param rateLimit - Rate limit info from last API response
 * @param threshold - Remaining requests threshold (default: 5)
 * @returns void - Resolves after waiting if needed
 */
export async function checkRateLimit(
  rateLimit: RateLimitInfo | undefined,
  threshold: number = 5
): Promise<void> {
  if (!rateLimit) {
    // No rate limit info - skip throttling
    return;
  }

  const { remaining, reset, limit } = rateLimit;

  // Log current rate limit status
  console.log(`[RateLimit] ${remaining}/${limit} requests remaining, resets in ${reset}s`);

  // Only wait if we're approaching the limit
  if (remaining < threshold) {
    const waitMs = reset * 1000;
    console.log(`[RateLimit] ⚠️  Low quota (${remaining} remaining), waiting ${reset}s before next request...`);
    await sleep(waitMs);
    console.log(`[RateLimit] ✓ Rate limit reset, resuming requests`);
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
