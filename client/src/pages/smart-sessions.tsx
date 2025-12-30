import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Layers,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Box,
  Package,
  Hand,
  ArrowUpDown,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";

interface SmartSession {
  id: number;
  name: string | null;
  sequenceNumber: number | null;
  stationId: string | null;
  stationType: string;
  orderCount: number;
  maxOrders: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  pickingStartedAt: string | null;
  packingStartedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  stationName: string | null;
}

interface SmartSessionsResponse {
  sessions: SmartSession[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
}

interface SessionShipmentItem {
  sku: string;
  name: string | null;
  quantity: number;
  imageUrl: string | null;
  weightValue: number | null;
  weightUnit: string | null;
}

interface SessionShipment {
  id: string;
  orderNumber: string;
  fingerprintId: string | null;
  trackingNumber: string | null;
  lifecyclePhase: string | null;
  totalWeightOz: number | null;
  items: SessionShipmentItem[];
}

interface SessionDetailsResponse extends SmartSession {
  shipments: SessionShipment[];
}

const STATION_TYPES = [
  { value: "all", label: "All Station Types" },
  { value: "boxing_machine", label: "Boxing Machine" },
  { value: "poly_bag", label: "Poly Bag" },
  { value: "hand_pack", label: "Hand Pack" },
];

const STATUSES = [
  { value: "all", label: "All Statuses" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "picking", label: "Picking" },
  { value: "packing", label: "Packing" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { value: "createdAt", label: "Created Date" },
  { value: "orderCount", label: "Order Count" },
  { value: "status", label: "Status" },
  { value: "stationType", label: "Station Type" },
  { value: "sequenceNumber", label: "Sequence #" },
];

const LIMIT_OPTIONS = [10, 25, 50, 100];

function getStationTypeIcon(stationType: string) {
  switch (stationType) {
    case "boxing_machine":
      return <Box className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
    case "poly_bag":
      return <Package className="h-4 w-4 text-green-600 dark:text-green-400" />;
    case "hand_pack":
      return <Hand className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
    default:
      return <Layers className="h-4 w-4" />;
  }
}

function getStationTypeLabel(stationType: string) {
  switch (stationType) {
    case "boxing_machine":
      return "Boxing Machine";
    case "poly_bag":
      return "Poly Bag";
    case "hand_pack":
      return "Hand Pack";
    default:
      return stationType;
  }
}

function getStatusBadge(status: string) {
  const variants: Record<string, { className: string; label: string }> = {
    draft: { className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200", label: "Draft" },
    ready: { className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200", label: "Ready" },
    picking: { className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200", label: "Picking" },
    packing: { className: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200", label: "Packing" },
    completed: { className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200", label: "Completed" },
    cancelled: { className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200", label: "Cancelled" },
  };
  const variant = variants[status] || { className: "", label: status };
  return (
    <Badge variant="outline" className={variant.className}>
      {variant.label}
    </Badge>
  );
}

export default function SmartSessions() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [stationType, setStationType] = useState("all");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);

  const { data, isLoading, refetch } = useQuery<SmartSessionsResponse>({
    queryKey: [
      "/api/smart-sessions",
      { page, limit, search: debouncedSearch, status, stationType, sortBy, sortOrder },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        search: debouncedSearch,
        status,
        stationType,
        sortBy,
        sortOrder,
      });
      const res = await fetch(`/api/smart-sessions?${params}`);
      if (!res.ok) throw new Error("Failed to fetch sessions");
      return res.json();
    },
  });

  const { data: sessionDetails, isLoading: sessionDetailsLoading } = useQuery<SessionDetailsResponse>({
    queryKey: ["/api/fulfillment-sessions", selectedSessionId],
    enabled: !!selectedSessionId,
  });

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const timeout = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const sessions = data?.sessions || [];
  const pagination = data?.pagination || { page: 1, limit: 25, totalCount: 0, totalPages: 0 };

  return (
    <div className="container mx-auto py-6 px-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5" />
                Smart Sessions
              </CardTitle>
              <CardDescription>
                Search and manage fulfillment sessions
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              data-testid="button-refresh-smart-sessions"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, ID, or sequence #..."
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-sessions"
                />
              </div>
              
              <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]" data-testid="select-status-filter">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={stationType} onValueChange={(v) => { setStationType(v); setPage(1); }}>
                <SelectTrigger className="w-[170px]" data-testid="select-station-type-filter">
                  <SelectValue placeholder="Station Type" />
                </SelectTrigger>
                <SelectContent>
                  {STATION_TYPES.map((st) => (
                    <SelectItem key={st.value} value={st.value}>
                      {st.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setPage(1); }}>
                <SelectTrigger className="w-[150px]" data-testid="select-sort-by">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((so) => (
                    <SelectItem key={so.value} value={so.value}>
                      {so.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              <Button
                variant="outline"
                size="icon"
                onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
                data-testid="button-toggle-sort-order"
              >
                <ArrowUpDown className={`h-4 w-4 ${sortOrder === "asc" ? "rotate-180" : ""}`} />
              </Button>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-12">
                <Layers className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Sessions Found</h3>
                <p className="text-muted-foreground">
                  {debouncedSearch || status !== "all" || stationType !== "all"
                    ? "Try adjusting your filters"
                    : "No fulfillment sessions have been created yet"}
                </p>
              </div>
            ) : (
              <>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[100px]">
                          <button
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleSort("sequenceNumber")}
                            data-testid="th-sort-sequence"
                          >
                            Seq #
                            {sortBy === "sequenceNumber" && (
                              <ArrowUpDown className="h-3 w-3" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>Name / ID</TableHead>
                        <TableHead>
                          <button
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleSort("stationType")}
                            data-testid="th-sort-station-type"
                          >
                            Station Type
                            {sortBy === "stationType" && (
                              <ArrowUpDown className="h-3 w-3" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleSort("status")}
                            data-testid="th-sort-status"
                          >
                            Status
                            {sortBy === "status" && (
                              <ArrowUpDown className="h-3 w-3" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead className="text-right">
                          <button
                            className="flex items-center gap-1 hover:text-foreground ml-auto"
                            onClick={() => handleSort("orderCount")}
                            data-testid="th-sort-order-count"
                          >
                            Orders
                            {sortBy === "orderCount" && (
                              <ArrowUpDown className="h-3 w-3" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={() => handleSort("createdAt")}
                            data-testid="th-sort-created"
                          >
                            Created
                            {sortBy === "createdAt" && (
                              <ArrowUpDown className="h-3 w-3" />
                            )}
                          </button>
                        </TableHead>
                        <TableHead>Completed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessions.map((session) => (
                        <TableRow key={session.id} data-testid={`row-session-${session.id}`}>
                          <TableCell className="font-mono text-sm">
                            {session.sequenceNumber ?? "-"}
                          </TableCell>
                          <TableCell>
                            <div>
                              <div className="font-medium">
                                {session.name || `Session ${session.sequenceNumber || session.id}`}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono">
                                #{session.id}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getStationTypeIcon(session.stationType)}
                              <span>{getStationTypeLabel(session.stationType)}</span>
                            </div>
                          </TableCell>
                          <TableCell>{getStatusBadge(session.status)}</TableCell>
                          <TableCell className="text-right">
                            <button
                              className="hover:underline cursor-pointer"
                              onClick={() => setSelectedSessionId(session.id)}
                              data-testid={`button-view-orders-${session.id}`}
                            >
                              <span className="font-medium text-primary">{session.orderCount}</span>
                              <span className="text-muted-foreground">/{session.maxOrders}</span>
                            </button>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {format(new Date(session.createdAt), "MMM d, h:mm a")}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {session.completedAt
                              ? format(new Date(session.completedAt), "MMM d, h:mm a")
                              : "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>Showing</span>
                    <Select
                      value={limit.toString()}
                      onValueChange={(v) => { setLimit(parseInt(v)); setPage(1); }}
                    >
                      <SelectTrigger className="w-[70px] h-8" data-testid="select-limit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LIMIT_OPTIONS.map((l) => (
                          <SelectItem key={l} value={l.toString()}>
                            {l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span>of {pagination.totalCount} sessions</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {page} of {pagination.totalPages || 1}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                      disabled={page >= pagination.totalPages}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selectedSessionId} onOpenChange={(open) => !open && setSelectedSessionId(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Session Orders
              {sessionDetails && (
                <Badge variant="secondary" className="ml-2">
                  {sessionDetails.shipments?.length || 0} orders
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {sessionDetails && (
                <>
                  {sessionDetails.name || `Session ${sessionDetails.sequenceNumber || sessionDetails.id}`}
                  {" - "}
                  {getStationTypeLabel(sessionDetails.stationType)}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          
          {sessionDetailsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sessionDetails?.shipments?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No orders in this session
            </div>
          ) : (
            <ScrollArea className="h-[60vh]">
              <div className="space-y-2 pr-4">
                {sessionDetails?.shipments?.map((shipment) => (
                  <div
                    key={shipment.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card"
                    data-testid={`shipment-row-${shipment.id}`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{shipment.orderNumber}</span>
                        {shipment.trackingNumber && (
                          <Badge variant="outline" className="text-xs">
                            {shipment.trackingNumber}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                        <span>{shipment.items?.length || 0} item{(shipment.items?.length || 0) !== 1 ? 's' : ''}</span>
                        {shipment.totalWeightOz && (
                          <>
                            <span className="mx-1">·</span>
                            <span>{(shipment.totalWeightOz / 16).toFixed(2)} lbs</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Link href={`/shipments/${shipment.id}`}>
                      <Button variant="ghost" size="icon" data-testid={`link-shipment-${shipment.id}`}>
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
