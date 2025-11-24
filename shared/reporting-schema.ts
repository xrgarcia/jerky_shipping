import { z } from "zod";

export interface PORecommendation {
  sku: string;
  supplier: string | null;
  title: string | null;
  lead_time: number | null;
  current_total_stock: number | null;
  base_velocity: string | null;
  projected_velocity: string | null;
  growth_rate: string | null;
  kit_driven_velocity: string | null;
  individual_velocity: string | null;
  ninety_day_forecast: string | null;
  case_adjustment_applied: number | null;
  current_days_cover: string | null;
  moq_applied: number | null;
  quantity_incoming: number | null;
  recommended_quantity: number;
  is_assembled_product: boolean | null;
  stock_check_date: Date;
  next_holiday_count_down_in_days: number | null;
  next_holiday_recommended_quantity: number | null;
  next_holiday_season: string | null;
  next_holiday_start_date: Date | null;
}

export interface PORecommendationStep {
  sku: string;
  step_name: string;
  calculation_commentary: string | null;
  stock_check_date: Date;
  raw_calculation: string;
  final_value: string;
}

export interface PORecommendationFilters {
  supplier?: string;
  stockCheckDate?: string;
  search?: string;
  sortBy?: keyof PORecommendation;
  sortOrder?: 'asc' | 'desc';
}
