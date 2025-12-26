import { reportingSql } from './reporting-db';
import type { PORecommendation, PORecommendationStep } from '@shared/reporting-schema';
import { getRedisClient } from './utils/queue';
import { formatInTimeZone } from 'date-fns-tz';

const CST_TIMEZONE = 'America/Chicago';

// Cache key structure - supports per-date caching
// No TTL - cache only invalidates when stock_check_date changes (handled by cache warmer)
const CACHE_PREFIX = 'po_recommendations:';
const SNAPSHOT_KEY_PREFIX = `${CACHE_PREFIX}snapshot:`; // + date, e.g. snapshot:2025-12-26
const SUPPLIERS_KEY = `${CACHE_PREFIX}suppliers`;
const AVAILABLE_DATES_KEY = `${CACHE_PREFIX}available_dates`;
const DATE_BOUNDS_KEY = `${CACHE_PREFIX}date_bounds`;

// Legacy snapshot key for backwards compatibility during transition
const LEGACY_SNAPSHOT_KEY = `${CACHE_PREFIX}snapshot`;

interface DateBounds {
  earliest: string;
  latest: string;
}

export interface IReportingStorage {
  getFullSnapshot(): Promise<PORecommendation[]>;
  getLatestStockCheckDate(): Promise<Date | null>;
  getAvailableDates(): Promise<string[]>;
  getDateBounds(): Promise<DateBounds | null>;
  getRecommendationsByDate(date: string): Promise<PORecommendation[]>;
  getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]>;
  getUniqueSuppliers(): Promise<string[]>;
  invalidateCache(): Promise<void>;
  warmCache(): Promise<{ recordCount: number; stockCheckDate: string; datesCount: number }>;
}

export class ReportingStorage implements IReportingStorage {
  async getLatestStockCheckDate(): Promise<Date | null> {
    const result = await reportingSql`
      SELECT MAX(stock_check_date) as latest_date
      FROM vw_po_recommendations
    `;
    return result[0]?.latest_date || null;
  }

  /**
   * Get all available stock_check_dates.
   * Returns cached dates if available, otherwise fetches from database.
   * Dates are CST-formatted strings in descending order (newest first).
   */
  async getAvailableDates(): Promise<string[]> {
    // Try cache first
    try {
      const redis = getRedisClient();
      const cached = await redis.get<string[]>(AVAILABLE_DATES_KEY);
      if (cached && cached.length > 0) {
        console.log(`[ReportingStorage] Available dates cache hit (${cached.length} dates)`);
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching available dates:', error);
    }

    console.log('[ReportingStorage] Available dates cache miss, fetching from database...');
    
    const results = await reportingSql`
      SELECT DISTINCT stock_check_date
      FROM vw_po_recommendations
      ORDER BY stock_check_date DESC
    `;
    
    // Format dates in CST timezone to ensure correct day alignment
    const dates = results.map((row: any) => 
      formatInTimeZone(row.stock_check_date, CST_TIMEZONE, 'yyyy-MM-dd')
    );

    // Cache the dates
    if (dates.length > 0) {
      try {
        const redis = getRedisClient();
        await redis.set(AVAILABLE_DATES_KEY, dates);
        console.log(`[ReportingStorage] Cached ${dates.length} available dates`);
        
        // Also cache date bounds
        const bounds: DateBounds = {
          earliest: dates[dates.length - 1], // Last item (oldest)
          latest: dates[0], // First item (newest)
        };
        await redis.set(DATE_BOUNDS_KEY, bounds);
        console.log(`[ReportingStorage] Cached date bounds: ${bounds.earliest} to ${bounds.latest}`);
      } catch (error) {
        console.error('[ReportingStorage] Redis error caching available dates:', error);
      }
    }
    
    return dates;
  }

  /**
   * Get date bounds (earliest and latest available dates).
   * Uses cache for fast access.
   */
  async getDateBounds(): Promise<DateBounds | null> {
    try {
      const redis = getRedisClient();
      const cached = await redis.get<DateBounds>(DATE_BOUNDS_KEY);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching date bounds:', error);
    }

    // If not cached, derive from available dates
    const dates = await this.getAvailableDates();
    if (dates.length === 0) return null;
    
    return {
      earliest: dates[dates.length - 1],
      latest: dates[0],
    };
  }

  /**
   * Get all PO recommendations for a specific date.
   * Uses per-date caching - checks cache first, fetches and caches on miss.
   * @param date - Date string in 'yyyy-MM-dd' format (CST)
   */
  async getRecommendationsByDate(date: string): Promise<PORecommendation[]> {
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Invalid date format. Expected yyyy-MM-dd');
    }

    const cacheKey = `${SNAPSHOT_KEY_PREFIX}${date}`;
    
    // Try cache first
    try {
      const redis = getRedisClient();
      const cached = await redis.get<PORecommendation[]>(cacheKey);
      if (cached) {
        console.log(`[ReportingStorage] Per-date cache hit for ${date} (${cached.length} records)`);
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching per-date snapshot:', error);
    }
    
    console.log(`[ReportingStorage] Per-date cache miss for ${date}, fetching from database...`);
    
    const results = await reportingSql`
      SELECT 
        sku,
        supplier,
        title,
        lead_time,
        current_total_stock,
        base_velocity,
        projected_velocity,
        growth_rate,
        kit_driven_velocity,
        individual_velocity,
        ninety_day_forecast,
        case_adjustment_applied,
        current_days_cover,
        moq_applied,
        quantity_incoming,
        recommended_quantity,
        is_assembled_product,
        stock_check_date,
        next_holiday_count_down_in_days,
        next_holiday_recommended_quantity,
        next_holiday_season,
        next_holiday_start_date
      FROM vw_po_recommendations
      WHERE stock_check_date = ${date}
    `;
    
    const recommendations = results as unknown as PORecommendation[];
    console.log(`[ReportingStorage] Fetched ${recommendations.length} recommendations for ${date}`);
    
    // Cache the results
    if (recommendations.length > 0) {
      try {
        const redis = getRedisClient();
        await redis.set(cacheKey, recommendations);
        console.log(`[ReportingStorage] Cached snapshot for ${date}`);
      } catch (error) {
        console.error('[ReportingStorage] Redis error caching per-date snapshot:', error);
      }
    }
    
    return recommendations;
  }

  /**
   * Get the full snapshot of all PO recommendations for the latest stock_check_date.
   * Returns cached data if available, otherwise fetches from database.
   * Uses per-date caching with fallback to legacy key for backwards compatibility.
   * Frontend handles all filtering/sorting locally for instant performance.
   */
  async getFullSnapshot(): Promise<PORecommendation[]> {
    // Get latest stock check date first (needed for cache key)
    const latestDate = await this.getLatestStockCheckDate();
    if (!latestDate) {
      console.log('[ReportingStorage] No stock check data available');
      return [];
    }
    
    // Format date in CST timezone to ensure correct day alignment
    const latestDateStr = formatInTimeZone(latestDate, CST_TIMEZONE, 'yyyy-MM-dd');
    const cacheKey = `${SNAPSHOT_KEY_PREFIX}${latestDateStr}`;
    
    // Try per-date cache first
    try {
      const redis = getRedisClient();
      const cached = await redis.get<PORecommendation[]>(cacheKey);
      if (cached) {
        console.log(`[ReportingStorage] Snapshot cache hit for ${latestDateStr} (${cached.length} records)`);
        return cached;
      }
      
      // Fallback to legacy key for backwards compatibility
      const legacyCached = await redis.get<PORecommendation[]>(LEGACY_SNAPSHOT_KEY);
      if (legacyCached) {
        console.log(`[ReportingStorage] Legacy snapshot cache hit (${legacyCached.length} records), migrating...`);
        // Migrate to per-date key
        await redis.set(cacheKey, legacyCached);
        return legacyCached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching snapshot:', error);
    }

    console.log(`[ReportingStorage] Snapshot cache miss for ${latestDateStr}, fetching from database...`);
    
    // Use getRecommendationsByDate which handles caching
    return this.getRecommendationsByDate(latestDateStr);
  }

  /**
   * Warm the cache by fetching all data and storing in Redis.
   * Called by the cache warmer when new stock_check_date is detected.
   * Warms: available dates, date bounds, latest snapshot, and suppliers.
   */
  async warmCache(): Promise<{ recordCount: number; stockCheckDate: string; datesCount: number }> {
    const redis = getRedisClient();
    
    // 1. Fetch and cache all available dates
    console.log('[ReportingStorage] Warming available dates...');
    const dateResults = await reportingSql`
      SELECT DISTINCT stock_check_date
      FROM vw_po_recommendations
      ORDER BY stock_check_date DESC
    `;
    
    const dates = dateResults.map((row: any) => 
      formatInTimeZone(row.stock_check_date, CST_TIMEZONE, 'yyyy-MM-dd')
    );
    
    if (dates.length === 0) {
      throw new Error('No stock check data available');
    }
    
    await redis.set(AVAILABLE_DATES_KEY, dates);
    console.log(`[ReportingStorage] Cached ${dates.length} available dates`);
    
    // 2. Cache date bounds
    const bounds: DateBounds = {
      earliest: dates[dates.length - 1],
      latest: dates[0],
    };
    await redis.set(DATE_BOUNDS_KEY, bounds);
    console.log(`[ReportingStorage] Cached date bounds: ${bounds.earliest} to ${bounds.latest}`);
    
    // 3. Fetch and cache latest date's recommendations
    const latestDateStr = dates[0];
    const cacheKey = `${SNAPSHOT_KEY_PREFIX}${latestDateStr}`;
    
    const results = await reportingSql`
      SELECT 
        sku,
        supplier,
        title,
        lead_time,
        current_total_stock,
        base_velocity,
        projected_velocity,
        growth_rate,
        kit_driven_velocity,
        individual_velocity,
        ninety_day_forecast,
        case_adjustment_applied,
        current_days_cover,
        moq_applied,
        quantity_incoming,
        recommended_quantity,
        is_assembled_product,
        stock_check_date,
        next_holiday_count_down_in_days,
        next_holiday_recommended_quantity,
        next_holiday_season,
        next_holiday_start_date
      FROM vw_po_recommendations
      WHERE stock_check_date = ${latestDateStr}
    `;
    
    const recommendations = results as unknown as PORecommendation[];
    
    // Cache the per-date snapshot
    await redis.set(cacheKey, recommendations);
    
    // Also cache with legacy key for backwards compatibility
    await redis.set(LEGACY_SNAPSHOT_KEY, recommendations);
    
    // 4. Cache unique suppliers for filter dropdown
    const supplierSet = new Set(recommendations.map(r => r.supplier).filter((s): s is string => s != null));
    const suppliers = Array.from(supplierSet).sort();
    await redis.set(SUPPLIERS_KEY, suppliers);
    
    console.log(`[ReportingStorage] Warmed cache: ${recommendations.length} records, ${suppliers.length} suppliers, ${dates.length} dates`);
    
    return { recordCount: recommendations.length, stockCheckDate: latestDateStr, datesCount: dates.length };
  }

  async getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]> {
    // Try cache first
    const cacheKey = `${CACHE_PREFIX}steps:${sku}:${stockCheckDate.toISOString().split('T')[0]}`;
    
    try {
      const redis = getRedisClient();
      const cached = await redis.get<PORecommendationStep[]>(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching steps:', error);
    }
    
    const results = await reportingSql`
      SELECT 
        sku,
        step_name,
        calculation_commentary,
        stock_check_date,
        raw_calculation,
        final_value
      FROM vw_po_recommendations_steps
      WHERE sku = ${sku} 
        AND stock_check_date = ${stockCheckDate}
      ORDER BY step_name
    `;

    const steps = results as unknown as PORecommendationStep[];
    
    // Cache the steps
    try {
      const redis = getRedisClient();
      await redis.set(cacheKey, steps);
    } catch (error) {
      console.error('[ReportingStorage] Redis error caching steps:', error);
    }

    return steps;
  }

  async getUniqueSuppliers(): Promise<string[]> {
    try {
      const redis = getRedisClient();
      const cached = await redis.get<string[]>(SUPPLIERS_KEY);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching suppliers:', error);
    }

    // If not cached, derive from snapshot
    const snapshot = await this.getFullSnapshot();
    const supplierSet = new Set(snapshot.map(r => r.supplier).filter((s): s is string => s != null));
    const suppliers = Array.from(supplierSet).sort();
    
    try {
      const redis = getRedisClient();
      await redis.set(SUPPLIERS_KEY, suppliers);
    } catch (error) {
      console.error('[ReportingStorage] Redis error caching suppliers:', error);
    }

    return suppliers;
  }

  async invalidateCache(): Promise<void> {
    try {
      const redis = getRedisClient();
      const keys = await redis.keys(`${CACHE_PREFIX}*`);
      if (keys && keys.length > 0) {
        await redis.del(...keys);
      }
      console.log(`[ReportingStorage] Invalidated ${keys?.length || 0} cache keys`);
    } catch (error) {
      console.error('[ReportingStorage] Redis error invalidating cache:', error);
    }
  }
}

export const reportingStorage = new ReportingStorage();
