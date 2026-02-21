import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TrendingUp, ChevronDown, Check, Loader2 } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  TimeRangePreset,
  TIME_RANGE_LABELS,
} from "@shared/forecasting-types";
import type { SalesDataPoint } from "@shared/forecasting-types";
import { useSalesData, useSalesChannels } from "@/hooks/use-forecasting";
import { format, parseISO } from "date-fns";

const CHANNEL_COLORS: Record<string, string> = {
  "amazon.us": "#FF9900",
  "amazon.mx": "#FF6600",
  "ebay": "#0064D2",
  "etsy": "#F56400",
  "jerky.com": "#4A7C59",
  "jerkywholesale.com": "#8B6914",
  "tiktok": "#010101",
  "walmart": "#0071CE",
};

const FALLBACK_COLORS = [
  "#6366f1", "#ec4899", "#14b8a6", "#f59e0b",
  "#8b5cf6", "#ef4444", "#22c55e", "#3b82f6",
];

function getChannelColor(channel: string, index: number): string {
  return CHANNEL_COLORS[channel] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

interface ChartDataRow {
  date: string;
  dateLabel: string;
  [channel: string]: number | string;
}

function buildChartData(
  data: SalesDataPoint[],
  activeChannels: string[],
): ChartDataRow[] {
  const dateMap = new Map<string, ChartDataRow>();

  for (const point of data) {
    if (!activeChannels.includes(point.salesChannel)) continue;

    let row = dateMap.get(point.orderDate);
    if (!row) {
      row = {
        date: point.orderDate,
        dateLabel: formatDateLabel(point.orderDate),
      };
      dateMap.set(point.orderDate, row);
    }
    row[point.salesChannel] = point.totalRevenue;
  }

  return Array.from(dateMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

function formatDateLabel(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

interface TimeRangeSelectorProps {
  value: TimeRangePreset;
  onChange: (preset: TimeRangePreset) => void;
}

function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TimeRangePreset)}>
      <SelectTrigger className="w-[180px]" data-testid="select-time-range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.values(TimeRangePreset).map((preset) => (
          <SelectItem key={preset} value={preset} data-testid={`option-${preset}`}>
            {TIME_RANGE_LABELS[preset]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ChannelFilterProps {
  channels: string[];
  selected: string[];
  onChange: (channels: string[]) => void;
}

function ChannelFilter({ channels, selected, onChange }: ChannelFilterProps) {
  const allSelected = selected.length === channels.length;

  const toggleChannel = (channel: string) => {
    if (selected.includes(channel)) {
      onChange(selected.filter((c) => c !== channel));
    } else {
      onChange([...selected, channel]);
    }
  };

  const toggleAll = () => {
    if (allSelected) {
      onChange([]);
    } else {
      onChange([...channels]);
    }
  };

  const label =
    allSelected
      ? "All Channels"
      : selected.length === 0
        ? "No Channels"
        : selected.length === 1
          ? selected[0]
          : `${selected.length} Channels`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-[220px] justify-between"
          data-testid="button-channel-filter"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-2" align="start">
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover-elevate active-elevate-2"
          onClick={toggleAll}
          data-testid="button-toggle-all-channels"
        >
          <div
            className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
              allSelected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-muted-foreground"
            }`}
          >
            {allSelected && <Check className="h-3 w-3" />}
          </div>
          <span className="font-medium">Select All</span>
        </button>
        <div className="my-1 h-px bg-border" />
        {channels.map((channel, idx) => {
          const isSelected = selected.includes(channel);
          return (
            <button
              key={channel}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover-elevate active-elevate-2"
              onClick={() => toggleChannel(channel)}
              data-testid={`button-channel-${channel}`}
            >
              <div
                className={`flex h-4 w-4 items-center justify-center rounded-sm border ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground"
                }`}
              >
                {isSelected && <Check className="h-3 w-3" />}
              </div>
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: getChannelColor(channel, idx) }}
              />
              <span className="truncate">{channel}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

interface SalesChartProps {
  data: ChartDataRow[];
  channels: string[];
  isLoading: boolean;
}

function SalesChart({ data, channels, isLoading }: SalesChartProps) {
  if (isLoading) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center text-muted-foreground">
        No sales data available for the selected filters.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart data={data} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="dateLabel"
          tick={{ fontSize: 12 }}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v: number) => formatCurrency(v)}
          tick={{ fontSize: 12 }}
          width={80}
        />
        <Tooltip
          formatter={(value: number, name: string) => [formatCurrency(value), name]}
          labelFormatter={(label: string) => label}
          contentStyle={{
            borderRadius: "var(--radius)",
            border: "1px solid hsl(var(--border))",
            backgroundColor: "hsl(var(--card))",
            color: "hsl(var(--card-foreground))",
          }}
        />
        <Legend />
        {channels.map((channel, idx) => (
          <Line
            key={channel}
            type="monotone"
            dataKey={channel}
            stroke={getChannelColor(channel, idx)}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function Forecasting() {
  const [preset, setPreset] = useState<TimeRangePreset>(TimeRangePreset.LAST_30_DAYS);
  const [selectedChannels, setSelectedChannels] = useState<string[] | null>(null);

  const { data: channelsData, isLoading: channelsLoading } = useSalesChannels();

  const allChannels = channelsData?.channels ?? [];

  const activeChannels = selectedChannels ?? allChannels;

  const hookChannels = selectedChannels === null ? null : selectedChannels;

  const { data: salesResponse, isLoading: salesLoading } = useSalesData(
    preset,
    hookChannels,
  );

  const displayChannels = selectedChannels === null
    ? (salesResponse?.data
        ? [...new Set(salesResponse.data.map((d) => d.salesChannel))].sort()
        : allChannels)
    : activeChannels;

  const chartData = useMemo(() => {
    if (!salesResponse?.data) return [];
    return buildChartData(salesResponse.data, displayChannels);
  }, [salesResponse?.data, displayChannels]);

  const handleChannelChange = (channels: string[]) => {
    setSelectedChannels(channels);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">
            Forecasting
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <TimeRangeSelector value={preset} onChange={setPreset} />
          {!channelsLoading && allChannels.length > 0 && (
            <ChannelFilter
              channels={allChannels}
              selected={activeChannels}
              onChange={handleChannelChange}
            />
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-base font-medium">
            Sales Revenue by Channel
          </CardTitle>
          {salesResponse?.params && (
            <span className="text-sm text-muted-foreground" data-testid="text-date-range">
              {salesResponse.params.startDate} — {salesResponse.params.endDate}
            </span>
          )}
        </CardHeader>
        <CardContent>
          <SalesChart
            data={chartData}
            channels={displayChannels}
            isLoading={salesLoading || channelsLoading}
          />
        </CardContent>
      </Card>
    </div>
  );
}
