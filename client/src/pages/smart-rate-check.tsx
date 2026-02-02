import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
  DollarSign,
  TrendingDown,
  TrendingUp,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Package,
  Percent,
  Calculator,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";

interface RateOption {
  carrier: string;
  service: string;
  cost: number;
  deliveryDays: number | null;
}

interface RateAnalysisRow {
  shipmentId: string;
  customerShippingMethod: string | null;
  customerShippingCost: string | null;
  customerDeliveryDays: number | null;
  smartShippingMethod: string | null;
  smartShippingCost: string | null;
  smartDeliveryDays: number | null;
  costSavings: string | null;
  reasoning: string | null;
  ratesComparedCount: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  originPostalCode: string;
  destinationPostalCode: string | null;
  destinationState: string | null;
  analyzedAt: string;
  orderNumber: string;
  orderDate: string | null;
  lifecyclePhase: string | null;
  decisionSubphase: string | null;
  allRatesChecked: RateOption[] | null;
  actualShippingCost: string | null;
  packageWeightOz: string | null;
  packageLengthIn: string | null;
  packageWidthIn: string | null;
  packageHeightIn: string | null;
}

interface RateAnalysisResponse {
  data: RateAnalysisRow[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
  metrics: {
    totalAnalyzed: number;
    totalPotentialSavings: number;
    totalCustomerShippingCost: number;
    totalRecommendedSpend: number;
    shipmentsWithSavings: number;
    percentWithSavings: number;
    averageSavingsPerShipment: number;
    totalActualSpend: number;
    shipmentsWithActualCost: number;
    realizedSavings: number;
    missedSavings: number;
    adoptedRecommendationCount: number;
    adoptionRate: number;
  };
}

const LIFECYCLE_PHASES = [
  { value: "all", label: "All Phases" },
  { value: "ready_to_fulfill", label: "Ready to Fulfill" },
  { value: "ready_to_session", label: "Ready to Session" },
  { value: "awaiting_decisions", label: "Awaiting Decisions" },
  { value: "ready_to_pick", label: "Ready to Pick" },
  { value: "picking", label: "Picking" },
  { value: "packing_ready", label: "Packing Ready" },
  { value: "on_dock", label: "On Dock" },
  { value: "in_transit", label: "In Transit" },
  { value: "delivered", label: "Delivered" },
];

const PAGE_SIZES = [10, 25, 50, 100];

type SortColumn = "analyzedAt" | "costSavings" | "customerShippingCost" | "smartShippingCost" | "orderDate";

export default function SmartRateCheck() {
  const [orderDateFrom, setOrderDateFrom] = useState("");
  const [orderDateTo, setOrderDateTo] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [lifecyclePhase, setLifecyclePhase] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [sortBy, setSortBy] = useState<SortColumn>("analyzedAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [expandedComment, setExpandedComment] = useState<string | null>(null);

  const queryParams = new URLSearchParams();
  if (orderDateFrom) queryParams.set("orderDateFrom", orderDateFrom);
  if (orderDateTo) queryParams.set("orderDateTo", orderDateTo);
  if (orderNumber) queryParams.set("orderNumber", orderNumber);
  if (lifecyclePhase && lifecyclePhase !== "all") queryParams.set("lifecyclePhase", lifecyclePhase);
  queryParams.set("sortBy", sortBy);
  queryParams.set("sortOrder", sortOrder);
  queryParams.set("page", page.toString());
  queryParams.set("limit", limit.toString());

  const queryString = queryParams.toString();
  const { data, isLoading, refetch, isFetching } = useQuery<RateAnalysisResponse>({
    queryKey: [`/api/rate-analysis?${queryString}`],
  });

  const handleSort = (column: SortColumn) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
    setPage(1);
  };

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortBy !== column) return <ArrowUpDown className="ml-1 h-4 w-4 opacity-50" />;
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-1 h-4 w-4" />
    );
  };

  const formatCurrency = (value: string | number | null) => {
    if (value === null || value === undefined) return "-";
    const num = typeof value === "string" ? parseFloat(value) : value;
    if (isNaN(num)) return "-";
    return `$${num.toFixed(2)}`;
  };

  const formatMethod = (method: string | null) => {
    if (!method) return "-";
    return method.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  };

  const handleReset = () => {
    setOrderDateFrom("");
    setOrderDateTo("");
    setOrderNumber("");
    setLifecyclePhase("all");
    setSortBy("analyzedAt");
    setSortOrder("desc");
    setPage(1);
  };

  const metrics = data?.metrics;
  const pagination = data?.pagination;

  return (
    <div className="p-6 space-y-6" data-testid="page-smart-rate-check">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Smart Rate Check</h1>
          <p className="text-muted-foreground mt-1">
            Analyze shipping costs and identify savings opportunities
          </p>
        </div>
        <Button
          onClick={() => refetch()}
          variant="outline"
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i + 4} className="h-28" />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card data-testid="card-shipments-analyzed">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Shipments Analyzed
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold" data-testid="text-shipments-analyzed">
                  {metrics?.totalAnalyzed?.toLocaleString() ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">
                  {metrics?.shipmentsWithActualCost?.toLocaleString() ?? 0} with label cost
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-potential-savings">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-amber-600" />
                  Potential Savings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-amber-600" data-testid="text-potential-savings">
                  {formatCurrency(metrics?.totalPotentialSavings ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {metrics?.percentWithSavings ?? 0}% have savings opportunity
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-realized-savings">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-green-600" />
                  Realized Savings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-green-600" data-testid="text-realized-savings">
                  {formatCurrency(metrics?.realizedSavings ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {metrics?.adoptedRecommendationCount?.toLocaleString() ?? 0} adopted recommendations
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-missed-savings">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-red-600" />
                  Missed Savings
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-red-600" data-testid="text-missed-savings">
                  {formatCurrency(metrics?.missedSavings ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Could have saved more
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card data-testid="card-actual-spend">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  Actual Label Spend
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold" data-testid="text-actual-spend">
                  {formatCurrency(metrics?.totalActualSpend ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  What was paid for labels
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-recommended-spend">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-blue-600" />
                  Recommended Spend
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-blue-600" data-testid="text-recommended-spend">
                  {formatCurrency(metrics?.totalRecommendedSpend ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Optimal shipping cost
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-adoption-rate">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Percent className="h-4 w-4 text-purple-600" />
                  Adoption Rate
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-purple-600" data-testid="text-adoption-rate">
                  {metrics?.adoptionRate ?? 0}%
                </p>
                <p className="text-xs text-muted-foreground">
                  Using recommended carrier
                </p>
              </CardContent>
            </Card>

            <Card data-testid="card-avg-savings">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Calculator className="h-4 w-4" />
                  Avg Savings/Shipment
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold" data-testid="text-avg-savings">
                  {formatCurrency(metrics?.averageSavingsPerShipment ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Per analyzed shipment
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Order Date From</label>
              <Input
                type="date"
                value={orderDateFrom}
                onChange={(e) => {
                  setOrderDateFrom(e.target.value);
                  setPage(1);
                }}
                className="w-40"
                data-testid="input-order-date-from"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Order Date To</label>
              <Input
                type="date"
                value={orderDateTo}
                onChange={(e) => {
                  setOrderDateTo(e.target.value);
                  setPage(1);
                }}
                className="w-40"
                data-testid="input-order-date-to"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Order Number</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search order..."
                  value={orderNumber}
                  onChange={(e) => {
                    setOrderNumber(e.target.value);
                    setPage(1);
                  }}
                  className="pl-8 w-48"
                  data-testid="input-order-number"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Lifecycle Phase</label>
              <Select
                value={lifecyclePhase}
                onValueChange={(value) => {
                  setLifecyclePhase(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-48" data-testid="select-lifecycle-phase">
                  <SelectValue placeholder="Select phase" />
                </SelectTrigger>
                <SelectContent>
                  {LIFECYCLE_PHASES.map((phase) => (
                    <SelectItem key={phase.value} value={phase.value}>
                      {phase.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={handleReset} data-testid="button-reset-filters">
              Reset Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-lg">Rate Analysis Results</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Rows per page:</span>
            <Select value={limit.toString()} onValueChange={(v) => { setLimit(parseInt(v)); setPage(1); }}>
              <SelectTrigger className="w-20" data-testid="select-page-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !data?.data.length ? (
            <div className="text-center py-12 text-muted-foreground">
              <Package className="mx-auto h-12 w-12 mb-4 opacity-50" />
              <p>No rate analysis data found</p>
              <p className="text-sm mt-1">Run a rate analysis job from Operations to populate this data</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[120px]">Order</TableHead>
                      <TableHead
                        className="min-w-[100px] cursor-pointer hover-elevate"
                        onClick={() => handleSort("orderDate")}
                      >
                        <div className="flex items-center">
                          Order Date
                          <SortIcon column="orderDate" />
                        </div>
                      </TableHead>
                      <TableHead className="min-w-[100px]">Lifecycle</TableHead>
                      <TableHead className="min-w-[140px]">Current Method</TableHead>
                      <TableHead
                        className="min-w-[100px] cursor-pointer hover-elevate"
                        onClick={() => handleSort("customerShippingCost")}
                      >
                        <div className="flex items-center">
                          Current Cost
                          <SortIcon column="customerShippingCost" />
                        </div>
                      </TableHead>
                      <TableHead className="min-w-[60px]">Days</TableHead>
                      <TableHead className="min-w-[140px]">Recommended</TableHead>
                      <TableHead
                        className="min-w-[100px] cursor-pointer hover-elevate"
                        onClick={() => handleSort("smartShippingCost")}
                      >
                        <div className="flex items-center">
                          Rec. Cost
                          <SortIcon column="smartShippingCost" />
                        </div>
                      </TableHead>
                      <TableHead className="min-w-[60px]">Days</TableHead>
                      <TableHead
                        className="min-w-[100px] cursor-pointer hover-elevate"
                        onClick={() => handleSort("costSavings")}
                      >
                        <div className="flex items-center">
                          Savings
                          <SortIcon column="costSavings" />
                        </div>
                      </TableHead>
                      <TableHead className="min-w-[100px]">Actual Cost</TableHead>
                      <TableHead className="min-w-[80px]">Destination</TableHead>
                      <TableHead className="min-w-[60px]">Rates</TableHead>
                      <TableHead className="min-w-[40px] w-[40px]"></TableHead>
                      <TableHead
                        className="min-w-[120px] cursor-pointer hover-elevate"
                        onClick={() => handleSort("analyzedAt")}
                      >
                        <div className="flex items-center">
                          Analyzed
                          <SortIcon column="analyzedAt" />
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.map((row) => {
                      const savings = parseFloat(row.costSavings || "0");
                      const hasSavings = savings > 0;
                      
                      return (
                        <TableRow key={row.shipmentId} data-testid={`row-rate-analysis-${row.shipmentId}`}>
                          <TableCell>
                            <Link href={`/shipments/${row.shipmentId}`}>
                              <span className="text-primary hover:underline cursor-pointer flex items-center gap-1" data-testid={`link-order-${row.orderNumber}`}>
                                {row.orderNumber}
                                <ExternalLink className="h-3 w-3" />
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell data-testid={`text-order-date-${row.shipmentId}`}>
                            {row.orderDate ? format(new Date(row.orderDate), "MMM d, yyyy") : "-"}
                          </TableCell>
                          <TableCell>
                            {row.lifecyclePhase ? (
                              <Badge variant="outline" className="text-xs" data-testid={`badge-lifecycle-${row.shipmentId}`}>
                                {row.lifecyclePhase.replace(/_/g, " ")}
                              </Badge>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs" data-testid={`text-current-method-${row.shipmentId}`}>
                            {formatMethod(row.customerShippingMethod)}
                          </TableCell>
                          <TableCell data-testid={`text-current-cost-${row.shipmentId}`}>
                            {formatCurrency(row.customerShippingCost)}
                          </TableCell>
                          <TableCell data-testid={`text-current-days-${row.shipmentId}`}>
                            {row.customerDeliveryDays ?? "-"}
                          </TableCell>
                          <TableCell className="font-mono text-xs" data-testid={`text-recommended-method-${row.shipmentId}`}>
                            {formatMethod(row.smartShippingMethod)}
                          </TableCell>
                          <TableCell data-testid={`text-recommended-cost-${row.shipmentId}`}>
                            {formatCurrency(row.smartShippingCost)}
                          </TableCell>
                          <TableCell data-testid={`text-recommended-days-${row.shipmentId}`}>
                            {row.smartDeliveryDays ?? "-"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={hasSavings ? "default" : "secondary"}
                              className={hasSavings ? "bg-green-600" : ""}
                              data-testid={`badge-savings-${row.shipmentId}`}
                            >
                              {hasSavings ? `+${formatCurrency(savings)}` : formatCurrency(savings)}
                            </Badge>
                          </TableCell>
                          <TableCell data-testid={`text-actual-cost-${row.shipmentId}`}>
                            {row.actualShippingCost ? (
                              <span className={
                                row.smartShippingCost && 
                                Math.abs(parseFloat(row.actualShippingCost) - parseFloat(row.smartShippingCost)) < 0.50
                                  ? "text-green-600 font-medium"
                                  : ""
                              }>
                                {formatCurrency(row.actualShippingCost)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs" data-testid={`text-destination-${row.shipmentId}`}>
                            {row.destinationState || row.destinationPostalCode || "-"}
                          </TableCell>
                          <TableCell data-testid={`text-rates-count-${row.shipmentId}`}>
                            {row.ratesComparedCount ?? "-"}
                          </TableCell>
                          <TableCell className="text-center">
                            {row.reasoning ? (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setExpandedComment(row.shipmentId)}
                                data-testid={`button-expand-comment-${row.shipmentId}`}
                              >
                                <MessageSquare className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground" data-testid={`text-analyzed-at-${row.shipmentId}`}>
                            {format(new Date(row.analyzedAt), "MMM d, h:mm a")}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {pagination && pagination.totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <p className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                    Showing {((pagination.page - 1) * pagination.limit) + 1} to{" "}
                    {Math.min(pagination.page * pagination.limit, pagination.totalCount)} of{" "}
                    {pagination.totalCount.toLocaleString()} results
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(page - 1)}
                      disabled={page <= 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(page + 1)}
                      disabled={page >= pagination.totalPages}
                      data-testid="button-next-page"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!expandedComment} onOpenChange={() => setExpandedComment(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Rate Analysis Details</DialogTitle>
            <DialogDescription>
              Full reasoning and all carrier rates checked
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const row = expandedComment ? data?.data.find((r) => r.shipmentId === expandedComment) : null;
            if (!row) return null;
            
            return (
              <div className="space-y-4">
                {/* Package dimensions used for rate check */}
                <div className="p-4 bg-muted rounded-md">
                  <p className="text-sm font-medium mb-2">Package Used for Rate Check</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Weight:</span>
                      <span className="font-mono" data-testid="text-package-weight">
                        {row.packageWeightOz ? `${parseFloat(row.packageWeightOz).toFixed(2)} oz` : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Dimensions:</span>
                      <span className="font-mono" data-testid="text-package-dimensions">
                        {row.packageLengthIn && row.packageWidthIn && row.packageHeightIn
                          ? `${parseFloat(row.packageLengthIn)}×${parseFloat(row.packageWidthIn)}×${parseFloat(row.packageHeightIn)} in`
                          : "—"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="p-4 bg-muted rounded-md">
                  <p className="text-sm font-medium mb-1">Recommendation</p>
                  <p className="text-sm whitespace-pre-wrap" data-testid="text-expanded-comment">
                    {row.reasoning}
                  </p>
                </div>
                
                {row.allRatesChecked && row.allRatesChecked.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium mb-2">All Rates Checked ({row.allRatesChecked.length})</p>
                    <div className="border rounded-md overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">Carrier</TableHead>
                            <TableHead>Service</TableHead>
                            <TableHead className="text-right w-20">Cost</TableHead>
                            <TableHead className="text-right w-20">Days</TableHead>
                            <TableHead className="w-24">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {row.allRatesChecked.map((rate, idx) => {
                            const isCustomerChoice = rate.service === row.customerShippingMethod;
                            const isSmartPick = rate.service === row.smartShippingMethod;
                            
                            return (
                              <TableRow 
                                key={`${rate.carrier}-${rate.service}-${idx}`}
                                className={isSmartPick ? "bg-green-50 dark:bg-green-950/20" : isCustomerChoice ? "bg-blue-50 dark:bg-blue-950/20" : ""}
                                data-testid={`row-rate-${idx}`}
                              >
                                <TableCell className="font-mono text-xs uppercase">{rate.carrier}</TableCell>
                                <TableCell className="font-mono text-xs">{rate.service}</TableCell>
                                <TableCell className="text-right font-mono">${rate.cost.toFixed(2)}</TableCell>
                                <TableCell className="text-right">{rate.deliveryDays ?? "—"}</TableCell>
                                <TableCell>
                                  {isSmartPick && (
                                    <Badge variant="default" className="text-xs bg-green-600">
                                      Lowest
                                    </Badge>
                                  )}
                                  {isCustomerChoice && !isSmartPick && (
                                    <Badge variant="secondary" className="text-xs">
                                      Selected
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No rate details available for this analysis.
                  </p>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
