import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { useSearch, useLocation, useRoute } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import { Input } from "@/components/ui/input";
import { TrendingUp, TrendingDown, ChevronDown, Check, Loader2, CalendarIcon, Pencil, Trash2, MessageSquarePlus, X, DollarSign, Package, Activity, ShieldCheck, Search, ListFilter, RefreshCw, Download, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ForecastingProduct } from "@shared/forecasting-types";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import {
  TimeRangePreset,
  TIME_RANGE_LABELS,
} from "@shared/forecasting-types";
import type { SalesDataPoint, RevenueTimeSeriesPoint } from "@shared/forecasting-types";
import { useSalesData, useSalesChannels, useFilterOptions, useProducts, useRevenueTimeSeries, useKitTimeSeries, useSummaryMetrics, useChartNotes, useCreateChartNote, useUpdateChartNote, useDeleteChartNote, useUpcomingPeakSeasons } from "@/hooks/use-forecasting";
import type { SalesDataFilters, PeakSeasonPreset } from "@/hooks/use-forecasting";
import type { BooleanFilter } from "@shared/forecasting-types";
import type { ChartNote } from "@shared/schema";
import { useUserPreference } from "@/hooks/use-user-preference";
import { format, parseISO, subDays } from "date-fns";
import { toZonedTime } from "date-fns-tz";

const CENTRAL_TZ = "America/Chicago";
function getCentralToday(): string {
  return format(toZonedTime(new Date(), CENTRAL_TZ), "yyyy-MM-dd");
}

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

function MetricCard({
  title,
  value,
  formatter,
  icon: Icon,
  changeValue,
  isLoading,
}: {
  title: string;
  value: number | null | undefined;
  formatter: (v: number) => string;
  icon: React.ComponentType<{ className?: string }>;
  changeValue?: number | null;
  isLoading: boolean;
}) {
  const isChange = changeValue !== undefined;
  const isPositive = isChange && changeValue != null && changeValue >= 0;
  const isNegative = isChange && changeValue != null && changeValue < 0;

  return (
    <Card data-testid={`metric-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-sm text-muted-foreground">{title}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 h-7 sm:h-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : value != null ? (
          <div className={`text-lg sm:text-2xl font-semibold truncate ${isPositive ? 'text-green-600 dark:text-green-400' : ''} ${isNegative ? 'text-red-600 dark:text-red-400' : ''}`}>
            {formatter(value)}
          </div>
        ) : (
          <div className="text-lg sm:text-2xl font-semibold text-muted-foreground">—</div>
        )}
      </CardContent>
    </Card>
  );
}

interface TimeRangeSelectorProps {
  value: TimeRangePreset;
  onChange: (preset: TimeRangePreset) => void;
  peakSeasons?: PeakSeasonPreset[];
  onPeakSeasonSelect?: (season: PeakSeasonPreset) => void;
  activePeakSeasonKey?: string | null;
}

function TimeRangeSelector({ value, onChange, peakSeasons, onPeakSeasonSelect, activePeakSeasonKey }: TimeRangeSelectorProps) {
  const historicalPresets = [
    TimeRangePreset.LAST_30_DAYS,
    TimeRangePreset.LAST_60_DAYS,
    TimeRangePreset.LAST_90_DAYS,
    TimeRangePreset.LAST_12_MONTHS,
    TimeRangePreset.YEAR_TO_DATE,
    TimeRangePreset.CURRENT_MONTH,
  ];
  const forecastPresets = [
    TimeRangePreset.NEXT_30_DAYS,
    TimeRangePreset.NEXT_90_DAYS,
    TimeRangePreset.NEXT_12_MONTHS,
  ];

  const displayValue = activePeakSeasonKey
    ? activePeakSeasonKey
    : value;

  return (
    <Select
      value={displayValue}
      onValueChange={(v) => {
        if (v.startsWith('peak_')) {
          const season = peakSeasons?.find(
            (s) => `peak_${s.peakSeasonTypeId}_${s.year}` === v
          );
          if (season && onPeakSeasonSelect) {
            onPeakSeasonSelect(season);
          }
        } else {
          onChange(v as TimeRangePreset);
        }
      }}
    >
      <SelectTrigger className="w-[220px]" data-testid="select-time-range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Historical</div>
        {historicalPresets.map((preset) => (
          <SelectItem key={preset} value={preset} data-testid={`option-${preset}`}>
            {TIME_RANGE_LABELS[preset]}
          </SelectItem>
        ))}
        <div className="my-1 border-t" />
        <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Forecast</div>
        {forecastPresets.map((preset) => (
          <SelectItem key={preset} value={preset} data-testid={`option-${preset}`}>
            {TIME_RANGE_LABELS[preset]}
          </SelectItem>
        ))}
        {peakSeasons && peakSeasons.length > 0 && (
          <>
            <div className="my-1 border-t" />
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Peak Seasons</div>
            {peakSeasons.map((season) => {
              const key = `peak_${season.peakSeasonTypeId}_${season.year}`;
              const startFormatted = format(parseISO(season.startDate), 'MMM d');
              const endFormatted = format(parseISO(season.endDate), 'MMM d');
              return (
                <SelectItem key={key} value={key} data-testid={`option-${key}`}>
                  {season.name} {season.year} ({startFormatted} – {endFormatted})
                </SelectItem>
              );
            })}
          </>
        )}
        <div className="my-1 border-t" />
        <SelectItem value={TimeRangePreset.CUSTOM} data-testid={`option-${TimeRangePreset.CUSTOM}`}>
          {TIME_RANGE_LABELS[TimeRangePreset.CUSTOM]}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

interface ProductFilterProps {
  products: ForecastingProduct[];
  selected: string[];
  onChange: (skus: string[]) => void;
}

function ProductFilter({ products, selected, onChange }: ProductFilterProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return products;
    const q = searchQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category && p.category.toLowerCase().includes(q))
    );
  }, [products, searchQuery]);

  const toggleSku = (sku: string) => {
    if (selected.includes(sku)) {
      onChange(selected.filter((s) => s !== sku));
    } else {
      onChange([...selected, sku]);
    }
  };

  const clearAll = () => {
    onChange([]);
  };

  const label =
    selected.length === 0
      ? "All Products"
      : selected.length === 1
        ? products.find((p) => p.sku === selected[0])?.title ?? selected[0]
        : `${selected.length} Products`;

  return (
    <Popover onOpenChange={(open) => {
      if (open) {
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        setSearchQuery("");
      }
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-[200px] sm:w-[240px] justify-between"
          data-testid="button-product-filter"
        >
          {selected.length > 0 && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-2" align="start">
        <div className="relative mb-2" onKeyDown={(e) => e.stopPropagation()}>
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Search title, SKU, or category..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 text-sm"
            data-testid="input-product-search"
          />
        </div>
        {selected.length > 0 && (
          <>
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover-elevate active-elevate-2"
              onClick={clearAll}
              data-testid="button-clear-products"
            >
              <X className="h-3 w-3" />
              <span>Clear selection ({selected.length})</span>
            </button>
            <div className="my-1 h-px bg-border" />
          </>
        )}
        <div className="max-h-[280px] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-sm text-muted-foreground text-center">
              No products found
            </div>
          ) : (
            filtered.map((product) => {
              const isSelected = selected.includes(product.sku);
              return (
                <button
                  key={product.sku}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-sm hover-elevate active-elevate-2"
                  onClick={() => toggleSku(product.sku)}
                  data-testid={`button-product-${product.sku}`}
                >
                  <div
                    className={`flex h-4 w-4 mt-0.5 items-center justify-center rounded-sm border shrink-0 ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground"
                    }`}
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </div>
                  <div className="flex flex-col items-start min-w-0">
                    <span className="truncate w-full text-left">{product.title}</span>
                    <span className="text-xs text-muted-foreground truncate w-full text-left">{product.sku}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
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
          {!allSelected && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
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

function NotesTooltipContent({
  active,
  payload,
  notesByDate,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload?: Record<string, any> }>;
  notesByDate: Record<string, ChartNote[]>;
  valueFormatter: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const dataPayload = payload[0]?.payload;
  const dateLabel = dataPayload?.fullDate ?? dataPayload?.dateLabel ?? "";
  const isoDate = dataPayload?.isoDate ?? dataPayload?.date ?? "";
  const dateNotes = isoDate ? notesByDate[isoDate] ?? [] : [];

  return (
    <div
      className="rounded-md border p-2.5 text-sm shadow-md"
      style={{
        backgroundColor: "hsl(var(--card))",
        color: "hsl(var(--card-foreground))",
        borderColor: "hsl(var(--border))",
        maxWidth: 280,
      }}
    >
      <p className="font-medium mb-1">{dateLabel}</p>
      {payload.map((entry, idx) => (
        <div key={idx} className="flex items-center justify-between gap-3">
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="font-medium">{valueFormatter(entry.value)}</span>
        </div>
      ))}
      {dateNotes.length > 0 && (
        <div className="mt-2 pt-2 border-t space-y-1" style={{ borderColor: "hsl(var(--border))" }}>
          {dateNotes.map((note) => (
            <div key={note.id} className="flex items-start gap-1.5">
              <MessageSquarePlus className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-xs leading-snug whitespace-pre-wrap">{note.content}</p>
                <span className="text-[10px] text-muted-foreground">{note.authorEmail.split("@")[0]} · {format(new Date(note.createdAt), "MMM d, h:mm a")}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SalesChartProps {
  data: ChartDataRow[];
  channels: string[];
  isLoading: boolean;
  chartType: string;
  startDate?: string;
  endDate?: string;
}

function SalesChart({ data, channels, isLoading, chartType, startDate, endDate }: SalesChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedPoint, setSelectedPoint] = useState<{
    date: string;
    dateLabel: string;
    x: number;
    y: number;
  } | null>(null);

  const { data: notes } = useChartNotes(chartType, startDate, endDate);

  const notesByDate = useMemo(() => {
    const map: Record<string, ChartNote[]> = {};
    if (notes) {
      for (const note of notes) {
        if (!map[note.noteDate]) map[note.noteDate] = [];
        map[note.noteDate].push(note);
      }
    }
    return map;
  }, [notes]);

  const datesWithNotes = useMemo(() => new Set(Object.keys(notesByDate)), [notesByDate]);

  if (isLoading) {
    return (
      <div className="flex h-[250px] sm:h-[350px] lg:h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-[250px] sm:h-[350px] lg:h-[400px] items-center justify-center text-muted-foreground">
        No sales data available for the selected filters.
      </div>
    );
  }

  const todayStr = getCentralToday();
  const chartData = data.map((row) => ({
    ...row,
    fullDate: (() => { try { return format(parseISO(row.date), "MMM d, yyyy"); } catch { return row.date; } })(),
    hasNote: datesWithNotes.has(row.date),
    isForecast: row.date > todayStr,
  }));

  const todayLabel = chartData.find(d => d.date === todayStr)?.dateLabel;
  const hasForecastData = chartData.some(d => d.isForecast);

  const handleChartClick = (chartState: any) => {
    if (!chartState || !chartState.activePayload || chartState.activePayload.length === 0) return;
    const payload = chartState.activePayload[0].payload;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const clickX = chartState.chartX ?? 0;
    const clickY = chartState.chartY ?? 0;

    const popoverX = Math.min(clickX, containerRect.width - 300);
    const popoverY = Math.max(0, clickY - 20);

    setSelectedPoint({
      date: payload.date,
      dateLabel: payload.fullDate,
      x: popoverX,
      y: popoverY,
    });
  };

  const renderAnnotationDot = (props: any) => {
    const { cx, payload } = props;
    if (!payload?.hasNote) return null;
    return (
      <circle
        cx={cx}
        cy={10}
        r={4}
        fill="hsl(var(--primary))"
        stroke="hsl(var(--background))"
        strokeWidth={2}
        style={{ cursor: "pointer" }}
      />
    );
  };

  return (
    <div className="relative h-[250px] sm:h-[350px] lg:h-[400px]" ref={containerRef}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={chartData}
        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
        onClick={handleChartClick}
        style={{ cursor: "crosshair" }}
      >
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
          content={<NotesTooltipContent notesByDate={notesByDate} valueFormatter={formatCurrency} />}
        />
        <Legend />
        {todayLabel && hasForecastData && (
          <ReferenceLine
            x={todayLabel}
            stroke="hsl(var(--muted-foreground))"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{ value: "Today", position: "top", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          />
        )}
        {channels.map((channel, idx) => (
          <Line
            key={channel}
            type="monotone"
            dataKey={channel}
            stroke={getChannelColor(channel, idx)}
            strokeWidth={2}
            dot={idx === 0 ? renderAnnotationDot : false}
            activeDot={{ r: 6, style: { cursor: "pointer" } }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
    {selectedPoint && (
      <ChartNotesPopover
        notes={notesByDate[selectedPoint.date] ?? []}
        date={selectedPoint.date}
        dateLabel={selectedPoint.dateLabel}
        chartType={chartType}
        position={{ x: selectedPoint.x, y: selectedPoint.y }}
        onClose={() => setSelectedPoint(null)}
      />
    )}
    </div>
  );
}

interface DualLineChartProps {
  data: Array<Record<string, any>>;
  line1Key: string;
  line1Label: string;
  line1Color: string;
  line2Key: string;
  line2Label: string;
  line2Color: string;
  valueFormatter: (v: number) => string;
  isLoading: boolean;
  chartType: string;
  startDate?: string;
  endDate?: string;
}

function ChartNotesPopover({
  notes,
  date,
  dateLabel,
  chartType,
  position,
  onClose,
}: {
  notes: ChartNote[];
  date: string;
  dateLabel: string;
  chartType: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const createNote = useCreateChartNote();
  const updateNote = useUpdateChartNote();
  const deleteNote = useDeleteChartNote();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const handleAdd = () => {
    if (!newContent.trim()) return;
    createNote.mutate({ chartType, noteDate: date, content: newContent.trim() }, {
      onSuccess: () => setNewContent(""),
    });
  };

  const handleUpdate = (id: number) => {
    if (!editContent.trim()) return;
    updateNote.mutate({ id, content: editContent.trim() }, {
      onSuccess: () => setEditingId(null),
    });
  };

  return (
    <div
      ref={popoverRef}
      className="absolute z-50"
      style={{ left: position.x, top: position.y }}
    >
      <div className="bg-card border rounded-md shadow-lg w-72 p-3" data-testid="chart-notes-popover">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-sm font-medium">{dateLabel}</span>
          <Button size="icon" variant="ghost" onClick={onClose} data-testid="button-close-notes">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {notes.length > 0 && (
          <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
            {notes.map((note) => (
              <div key={note.id} className="text-sm border rounded-md p-2 space-y-1" data-testid={`chart-note-${note.id}`}>
                {editingId === note.id ? (
                  <div className="space-y-1">
                    <textarea
                      className="w-full text-sm border rounded-md p-1.5 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={2}
                      data-testid="input-edit-note"
                    />
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} data-testid="button-cancel-edit">
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => handleUpdate(note.id)} disabled={updateNote.isPending} data-testid="button-save-edit">
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap">{note.content}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground truncate">
                        {note.authorEmail.split("@")[0]} · {format(new Date(note.createdAt), "MMM d, h:mm a")}
                      </span>
                      <div className="flex gap-0.5 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => { setEditingId(note.id); setEditContent(note.content); }}
                          data-testid={`button-edit-note-${note.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteNote.mutate(note.id)}
                          disabled={deleteNote.isPending}
                          data-testid={`button-delete-note-${note.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <textarea
            className="w-full text-sm border rounded-md p-1.5 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Add a note..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={2}
            data-testid="input-new-note"
          />
          <Button
            size="sm"
            className="w-full"
            onClick={handleAdd}
            disabled={!newContent.trim() || createNote.isPending}
            data-testid="button-add-note"
          >
            <MessageSquarePlus className="h-4 w-4 mr-1" />
            Add Note
          </Button>
        </div>
      </div>
    </div>
  );
}

function DualLineChart({ data, line1Key, line1Label, line1Color, line2Key, line2Label, line2Color, valueFormatter, isLoading, chartType, startDate, endDate }: DualLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedPoint, setSelectedPoint] = useState<{
    date: string;
    dateLabel: string;
    x: number;
    y: number;
  } | null>(null);

  const { data: notes } = useChartNotes(chartType, startDate, endDate);

  const notesByDate = useMemo(() => {
    const map: Record<string, ChartNote[]> = {};
    if (notes) {
      for (const note of notes) {
        if (!map[note.noteDate]) map[note.noteDate] = [];
        map[note.noteDate].push(note);
      }
    }
    return map;
  }, [notes]);

  const datesWithNotes = useMemo(() => new Set(Object.keys(notesByDate)), [notesByDate]);

  if (isLoading) {
    return (
      <div className="flex h-[200px] sm:h-[280px] lg:h-[350px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex h-[200px] sm:h-[280px] lg:h-[350px] items-center justify-center text-muted-foreground">
        No data available for the selected filters.
      </div>
    );
  }

  const todayStr = getCentralToday();
  const chartData = data.map((d) => ({
    dateLabel: format(parseISO(d.date), "MMM d"),
    fullDate: format(parseISO(d.date), "MMM d, yyyy"),
    isoDate: d.date,
    hasNote: datesWithNotes.has(d.date),
    isForecast: d.date > todayStr,
    [line1Label]: d[line1Key],
    [line2Label]: d[line2Key],
  }));

  const todayLabel = chartData.find(d => d.isoDate === todayStr)?.dateLabel;
  const hasForecastData = chartData.some(d => d.isForecast);

  const handleChartClick = (chartState: any) => {
    if (!chartState || !chartState.activePayload || chartState.activePayload.length === 0) return;
    const payload = chartState.activePayload[0].payload;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return;

    const clickX = chartState.chartX ?? 0;
    const clickY = chartState.chartY ?? 0;

    const popoverX = Math.min(clickX, containerRect.width - 300);
    const popoverY = Math.max(0, clickY - 20);

    setSelectedPoint({
      date: payload.isoDate,
      dateLabel: payload.fullDate,
      x: popoverX,
      y: popoverY,
    });
  };

  const renderAnnotationDot = (props: any) => {
    const { cx, payload } = props;
    if (!payload?.hasNote) return null;
    return (
      <circle
        cx={cx}
        cy={10}
        r={4}
        fill="hsl(var(--primary))"
        stroke="hsl(var(--background))"
        strokeWidth={2}
        style={{ cursor: "pointer" }}
      />
    );
  };

  return (
    <div className="relative h-[200px] sm:h-[280px] lg:h-[350px]" ref={containerRef}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
          onClick={handleChartClick}
          style={{ cursor: "crosshair" }}
        >
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
            content={<NotesTooltipContent notesByDate={notesByDate} valueFormatter={valueFormatter} />}
          />
          <Legend />
          {todayLabel && hasForecastData && (
            <ReferenceLine
              x={todayLabel}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{ value: "Today", position: "top", fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            />
          )}
          <Line
            type="monotone"
            dataKey={line1Label}
            stroke={line1Color}
            strokeWidth={2}
            dot={renderAnnotationDot}
            activeDot={{ r: 6, style: { cursor: "pointer" } }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey={line2Label}
            stroke={line2Color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, style: { cursor: "pointer" } }}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
      {selectedPoint && (
        <ChartNotesPopover
          notes={notesByDate[selectedPoint.date] ?? []}
          date={selectedPoint.date}
          dateLabel={selectedPoint.dateLabel}
          chartType={chartType}
          position={{ x: selectedPoint.x, y: selectedPoint.y }}
          onClose={() => setSelectedPoint(null)}
        />
      )}
    </div>
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
  const skus = params.get("skus");
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
    skus: skus ? skus.split(",").filter(Boolean) : null,
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
  if (p.filters?.skus && p.filters.skus.length > 0) {
    params.set("skus", p.filters.skus.join(","));
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
  const [endMonth, setEndMonth] = useState<Date>(endValue ?? startValue ?? new Date());

  const handleStartSelect = useCallback((day: Date | undefined) => {
    if (!day) return;
    onStartChange(formatDateParam(day));
    setEndMonth(day);
    if (endValue && day > endValue) {
      onEndChange(formatDateParam(day));
    }
  }, [endValue, onStartChange, onEndChange]);

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
            onSelect={handleStartSelect}
            fixedWeeks
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
            month={endMonth}
            onMonthChange={setEndMonth}
            onSelect={(day) => day && onEndChange(formatDateParam(day))}
            disabled={(date) => (startValue ? date < startValue : false)}
            fixedWeeks
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
  skus: undefined,
  isPeakSeason: 'either',
};

function SalesTab() {
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
    skus: urlParams.skus ?? savedFilters.skus,
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
    setActivePeakSeasonKey(null);
    setSavedCustomDates({ start: date, end: customEndDate });
    buildUrl({ range: TimeRangePreset.CUSTOM, start: date });
  }, [setSavedCustomDates, buildUrl, customEndDate]);

  const setCustomEnd = useCallback((date: string) => {
    setActivePeakSeasonKey(null);
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
  const { data: productsData } = useProducts();
  const { data: peakSeasonsData } = useUpcomingPeakSeasons();

  const [activePeakSeasonKey, setActivePeakSeasonKey] = useState<string | null>(null);

  const handlePeakSeasonSelect = useCallback((season: PeakSeasonPreset) => {
    const key = `peak_${season.peakSeasonTypeId}_${season.year}`;
    setActivePeakSeasonKey(key);
    setSavedPreset(TimeRangePreset.CUSTOM);
    setSavedCustomDates({ start: season.startDate, end: season.endDate });
    buildUrl({ range: TimeRangePreset.CUSTOM, start: season.startDate, end: season.endDate });
  }, [setSavedPreset, setSavedCustomDates, buildUrl]);

  const handlePresetChange = useCallback((newPreset: TimeRangePreset) => {
    setActivePeakSeasonKey(null);
    setPreset(newPreset);
  }, [setPreset]);

  const allChannels = channelsData?.channels ?? [];
  const allProducts = productsData?.products ?? [];
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

  const { data: kitTimeSeriesResponse, isLoading: kitTimeSeriesLoading } = useKitTimeSeries(
    preset,
    hookChannels,
    preset === TimeRangePreset.CUSTOM ? customStartDate : undefined,
    preset === TimeRangePreset.CUSTOM ? customEndDate : undefined,
    activeFilters,
  );

  const { data: summaryResponse, isLoading: summaryLoading } = useSummaryMetrics(
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-foreground">Date Range</span>
            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeSelector
                value={preset}
                onChange={handlePresetChange}
                peakSeasons={peakSeasonsData ?? []}
                onPeakSeasonSelect={handlePeakSeasonSelect}
                activePeakSeasonKey={activePeakSeasonKey}
              />
              {preset === TimeRangePreset.CUSTOM && (
                <DateRangePicker
                  startDate={customStartDate}
                  endDate={customEndDate}
                  onStartChange={setCustomStart}
                  onEndChange={setCustomEnd}
                />
              )}
              <Select
                value={activeFilters.eventType ?? '__all__'}
                onValueChange={(v) => updateFilter('eventType', v === '__all__' ? undefined : v)}
              >
                <SelectTrigger className="w-[140px] sm:w-[180px]" data-testid="select-event-type">
                  {activeFilters.eventType && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
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
              <Select
                value={activeFilters.isPeakSeason ?? 'either'}
                onValueChange={(v) => updateFilter('isPeakSeason', v as BooleanFilter)}
              >
                <SelectTrigger className="w-[120px] sm:w-[150px]" data-testid="select-peak-season">
                  {activeFilters.isPeakSeason && activeFilters.isPeakSeason !== 'either' && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
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

          <div className="h-8 w-px bg-border self-end" />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-foreground">Products</span>
            <div className="flex flex-wrap items-center gap-2">
              {allProducts.length > 0 && (
                <ProductFilter
                  products={allProducts}
                  selected={activeFilters.skus ?? []}
                  onChange={(skus) => updateFilter('skus', skus.length > 0 ? skus : undefined)}
                />
              )}
              <Select
                value={activeFilters.category ?? '__all__'}
                onValueChange={(v) => updateFilter('category', v === '__all__' ? undefined : v)}
              >
                <SelectTrigger className="w-[140px] sm:w-[180px]" data-testid="select-category">
                  {activeFilters.category && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
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
              <Select
                value={activeFilters.isAssembledProduct ?? 'either'}
                onValueChange={(v) => updateFilter('isAssembledProduct', v as BooleanFilter)}
              >
                <SelectTrigger className="w-[120px] sm:w-[150px]" data-testid="select-assembled">
                  {activeFilters.isAssembledProduct && activeFilters.isAssembledProduct !== 'either' && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="either" data-testid="option-assembled-either">Either</SelectItem>
                  <SelectItem value="true" data-testid="option-assembled-true">True</SelectItem>
                  <SelectItem value="false" data-testid="option-assembled-false">False</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="h-8 w-px bg-border self-end" />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-foreground">Sales Channel</span>
            <div className="flex flex-wrap items-center gap-2">
              {!channelsLoading && allChannels.length > 0 && (
                <ChannelFilter
                  channels={allChannels}
                  selected={activeChannels}
                  onChange={handleChannelChange}
                />
              )}
            </div>
          </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <MetricCard
          title="Total Revenue"
          value={summaryResponse?.data.totalRevenue}
          formatter={formatCurrency}
          icon={DollarSign}
          isLoading={summaryLoading}
        />
        <MetricCard
          title="Total Units Sold"
          value={summaryResponse?.data.totalUnits}
          formatter={(v) => v.toLocaleString()}
          icon={Package}
          isLoading={summaryLoading}
        />
        <MetricCard
          title="YoY Revenue"
          value={summaryResponse?.data.yoyRevenueChangePct}
          formatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
          icon={summaryResponse?.data.yoyRevenueChangePct != null && summaryResponse.data.yoyRevenueChangePct >= 0 ? TrendingUp : TrendingDown}
          changeValue={summaryResponse?.data.yoyRevenueChangePct}
          isLoading={summaryLoading}
        />
        <MetricCard
          title="YoY Units"
          value={summaryResponse?.data.yoyUnitsChangePct}
          formatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
          icon={summaryResponse?.data.yoyUnitsChangePct != null && summaryResponse.data.yoyUnitsChangePct >= 0 ? TrendingUp : TrendingDown}
          changeValue={summaryResponse?.data.yoyUnitsChangePct}
          isLoading={summaryLoading}
        />
        <Card data-testid="metric-card-yoy-growth">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm text-muted-foreground">YoY Growth (Period)</span>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </div>
            {summaryLoading ? (
              <div className="flex items-center gap-2 h-7 sm:h-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : summaryResponse?.data.yoyGrowthByChannel && summaryResponse.data.yoyGrowthByChannel.length > 0 ? (
              <div className="space-y-1">
                {summaryResponse.data.yoyGrowthByChannel.map((item, idx) => {
                  const changePct = (item.yoyGrowthFactor - 1) * 100;
                  const isPositive = changePct >= 0;
                  return (
                    <div key={item.channel} className="flex items-center justify-between gap-2">
                      <span className="text-xs truncate" style={{ color: getChannelColor(item.channel, idx) }}>
                        {item.channel}
                      </span>
                      <span className={`text-xs font-semibold whitespace-nowrap ${isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {isPositive ? '+' : ''}{changePct.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-lg sm:text-2xl font-semibold text-muted-foreground">—</div>
            )}
          </CardContent>
        </Card>
        <Card data-testid="metric-card-trend">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm text-muted-foreground">Trend (2wk/4wk)</span>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </div>
            {summaryLoading ? (
              <div className="flex items-center gap-2 h-7 sm:h-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : summaryResponse?.data.trendByChannel && summaryResponse.data.trendByChannel.length > 0 ? (
              <div className="space-y-1">
                {summaryResponse.data.trendByChannel.map((item, idx) => {
                  const pct = item.trendFactor * 100;
                  const isAboveAvg = item.trendFactor >= 0.5;
                  return (
                    <div key={item.channel} className="flex items-center justify-between gap-2">
                      <span className="text-xs truncate" style={{ color: getChannelColor(item.channel, idx) }}>
                        {item.channel}
                      </span>
                      <span className={`text-xs font-semibold whitespace-nowrap ${isAboveAvg ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-lg sm:text-2xl font-semibold text-muted-foreground">—</div>
            )}
          </CardContent>
        </Card>
        <Card data-testid="metric-card-confidence">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm text-muted-foreground">Confidence</span>
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            </div>
            {summaryLoading ? (
              <div className="flex items-center gap-2 h-7 sm:h-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : summaryResponse?.data.confidenceByChannel && summaryResponse.data.confidenceByChannel.length > 0 ? (
              <div className="space-y-1">
                {summaryResponse.data.confidenceByChannel.map((item, idx) => {
                  const colorClass = item.confidenceLevel === 'normal'
                    ? 'text-green-600 dark:text-green-400'
                    : item.confidenceLevel === 'warning'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-red-600 dark:text-red-400';
                  return (
                    <div key={item.channel} className="flex items-center justify-between gap-2">
                      <span className="text-xs truncate" style={{ color: getChannelColor(item.channel, idx) }}>
                        {item.channel}
                      </span>
                      <span className={`text-xs font-semibold uppercase whitespace-nowrap ${colorClass}`}>
                        {item.confidenceLevel}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-lg sm:text-2xl font-semibold text-muted-foreground">—</div>
            )}
          </CardContent>
        </Card>
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
            chartType="sales_by_channel"
            startDate={salesResponse?.params?.startDate}
            endDate={salesResponse?.params?.endDate}
          />
        </CardContent>
      </Card>

      {(() => {
        const currentYear = timeSeriesResponse?.params
          ? parseISO(timeSeriesResponse.params.startDate).getFullYear()
          : new Date().getFullYear();
        const priorYear = currentYear - 1;
        const tsStart = timeSeriesResponse?.params?.startDate;
        const tsEnd = timeSeriesResponse?.params?.endDate;
        return (
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
                  line1Label={`Revenue ${currentYear}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyRevenue"
                  line2Label={`Revenue ${priorYear}`}
                  line2Color="#FF9900"
                  valueFormatter={formatCurrency}
                  isLoading={timeSeriesLoading}
                  chartType="revenue_yoy"
                  startDate={tsStart}
                  endDate={tsEnd}
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
                  line1Label={`Units ${currentYear}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyQuantity"
                  line2Label={`Units ${priorYear}`}
                  line2Color="#FF9900"
                  valueFormatter={(v) => v.toLocaleString()}
                  isLoading={timeSeriesLoading}
                  chartType="units_yoy"
                  startDate={tsStart}
                  endDate={tsEnd}
                />
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {(() => {
        const currentYear = kitTimeSeriesResponse?.params
          ? parseISO(kitTimeSeriesResponse.params.startDate).getFullYear()
          : new Date().getFullYear();
        const priorYear = currentYear - 1;
        const kitStart = kitTimeSeriesResponse?.params?.startDate;
        const kitEnd = kitTimeSeriesResponse?.params?.endDate;
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-base font-medium" data-testid="text-kit-revenue-yoy-title">
                  Kit Daily Sales Revenue (YoY)
                </CardTitle>
                {kitTimeSeriesResponse?.params && (
                  <span className="text-sm text-muted-foreground" data-testid="text-kit-revenue-yoy-range">
                    {kitTimeSeriesResponse.params.startDate} — {kitTimeSeriesResponse.params.endDate}
                  </span>
                )}
              </CardHeader>
              <CardContent>
                <DualLineChart
                  data={kitTimeSeriesResponse?.data ?? []}
                  line1Key="kitDailyRevenue"
                  line1Label={`Kit Revenue ${currentYear}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyKitDailyRevenue"
                  line2Label={`Kit Revenue ${priorYear}`}
                  line2Color="#FF9900"
                  valueFormatter={formatCurrency}
                  isLoading={kitTimeSeriesLoading}
                  chartType="kit_revenue_yoy"
                  startDate={kitStart}
                  endDate={kitEnd}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-base font-medium" data-testid="text-kit-units-yoy-title">
                  Kit Units Sold (YoY)
                </CardTitle>
                {kitTimeSeriesResponse?.params && (
                  <span className="text-sm text-muted-foreground" data-testid="text-kit-units-yoy-range">
                    {kitTimeSeriesResponse.params.startDate} — {kitTimeSeriesResponse.params.endDate}
                  </span>
                )}
              </CardHeader>
              <CardContent>
                <DualLineChart
                  data={kitTimeSeriesResponse?.data ?? []}
                  line1Key="kitDailyQuantity"
                  line1Label={`Kit Units ${currentYear}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyKitDailyQuantity"
                  line2Label={`Kit Units ${priorYear}`}
                  line2Color="#FF9900"
                  valueFormatter={(v) => v.toLocaleString()}
                  isLoading={kitTimeSeriesLoading}
                  chartType="kit_units_yoy"
                  startDate={kitStart}
                  endDate={kitEnd}
                />
              </CardContent>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}

function PurchaseOrdersTab() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");

  const readinessQuery = useQuery<{
    ready: boolean;
    ifdDate: string | null;
    inventoryDate: string | null;
    localDate: string | null;
    reason: string;
  }>({
    queryKey: ["/api/purchase-orders/readiness"],
    refetchInterval: 60000,
  });

  const datesQuery = useQuery<string[]>({
    queryKey: ["/api/purchase-orders/dates"],
  });

  const snapshotQuery = useQuery<any[]>({
    queryKey: ["/api/purchase-orders/snapshot", selectedDate],
    queryFn: async () => {
      const url = selectedDate
        ? `/api/purchase-orders/snapshot?date=${selectedDate}`
        : "/api/purchase-orders/snapshot";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch snapshot");
      return res.json();
    },
    enabled: (datesQuery.data?.length ?? 0) > 0,
  });

  const createSnapshotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/purchase-orders/create-snapshot");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Snapshot Created",
        description: `${data.rowCount} products captured for ${data.stockCheckDate}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/dates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/readiness"] });
    },
    onError: (err: any) => {
      toast({
        title: "Snapshot Failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const snapshot = snapshotQuery.data ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    snapshot.forEach((r: any) => { if (r.product_category) set.add(r.product_category); });
    return Array.from(set).sort();
  }, [snapshot]);

  const suppliers = useMemo(() => {
    const set = new Set<string>();
    snapshot.forEach((r: any) => { if (r.supplier) set.add(r.supplier); });
    return Array.from(set).sort();
  }, [snapshot]);

  const filtered = useMemo(() => {
    let rows = snapshot;
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      rows = rows.filter((r: any) =>
        r.sku?.toLowerCase().includes(lower) ||
        r.product_title?.toLowerCase().includes(lower) ||
        r.description?.toLowerCase().includes(lower)
      );
    }
    if (categoryFilter !== "all") {
      rows = rows.filter((r: any) => r.product_category === categoryFilter);
    }
    if (supplierFilter !== "all") {
      rows = rows.filter((r: any) => r.supplier === supplierFilter);
    }
    return rows;
  }, [snapshot, searchTerm, categoryFilter, supplierFilter]);

  const summaryStats = useMemo(() => {
    const totalSkus = filtered.length;
    const withSupplier = filtered.filter((r: any) => r.supplier).length;
    const lowStock = filtered.filter((r: any) => (r.available_quantity ?? 0) <= 0 && !r.is_kit).length;
    const incoming = filtered.filter((r: any) => (r.quantity_incoming ?? 0) > 0).length;
    return { totalSkus, withSupplier, lowStock, incoming };
  }, [filtered]);

  const readiness = readinessQuery.data;

  const exportCsv = useCallback(() => {
    if (filtered.length === 0) return;
    const headers = ["SKU", "Title", "Category", "Supplier", "On Hand", "Available", "Incoming", "Lead Time (days)", "MOQ", "Amazon Inv", "Walmart Inv", "Total Stock", "In Kits", "Unit Cost"];
    const csvRows = [headers.join(",")];
    for (const r of filtered) {
      csvRows.push([
        r.sku, `"${(r.product_title || '').replace(/"/g, '""')}"`, r.product_category || '',
        `"${(r.supplier || '').replace(/"/g, '""')}"`, r.quantity_on_hand ?? 0, r.available_quantity ?? 0,
        r.quantity_incoming ?? '', r.lead_time ?? '', r.moq ?? '',
        r.ext_amzn_inv ?? '', r.ext_wlmt_inv ?? '', r.total_stock ?? '',
        r.quantity_in_kits ?? '', r.unit_cost ?? ''
      ].join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `po-snapshot-${selectedDate || 'latest'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, selectedDate]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <Card className="flex-1 min-w-[200px]">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2">
              {readiness?.ready ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
              ) : (
                <Clock className="w-5 h-5 text-muted-foreground shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Snapshot Status</p>
                <p className="text-sm truncate" data-testid="text-po-readiness">
                  {readinessQuery.isLoading ? "Checking..." : readiness?.reason ?? "Unknown"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Button
          onClick={() => createSnapshotMutation.mutate()}
          disabled={!readiness?.ready || createSnapshotMutation.isPending}
          data-testid="button-create-snapshot"
        >
          {createSnapshotMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          Create Snapshot
        </Button>

        {(datesQuery.data?.length ?? 0) > 0 && (
          <Select value={selectedDate ?? ""} onValueChange={(v) => setSelectedDate(v || undefined)}>
            <SelectTrigger className="w-[180px]" data-testid="select-snapshot-date">
              <SelectValue placeholder="Latest snapshot" />
            </SelectTrigger>
            <SelectContent>
              {datesQuery.data?.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0} data-testid="button-export-csv">
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground">Total SKUs</p>
            <p className="text-2xl font-semibold" data-testid="text-po-total-skus">{summaryStats.totalSkus}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground">With Supplier</p>
            <p className="text-2xl font-semibold" data-testid="text-po-with-supplier">{summaryStats.withSupplier}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground">Out of Stock</p>
            <p className="text-2xl font-semibold text-red-600 dark:text-red-400" data-testid="text-po-low-stock">{summaryStats.lowStock}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-xs text-muted-foreground">Incoming Orders</p>
            <p className="text-2xl font-semibold" data-testid="text-po-incoming">{summaryStats.incoming}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU, title, or description..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
            data-testid="input-po-search"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-po-category">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={supplierFilter} onValueChange={setSupplierFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-po-supplier">
            <SelectValue placeholder="All Suppliers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Suppliers</SelectItem>
            {suppliers.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered.length} of {snapshot.length} products
        </p>
      </div>

      {snapshotQuery.isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : snapshot.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 gap-3">
            <Package className="w-10 h-10 text-muted-foreground" />
            <p className="text-muted-foreground text-sm" data-testid="text-po-empty">
              No snapshots yet. Create one when reporting data is ready.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="flex flex-col flex-1 min-h-0">
          <div className="overflow-auto flex-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap sticky top-0 bg-card z-10">SKU</TableHead>
                  <TableHead className="min-w-[200px] sticky top-0 bg-card z-10">Title</TableHead>
                  <TableHead className="sticky top-0 bg-card z-10">Category</TableHead>
                  <TableHead className="sticky top-0 bg-card z-10">Supplier</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">On Hand</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Available</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Incoming</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Lead Time</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">MOQ</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Amzn</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Wlmt</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Total</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">In Kits</TableHead>
                  <TableHead className="text-right sticky top-0 bg-card z-10">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row: any) => {
                  const avail = row.available_quantity ?? 0;
                  const isLow = avail <= 0 && !row.is_kit;
                  return (
                    <TableRow key={row.id} data-testid={`row-po-${row.sku}`}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {row.sku}
                        {row.is_kit && <Badge variant="outline" className="ml-1 text-[10px]">Kit</Badge>}
                        {row.is_assembled_product && <Badge variant="outline" className="ml-1 text-[10px]">Asm</Badge>}
                      </TableCell>
                      <TableCell className="text-sm max-w-[250px] truncate" title={row.product_title}>
                        {row.product_title || row.description || "—"}
                      </TableCell>
                      <TableCell className="text-xs">{row.product_category || "—"}</TableCell>
                      <TableCell className="text-xs max-w-[120px] truncate" title={row.supplier}>{row.supplier || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.quantity_on_hand ?? "—"}</TableCell>
                      <TableCell className={`text-right tabular-nums ${isLow ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}>
                        {avail}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.quantity_incoming ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.lead_time != null ? `${row.lead_time}d` : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.moq ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.ext_amzn_inv ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.ext_wlmt_inv ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.total_stock ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.quantity_in_kits ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.unit_cost ? `$${Number(row.unit_cost).toFixed(2)}` : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function Forecasting() {
  const [, params] = useRoute("/forecasting/:tab?");
  const [, setLocation] = useLocation();
  const activeTab = params?.tab || "sales";

  const handleTabChange = useCallback((value: string) => {
    setLocation(value === "sales" ? "/forecasting" : `/forecasting/${value}`);
  }, [setLocation]);

  return (
    <div className="flex flex-col h-full p-4 sm:p-6 gap-4">
      <div className="flex items-center gap-3 shrink-0">
        <TrendingUp className="h-6 w-6 text-primary" />
        <h1 className="text-xl sm:text-2xl font-semibold" data-testid="text-page-title">
          Forecasting
        </h1>
      </div>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="sales" data-testid="tab-sales">Sales</TabsTrigger>
          <TabsTrigger value="purchase-orders" data-testid="tab-purchase-orders">Purchase Orders</TabsTrigger>
        </TabsList>
        <TabsContent value="sales" className="flex-1 overflow-auto mt-4">
          <SalesTab />
        </TabsContent>
        <TabsContent value="purchase-orders" className="flex flex-col flex-1 min-h-0 mt-4">
          <PurchaseOrdersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
