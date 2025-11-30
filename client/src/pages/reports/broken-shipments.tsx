import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, RefreshCw, ExternalLink, Package, Link2Off, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

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

export default function BrokenShipmentsReport() {
  const { toast } = useToast();
  
  const { data, isLoading, refetch, isRefetching } = useQuery<BrokenShipmentsResponse>({
    queryKey: ['/api/reports/broken-shipments'],
    queryFn: async () => {
      const res = await fetch('/api/reports/broken-shipments', { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
  });

  const formatDate = (dateStr: string) => {
    try {
      return format(new Date(dateStr), "MMM dd, yyyy HH:mm");
    } catch {
      return dateStr;
    }
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
            onClick={() => refetch()}
            disabled={isRefetching}
            data-testid="button-refresh"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Summary Cards */}
        {data?.summary && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  {data.summary.hasLabelNoTracking}
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
                  {data.summary.orphanedShipmentId}
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
                  {data.summary.missingShipmentData}
                </div>
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
      </div>
    </div>
  );
}
