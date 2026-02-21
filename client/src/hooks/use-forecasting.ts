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
  selectedChannels: string[],
) {
  const channelsParam =
    selectedChannels.length > 0 ? selectedChannels.join(",") : undefined;

  return useQuery<ForecastingSalesResponse>({
    queryKey: [
      "/api/forecasting/sales",
      `?preset=${preset}${channelsParam ? `&channels=${channelsParam}` : ""}`,
    ],
    enabled: selectedChannels.length > 0,
  });
}
