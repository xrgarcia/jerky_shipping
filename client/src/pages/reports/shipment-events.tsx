import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClipboardList, RefreshCw, Calendar, Loader2, ArrowUpDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { subDays } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

const CST_TIMEZONE = 'America/Chicago';

interface ShipmentEvent {
  id: number;
  orderNumber: string;
  eventName: string;
  username: string;
  station: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
}

interface ShipmentEventsResponse {
  events: ShipmentEvent[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
  filters: {
    eventNames: string[];
    stations: string[];
    usernames: string[];
  };
}

type SortField = 'occurredAt' | 'username' | 'station' | 'eventName' | 'orderNumber';
type SortOrder = 'asc' | 'desc';

export default function ShipmentEventsReport() {
  const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
  const today = formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  const sevenDaysAgo = formatInTimeZone(subDays(cstNow, 7), CST_TIMEZONE, 'yyyy-MM-dd');
  
  const [startDate, setStartDate] = useState(sevenDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [sortBy, setSortBy] = useState<SortField>('occurredAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  
  const [usernameFilter, setUsernameFilter] = useState('');
  const [stationFilter, setStationFilter] = useState('');
  const [eventNameFilter, setEventNameFilter] = useState('');
  const [orderNumberFilter, setOrderNumberFilter] = useState('');

  const queryParams = new URLSearchParams({
    startDate,
    endDate,
    page: page.toString(),
    limit: limit.toString(),
    sortBy,
    sortOrder,
  });
  if (usernameFilter) queryParams.append('username', usernameFilter);
  if (stationFilter) queryParams.append('station', stationFilter);
  if (eventNameFilter) queryParams.append('eventName', eventNameFilter);
  if (orderNumberFilter) queryParams.append('orderNumber', orderNumberFilter);

  const { data, isLoading, refetch, isRefetching } = useQuery<ShipmentEventsResponse>({
    queryKey: ['/api/reports/shipment-events', queryParams.toString()],
    queryFn: async () => {
      const url = `/api/reports/shipment-events?${queryParams.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
    enabled: !!startDate && !!endDate,
  });

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('desc');
    }
    setPage(1);
  };

  const clearFilters = () => {
    setUsernameFilter('');
    setStationFilter('');
    setEventNameFilter('');
    setOrderNumberFilter('');
    setPage(1);
  };

  const hasActiveFilters = usernameFilter || stationFilter || eventNameFilter || orderNumberFilter;

  const formatDateTime = (dateStr: string) => {
    try {
      return formatInTimeZone(new Date(dateStr), CST_TIMEZONE, "MMM d, yyyy h:mm:ss a");
    } catch {
      return dateStr;
    }
  };

  const extractUsername = (email: string) => {
    return email.split('@')[0];
  };

  const getEventBadgeVariant = (eventName: string): "default" | "secondary" | "outline" => {
    if (eventName.includes('completed') || eventName.includes('success')) return 'default';
    if (eventName.includes('error') || eventName.includes('failed')) return 'outline';
    return 'secondary';
  };

  const SortButton = ({ field, label }: { field: SortField; label: string }) => (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => handleSort(field)}
      className="h-8 px-2 font-medium"
      data-testid={`sort-${field}`}
    >
      {label}
      <ArrowUpDown className={`ml-1 h-3 w-3 ${sortBy === field ? 'text-primary' : 'opacity-50'}`} />
    </Button>
  );

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl font-bold text-foreground flex items-center gap-3" data-testid="text-page-title">
              <ClipboardList className="h-10 w-10 text-blue-500" />
              Shipment Events
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Browse all shipment events with filtering and sorting
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
                  onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
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
                  onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
                  className="w-[180px]"
                  data-testid="input-end-date"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setStartDate(today); setEndDate(today); setPage(1); }}
                  data-testid="button-today"
                >
                  Today
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setStartDate(sevenDaysAgo); setEndDate(today); setPage(1); }}
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
                    setPage(1);
                  }}
                  data-testid="button-30-days"
                >
                  Last 30 Days
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-lg flex items-center gap-2">
                <Search className="h-5 w-5" />
                Filters
              </CardTitle>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="text-muted-foreground"
                  data-testid="button-clear-filters"
                >
                  <X className="h-4 w-4 mr-1" />
                  Clear Filters
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="order-number">Order Number</Label>
                <Input
                  id="order-number"
                  placeholder="Search order..."
                  value={orderNumberFilter}
                  onChange={(e) => { setOrderNumberFilter(e.target.value); setPage(1); }}
                  data-testid="input-filter-order"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Select
                  value={usernameFilter}
                  onValueChange={(v) => { setUsernameFilter(v === "all" ? "" : v); setPage(1); }}
                >
                  <SelectTrigger data-testid="select-filter-username">
                    <SelectValue placeholder="All users" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All users</SelectItem>
                    {data?.filters.usernames.map((u) => (
                      <SelectItem key={u} value={u}>{extractUsername(u)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="station">Station</Label>
                <Select
                  value={stationFilter}
                  onValueChange={(v) => { setStationFilter(v === "all" ? "" : v); setPage(1); }}
                >
                  <SelectTrigger data-testid="select-filter-station">
                    <SelectValue placeholder="All stations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stations</SelectItem>
                    {data?.filters.stations.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-name">Event Type</Label>
                <Select
                  value={eventNameFilter}
                  onValueChange={(v) => { setEventNameFilter(v === "all" ? "" : v); setPage(1); }}
                >
                  <SelectTrigger data-testid="select-filter-event">
                    <SelectValue placeholder="All events" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All events</SelectItem>
                    {data?.filters.eventNames.map((e) => (
                      <SelectItem key={e} value={e}>{e.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary */}
        {data && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span data-testid="text-total-count">
              Showing {data.events.length} of {data.pagination.totalCount.toLocaleString()} events
            </span>
            <span>
              Page {data.pagination.page} of {data.pagination.totalPages}
            </span>
          </div>
        )}

        {/* Events Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-3 text-lg text-muted-foreground">Loading events...</span>
              </div>
            ) : data?.events && data.events.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <SortButton field="occurredAt" label="Time" />
                    </TableHead>
                    <TableHead>
                      <SortButton field="orderNumber" label="Order" />
                    </TableHead>
                    <TableHead>
                      <SortButton field="eventName" label="Event" />
                    </TableHead>
                    <TableHead>
                      <SortButton field="username" label="User" />
                    </TableHead>
                    <TableHead>
                      <SortButton field="station" label="Station" />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.events.map((event) => (
                    <TableRow key={event.id} data-testid={`row-event-${event.id}`}>
                      <TableCell className="font-mono text-sm whitespace-nowrap">
                        {formatDateTime(event.occurredAt)}
                      </TableCell>
                      <TableCell>
                        <a
                          href={`/shipments?search=${event.orderNumber}`}
                          className="font-mono text-sm text-primary hover:underline"
                          data-testid={`link-order-${event.orderNumber}`}
                        >
                          {event.orderNumber}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getEventBadgeVariant(event.eventName)}>
                          {event.eventName.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {extractUsername(event.username)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.station}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <ClipboardList className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg">No events found</p>
                <p className="text-sm mt-1">Try adjusting your filters or date range</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {data && data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(1)}
              disabled={page === 1}
              data-testid="button-first-page"
            >
              First
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="px-4 text-sm text-muted-foreground">
              Page {page} of {data.pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= data.pagination.totalPages}
              data-testid="button-next-page"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(data.pagination.totalPages)}
              disabled={page >= data.pagination.totalPages}
              data-testid="button-last-page"
            >
              Last
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
