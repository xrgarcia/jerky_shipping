import { useQuery } from "@tanstack/react-query";
import type {
  ForecastingSalesResponse,
  ForecastingChannelsResponse,
} from "@shared/forecasting-types";
import { TimeRangePreset } from "@shared/forecasting-types";

export function useSalesChannels() {
  return useQuery<ForecastingChannelsResponse>({
    queryKey: ["/api/forecasting/channels"],
  });
}

export function useSalesData(
  preset: TimeRangePreset,
  selectedChannels: string[] | null,
  customStartDate?: string,
  customEndDate?: string,
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

  const queryString = `?${params.toString()}`;

  return useQuery<ForecastingSalesResponse>({
    queryKey: ["/api/forecasting/sales", queryString],
    enabled:
      (selectedChannels === null || selectedChannels.length > 0) &&
      (preset !== TimeRangePreset.CUSTOM || (!!customStartDate && !!customEndDate)),
  });
}
