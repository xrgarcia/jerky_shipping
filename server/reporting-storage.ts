import { reportingSql } from './reporting-db';
import type { PORecommendation, PORecommendationStep } from '@shared/reporting-schema';
import { getRedisClient } from './utils/queue';
import { formatInTimeZone } from 'date-fns-tz';

const CST_TIMEZONE = 'America/Chicago';

// Single snapshot cache - one key for all recommendations
// No TTL - cache only invalidates when stock_check_date changes (handled by cache warmer)
const CACHE_PREFIX = 'po_recommendations:';
const SNAPSHOT_KEY = `${CACHE_PREFIX}snapshot`;
const SUPPLIERS_KEY = `${CACHE_PREFIX}suppliers`;

export interface IReportingStorage {
  getFullSnapshot(): Promise<PORecommendation[]>;
  getLatestStockCheckDate(): Promise<Date | null>;
  getAvailableDates(): Promise<string[]>;
  getRecommendationsByDate(date: string): Promise<PORecommendation[]>;
  getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]>;
  getUniqueSuppliers(): Promise<string[]>;
  invalidateCache(): Promise<void>;
  warmCache(): Promise<{ recordCount: number; stockCheckDate: string }>;
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
   * Get all available stock_check_dates from the database.
   * Returns dates as CST-formatted strings in descending order (newest first).
   */
  async getAvailableDates(): Promise<string[]> {
    const results = await reportingSql`
      SELECT DISTINCT stock_check_date
      FROM vw_po_recommendations
      ORDER BY stock_check_date DESC
    `;
    
    // Format dates in CST timezone to ensure correct day alignment
    return results.map((row: any) => 
      formatInTimeZone(row.stock_check_date, CST_TIMEZONE, 'yyyy-MM-dd')
    );
  }

  /**
   * Get all PO recommendations for a specific date.
   * @param date - Date string in 'yyyy-MM-dd' format (CST)
   */
  async getRecommendationsByDate(date: string): Promise<PORecommendation[]> {
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Invalid date format. Expected yyyy-MM-dd');
    }
    
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
    
    return recommendations;
  }

  /**
   * Get the full snapshot of all PO recommendations for the latest stock_check_date.
   * Returns cached data if available, otherwise fetches from database.
   * Frontend handles all filtering/sorting locally for instant performance.
   */
  async getFullSnapshot(): Promise<PORecommendation[]> {
    // Try to get from Redis cache first
    try {
      const redis = getRedisClient();
      const cached = await redis.get<PORecommendation[]>(SNAPSHOT_KEY);
      if (cached) {
        console.log(`[ReportingStorage] Snapshot cache hit (${cached.length} records)`);
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching snapshot:', error);
    }

    console.log('[ReportingStorage] Snapshot cache miss, fetching from database...');
    
    // Get latest stock check date
    const latestDate = await this.getLatestStockCheckDate();
    if (!latestDate) {
      console.log('[ReportingStorage] No stock check data available');
      return [];
    }
    
    // Format date in CST timezone to ensure correct day alignment
    // The GCP database stores dates in CST context, so we need to preserve that
    const latestDateStr = formatInTimeZone(latestDate, CST_TIMEZONE, 'yyyy-MM-dd');
    
    // Fetch all recommendations for the latest date
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
    console.log(`[ReportingStorage] Fetched ${recommendations.length} recommendations for ${latestDateStr}`);

    // Cache the snapshot
    try {
      const redis = getRedisClient();
      await redis.set(SNAPSHOT_KEY, recommendations);
      console.log('[ReportingStorage] Cached snapshot (no TTL)');
    } catch (error) {
      console.error('[ReportingStorage] Redis error caching snapshot:', error);
    }

    return recommendations;
  }

  /**
   * Warm the cache by fetching all data and storing in Redis.
   * Called by the cache warmer when new stock_check_date is detected.
   */
  async warmCache(): Promise<{ recordCount: number; stockCheckDate: string }> {
    const latestDate = await this.getLatestStockCheckDate();
    if (!latestDate) {
      throw new Error('No stock check data available');
    }
    
    // Format date in CST timezone to ensure correct day alignment
    const latestDateStr = formatInTimeZone(latestDate, CST_TIMEZONE, 'yyyy-MM-dd');
    
    // Fetch all recommendations
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
    
    // Cache the snapshot
    const redis = getRedisClient();
    await redis.set(SNAPSHOT_KEY, recommendations);
    
    // Also cache unique suppliers for filter dropdown
    const supplierSet = new Set(recommendations.map(r => r.supplier).filter((s): s is string => s != null));
    const suppliers = Array.from(supplierSet).sort();
    await redis.set(SUPPLIERS_KEY, suppliers);
    
    console.log(`[ReportingStorage] Warmed cache: ${recommendations.length} records, ${suppliers.length} suppliers`);
    
    return { recordCount: recommendations.length, stockCheckDate: latestDateStr };
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
