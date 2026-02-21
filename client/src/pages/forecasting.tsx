import { useMemo, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
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
import { Calendar } from "@/components/ui/calendar";
import { TrendingUp, ChevronDown, Check, Loader2, CalendarIcon } from "lucide-react";
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
import type { SalesDataPoint, RevenueTimeSeriesPoint } from "@shared/forecasting-types";
import { useSalesData, useSalesChannels, useFilterOptions, useRevenueTimeSeries } from "@/hooks/use-forecasting";
import type { SalesDataFilters } from "@/hooks/use-forecasting";
import type { BooleanFilter } from "@shared/forecasting-types";
import { useUserPreference } from "@/hooks/use-user-preference";
import { format, parseISO, subDays } from "date-fns";

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

interface DualLineChartProps {
  data: RevenueTimeSeriesPoint[];
  line1Key: keyof RevenueTimeSeriesPoint;
  line1Label: string;
  line1Color: string;
  line2Key: keyof RevenueTimeSeriesPoint;
  line2Label: string;
  line2Color: string;
  valueFormatter: (v: number) => string;
  isLoading: boolean;
}

function DualLineChart({ data, line1Key, line1Label, line1Color, line2Key, line2Label, line2Color, valueFormatter, isLoading }: DualLineChartProps) {
  if (isLoading) {
    return (
      <div className="flex h-[350px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-[350px] items-center justify-center text-muted-foreground">
        No data available for the selected filters.
      </div>
    );
  }

  const chartData = data.map((d) => ({
    dateLabel: format(parseISO(d.date), "MMM d"),
    [line1Label]: d[line1Key],
    [line2Label]: d[line2Key],
  }));

  return (
    <ResponsiveContainer width="100%" height={350}>
      <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="dateLabel"
          tick={{ fontSize: 12 }}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={(v: number) => valueFormatter(v)}
          tick={{ fontSize: 12 }}
          width={80}
        />
        <Tooltip
          formatter={(value: number, name: string) => [valueFormatter(value), name]}
          labelFormatter={(label: string) => label}
          contentStyle={{
            borderRadius: "var(--radius)",
            border: "1px solid hsl(var(--border))",
            backgroundColor: "hsl(var(--card))",
            color: "hsl(var(--card-foreground))",
          }}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey={line1Label}
          stroke={line1Color}
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        <Line
          type="monotone"
          dataKey={line2Label}
          stroke={line2Color}
          strokeWidth={2}
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function formatDateParam(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

const BOOLEAN_FILTER_VALUES: BooleanFilter[] = ['either', 'true', 'false'];

function parseUrlParams(search: string) {
  const params = new URLSearchParams(search);
  const range = params.get("range");
  const channels = params.get("channels");
  const startDate = params.get("start");
  const endDate = params.get("end");
  const isAssembledProduct = params.get("assembled");
  const category = params.get("category");
  const eventType = params.get("eventType");
  const isPeakSeason = params.get("peak");
  return {
    range: range && Object.values(TimeRangePreset).includes(range as TimeRangePreset)
      ? (range as TimeRangePreset)
      : null,
    channels: channels !== null ? channels.split(",").filter(Boolean) : null,
    startDate: startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null,
    endDate: endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : null,
    isAssembledProduct: isAssembledProduct && BOOLEAN_FILTER_VALUES.includes(isAssembledProduct as BooleanFilter)
      ? (isAssembledProduct as BooleanFilter)
      : null,
    category: category || null,
    eventType: eventType || null,
    isPeakSeason: isPeakSeason && BOOLEAN_FILTER_VALUES.includes(isPeakSeason as BooleanFilter)
      ? (isPeakSeason as BooleanFilter)
      : null,
  };
}

interface UrlBuildParams {
  range: TimeRangePreset;
  channels: string[] | null;
  startDate?: string;
  endDate?: string;
  filters?: SalesDataFilters;
}

function buildSearchString(p: UrlBuildParams): string {
  const params = new URLSearchParams();
  params.set("range", p.range);
  if (p.channels !== null) {
    params.set("channels", p.channels.join(","));
  }
  if (p.range === TimeRangePreset.CUSTOM && p.startDate && p.endDate) {
    params.set("start", p.startDate);
    params.set("end", p.endDate);
  }
  if (p.filters?.isAssembledProduct && p.filters.isAssembledProduct !== 'either') {
    params.set("assembled", p.filters.isAssembledProduct);
  }
  if (p.filters?.category) {
    params.set("category", p.filters.category);
  }
  if (p.filters?.eventType) {
    params.set("eventType", p.filters.eventType);
  }
  if (p.filters?.isPeakSeason && p.filters.isPeakSeason !== 'either') {
    params.set("peak", p.filters.isPeakSeason);
  }
  return params.toString();
}

interface DateRangePickerProps {
  startDate: string | undefined;
  endDate: string | undefined;
  onStartChange: (date: string) => void;
  onEndChange: (date: string) => void;
}

function DateRangePicker({ startDate, endDate, onStartChange, onEndChange }: DateRangePickerProps) {
  const startValue = startDate ? parseISO(startDate) : undefined;
  const endValue = endDate ? parseISO(endDate) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-[150px] justify-start text-left font-normal"
            data-testid="button-start-date"
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {startDate ? format(parseISO(startDate), "MMM d, yyyy") : "Start date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={startValue}
            onSelect={(day) => day && onStartChange(formatDateParam(day))}
            disabled={(date) => date > new Date() || (endValue ? date > endValue : false)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      <span className="text-muted-foreground text-sm">to</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-[150px] justify-start text-left font-normal"
            data-testid="button-end-date"
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {endDate ? format(parseISO(endDate), "MMM d, yyyy") : "End date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={endValue}
            onSelect={(day) => day && onEndChange(formatDateParam(day))}
            disabled={(date) => date > new Date() || (startValue ? date < startValue : false)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

const DEFAULT_FILTERS: SalesDataFilters = {
  isAssembledProduct: 'either',
  category: undefined,
  eventType: undefined,
  isPeakSeason: 'either',
};

export default function Forecasting() {
  const searchString = useSearch();
  const [, setLocation] = useLocation();

  const urlParams = useMemo(() => parseUrlParams(searchString), [searchString]);
  const hasUrlParams = urlParams.range !== null || urlParams.channels !== null;

  const {
    value: savedPreset,
    setValue: setSavedPreset,
  } = useUserPreference<TimeRangePreset>(
    "forecasting",
    "timeRange",
    TimeRangePreset.LAST_30_DAYS,
    { debounceMs: 300 },
  );

  const {
    value: savedChannels,
    setValue: setSavedChannels,
  } = useUserPreference<string[] | null>(
    "forecasting",
    "selectedChannels",
    null,
    { debounceMs: 300 },
  );

  const {
    value: savedCustomDates,
    setValue: setSavedCustomDates,
  } = useUserPreference<{ start?: string; end?: string }>(
    "forecasting",
    "customDateRange",
    { start: formatDateParam(subDays(new Date(), 30)), end: formatDateParam(new Date()) },
    { debounceMs: 300 },
  );

  const {
    value: savedFilters,
    setValue: setSavedFilters,
  } = useUserPreference<SalesDataFilters>(
    "forecasting",
    "salesFilters",
    DEFAULT_FILTERS,
    { debounceMs: 300 },
  );

  const preset = urlParams.range ?? savedPreset;
  const selectedChannels = hasUrlParams ? (urlParams.channels ?? null) : savedChannels;

  const customStartDate = urlParams.startDate ?? savedCustomDates.start;
  const customEndDate = urlParams.endDate ?? savedCustomDates.end;

  const activeFilters: SalesDataFilters = useMemo(() => ({
    isAssembledProduct: urlParams.isAssembledProduct ?? savedFilters.isAssembledProduct ?? 'either',
    category: urlParams.category ?? savedFilters.category,
    eventType: urlParams.eventType ?? savedFilters.eventType,
    isPeakSeason: urlParams.isPeakSeason ?? savedFilters.isPeakSeason ?? 'either',
  }), [urlParams, savedFilters]);

  const buildUrl = useCallback((overrides: Partial<{
    range: TimeRangePreset;
    channels: string[] | null;
    start: string;
    end: string;
    filters: SalesDataFilters;
  }> = {}) => {
    const r = overrides.range ?? preset;
    const ch = overrides.channels !== undefined ? overrides.channels : selectedChannels;
    const s = overrides.start ?? customStartDate;
    const e = overrides.end ?? customEndDate;
    const f = overrides.filters ?? activeFilters;
    const qs = buildSearchString({
      range: r,
      channels: ch,
      startDate: r === TimeRangePreset.CUSTOM ? s : undefined,
      endDate: r === TimeRangePreset.CUSTOM ? e : undefined,
      filters: f,
    });
    setLocation(`/forecasting?${qs}`, { replace: true });
  }, [preset, selectedChannels, customStartDate, customEndDate, activeFilters, setLocation]);

  const setPreset = useCallback((newPreset: TimeRangePreset) => {
    setSavedPreset(newPreset);
    buildUrl({ range: newPreset });
  }, [setSavedPreset, buildUrl]);

  const setChannels = useCallback((channels: string[]) => {
    setSavedChannels(channels);
    buildUrl({ channels });
  }, [setSavedChannels, buildUrl]);

  const setCustomStart = useCallback((date: string) => {
    setSavedCustomDates({ start: date, end: customEndDate });
    buildUrl({ range: TimeRangePreset.CUSTOM, start: date });
  }, [setSavedCustomDates, buildUrl, customEndDate]);

  const setCustomEnd = useCallback((date: string) => {
    setSavedCustomDates({ start: customStartDate, end: date });
    buildUrl({ range: TimeRangePreset.CUSTOM, end: date });
  }, [setSavedCustomDates, buildUrl, customStartDate]);

  const updateFilter = useCallback(<K extends keyof SalesDataFilters>(key: K, value: SalesDataFilters[K]) => {
    const newFilters = { ...activeFilters, [key]: value };
    setSavedFilters(newFilters);
    buildUrl({ filters: newFilters });
  }, [activeFilters, setSavedFilters, buildUrl]);

  const { data: channelsData, isLoading: channelsLoading } = useSalesChannels();
  const { data: filterOptionsData } = useFilterOptions();

  const allChannels = channelsData?.channels ?? [];
  const filterCategories = filterOptionsData?.categories ?? [];
  const filterEventTypes = filterOptionsData?.eventTypes ?? [];

  const activeChannels = selectedChannels ?? allChannels;

  const hookChannels = selectedChannels === null ? null : selectedChannels;

  const { data: salesResponse, isLoading: salesLoading } = useSalesData(
    preset,
    hookChannels,
    preset === TimeRangePreset.CUSTOM ? customStartDate : undefined,
    preset === TimeRangePreset.CUSTOM ? customEndDate : undefined,
    activeFilters,
  );

  const { data: timeSeriesResponse, isLoading: timeSeriesLoading } = useRevenueTimeSeries(
    preset,
    hookChannels,
    preset === TimeRangePreset.CUSTOM ? customStartDate : undefined,
    preset === TimeRangePreset.CUSTOM ? customEndDate : undefined,
    activeFilters,
  );

  const displayChannels = selectedChannels === null
    ? (salesResponse?.data
        ? Array.from(new Set(salesResponse.data.map((d) => d.salesChannel))).sort()
        : allChannels)
    : activeChannels;

  const chartData = useMemo(() => {
    if (!salesResponse?.data) return [];
    return buildChartData(salesResponse.data, displayChannels);
  }, [salesResponse?.data, displayChannels]);

  const handleChannelChange = (channels: string[]) => {
    setChannels(channels);
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
        <div className="flex flex-wrap items-end gap-3">
          <TimeRangeSelector value={preset} onChange={setPreset} />
          {preset === TimeRangePreset.CUSTOM && (
            <DateRangePicker
              startDate={customStartDate}
              endDate={customEndDate}
              onStartChange={setCustomStart}
              onEndChange={setCustomEnd}
            />
          )}
          {!channelsLoading && allChannels.length > 0 && (
            <ChannelFilter
              channels={allChannels}
              selected={activeChannels}
              onChange={handleChannelChange}
            />
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Assembled</span>
            <Select
              value={activeFilters.isAssembledProduct ?? 'either'}
              onValueChange={(v) => updateFilter('isAssembledProduct', v as BooleanFilter)}
            >
              <SelectTrigger className="w-[150px]" data-testid="select-assembled">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="either" data-testid="option-assembled-either">Either</SelectItem>
                <SelectItem value="true" data-testid="option-assembled-true">True</SelectItem>
                <SelectItem value="false" data-testid="option-assembled-false">False</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Category</span>
            <Select
              value={activeFilters.category ?? '__all__'}
              onValueChange={(v) => updateFilter('category', v === '__all__' ? undefined : v)}
            >
              <SelectTrigger className="w-[180px]" data-testid="select-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__" data-testid="option-category-all">All Categories</SelectItem>
                {filterCategories.map((cat) => (
                  <SelectItem key={cat} value={cat} data-testid={`option-category-${cat}`}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Event Type</span>
            <Select
              value={activeFilters.eventType ?? '__all__'}
              onValueChange={(v) => updateFilter('eventType', v === '__all__' ? undefined : v)}
            >
              <SelectTrigger className="w-[180px]" data-testid="select-event-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__" data-testid="option-event-all">All Event Types</SelectItem>
                {filterEventTypes.map((et) => (
                  <SelectItem key={et} value={et} data-testid={`option-event-${et}`}>
                    {et}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Peak Season</span>
            <Select
              value={activeFilters.isPeakSeason ?? 'either'}
              onValueChange={(v) => updateFilter('isPeakSeason', v as BooleanFilter)}
            >
              <SelectTrigger className="w-[150px]" data-testid="select-peak-season">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="either" data-testid="option-peak-either">Either</SelectItem>
                <SelectItem value="true" data-testid="option-peak-true">True</SelectItem>
                <SelectItem value="false" data-testid="option-peak-false">False</SelectItem>
              </SelectContent>
            </Select>
          </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-base font-medium" data-testid="text-revenue-yoy-title">
              Total Daily Sales Revenue (YoY)
            </CardTitle>
            {timeSeriesResponse?.params && (
              <span className="text-sm text-muted-foreground" data-testid="text-revenue-yoy-range">
                {timeSeriesResponse.params.startDate} — {timeSeriesResponse.params.endDate}
              </span>
            )}
          </CardHeader>
          <CardContent>
            <DualLineChart
              data={timeSeriesResponse?.data ?? []}
              line1Key="dailyRevenue"
              line1Label="Daily Revenue"
              line1Color="hsl(var(--primary))"
              line2Key="yoyRevenue"
              line2Label="YoY Revenue"
              line2Color="#FF9900"
              valueFormatter={formatCurrency}
              isLoading={timeSeriesLoading}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-base font-medium" data-testid="text-units-yoy-title">
              Total Units Sold (YoY)
            </CardTitle>
            {timeSeriesResponse?.params && (
              <span className="text-sm text-muted-foreground" data-testid="text-units-yoy-range">
                {timeSeriesResponse.params.startDate} — {timeSeriesResponse.params.endDate}
              </span>
            )}
          </CardHeader>
          <CardContent>
            <DualLineChart
              data={timeSeriesResponse?.data ?? []}
              line1Key="dailyQuantity"
              line1Label="Daily Units"
              line1Color="hsl(var(--primary))"
              line2Key="yoyQuantity"
              line2Label="YoY Units"
              line2Color="#FF9900"
              valueFormatter={(v) => v.toLocaleString()}
              isLoading={timeSeriesLoading}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
