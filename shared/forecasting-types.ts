export enum TimeRangePreset {
  LAST_30_DAYS = 'last_30_days',
  LAST_60_DAYS = 'last_60_days',
  LAST_90_DAYS = 'last_90_days',
  LAST_12_MONTHS = 'last_12_months',
  YEAR_TO_DATE = 'year_to_date',
  CURRENT_MONTH = 'current_month',
  CUSTOM = 'custom',
}

export const TIME_RANGE_LABELS: Record<TimeRangePreset, string> = {
  [TimeRangePreset.LAST_30_DAYS]: 'Last 30 Days',
  [TimeRangePreset.LAST_60_DAYS]: 'Last 60 Days',
  [TimeRangePreset.LAST_90_DAYS]: 'Last 90 Days',
  [TimeRangePreset.LAST_12_MONTHS]: 'Last 12 Months',
  [TimeRangePreset.YEAR_TO_DATE]: 'Year to Date',
  [TimeRangePreset.CURRENT_MONTH]: 'Current Month',
  [TimeRangePreset.CUSTOM]: 'Custom Range',
};

export const TIME_RANGE_DAYS: Record<string, number> = {
  [TimeRangePreset.LAST_30_DAYS]: 30,
  [TimeRangePreset.LAST_60_DAYS]: 60,
  [TimeRangePreset.LAST_90_DAYS]: 90,
  [TimeRangePreset.LAST_12_MONTHS]: 365,
};

export interface SalesDataPoint {
  orderDate: string;
  salesChannel: string;
  totalRevenue: number;
  totalQuantity: number;
}

export type BooleanFilter = 'true' | 'false' | 'either';

export interface ForecastingProduct {
  sku: string;
  title: string;
  category: string | null;
}

export interface ForecastingProductsResponse {
  products: ForecastingProduct[];
}

export interface ForecastingSalesParams {
  preset: TimeRangePreset;
  channels?: string[];
  skus?: string[];
  startDate?: string;
  endDate?: string;
  isAssembledProduct?: BooleanFilter;
  category?: string;
  eventType?: string;
  isPeakSeason?: BooleanFilter;
}

export interface ForecastingSalesResponse {
  data: SalesDataPoint[];
  params: {
    preset: TimeRangePreset;
    startDate: string;
    endDate: string;
    channels: string[];
  };
}

export interface ForecastingChannelsResponse {
  channels: string[];
}

export interface ForecastingFilterOptionsResponse {
  categories: string[];
  eventTypes: string[];
}

export interface RevenueTimeSeriesPoint {
  date: string;
  dailyRevenue: number;
  yoyRevenue: number;
  dailyQuantity: number;
  yoyQuantity: number;
}

export interface RevenueTimeSeriesResponse {
  data: RevenueTimeSeriesPoint[];
  params: {
    preset: TimeRangePreset;
    startDate: string;
    endDate: string;
  };
}

export interface ChannelGrowthFactor {
  channel: string;
  yoyGrowthFactor: number;
}

export interface ChannelTrendFactor {
  channel: string;
  trendFactor: number;
}

export interface SummaryMetrics {
  totalRevenue: number;
  totalUnits: number;
  totalOrders: number | null;
  yoyTotalRevenue: number;
  yoyTotalUnits: number;
  yoyRevenueChangePct: number | null;
  yoyUnitsChangePct: number | null;
  yoyGrowthByChannel: ChannelGrowthFactor[];
  trendByChannel: ChannelTrendFactor[];
  confidenceLevel: 'critical' | 'warning' | 'normal' | null;
}

export interface SummaryMetricsResponse {
  data: SummaryMetrics;
  params: {
    preset: TimeRangePreset;
    startDate: string;
    endDate: string;
  };
}
