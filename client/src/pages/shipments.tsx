import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Search, Truck, Package, RefreshCw, ChevronDown, ChevronUp, Filter, X, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, Order } from "@shared/schema";

interface ShipmentWithOrder extends Shipment {
  order: Order | null;
}

interface ShipmentsResponse {
  shipments: ShipmentWithOrder[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function Shipments() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { toast } = useToast();

  // Filter states
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string[]>([]);
  const [carrierCode, setCarrierCode] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Pagination and sorting
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState("desc");

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        if (isMounted) {
          toast({
            title: "Connection error",
            description: "Please refresh the page and log in again.",
            variant: "destructive",
          });
        }
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'order_update' && data.order) {
            queryClient.invalidateQueries({ queryKey: ["/api/shipments"] });
            if (isMounted) {
              toast({
                title: `Order ${data.order.orderNumber} updated`,
                description: `Shipment tracking information updated for ${data.order.customerName}`,
              });
            }
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = (event) => {
        console.log('WebSocket disconnected', event.code, event.reason);
        
        if (event.code === 1006 && reconnectAttempts > 3) {
          console.error('WebSocket failed to connect - auth may have failed');
          if (isMounted) {
            toast({
              title: "Connection lost",
              description: "Please refresh the page and log in again.",
              variant: "destructive",
            });
          }
          return;
        }
        
        if (event.code === 1008 || event.code === 1011) {
          console.error('WebSocket auth failed - please log in again');
          if (isMounted) {
            toast({
              title: "Connection lost",
              description: "Please refresh the page and log in again.",
              variant: "destructive",
            });
          }
          return;
        }
        
        if (isMounted) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
          reconnectAttempts++;
          reconnectTimeout = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
      }
    };
  }, [toast]);

  // Build query string
  const buildQueryString = () => {
    const params = new URLSearchParams();
    
    if (search) params.append('search', search);
    status.forEach(s => params.append('status', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    
    if (dateFrom) params.append('dateFrom', dateFrom);
    if (dateTo) params.append('dateTo', dateTo);
    
    params.append('page', page.toString());
    params.append('pageSize', pageSize.toString());
    params.append('sortBy', sortBy);
    params.append('sortOrder', sortOrder);
    
    return params.toString();
  };

  const { data: shipmentsData, isLoading, isError, error } = useQuery<ShipmentsResponse>({
    queryKey: ["/api/shipments", search, status, carrierCode, dateFrom, dateTo, page, pageSize, sortBy, sortOrder],
    queryFn: async () => {
      const queryString = buildQueryString();
      const url = `/api/shipments?${queryString}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error("Failed to fetch shipments");
      }
      return response.json();
    },
  });

  // Show error toast when query fails
  useEffect(() => {
    if (isError && error) {
      toast({
        title: "Failed to load shipments",
        description: error instanceof Error ? error.message : "An error occurred while fetching shipments",
        variant: "destructive",
      });
    }
  }, [isError, error, toast]);

  // Only derive data when not in error state to avoid showing stale data
  const shipments = !isError && shipmentsData?.shipments ? shipmentsData.shipments : [];
  const total = !isError && shipmentsData?.total ? shipmentsData.total : 0;
  const totalPages = !isError && shipmentsData?.totalPages ? shipmentsData.totalPages : 1;

  const clearFilters = () => {
    setSearch("");
    setStatus([]);
    setCarrierCode([]);
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const activeFiltersCount = [
    search,
    status.length > 0,
    carrierCode.length > 0,
    dateFrom,
    dateTo,
  ].filter(Boolean).length;

  const toggleArrayFilter = (value: string, current: string[], setter: (val: string[]) => void) => {
    if (current.includes(value)) {
      setter(current.filter(v => v !== value));
    } else {
      setter([...current, value]);
    }
    setPage(1);
  };

  const syncShipmentsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/shipments/sync");
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to sync shipments");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/shipments"] });
      const trackingMsg = data.trackingEnrichedCount > 0 ? `, ${data.trackingEnrichedCount} with tracking details` : '';
      toast({
        title: "Shipments synced",
        description: `Synced ${data.syncedCount} shipments (${data.createdCount} new, ${data.updatedCount} updated${trackingMsg})`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to sync shipments",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getStatusBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline">Unknown</Badge>;
    }
    if (status === "delivered") {
      return <Badge className="bg-green-600 text-white">Delivered</Badge>;
    }
    if (status === "shipped") {
      return <Badge className="bg-blue-600 text-white">Shipped</Badge>;
    }
    if (status === "cancelled") {
      return <Badge className="bg-red-600 text-white">Cancelled</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  return (
    <>
      <div className="max-w-7xl mx-auto p-6 space-y-6 pb-32">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Shipments</h1>
          <p className="text-muted-foreground text-lg">
            Track all shipments • Real-time carrier updates
          </p>
        </div>

        {/* Search and Filters */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                data-testid="input-search-shipments"
                type="search"
                placeholder="Search by tracking number, carrier, shipment ID..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-10 h-14 text-lg"
              />
            </div>

            <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
              <div className="flex items-center justify-between gap-4">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" className="gap-2" data-testid="button-toggle-filters">
                    <Filter className="h-4 w-4" />
                    Advanced Filters
                    {activeFiltersCount > 0 && (
                      <Badge variant="secondary" className="ml-1">{activeFiltersCount}</Badge>
                    )}
                    {filtersOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                
                <div className="flex items-center gap-2">
                  {activeFiltersCount > 0 && (
                    <Button variant="ghost" onClick={clearFilters} className="gap-2" data-testid="button-clear-filters">
                      <X className="h-4 w-4" />
                      Clear Filters
                    </Button>
                  )}
                  <Button
                    data-testid="button-sync-shipments"
                    onClick={() => syncShipmentsMutation.mutate()}
                    disabled={syncShipmentsMutation.isPending}
                    className="gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncShipmentsMutation.isPending ? 'animate-spin' : ''}`} />
                    {syncShipmentsMutation.isPending ? "Syncing..." : "Sync from ShipStation"}
                  </Button>
                </div>
              </div>

              <CollapsibleContent className="pt-4 space-y-4">
                {/* Status and Carrier Filters */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Shipment Status</label>
                    <div className="flex flex-wrap gap-2">
                      {['pending', 'shipped', 'delivered', 'cancelled', 'exception'].map(s => (
                        <Badge
                          key={s}
                          variant={status.includes(s) ? "default" : "outline"}
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleArrayFilter(s, status, setStatus)}
                          data-testid={`filter-status-${s}`}
                        >
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Carrier</label>
                    <div className="flex flex-wrap gap-2">
                      {['usps', 'fedex', 'ups', 'dhl'].map(carrier => (
                        <Badge
                          key={carrier}
                          variant={carrierCode.includes(carrier) ? "default" : "outline"}
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleArrayFilter(carrier, carrierCode, setCarrierCode)}
                          data-testid={`filter-carrier-${carrier}`}
                        >
                          {carrier.toUpperCase()}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Date Filter */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Ship Date Range</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                        placeholder="From"
                        data-testid="input-date-from"
                      />
                      <Input
                        type="date"
                        value={dateTo}
                        onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                        placeholder="To"
                        data-testid="input-date-to"
                      />
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Sort and Page Size */}
            <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
              <div className="flex items-center gap-2">
                <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Sort by:</span>
                <Select value={sortBy} onValueChange={(val) => { setSortBy(val); setPage(1); }}>
                  <SelectTrigger className="w-40" data-testid="select-sort-by">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="createdAt" data-testid="sort-option-createdAt">Created Date</SelectItem>
                    <SelectItem value="shipDate" data-testid="sort-option-shipDate">Ship Date</SelectItem>
                    <SelectItem value="trackingNumber" data-testid="sort-option-trackingNumber">Tracking #</SelectItem>
                    <SelectItem value="status" data-testid="sort-option-status">Status</SelectItem>
                    <SelectItem value="carrierCode" data-testid="sort-option-carrierCode">Carrier</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortOrder} onValueChange={(val) => { setSortOrder(val); setPage(1); }}>
                  <SelectTrigger className="w-32" data-testid="select-sort-order">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc" data-testid="sort-order-desc">Newest</SelectItem>
                    <SelectItem value="asc" data-testid="sort-order-asc">Oldest</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm font-semibold">Show:</span>
                <Select value={pageSize.toString()} onValueChange={(val) => { setPageSize(parseInt(val)); setPage(1); }}>
                  <SelectTrigger className="w-24" data-testid="select-page-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25" data-testid="page-size-25">25</SelectItem>
                    <SelectItem value="50" data-testid="page-size-50">50</SelectItem>
                    <SelectItem value="100" data-testid="page-size-100">100</SelectItem>
                    <SelectItem value="200" data-testid="page-size-200">200</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Shipments List - Explicit branching for loading, error, empty, and success states */}
        {isLoading ? (
          <div className="text-center py-12">
            <Truck className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
            <p className="text-muted-foreground text-lg">Loading shipments...</p>
          </div>
        ) : isError ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Truck className="h-16 w-16 text-destructive mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Failed to load shipments</h3>
              <p className="text-muted-foreground mb-4">
                {error instanceof Error ? error.message : "An error occurred while fetching shipments"}
              </p>
              <Button
                variant="outline"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/shipments"] })}
                data-testid="button-retry-shipments"
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : shipments.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Truck className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No shipments found</h3>
              <p className="text-muted-foreground">
                {activeFiltersCount > 0
                  ? "Try adjusting your filters or clearing them to see more results"
                  : "Shipments will appear here when orders are fulfilled through ShipStation"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Results Summary and Pagination - Only shown in success state */}
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground" data-testid="text-results-summary">
                Showing {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, total)} of {total.toLocaleString()} shipments
              </p>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm px-2" data-testid="text-page-info">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>

            {/* Shipment Cards */}
            <div className="grid gap-4">
              {shipments.map((shipment) => (
                <Link 
                  key={shipment.id} 
                  href={shipment.order ? `/orders/${shipment.order.id}` : "#"}
                >
                  <Card 
                    className="hover-elevate active-elevate-2 cursor-pointer"
                    data-testid={`card-shipment-${shipment.id}`}
                  >
                    <CardHeader className="pb-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-3">
                            <Truck className="h-6 w-6 text-muted-foreground" />
                            <CardTitle className="text-2xl font-mono font-bold">
                              {shipment.trackingNumber || "No tracking"}
                            </CardTitle>
                          </div>
                          <div className="space-y-1">
                            {shipment.order ? (
                              <>
                                <p className="text-xl font-semibold text-foreground">
                                  Order #{shipment.order.orderNumber}
                                </p>
                                <p className="text-lg text-muted-foreground">
                                  {shipment.order.customerName}
                                </p>
                              </>
                            ) : (
                              <p className="text-sm text-muted-foreground">
                                No order linked
                              </p>
                            )}
                            {shipment.shipmentId && (
                              <p className="text-sm font-mono text-muted-foreground">
                                Shipment ID: {shipment.shipmentId}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-4 mt-3 text-lg text-muted-foreground">
                            {shipment.carrierCode && (
                              <div className="flex items-center gap-2">
                                <Package className="h-4 w-4" />
                                <span className="font-semibold uppercase">{shipment.carrierCode}</span>
                              </div>
                            )}
                            {shipment.shipDate && (
                              <span>
                                {new Date(shipment.shipDate).toLocaleString()}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {getStatusBadge(shipment.status)}
                          {shipment.serviceCode && (
                            <p className="text-sm text-muted-foreground">
                              {shipment.serviceCode}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>

            {/* Bottom Pagination - Only shown in success state */}
            <div className="flex items-center justify-between pt-4">
              <p className="text-muted-foreground">
                Showing {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, total)} of {total.toLocaleString()} shipments
              </p>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page-bottom"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm px-2">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-next-page-bottom"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
