import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PackageCheck, RefreshCw, Calendar, User, Loader2, ChevronDown, ChevronRight, Clock, Layers, Copy, Monitor, ListChecks, Trophy, Medal, Award } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
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
  avatarUrl: string | null;
  count: number;
  avgPackingSeconds: number | null;
  ordersWithTiming: number;
}

interface StationSummary {
  stationId: string;
  count: number;
  avgPackingSeconds: number | null;
  ordersWithTiming: number;
}

interface SessionSummary {
  sessionId: string;
  count: number;
  avgPackingSeconds: number | null;
  ordersWithTiming: number;
}

interface StationSessionSummary {
  stationId: string;
  sessionCount: number;
  avgSessionSeconds: number | null;
}

interface PackedShipmentsResponse {
  startDate: string;
  endDate: string;
  totalPacked: number;
  overallAvgPackingSeconds: number | null;
  ordersWithTiming: number;
  userSummary: UserSummary[];
  stationSummary: StationSummary[];
  sessionSummary: SessionSummary[];
  stationSessionSummary: StationSessionSummary[];
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
  // Get dates in Central Time
  const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
  const today = formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  const yesterday = formatInTimeZone(subDays(cstNow, 1), CST_TIMEZONE, 'yyyy-MM-dd');
  const sevenDaysAgo = formatInTimeZone(subDays(cstNow, 7), CST_TIMEZONE, 'yyyy-MM-dd');
  
  // Default to "today" only for quick daily review
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const { toast } = useToast();

  const copyOrderNumber = async (orderNumber: string) => {
    try {
      await navigator.clipboard.writeText(orderNumber);
      toast({
        title: "Copied",
        description: `${orderNumber} copied to clipboard`,
      });
    } catch {
      toast({
        title: "Failed to copy",
        description: "Could not copy to clipboard",
        variant: "destructive",
      });
    }
  };

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
            <CardDescription>
              All times in Central Time (CT)
            </CardDescription>
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
              <div className="flex flex-wrap gap-2">
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
                    setStartDate(yesterday);
                    setEndDate(yesterday);
                  }}
                  data-testid="button-yesterday"
                >
                  Yesterday
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

        {/* Station & Session Timing Summary */}
        {data && (data.stationSummary?.length > 0 || data.sessionSummary?.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Station Timing */}
            {data.stationSummary && data.stationSummary.length > 0 && (
              <Card className="border-cyan-500/30 bg-cyan-500/5">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Monitor className="h-5 w-5 text-cyan-500" />
                    Avg Time by Station
                  </CardTitle>
                  <CardDescription>
                    Average packing time per workstation
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {data.stationSummary.map((station) => {
                      const stationInfo = stationMap.get(station.stationId);
                      const displayName = stationInfo?.name || station.stationId;
                      return (
                        <div
                          key={station.stationId}
                          className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                          data-testid={`station-timing-${station.stationId}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{displayName}</span>
                            <Badge variant="secondary" className="text-xs">{station.count} orders</Badge>
                          </div>
                          <Badge variant="outline" className="text-cyan-600 border-cyan-300">
                            <Clock className="h-3 w-3 mr-1" />
                            {formatPackingTime(station.avgPackingSeconds)}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Session Timing - Overall Average */}
            {data.sessionSummary && data.sessionSummary.length > 0 && (
              <Card className="border-indigo-500/30 bg-indigo-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <ListChecks className="h-5 w-5 text-indigo-500" />
                    Avg Pack Time per Session
                  </CardTitle>
                  <CardDescription>
                    Overall average across {data.sessionSummary.length} session{data.sessionSummary.length !== 1 ? 's' : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const sessionsWithTiming = data.sessionSummary.filter(s => s.avgPackingSeconds !== null);
                    const totalAvgSeconds = sessionsWithTiming.reduce((sum, s) => sum + (s.avgPackingSeconds || 0), 0);
                    const overallSessionAvg = sessionsWithTiming.length > 0 
                      ? totalAvgSeconds / sessionsWithTiming.length 
                      : null;
                    return (
                      <div className="text-4xl font-bold text-indigo-600" data-testid="text-avg-session-time">
                        {formatPackingTime(overallSessionAvg)}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            {/* Avg Session Time per Station */}
            <Card className="border-purple-500/30 bg-purple-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Layers className="h-5 w-5 text-purple-500" />
                  Avg Session Time by Station
                </CardTitle>
                <CardDescription>
                  Average time to complete a full session (~28 orders) at each station
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.stationSessionSummary && data.stationSessionSummary.length > 0 ? (
                  <div className="space-y-2">
                    {data.stationSessionSummary.map((station) => {
                      const stationInfo = stationMap.get(station.stationId);
                      const displayName = stationInfo?.name || station.stationId;
                      return (
                        <div
                          key={station.stationId}
                          className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                          data-testid={`station-session-${station.stationId}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{displayName}</span>
                            <Badge variant="secondary" className="text-xs">{station.sessionCount} session{station.sessionCount !== 1 ? 's' : ''}</Badge>
                          </div>
                          <Badge variant="outline" className="text-purple-600 border-purple-300">
                            <Clock className="h-3 w-3 mr-1" />
                            {formatPackingTime(station.avgSessionSeconds)}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-4xl font-bold text-purple-600" data-testid="text-no-station-sessions">
                    0
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* User Leaderboard - Gamified */}
        {data && data.userSummary.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-xl flex items-center gap-2">
                <Trophy className="h-5 w-5 text-amber-500" />
                Packer Leaderboard
              </CardTitle>
              <CardDescription>
                Top performers for the selected date range
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {data.userSummary.map((user, index) => {
                  const rank = index + 1;
                  const isGold = rank === 1;
                  const isSilver = rank === 2;
                  const isBronze = rank === 3;
                  const isTopThree = rank <= 3;
                  
                  // Get initials for avatar fallback
                  const name = extractUsername(user.username);
                  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || name.slice(0, 2).toUpperCase();
                  
                  // Rank badge styling
                  const getRankBadge = () => {
                    if (isGold) return (
                      <div className="absolute -top-1 -left-1 w-7 h-7 rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 flex items-center justify-center shadow-md border-2 border-yellow-300">
                        <Trophy className="h-4 w-4 text-white" />
                      </div>
                    );
                    if (isSilver) return (
                      <div className="absolute -top-1 -left-1 w-7 h-7 rounded-full bg-gradient-to-br from-gray-300 to-gray-400 flex items-center justify-center shadow-md border-2 border-gray-200">
                        <Medal className="h-4 w-4 text-white" />
                      </div>
                    );
                    if (isBronze) return (
                      <div className="absolute -top-1 -left-1 w-7 h-7 rounded-full bg-gradient-to-br from-amber-600 to-amber-700 flex items-center justify-center shadow-md border-2 border-amber-500">
                        <Award className="h-4 w-4 text-white" />
                      </div>
                    );
                    return (
                      <div className="absolute -top-1 -left-1 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground border">
                        {rank}
                      </div>
                    );
                  };
                  
                  return (
                    <div
                      key={user.username}
                      className={`relative flex flex-col items-center p-4 rounded-xl transition-all ${
                        isGold ? 'bg-gradient-to-br from-yellow-50 to-amber-100 border-2 border-yellow-300 shadow-lg dark:from-yellow-900/20 dark:to-amber-900/30 dark:border-yellow-700' :
                        isSilver ? 'bg-gradient-to-br from-gray-50 to-gray-100 border-2 border-gray-300 shadow-md dark:from-gray-800/50 dark:to-gray-700/50 dark:border-gray-600' :
                        isBronze ? 'bg-gradient-to-br from-amber-50 to-orange-100 border-2 border-amber-400 shadow-md dark:from-amber-900/20 dark:to-orange-900/30 dark:border-amber-700' :
                        'bg-muted/50 border border-border'
                      }`}
                      data-testid={`packer-${index}`}
                    >
                      {/* Rank Badge */}
                      {getRankBadge()}
                      
                      {/* Avatar */}
                      <Avatar className={`${isTopThree ? 'h-14 w-14' : 'h-12 w-12'} mb-2 ${isGold ? 'ring-2 ring-yellow-400 ring-offset-2' : ''}`}>
                        <AvatarImage src={user.avatarUrl || undefined} alt={name} />
                        <AvatarFallback className={`text-sm font-semibold ${
                          isGold ? 'bg-yellow-200 text-yellow-800' :
                          isSilver ? 'bg-gray-200 text-gray-700' :
                          isBronze ? 'bg-amber-200 text-amber-800' :
                          'bg-primary/10 text-primary'
                        }`}>
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      
                      {/* Name */}
                      <span className={`font-semibold text-center truncate w-full ${isTopThree ? 'text-base' : 'text-sm'}`}>
                        {name}
                      </span>
                      
                      {/* Stats */}
                      <div className="flex items-center gap-2 mt-2">
                        <Badge 
                          className={`${
                            isGold ? 'bg-yellow-500 hover:bg-yellow-600 text-white' :
                            isSilver ? 'bg-gray-400 hover:bg-gray-500 text-white' :
                            isBronze ? 'bg-amber-600 hover:bg-amber-700 text-white' :
                            ''
                          }`}
                          variant={isTopThree ? 'default' : 'secondary'}
                        >
                          {user.count} orders
                        </Badge>
                      </div>
                      
                      {/* Avg Time */}
                      {user.avgPackingSeconds !== null && (
                        <div className={`flex items-center gap-1 mt-1 text-sm ${
                          isGold ? 'text-yellow-700 dark:text-yellow-400' :
                          isSilver ? 'text-gray-600 dark:text-gray-300' :
                          isBronze ? 'text-amber-700 dark:text-amber-400' :
                          'text-muted-foreground'
                        }`}>
                          <Clock className="h-3 w-3" />
                          <span>{formatPackingTime(user.avgPackingSeconds)} avg</span>
                        </div>
                      )}
                    </div>
                  );
                })}
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
                      className="w-full flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 sm:p-4 rounded-lg bg-muted/50 hover-elevate active-elevate-2 gap-2 sm:gap-4"
                      data-testid={`day-row-${day.date}`}
                    >
                      <div className="flex items-center gap-2 sm:gap-4">
                        {expandedDates.has(day.date) ? (
                          <ChevronDown className="h-5 w-5 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="h-5 w-5 flex-shrink-0" />
                        )}
                        <span className="font-semibold text-base sm:text-lg">{formatDisplayDate(day.date)}</span>
                        <Badge className="bg-green-600 hover:bg-green-700 sm:hidden">{day.count}</Badge>
                        {day.avgPackingSeconds !== null && (
                          <Badge variant="outline" className="text-amber-600 border-amber-300 hidden sm:flex">
                            <Clock className="h-3 w-3 mr-1" />
                            avg {formatPackingTime(day.avgPackingSeconds)}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-4 flex-wrap pl-7 sm:pl-0">
                        {day.avgPackingSeconds !== null && (
                          <Badge variant="outline" className="text-amber-600 border-amber-300 sm:hidden">
                            <Clock className="h-3 w-3 mr-1" />
                            avg {formatPackingTime(day.avgPackingSeconds)}
                          </Badge>
                        )}
                        <div className="flex gap-1 sm:gap-2 flex-wrap">
                          {Object.entries(day.userBreakdown).map(([username, count]) => (
                            <Badge key={username} variant="outline" className="text-xs">
                              {extractUsername(username)}: {count}
                            </Badge>
                          ))}
                        </div>
                        <Badge className="bg-green-600 hover:bg-green-700 hidden sm:flex">{day.count} orders</Badge>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 ml-2 sm:ml-9 border-l-2 border-muted pl-2 sm:pl-4 space-y-2 sm:space-y-1">
                        {day.orders.map((order, idx) => (
                          <div
                            key={`${order.orderNumber}-${idx}`}
                            className="flex flex-col gap-1 py-2 px-2 sm:px-3 rounded hover:bg-muted/30 lg:grid lg:grid-cols-[1fr_90px_1fr_100px_70px_100px] lg:items-center lg:gap-2"
                            data-testid={`order-row-${order.orderNumber}`}
                          >
                            {/* Order number row - always visible */}
                            <div className="flex items-center justify-between gap-1 min-w-0 lg:justify-start">
                              <div className="flex items-center gap-1 min-w-0">
                                <a
                                  href={`/shipments?search=${order.orderNumber}`}
                                  className="font-mono text-sm text-primary hover:underline truncate"
                                  data-testid={`link-order-${order.orderNumber}`}
                                >
                                  {order.orderNumber}
                                </a>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="flex-shrink-0 h-6 w-6"
                                  onClick={() => copyOrderNumber(order.orderNumber)}
                                  data-testid={`button-copy-${order.orderNumber}`}
                                >
                                  <Copy className="h-3 w-3" />
                                </Button>
                              </div>
                              {/* Mobile: show time on same row as order number */}
                              <span className="text-sm text-muted-foreground lg:hidden">
                                {formatDateTime(order.packedAt)}
                              </span>
                            </div>
                            
                            {/* Mobile: metadata row */}
                            <div className="flex items-center gap-2 flex-wrap text-xs lg:hidden">
                              <span className="text-muted-foreground">
                                {extractUsername(order.packedBy)}
                              </span>
                              <span className="text-amber-600 font-medium">
                                {order.packingSeconds !== null ? formatPackingTime(order.packingSeconds) : '-'}
                              </span>
                              {order.sessionId && (
                                <button
                                  onClick={() => setSelectedSessionId(order.sessionId)}
                                  className="font-mono text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-200 flex items-center gap-1"
                                  data-testid={`button-session-mobile-${order.sessionId}`}
                                >
                                  <Layers className="h-3 w-3" />
                                  {order.sessionId}
                                </button>
                              )}
                              <span className="text-muted-foreground" data-testid={`station-mobile-${order.orderNumber}`}>
                                {getStationDisplay(order.stationId, order.stationType)}
                              </span>
                            </div>
                            
                            {/* Desktop: remaining columns (hidden on mobile) */}
                            <div className="hidden lg:block">
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
                            </div>
                            <span className="hidden lg:block text-sm text-muted-foreground truncate text-center" data-testid={`station-${order.orderNumber}`}>
                              {getStationDisplay(order.stationId, order.stationType)}
                            </span>
                            <span className="hidden lg:block text-sm text-muted-foreground truncate text-right">
                              {extractUsername(order.packedBy)}
                            </span>
                            <span className="hidden lg:block text-sm text-amber-600 font-medium text-right">
                              {order.packingSeconds !== null ? formatPackingTime(order.packingSeconds) : '-'}
                            </span>
                            <span className="hidden lg:block text-sm text-muted-foreground text-right">
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
