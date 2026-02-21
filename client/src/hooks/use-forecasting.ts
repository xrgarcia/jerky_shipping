import { useQuery } from "@tanstack/react-query";
import type {
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
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

export function useSalesData(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
) {
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

  const queryString = `?${params.toString()}`;

  return useQuery<ForecastingSalesResponse>({
    queryKey: ["/api/forecasting/sales", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}
