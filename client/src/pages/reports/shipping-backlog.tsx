import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { AlertTriangle, Clock, Package, Loader2, Search, ArrowUpDown, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { ShipmentTagBadges } from "@/components/shipment-tag-badges";

interface BacklogCounts {
  backlog: number;
  oneDay: number;
  twoThreeDays: number;
  fourPlusDays: number;
  inProgress: number;
}

interface BacklogOrder {
  id: string;
  orderNumber: string;
  shipToName: string;
  orderDate: string;
  shipToCity: string | null;
  shipToState: string | null;
  lifecyclePhase: string | null;
  decisionSubphase: string | null;
  itemCount: number;
  ageDays: number;
  tags: Array<{ name: string; color: string | null }>;
}

interface BacklogResponse {
  orders: BacklogOrder[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type SortField = "orderNumber" | "shipToName" | "orderDate" | "ageDays" | "shipToState" | "lifecyclePhase" | "itemCount";
type SortDir = "asc" | "desc";
type AgeFilter = "all" | "oneDay" | "twoThreeDays" | "fourPlusDays";

function formatPhase(phase: string | null, subphase: string | null): string {
  if (!phase) return "—";
  const label = phase.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  if (subphase) {
    const subLabel = subphase.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return `${label} / ${subLabel}`;
  }
  return label;
}

function ageBadgeVariant(days: number): "default" | "secondary" | "destructive" | "outline" {
  if (days >= 4) return "destructive";
  if (days >= 2) return "default";
  return "secondary";
}

export default function ShippingBacklogReport() {
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortField, setSortField] = useState<SortField>("ageDays");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [ageFilter, setAgeFilter] = useState<AgeFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) return;

    const params = new URLSearchParams(currentSearch);
    setPage(parseInt(params.get('page') || '1'));
    setPageSize(parseInt(params.get('pageSize') || '25'));
    setSortField((params.get('sortBy') as SortField) || 'ageDays');
    setSortDir((params.get('sortOrder') as SortDir) || 'desc');
    setAgeFilter((params.get('ageFilter') as AgeFilter) || 'all');
    const urlSearch = params.get('search') || '';
    setSearch(urlSearch);
    setDebouncedSearch(urlSearch);

    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]);

  useEffect(() => {
    if (!isInitialized) return;

    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (ageFilter !== 'all') params.set('ageFilter', ageFilter);
    if (page !== 1) params.set('page', page.toString());
    if (pageSize !== 25) params.set('pageSize', pageSize.toString());
    if (sortField !== 'ageDays') params.set('sortBy', sortField);
    if (sortDir !== 'desc') params.set('sortOrder', sortDir);

    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;

    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/reports/shipping-backlog${newUrl}`);
    }
  }, [debouncedSearch, ageFilter, page, pageSize, sortField, sortDir, isInitialized]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const { data: counts, isLoading: countsLoading, isError: countsError } = useQuery<BacklogCounts>({
    queryKey: ["/api/reports/shipping-backlog/counts"],
    refetchInterval: 30000,
  });

  const queryParams = new URLSearchParams();
  queryParams.set('page', page.toString());
  queryParams.set('pageSize', pageSize.toString());
  queryParams.set('sortBy', sortField);
  queryParams.set('sortOrder', sortDir);
  if (debouncedSearch) queryParams.set('search', debouncedSearch);
  if (ageFilter !== 'all') queryParams.set('ageFilter', ageFilter);

  const { data: backlogData, isLoading: ordersLoading, isError: ordersError } = useQuery<BacklogResponse>({
    queryKey: ['/api/reports/shipping-backlog', page, pageSize, sortField, sortDir, debouncedSearch, ageFilter],
    queryFn: () => fetch(`/api/reports/shipping-backlog?${queryParams.toString()}`, { credentials: 'include' }).then(r => r.json()),
    refetchInterval: 30000,
  });

  const orders = backlogData?.orders ?? [];
  const total = backlogData?.total ?? 0;
  const totalPages = backlogData?.totalPages ?? 0;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "ageDays" ? "desc" : "asc");
    }
    setPage(1);
  };

  const handleAgeFilter = (filter: AgeFilter) => {
    setAgeFilter(prev => prev === filter ? "all" : filter);
    setPage(1);
  };

  const handlePageSizeChange = (value: string) => {
    setPageSize(parseInt(value));
    setPage(1);
  };

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/reports/shipping-backlog/counts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/reports/shipping-backlog"] });
  };

  const startRow = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const endRow = Math.min(page * pageSize, total);

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <TableHead>
      <button
        className="flex items-center gap-1 hover-elevate active-elevate-2 rounded px-1 py-0.5"
        onClick={() => handleSort(field)}
        data-testid={`sort-${field}`}
      >
        {children}
        <ArrowUpDown className={`h-3 w-3 ${sortField === field ? 'opacity-100' : 'opacity-40'}`} />
      </button>
    </TableHead>
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Shipping Backlog</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Orders placed before today that haven't entered the fulfillment pipeline
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="button-refresh-backlog">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {countsLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading counts...
        </div>
      ) : countsError ? (
        <div className="flex items-center gap-2 text-red-500" data-testid="text-counts-error">
          <AlertTriangle className="h-4 w-4" />
          Failed to load backlog counts. Try refreshing.
        </div>
      ) : counts ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card
            className={`cursor-pointer ${ageFilter === "all" ? "ring-2 ring-primary" : ""}`}
            onClick={() => { setAgeFilter("all"); setPage(1); }}
            data-testid="card-backlog-total"
          >
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Backlog</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-backlog-total">{counts.backlog}</div>
            </CardContent>
          </Card>

          <Card
            className={`cursor-pointer ${ageFilter === "oneDay" ? "ring-2 ring-primary" : ""}`}
            onClick={() => handleAgeFilter("oneDay")}
            data-testid="card-backlog-1day"
          >
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">1 Day Old</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-backlog-1day">{counts.oneDay}</div>
            </CardContent>
          </Card>

          <Card
            className={`cursor-pointer ${ageFilter === "twoThreeDays" ? "ring-2 ring-primary" : ""}`}
            onClick={() => handleAgeFilter("twoThreeDays")}
            data-testid="card-backlog-2-3days"
          >
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">2–3 Days Old</CardTitle>
              <Clock className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-backlog-2-3days">{counts.twoThreeDays}</div>
            </CardContent>
          </Card>

          <Card
            className={`cursor-pointer ${ageFilter === "fourPlusDays" ? "ring-2 ring-primary" : ""}`}
            onClick={() => handleAgeFilter("fourPlusDays")}
            data-testid="card-backlog-4plus"
          >
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">4+ Days Old</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-500" data-testid="text-backlog-4plus">{counts.fourPlusDays}</div>
            </CardContent>
          </Card>

          <Card data-testid="card-in-progress">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">In Progress</CardTitle>
              <Package className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-500" data-testid="text-in-progress">{counts.inProgress}</div>
              <p className="text-xs text-muted-foreground mt-1">Being fulfilled</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap space-y-0 pb-4">
          <CardTitle className="text-base">Backlog Orders</CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search orders..."
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              className="pl-8"
              data-testid="input-search-backlog"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {ordersLoading ? (
            <div className="flex items-center justify-center p-12 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading backlog orders...
            </div>
          ) : ordersError ? (
            <div className="flex items-center justify-center p-12 gap-2 text-red-500" data-testid="text-orders-error">
              <AlertTriangle className="h-4 w-4" />
              Failed to load backlog orders. Try refreshing.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHeader field="orderNumber">Order</SortHeader>
                    <SortHeader field="shipToName">Customer</SortHeader>
                    <SortHeader field="orderDate">Order Date</SortHeader>
                    <SortHeader field="ageDays">Age</SortHeader>
                    <SortHeader field="shipToState">Destination</SortHeader>
                    <SortHeader field="lifecyclePhase">Phase</SortHeader>
                    <SortHeader field="itemCount">Items</SortHeader>
                    <TableHead>Tags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {debouncedSearch || ageFilter !== "all" ? "No orders match the current filters" : "No backlog orders found"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    orders.map(order => (
                      <TableRow key={order.id} data-testid={`row-backlog-${order.orderNumber}`}>
                        <TableCell>
                          <Link href={`/shipments/${order.id}`}>
                            <span className="text-primary underline cursor-pointer" data-testid={`link-order-${order.orderNumber}`}>
                              {order.orderNumber}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-[180px] truncate" data-testid={`text-customer-${order.orderNumber}`}>
                          {order.shipToName || "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground" data-testid={`text-date-${order.orderNumber}`}>
                          {order.orderDate
                            ? new Date(order.orderDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={ageBadgeVariant(order.ageDays)} data-testid={`badge-age-${order.orderNumber}`}>
                            {order.ageDays}d
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap" data-testid={`text-destination-${order.orderNumber}`}>
                          {order.shipToCity && order.shipToState
                            ? `${order.shipToCity}, ${order.shipToState}`
                            : order.shipToState || order.shipToCity || "—"}
                        </TableCell>
                        <TableCell className="text-sm" data-testid={`text-phase-${order.orderNumber}`}>
                          {formatPhase(order.lifecyclePhase, order.decisionSubphase)}
                        </TableCell>
                        <TableCell className="text-center" data-testid={`text-items-${order.orderNumber}`}>
                          {order.itemCount}
                        </TableCell>
                        <TableCell>
                          <ShipmentTagBadges tags={order.tags} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              {total > 0 && (
                <div className="flex items-center justify-between flex-wrap gap-3 px-4 py-3 border-t">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                      Showing {startRow}–{endRow} of {total} order{total !== 1 ? "s" : ""}
                    </span>
                    <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
                      <SelectTrigger className="w-[80px]" data-testid="select-page-size">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-muted-foreground">per page</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage(p => p - 1)}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground" data-testid="text-page-number">
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage(p => p + 1)}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
