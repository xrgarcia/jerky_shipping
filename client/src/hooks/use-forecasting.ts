import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type {
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
  ForecastingFilterOptionsResponse,
  ForecastingProductsResponse,
  RevenueTimeSeriesResponse,
  KitTimeSeriesResponse,
  SummaryMetricsResponse,
  BooleanFilter,
} from "@shared/forecasting-types";
import { TimeRangePreset } from "@shared/forecasting-types";
import type { ChartNote } from "@shared/schema";

export interface PeakSeasonPreset {
  peakSeasonTypeId: number;
  name: string;
  year: number;
  startDate: string;
  endDate: string;
}

export function useUpcomingPeakSeasons() {
  return useQuery<PeakSeasonPreset[]>({
    queryKey: ["/api/forecasting/peak-seasons"],
  });
}

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

export function useProducts() {
  return useQuery<ForecastingProductsResponse>({
    queryKey: ["/api/forecasting/products"],
  });
}

export interface SalesDataFilters {
  isAssembledProduct?: BooleanFilter;
  categories?: string[];
  eventType?: string;
  isPeakSeason?: BooleanFilter;
  skus?: string[];
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

  if (filters?.categories && filters.categories.length > 0) {
    params.set("categories", filters.categories.join(","));
  }

  if (filters?.eventType) {
    params.set("eventType", filters.eventType);
  }

  if (filters?.isPeakSeason && filters.isPeakSeason !== 'either') {
    params.set("isPeakSeason", filters.isPeakSeason);
  }

  if (filters?.skus && filters.skus.length > 0) {
    params.set("skus", filters.skus.join(","));
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

export function useKitTimeSeries(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
) {
  const queryString = buildFilterParams(preset, selectedChannels, customStartDate, customEndDate, filters);

  return useQuery<KitTimeSeriesResponse>({
    queryKey: ["/api/forecasting/kit-timeseries", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}

export function useSummaryMetrics(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
  filters?: SalesDataFilters,
) {
  const queryString = buildFilterParams(preset, selectedChannels, customStartDate, customEndDate, filters);

  return useQuery<SummaryMetricsResponse>({
    queryKey: ["/api/forecasting/summary-metrics", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}

export function useChartNotes(chartType: string, startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (chartType) params.set("chartType", chartType);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const qs = `?${params.toString()}`;

  return useQuery<ChartNote[]>({
    queryKey: ["/api/chart-notes", qs],
    enabled: !!chartType && !!startDate && !!endDate,
  });
}

export function useCreateChartNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { chartType: string; noteDate: string; content: string }) => {
      const res = await apiRequest("POST", "/api/chart-notes", data);
      return res.json() as Promise<ChartNote>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chart-notes"] });
    },
  });
}

export function useUpdateChartNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, content }: { id: number; content: string }) => {
      const res = await apiRequest("PATCH", `/api/chart-notes/${id}`, { content });
      return res.json() as Promise<ChartNote>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chart-notes"] });
    },
  });
}

export function useDeleteChartNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/chart-notes/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/chart-notes"] });
    },
  });
}
