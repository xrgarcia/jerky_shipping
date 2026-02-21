import { useQuery } from "@tanstack/react-query";
import type {
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
  RevenueTimeSeriesResponse,
  BooleanFilter,
} from "@shared/forecasting-types";
import { TimeRangePreset } from "@shared/forecasting-types";

export function useSalesChannels() {
  return useQuery<ForecastingChannelsResponse>({
    queryKey: ["/api/forecasting/channels"],
  });
}

export function useFilterOptions() {
  return useQuery<ForecastingFilterOptionsResponse>({
    queryKey: ["/api/forecasting/filter-options"],
  });
}

export interface SalesDataFilters {
  isAssembledProduct?: BooleanFilter;
  category?: string;
  eventType?: string;
  isPeakSeason?: BooleanFilter;
}

function buildFilterParams(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
): string {
  const params = new URLSearchParams();
  params.set("preset", preset);

  if (selectedChannels && selectedChannels.length > 0) {
    params.set("channels", selectedChannels.join(","));
  }

  if (preset === TimeRangePreset.CUSTOM && customStartDate && customEndDate) {
    params.set("startDate", customStartDate);
    params.set("endDate", customEndDate);
  }

  if (filters?.isAssembledProduct && filters.isAssembledProduct !== 'either') {
    params.set("isAssembledProduct", filters.isAssembledProduct);
  }

  if (filters?.category) {
    params.set("category", filters.category);
  }

  if (filters?.eventType) {
    params.set("eventType", filters.eventType);
  }

  if (filters?.isPeakSeason && filters.isPeakSeason !== 'either') {
    params.set("isPeakSeason", filters.isPeakSeason);
  }

  return `?${params.toString()}`;
}

export function useSalesData(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
) {
  const queryString = buildFilterParams(preset, selectedChannels, customStartDate, customEndDate, filters);

  return useQuery<ForecastingSalesResponse>({
    queryKey: ["/api/forecasting/sales", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}

export function useRevenueTimeSeries(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
) {
  const queryString = buildFilterParams(preset, selectedChannels, customStartDate, customEndDate, filters);

  return useQuery<RevenueTimeSeriesResponse>({
    queryKey: ["/api/forecasting/revenue-timeseries", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}
