export enum TimeRangePreset {
  LAST_30_DAYS = 'last_30_days',
  LAST_60_DAYS = 'last_60_days',
  LAST_90_DAYS = 'last_90_days',
  LAST_12_MONTHS = 'last_12_months',
}

export const TIME_RANGE_LABELS: Record<TimeRangePreset, string> = {
  [TimeRangePreset.LAST_30_DAYS]: 'Last 30 Days',
  [TimeRangePreset.LAST_60_DAYS]: 'Last 60 Days',
  [TimeRangePreset.LAST_90_DAYS]: 'Last 90 Days',
  [TimeRangePreset.LAST_12_MONTHS]: 'Last 12 Months',
};

export const TIME_RANGE_DAYS: Record<TimeRangePreset, number> = {
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

export interface ForecastingSalesParams {
  preset: TimeRangePreset;
  channels?: string[];
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
