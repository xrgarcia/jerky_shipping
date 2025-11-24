import { reportingSql } from './reporting-db';
import type { PORecommendation, PORecommendationStep, PORecommendationFilters } from '@shared/reporting-schema';

export interface IReportingStorage {
  getPORecommendations(filters?: PORecommendationFilters): Promise<PORecommendation[]>;
  getLatestStockCheckDate(): Promise<Date | null>;
  getPORecommendationSteps(sku: string, stockCheckDate: Date): Promise<PORecommendationStep[]>;
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
    const {
      supplier,
      stockCheckDate,
      search,
      sortBy = 'sku',
      sortOrder = 'asc'
    } = filters;

    // Whitelist allowed sort columns to prevent SQL injection
    const allowedSortColumns = [
      'sku', 'supplier', 'title', 'current_total_stock', 
      'recommended_quantity', 'base_velocity', 'ninety_day_forecast',
      'current_days_cover', 'quantity_incoming'
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
    return results as PORecommendation[];
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
}

export const reportingStorage = new ReportingStorage();
