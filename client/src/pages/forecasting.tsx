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
import { TrendingUp, TrendingDown, ChevronDown, ChevronUp, ChevronsUpDown, Check, Loader2, CalendarIcon, Pencil, Trash2, MessageSquarePlus, X, DollarSign, Package, Activity, ShieldCheck, Search, ListFilter, RefreshCw, RotateCcw, Download, AlertCircle, CheckCircle2, Clock, SlidersHorizontal, Copy, Info, BarChart2, MessageSquare } from "lucide-react";
import { Tooltip as HoverTooltip, TooltipTrigger as HoverTooltipTrigger, TooltipContent as HoverTooltipContent } from "@/components/ui/tooltip";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";

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

function buildYearRangeLabel(
  startStr: string | undefined,
  endStr: string | undefined
): { current: string; prior: string } {
  const now = new Date().getFullYear();
  const sy = startStr ? parseISO(startStr).getFullYear() : now;
  const ey = endStr ? parseISO(endStr).getFullYear() : now;
  if (sy === ey) {
    return { current: String(ey), prior: String(ey - 1) };
  }
  return { current: `${sy}–${ey}`, prior: `${sy - 1}–${ey - 1}` };
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
  tooltip,
}: {
  title: string;
  value: number | null | undefined;
  formatter: (v: number) => string;
  icon: React.ComponentType<{ className?: string }>;
  changeValue?: number | null;
  isLoading: boolean;
  tooltip?: string;
}) {
  const isChange = changeValue !== undefined;
  const isPositive = isChange && changeValue != null && changeValue >= 0;
  const isNegative = isChange && changeValue != null && changeValue < 0;

  return (
    <Card data-testid={`metric-card-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">{title}</span>
            {tooltip && (
              <HoverTooltip>
                <HoverTooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </HoverTooltipTrigger>
                <HoverTooltipContent side="top" className="max-w-xs text-xs">
                  {tooltip}
                </HoverTooltipContent>
              </HoverTooltip>
            )}
          </div>
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
  if (typeof opt === "string") return { label: opt, value: opt };
  return {
    label: opt.label != null ? String(opt.label) : "",
    value: opt.value != null ? String(opt.value) : "",
    sublabel: opt.sublabel,
  };
}


function NotesTooltipContent({
  active,
  payload,
  notesByDate,
  valueFormatter,
  labelFormatters,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload?: Record<string, any> }>;
  notesByDate: Record<string, ChartNote[]>;
  valueFormatter: (v: number) => string;
  labelFormatters?: [(payload: Record<string, any>) => string, (payload: Record<string, any>) => string];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const dataPayload = payload[0]?.payload ?? {};
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
      {payload.map((entry, idx) => {
        const label = labelFormatters && idx < 2
          ? labelFormatters[idx](dataPayload)
          : entry.name;
        return (
          <div key={idx} className="flex items-center justify-between gap-3">
            <span style={{ color: entry.color }}>{label}</span>
            <span className="font-medium">{valueFormatter(entry.value)}</span>
          </div>
        );
      })}
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
    const { cx, payload, index } = props;
    if (!payload?.hasNote) return null;
    return (
      <circle
        key={index}
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
  labelFormatters?: [(payload: Record<string, any>) => string, (payload: Record<string, any>) => string];
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

function DualLineChart({ data, line1Key, line1Label, line1Color, line2Key, line2Label, line2Color, valueFormatter, isLoading, chartType, startDate, endDate, labelFormatters }: DualLineChartProps) {
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
    year: d.year ?? parseInt(d.date.slice(0, 4), 10),
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
    const { cx, payload, index } = props;
    if (!payload?.hasNote) return null;
    return (
      <circle
        key={index}
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
            content={<NotesTooltipContent notesByDate={notesByDate} valueFormatter={valueFormatter} labelFormatters={labelFormatters} />}
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
      {/* Row 1: Date Range + Sales Channel */}
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
                <SelectTrigger className={`w-[185px] transition-all${activeFilters.isPeakSeason && activeFilters.isPeakSeason !== 'either' ? " ring-1 ring-primary/50 border-primary/50" : ""}`} data-testid="select-peak-season">
                  {activeFilters.isPeakSeason && activeFilters.isPeakSeason !== 'either' && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
                  <span className="truncate text-sm">
                    {"Peak Season: " + (activeFilters.isPeakSeason === 'true' ? 'Yes' : activeFilters.isPeakSeason === 'false' ? 'No' : 'Either')}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="either" data-testid="option-peak-either">Either</SelectItem>
                  <SelectItem value="true" data-testid="option-peak-true">Yes</SelectItem>
                  <SelectItem value="false" data-testid="option-peak-false">No</SelectItem>
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

      {/* Row 2: Products */}
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
          <SelectTrigger className={`w-[185px] transition-all${activeFilters.isAssembledProduct && activeFilters.isAssembledProduct !== 'either' ? " ring-1 ring-primary/50 border-primary/50" : ""}`} data-testid="select-assembled">
            {activeFilters.isAssembledProduct && activeFilters.isAssembledProduct !== 'either' && <ListFilter className="mr-1 h-3.5 w-3.5 shrink-0 text-primary" />}
            <span className="truncate text-sm">
              {"Assembled: " + (activeFilters.isAssembledProduct === 'true' ? 'Yes' : activeFilters.isAssembledProduct === 'false' ? 'No' : 'Either')}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="either" data-testid="option-assembled-either">Either</SelectItem>
            <SelectItem value="true" data-testid="option-assembled-true">Yes</SelectItem>
            <SelectItem value="false" data-testid="option-assembled-false">No</SelectItem>
          </SelectContent>
        </Select>
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
        <Card data-testid="metric-card-avgs-per-day">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm text-muted-foreground">Avgs per Day</span>
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
            </div>
            {summaryLoading ? (
              <div className="flex items-center gap-2 h-7 sm:h-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-1 mt-1">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-xs text-muted-foreground">Units</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {summaryResponse?.data.avgDailyUnits != null
                      ? summaryResponse.data.avgDailyUnits.toLocaleString(undefined, { maximumFractionDigits: 1 })
                      : '—'}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-xs text-muted-foreground">Revenue</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {summaryResponse?.data.avgDailyRevenue != null
                      ? formatCurrency(summaryResponse.data.avgDailyRevenue)
                      : '—'}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <MetricCard
          title="YoY Revenue"
          value={summaryResponse?.data.yoyRevenueChangePct}
          formatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
          icon={summaryResponse?.data.yoyRevenueChangePct != null && summaryResponse.data.yoyRevenueChangePct >= 0 ? TrendingUp : TrendingDown}
          changeValue={summaryResponse?.data.yoyRevenueChangePct}
          isLoading={summaryLoading}
          tooltip="Compares the selected period's revenue against the same period one year prior. For historical dates this is actual current-year vs. last-year revenue from the GCP reporting database. For future dates it uses last year's actuals vs. two years ago stored in the sales_forecasting table as a growth proxy."
        />
        <MetricCard
          title="YoY Units"
          value={summaryResponse?.data.yoyUnitsChangePct}
          formatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
          icon={summaryResponse?.data.yoyUnitsChangePct != null && summaryResponse.data.yoyUnitsChangePct >= 0 ? TrendingUp : TrendingDown}
          changeValue={summaryResponse?.data.yoyUnitsChangePct}
          isLoading={summaryLoading}
          tooltip="Compares the selected period's unit sales against the same period one year prior. For historical dates this is actual current-year vs. last-year units from the GCP reporting database. For future dates it uses last year's actuals vs. two years ago stored in the sales_forecasting table as a growth proxy."
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
        const tsStart = timeSeriesResponse?.params?.startDate;
        const tsEnd = timeSeriesResponse?.params?.endDate;
        const { current: currentYearLabel, prior: priorYearLabel } = buildYearRangeLabel(tsStart, tsEnd);
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
                  line1Label={`Revenue ${currentYearLabel}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyRevenue"
                  line2Label={`Revenue ${priorYearLabel}`}
                  labelFormatters={[(p) => `Revenue ${p.year}`, (p) => `Revenue ${p.year - 1}`]}
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
                  line1Label={`Units ${currentYearLabel}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyQuantity"
                  line2Label={`Units ${priorYearLabel}`}
                  labelFormatters={[(p) => `Units ${p.year}`, (p) => `Units ${p.year - 1}`]}
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
        const kitStart = kitTimeSeriesResponse?.params?.startDate;
        const kitEnd = kitTimeSeriesResponse?.params?.endDate;
        const { current: currentYearLabel, prior: priorYearLabel } = buildYearRangeLabel(kitStart, kitEnd);
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
                  line1Label={`Kit Revenue ${currentYearLabel}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyKitDailyRevenue"
                  line2Label={`Kit Revenue ${priorYearLabel}`}
                  labelFormatters={[(p) => `Kit Revenue ${p.year}`, (p) => `Kit Revenue ${p.year - 1}`]}
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
                  line1Label={`Kit Units ${currentYearLabel}`}
                  line1Color="hsl(var(--primary))"
                  line2Key="yoyKitDailyQuantity"
                  line2Label={`Kit Units ${priorYearLabel}`}
                  labelFormatters={[(p) => `Kit Units ${p.year}`, (p) => `Kit Units ${p.year - 1}`]}
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
  triggerVariant = "button",
  "data-testid": testId,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  isActive?: boolean;
  popoverWidth?: string;
  triggerVariant?: "button" | "icon";
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

  const active = isActive ?? selected.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {triggerVariant === "icon" ? (
          <button
            type="button"
            data-testid={testId}
            className={`inline-flex items-center justify-center rounded p-0.5 transition-colors ${
              active
                ? "text-primary ring-1 ring-primary/50"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            }`}
          >
            <ListFilter className="w-3 h-3" />
          </button>
        ) : (
        <Button
          variant="outline"
          size="default"
          className={`max-w-[400px] justify-between gap-2 transition-all${active ? " ring-1 ring-primary/50 border-primary/50" : ""}`}
          data-testid={testId}
        >
          {active && <ListFilter className="h-3.5 w-3.5 shrink-0 text-primary" />}
          <span className="truncate">{displayLabel}</span>
          <ChevronDown className="w-3 h-3 opacity-50 shrink-0" />
        </Button>
        )}
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

function SkuNotesModal({
  open,
  onClose,
  sku,
  productTitle,
  initialNotes,
  onSave,
  isSaving,
}: {
  open: boolean;
  onClose: () => void;
  sku: string;
  productTitle?: string;
  initialNotes: string;
  onSave: (notes: string) => void;
  isSaving?: boolean;
}) {
  const [draft, setDraft] = useState(initialNotes);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    if (open) {
      setDraft(initialNotes);
      setTab("edit");
    }
  }, [open, initialNotes]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl w-full flex flex-col" style={{ maxHeight: "80vh" }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            Notes
            <span className="text-muted-foreground font-normal text-sm">·</span>
            <span className="font-mono text-sm text-muted-foreground">{sku}</span>
          </DialogTitle>
          {productTitle && (
            <p className="text-sm text-muted-foreground mt-0.5">{productTitle}</p>
          )}
        </DialogHeader>

        <div className="flex gap-1 border-b pb-0">
          <button
            type="button"
            onClick={() => setTab("edit")}
            className={`px-3 py-1.5 text-sm font-medium rounded-t border-b-2 transition-colors ${
              tab === "edit"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setTab("preview")}
            className={`px-3 py-1.5 text-sm font-medium rounded-t border-b-2 transition-colors ${
              tab === "preview"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Preview
          </button>
        </div>

        <div className="flex-1 overflow-auto min-h-0" style={{ minHeight: 260 }}>
          {tab === "edit" ? (
            <Textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={"Add notes in markdown format...\n\n# Heading\n- bullet points\n**bold**, _italic_"}
              className="w-full h-full resize-none font-mono text-sm border-0 rounded-none focus-visible:ring-0 min-h-[260px]"
              style={{ height: "100%" }}
            />
          ) : (
            <div className="px-4 py-3 prose prose-sm dark:prose-invert max-w-none min-h-[260px]">
              {draft.trim() ? (
                <ReactMarkdown>{draft}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground italic text-sm">Nothing to preview yet.</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-row justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="default"
            onClick={() => onSave(draft)}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Save Notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PO_COLUMNS = [
  { key: "title",        label: "Title",        group: "product"    },
  { key: "category",     label: "Category",     group: "product"    },
  { key: "available",    label: "Available",    group: "inventory"  },
  { key: "incoming",     label: "Incoming",     group: "inventory"  },
  { key: "amzn",         label: "Amazon Inv",   group: "inventory"  },
  { key: "wlmt",         label: "Walmart Inv",  group: "inventory"  },
  { key: "in_kits",      label: "In Kits",      group: "inventory"  },
  { key: "total",        label: "Total Stock",  group: "inventory"  },
  { key: "supplier",     label: "Supplier",     group: "ordering"   },
  { key: "cost",         label: "Cost",         group: "ordering"   },
  { key: "lead_time",    label: "Lead Time",    group: "ordering"   },
  { key: "moq",          label: "MOQ",          group: "ordering"   },
  { key: "proj_direct",  label: "Proj. Direct",  group: "projection" },
  { key: "proj_kits",    label: "Proj. Kits",    group: "projection" },
  { key: "growth_mult",  label: "Growth Adj.",   group: "projection" },
  { key: "proj_total",   label: "Proj. Total",   group: "projection" },
  { key: "rec_purchase", label: "Rec. Purchase", group: "projection" },
  { key: "qty_ordered",  label: "Qty Ordered",   group: "projection" },
  { key: "notes",        label: "Notes" },
] as const;
type PoColumnKey = (typeof PO_COLUMNS)[number]["key"];
const PO_DEFAULT_COLUMNS: PoColumnKey[] = PO_COLUMNS
  .filter((c) => "group" in c && c.group !== "projection")
  .map((c) => c.key) as PoColumnKey[];

const PO_COLUMN_GROUPS = [
  { key: "product",   label: "Product",   keys: ["title", "category"] as PoColumnKey[] },
  { key: "inventory", label: "Inventory", keys: ["available", "incoming", "amzn", "wlmt", "in_kits", "total"] as PoColumnKey[] },
  { key: "ordering",  label: "Supplier",  keys: ["supplier", "cost", "lead_time", "moq"] as PoColumnKey[] },
] as const;

function ColumnFilterPopover({
  isActive,
  children,
  "data-testid": testId,
}: {
  isActive: boolean;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
          className={`inline-flex items-center justify-center rounded p-0.5 transition-colors ${
            isActive
              ? "text-primary ring-1 ring-primary/50"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}
        >
          <ListFilter className="w-3 h-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="p-2 w-auto min-w-[160px]"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

type ProjFilterOp = 'none' | 'above' | 'below' | 'eq' | 'between';
type ProjFilter = { op: ProjFilterOp; value: string; value2: string };
const PROJ_FILTER_DEFAULT: ProjFilter = { op: 'none', value: '', value2: '' };

const PROJ_FILTER_OP_LABELS: Record<ProjFilterOp, string> = {
  none: 'No filter',
  above: 'Above',
  below: 'Below',
  eq: 'Equal to',
  between: 'Between',
};

function applyProjFilter(rows: any[], filter: ProjFilter, getValue: (r: any) => number): any[] {
  if (filter.op === 'none') return rows;
  const v = Number(filter.value);
  const v2 = Number(filter.value2);
  return rows.filter((r) => {
    const val = getValue(r);
    if (filter.op === 'above') return val > v;
    if (filter.op === 'below') return val < v;
    if (filter.op === 'eq') return val === v;
    if (filter.op === 'between') return val >= Math.min(v, v2) && val <= Math.max(v, v2);
    return true;
  });
}

function parseLocalDate(dateStr: string | null | undefined): Date {
  if (!dateStr || typeof dateStr !== 'string') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return new Date(dateStr + 'T00:00:00');
}

function PurchaseOrdersTab() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const { value: searchTerm, setValue: setSearchTerm } = useUserPreference<string>(
    "purchase-orders", "searchTerm", "", { debounceMs: 800 }
  );
  const { value: categoryFilter, setValue: setCategoryFilter } = useUserPreference<string[]>(
    "purchase-orders", "category-filter", [], { debounceMs: 300 }
  );
  const { value: supplierFilter, setValue: setSupplierFilter } = useUserPreference<string[]>(
    "purchase-orders", "supplier-filter", [], { debounceMs: 300 }
  );
  const [activeProjectionMethod, setActiveProjectionMethod] = useState<string>("yoy");
  const [growthFactorMethod, setGrowthFactorMethod] = useState<string>("none");
  const { value: savedVelocityStart, setValue: setSavedVelocityStart } = useUserPreference<string>(
    "purchase-orders", "velocity-start",
    new Date().toLocaleDateString('en-CA'),
    { debounceMs: 300 }
  );
  const { value: savedVelocityEnd, setValue: setSavedVelocityEnd } = useUserPreference<string>(
    "purchase-orders", "velocity-end",
    (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toLocaleDateString('en-CA'); })(),
    { debounceMs: 300 }
  );
  const velocityStart = parseLocalDate(savedVelocityStart);
  const velocityEnd = parseLocalDate(savedVelocityEnd);
  const [velocityStartPopoverOpen, setVelocityStartPopoverOpen] = useState(false);
  const [velocityEndPopoverOpen, setVelocityEndPopoverOpen] = useState(false);
  const { value: sortCol, setValue: setSortCol } = useUserPreference<string | null>(
    "purchase-orders", "sort-col", null, { debounceMs: 300 }
  );
  const { value: sortDir, setValue: setSortDir } = useUserPreference<"asc" | "desc">(
    "purchase-orders", "sort-dir", "asc", { debounceMs: 300 }
  );
  const [copiedSku, setCopiedSku] = useState<string | null>(null);
  const [noteModalSku, setNoteModalSku] = useState<string | null>(null);
  const [editingQtySku, setEditingQtySku] = useState<string | null>(null);
  const [editingQtyValue, setEditingQtyValue] = useState<string>("");
  const { value: projFilterDirect, setValue: setProjFilterDirect } = useUserPreference<ProjFilter>(
    "purchase-orders", "proj-filter-direct", PROJ_FILTER_DEFAULT, { debounceMs: 300 }
  );
  const { value: projFilterKits, setValue: setProjFilterKits } = useUserPreference<ProjFilter>(
    "purchase-orders", "proj-filter-kits", PROJ_FILTER_DEFAULT, { debounceMs: 300 }
  );
  const { value: projFilterTotal, setValue: setProjFilterTotal } = useUserPreference<ProjFilter>(
    "purchase-orders", "proj-filter-total", PROJ_FILTER_DEFAULT, { debounceMs: 300 }
  );
  const { value: projFilterRec, setValue: setProjFilterRec } = useUserPreference<ProjFilter>(
    "purchase-orders", "proj-filter-rec", PROJ_FILTER_DEFAULT, { debounceMs: 300 }
  );
  const [projFilterOpen, setProjFilterOpen] = useState(false);

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
  const { value: visibleColumns, setValue: setVisibleColumns } = useUserPreference<string[]>(
    "purchase-orders", "visible-columns", [...PO_DEFAULT_COLUMNS], { debounceMs: 300 }
  );
  useEffect(() => {
    const allKeys = PO_COLUMNS.map((c) => c.key);
    const missing = PO_DEFAULT_COLUMNS.filter((k) => !visibleColumns.includes(k));
    const merged = [...visibleColumns, ...missing].sort(
      (a, b) => allKeys.indexOf(a as PoColumnKey) - allKeys.indexOf(b as PoColumnKey)
    );
    const changed =
      merged.length !== visibleColumns.length ||
      merged.some((k, i) => k !== visibleColumns[i]);
    if (changed) setVisibleColumns(merged);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const colVisible = useCallback((key: string) => visibleColumns.includes(key), [visibleColumns]);
  const toggleColumn = useCallback((key: string) => {
    if (visibleColumns.includes(key)) {
      setVisibleColumns(visibleColumns.filter((k) => k !== key));
    } else {
      const allKeys = PO_COLUMNS.map((c) => c.key);
      setVisibleColumns([...visibleColumns, key].sort((a, b) => allKeys.indexOf(a as PoColumnKey) - allKeys.indexOf(b as PoColumnKey)));
    }
  }, [visibleColumns, setVisibleColumns]);

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

  const windowStartStr = savedVelocityStart;
  const windowEndStr = savedVelocityEnd;

  const snapshotQuery = useQuery<any[]>({
    queryKey: ["/api/purchase-orders/snapshot", selectedDate, activeProjectionMethod, windowStartStr, windowEndStr],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedDate) params.set('date', selectedDate);
      params.set('method', activeProjectionMethod);
      params.set('windowStart', windowStartStr);
      params.set('windowEnd', windowEndStr);
      const res = await fetch(`/api/purchase-orders/snapshot?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch snapshot");
      return res.json();
    },
    enabled: (datesQuery.data?.length ?? 0) > 0,
  });

  const skuNotesQuery = useQuery<Record<string, string>>({
    queryKey: ["/api/purchase-orders/sku-notes"],
  });

  const quantitiesQuery = useQuery<Record<string, number | null>>({
    queryKey: ["/api/purchase-orders/quantities", selectedDate],
    queryFn: () => fetch(`/api/purchase-orders/quantities?date=${selectedDate}`).then((r) => r.json()),
    enabled: !!selectedDate,
  });

  const saveQuantityMutation = useMutation({
    mutationFn: async ({ sku, quantityOrdered }: { sku: string; quantityOrdered: number | null }) => {
      const effectiveDate = selectedDate ?? datesQuery.data?.[0];
      if (!effectiveDate) throw new Error("No snapshot date available to save against.");
      const res = await apiRequest("PUT", `/api/purchase-orders/quantities/${encodeURIComponent(sku)}`, {
        date: effectiveDate,
        quantityOrdered,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/quantities", selectedDate] });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err?.message ?? "Failed to save quantity.", variant: "destructive" });
    },
  });

  const growthFactorsQuery = useQuery<Record<string, { trendFactor: number | null; yoyGrowthFactor: number | null }>>({
    queryKey: ["/api/purchase-orders/growth-factors"],
    enabled: growthFactorMethod !== "none",
    staleTime: 60 * 60 * 1000,
  });

  const saveNoteMutation = useMutation({
    mutationFn: async ({ sku, notes }: { sku: string; notes: string }) => {
      const res = await apiRequest("PUT", `/api/purchase-orders/sku-notes/${encodeURIComponent(sku)}`, { notes });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/sku-notes"] });
      setNoteModalSku(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save notes.", variant: "destructive" });
    },
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

  const regenerateForecastsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/forecasting/generate", { force: true });
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Forecasts Regenerated",
        description: `${data.totalRows} rows rebuilt across ${data.daysProcessed} days`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders/readiness"] });
    },
    onError: (err: any) => {
      toast({
        title: "Regeneration Failed",
        description: err.message ?? "An unexpected error occurred",
        variant: "destructive",
      });
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
      if (cfg.activeProjectionMethod) setActiveProjectionMethod(cfg.activeProjectionMethod);
      if (cfg.growthFactorMethod) setGrowthFactorMethod(cfg.growthFactorMethod);
      configInitialized.current = true;
    }
  }, [configQuery.data]);

  const snapshot = snapshotQuery.data ?? [];
  const hasProjection = snapshot.length > 0;

  const getGrowthMultiplier = useCallback((sku: string): number => {
    if (growthFactorMethod === "none" || !growthFactorsQuery.data) return 1;
    const factors = growthFactorsQuery.data[sku];
    if (!factors) return 1;
    const { trendFactor, yoyGrowthFactor } = factors;
    if (growthFactorMethod === "trend") return trendFactor ?? 1;
    if (growthFactorMethod === "yoy") return yoyGrowthFactor ?? 1;
    if (growthFactorMethod === "smart") return Math.max(trendFactor ?? 1, yoyGrowthFactor ?? 1);
    return 1;
  }, [growthFactorMethod, growthFactorsQuery.data]);

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
    if (searchTerm && typeof searchTerm === 'string') {
      const lower = searchTerm.toLowerCase();
      rows = rows.filter((r: any) =>
        (typeof r.sku === 'string' && r.sku.toLowerCase().includes(lower)) ||
        (typeof r.product_title === 'string' && r.product_title.toLowerCase().includes(lower)) ||
        (typeof r.description === 'string' && r.description.toLowerCase().includes(lower))
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
          case "available": aVal = a.available_quantity ?? 0; bVal = b.available_quantity ?? 0; break;
          case "incoming": aVal = a.quantity_incoming ?? 0; bVal = b.quantity_incoming ?? 0; break;
          case "lead_time": aVal = a.lead_time ?? 0; bVal = b.lead_time ?? 0; break;
          case "moq": aVal = a.moq ?? 0; bVal = b.moq ?? 0; break;
          case "amzn": aVal = a.ext_amzn_inv ?? 0; bVal = b.ext_amzn_inv ?? 0; break;
          case "wlmt": aVal = a.ext_wlmt_inv ?? 0; bVal = b.ext_wlmt_inv ?? 0; break;
          case "in_kits": aVal = a.quantity_in_kits ?? 0; bVal = b.quantity_in_kits ?? 0; break;
          case "total": aVal = a.total_stock ?? 0; bVal = b.total_stock ?? 0; break;
          case "proj_direct": aVal = Math.round(Number(a.proj_direct ?? 0) * getGrowthMultiplier(a.sku)); bVal = Math.round(Number(b.proj_direct ?? 0) * getGrowthMultiplier(b.sku)); break;
          case "proj_kits": aVal = Math.round(Number(a.proj_kits ?? 0) * getGrowthMultiplier(a.sku)); bVal = Math.round(Number(b.proj_kits ?? 0) * getGrowthMultiplier(b.sku)); break;
          case "proj_total": { const fa = getGrowthMultiplier(a.sku); const fb = getGrowthMultiplier(b.sku); aVal = Math.round(Number(a.proj_direct ?? 0) * fa) + Math.round(Number(a.proj_kits ?? 0) * fa); bVal = Math.round(Number(b.proj_direct ?? 0) * fb) + Math.round(Number(b.proj_kits ?? 0) * fb); break; }
          case "rec_purchase": { const fa = getGrowthMultiplier(a.sku); const fb = getGrowthMultiplier(b.sku); aVal = Math.round(Number(a.proj_direct ?? 0) * fa) + Math.round(Number(a.proj_kits ?? 0) * fa) - Math.round(Number(a.total_stock ?? 0)); bVal = Math.round(Number(b.proj_direct ?? 0) * fb) + Math.round(Number(b.proj_kits ?? 0) * fb) - Math.round(Number(b.total_stock ?? 0)); break; }
          case "qty_ordered": aVal = quantitiesQuery.data?.[a.sku] ?? 0; bVal = quantitiesQuery.data?.[b.sku] ?? 0; break;
          default: aVal = 0; bVal = 0;
        }
        if (typeof aVal === "string") {
          const cmp = aVal.localeCompare(bVal);
          return sortDir === "asc" ? cmp : -cmp;
        }
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      });
    }
    if (hasProjection) {
      rows = applyProjFilter(rows, projFilterDirect, (r) => Math.round(Number(r.proj_direct ?? 0) * getGrowthMultiplier(r.sku)));
      rows = applyProjFilter(rows, projFilterKits, (r) => Math.round(Number(r.proj_kits ?? 0) * getGrowthMultiplier(r.sku)));
      rows = applyProjFilter(rows, projFilterTotal, (r) => {
        const f = getGrowthMultiplier(r.sku);
        return Math.round(Number(r.proj_direct ?? 0) * f) + Math.round(Number(r.proj_kits ?? 0) * f);
      });
      rows = applyProjFilter(rows, projFilterRec, (r) => {
        const f = getGrowthMultiplier(r.sku);
        return Math.round(Number(r.proj_direct ?? 0) * f) + Math.round(Number(r.proj_kits ?? 0) * f) - Number(r.total_stock ?? 0);
      });
    }
    return rows;
  }, [snapshot, searchTerm, categoryFilter, supplierFilter, kitFilter, assembledFilter, sortCol, sortDir, getGrowthMultiplier, hasProjection, projFilterDirect, projFilterKits, projFilterTotal, projFilterRec]);

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
    assembledFilter !== "either" ||
    (hasProjection && [projFilterDirect, projFilterKits, projFilterTotal, projFilterRec].some((f) => f.op !== 'none'));

  const clearPoFilters = useCallback(() => {
    setSearchTerm("");
    setCategoryFilter([]);
    setSupplierFilter([]);
    setKitFilter("no");
    setAssembledFilter("either");
    setProjFilterDirect(PROJ_FILTER_DEFAULT);
    setProjFilterKits(PROJ_FILTER_DEFAULT);
    setProjFilterTotal(PROJ_FILTER_DEFAULT);
    setProjFilterRec(PROJ_FILTER_DEFAULT);
  }, [setCategoryFilter, setSupplierFilter, setKitFilter, setAssembledFilter]);

  const readiness = readinessQuery.data;

  const exportCsv = useCallback(() => {
    if (filtered.length === 0) return;
    const headers = ["SKU", "Title", "Category", "Supplier", "Unit Cost", "Available", "Incoming", "Lead Time (days)", "MOQ", "Amazon Inv", "Walmart Inv", "In Kits", "Total Stock"];
    if (hasProjection) headers.push("Proj. Direct", "Proj. Kits", "Growth Adj.", "Proj. Total", "Rec. Purchase", "Qty Ordered");
    const csvRows = [headers.join(",")];
    for (const r of filtered) {
      const row = [
        r.sku, `"${(r.product_title || '').replace(/"/g, '""')}"`, r.product_category || '',
        `"${(r.supplier || '').replace(/"/g, '""')}"`, r.unit_cost ?? '',
        r.available_quantity ?? 0,
        r.quantity_incoming ?? '', r.lead_time ?? '', r.moq ?? '',
        r.ext_amzn_inv ?? '', r.ext_wlmt_inv ?? '', r.quantity_in_kits ?? '',
        r.total_stock ?? ''
      ];
      if (hasProjection) {
        const csvFactor = getGrowthMultiplier(r.sku);
        const csvRawDirect = Math.round(Number(r.proj_direct ?? 0));
        const csvRawKits = Math.round(Number(r.proj_kits ?? 0));
        const csvAdjDirect = Math.round(csvRawDirect * csvFactor);
        const csvAdjKits = Math.round(csvRawKits * csvFactor);
        const csvAdjTotal = csvAdjDirect + csvAdjKits;
        const csvAdjRec = csvAdjTotal - Math.round(Number(r.total_stock ?? 0));
        row.push(
          String(csvAdjDirect),
          String(csvAdjKits),
          growthFactorMethod === "none" ? "—" : csvFactor.toFixed(2) + "x",
          String(csvAdjTotal),
          String(csvAdjRec),
          String(quantitiesQuery.data?.[r.sku] ?? ""),
        );
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
        <HoverTooltip>
          <HoverTooltipTrigger asChild>
            <div className="relative inline-block">
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
              {readiness?.ready && (
                <span className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 pointer-events-none" data-testid="text-po-readiness">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-green-500" />
                </span>
              )}
            </div>
          </HoverTooltipTrigger>
          <HoverTooltipContent side="bottom">
            {readinessQuery.isLoading ? "Checking..." : readiness?.reason ?? "Unknown"}
          </HoverTooltipContent>
        </HoverTooltip>

        <Button
          variant="outline"
          onClick={() => regenerateForecastsMutation.mutate()}
          disabled={regenerateForecastsMutation.isPending}
          data-testid="button-regenerate-forecasts"
        >
          {regenerateForecastsMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4 mr-2" />
          )}
          {regenerateForecastsMutation.isPending ? "Regenerating…" : "Regenerate Forecasts"}
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

        {snapshot.length > 0 && (
          <>
            <Select
              value={activeProjectionMethod}
              onValueChange={(val) => {
                setActiveProjectionMethod(val);
                saveConfigMutation.mutate({ activeProjectionMethod: val });
              }}
            >
              <SelectTrigger className="w-[170px]" data-testid="select-projection-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yoy">YoY (Last Year)</SelectItem>
                <SelectItem value="velocity">14-Day Velocity</SelectItem>
                <SelectItem value="smart">Smart Blend</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={growthFactorMethod}
              onValueChange={(val) => {
                setGrowthFactorMethod(val);
                saveConfigMutation.mutate({ growthFactorMethod: val });
              }}
            >
              <SelectTrigger className="w-[185px]" data-testid="select-growth-factor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Growth Adj.</SelectItem>
                <SelectItem value="trend">Trend Factor</SelectItem>
                <SelectItem value="yoy">YoY Growth Rate</SelectItem>
                <SelectItem value="smart">Smart Growth</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-card" data-testid="projection-window">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Projection Window:</span>
              <Popover open={velocityStartPopoverOpen} onOpenChange={setVelocityStartPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs font-mono px-2" data-testid="button-window-start">
                    {velocityStart.toLocaleDateString('en-CA')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={velocityStart}
                    onSelect={(date) => {
                      if (date) {
                        setSavedVelocityStart(date.toLocaleDateString('en-CA'));
                        setVelocityStartPopoverOpen(false);
                        saveConfigMutation.mutate({ velocityWindowStart: date.toLocaleDateString('en-CA') });
                      }
                    }}
                    disabled={(date) => date >= velocityEnd}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-muted-foreground">to</span>
              <Popover open={velocityEndPopoverOpen} onOpenChange={setVelocityEndPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs font-mono px-2" data-testid="button-window-end">
                    {velocityEnd.toLocaleDateString('en-CA')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={velocityEnd}
                    onSelect={(date) => {
                      if (date) {
                        setSavedVelocityEnd(date.toLocaleDateString('en-CA'));
                        setVelocityEndPopoverOpen(false);
                        saveConfigMutation.mutate({ velocityWindowEnd: date.toLocaleDateString('en-CA') });
                      }
                    }}
                    disabled={(date) => date <= velocityStart}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={(() => {
                const hiddenDefault = PO_DEFAULT_COLUMNS.filter((k) => !visibleColumns.includes(k)).length;
                const extraVisible = visibleColumns.filter((k) => !PO_DEFAULT_COLUMNS.includes(k as PoColumnKey)).length;
                return (hiddenDefault + extraVisible) > 0
                  ? "gap-1.5 shrink-0 border-primary/50 ring-1 ring-primary/30 text-primary"
                  : "gap-1.5 shrink-0";
              })()}
              data-testid="button-po-columns"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Columns
              {(() => {
                const hiddenDefault = PO_DEFAULT_COLUMNS.filter((k) => !visibleColumns.includes(k)).length;
                const extraVisible = visibleColumns.filter((k) => !PO_DEFAULT_COLUMNS.includes(k as PoColumnKey)).length;
                const total = hiddenDefault + extraVisible;
                return total > 0 ? (
                  <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-xs">
                    {total}
                  </Badge>
                ) : null;
              })()}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[230px] p-2" align="start">
            <div className="flex flex-col gap-1">
              {(() => {
                const allColKeys = PO_COLUMNS.map((c) => c.key) as PoColumnKey[];
                const renderGroup = (label: string, keys: readonly PoColumnKey[]) => {
                  const allOn = keys.every((k) => colVisible(k));
                  const someOn = keys.some((k) => colVisible(k));
                  const toggle = () => {
                    if (allOn) {
                      setVisibleColumns(visibleColumns.filter((k) => !keys.includes(k as PoColumnKey)));
                    } else {
                      const merged = [...new Set([...visibleColumns, ...keys])];
                      setVisibleColumns(merged.sort((a, b) => allColKeys.indexOf(a as PoColumnKey) - allColKeys.indexOf(b as PoColumnKey)));
                    }
                  };
                  return (
                    <div>
                      <button type="button" onClick={toggle} className="flex items-center gap-2 px-1 py-1 w-full rounded hover-elevate">
                        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${allOn ? "bg-primary border-primary" : someOn ? "border-primary/60" : "border-muted-foreground/40"}`}>
                          {allOn && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                          {!allOn && someOn && <div className="w-1.5 h-0.5 bg-primary/60 rounded-full" />}
                        </div>
                        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
                      </button>
                      {keys.map((k) => {
                        const col = PO_COLUMNS.find((c) => c.key === k)!;
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`flex items-center gap-2 text-sm px-2 py-0.5 pl-5 rounded hover-elevate w-full ${colVisible(k) ? "" : "text-muted-foreground"}`}
                            onClick={() => toggleColumn(k)}
                          >
                            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${colVisible(k) ? "bg-primary border-primary" : "border-muted-foreground/40"}`}>
                              {colVisible(k) && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                            </div>
                            {col.label}
                          </button>
                        );
                      })}
                    </div>
                  );
                };
                const productGroup = PO_COLUMN_GROUPS.find((g) => g.key === "product")!;
                const inventoryGroup = PO_COLUMN_GROUPS.find((g) => g.key === "inventory")!;
                const orderingGroup = PO_COLUMN_GROUPS.find((g) => g.key === "ordering")!;
                const projCols = PO_COLUMNS.filter((c) => "group" in c && c.group === "projection");
                const projKeys = projCols.map((c) => c.key) as PoColumnKey[];
                return (
                  <>
                    {renderGroup(productGroup.label, productGroup.keys)}
                    {hasProjection && renderGroup("Projection", projKeys)}
                    {renderGroup(inventoryGroup.label, inventoryGroup.keys)}
                    {renderGroup(orderingGroup.label, orderingGroup.keys)}
                  </>
                );
              })()}
              <div className="border-t mt-1 pt-1 flex gap-1">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5"
                  onClick={() => setVisibleColumns(hasProjection ? PO_COLUMNS.map((c) => c.key) : [...PO_DEFAULT_COLUMNS])}
                >
                  Show all
                </button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5"
                  onClick={() => setVisibleColumns(["title"])}
                >
                  Hide all
                </button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        {hasProjection && (() => {
          const hasActiveProjFilters = [projFilterDirect, projFilterKits, projFilterTotal, projFilterRec].some((f) => f.op !== 'none');
          const projFilterRows: { label: string; filter: ProjFilter; setFilter: (f: ProjFilter) => void }[] = [
            { label: "Proj. Direct", filter: projFilterDirect, setFilter: setProjFilterDirect },
            { label: "Proj. Kits", filter: projFilterKits, setFilter: setProjFilterKits },
            { label: "Proj. Total", filter: projFilterTotal, setFilter: setProjFilterTotal },
            { label: "Rec. Purchase", filter: projFilterRec, setFilter: setProjFilterRec },
          ];
          return (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProjFilterOpen(true)}
                className={hasActiveProjFilters ? "gap-1.5 border-primary/50 ring-1 ring-primary/30 text-primary" : "gap-1.5"}
                data-testid="button-proj-filters"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Projection Filters
                {hasActiveProjFilters && (
                  <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-xs">
                    {[projFilterDirect, projFilterKits, projFilterTotal, projFilterRec].filter((f) => f.op !== 'none').length}
                  </Badge>
                )}
              </Button>
              <Dialog open={projFilterOpen} onOpenChange={setProjFilterOpen}>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Projection Filters</DialogTitle>
                    <DialogDescription>
                      Filter rows by projected values. Growth factor adjustments are applied before filtering.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col gap-5 py-2">
                    {projFilterRows.map(({ label, filter, setFilter }) => (
                      <div key={label} className="flex flex-col gap-2">
                        <Label className="text-sm font-medium">{label}</Label>
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            value={filter.op}
                            onValueChange={(v) => setFilter({ ...filter, op: v as ProjFilterOp })}
                          >
                            <SelectTrigger className="w-36" data-testid={`select-proj-filter-op-${label.replace(/\W+/g, '-').toLowerCase()}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.entries(PROJ_FILTER_OP_LABELS) as [ProjFilterOp, string][]).map(([op, lbl]) => (
                                <SelectItem key={op} value={op}>{lbl}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {filter.op !== 'none' && (
                            <Input
                              type="number"
                              className="w-28"
                              placeholder="Value"
                              value={filter.value}
                              onChange={(e) => setFilter({ ...filter, value: e.target.value })}
                              data-testid={`input-proj-filter-value-${label.replace(/\W+/g, '-').toLowerCase()}`}
                            />
                          )}
                          {filter.op === 'between' && (
                            <>
                              <span className="text-sm text-muted-foreground">and</span>
                              <Input
                                type="number"
                                className="w-28"
                                placeholder="Value"
                                value={filter.value2}
                                onChange={(e) => setFilter({ ...filter, value2: e.target.value })}
                                data-testid={`input-proj-filter-value2-${label.replace(/\W+/g, '-').toLowerCase()}`}
                              />
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <DialogFooter className="gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setProjFilterDirect(PROJ_FILTER_DEFAULT);
                        setProjFilterKits(PROJ_FILTER_DEFAULT);
                        setProjFilterTotal(PROJ_FILTER_DEFAULT);
                        setProjFilterRec(PROJ_FILTER_DEFAULT);
                      }}
                      data-testid="button-proj-filter-clear"
                    >
                      Clear All
                    </Button>
                    <Button onClick={() => setProjFilterOpen(false)} data-testid="button-proj-filter-apply">
                      Apply
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          );
        })()}
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

        <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0} className="ml-auto" data-testid="button-export-csv">
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
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
            <Table containerClassName="flex-1 overflow-auto" className="[&_th]:border-r [&_th]:border-border [&_td]:border-r [&_td]:border-border">
              <TableHeader>
                {/* Row 1 — Group label row; Notes spans both rows via rowSpan; SKU is now under Product */}
                <TableRow className="h-8">
                  {/* Notes spans both rows — first column */}
                  {colVisible("notes") && (
                    <TableHead
                      rowSpan={2}
                      style={{ width: 44, minWidth: 44 }}
                      className="sticky top-0 bg-card z-20 select-none text-center align-middle border-b-0"
                      data-testid="col-notes"
                    >
                      <span className="sr-only">Notes</span>
                    </TableHead>
                  )}
                  {/* Product group — always includes SKU (+1) */}
                  {(() => {
                    const group = PO_COLUMN_GROUPS.find((g) => g.key === "product")!;
                    const cnt = group.keys.filter((k) => colVisible(k)).length + 1;
                    return (
                      <TableHead
                        colSpan={cnt}
                        className="sticky top-0 bg-border/50 z-20 text-center text-[10px] font-bold text-foreground/70 uppercase tracking-widest py-1.5 border-b border-border"
                      >
                        {group.label}
                      </TableHead>
                    );
                  })()}
                  {/* Projection group — between Product and Inventory */}
                  {hasProjection && (() => {
                    const projKeys = PO_COLUMNS.filter((c) => "group" in c && c.group === "projection").map((c) => c.key);
                    const cnt = projKeys.filter((k) => colVisible(k)).length;
                    if (cnt === 0) return null;
                    return (
                      <TableHead
                        colSpan={cnt}
                        className="sticky top-0 bg-border/50 z-20 text-center text-[10px] font-bold text-foreground/70 uppercase tracking-widest py-1.5 border-l-2 border-b border-border"
                      >
                        Projection
                      </TableHead>
                    );
                  })()}
                  {/* Inventory group */}
                  {(() => {
                    const group = PO_COLUMN_GROUPS.find((g) => g.key === "inventory")!;
                    const cnt = group.keys.filter((k) => colVisible(k)).length;
                    if (cnt === 0) return null;
                    return (
                      <TableHead
                        colSpan={cnt}
                        className="sticky top-0 bg-border/50 z-20 text-center text-[10px] font-bold text-foreground/70 uppercase tracking-widest py-1.5 border-l-2 border-b border-border"
                      >
                        {group.label}
                      </TableHead>
                    );
                  })()}
                  {/* Ordering group */}
                  {(() => {
                    const group = PO_COLUMN_GROUPS.find((g) => g.key === "ordering")!;
                    const cnt = group.keys.filter((k) => colVisible(k)).length;
                    if (cnt === 0) return null;
                    return (
                      <TableHead
                        colSpan={cnt}
                        className="sticky top-0 bg-border/50 z-20 text-center text-[10px] font-bold text-foreground/70 uppercase tracking-widest py-1.5 border-l-2 border-b border-border"
                      >
                        {group.label}
                      </TableHead>
                    );
                  })()}
                </TableRow>
                {/* Row 2 — Individual column headers (Notes already placed via rowSpan above) */}
                <TableRow>
                  {/* SKU column — Kit filter in header (Product group) */}
                  <TableHead
                    style={{ width: 145, minWidth: 145 }}
                    className="sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort("sku")}
                    data-testid="sort-sku"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="inline-flex items-center gap-1">
                        SKU
                        {sortCol === "sku" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                      <ColumnFilterPopover isActive={kitFilter !== "no"} data-testid="filter-kit-popover">
                        <div className="flex flex-col gap-0.5">
                          <p className="text-xs font-medium text-muted-foreground px-1 pb-1">Kit</p>
                          {(["no", "yes", "either"] as const).map((v) => (
                            <button
                              key={v}
                              type="button"
                              className={`text-left text-sm px-2 py-1 rounded hover-elevate ${kitFilter === v ? "text-primary font-medium" : ""}`}
                              onClick={() => setKitFilter(v)}
                            >
                              {v === "no" ? "Not a Kit" : v === "yes" ? "Kits Only" : "Show All"}
                            </button>
                          ))}
                        </div>
                      </ColumnFilterPopover>
                    </div>
                  </TableHead>
                  {/* Title column — Assembled Product filter in header */}
                  {colVisible("title") && (
                  <TableHead
                    style={{ width: 230, minWidth: 230 }}
                    className="sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort("title")}
                    data-testid="sort-title"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="inline-flex items-center gap-1">
                        Title
                        {sortCol === "title" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                      <ColumnFilterPopover isActive={assembledFilter !== "either"} data-testid="filter-assembled-popover">
                        <div className="flex flex-col gap-0.5">
                          <p className="text-xs font-medium text-muted-foreground px-1 pb-1">Assembled Product</p>
                          {(["either", "yes", "no"] as const).map((v) => (
                            <button
                              key={v}
                              type="button"
                              className={`text-left text-sm px-2 py-1 rounded hover-elevate ${assembledFilter === v ? "text-primary font-medium" : ""}`}
                              onClick={() => setAssembledFilter(v)}
                            >
                              {v === "either" ? "Show All" : v === "yes" ? "Assembled Only" : "Not Assembled"}
                            </button>
                          ))}
                        </div>
                      </ColumnFilterPopover>
                    </div>
                  </TableHead>
                  )}
                  {/* Category column — multi-select filter in header */}
                  {colVisible("category") && (
                  <TableHead
                    style={{ width: 130, minWidth: 130 }}
                    className="sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap"
                    onClick={() => toggleSort("category")}
                    data-testid="sort-category"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="inline-flex items-center gap-1">
                        Category
                        {sortCol === "category" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                      <div onClick={(e) => e.stopPropagation()}>
                        <MultiSelectFilter
                          label="Category"
                          options={categories}
                          selected={categoryFilter}
                          onChange={setCategoryFilter}
                          isActive={categoryFilter.length > 0}
                          triggerVariant="icon"
                          popoverWidth="w-[240px]"
                          data-testid="filter-category-popover"
                        />
                      </div>
                    </div>
                  </TableHead>
                  )}
                  {/* Projection columns — between Product and Inventory */}
                  {hasProjection && [
                    { key: "proj_direct",  label: "Proj. Direct",  width: 90, tooltip: "Projected individual units sold (not part of a kit) over the selected window, using the chosen algorithm." },
                    { key: "proj_kits",    label: "Proj. Kits",    width: 90, tooltip: "Projected kit-driven units (this SKU ships inside a kit) over the selected window, using the chosen algorithm." },
                    { key: "growth_mult",  label: "Growth Adj.",   width: 70, tooltip: "The growth multiplier applied to this SKU's projections based on the selected growth factor method." },
                    { key: "proj_total",   label: "Proj. Total",   width: 90, tooltip: "Total projected units needed (direct + kit-driven) over the selected window." },
                    { key: "rec_purchase", label: "Rec. Purchase", width: 90, tooltip: "Recommended purchase qty: projected total minus current total stock. Negative means you have sufficient stock." },
                    { key: "qty_ordered",  label: "Qty Ordered",   width: 90, tooltip: "The quantity your team decided to order for this SKU. Click any cell to enter or edit the value." },
                  ].filter((col) => colVisible(col.key)).map((col, idx) => (
                    <TableHead
                      key={col.key}
                      style={{ width: col.width, minWidth: col.width }}
                      className={`text-right sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap ${idx === 0 ? "border-l-2 border-border" : ""}`}
                      onClick={() => toggleSort(col.key)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        {col.tooltip && (
                          <HoverTooltip>
                            <HoverTooltipTrigger asChild>
                              <span onClick={(e) => e.stopPropagation()} className="cursor-default">
                                <Info className="w-3 h-3 text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0" />
                              </span>
                            </HoverTooltipTrigger>
                            <HoverTooltipContent side="top" align="end" className="normal-case font-normal tracking-normal" style={{ fontSize: '0.75rem', lineHeight: '1.4', color: 'hsl(var(--popover-foreground))', textAlign: 'left', maxWidth: '220px', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                              {col.tooltip}
                            </HoverTooltipContent>
                          </HoverTooltip>
                        )}
                        {col.label}
                        {sortCol === col.key ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                    </TableHead>
                  ))}
                  {/* Inventory columns — sortable-only */}
                  {[
                    { key: "available", label: "Available", right: true, width: 80 },
                    { key: "incoming",  label: "Incoming",  right: true, width: 80 },
                    { key: "amzn",      label: "Amzn",      right: true, width: 65 },
                    { key: "wlmt",      label: "Wlmt",      right: true, width: 65 },
                    { key: "in_kits",   label: "In Kits",   right: true, width: 70 },
                    { key: "total",     label: "Total",     right: true, width: 70 },
                  ].filter((col) => colVisible(col.key)).map((col, idx) => (
                    <TableHead
                      key={col.key}
                      style={{ width: col.width, minWidth: col.width }}
                      className={`sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap ${col.right ? "text-right" : ""} ${idx === 0 ? "border-l-2 border-border" : ""}`}
                      onClick={() => toggleSort(col.key)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className={`inline-flex items-center gap-1 ${col.right ? "justify-end" : ""}`}>
                        {col.label}
                        {sortCol === col.key ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                    </TableHead>
                  ))}
                  {/* Supplier column — multi-select filter in header (Ordering group) */}
                  {colVisible("supplier") && (
                  <TableHead
                    style={{ width: 140, minWidth: 140 }}
                    className="sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap border-l-2 border-border"
                    onClick={() => toggleSort("supplier")}
                    data-testid="sort-supplier"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="inline-flex items-center gap-1">
                        Supplier
                        {sortCol === "supplier" ? (sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                      </span>
                      <div onClick={(e) => e.stopPropagation()}>
                        <MultiSelectFilter
                          label="Supplier"
                          options={suppliers}
                          selected={supplierFilter}
                          onChange={setSupplierFilter}
                          isActive={supplierFilter.length > 0}
                          triggerVariant="icon"
                          popoverWidth="w-[260px]"
                          data-testid="filter-supplier-popover"
                        />
                      </div>
                    </div>
                  </TableHead>
                  )}
                  {/* Ordering columns — cost, lead_time, moq */}
                  {[
                    { key: "cost",      label: "Cost",      right: true, width: 70 },
                    { key: "lead_time", label: "Lead Time", right: true, width: 80 },
                    { key: "moq",       label: "MOQ",       right: true, width: 65 },
                  ].filter((col) => colVisible(col.key)).map((col) => (
                    <TableHead
                      key={col.key}
                      style={{ width: col.width, minWidth: col.width }}
                      className={`sticky top-8 bg-card z-10 cursor-pointer select-none whitespace-nowrap ${col.right ? "text-right" : ""}`}
                      onClick={() => toggleSort(col.key)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className={`inline-flex items-center gap-1 ${col.right ? "justify-end" : ""}`}>
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
                    <TableRow key={row.id} data-testid={`row-po-${row.sku}`} className="group/row">
                      {/* Notes cell — first column */}
                      {colVisible("notes") && (() => {
                        const noteText = skuNotesQuery.data?.[row.sku]?.trim() ?? "";
                        const hasNote = !!noteText;
                        return (
                          <TableCell style={{ width: 44, minWidth: 44 }} className="text-center p-1">
                            <HoverTooltip>
                              <HoverTooltipTrigger asChild>
                                <button
                                  type="button"
                                  data-testid={`button-notes-${row.sku}`}
                                  onClick={() => setNoteModalSku(row.sku)}
                                  className={`inline-flex items-center justify-center rounded p-1 transition-colors ${
                                    hasNote
                                      ? "text-primary"
                                      : "text-muted-foreground/30 hover:text-muted-foreground"
                                  }`}
                                >
                                  <MessageSquare
                                    className="w-4 h-4"
                                    fill={hasNote ? "currentColor" : "none"}
                                    fillOpacity={hasNote ? 0.2 : 0}
                                  />
                                </button>
                              </HoverTooltipTrigger>
                              <HoverTooltipContent side="right" className="max-w-xs text-left whitespace-pre-wrap">
                                {hasNote ? noteText : <span className="text-muted-foreground italic">No notes — click to add</span>}
                              </HoverTooltipContent>
                            </HoverTooltip>
                          </TableCell>
                        );
                      })()}
                      <TableCell style={{ width: 145, minWidth: 145 }} className="font-mono text-xs whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <span className="truncate">{row.sku}</span>
                          {row.is_kit && <Badge variant="outline" className="text-[10px] shrink-0">Kit</Badge>}
                          {row.is_assembled_product && <Badge variant="outline" className="text-[10px] shrink-0">Asm</Badge>}
                          <button
                            type="button"
                            data-testid={`button-copy-sku-${row.sku}`}
                            className="invisible group-hover/row:visible shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                              navigator.clipboard.writeText(row.sku);
                              setCopiedSku(row.sku);
                              setTimeout(() => setCopiedSku(null), 1500);
                            }}
                            title="Copy SKU"
                          >
                            {copiedSku === row.sku
                              ? <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                              : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                      </TableCell>
                      {colVisible("title") && <TableCell style={{ width: 230, minWidth: 230, maxWidth: 230 }} className="text-sm truncate" title={row.product_title}>{row.product_title || row.description || "—"}</TableCell>}
                      {colVisible("category") && <TableCell style={{ width: 130, minWidth: 130, maxWidth: 130 }} className="text-xs truncate">{row.product_category || "—"}</TableCell>}
                      {/* Projection cells — between Product and Inventory */}
                      {hasProjection && (() => {
                        const rawDirect = Math.round(Number(row.proj_direct ?? 0));
                        const rawKits = Math.round(Number(row.proj_kits ?? 0));
                        const factor = getGrowthMultiplier(row.sku);
                        const adjDirect = Math.round(rawDirect * factor);
                        const adjKits = Math.round(rawKits * factor);
                        const adjTotal = adjDirect + adjKits;
                        const adjRec = adjTotal - Math.round(Number(row.total_stock ?? 0));
                        const isAdjusted = factor !== 1;
                        return (
                          <>
                            {colVisible("proj_direct") && (
                              <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums border-l-2 border-border">
                                {adjDirect.toLocaleString()}
                                {isAdjusted && <div className="text-xs text-muted-foreground">{rawDirect.toLocaleString()}</div>}
                              </TableCell>
                            )}
                            {colVisible("proj_kits") && (
                              <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums">
                                {adjKits.toLocaleString()}
                                {isAdjusted && <div className="text-xs text-muted-foreground">{rawKits.toLocaleString()}</div>}
                              </TableCell>
                            )}
                            {colVisible("growth_mult") && (
                              <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">
                                {growthFactorMethod === "none"
                                  ? <span className="text-muted-foreground">—</span>
                                  : (
                                    <>
                                      <span className={isAdjusted ? "" : "text-muted-foreground"}>{factor.toFixed(2)}×</span>
                                      <div className="text-xs text-muted-foreground/70">
                                        {growthFactorMethod === "smart"
                                          ? (() => {
                                              const f = growthFactorsQuery.data?.[row.sku];
                                              const tf = f?.trendFactor ?? 1;
                                              const yf = f?.yoyGrowthFactor ?? 1;
                                              return tf >= yf ? "trend" : "yoy";
                                            })()
                                          : growthFactorMethod
                                        }
                                      </div>
                                    </>
                                  )
                                }
                              </TableCell>
                            )}
                            {colVisible("proj_total") && (
                              <TableCell style={{ width: 90, minWidth: 90 }} className="text-right tabular-nums font-semibold">
                                {adjTotal.toLocaleString()}
                                {isAdjusted && <div className="text-xs text-muted-foreground font-normal">{(rawDirect + rawKits).toLocaleString()}</div>}
                              </TableCell>
                            )}
                            {colVisible("rec_purchase") && (
                              <TableCell style={{ width: 90, minWidth: 90 }} className={`text-right tabular-nums font-semibold ${adjRec > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                                {adjRec.toLocaleString()}
                              </TableCell>
                            )}
                            {colVisible("qty_ordered") && (
                              <TableCell
                                style={{ width: 90, minWidth: 90 }}
                                className="text-right tabular-nums p-0"
                                onClick={() => {
                                  if (editingQtySku !== row.sku) {
                                    setEditingQtySku(row.sku);
                                    setEditingQtyValue(String(quantitiesQuery.data?.[row.sku] ?? ""));
                                  }
                                }}
                              >
                                {editingQtySku === row.sku ? (
                                  <input
                                    type="number"
                                    autoFocus
                                    value={editingQtyValue}
                                    onChange={(e) => setEditingQtyValue(e.target.value)}
                                    onBlur={() => {
                                      const parsed = editingQtyValue === "" ? null : parseInt(editingQtyValue, 10);
                                      if (!isNaN(parsed as number) || parsed === null) {
                                        saveQuantityMutation.mutate({ sku: row.sku, quantityOrdered: parsed });
                                      }
                                      setEditingQtySku(null);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") e.currentTarget.blur();
                                      if (e.key === "Escape") { setEditingQtySku(null); }
                                    }}
                                    className="w-full h-full px-3 py-2 text-right bg-primary/5 border border-primary/30 rounded focus:outline-none focus:ring-1 focus:ring-primary text-sm tabular-nums"
                                    style={{ minWidth: 80 }}
                                  />
                                ) : (
                                  <div className="px-3 py-2 cursor-pointer hover-elevate rounded text-sm">
                                    {quantitiesQuery.data?.[row.sku] != null
                                      ? Number(quantitiesQuery.data[row.sku]).toLocaleString()
                                      : <span className="text-muted-foreground/40">—</span>
                                    }
                                  </div>
                                )}
                              </TableCell>
                            )}
                          </>
                        );
                      })()}
                      {colVisible("available") && <TableCell style={{ width: 80, minWidth: 80 }} className={`text-right tabular-nums border-l-2 border-border ${isLow ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}>{avail}</TableCell>}
                      {colVisible("incoming") && <TableCell style={{ width: 80, minWidth: 80 }} className="text-right tabular-nums">{row.quantity_incoming ?? "—"}</TableCell>}
                      {colVisible("amzn") && <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.ext_amzn_inv ?? "—"}</TableCell>}
                      {colVisible("wlmt") && <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.ext_wlmt_inv ?? "—"}</TableCell>}
                      {colVisible("in_kits") && <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.quantity_in_kits ?? "—"}</TableCell>}
                      {colVisible("total") && <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.total_stock ?? "—"}</TableCell>}
                      {colVisible("supplier") && <TableCell style={{ width: 140, minWidth: 140, maxWidth: 140 }} className="text-xs truncate border-l-2 border-border" title={row.supplier}>{row.supplier || "—"}</TableCell>}
                      {colVisible("cost") && <TableCell style={{ width: 70, minWidth: 70 }} className="text-right tabular-nums">{row.unit_cost ? `$${Number(row.unit_cost).toFixed(2)}` : "—"}</TableCell>}
                      {colVisible("lead_time") && <TableCell style={{ width: 80, minWidth: 80 }} className="text-right tabular-nums">{row.lead_time != null ? `${row.lead_time}d` : "—"}</TableCell>}
                      {colVisible("moq") && <TableCell style={{ width: 65, minWidth: 65 }} className="text-right tabular-nums">{row.moq ?? "—"}</TableCell>}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
        </Card>
      )}

      {/* SKU Notes Modal */}
      {noteModalSku && (() => {
        const modalRow = (snapshotQuery.data ?? []).find((r: any) => r.sku === noteModalSku);
        return (
          <SkuNotesModal
            open={!!noteModalSku}
            onClose={() => setNoteModalSku(null)}
            sku={noteModalSku}
            productTitle={modalRow?.product_title || modalRow?.description}
            initialNotes={skuNotesQuery.data?.[noteModalSku] ?? ""}
            onSave={(notes) => saveNoteMutation.mutate({ sku: noteModalSku, notes })}
            isSaving={saveNoteMutation.isPending}
          />
        );
      })()}
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
