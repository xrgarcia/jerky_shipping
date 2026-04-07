import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Clock, Package, Loader2, Search, ArrowUpDown, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";

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

type SortField = "orderNumber" | "shipToName" | "orderDate" | "ageDays" | "shipToState" | "lifecyclePhase" | "itemCount";
type SortDir = "asc" | "desc";

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
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("ageDays");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [ageFilter, setAgeFilter] = useState<"all" | "1" | "2-3" | "4+">("all");

  const { data: counts, isLoading: countsLoading, isError: countsError } = useQuery<BacklogCounts>({
    queryKey: ["/api/reports/shipping-backlog/counts"],
    refetchInterval: 30000,
  });

  const { data: orders, isLoading: ordersLoading, isError: ordersError } = useQuery<BacklogOrder[]>({
    queryKey: ["/api/reports/shipping-backlog"],
    refetchInterval: 30000,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "ageDays" ? "desc" : "asc");
    }
  };

  const filteredOrders = useMemo(() => {
    if (!orders) return [];
    let filtered = orders;

    if (ageFilter === "1") {
      filtered = filtered.filter(o => o.ageDays === 1);
    } else if (ageFilter === "2-3") {
      filtered = filtered.filter(o => o.ageDays >= 2 && o.ageDays <= 3);
    } else if (ageFilter === "4+") {
      filtered = filtered.filter(o => o.ageDays >= 4);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(o =>
        o.orderNumber.toLowerCase().includes(q) ||
        (o.shipToName && o.shipToName.toLowerCase().includes(q)) ||
        (o.shipToCity && o.shipToCity.toLowerCase().includes(q)) ||
        (o.shipToState && o.shipToState.toLowerCase().includes(q)) ||
        o.tags.some(t => t.name.toLowerCase().includes(q))
      );
    }

    filtered = [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "orderNumber": cmp = a.orderNumber.localeCompare(b.orderNumber); break;
        case "shipToName": cmp = (a.shipToName || "").localeCompare(b.shipToName || ""); break;
        case "orderDate": cmp = new Date(a.orderDate).getTime() - new Date(b.orderDate).getTime(); break;
        case "ageDays": cmp = a.ageDays - b.ageDays; break;
        case "shipToState": cmp = (a.shipToState || "").localeCompare(b.shipToState || ""); break;
        case "lifecyclePhase": cmp = (a.lifecyclePhase || "").localeCompare(b.lifecyclePhase || ""); break;
        case "itemCount": cmp = a.itemCount - b.itemCount; break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return filtered;
  }, [orders, search, sortField, sortDir, ageFilter]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/reports/shipping-backlog/counts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/reports/shipping-backlog"] });
  };

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
            onClick={() => setAgeFilter("all")}
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
            className={`cursor-pointer ${ageFilter === "1" ? "ring-2 ring-primary" : ""}`}
            onClick={() => setAgeFilter(ageFilter === "1" ? "all" : "1")}
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
            className={`cursor-pointer ${ageFilter === "2-3" ? "ring-2 ring-primary" : ""}`}
            onClick={() => setAgeFilter(ageFilter === "2-3" ? "all" : "2-3")}
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
            className={`cursor-pointer ${ageFilter === "4+" ? "ring-2 ring-primary" : ""}`}
            onClick={() => setAgeFilter(ageFilter === "4+" ? "all" : "4+")}
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
              onChange={e => setSearch(e.target.value)}
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
                  {filteredOrders.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {search || ageFilter !== "all" ? "No orders match the current filters" : "No backlog orders found"}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredOrders.map(order => (
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
                          <div className="flex flex-wrap gap-1">
                            {order.tags.slice(0, 3).map(tag => (
                              <Badge key={tag.name} variant="outline" className="text-xs">
                                {tag.name}
                              </Badge>
                            ))}
                            {order.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{order.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              {filteredOrders.length > 0 && (
                <div className="px-4 py-3 text-sm text-muted-foreground border-t">
                  Showing {filteredOrders.length} order{filteredOrders.length !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}