import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Search, Package, Clock, Truck, ChevronDown, ChevronUp, Filter, X, ArrowUpDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import type { Order } from "@shared/schema";

type OrderWithShipment = Order & { hasShipment?: boolean };

interface OrdersResponse {
  orders: OrderWithShipment[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function Orders() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');

  // Filter states
  const [search, setSearch] = useState("");
  const [fulfillmentStatus, setFulfillmentStatus] = useState<string[]>([]);
  const [financialStatus, setFinancialStatus] = useState<string[]>([]);
  const [shipmentStatus, setShipmentStatus] = useState<string[]>([]);
  const [hasShipment, setHasShipment] = useState<string>("all");
  const [hasRefund, setHasRefund] = useState<string>("all");
  const [carrierCode, setCarrierCode] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [maxTotal, setMaxTotal] = useState("");

  // Pagination and sorting
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState("desc");

  // Initialize state from URL params (runs when URL changes, including browser navigation)
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    // Skip if this is the same URL we just synced to avoid loops
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    // Always reset to defaults, then apply URL params
    setSearch(params.get('search') || '');
    setFulfillmentStatus(params.getAll('fulfillmentStatus'));
    setFinancialStatus(params.getAll('financialStatus'));
    setShipmentStatus(params.getAll('shipmentStatus'));
    setCarrierCode(params.getAll('carrierCode'));
    setHasShipment(params.get('hasShipment') || 'all');
    setHasRefund(params.get('hasRefund') || 'all');
    setDateFrom(params.get('dateFrom') || '');
    setDateTo(params.get('dateTo') || '');
    setMinTotal(params.get('minTotal') || '');
    setMaxTotal(params.get('maxTotal') || '');
    setPage(parseInt(params.get('page') || '1'));
    setPageSize(parseInt(params.get('pageSize') || '50'));
    setSortBy(params.get('sortBy') || 'createdAt');
    setSortOrder((params.get('sortOrder') as 'asc' | 'desc') || 'desc');
    
    // Open filters if any are active
    const hasActiveFilters = params.get('search') || 
      params.getAll('fulfillmentStatus').length ||
      params.getAll('financialStatus').length ||
      params.getAll('shipmentStatus').length ||
      params.getAll('carrierCode').length ||
      (params.get('hasShipment') && params.get('hasShipment') !== 'all') ||
      (params.get('hasRefund') && params.get('hasRefund') !== 'all') ||
      params.get('dateFrom') ||
      params.get('dateTo') ||
      params.get('minTotal') ||
      params.get('maxTotal');
    
    if (hasActiveFilters) {
      setFiltersOpen(true);
    }
    
    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]); // Re-run when URL changes (including browser navigation)

  // Update URL when state changes
  useEffect(() => {
    if (!isInitialized) return; // Don't update URL during initialization
    
    const params = new URLSearchParams();
    
    if (search) params.set('search', search);
    fulfillmentStatus.forEach(s => params.append('fulfillmentStatus', s));
    financialStatus.forEach(s => params.append('financialStatus', s));
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    
    if (hasShipment !== "all") params.set('hasShipment', hasShipment);
    if (hasRefund !== "all") params.set('hasRefund', hasRefund);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (minTotal) params.set('minTotal', minTotal);
    if (maxTotal) params.set('maxTotal', maxTotal);
    
    if (page !== 1) params.set('page', page.toString());
    if (pageSize !== 50) params.set('pageSize', pageSize.toString());
    if (sortBy !== 'createdAt') params.set('sortBy', sortBy);
    if (sortOrder !== 'desc') params.set('sortOrder', sortOrder);
    
    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    // Only update if different to avoid infinite loops
    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/orders${newUrl}`);
    }
  }, [search, fulfillmentStatus, financialStatus, shipmentStatus, hasShipment, hasRefund, carrierCode, dateFrom, dateTo, minTotal, maxTotal, page, pageSize, sortBy, sortOrder, isInitialized]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=orders`;
      
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
          if (data.type === 'order_update') {
            queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
            if (isMounted) {
              // Get descriptive title and message based on event type
              // For orders, use orderNumber. For shipments, check order_number field too.
              const orderNumber = data.order?.orderNumber || data.order?.order_number || 'Unknown';
              const eventType = data.eventType || 'order_updated';
              
              const eventMessages: Record<string, { title: string; description: string }> = {
                new_order: {
                  title: "New order placed",
                  description: `Order #${orderNumber} has been received.`,
                },
                order_paid: {
                  title: "Payment received",
                  description: `Order #${orderNumber} has been paid.`,
                },
                order_updated: {
                  title: "Order updated",
                  description: `Order #${orderNumber} has been updated.`,
                },
                refund_issued: {
                  title: "Refund issued",
                  description: `A refund has been processed for order #${orderNumber}.`,
                },
                shipment_created: {
                  title: "Shipment created",
                  description: `A new shipment has been created for order #${orderNumber}.`,
                },
                shipment_synced: {
                  title: "Shipment synced",
                  description: `Shipment data updated for order #${orderNumber}.`,
                },
                tracking_received: {
                  title: "Tracking updated",
                  description: `Tracking info received for order #${orderNumber}.`,
                },
                label_printed: {
                  title: "Label printed",
                  description: `Shipping label printed for order #${orderNumber}.`,
                },
                shipped: {
                  title: "Order shipped",
                  description: `Order #${orderNumber} is now in transit.`,
                },
                delivered: {
                  title: "Order delivered",
                  description: `Order #${orderNumber} has been delivered.`,
                },
                on_hold: {
                  title: "Shipment on hold",
                  description: `Shipment for order #${orderNumber} has been put on hold.`,
                },
                hold_released: {
                  title: "Hold released",
                  description: `Shipment for order #${orderNumber} has been released from hold.`,
                },
              };
              
              const message = eventMessages[eventType] || eventMessages.order_updated;
              toast({
                title: message.title,
                description: message.description,
              });
            }
          } else if (data.type === 'print_queue_update') {
            queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
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
    fulfillmentStatus.forEach(s => params.append('fulfillmentStatus', s));
    financialStatus.forEach(s => params.append('financialStatus', s));
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    
    if (hasShipment !== "all") params.append('hasShipment', hasShipment);
    if (hasRefund !== "all") params.append('hasRefund', hasRefund);
    if (dateFrom) params.append('dateFrom', dateFrom);
    if (dateTo) params.append('dateTo', dateTo);
    if (minTotal) params.append('minTotal', minTotal);
    if (maxTotal) params.append('maxTotal', maxTotal);
    
    params.append('page', page.toString());
    params.append('pageSize', pageSize.toString());
    params.append('sortBy', sortBy);
    params.append('sortOrder', sortOrder);
    
    return params.toString();
  };

  const { data: ordersData, isLoading } = useQuery<OrdersResponse>({
    queryKey: ["/api/orders", search, fulfillmentStatus, financialStatus, shipmentStatus, hasShipment, hasRefund, carrierCode, dateFrom, dateTo, minTotal, maxTotal, page, pageSize, sortBy, sortOrder],
    queryFn: async () => {
      const queryString = buildQueryString();
      const url = `/api/orders?${queryString}`;
      return fetch(url, { credentials: "include" }).then((res) => res.json());
    },
  });

  const orders = ordersData?.orders || [];
  const total = ordersData?.total || 0;
  const totalPages = ordersData?.totalPages || 1;

  const clearFilters = () => {
    setSearch("");
    setFulfillmentStatus([]);
    setFinancialStatus([]);
    setShipmentStatus([]);
    setHasShipment("all");
    setHasRefund("all");
    setCarrierCode([]);
    setDateFrom("");
    setDateTo("");
    setMinTotal("");
    setMaxTotal("");
    setPage(1);
  };

  const activeFiltersCount = [
    search,
    fulfillmentStatus.length > 0,
    financialStatus.length > 0,
    shipmentStatus.length > 0,
    hasShipment !== "all",
    hasRefund !== "all",
    carrierCode.length > 0,
    dateFrom,
    dateTo,
    minTotal,
    maxTotal,
  ].filter(Boolean).length;

  const getFulfillmentBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline">Unfulfilled</Badge>;
    }
    if (status === "fulfilled") {
      return <Badge className="bg-green-600 text-white">Fulfilled</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  const toggleArrayFilter = (value: string, current: string[], setter: (val: string[]) => void) => {
    if (current.includes(value)) {
      setter(current.filter(v => v !== value));
    } else {
      setter([...current, value]);
    }
    setPage(1); // Reset to first page when filter changes
  };

  return (
    <>
      <div className="max-w-7xl mx-auto p-6 space-y-6 pb-32">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Orders</h1>
          <p className="text-muted-foreground text-lg">
            Search and manage warehouse fulfillment • Real-time updates
          </p>
        </div>

        {/* Search and Filters */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                data-testid="input-search-orders"
                type="search"
                placeholder="Search by order number, customer, email, tracking number, SKU, or product..."
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
                
                {activeFiltersCount > 0 && (
                  <Button variant="ghost" onClick={clearFilters} className="gap-2" data-testid="button-clear-filters">
                    <X className="h-4 w-4" />
                    Clear Filters
                  </Button>
                )}
              </div>

              <CollapsibleContent className="pt-4 space-y-4">
                {/* Status Filters */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Fulfillment Status</label>
                    <div className="flex flex-wrap gap-2">
                      {['fulfilled', 'unfulfilled', 'partial', 'restocked'].map(status => (
                        <Badge
                          key={status}
                          variant={fulfillmentStatus.includes(status) ? "default" : "outline"}
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleArrayFilter(status, fulfillmentStatus, setFulfillmentStatus)}
                          data-testid={`filter-fulfillment-${status}`}
                        >
                          {status}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Financial Status</label>
                    <div className="flex flex-wrap gap-2">
                      {['paid', 'pending', 'refunded', 'authorized', 'partially_refunded'].map(status => (
                        <Badge
                          key={status}
                          variant={financialStatus.includes(status) ? "default" : "outline"}
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleArrayFilter(status, financialStatus, setFinancialStatus)}
                          data-testid={`filter-financial-${status}`}
                        >
                          {status.replace('_', ' ')}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Shipment Status</label>
                    <div className="flex flex-wrap gap-2">
                      {['pending', 'shipped', 'DE', 'exception', 'cancelled'].map(status => (
                        <Badge
                          key={status}
                          variant={shipmentStatus.includes(status) ? "default" : "outline"}
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleArrayFilter(status, shipmentStatus, setShipmentStatus)}
                          data-testid={`filter-shipment-${status}`}
                        >
                          {status === 'DE' ? 'Delivered' : status}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Boolean Filters */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Has Shipment</label>
                    <Select value={hasShipment} onValueChange={(val) => { setHasShipment(val); setPage(1); }}>
                      <SelectTrigger data-testid="select-has-shipment">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" data-testid="has-shipment-all">All</SelectItem>
                        <SelectItem value="true" data-testid="has-shipment-yes">Yes</SelectItem>
                        <SelectItem value="false" data-testid="has-shipment-no">No</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Has Refund</label>
                    <Select value={hasRefund} onValueChange={(val) => { setHasRefund(val); setPage(1); }}>
                      <SelectTrigger data-testid="select-has-refund">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" data-testid="has-refund-all">All</SelectItem>
                        <SelectItem value="true" data-testid="has-refund-yes">Yes</SelectItem>
                        <SelectItem value="false" data-testid="has-refund-no">No</SelectItem>
                      </SelectContent>
                    </Select>
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

                {/* Date and Price Filters */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Order Date Range</label>
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

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Order Total Range</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="number"
                        value={minTotal}
                        onChange={(e) => { setMinTotal(e.target.value); setPage(1); }}
                        placeholder="Min $"
                        min="0"
                        step="0.01"
                        data-testid="input-min-total"
                      />
                      <Input
                        type="number"
                        value={maxTotal}
                        onChange={(e) => { setMaxTotal(e.target.value); setPage(1); }}
                        placeholder="Max $"
                        min="0"
                        step="0.01"
                        data-testid="input-max-total"
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
                    <SelectItem value="createdAt" data-testid="sort-option-createdAt">Order Date</SelectItem>
                    <SelectItem value="updatedAt" data-testid="sort-option-updatedAt">Last Updated</SelectItem>
                    <SelectItem value="orderTotal" data-testid="sort-option-orderTotal">Order Total</SelectItem>
                    <SelectItem value="customerName" data-testid="sort-option-customerName">Customer Name</SelectItem>
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

        {/* Results Summary */}
        {!isLoading && (
          <div className="text-sm text-muted-foreground">
            Showing {orders.length === 0 ? 0 : ((page - 1) * pageSize) + 1} - {Math.min(page * pageSize, total)} of {total} orders
          </div>
        )}

        {/* Orders List */}
        {isLoading ? (
          <div className="text-center py-12">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
            <p className="text-muted-foreground text-lg">Loading orders...</p>
          </div>
        ) : orders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No orders found</h3>
              <p className="text-muted-foreground">
                {activeFiltersCount > 0
                  ? "Try adjusting your filters"
                  : "Orders will appear here automatically when they come in from Shopify"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {orders.map((order) => (
              <Link key={order.id} href={`/orders/${order.id}`}>
                <Card className="hover-elevate active-elevate-2 cursor-pointer">
                  <CardHeader className="pb-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-3xl font-mono font-bold mb-2">
                          #{order.orderNumber}
                        </CardTitle>
                        <p className="text-2xl font-semibold text-foreground truncate">
                          {order.customerName}
                        </p>
                        <p className="text-lg text-muted-foreground mt-1">
                          {new Date(order.createdAt).toLocaleString()} •{" "}
                          {Array.isArray(order.lineItems) ? order.lineItems.length : 0} items
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {getFulfillmentBadge(order.fulfillmentStatus)}
                        {order.hasShipment ? (
                          <Badge className="bg-blue-600 text-white gap-1" data-testid={`badge-shipment-${order.id}`}>
                            <Truck className="h-3 w-3" />
                            ShipStation
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1" data-testid={`badge-no-shipment-${order.id}`}>
                            <Truck className="h-3 w-3" />
                            No Shipment
                          </Badge>
                        )}
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(order.createdAt), { addSuffix: true })}
                        </Badge>
                        <p className="text-xl font-bold text-foreground">
                          ${order.totalPrice}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between gap-4">
                <Button
                  variant="outline"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page"
                >
                  Previous
                </Button>
                
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                </div>

                <Button
                  variant="outline"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
