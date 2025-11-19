import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";
import { 
  Database, 
  Trash2, 
  RefreshCw, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Search,
  ChevronDown,
  ChevronRight,
  Activity
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type QueueStats = {
  shopifyQueue: {
    size: number;
    oldestMessageAt: number | null;
  };
  shipmentSyncQueue: {
    size: number;
    oldestMessageAt: number | null;
  };
  failures: {
    total: number;
  };
};

type ShipmentSyncFailure = {
  id: string;
  orderNumber: string;
  reason: string;
  errorMessage: string;
  requestData: any;
  responseData: any;
  retryCount: number;
  failedAt: string;
  createdAt: string;
};

type FailuresResponse = {
  failures: ShipmentSyncFailure[];
  totalCount: number;
  page: number;
  totalPages: number;
};

function getQueueHealth(size: number, oldestMessageAt: number | null): "healthy" | "warning" | "critical" {
  if (size === 0) return "healthy";
  
  if (oldestMessageAt) {
    const ageInMinutes = (Date.now() - oldestMessageAt) / (1000 * 60);
    if (ageInMinutes > 60) return "critical";
    if (ageInMinutes > 30) return "warning";
  }
  
  if (size > 1000) return "critical";
  if (size > 500) return "warning";
  
  return "healthy";
}

export default function OperationsPage() {
  const [purgeAction, setPurgeAction] = useState<"shopify" | "shipment" | "failures" | null>(null);
  const [showFailuresDialog, setShowFailuresDialog] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedFailure, setExpandedFailure] = useState<string | null>(null);
  const [liveQueueStats, setLiveQueueStats] = useState<QueueStats | null>(null);
  const { toast } = useToast();

  // Initial fetch of queue stats (no polling)
  const { data: initialQueueStats, isLoading: statsLoading } = useQuery<QueueStats>({
    queryKey: ["/api/operations/queue-stats"],
  });

  // Use live stats from WebSocket if available, otherwise fall back to initial fetch
  const queueStats = liveQueueStats || initialQueueStats;

  // WebSocket connection for real-time updates
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
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected (Operations)');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'queue_status' && message.data) {
            // Update live queue stats from WebSocket
            setLiveQueueStats({
              shopifyQueue: {
                size: message.data.shopifyQueue,
                oldestMessageAt: message.data.shopifyQueueOldestAt,
              },
              shipmentSyncQueue: {
                size: message.data.shipmentSyncQueue,
                oldestMessageAt: message.data.shipmentSyncQueueOldestAt,
              },
              failures: {
                total: message.data.shipmentFailureCount,
              },
            });
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
  }, []);

  const { data: failuresData } = useQuery<FailuresResponse>({
    queryKey: ["/api/operations/failures", currentPage, searchTerm],
    enabled: showFailuresDialog,
  });

  const purgeShopifyMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/purge-shopify-queue");
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Queue Purged",
        description: `Cleared ${data.clearedCount} messages from Shopify queue`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/queue-stats"] });
      setPurgeAction(null);
    },
    onError: () => {
      toast({
        title: "Purge Failed",
        description: "Failed to purge Shopify queue",
        variant: "destructive",
      });
    },
  });

  const purgeShipmentSyncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/purge-shipment-sync-queue");
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Queue Purged",
        description: `Cleared ${data.clearedCount} messages from shipment sync queue`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/queue-stats"] });
      setPurgeAction(null);
    },
    onError: () => {
      toast({
        title: "Purge Failed",
        description: "Failed to purge shipment sync queue",
        variant: "destructive",
      });
    },
  });

  const purgeFailuresMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/purge-failures");
      return await response.json();
    },
    onSuccess: () => {
      toast({
        title: "Failures Cleared",
        description: "All shipment sync failures have been cleared",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/queue-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/failures"] });
      setPurgeAction(null);
      setShowFailuresDialog(false);
    },
    onError: () => {
      toast({
        title: "Clear Failed",
        description: "Failed to clear failures table",
        variant: "destructive",
      });
    },
  });

  const handlePurge = () => {
    if (purgeAction === "shopify") {
      purgeShopifyMutation.mutate();
    } else if (purgeAction === "shipment") {
      purgeShipmentSyncMutation.mutate();
    } else if (purgeAction === "failures") {
      purgeFailuresMutation.mutate();
    }
  };

  const shopifyHealth = queueStats ? getQueueHealth(
    queueStats.shopifyQueue.size,
    queueStats.shopifyQueue.oldestMessageAt
  ) : "healthy";

  const shipmentHealth = queueStats ? getQueueHealth(
    queueStats.shipmentSyncQueue.size,
    queueStats.shipmentSyncQueue.oldestMessageAt
  ) : "healthy";

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Operations Dashboard</h1>
          <p className="text-muted-foreground">Monitor queue health and manage system operations</p>
        </div>
        <Button
          data-testid="button-refresh-stats"
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/operations/queue-stats"] })}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card data-testid="card-shopify-queue">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-lg">Shopify Queue</CardTitle>
              <CardDescription>Order webhooks awaiting processing</CardDescription>
            </div>
            <Badge
              data-testid={`badge-health-${shopifyHealth}`}
              variant={
                shopifyHealth === "healthy" ? "default" :
                shopifyHealth === "warning" ? "secondary" : "destructive"
              }
            >
              {shopifyHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
              {shopifyHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shopifyHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shopifyHealth}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold" data-testid="text-shopify-queue-size">
                  {statsLoading ? "-" : queueStats?.shopifyQueue.size.toLocaleString()}
                </span>
                <span className="text-muted-foreground">messages</span>
              </div>
              {queueStats?.shopifyQueue.oldestMessageAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Oldest: {formatDistanceToNow(new Date(queueStats.shopifyQueue.oldestMessageAt), { addSuffix: true })}
                </div>
              )}
              <Button
                data-testid="button-purge-shopify"
                variant="outline"
                size="sm"
                onClick={() => setPurgeAction("shopify")}
                disabled={!queueStats || queueStats.shopifyQueue.size === 0}
                className="w-full"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Purge Queue
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-shipment-sync-queue">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-lg">Shipment Sync Queue</CardTitle>
              <CardDescription>Shipments awaiting enrichment</CardDescription>
            </div>
            <Badge
              data-testid={`badge-health-${shipmentHealth}`}
              variant={
                shipmentHealth === "healthy" ? "default" :
                shipmentHealth === "warning" ? "secondary" : "destructive"
              }
            >
              {shipmentHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
              {shipmentHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shipmentHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shipmentHealth}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold" data-testid="text-shipment-queue-size">
                  {statsLoading ? "-" : queueStats?.shipmentSyncQueue.size.toLocaleString()}
                </span>
                <span className="text-muted-foreground">messages</span>
              </div>
              {queueStats?.shipmentSyncQueue.oldestMessageAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Oldest: {formatDistanceToNow(new Date(queueStats.shipmentSyncQueue.oldestMessageAt), { addSuffix: true })}
                </div>
              )}
              <Button
                data-testid="button-purge-shipment-sync"
                variant="outline"
                size="sm"
                onClick={() => setPurgeAction("shipment")}
                disabled={!queueStats || queueStats.shipmentSyncQueue.size === 0}
                className="w-full"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Purge Queue
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-failures">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="h-5 w-5" />
            Shipment Sync Failures
          </CardTitle>
          <CardDescription>Dead letter queue for failed shipment syncs</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold" data-testid="text-failure-count">
                {statsLoading ? "-" : queueStats?.failures.total.toLocaleString()}
              </span>
              <span className="text-muted-foreground">failures</span>
            </div>
            <div className="flex gap-2">
              <Button
                data-testid="button-view-failures"
                variant="outline"
                size="sm"
                onClick={() => setShowFailuresDialog(true)}
                disabled={!queueStats || queueStats.failures.total === 0}
                className="flex-1"
              >
                <Search className="h-4 w-4 mr-2" />
                View Details
              </Button>
              <Button
                data-testid="button-purge-failures"
                variant="outline"
                size="sm"
                onClick={() => setPurgeAction("failures")}
                disabled={!queueStats || queueStats.failures.total === 0}
                className="flex-1"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-worker-status">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Worker Status
          </CardTitle>
          <CardDescription>Background workers processing queues</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Shopify Webhook Worker</p>
                <p className="text-sm text-muted-foreground">Processes 50 webhooks per batch, 5s intervals</p>
              </div>
              <Badge variant="default" data-testid="badge-shopify-worker">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Running
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Shipment Sync Worker</p>
                <p className="text-sm text-muted-foreground">Processes 50 shipments per batch, 10s intervals</p>
              </div>
              <Badge variant="default" data-testid="badge-shipment-worker">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Running
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={purgeAction !== null} onOpenChange={(open) => !open && setPurgeAction(null)}>
        <AlertDialogContent data-testid="dialog-purge-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Purge</AlertDialogTitle>
            <AlertDialogDescription>
              {purgeAction === "shopify" && "This will permanently delete all messages in the Shopify queue. This action cannot be undone."}
              {purgeAction === "shipment" && "This will permanently delete all messages in the shipment sync queue. This action cannot be undone."}
              {purgeAction === "failures" && "This will permanently delete all failure records. This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-purge">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-purge"
              onClick={handlePurge}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Purge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showFailuresDialog} onOpenChange={setShowFailuresDialog}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-failures">
          <DialogHeader>
            <DialogTitle>Shipment Sync Failures</DialogTitle>
            <DialogDescription>
              Detailed view of all failed shipment sync attempts
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                data-testid="input-search-failures"
                placeholder="Search by order number or error message..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                className="flex-1"
              />
            </div>

            {failuresData && failuresData.failures.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-no-failures">
                No failures found
              </div>
            ) : (
              <div className="space-y-2">
                {failuresData?.failures.map((failure) => (
                  <Collapsible
                    key={failure.id}
                    open={expandedFailure === failure.id}
                    onOpenChange={(open) => setExpandedFailure(open ? failure.id : null)}
                  >
                    <Card data-testid={`card-failure-${failure.id}`}>
                      <CollapsibleTrigger asChild>
                        <CardHeader className="cursor-pointer hover-elevate active-elevate-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {expandedFailure === failure.id ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                              <div>
                                <CardTitle className="text-base">{failure.orderNumber}</CardTitle>
                                <CardDescription className="text-xs">
                                  {formatDistanceToNow(new Date(failure.failedAt), { addSuffix: true })}
                                </CardDescription>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary">{failure.reason}</Badge>
                              {failure.retryCount > 0 && (
                                <Badge variant="outline">{failure.retryCount} retries</Badge>
                              )}
                            </div>
                          </div>
                        </CardHeader>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <CardContent className="space-y-4">
                          <div>
                            <p className="text-sm font-medium mb-1">Error Message</p>
                            <p className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded">
                              {failure.errorMessage}
                            </p>
                          </div>
                          {failure.requestData && (
                            <div>
                              <p className="text-sm font-medium mb-1">Request Data</p>
                              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                                {JSON.stringify(failure.requestData, null, 2)}
                              </pre>
                            </div>
                          )}
                          {failure.responseData && (
                            <div>
                              <p className="text-sm font-medium mb-1">Response Data</p>
                              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                                {JSON.stringify(failure.responseData, null, 2)}
                              </pre>
                            </div>
                          )}
                        </CardContent>
                      </CollapsibleContent>
                    </Card>
                  </Collapsible>
                ))}
              </div>
            )}

            {failuresData && failuresData.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  data-testid="button-prev-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="text-page-info">
                  Page {currentPage} of {failuresData.totalPages}
                </span>
                <Button
                  data-testid="button-next-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(failuresData.totalPages, p + 1))}
                  disabled={currentPage === failuresData.totalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
