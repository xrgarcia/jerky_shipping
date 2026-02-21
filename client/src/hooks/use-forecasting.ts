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
) {
  const channelsParam =
    selectedChannels && selectedChannels.length > 0
      ? selectedChannels.join(",")
      : undefined;

  const queryString = channelsParam
    ? `?preset=${preset}&channels=${channelsParam}`
    : `?preset=${preset}`;

  return useQuery<ForecastingSalesResponse>({
    queryKey: ["/api/forecasting/sales", queryString],
    enabled: selectedChannels === null || selectedChannels.length > 0,
  });
}
