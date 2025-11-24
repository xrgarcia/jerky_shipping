import { reportingSql } from './reporting-db';
import type { PORecommendation, PORecommendationStep, PORecommendationFilters } from '@shared/reporting-schema';
import { getRedisClient } from './utils/queue';

const CACHE_TTL = 300; // 5 minutes cache
const CACHE_PREFIX = 'po_recommendations:';

// Generate consistent cache key from filters
function generateCacheKey(filters: PORecommendationFilters): string {
  const normalized: Record<string, string> = {};
  
  // Normalize stockCheckDate to string format
  if (filters.stockCheckDate) {
    normalized.stockCheckDate = typeof filters.stockCheckDate === 'string' 
      ? filters.stockCheckDate 
      : new Date(filters.stockCheckDate).toISOString().split('T')[0];
  }
  
  // Add other non-default filter values in alphabetical order
  if (filters.supplier) normalized.supplier = filters.supplier;
  if (filters.sortBy && filters.sortBy !== 'sku') normalized.sortBy = filters.sortBy;
  if (filters.sortOrder && filters.sortOrder !== 'asc') normalized.sortOrder = filters.sortOrder;
  
  // Generate key from sorted keys for consistency
  const keyParts = Object.keys(normalized)
    .sort()
    .map(key => `${key}:${normalized[key]}`)
    .join('|');
    
  return `${CACHE_PREFIX}data:${keyParts || 'default'}`;
}

export interface IReportingStorage {
  getPORecommendations(filters?: PORecommendationFilters): Promise<PORecommendation[]>;
  getLatestStockCheckDate(): Promise<Date | null>;
  getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]>;
  getUniqueSuppliers(): Promise<string[]>;
  invalidateCache(): Promise<void>;
}

export class ReportingStorage implements IReportingStorage {
  async getLatestStockCheckDate(): Promise<Date | null> {
    const result = await reportingSql`
      SELECT MAX(stock_check_date) as latest_date
      FROM vw_po_recommendations
    `;
    return result[0]?.latest_date || null;
  }

  async getPORecommendations(filters: PORecommendationFilters = {}): Promise<PORecommendation[]> {
    // Normalize stockCheckDate to string to ensure consistent cache keys
    const normalizedFilters = {
      ...filters,
      stockCheckDate: filters.stockCheckDate 
        ? (typeof filters.stockCheckDate === 'string' 
            ? filters.stockCheckDate 
            : new Date(filters.stockCheckDate).toISOString().split('T')[0])
        : undefined
    };

    const {
      supplier,
      stockCheckDate,
      search,
      sortBy = 'sku',
      sortOrder = 'asc'
    } = normalizedFilters;

    // Create cache key based on normalized filters
    const cacheKey = generateCacheKey(normalizedFilters);
    
    // Try to get from cache (only if no search filter - searches are dynamic)
    // Skip cache entirely if search is provided (even empty string)
    const shouldCache = !search;
    if (shouldCache) {
      try {
        const redis = getRedisClient();
        const cached = await redis.get<PORecommendation[]>(cacheKey);
        if (cached) {
          console.log('[ReportingStorage] Cache hit for PO recommendations');
          return cached;
        }
      } catch (error) {
        console.error('[ReportingStorage] Redis error fetching recommendations:', error);
      }
    }

    // Whitelist allowed sort columns to prevent SQL injection
    // IMPORTANT: Must match all SortableHeader columns in client/src/pages/po-recommendations.tsx
    // Database contains additional columns (kit_driven_velocity, individual_velocity, etc.)
    // that are not exposed in the UI and should NOT be added to this whitelist
    const allowedSortColumns = [
      'sku', 'supplier', 'title', 'lead_time', 'current_total_stock', 
      'recommended_quantity', 'base_velocity', 'projected_velocity',
      'growth_rate', 'ninety_day_forecast', 'current_days_cover', 
      'quantity_incoming', 'next_holiday_count_down_in_days'
    ];
    
    const safeSortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'sku';
    const safeSortOrder = sortOrder === 'desc' ? 'DESC' : 'ASC';

    // Build WHERE conditions
    const whereClauses = [];
    
    if (stockCheckDate) {
      whereClauses.push(reportingSql`stock_check_date = ${stockCheckDate}`);
    }
    
    if (supplier) {
      whereClauses.push(reportingSql`supplier = ${supplier}`);
    }
    
    if (search) {
      const searchPattern = `%${search}%`;
      whereClauses.push(reportingSql`(
        sku ILIKE ${searchPattern} OR 
        title ILIKE ${searchPattern} OR 
        supplier ILIKE ${searchPattern}
      )`);
    }

    // Build the complete query using postgres.js composition
    let query;
    if (whereClauses.length > 0) {
      const whereCondition = whereClauses.reduce((acc, clause, i) => 
        i === 0 ? clause : reportingSql`${acc} AND ${clause}`
      );
      
      query = reportingSql`
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
        WHERE ${whereCondition}
        ORDER BY ${reportingSql(safeSortColumn)} ${reportingSql.unsafe(safeSortOrder)}
      `;
    } else {
      query = reportingSql`
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
        ORDER BY ${reportingSql(safeSortColumn)} ${reportingSql.unsafe(safeSortOrder)}
      `;
    }
    
    const results = await query;
    const recommendations = results as PORecommendation[];

    // Cache the results (only if shouldCache is true)
    if (shouldCache) {
      try {
        const redis = getRedisClient();
        await redis.set(cacheKey, recommendations, { ex: CACHE_TTL });
        console.log('[ReportingStorage] Cached PO recommendations');
      } catch (error) {
        console.error('[ReportingStorage] Redis error caching recommendations:', error);
      }
    }

    return recommendations;
  }

  async getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]> {
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

    return results as PORecommendationStep[];
  }

  async getUniqueSuppliers(): Promise<string[]> {
    const cacheKey = `${CACHE_PREFIX}unique_suppliers`;
    
    try {
      const redis = getRedisClient();
      const cached = await redis.get<string[]>(cacheKey);
      if (cached) {
        return cached;
      }
    } catch (error) {
      console.error('[ReportingStorage] Redis error fetching suppliers:', error);
    }

    const results = await reportingSql`
      SELECT DISTINCT supplier
      FROM vw_po_recommendations
      WHERE supplier IS NOT NULL
      ORDER BY supplier
    `;

    const suppliers = results.map((r: any) => r.supplier);

    try {
      const redis = getRedisClient();
      await redis.set(cacheKey, suppliers, { ex: CACHE_TTL });
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
