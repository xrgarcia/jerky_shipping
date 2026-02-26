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
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { TrendingUp, TrendingDown, ChevronDown, ChevronUp, ChevronsUpDown, Check, Loader2, CalendarIcon, Pencil, Trash2, MessageSquarePlus, X, DollarSign, Package, Activity, ShieldCheck, Search, ListFilter, RefreshCw, Download, AlertCircle, CheckCircle2, Clock } from "lucide-react";
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
import type { ChartNote, PurchaseOrderConfig } from "@shared/schema";
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
    TimeRangePreset.LAST_YEAR,
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
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Recent Peak Seasons</div>
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

type MultiSelectOption = string | { label: string; value: string; sublabel?: string };

function normalizeOpt(opt: MultiSelectOption): { label: string; value: string; sublabel?: string } {
  return typeof opt === "string" ? { label: opt, value: opt } : opt;
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
  const categoriesRaw = params.get("categories");
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
    categories: categoriesRaw ? categoriesRaw.split(",").filter(Boolean) : null,
    eventTypes: eventType ? eventType.split(",").filter(Boolean) : null,
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
  if (p.channels !== null && p.channels.length > 0) {
    params.set("channels", p.channels.join(","));
  }
  if (p.range === TimeRangePreset.CUSTOM && p.startDate && p.endDate) {
    params.set("start", p.startDate);
    params.set("end", p.endDate);
  }
  if (p.filters?.isAssembledProduct && p.filters.isAssembledProduct !== 'either') {
    params.set("assembled", p.filters.isAssembledProduct);
  }
  if (p.filters?.categories && p.filters.categories.length > 0) {
    params.set("categories", p.filters.categories.join(","));
  }
  if (p.filters?.eventTypes && p.filters.eventTypes.length > 0) {
    params.set("eventType", p.filters.eventTypes.join(","));
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
  categories: undefined,
  eventTypes: undefined,
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
    categories: urlParams.categories ?? savedFilters.categories,
    eventTypes: urlParams.eventTypes ?? savedFilters.eventTypes,
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

  const setChannels = useCallback((channels: string[] | null) => {
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

  const EXCLUDED_DEFAULT_CHANNEL = 'jerkywholesale.com';

  const activeChannels = selectedChannels !== null
    ? selectedChannels
    : allChannels.filter((c) => c !== EXCLUDED_DEFAULT_CHANNEL);

  // When null (default), send the filtered list to the API once channels have loaded.
  // Before channels load, send null so the query runs immediately without filtering.
  const hookChannels = selectedChannels !== null
    ? selectedChannels
    : allChannels.length > 0
      ? allChannels.filter((c) => c !== EXCLUDED_DEFAULT_CHANNEL)
      : null;

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

  const displayChannels = salesResponse?.data
    ? Array.from(new Set(salesResponse.data.map((d) => d.salesChannel))).sort()
    : activeChannels;

  const chartData = useMemo(() => {
    if (!salesResponse?.data) return [];
    return buildChartData(salesResponse.data, displayChannels);
  }, [salesResponse?.data, displayChannels]);

  const hasActiveFilters =
    selectedChannels !== null ||
    (activeFilters.skus?.length ?? 0) > 0 ||
    (activeFilters.categories?.length ?? 0) > 0 ||
    (activeFilters.eventTypes !== undefined && activeFilters.eventTypes !== null && activeFilters.eventTypes.length > 0) ||
    (activeFilters.isPeakSeason !== undefined && activeFilters.isPeakSeason !== 'either') ||
    (activeFilters.isAssembledProduct !== undefined && activeFilters.isAssembledProduct !== 'either');

  const clearAllFilters = useCallback(() => {
    setSavedFilters(DEFAULT_FILTERS);
    setSavedChannels(null);
    buildUrl({ filters: DEFAULT_FILTERS, channels: null });
  }, [setSavedFilters, setSavedChannels, buildUrl]);

  return (
    <div className="space-y-3">
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
              <MultiSelectFilter
                label="Event Types"
                options={filterEventTypes}
                selected={activeFilters.eventTypes ?? []}
                onChange={(vals) => updateFilter('eventTypes', vals.length > 0 ? vals : undefined)}
                popoverWidth="w-[220px]"
                data-testid="select-event-type"
              />
              <Select
                value={activeFilters.isPeakSeason ?? 'either'}
                onValueChange={(v) => updateFilter('isPeakSeason', v as BooleanFilter)}
              >
                <SelectTrigger className={`w-[120px] sm:w-[150px] transition-all${activeFilters.isPeakSeason && activeFilters.isPeakSeason !== 'either' ? " ring-1 ring-primary/50 border-primary/50" : ""}`} data-testid="select-peak-season">
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
                <MultiSelectFilter
                  label="Product"
                  options={allProducts.map((p) => ({ label: p.title, value: p.sku, sublabel: p.sku }))}
                  selected={activeFilters.skus ?? []}
                  onChange={(skus) => updateFilter('skus', skus.length > 0 ? skus : undefined)}
                  popoverWidth="w-[300px]"
                  data-testid="select-products-filter"
                />
              )}
              {filterCategories.length > 0 && (
                <MultiSelectFilter
                  label="Category"
                  options={filterCategories}
                  selected={activeFilters.categories ?? []}
                  onChange={(cats) => updateFilter('categories', cats.length > 0 ? cats : undefined)}
                  data-testid="select-category-filter"
                />
              )}
              <Select
                value={activeFilters.isAssembledProduct ?? 'either'}
                onValueChange={(v) => updateFilter('isAssembledProduct', v as BooleanFilter)}
              >
                <SelectTrigger className={`w-[120px] sm:w-[150px] transition-all${activeFilters.isAssembledProduct && activeFilters.isAssembledProduct !== 'either' ? " ring-1 ring-primary/50 border-primary/50" : ""}`} data-testid="select-assembled">
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
                <MultiSelectFilter
                  label="Channel"
                  options={allChannels}
                  selected={selectedChannels ?? activeChannels}
                  isActive={selectedChannels !== null}
                  onChange={(channels) => setChannels(channels.length === 0 ? null : channels)}
                  data-testid="select-channel-filter"
                />
              )}
            </div>
          </div>

          {hasActiveFilters && (
            <div className="ml-auto flex items-end pb-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                className="text-muted-foreground gap-1.5"
                data-testid="button-clear-all-filters"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </Button>
            </div>
          )}
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
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {chartData.length > 0 && (
              <span className="text-sm font-semibold" data-testid="text-channel-total">
                {formatCurrency(chartData.reduce((sum, row) => {
                  return sum + displayChannels.reduce((s, ch) => s + (Number(row[ch]) || 0), 0);
                }, 0))}
              </span>
            )}
            {salesResponse?.params && (
              <span className="text-sm text-muted-foreground" data-testid="text-date-range">
                {salesResponse.params.startDate} — {salesResponse.params.endDate}
              </span>
            )}
          </div>
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
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {(timeSeriesResponse?.data?.length ?? 0) > 0 && (() => {
                    const rows = timeSeriesResponse!.data;
                    const cur = rows.reduce((s, r) => s + (Number(r.dailyRevenue) || 0), 0);
                    const prior = rows.reduce((s, r) => s + (Number(r.yoyRevenue) || 0), 0);
                    return (
                      <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-revenue-yoy-totals">
                        <span className="font-semibold text-foreground">{formatCurrency(cur)}</span>
                        {" vs "}
                        <span>{formatCurrency(prior)}</span>
                      </span>
                    );
                  })()}
                  {timeSeriesResponse?.params && (
                    <span className="text-sm text-muted-foreground" data-testid="text-revenue-yoy-range">
                      {timeSeriesResponse.params.startDate} — {timeSeriesResponse.params.endDate}
                    </span>
                  )}
                </div>
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
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {(timeSeriesResponse?.data?.length ?? 0) > 0 && (() => {
                    const rows = timeSeriesResponse!.data;
                    const cur = rows.reduce((s, r) => s + (Number(r.dailyQuantity) || 0), 0);
                    const prior = rows.reduce((s, r) => s + (Number(r.yoyQuantity) || 0), 0);
                    return (
                      <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-units-yoy-totals">
                        <span className="font-semibold text-foreground">{cur.toLocaleString()}</span>
                        {" vs "}
                        <span>{prior.toLocaleString()}</span>
                      </span>
                    );
                  })()}
                  {timeSeriesResponse?.params && (
                    <span className="text-sm text-muted-foreground" data-testid="text-units-yoy-range">
                      {timeSeriesResponse.params.startDate} — {timeSeriesResponse.params.endDate}
                    </span>
                  )}
                </div>
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
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {(kitTimeSeriesResponse?.data?.length ?? 0) > 0 && (() => {
                    const rows = kitTimeSeriesResponse!.data;
                    const cur = rows.reduce((s, r) => s + (Number(r.kitDailyRevenue) || 0), 0);
                    const prior = rows.reduce((s, r) => s + (Number(r.yoyKitDailyRevenue) || 0), 0);
                    return (
                      <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-kit-revenue-yoy-totals">
                        <span className="font-semibold text-foreground">{formatCurrency(cur)}</span>
                        {" vs "}
                        <span>{formatCurrency(prior)}</span>
                      </span>
                    );
                  })()}
                  {kitTimeSeriesResponse?.params && (
                    <span className="text-sm text-muted-foreground" data-testid="text-kit-revenue-yoy-range">
                      {kitTimeSeriesResponse.params.startDate} — {kitTimeSeriesResponse.params.endDate}
                    </span>
                  )}
                </div>
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
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {(kitTimeSeriesResponse?.data?.length ?? 0) > 0 && (() => {
                    const rows = kitTimeSeriesResponse!.data;
                    const cur = rows.reduce((s, r) => s + (Number(r.kitDailyQuantity) || 0), 0);
                    const prior = rows.reduce((s, r) => s + (Number(r.yoyKitDailyQuantity) || 0), 0);
                    return (
                      <span className="text-xs text-muted-foreground tabular-nums" data-testid="text-kit-units-yoy-totals">
                        <span className="font-semibold text-foreground">{cur.toLocaleString()}</span>
                        {" vs "}
                        <span>{prior.toLocaleString()}</span>
                      </span>
                    );
                  })()}
                  {kitTimeSeriesResponse?.params && (
                    <span className="text-sm text-muted-foreground" data-testid="text-kit-units-yoy-range">
                      {kitTimeSeriesResponse.params.startDate} — {kitTimeSeriesResponse.params.endDate}
                    </span>
                  )}
                </div>
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

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  isActive,
  popoverWidth = "w-[220px]",
  "data-testid": testId,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  isActive?: boolean;
  popoverWidth?: string;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const normalized = useMemo(() => options.map(normalizeOpt), [options]);

  const filtered = normalized.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()) ||
    o.value.toLowerCase().includes(search.toLowerCase())
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every((o) => selected.includes(o.value));
  const someFilteredSelected = filtered.some((o) => selected.includes(o.value));

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const toggleAll = () => {
    if (allFilteredSelected) {
      onChange(selected.filter((v) => !filtered.some((o) => o.value === v)));
    } else {
      const toAdd = filtered.filter((o) => !selected.includes(o.value)).map((o) => o.value);
      onChange([...selected, ...toAdd]);
    }
  };

  const displayLabel = selected.length === 0
    ? `All ${label}s`
    : selected.length === 1
      ? (normalized.find((o) => o.value === selected[0])?.label ?? selected[0])
      : `${selected.length} ${label}s`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="default"
          className={`justify-between gap-2 transition-all${(isActive ?? selected.length > 0) ? " ring-1 ring-primary/50 border-primary/50" : ""}`}
          data-testid={testId}
        >
          {(isActive ?? selected.length > 0) && <ListFilter className="h-3.5 w-3.5 shrink-0 text-primary" />}
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="w-3 h-3 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={`${popoverWidth} p-0`} align="start">
        <div className="flex flex-col">
          <div className="px-2 pt-2">
            <input
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={`Search ${label.toLowerCase()}s...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">No {label.toLowerCase()}s found.</div>
            )}
            <div
              onClick={toggleAll}
              className="flex items-center gap-2 cursor-pointer px-2 py-1.5 mx-1 rounded-sm hover-elevate border-b mb-1 pb-2"
              data-testid={`${testId}-select-all`}
            >
              <Checkbox
                checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
                className="pointer-events-none"
              />
              <span className="text-sm font-medium">Select all</span>
            </div>
            {filtered.map((option) => (
              <div
                key={option.value}
                onClick={() => toggle(option.value)}
                className="flex items-center gap-2 cursor-pointer px-2 py-1.5 mx-1 rounded-sm hover-elevate"
              >
                <Checkbox
                  checked={selected.includes(option.value)}
                  className="pointer-events-none"
                />
                <div className="flex flex-col min-w-0">
                  <span className="truncate text-sm">{option.label}</span>
                  {option.sublabel && option.sublabel !== option.label && (
                    <span className="truncate text-xs text-muted-foreground">{option.sublabel}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {selected.length > 0 && (
            <div className="border-t px-2 py-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs text-muted-foreground"
                onClick={() => { onChange([]); setOpen(false); }}
              >
                Clear selection
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PurchaseOrdersTab() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const [searchTerm, setSearchTerm] = useState("");
  const { value: categoryFilter, setValue: setCategoryFilter } = useUserPreference<string[]>(
    "purchase-orders", "category-filter", [], { debounceMs: 300 }
  );
  const { value: supplierFilter, setValue: setSupplierFilter } = useUserPreference<string[]>(
    "purchase-orders", "supplier-filter", [], { debounceMs: 300 }
  );
  const [projectionDate, setProjectionDate] = useState<Date | undefined>();
  const [projectionPopoverOpen, setProjectionPopoverOpen] = useState(false);
  const [velocityStart, setVelocityStart] = useState<Date>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d;
  });
  const [velocityEnd, setVelocityEnd] = useState<Date>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  });
  const [velocityStartPopoverOpen, setVelocityStartPopoverOpen] = useState(false);
  const [velocityEndPopoverOpen, setVelocityEndPopoverOpen] = useState(false);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = useCallback((col: string) => {
    if (sortCol === col) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortCol(null); setSortDir("asc"); }
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }, [sortCol, sortDir]);

  const { value: kitFilter, setValue: setKitFilter } = useUserPreference<string>(
    "purchase-orders", "kit-filter", "no", { debounceMs: 300 }
  );
  const { value: assembledFilter, setValue: setAssembledFilter } = useUserPreference<string>(
    "purchase-orders", "assembled-filter", "either", { debounceMs: 300 }
  );

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

  const projectSalesMutation = useMutation({
    mutationFn: async ({ snapshotDate, projectionDate: projDate, velocityWindowStart, velocityWindowEnd }: { snapshotDate: string; projectionDate: string; velocityWindowStart: string; velocityWindowEnd: string }) => {
      const res = await apiRequest("POST", "/api/purchase-orders/project-sales", { snapshotDate, projectionDate: projDate, velocityWindowStart, velocityWindowEnd });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sales Projected",
        description: `${data.updatedCount} products updated with projected demand`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/snapshot"] });
    },
    onError: (err: any) => {
      toast({ title: "Projection Failed", description: err.message, variant: "destructive" });
    },
  });

  const clearProjectionMutation = useMutation({
    mutationFn: async (snapshotDate: string) => {
      const res = await apiRequest("POST", "/api/purchase-orders/clear-projection", { snapshotDate });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Projection Cleared" });
      setProjectionDate(undefined);
      saveConfigMutation.mutate({ projectionDate: null });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/snapshot"] });
    },
    onError: (err: any) => {
      toast({ title: "Clear Failed", description: err.message, variant: "destructive" });
    },
  });

  const configQuery = useQuery<PurchaseOrderConfig>({
    queryKey: ["/api/purchase-orders/config"],
  });

  const saveConfigMutation = useMutation({
    mutationFn: async (data: Partial<PurchaseOrderConfig>) => {
      const res = await apiRequest("PATCH", "/api/purchase-orders/config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/config"] });
    },
  });

  const configInitialized = useRef(false);
  useEffect(() => {
    if (!configInitialized.current && configQuery.data) {
      const cfg = configQuery.data;
      if (cfg.activeSnapshotDate) setSelectedDate(cfg.activeSnapshotDate);
      if (cfg.projectionDate) setProjectionDate(new Date(cfg.projectionDate));
      if (cfg.velocityWindowStart) setVelocityStart(new Date(cfg.velocityWindowStart));
      if (cfg.velocityWindowEnd) setVelocityEnd(new Date(cfg.velocityWindowEnd));
      configInitialized.current = true;
    }
  }, [configQuery.data]);

  const snapshot = snapshotQuery.data ?? [];
  const hasProjection = snapshot.length > 0 && snapshot[0]?.sales_projection_date != null;
  const activeProjectionDate = hasProjection ? snapshot[0].sales_projection_date : null;

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
    if (categoryFilter.length > 0) {
      rows = rows.filter((r: any) => categoryFilter.includes(r.product_category));
    }
    if (supplierFilter.length > 0) {
      rows = rows.filter((r: any) => supplierFilter.includes(r.supplier));
    }
    if (kitFilter === "yes") {
      rows = rows.filter((r: any) => r.is_kit === true);
    } else if (kitFilter === "no") {
      rows = rows.filter((r: any) => r.is_kit !== true);
    }
    if (assembledFilter === "yes") {
      rows = rows.filter((r: any) => r.is_assembled_product === true);
    } else if (assembledFilter === "no") {
      rows = rows.filter((r: any) => r.is_assembled_product !== true);
    }
    if (sortCol) {
      rows = [...rows].sort((a: any, b: any) => {
        let aVal: any, bVal: any;
        switch (sortCol) {
          case "sku": aVal = a.sku ?? ""; bVal = b.sku ?? ""; break;
          case "title": aVal = (a.product_title || a.description || "").toLowerCase(); bVal = (b.product_title || b.description || "").toLowerCase(); break;
          case "category": aVal = a.product_category ?? ""; bVal = b.product_category ?? ""; break;
          case "supplier": aVal = a.supplier ?? ""; bVal = b.supplier ?? ""; break;
          case "cost": aVal = Number(a.unit_cost ?? 0); bVal = Number(b.unit_cost ?? 0); break;
          case "on_hand": aVal = a.quantity_on_hand ?? 0; bVal = b.quantity_on_hand ?? 0; break;
          case "available": aVal = a.available_quantity ?? 0; bVal = b.available_quantity ?? 0; break;
          case "incoming": aVal = a.quantity_incoming ?? 0; bVal = b.quantity_incoming ?? 0; break;
          case "lead_time": aVal = a.lead_time ?? 0; bVal = b.lead_time ?? 0; break;
          case "moq": aVal = a.moq ?? 0; bVal = b.moq ?? 0; break;
          case "amzn": aVal = a.ext_amzn_inv ?? 0; bVal = b.ext_amzn_inv ?? 0; break;
          case "wlmt": aVal = a.ext_wlmt_inv ?? 0; bVal = b.ext_wlmt_inv ?? 0; break;
          case "in_kits": aVal = a.quantity_in_kits ?? 0; bVal = b.quantity_in_kits ?? 0; break;
          case "total": aVal = a.total_stock ?? 0; bVal = b.total_stock ?? 0; break;
          case "proj_direct": aVal = Number(a.projected_units_sold ?? 0); bVal = Number(b.projected_units_sold ?? 0); break;
          case "proj_kits": aVal = Number(a.projected_units_sold_from_kits ?? 0); bVal = Number(b.projected_units_sold_from_kits ?? 0); break;
          case "proj_total": aVal = Number(a.projected_units_sold ?? 0) + Number(a.projected_units_sold_from_kits ?? 0); bVal = Number(b.projected_units_sold ?? 0) + Number(b.projected_units_sold_from_kits ?? 0); break;
          case "daily_vel_individual": aVal = Number(a.daily_velocity_individual ?? 0); bVal = Number(b.daily_velocity_individual ?? 0); break;
          case "daily_vel_kits": aVal = Number(a.daily_velocity_kits ?? 0); bVal = Number(b.daily_velocity_kits ?? 0); break;
          case "curr_individual": aVal = Number(a.current_velocity_individual ?? 0); bVal = Number(b.current_velocity_individual ?? 0); break;
          case "curr_kits": aVal = Number(a.current_velocity_kits ?? 0); bVal = Number(b.current_velocity_kits ?? 0); break;
          case "rec_purchase": {
            const aForecast = Number(a.projected_units_sold ?? 0) + Number(a.projected_units_sold_from_kits ?? 0);
            const bForecast = Number(b.projected_units_sold ?? 0) + Number(b.projected_units_sold_from_kits ?? 0);
            const aVelocity = Number(a.current_velocity_individual ?? 0) + Number(a.current_velocity_kits ?? 0);
            const bVelocity = Number(b.current_velocity_individual ?? 0) + Number(b.current_velocity_kits ?? 0);
            aVal = Math.max(Math.round(aForecast), Math.round(aVelocity)) - (a.total_stock ?? 0);
            bVal = Math.max(Math.round(bForecast), Math.round(bVelocity)) - (b.total_stock ?? 0);
            break;
          }
          default: aVal = 0; bVal = 0;
        }
        if (typeof aVal === "string") {
          const cmp = aVal.localeCompare(bVal);
          return sortDir === "asc" ? cmp : -cmp;
        }
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      });
    }
    return rows;
  }, [snapshot, searchTerm, categoryFilter, supplierFilter, kitFilter, assembledFilter, sortCol, sortDir]);

  const summaryStats = useMemo(() => {
    const totalSkus = filtered.length;
    const withSupplier = filtered.filter((r: any) => r.supplier).length;
    const lowStock = filtered.filter((r: any) => (r.available_quantity ?? 0) <= 0 && !r.is_kit).length;
    const incoming = filtered.filter((r: any) => (r.quantity_incoming ?? 0) > 0).length;
    return { totalSkus, withSupplier, lowStock, incoming };
  }, [filtered]);

  const hasActivePoFilters =
    searchTerm !== "" ||
    categoryFilter.length > 0 ||
    supplierFilter.length > 0 ||
    kitFilter !== "no" ||
    assembledFilter !== "either";

  const clearPoFilters = useCallback(() => {
    setSearchTerm("");
    setCategoryFilter([]);
    setSupplierFilter([]);
    setKitFilter("no");
    setAssembledFilter("either");
  }, [setCategoryFilter, setSupplierFilter, setKitFilter, setAssembledFilter]);

  const readiness = readinessQuery.data;

  const exportCsv = useCallback(() => {
    if (filtered.length === 0) return;
    const headers = ["SKU", "Title", "Category", "Supplier", "Unit Cost", "On Hand", "Available", "Incoming", "Lead Time (days)", "MOQ", "Amazon Inv", "Walmart Inv", "In Kits", "Total Stock"];
    if (hasProjection) headers.push("Proj. Direct", "Proj. Kits", "Proj. Total", "Daily Vel. Individual", "Daily Vel. Kits", "Curr. Total Individual", "Curr. Total Kits", "Rec. Purchase");
    const csvRows = [headers.join(",")];
    for (const r of filtered) {
      const row = [
        r.sku, `"${(r.product_title || '').replace(/"/g, '""')}"`, r.product_category || '',
        `"${(r.supplier || '').replace(/"/g, '""')}"`, r.unit_cost ?? '',
        r.quantity_on_hand ?? 0, r.available_quantity ?? 0,
        r.quantity_incoming ?? '', r.lead_time ?? '', r.moq ?? '',
        r.ext_amzn_inv ?? '', r.ext_wlmt_inv ?? '', r.quantity_in_kits ?? '',
        r.total_stock ?? ''
      ];
      if (hasProjection) {
        const direct = Math.round(Number(r.projected_units_sold ?? 0));
        const kits = Math.round(Number(r.projected_units_sold_from_kits ?? 0));
        const projTotal = direct + kits;
        const dailyVelIndividual = Number(r.daily_velocity_individual ?? 0).toFixed(1);
        const dailyVelKits = Number(r.daily_velocity_kits ?? 0).toFixed(1);
        const currIndividual = Math.round(Number(r.current_velocity_individual ?? 0));
        const currKits = Math.round(Number(r.current_velocity_kits ?? 0));
        const maxTotal = Math.max(projTotal, currIndividual + currKits);
        const recPurchase = maxTotal - (r.total_stock ?? 0);
        row.push(String(direct), String(kits), String(projTotal), dailyVelIndividual, dailyVelKits, String(currIndividual), String(currKits), String(Math.round(recPurchase)));
      }
      csvRows.push(row.join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `po-snapshot-${selectedDate || 'latest'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, selectedDate, hasProjection]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
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
          <Select value={selectedDate ?? ""} onValueChange={(v) => { setSelectedDate(v || undefined); saveConfigMutation.mutate({ activeSnapshotDate: v || null }); }}>
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

        {snapshot.length > 0 && (
          <>
            <div className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-card" data-testid="velocity-window">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Velocity Window:</span>
              <Popover open={velocityStartPopoverOpen} onOpenChange={setVelocityStartPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs font-mono px-2" data-testid="button-velocity-start">
                    {velocityStart.toLocaleDateString('en-CA')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={velocityStart}
                    onSelect={(date) => {
                      if (date) {
                        setVelocityStart(date);
                        setVelocityStartPopoverOpen(false);
                        saveConfigMutation.mutate({ velocityWindowStart: date.toLocaleDateString('en-CA') });
                      }
                    }}
                    disabled={(date) => date >= velocityEnd || date > new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-muted-foreground">to</span>
              <Popover open={velocityEndPopoverOpen} onOpenChange={setVelocityEndPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs font-mono px-2" data-testid="button-velocity-end">
                    {velocityEnd.toLocaleDateString('en-CA')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={velocityEnd}
                    onSelect={(date) => {
                      if (date) {
                        setVelocityEnd(date);
                        setVelocityEndPopoverOpen(false);
                        saveConfigMutation.mutate({ velocityWindowEnd: date.toLocaleDateString('en-CA') });
                      }
                    }}
                    disabled={(date) => date <= velocityStart || date > new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <Popover open={projectionPopoverOpen} onOpenChange={setProjectionPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant={hasProjection ? "default" : "outline"}
                  disabled={projectSalesMutation.isPending}
                  data-testid="button-project-sales"
                >
                  {projectSalesMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <TrendingUp className="w-4 h-4 mr-2" />
                  )}
                  {hasProjection
                    ? `Projected to ${new Date(activeProjectionDate).toLocaleDateString('en-CA')}`
                    : "Project Sales"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={projectionDate}
                  onSelect={(date) => {
                    if (date) {
                      setProjectionDate(date);
                      const dateStr = date.toLocaleDateString('en-CA');
                      const snapDate = selectedDate || (datesQuery.data?.[0] ?? '');
                      setProjectionPopoverOpen(false);
                      const velStart = velocityStart.toLocaleDateString('en-CA');
                      const velEnd = velocityEnd.toLocaleDateString('en-CA');
                      projectSalesMutation.mutate({
                        snapshotDate: snapDate,
                        projectionDate: dateStr,
                        velocityWindowStart: velStart,
                        velocityWindowEnd: velEnd,
                      });
                      saveConfigMutation.mutate({
                        projectionDate: dateStr,
                        velocityWindowStart: velStart,
                        velocityWindowEnd: velEnd,
                      });
                    }
                  }}
                  disabled={(date) => date < new Date()}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            {hasProjection && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  const snapDate = selectedDate || (datesQuery.data?.[0] ?? '');
                  clearProjectionMutation.mutate(snapDate);
                }}
                disabled={clearProjectionMutation.isPending}
                data-testid="button-clear-projection"
                title="Clear projection"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
          </>
        )}
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
        <MultiSelectFilter
          label="Category"
          options={categories}
          selected={categoryFilter}
          onChange={setCategoryFilter}
          data-testid="select-po-category"
        />
        <MultiSelectFilter
          label="Supplier"
          options={suppliers}
          selected={supplierFilter}
          onChange={setSupplierFilter}
          data-testid="select-po-supplier"
        />
        <Select value={kitFilter} onValueChange={setKitFilter}>
          <SelectTrigger className="w-[120px]" data-testid="select-po-kit">
            <SelectValue placeholder="Kit" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="either">Kit: Either</SelectItem>
            <SelectItem value="yes">Kit: Yes</SelectItem>
            <SelectItem value="no">Kit: No</SelectItem>
          </SelectContent>
        </Select>
        <Select value={assembledFilter} onValueChange={setAssembledFilter}>
          <SelectTrigger className="w-[150px]" data-testid="select-po-assembled">
            <SelectValue placeholder="Assembled" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="either">AP: Either</SelectItem>
            <SelectItem value="yes">AP: Yes</SelectItem>
            <SelectItem value="no">AP: No</SelectItem>
          </SelectContent>
        </Select>
        {hasActivePoFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearPoFilters}
            className="gap-1.5 text-muted-foreground"
            data-testid="button-po-clear-filters"
          >
            <X className="w-3.5 h-3.5" />
            Clear Filters
          </Button>
        )}
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
        <Card className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <Table containerClassName="flex-1 overflow-auto">
              <TableHeader>
                <TableRow>
                  {[
                    { key: "sku", label: "SKU", width: 130 },
                    { key: "title", label: "Title", width: 220 },
                    { key: "category", label: "Category", width: 100 },
                    { key: "supplier", label: "Supplier", width: 110 },
                    { key: "cost", label: "Cost", right: true, width: 70 },
                    { key: "on_hand", label: "On Hand", right: true, width: 75 },
                    { key: "available", label: "Available", right: true, width: 80 },
                    { key: "incoming", label: "Incoming", right: true, width: 80 },
                    { key: "lead_time", label: "Lead Time", right: true, width: 80 },
                    { key: "moq", label: "MOQ", right: true, width: 65 },
                    { key: "amzn", label: "Amzn", right: true, width: 65 },
                    { key: "wlmt", label: "Wlmt", right: true, width: 65 },
                    { key: "in_kits", label: "In Kits", right: true, width: 70 },
                    { key: "total", label: "Total", right: true, width: 70 },
                  ].map((col) => (
                    <TableHead
                      key={col.key}
                      style={{ width: col.width, minWidth: col.width }}
                      className={`sticky top-0 bg-card z-10 cursor-pointer select-none whitespace-nowrap ${col.right ? "text-right" : ""}`}
                      onClick={() => toggleSort(col.key)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className={`inline-flex items-center gap-1 ${col.right ? "justify-end" : ""}`}>
                        {col.label}
                        {sortCol === col.key ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                    </TableHead>
                  ))}
                  {hasProjection && [
                    { key: "proj_direct", label: "Proj. Direct", width: 90 },
                    { key: "proj_kits", label: "Proj. Kits", width: 90 },
                    { key: "proj_total", label: "Proj. Total", width: 90 },
                    { key: "daily_vel_individual", label: "Daily Vel. Individual", width: 90 },
                    { key: "daily_vel_kits", label: "Daily Vel. Kits", width: 90 },
                    { key: "curr_individual", label: "Curr. Total Individual", width: 90 },
                    { key: "curr_kits", label: "Curr. Total Kits", width: 90 },
                    { key: "rec_purchase", label: "Rec. Purchase", width: 90 },
                  ].map((col) => (
                    <TableHead
                      key={col.key}
                      style={{ width: col.width, minWidth: col.width }}
                      className="text-right sticky top-0 bg-card z-10 cursor-pointer select-none whitespace-nowrap"
                      onClick={() => toggleSort(col.key)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        {col.label}
                        {sortCol === col.key ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row: any) => {
                  const avail = row.available_quantity ?? 0;
                  const isLow = avail <= 0 && !row.is_kit;
                  return (
                    <TableRow key={row.id} data-testid={`row-po-${row.sku}`}>
                      <TableCell style={{ width: 130, minWidth: 130 }} className="font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis">
                        {row.sku}
                        {row.is_kit && <Badge variant="outline" className="ml-1 text-[10px]">Kit</Badge>}
                        {row.is_assembled_product && <Badge variant="outline" className="ml-1 text-[10px]">Asm</Badge>}
                      </TableCell>
                      <TableCell style={{ width: 220, minWidth: 220, maxWidth: 220 }} className="text-sm truncate" title={row.product_title}>
                        {row.product_title || row.description || "—"}
                      </TableCell>
                      <TableCell style={{ width: 100, minWidth: 100, maxWidth: 100 }} className="text-xs truncate">{row.product_category || "—"}</TableCell>
                      <TableCell style={{ width: 110, minWidth: 110, maxWidth: 110 }} className="text-xs truncate" title={row.supplier}>{row.supplier || "—"}</TableCell>
                      <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.unit_cost ? `$${Number(row.unit_cost).toFixed(2)}` : "—"}</TableCell>
                      <TableCell style={{ width: 75, minWidth: 75 }} className="text-right tabular-nums">{row.quantity_on_hand ?? "—"}</TableCell>
                      <TableCell style={{ width: 80, minWidth: 80 }} className={`text-right tabular-nums ${isLow ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}>
                        {avail}
                      </TableCell>
                      <TableCell style={{ width: 80, minWidth: 80 }} className="text-right tabular-nums">{row.quantity_incoming ?? "—"}</TableCell>
                      <TableCell style={{ width: 80, minWidth: 80 }} className="text-right tabular-nums">{row.lead_time != null ? `${row.lead_time}d` : "—"}</TableCell>
                      <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.moq ?? "—"}</TableCell>
                      <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.ext_amzn_inv ?? "—"}</TableCell>
                      <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.ext_wlmt_inv ?? "—"}</TableCell>
                      <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.quantity_in_kits ?? "—"}</TableCell>
                      <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.total_stock ?? "—"}</TableCell>
                      {hasProjection && (() => {
                        const direct = Number(row.projected_units_sold ?? 0);
                        const kits = Number(row.projected_units_sold_from_kits ?? 0);
                        const total = Math.round(direct + kits);
                        const dailyVelIndividual = Number(row.daily_velocity_individual ?? 0);
                        const dailyVelKits = Number(row.daily_velocity_kits ?? 0);
                        const currIndividual = Number(row.current_velocity_individual ?? 0);
                        const currKits = Number(row.current_velocity_kits ?? 0);
                        const maxTotal = Math.max(total, Math.round(currIndividual + currKits));
                        return (
                          <>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{Math.round(direct).toLocaleString()}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{Math.round(kits).toLocaleString()}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums font-semibold">{total.toLocaleString()}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{dailyVelIndividual.toFixed(1)}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{dailyVelKits.toFixed(1)}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{Math.round(currIndividual).toLocaleString()}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">{Math.round(currKits).toLocaleString()}</TableCell>
                            <TableCell style={{ width: 90, minWidth: 90 }} className={`text-right tabular-nums font-semibold ${(maxTotal - (row.total_stock ?? 0)) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                              {Math.round(maxTotal - (row.total_stock ?? 0)).toLocaleString()}
                            </TableCell>
                          </>
                        );
                      })()}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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
    <div className="flex flex-col h-full overflow-hidden p-4 sm:p-6">
      <div className="flex items-center gap-3 shrink-0 mb-2">
        <TrendingUp className="h-6 w-6 text-primary" />
        <h1 className="text-xl sm:text-2xl font-semibold" data-testid="text-page-title">
          Forecasting
        </h1>
      </div>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0 w-fit mb-2">
          <TabsTrigger value="sales" data-testid="tab-sales">Sales</TabsTrigger>
          <TabsTrigger value="purchase-orders" data-testid="tab-purchase-orders">Purchase Orders</TabsTrigger>
        </TabsList>
        <div className="flex-1 min-h-0">
          <TabsContent value="sales" className="h-full mt-0 overflow-y-auto">
            <SalesTab />
          </TabsContent>
          <TabsContent value="purchase-orders" className="flex flex-col h-full mt-0">
            <PurchaseOrdersTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
