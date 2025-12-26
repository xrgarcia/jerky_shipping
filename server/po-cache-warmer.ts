/**
 * PO Recommendations Cache Warmer
 * Runs every 6 hours to pre-populate Redis cache with latest PO recommendations data
 * Ensures instant page loads by caching the full snapshot before users visit
 */

import { getRedisClient } from './utils/queue';
import { reportingStorage } from './reporting-storage';

const log = (message: string) => console.log(`[po-cache-warmer] ${message}`);

const LAST_WARMED_DATE_KEY = 'po_recommendations:last_warmed_date';
const TOP_SKUS_COUNT = 50; // Pre-warm steps for top 50 SKUs by recommended quantity

// Global worker status
let workerStatus: 'sleeping' | 'running' = 'sleeping';
let workerStats = {
  totalRunsCount: 0,
  lastCacheWarmedAt: null as Date | null,
  lastStockCheckDate: null as string | null,
  workerStartedAt: new Date(),
};

export function getPOCacheWarmerStatus(): 'sleeping' | 'running' {
  return workerStatus;
}

export function getPOCacheWarmerStats() {
  return {
    ...workerStats,
    status: workerStatus,
  };
}

/**
 * Warm the cache with latest PO recommendations data
 */
async function warmCache(): Promise<void> {
  const startTime = Date.now();
  workerStatus = 'running';
  
  try {
    // Get latest stock check date from database
    const latestDate = await reportingStorage.getLatestStockCheckDate();
    if (!latestDate) {
      log('No stock check data available in database');
      return;
    }
    
    const latestDateStr = latestDate.toISOString().split('T')[0];
    
    // Check if this date is already warmed
    const redis = getRedisClient();
    const lastWarmedDate = await redis.get<string>(LAST_WARMED_DATE_KEY);
    
    if (lastWarmedDate === latestDateStr) {
      log(`Cache already warm for ${latestDateStr}, skipping`);
      return;
    }
    
    log(`New stock check date detected: ${latestDateStr} (previous: ${lastWarmedDate || 'none'})`);
    
    // Invalidate old cache entries before warming new ones
    log('Invalidating old cache entries...');
    await reportingStorage.invalidateCache();
    
    log('Warming cache...');
    
    // Warm the main snapshot, available dates, and date bounds
    const { recordCount, stockCheckDate, datesCount } = await reportingStorage.warmCache();
    log(`Warmed snapshot: ${recordCount} recommendations for ${stockCheckDate}, ${datesCount} available dates`);
    
    // Pre-warm steps for top SKUs by recommended quantity
    const snapshot = await reportingStorage.getFullSnapshot();
    const topSkus = snapshot
      .filter(r => r.recommended_quantity > 0)
      .sort((a, b) => (b.recommended_quantity || 0) - (a.recommended_quantity || 0))
      .slice(0, TOP_SKUS_COUNT)
      .map(r => r.sku);
    
    if (topSkus.length > 0) {
      log(`Pre-warming steps for top ${topSkus.length} SKUs...`);
      let warmedCount = 0;
      
      for (const sku of topSkus) {
        try {
          await reportingStorage.getPORecommendationSteps(sku, latestDate);
          warmedCount++;
        } catch (error) {
          log(`Warning: Failed to warm steps for SKU ${sku}: ${error}`);
        }
      }
      
      log(`Warmed ${warmedCount}/${topSkus.length} SKU step caches`);
    }
    
    // Update last warmed date in Redis (no TTL - persists until explicitly changed)
    await redis.set(LAST_WARMED_DATE_KEY, latestDateStr);
    
    // Update stats
    workerStats.totalRunsCount++;
    workerStats.lastCacheWarmedAt = new Date();
    workerStats.lastStockCheckDate = latestDateStr;
    
    const duration = Date.now() - startTime;
    log(`Cache warming complete in ${duration}ms`);
    
  } catch (error) {
    log(`Error warming cache: ${error}`);
    console.error('[po-cache-warmer] Full error:', error);
  } finally {
    workerStatus = 'sleeping';
  }
}

/**
 * Start the PO cache warmer worker
 * @param intervalMs Interval in milliseconds (default: 6 hours = 21600000ms)
 */
export function startPOCacheWarmer(intervalMs: number = 21600000): void {
  log(`Worker started (interval: ${intervalMs}ms = ${intervalMs / 3600000} hours)`);
  
  // Run immediately on startup
  setImmediate(() => warmCache());
  
  // Then run on interval
  setInterval(() => warmCache(), intervalMs);
}
