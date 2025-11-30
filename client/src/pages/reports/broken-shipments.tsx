import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, RefreshCw, ExternalLink, Package, Link2Off, Loader2, Copy, Calendar, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { subDays } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const CST_TIMEZONE = 'America/Chicago';

interface BrokenShipment {
  id: number;
  orderId: number;
  orderNumber: string;
  shipmentId: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  carrierCode: string | null;
  status: string | null;
  createdAt: string;
  updatedAt: string | null;
}

interface BrokenShipmentsResponse {
  shipments: BrokenShipment[];
  total: number;
  summary: {
    hasLabelNoTracking: number;
    orphanedShipmentId: number;
    missingShipmentData: number;
  };
}

interface DuplicateShipment {
  id: string;
  shipmentId: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  status: string | null;
  shipDate: string | null;
  createdAt: string | null;
  // Duplicate detection indicators
  sessionId: string | null;
  waveId: string | null;
  externalShipmentId: string | null;
  shipmentDataKeyCount: number;
  isLikelyOriginal: boolean;
}

interface DuplicateOrder {
  orderNumber: string;
  shipmentCount: number;
  shipments: DuplicateShipment[];
}

interface DuplicatesResponse {
  startDate: string;
  endDate: string;
  totalOrders: number;
  totalDuplicateShipments: number;
  duplicates: DuplicateOrder[];
}

export default function BrokenShipmentsReport() {
  const { toast } = useToast();
  
  // Date range for duplicate detection (Central Time)
  const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
  const today = formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  const thirtyDaysAgo = formatInTimeZone(subDays(cstNow, 30), CST_TIMEZONE, 'yyyy-MM-dd');
  
  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());
  
  // Broken shipments query - now with date filtering
  const { data, isLoading, refetch, isRefetching } = useQuery<BrokenShipmentsResponse>({
    queryKey: ['/api/reports/broken-shipments', startDate, endDate],
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

  // Duplicate shipments query
  const { data: duplicatesData, isLoading: duplicatesLoading, refetch: refetchDuplicates, isRefetching: duplicatesRefetching } = useQuery<DuplicatesResponse>({
    queryKey: ['/api/reports/duplicate-shipments', startDate, endDate],
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

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return formatInTimeZone(new Date(dateStr), CST_TIMEZONE, "MMM dd, yyyy h:mm a");
    } catch {
      return dateStr;
    }
  };

  const formatShortDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return formatInTimeZone(new Date(dateStr), CST_TIMEZONE, "MMM dd h:mm a");
    } catch {
      return dateStr;
    }
  };

  const toggleOrderExpanded = (orderNumber: string) => {
    setExpandedOrders(prev => {
      const next = new Set(prev);
      if (next.has(orderNumber)) {
        next.delete(orderNumber);
      } else {
        next.add(orderNumber);
      }
      return next;
    });
  };

  const handleRefreshAll = () => {
    refetch();
    refetchDuplicates();
  };

  // State to track which shipment is being fixed
  const [fixingShipmentId, setFixingShipmentId] = useState<string | null>(null);

  // Mutation to fix shipment number in ShipStation
  const fixShipmentNumberMutation = useMutation({
    mutationFn: async (shipmentId: string) => {
      const response = await apiRequest('POST', `/api/shipments/${shipmentId}/fix-shipment-number`);
      return response.json();
    },
    onMutate: (shipmentId) => {
      setFixingShipmentId(shipmentId);
    },
    onSuccess: (data: any) => {
      toast({
        title: "Shipment Number Fixed",
        description: `Updated to: ${data.newShipmentNumber}`,
      });
      // Refresh the duplicates list
      queryClient.invalidateQueries({ queryKey: ['/api/reports/duplicate-shipments'] });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to Fix Shipment Number",
        description: error.message || "An error occurred",
        variant: "destructive",
      });
    },
    onSettled: () => {
      setFixingShipmentId(null);
    },
  });

  // Helper to generate what the new shipment_number will be
  const getExpectedNewShipmentNumber = (orderNumber: string, shipmentId: string | null) => {
    if (!shipmentId) return null;
    const numericPart = shipmentId.replace(/^se-/, '');
    return `${orderNumber}-${numericPart}`;
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground flex items-center gap-3" data-testid="text-page-title">
              <AlertTriangle className="h-10 w-10 text-amber-500" />
              Broken Shipments
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Shipments with data integrity issues that need backfill or manual correction
            </p>
          </div>
          <Button
            variant="outline"
            onClick={handleRefreshAll}
            disabled={isRefetching || duplicatesRefetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${(isRefetching || duplicatesRefetching) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Date Range Filter - applies to all data */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-muted-foreground" />
                <span className="font-medium">Date Range:</span>
              </div>
              <div className="space-y-1">
                <Label htmlFor="start-date" className="text-xs text-muted-foreground">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-[160px]"
                  data-testid="input-start-date"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="end-date" className="text-xs text-muted-foreground">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-[160px]"
                  data-testid="input-end-date"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const now = toZonedTime(new Date(), CST_TIMEZONE);
                    setStartDate(formatInTimeZone(now, CST_TIMEZONE, 'yyyy-MM-dd'));
                    setEndDate(formatInTimeZone(now, CST_TIMEZONE, 'yyyy-MM-dd'));
                  }}
                  data-testid="button-today"
                >
                  Today
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const now = toZonedTime(new Date(), CST_TIMEZONE);
                    setStartDate(formatInTimeZone(subDays(now, 7), CST_TIMEZONE, 'yyyy-MM-dd'));
                    setEndDate(formatInTimeZone(now, CST_TIMEZONE, 'yyyy-MM-dd'));
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
              <span className="text-sm text-muted-foreground ml-auto">
                All times in Central Time (CST/CDT)
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        {(data?.summary || duplicatesData) && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Link2Off className="h-5 w-5 text-amber-500" />
                  Has Label, No Tracking
                </CardTitle>
                <CardDescription>
                  Label created but tracking number missing
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-amber-600" data-testid="text-label-no-tracking">
                  {data?.summary?.hasLabelNoTracking ?? 0}
                </div>
              </CardContent>
            </Card>

            <Card className="border-red-500/30 bg-red-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                  Orphaned Shipment ID
                </CardTitle>
                <CardDescription>
                  ShipStation ID no longer retrievable via API
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-red-600" data-testid="text-orphaned-shipment">
                  {data?.summary?.orphanedShipmentId ?? 0}
                </div>
              </CardContent>
            </Card>

            <Card className="border-orange-500/30 bg-orange-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="h-5 w-5 text-orange-500" />
                  Missing Shipment Data
                </CardTitle>
                <CardDescription>
                  No raw ShipStation data stored
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-orange-600" data-testid="text-missing-data">
                  {data?.summary?.missingShipmentData ?? 0}
                </div>
              </CardContent>
            </Card>

            <Card className="border-purple-500/30 bg-purple-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Copy className="h-5 w-5 text-purple-500" />
                  Duplicate Shipments
                </CardTitle>
                <CardDescription>
                  Orders with multiple shipment records
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-purple-600" data-testid="text-duplicate-count">
                  {duplicatesData?.totalOrders ?? 0}
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {duplicatesData?.totalDuplicateShipments ?? 0} total shipments
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Shipments List */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              Affected Shipments ({data?.total ?? 0})
            </CardTitle>
            <CardDescription>
              These shipments have label URLs but are missing tracking numbers - likely caused by the label creation bug that has now been fixed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-3 text-lg text-muted-foreground">Loading broken shipments...</span>
              </div>
            ) : data?.shipments && data.shipments.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-semibold">Order #</th>
                      <th className="text-left py-3 px-4 font-semibold">Shipment ID</th>
                      <th className="text-left py-3 px-4 font-semibold">Status</th>
                      <th className="text-left py-3 px-4 font-semibold">Carrier</th>
                      <th className="text-left py-3 px-4 font-semibold">Created</th>
                      <th className="text-left py-3 px-4 font-semibold">Issues</th>
                      <th className="text-left py-3 px-4 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.shipments.map((shipment) => (
                      <tr 
                        key={shipment.id} 
                        className="border-b hover:bg-muted/50"
                        data-testid={`row-shipment-${shipment.id}`}
                      >
                        <td className="py-3 px-4">
                          <a 
                            href={`/orders/${shipment.orderId}`}
                            className="text-primary hover:underline font-mono font-semibold"
                            data-testid={`link-order-${shipment.orderNumber}`}
                          >
                            {shipment.orderNumber}
                          </a>
                        </td>
                        <td className="py-3 px-4 font-mono text-sm">
                          {shipment.shipmentId || (
                            <span className="text-muted-foreground italic">None</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant="outline">
                            {shipment.status || 'unknown'}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">
                          {shipment.carrierCode || (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm text-muted-foreground">
                          {formatDate(shipment.createdAt)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-1">
                            {shipment.labelUrl && !shipment.trackingNumber && (
                              <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                                No Tracking
                              </Badge>
                            )}
                            {!shipment.shipmentId && (
                              <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
                                No ShipStation ID
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex gap-2">
                            {shipment.labelUrl && (
                              <Button
                                variant="outline"
                                size="sm"
                                asChild
                              >
                                <a 
                                  href={shipment.labelUrl} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  data-testid={`link-label-${shipment.id}`}
                                >
                                  <ExternalLink className="h-3 w-3 mr-1" />
                                  Label
                                </a>
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Package className="h-12 w-12 text-green-500 mb-4" />
                <h3 className="text-xl font-semibold text-foreground">All Clear!</h3>
                <p className="text-muted-foreground mt-2">
                  No broken shipments found. All shipments have valid data.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Duplicate Shipments Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl flex items-center gap-2">
              <Copy className="h-5 w-5 text-purple-500" />
              Duplicate Shipments
            </CardTitle>
            <CardDescription>
              Orders that have multiple shipment records created - often caused by label printing bugs
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Duplicates List */}
            {duplicatesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-3 text-lg text-muted-foreground">Loading duplicate shipments...</span>
              </div>
            ) : duplicatesData?.duplicates && duplicatesData.duplicates.length > 0 ? (
              <div className="space-y-3">
                {duplicatesData.duplicates.map((order) => (
                  <Collapsible
                    key={order.orderNumber}
                    open={expandedOrders.has(order.orderNumber)}
                    onOpenChange={() => toggleOrderExpanded(order.orderNumber)}
                  >
                    <CollapsibleTrigger asChild>
                      <div 
                        className="flex items-center justify-between p-4 bg-muted/50 rounded-lg cursor-pointer hover-elevate"
                        data-testid={`row-duplicate-${order.orderNumber}`}
                      >
                        <div className="flex items-center gap-4">
                          {expandedOrders.has(order.orderNumber) ? (
                            <ChevronDown className="h-5 w-5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-5 w-5 text-muted-foreground" />
                          )}
                          <span className="font-mono font-semibold text-lg">{order.orderNumber}</span>
                          <Badge variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                            {order.shipmentCount} shipments
                          </Badge>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(`/shipments?search=${order.orderNumber}`, '_blank');
                          }}
                          data-testid={`link-view-shipments-${order.orderNumber}`}
                        >
                          <ExternalLink className="h-4 w-4 mr-1" />
                          View in Shipments
                        </Button>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-2 ml-9 mr-4 border rounded-lg overflow-hidden">
                        <table className="w-full">
                          <thead>
                            <tr className="bg-muted/30 border-b">
                              <th className="text-left py-2 px-4 text-sm font-medium">Type</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Shipment ID</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Tracking #</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Status</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Ship Date</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Created</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Indicators</th>
                              <th className="text-left py-2 px-4 text-sm font-medium">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {order.shipments.map((shipment) => (
                              <tr 
                                key={shipment.id} 
                                className={`border-b last:border-b-0 ${shipment.isLikelyOriginal ? 'bg-green-50 dark:bg-green-950/20' : 'bg-red-50/50 dark:bg-red-950/10'}`}
                                data-testid={`row-shipment-detail-${shipment.id}`}
                              >
                                <td className="py-2 px-4">
                                  {shipment.isLikelyOriginal ? (
                                    <Badge className="bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300 border-green-300 dark:border-green-700">
                                      Original
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300 border-red-300 dark:border-red-700">
                                      Duplicate
                                    </Badge>
                                  )}
                                </td>
                                <td className="py-2 px-4 font-mono text-sm">
                                  {shipment.shipmentId || <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className="py-2 px-4 font-mono text-sm">
                                  {shipment.trackingNumber || <span className="text-muted-foreground">—</span>}
                                </td>
                                <td className="py-2 px-4">
                                  <Badge variant="outline" className="text-xs">
                                    {shipment.status || 'unknown'}
                                  </Badge>
                                </td>
                                <td className="py-2 px-4 text-sm text-muted-foreground">
                                  {formatShortDate(shipment.shipDate)}
                                </td>
                                <td className="py-2 px-4 text-sm text-muted-foreground">
                                  {formatShortDate(shipment.createdAt)}
                                </td>
                                <td className="py-2 px-4">
                                  <div className="flex flex-wrap gap-1">
                                    {shipment.sessionId && (
                                      <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300">
                                        Session
                                      </Badge>
                                    )}
                                    {shipment.waveId && (
                                      <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300">
                                        Wave
                                      </Badge>
                                    )}
                                    {shipment.externalShipmentId && (
                                      <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300">
                                        Shopify
                                      </Badge>
                                    )}
                                    <Badge variant="outline" className={`text-xs ${shipment.shipmentDataKeyCount >= 20 ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300' : 'bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-300'}`}>
                                      {shipment.shipmentDataKeyCount} keys
                                    </Badge>
                                  </div>
                                </td>
                                <td className="py-2 px-4">
                                  {shipment.shipmentId && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => fixShipmentNumberMutation.mutate(shipment.id)}
                                      disabled={fixingShipmentId === shipment.id}
                                      title={`Fix to: ${getExpectedNewShipmentNumber(order.orderNumber, shipment.shipmentId)}`}
                                      data-testid={`button-fix-shipment-${shipment.id}`}
                                    >
                                      {fixingShipmentId === shipment.id ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <>
                                          <Wrench className="h-3 w-3 mr-1" />
                                          Fix #
                                        </>
                                      )}
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="p-3 bg-muted/20 text-sm text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-4">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300 text-xs">Original</Badge>
                              <span>Has session/wave ID, Shopify link, or full shipment data (20+ keys)</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge className="bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300 text-xs">Duplicate</Badge>
                              <span>Created by label bug - only has tracking data</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Copy className="h-12 w-12 text-green-500 mb-4" />
                <h3 className="text-xl font-semibold text-foreground">No Duplicates Found</h3>
                <p className="text-muted-foreground mt-2">
                  No orders with multiple shipments in the selected date range.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
