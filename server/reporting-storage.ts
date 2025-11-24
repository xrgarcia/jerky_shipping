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

    let query = reportingSql`
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
      WHERE 1=1
    `;

    const conditions = [];
    
    if (stockCheckDate) {
      conditions.push(reportingSql`stock_check_date = ${stockCheckDate}`);
    }
    
    if (supplier) {
      conditions.push(reportingSql`supplier = ${supplier}`);
    }
    
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(reportingSql`(
        sku ILIKE ${searchPattern} OR 
        title ILIKE ${searchPattern} OR 
        supplier ILIKE ${searchPattern}
      )`);
    }

    if (conditions.length > 0) {
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
        WHERE ${reportingSql(conditions.reduce((acc, cond, i) => 
          i === 0 ? cond : reportingSql`${acc} AND ${cond}`
        ))}
      `;
    }

    const orderColumn = reportingSql(sortBy);
    const orderDir = sortOrder === 'desc' ? reportingSql`DESC` : reportingSql`ASC`;
    
    const results = await reportingSql`
      ${query}
      ORDER BY ${orderColumn} ${orderDir}
    `;

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
