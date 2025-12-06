import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PackageCheck, RefreshCw, Calendar, User, Loader2, ChevronDown, ChevronRight, Clock, Layers } from "lucide-react";
import { subDays } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { SessionDetailDialog } from "@/components/session-detail-dialog";

const CST_TIMEZONE = 'America/Chicago';

interface PackedOrder {
  orderNumber: string;
  packedAt: string;
  packedBy: string;
  packingSeconds: number | null;
  sessionId: string | null;
  stationId: string | null;
  stationType: string | null;
}

interface Station {
  id: string;
  name: string;
  locationHint: string | null;
}

interface DailySummary {
  date: string;
  count: number;
  avgPackingSeconds: number | null;
  ordersWithTiming: number;
  userBreakdown: Record<string, number>;
  orders: PackedOrder[];
}

interface UserSummary {
  username: string;
  count: number;
  avgPackingSeconds: number | null;
  ordersWithTiming: number;
}

interface PackedShipmentsResponse {
  startDate: string;
  endDate: string;
  totalPacked: number;
  overallAvgPackingSeconds: number | null;
  ordersWithTiming: number;
  userSummary: UserSummary[];
  dailySummary: DailySummary[];
}

// Helper function to format seconds as human-readable time
const formatPackingTime = (seconds: number | null): string => {
  if (seconds === null) return '-';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

export default function PackedShipmentsReport() {
  // Get today and 7 days ago in Central Time
  const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
  const today = formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  const sevenDaysAgo = formatInTimeZone(subDays(cstNow, 7), CST_TIMEZONE, 'yyyy-MM-dd');
  
  const [startDate, setStartDate] = useState(sevenDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Query stations for name lookup
  const { data: stationsData } = useQuery<{ stations: Station[] }>({
    queryKey: ["/api/stations"],
  });

  // Create station lookup map (keyed by station id to match stationId in events)
  // Memoized to prevent recreation on every render
  const stationMap = useMemo(() => {
    const map = new Map<string, Station>();
    if (stationsData?.stations) {
      for (const station of stationsData.stations) {
        map.set(station.id, station);
      }
    }
    return map;
  }, [stationsData?.stations]);

  const getStationDisplay = (stationId: string | null, stationType: string | null): string => {
    // Try to get station name from lookup first
    if (stationId) {
      const station = stationMap.get(stationId);
      if (station) {
        return station.name;
      }
    }
    // Fall back to stationType, mapping "packing" → "Boxing" and "bagging" → "Bagging"
    if (stationType === 'packing') {
      return 'Boxing';
    }
    if (stationType === 'bagging') {
      return 'Bagging';
    }
    // Handle unknown station types by capitalizing them (future-proofing)
    if (stationType) {
      return stationType.charAt(0).toUpperCase() + stationType.slice(1);
    }
    // Default fallback when no station info available
    return 'Unknown';
  };

  const { data, isLoading, refetch, isRefetching } = useQuery<PackedShipmentsResponse>({
    queryKey: ['/api/reports/packed-shipments', startDate, endDate],
    queryFn: async ({ queryKey }) => {
      const [endpoint, start, end] = queryKey as [string, string, string];
      const url = `${endpoint}?startDate=${start}&endDate=${end}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
    enabled: !!startDate && !!endDate,
  });

  const toggleDateExpanded = (date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  const formatDateTime = (dateStr: string) => {
    try {
      // Format time in Central Time
      return formatInTimeZone(new Date(dateStr), CST_TIMEZONE, "h:mm a");
    } catch {
      return dateStr;
    }
  };

  const formatDisplayDate = (dateStr: string) => {
    try {
      // Date string is already in Central Time from backend, just format it nicely
      // Using noon to avoid any date boundary issues
      return formatInTimeZone(new Date(dateStr + 'T12:00:00'), CST_TIMEZONE, "EEE, MMM d, yyyy");
    } catch {
      return dateStr;
    }
  };

  const extractUsername = (email: string) => {
    return email.split('@')[0];
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl font-bold text-foreground flex items-center gap-3" data-testid="text-page-title">
              <PackageCheck className="h-10 w-10 text-green-500" />
              Packed Shipments
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Shipments completed at packing station by date
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isRefetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Date Range Selection */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Date Range
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-[180px]"
                  data-testid="input-start-date"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-[180px]"
                  data-testid="input-end-date"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setStartDate(today);
                    setEndDate(today);
                  }}
                  data-testid="button-today"
                >
                  Today
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setStartDate(sevenDaysAgo);
                    setEndDate(today);
                  }}
                  data-testid="button-7-days"
                >
                  Last 7 Days
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const now = toZonedTime(new Date(), CST_TIMEZONE);
                    setStartDate(formatInTimeZone(subDays(now, 30), CST_TIMEZONE, 'yyyy-MM-dd'));
                    setEndDate(formatInTimeZone(now, CST_TIMEZONE, 'yyyy-MM-dd'));
                  }}
                  data-testid="button-30-days"
                >
                  Last 30 Days
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        {data && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="border-green-500/30 bg-green-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <PackageCheck className="h-5 w-5 text-green-500" />
                  Total Packed
                </CardTitle>
                <CardDescription>
                  In selected date range
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-green-600" data-testid="text-total-packed">
                  {data.totalPacked}
                </div>
              </CardContent>
            </Card>

            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Clock className="h-5 w-5 text-amber-500" />
                  Avg Pack Time
                </CardTitle>
                <CardDescription>
                  Scan to complete
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-amber-600" data-testid="text-avg-time">
                  {formatPackingTime(data.overallAvgPackingSeconds)}
                </div>
                {data.ordersWithTiming > 0 && data.ordersWithTiming < data.totalPacked && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Based on {data.ordersWithTiming} of {data.totalPacked} orders
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-blue-500" />
                  Days with Activity
                </CardTitle>
                <CardDescription>
                  Days with at least one pack
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-blue-600" data-testid="text-active-days">
                  {data.dailySummary.length}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className="h-5 w-5 text-purple-500" />
                  Packers
                </CardTitle>
                <CardDescription>
                  Unique users who packed
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-purple-600" data-testid="text-unique-packers">
                  {data.userSummary.length}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* User Leaderboard */}
        {data && data.userSummary.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl flex items-center gap-2">
                <User className="h-5 w-5" />
                Packer Leaderboard
              </CardTitle>
              <CardDescription>
                Orders packed by user in the selected date range (with average pack time)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {data.userSummary.map((user, index) => (
                  <div
                    key={user.username}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted"
                    data-testid={`packer-${index}`}
                  >
                    <span className="font-medium">{extractUsername(user.username)}</span>
                    <Badge variant="secondary">{user.count}</Badge>
                    {user.avgPackingSeconds !== null && (
                      <Badge variant="outline" className="text-amber-600 border-amber-300">
                        <Clock className="h-3 w-3 mr-1" />
                        {formatPackingTime(user.avgPackingSeconds)}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Daily Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              Daily Breakdown
            </CardTitle>
            <CardDescription>
              Click on a date to see individual orders
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-3 text-lg text-muted-foreground">Loading packed shipments...</span>
              </div>
            ) : data?.dailySummary && data.dailySummary.length > 0 ? (
              <div className="space-y-2">
                {data.dailySummary.map((day) => (
                  <Collapsible
                    key={day.date}
                    open={expandedDates.has(day.date)}
                    onOpenChange={() => toggleDateExpanded(day.date)}
                  >
                    <CollapsibleTrigger
                      className="w-full flex items-center justify-between p-4 rounded-lg bg-muted/50 hover-elevate active-elevate-2"
                      data-testid={`day-row-${day.date}`}
                    >
                      <div className="flex items-center gap-4">
                        {expandedDates.has(day.date) ? (
                          <ChevronDown className="h-5 w-5" />
                        ) : (
                          <ChevronRight className="h-5 w-5" />
                        )}
                        <span className="font-semibold text-lg">{formatDisplayDate(day.date)}</span>
                        {day.avgPackingSeconds !== null && (
                          <Badge variant="outline" className="text-amber-600 border-amber-300">
                            <Clock className="h-3 w-3 mr-1" />
                            avg {formatPackingTime(day.avgPackingSeconds)}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="flex gap-2">
                          {Object.entries(day.userBreakdown).map(([username, count]) => (
                            <Badge key={username} variant="outline" className="text-xs">
                              {extractUsername(username)}: {count}
                            </Badge>
                          ))}
                        </div>
                        <Badge className="bg-green-600 hover:bg-green-700">{day.count} orders</Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 ml-9 border-l-2 border-muted pl-4 space-y-1">
                        {day.orders.map((order, idx) => (
                          <div
                            key={`${order.orderNumber}-${idx}`}
                            className="grid grid-cols-[1fr_90px_80px_100px_70px_100px] items-center gap-2 py-2 px-3 rounded hover:bg-muted/30"
                            data-testid={`order-row-${order.orderNumber}`}
                          >
                            <a
                              href={`/shipments?search=${order.orderNumber}`}
                              className="font-mono text-sm text-primary hover:underline truncate"
                              data-testid={`link-order-${order.orderNumber}`}
                            >
                              {order.orderNumber}
                            </a>
                            {order.sessionId ? (
                              <button
                                onClick={() => setSelectedSessionId(order.sessionId)}
                                className="text-xs font-mono text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-200 flex items-center gap-1"
                                data-testid={`button-session-${order.sessionId}`}
                              >
                                <Layers className="h-3 w-3" />
                                {order.sessionId}
                              </button>
                            ) : (
                              <span className="text-sm text-muted-foreground text-center">—</span>
                            )}
                            <span className="text-sm text-muted-foreground truncate text-center" data-testid={`station-${order.orderNumber}`}>
                              {getStationDisplay(order.stationId, order.stationType)}
                            </span>
                            <span className="text-sm text-muted-foreground truncate text-right">
                              {extractUsername(order.packedBy)}
                            </span>
                            <span className="text-sm text-amber-600 font-medium text-right">
                              {order.packingSeconds !== null ? formatPackingTime(order.packingSeconds) : '-'}
                            </span>
                            <span className="text-sm text-muted-foreground text-right">
                              {formatDateTime(order.packedAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <PackageCheck className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg">No packed shipments in this date range</p>
                <p className="text-sm mt-1">Try selecting a different date range</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Session Detail Modal */}
      <SessionDetailDialog
        picklistId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
