import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";
import { Link } from "wouter";
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
  Activity,
  Settings,
  Package,
  Truck,
  ShoppingCart,
  XCircle,
  Copy,
  AlertTriangle,
  Pause,
  Zap,
  WifiOff,
  Monitor
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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

type BackfillJob = {
  id: string;
  startDate: string;
  endDate: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  shopifyOrdersTotal: number;
  shopifyOrdersImported: number;
  shopifyOrdersFailed: number;
  shipstationShipmentsTotal: number;
  shipstationShipmentsImported: number;
  shipstationShipmentsFailed: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type QueueStats = {
  shopifyQueue: {
    size: number;
    oldestMessageAt: number | null;
  };
  shipmentSyncQueue: {
    size: number;
    oldestMessageAt: number | null;
  };
  shopifyOrderSyncQueue: {
    size: number;
    oldestMessageAt: number | null;
  };
  failures: {
    total: number;
  };
  backfill: {
    activeJob: BackfillJob | null;
    recentJobs: BackfillJob[];
  };
  dataHealth?: {
    ordersMissingShipments: number;
    oldestOrderMissingShipmentAt: string | null;
    shipmentsWithoutOrders: number;
    orphanedShipments: number;
    shipmentsWithoutStatus: number;
    shipmentSyncFailures: number;
    shopifyOrderSyncFailures: number;
  };
  pipeline?: {
    sessionedToday: number;
    inPackingQueue: number;
    shippedToday: number;
    oldestQueuedSessionAt: string | null;
  };
  onHoldWorkerStatus?: 'sleeping' | 'running' | 'awaiting_backfill_job';
  onHoldWorkerStats?: {
    totalProcessedCount: number;
    lastProcessedCount: number;
    workerStartedAt: string;
    lastCompletedAt: string | null;
  };
  reverseSyncProgress?: {
    inProgress: boolean;
    currentPage: number;
    totalStaleAtStart: number;
    checkedThisRun: number;
    updatedThisRun: number;
    startedAt: string | null;
  };
  firestoreSessionSyncWorkerStatus?: 'sleeping' | 'running' | 'error';
  firestoreSessionSyncWorkerStats?: {
    totalSynced: number;
    lastSyncCount: number;
    lastSyncAt: string | null;
    lastSyncTimestamp: string | null;
    workerStartedAt: string;
    errorsCount: number;
    lastError: string | null;
  };
  stalePrintJobs?: {
    totalStale: number;
    warningCount: number;
    criticalCount: number;
    healthStatus: 'healthy' | 'warning' | 'critical';
    lastCheckedAt: string;
  };
  unifiedSyncWorker?: {
    status: 'running' | 'sleeping' | 'idle' | 'error';
    cursor: string | null;
    cursorAge: number | null;
    cursorAgeLabel: string | null;
    lastPollAt: string | null;
    lastPollDuration: number | null;
    pollIntervalSeconds: number;
    shipmentsProcessedTotal: number;
    shipmentsProcessedLastPoll: number;
    workerStartedAt: string;
    error: string | null;
  };
};

type EnvironmentInfo = {
  redis: {
    host: string;
    configured: boolean;
  };
  webhooks: {
    baseUrl: string;
    environment: "production" | "development";
  };
};

type ShopifyValidation = {
  isValid: boolean;
  errors: string[];
  lastChecked: string;
  shopName?: string;
};

type SkuVaultValidation = {
  isValid: boolean;
  credentialsConfigured: boolean;
  tokenValid: boolean;
  lastRefreshed: string | null;
  errors: string[];
  lastChecked: string;
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

type ShopifyWebhook = {
  id: number;
  topic: string;
  address: string;
  format: string;
  created_at: string;
  updated_at: string;
};

type ShipStationWebhook = {
  webhook_id: string;
  name: string;
  event: string;
  url: string;
  store_id: string | null;
};

type StationsResponse = {
  stations: Array<{
    id: string;
    name: string;
    isActive: boolean;
    isConnected?: boolean;
  }>;
  connectionStats?: {
    total: number;
    connected: number;
    offline: number;
  };
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

function ClearFailuresButton() {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);

  const clearFailuresMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("DELETE", "/api/operations/shipment-sync-failures");
    },
    onSuccess: () => {
      // WebSocket will update queue stats automatically
      toast({
        title: "Success",
        description: "All shipment sync failures have been cleared",
      });
      setShowDialog(false);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to clear failures",
      });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowDialog(true)}
        data-testid="button-clear-failures"
      >
        Clear All
      </Button>
      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent data-testid="dialog-clear-failures">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Shipment Sync Failures?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all shipment sync failure records. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-clear-failures">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => clearFailuresMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-clear-failures"
            >
              {clearFailuresMutation.isPending ? "Clearing..." : "Clear All"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BackfillCancelButton({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", `/api/backfill/jobs/${jobId}/cancel`);
    },
    onSuccess: () => {
      // WebSocket will update queue stats automatically
      toast({
        title: "Job Cancelled",
        description: "The backfill job has been cancelled successfully",
      });
      setShowDialog(false);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to cancel backfill job",
      });
    },
  });

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setShowDialog(true)}
        data-testid="button-cancel-backfill"
      >
        <XCircle className="h-4 w-4 mr-2" />
        Cancel Job
      </Button>
      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent data-testid="dialog-cancel-backfill">
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Backfill Job?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the backfill job. Progress will be saved, but incomplete imports will stop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-cancel-backfill">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-cancel-backfill"
            >
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Job"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BackfillRestartButton({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);

  const restartMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", `/api/backfill/jobs/${jobId}/restart`);
    },
    onSuccess: () => {
      // WebSocket will update queue stats automatically
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      toast({
        title: "Job Restarted",
        description: "A new backfill job has been started with the same date range",
      });
      setShowDialog(false);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to restart backfill job",
      });
    },
  });

  return (
    <>
      <Button
        variant="default"
        size="sm"
        onClick={() => setShowDialog(true)}
        data-testid="button-restart-backfill"
      >
        <RefreshCw className="h-4 w-4 mr-2" />
        Restart Job
      </Button>
      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent data-testid="dialog-restart-backfill">
          <AlertDialogHeader>
            <AlertDialogTitle>Restart Backfill Job?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create a new backfill job with the same date range and start it immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-restart-backfill">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => restartMutation.mutate()}
              data-testid="button-confirm-restart-backfill"
            >
              {restartMutation.isPending ? "Restarting..." : "Restart Job"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BackfillDeleteButton({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("DELETE", `/api/backfill/jobs/${jobId}`);
    },
    onSuccess: () => {
      // WebSocket will update queue stats automatically
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      toast({
        title: "Job Deleted",
        description: "The backfill job has been deleted successfully",
      });
      setShowDialog(false);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to delete backfill job",
      });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowDialog(true)}
        data-testid="button-delete-backfill"
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete
      </Button>
      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent data-testid="dialog-delete-backfill">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Backfill Job?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this backfill job record. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-backfill">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-backfill"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Job"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function OperationsPage() {
  const [purgeAction, setPurgeAction] = useState<"shopify" | "shipment" | "shopify-order-sync" | "failures" | "shopify-order-sync-failures" | null>(null);
  const [showFailuresDialog, setShowFailuresDialog] = useState(false);
  const [showShopifyOrderSyncFailuresDialog, setShowShopifyOrderSyncFailuresDialog] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [shopifyOrderSyncSearchTerm, setShopifyOrderSyncSearchTerm] = useState("");
  const [shopifyOrderSyncCurrentPage, setShopifyOrderSyncCurrentPage] = useState(1);
  const [expandedFailure, setExpandedFailure] = useState<string | null>(null);
  const [liveQueueStats, setLiveQueueStats] = useState<QueueStats | null>(null);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
  
  // Ref to access initialQueueStats in WebSocket handler without adding to dependencies
  const initialQueueStatsRef = useRef<QueueStats | undefined>(undefined);
  const [showReregisterDialog, setShowReregisterDialog] = useState(false);
  const [showShipStationReregisterDialog, setShowShipStationReregisterDialog] = useState(false);
  const [webhookToDelete, setWebhookToDelete] = useState<ShopifyWebhook | null>(null);
  const [shipStationWebhookToDelete, setShipStationWebhookToDelete] = useState<ShipStationWebhook | null>(null);
  const [showClearOrderDataDialog, setShowClearOrderDataDialog] = useState(false);
  const { toast } = useToast();

  // Helper function to format failure for AI analysis
  const formatFailureForAI = (failure: ShipmentSyncFailure) => {
    return `SHIPMENT SYNC FAILURE ANALYSIS
=====================================

Order Number: ${failure.orderNumber}
Failure ID: ${failure.id}
Failed At: ${new Date(failure.failedAt).toLocaleString()}
Created At: ${new Date(failure.createdAt).toLocaleString()}
Retry Count: ${failure.retryCount}
Reason: ${failure.reason}

Error Message:
${failure.errorMessage}

Request Data:
${JSON.stringify(failure.requestData, null, 2)}

Response Data:
${JSON.stringify(failure.responseData, null, 2)}

=====================================
Please analyze this failure and help me understand:
1. What caused this shipment sync to fail?
2. Is this a data issue, API issue, or integration issue?
3. What steps should I take to fix it?
`;
  };

  // Copy failure to clipboard for AI analysis
  const copyFailureForAI = async (failure: ShipmentSyncFailure) => {
    try {
      const formattedText = formatFailureForAI(failure);
      await navigator.clipboard.writeText(formattedText);
      toast({
        title: "Copied to clipboard",
        description: "Failure details copied. You can now paste this in your AI chat for analysis.",
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Could not copy to clipboard. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Initial fetch of queue stats (bootstrap only - WebSocket takes over after)
  const { data: initialQueueStats, isLoading: statsLoading } = useQuery<QueueStats>({
    queryKey: ["/api/operations/queue-stats"],
    staleTime: Infinity, // Never refetch - WebSocket provides real-time updates
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Fetch environment info (static, no polling)
  const { data: envInfo, isLoading: envLoading } = useQuery<EnvironmentInfo>({
    queryKey: ["/api/operations/environment"],
  });

  // Fetch Shopify credential validation (cached for 10 minutes on backend)
  const { data: shopifyValidation, isLoading: validationLoading } = useQuery<ShopifyValidation>({
    queryKey: ["/api/operations/shopify-validation"],
  });

  // Fetch SkuVault credential validation and token status
  const { data: skuVaultValidation, isLoading: skuVaultValidationLoading } = useQuery<SkuVaultValidation>({
    queryKey: ["/api/operations/skuvault-validation"],
  });

  // Fetch Shopify webhooks list
  const { data: webhooksData, isLoading: webhooksLoading } = useQuery<{ webhooks: ShopifyWebhook[] }>({
    queryKey: ["/api/operations/shopify-webhooks"],
  });

  // Fetch ShipStation webhooks list
  const { data: shipStationWebhooksData, isLoading: shipStationWebhooksLoading } = useQuery<{ webhooks: ShipStationWebhook[] }>({
    queryKey: ["/api/operations/shipstation-webhooks"],
  });

  // Fetch all backfill jobs
  const { data: backfillJobsData, isLoading: backfillJobsLoading } = useQuery<{ jobs: any[] }>({
    queryKey: ["/api/backfill/jobs"],
  });
  
  const allBackfillJobs = backfillJobsData?.jobs || [];

  // Fetch station connection stats
  const { data: stationsData } = useQuery<StationsResponse>({
    queryKey: ["/api/stations"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });
  
  const stationConnectionStats = stationsData?.connectionStats;

  // Use live stats from WebSocket if available, otherwise fall back to initial fetch
  const queueStats = liveQueueStats || initialQueueStats;
  
  // Show loading state only if we have no data at all (neither from WebSocket nor initial API)
  const hasQueueData = !!queueStats;

  // Keep the ref updated so WebSocket handler can access it
  useEffect(() => {
    if (initialQueueStats) {
      initialQueueStatsRef.current = initialQueueStats;
    }
  }, [initialQueueStats]);

  // Initialize liveQueueStats with initialQueueStats when it first loads
  useEffect(() => {
    if (initialQueueStats && !liveQueueStats) {
      setLiveQueueStats(initialQueueStats);
    }
  }, [initialQueueStats, liveQueueStats]);

  // WebSocket connection for real-time updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=operations`;
      
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected (Operations)');
        reconnectAttempts = 0;
        setIsWebSocketConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'queue_status' && message.data) {
            // Update live queue stats from WebSocket
            // Strategy: Use WebSocket data if defined, otherwise preserve previous/initial values
            // This prevents flashing to zero when partial updates are sent
            const initial = initialQueueStatsRef.current;
            setLiveQueueStats((prev) => ({
              shopifyQueue: {
                size: message.data.shopifyQueue ?? prev?.shopifyQueue?.size ?? initial?.shopifyQueue?.size ?? 0,
                oldestMessageAt: message.data.shopifyQueueOldestAt ?? prev?.shopifyQueue?.oldestMessageAt ?? null,
              },
              shipmentSyncQueue: {
                size: message.data.shipmentSyncQueue ?? prev?.shipmentSyncQueue?.size ?? initial?.shipmentSyncQueue?.size ?? 0,
                oldestMessageAt: message.data.shipmentSyncQueueOldestAt ?? prev?.shipmentSyncQueue?.oldestMessageAt ?? null,
              },
              shopifyOrderSyncQueue: {
                size: message.data.shopifyOrderSyncQueue ?? prev?.shopifyOrderSyncQueue?.size ?? initial?.shopifyOrderSyncQueue?.size ?? 0,
                oldestMessageAt: message.data.shopifyOrderSyncQueueOldestAt ?? prev?.shopifyOrderSyncQueue?.oldestMessageAt ?? null,
              },
              failures: {
                total: message.data.shipmentFailureCount ?? prev?.failures?.total ?? initial?.failures?.total ?? 0,
              },
              backfill: {
                // Only update activeJob if explicitly provided (null clears it, undefined preserves)
                activeJob: message.data.backfillActiveJob !== undefined 
                  ? message.data.backfillActiveJob 
                  : (prev?.backfill?.activeJob ?? initial?.backfill?.activeJob ?? null),
                // Preserve recentJobs from initial API load since WebSocket doesn't send them
                recentJobs: prev?.backfill?.recentJobs || initial?.backfill?.recentJobs || [],
              },
              // Use WebSocket dataHealth if defined, otherwise preserve previous
              dataHealth: message.data.dataHealth ?? prev?.dataHealth ?? initial?.dataHealth,
              // Pipeline metrics - now included in WebSocket broadcasts
              pipeline: message.data.pipeline ?? prev?.pipeline ?? initial?.pipeline,
              onHoldWorkerStatus: message.data.onHoldWorkerStatus ?? prev?.onHoldWorkerStatus ?? 'sleeping',
              // Only update onHoldWorkerStats if defined, otherwise preserve previous value
              onHoldWorkerStats: message.data.onHoldWorkerStats !== undefined 
                ? message.data.onHoldWorkerStats 
                : (prev?.onHoldWorkerStats ?? initial?.onHoldWorkerStats),
              // Reverse sync progress - live status of on_hold reverse sync
              reverseSyncProgress: message.data.reverseSyncProgress !== undefined
                ? message.data.reverseSyncProgress
                : prev?.reverseSyncProgress,
              // Firestore worker status - use WebSocket data if defined
              firestoreSessionSyncWorkerStatus: message.data.firestoreSessionSyncWorkerStatus 
                ?? prev?.firestoreSessionSyncWorkerStatus 
                ?? initial?.firestoreSessionSyncWorkerStatus,
              firestoreSessionSyncWorkerStats: message.data.firestoreSessionSyncWorkerStats !== undefined
                ? message.data.firestoreSessionSyncWorkerStats
                : (prev?.firestoreSessionSyncWorkerStats ?? initial?.firestoreSessionSyncWorkerStats),
            }));
          } else if (message.type === 'station_connection_change') {
            // Desktop client connected/disconnected - refetch stations data immediately
            console.log(`[WS] Station ${message.stationId} connection change: ${message.isConnected ? 'online' : 'offline'}`);
            queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
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
        setIsWebSocketConnected(false);
        
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
    queryFn: async () => {
      const params = new URLSearchParams({
        page: currentPage.toString(),
        limit: "50",
      });
      if (searchTerm) {
        params.set("search", searchTerm);
      }
      const response = await fetch(`/api/operations/failures?${params}`);
      if (!response.ok) throw new Error("Failed to fetch failures");
      return response.json();
    },
    enabled: showFailuresDialog,
  });
  
  const { data: shopifyOrderSyncFailuresData } = useQuery<FailuresResponse>({
    queryKey: ["/api/operations/shopify-order-sync-failures", shopifyOrderSyncCurrentPage, shopifyOrderSyncSearchTerm],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: shopifyOrderSyncCurrentPage.toString(),
        limit: "50",
      });
      if (shopifyOrderSyncSearchTerm) {
        params.set("search", shopifyOrderSyncSearchTerm);
      }
      const response = await fetch(`/api/operations/shopify-order-sync-failures?${params}`);
      if (!response.ok) throw new Error("Failed to fetch Shopify order sync failures");
      return response.json();
    },
    enabled: showShopifyOrderSyncFailuresDialog,
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
      // WebSocket will update queue stats automatically
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
      // WebSocket will update queue stats automatically
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

  const purgeShopifyOrderSyncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/purge-shopify-order-sync-queue");
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Queue Purged",
        description: `Cleared ${data.clearedCount} messages from Shopify order sync queue`,
      });
      // WebSocket will update queue stats automatically
      setPurgeAction(null);
    },
    onError: () => {
      toast({
        title: "Purge Failed",
        description: "Failed to purge Shopify order sync queue",
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
      // WebSocket will update queue stats automatically
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

  const purgeShopifyOrderSyncFailuresMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/operations/shopify-order-sync-failures");
    },
    onSuccess: () => {
      toast({
        title: "Failures Cleared",
        description: "All Shopify order sync failures have been cleared",
      });
      // WebSocket will update queue stats automatically
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shopify-order-sync-failures"] });
      setPurgeAction(null);
      setShowShopifyOrderSyncFailuresDialog(false);
    },
    onError: () => {
      toast({
        title: "Clear Failed",
        description: "Failed to clear Shopify order sync failures",
        variant: "destructive",
      });
    },
  });

  const clearOrderDataMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/clear-order-data");
      return await response.json();
    },
    onSuccess: () => {
      toast({
        title: "Order Data Cleared",
        description: "All order data has been successfully cleared",
      });
      // WebSocket will update queue stats automatically
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      setShowClearOrderDataDialog(false);
    },
    onError: () => {
      toast({
        title: "Clear Failed",
        description: "Failed to clear order data",
        variant: "destructive",
      });
    },
  });

  const reregisterWebhooksMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/reregister-shopify-webhooks");
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Webhooks Re-registered",
        description: data.message || `Successfully deleted ${data.deleted} and re-registered ${data.registered} webhook(s)`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shopify-validation"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shopify-webhooks"] });
      setShowReregisterDialog(false);
    },
    onError: (error: any) => {
      toast({
        title: "Re-registration Failed",
        description: error.message || "Failed to re-register Shopify webhooks",
        variant: "destructive",
      });
    },
  });

  const rotateSkuVaultTokenMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/operations/skuvault-rotate-token");
      return await response.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Token Rotated",
        description: data.message || "SkuVault token rotated successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/skuvault-validation"] });
    },
    onError: (error: any) => {
      toast({
        title: "Rotation Failed",
        description: error.message || "Failed to rotate SkuVault token",
        variant: "destructive",
      });
    },
  });

  const deleteWebhookMutation = useMutation({
    mutationFn: async (webhookId: number) => {
      const response = await apiRequest("DELETE", `/api/operations/shopify-webhooks/${webhookId}`);
      return await response.json();
    },
    onSuccess: () => {
      toast({
        title: "Webhook Deleted",
        description: "Successfully deleted webhook",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shopify-webhooks"] });
      setWebhookToDelete(null);
    },
    onError: (error: any) => {
      toast({
        title: "Delete Failed",
        description: error.message || "Failed to delete webhook",
        variant: "destructive",
      });
    },
  });

  const deleteShipStationWebhookMutation = useMutation({
    mutationFn: async (webhookId: string) => {
      const response = await apiRequest("DELETE", `/api/operations/shipstation-webhooks/${webhookId}`);
      return await response.json();
    },
    onSuccess: () => {
      toast({
        title: "Webhook Deleted",
        description: "Successfully deleted ShipStation webhook",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shipstation-webhooks"] });
      setShipStationWebhookToDelete(null);
    },
    onError: (error: any) => {
      toast({
        title: "Delete Failed",
        description: error.message || "Failed to delete ShipStation webhook",
        variant: "destructive",
      });
    },
  });

  const reregisterShipStationWebhooksMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/operations/reregister-shipstation-webhooks", {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json();
      
      if (response.status === 207) {
        return { ...data, partialSuccess: true };
      }
      
      if (!response.ok) {
        throw new Error(data.error || data.message || "Failed to register webhooks");
      }
      
      return data;
    },
    onSuccess: (data: any) => {
      if (data.partialSuccess) {
        const failedEvents = data.failedEvents?.map((f: any) => f.event).join(", ") || "unknown";
        toast({
          title: "Partial Registration",
          description: `Some webhooks failed to register: ${failedEvents}. This may require elevated ShipStation plan permissions.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Webhooks Re-registered",
          description: data.message || `Successfully re-registered ${data.after} webhook(s)`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/operations/shipstation-webhooks"] });
      setShowShipStationReregisterDialog(false);
    },
    onError: (error: any) => {
      toast({
        title: "Re-registration Failed",
        description: error.message || "Failed to re-register ShipStation webhooks",
        variant: "destructive",
      });
    },
  });

  const handlePurge = () => {
    if (purgeAction === "shopify") {
      purgeShopifyMutation.mutate();
    } else if (purgeAction === "shipment") {
      purgeShipmentSyncMutation.mutate();
    } else if (purgeAction === "shopify-order-sync") {
      purgeShopifyOrderSyncMutation.mutate();
    } else if (purgeAction === "failures") {
      purgeFailuresMutation.mutate();
    } else if (purgeAction === "shopify-order-sync-failures") {
      purgeShopifyOrderSyncFailuresMutation.mutate();
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

  const shopifyOrderSyncHealth = queueStats && queueStats.shopifyOrderSyncQueue ? getQueueHealth(
    queueStats.shopifyOrderSyncQueue.size,
    queueStats.shopifyOrderSyncQueue.oldestMessageAt
  ) : "healthy";

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Operations Dashboard</h1>
          <p className="text-muted-foreground">Monitor queue health and manage system operations</p>
        </div>
        <div className="flex items-center gap-2">
          {isWebSocketConnected && (
            <Badge variant="default" className="gap-1">
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              Live Updates
            </Badge>
          )}
          <Button
            data-testid="button-refresh-stats"
            variant="outline"
            size="sm"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/operations/queue-stats"] })}
            disabled={isWebSocketConnected}
            title={isWebSocketConnected ? "Real-time updates active via WebSocket" : "Manually refresh queue stats"}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card data-testid="card-shopify-queue" className="min-h-[280px]">
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
                  {!hasQueueData ? "-" : queueStats?.shopifyQueue.size.toLocaleString()}
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

        <Card data-testid="card-shipment-sync-queue" className="min-h-[280px]">
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
                  {!hasQueueData ? "-" : queueStats?.shipmentSyncQueue.size.toLocaleString()}
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

        <Card data-testid="card-shopify-order-sync-queue" className="min-h-[280px]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-lg">Shopify Order Sync</CardTitle>
              <CardDescription>Missing orders awaiting import</CardDescription>
            </div>
            <Badge
              data-testid={`badge-health-${shopifyOrderSyncHealth}`}
              variant={
                shopifyOrderSyncHealth === "healthy" ? "default" :
                shopifyOrderSyncHealth === "warning" ? "secondary" : "destructive"
              }
            >
              {shopifyOrderSyncHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
              {shopifyOrderSyncHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shopifyOrderSyncHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
              {shopifyOrderSyncHealth}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold" data-testid="text-shopify-order-sync-queue-size">
                  {!hasQueueData ? "-" : queueStats?.shopifyOrderSyncQueue.size.toLocaleString()}
                </span>
                <span className="text-muted-foreground">orders</span>
              </div>
              {queueStats?.shopifyOrderSyncQueue.oldestMessageAt && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Oldest: {formatDistanceToNow(new Date(queueStats.shopifyOrderSyncQueue.oldestMessageAt), { addSuffix: true })}
                </div>
              )}
              <Button
                data-testid="button-purge-shopify-order-sync"
                variant="outline"
                size="sm"
                onClick={() => setPurgeAction("shopify-order-sync")}
                disabled={!queueStats || queueStats.shopifyOrderSyncQueue.size === 0}
                className="w-full"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Purge Queue
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline Metrics - SkuVault Session Workflow */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Package className="h-5 w-5" />
          Pipeline Metrics
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card data-testid="card-sessioned-today" className="hover-elevate min-h-[180px]">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <div>
                <CardTitle className="text-lg">Sessioned Today</CardTitle>
                <CardDescription>Orders entered wave picking</CardDescription>
              </div>
              <Zap className="h-5 w-5 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold" data-testid="text-sessioned-today">
                    {!hasQueueData ? "-" : (queueStats?.pipeline?.sessionedToday ?? 0).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground">orders</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Link href="/shipments?tab=packing_queue">
            <Card data-testid="card-packing-queue" className="hover-elevate active-elevate-2 cursor-pointer min-h-[180px]">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <div>
                  <CardTitle className="text-lg">Packing Queue</CardTitle>
                  <CardDescription>Sessioned but not shipped</CardDescription>
                </div>
                {(() => {
                  const queueHealth = (() => {
                    const count = queueStats?.pipeline?.inPackingQueue ?? 0;
                    if (count === 0) return "healthy";
                    if (count > 50) return "warning";
                    return "healthy";
                  })();
                  
                  return (
                    <Badge
                      data-testid={`badge-packing-queue-${queueHealth}`}
                      variant={queueHealth === "healthy" ? "default" : "secondary"}
                    >
                      {queueHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                      {queueHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
                      {queueHealth}
                    </Badge>
                  );
                })()}
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold" data-testid="text-packing-queue">
                      {!hasQueueData ? "-" : (queueStats?.pipeline?.inPackingQueue ?? 0).toLocaleString()}
                    </span>
                    <span className="text-muted-foreground">orders</span>
                  </div>
                  {queueStats?.pipeline?.oldestQueuedSessionAt && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      Oldest: {formatDistanceToNow(new Date(queueStats.pipeline.oldestQueuedSessionAt), { addSuffix: true })}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>

          <Card data-testid="card-shipped-today" className="hover-elevate min-h-[180px]">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <div>
                <CardTitle className="text-lg">Shipped Today</CardTitle>
                <CardDescription>Orders with shipments today</CardDescription>
              </div>
              <Truck className="h-5 w-5 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold" data-testid="text-shipped-today">
                    {!hasQueueData ? "-" : (queueStats?.pipeline?.shippedToday ?? 0).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground">orders</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Link href="/stations?connection=offline">
            <Card data-testid="card-offline-stations" className="hover-elevate active-elevate-2 cursor-pointer min-h-[180px]">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <div>
                  <CardTitle className="text-lg">Offline Stations</CardTitle>
                  <CardDescription>Active stations not connected</CardDescription>
                </div>
                {(() => {
                  const offlineCount = stationConnectionStats?.offline ?? 0;
                  const totalCount = stationConnectionStats?.total ?? 0;
                  const stationsHealth = (() => {
                    if (totalCount === 0) return "healthy";
                    if (offlineCount === 0) return "healthy";
                    if (offlineCount === totalCount) return "critical";
                    return "warning";
                  })();
                  
                  return (
                    <Badge
                      data-testid={`badge-stations-${stationsHealth}`}
                      variant={
                        stationsHealth === "healthy" ? "default" :
                        stationsHealth === "warning" ? "secondary" : "destructive"
                      }
                    >
                      {stationsHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                      {stationsHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
                      {stationsHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
                      {stationsHealth}
                    </Badge>
                  );
                })()}
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold" data-testid="text-offline-stations">
                      {stationConnectionStats?.offline ?? 0}
                    </span>
                    <span className="text-muted-foreground">
                      of {stationConnectionStats?.total ?? 0} stations
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Monitor className="h-4 w-4" />
                    {stationConnectionStats?.connected ?? 0} online
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/print-queue">
            <Card data-testid="card-stale-print-jobs" className="hover-elevate active-elevate-2 cursor-pointer min-h-[180px]">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <div>
                  <CardTitle className="text-lg">Stale Print Jobs</CardTitle>
                  <CardDescription>Jobs waiting too long</CardDescription>
                </div>
                {(() => {
                  const staleHealth = queueStats?.stalePrintJobs?.healthStatus ?? 'healthy';
                  
                  return (
                    <Badge
                      data-testid={`badge-stale-print-${staleHealth}`}
                      variant={
                        staleHealth === "healthy" ? "default" :
                        staleHealth === "warning" ? "secondary" : "destructive"
                      }
                    >
                      {staleHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                      {staleHealth === "warning" && <AlertTriangle className="h-3 w-3 mr-1" />}
                      {staleHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
                      {staleHealth}
                    </Badge>
                  );
                })()}
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold" data-testid="text-stale-print-jobs">
                      {!hasQueueData ? "-" : (queueStats?.stalePrintJobs?.totalStale ?? 0)}
                    </span>
                    <span className="text-muted-foreground">stale jobs</span>
                  </div>
                  {(queueStats?.stalePrintJobs?.totalStale ?? 0) > 0 && (
                    <div className="flex items-center gap-3 text-sm">
                      {(queueStats?.stalePrintJobs?.warningCount ?? 0) > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {queueStats?.stalePrintJobs?.warningCount} warning
                        </span>
                      )}
                      {(queueStats?.stalePrintJobs?.criticalCount ?? 0) > 0 && (
                        <span className="text-red-600 dark:text-red-400">
                          {queueStats?.stalePrintJobs?.criticalCount} critical
                        </span>
                      )}
                    </div>
                  )}
                  {queueStats?.stalePrintJobs?.lastCheckedAt && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      Checked {formatDistanceToNow(new Date(queueStats.stalePrintJobs.lastCheckedAt), { addSuffix: true })}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>
      </div>

      {/* Data Health */}
      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/orders?hasShipment=false">
          <Card data-testid="card-orders-missing-shipments" className="hover-elevate active-elevate-2 cursor-pointer min-h-[280px]">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle className="text-lg">Orders Missing Shipments</CardTitle>
                <CardDescription>Orders without shipment records</CardDescription>
              </div>
              {(() => {
                const ordersMissingHealth = (() => {
                  if (!queueStats?.dataHealth?.ordersMissingShipments) return "healthy";
                  if (!queueStats?.dataHealth?.oldestOrderMissingShipmentAt) return "healthy";
                  
                  const ageMinutes = (Date.now() - new Date(queueStats.dataHealth.oldestOrderMissingShipmentAt).getTime()) / (1000 * 60);
                  if (ageMinutes > 90) return "critical";
                  if (ageMinutes > 75) return "warning";
                  return "healthy";
                })();
                
                return (
                  <Badge
                    data-testid={`badge-health-${ordersMissingHealth}`}
                    variant={
                      ordersMissingHealth === "healthy" ? "default" :
                      ordersMissingHealth === "warning" ? "secondary" : "destructive"
                    }
                  >
                    {ordersMissingHealth === "healthy" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {ordersMissingHealth === "warning" && <AlertCircle className="h-3 w-3 mr-1" />}
                    {ordersMissingHealth === "critical" && <AlertCircle className="h-3 w-3 mr-1" />}
                    {ordersMissingHealth}
                  </Badge>
                );
              })()}
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold" data-testid="text-orders-missing-shipments">
                    {!hasQueueData ? "-" : (queueStats?.dataHealth?.ordersMissingShipments ?? 0).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground">orders</span>
                </div>
                {queueStats?.dataHealth?.oldestOrderMissingShipmentAt && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    Oldest: {formatDistanceToNow(new Date(queueStats.dataHealth.oldestOrderMissingShipmentAt), { addSuffix: true })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/shipments?withoutOrders=true">
          <Card data-testid="card-shipments-without-orders" className="hover-elevate active-elevate-2 cursor-pointer min-h-[280px]">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Truck className="h-5 w-5" />
                Shipments Without Orders
              </CardTitle>
              <CardDescription>Shipment records with no linked orders</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-shipments-without-orders">
                {!hasQueueData ? "-" : (queueStats?.dataHealth?.shipmentsWithoutOrders ?? 0).toLocaleString()}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Card data-testid="card-onhold-worker-last-run" className="min-h-[280px]">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-5 w-5" />
              On-Hold Worker - Last Run
            </CardTitle>
            <CardDescription>Time since last successful completion</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="text-3xl font-bold" data-testid="text-onhold-worker-last-run">
                {!hasQueueData || !queueStats?.onHoldWorkerStats?.lastCompletedAt 
                  ? "Never" 
                  : formatDistanceToNow(new Date(queueStats.onHoldWorkerStats.lastCompletedAt), { addSuffix: true })}
              </div>
              {queueStats?.onHoldWorkerStats && (
                <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <div>Last processed: {queueStats.onHoldWorkerStats.lastProcessedCount.toLocaleString()} orders</div>
                  <div>Total processed: {queueStats.onHoldWorkerStats.totalProcessedCount.toLocaleString()} orders</div>
                  <div>Running since: {formatDistanceToNow(new Date(queueStats.onHoldWorkerStats.workerStartedAt), { addSuffix: true })}</div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Link href="/shipments?tab=all&shippedWithoutTracking=true" data-testid="link-shipped-without-tracking">
          <Card data-testid="card-shipments-without-status" className="hover-elevate active-elevate-2 cursor-pointer min-h-[280px]">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertCircle className="h-5 w-5" />
                Shipped Without Tracking
              </CardTitle>
              <CardDescription>Shipped shipments missing tracking numbers</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold" data-testid="text-shipments-without-status">
                {!hasQueueData ? "-" : (queueStats?.dataHealth?.shipmentsWithoutStatus ?? 0).toLocaleString()}
              </div>
            </CardContent>
          </Card>
        </Link>

        <Card data-testid="card-shipment-sync-failures" className="min-h-[280px]">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <XCircle className="h-5 w-5" />
              Shipment Sync Failures
            </CardTitle>
            <CardDescription>Failed shipment synchronization attempts</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="text-3xl font-bold" data-testid="text-shipment-sync-failures">
                {!hasQueueData ? "-" : (queueStats?.dataHealth?.shipmentSyncFailures ?? 0).toLocaleString()}
              </div>
              <div className="flex gap-2">
                <Button
                  data-testid="button-view-failures"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowFailuresDialog(true)}
                  disabled={!queueStats || (queueStats?.dataHealth?.shipmentSyncFailures ?? 0) === 0}
                  className="flex-1"
                >
                  <Search className="h-4 w-4 mr-2" />
                  View
                </Button>
                <Button
                  data-testid="button-purge-failures"
                  variant="outline"
                  size="sm"
                  onClick={() => setPurgeAction("failures")}
                  disabled={!queueStats || (queueStats?.dataHealth?.shipmentSyncFailures ?? 0) === 0}
                  className="flex-1"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-shopify-order-sync-failures" className="min-h-[280px]">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" />
              Shopify Order Sync Failures
            </CardTitle>
            <CardDescription>Orders that failed to import from Shopify</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="text-3xl font-bold" data-testid="text-shopify-order-sync-failures">
                {!hasQueueData ? "-" : (queueStats?.dataHealth?.shopifyOrderSyncFailures ?? 0).toLocaleString()}
              </div>
              <div className="flex gap-2">
                <Button
                  data-testid="button-view-shopify-order-sync-failures"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowShopifyOrderSyncFailuresDialog(true)}
                  disabled={!queueStats || (queueStats?.dataHealth?.shopifyOrderSyncFailures ?? 0) === 0}
                  className="flex-1"
                >
                  <Search className="h-4 w-4 mr-2" />
                  View
                </Button>
                <Button
                  data-testid="button-purge-shopify-order-sync-failures"
                  variant="outline"
                  size="sm"
                  onClick={() => setPurgeAction("shopify-order-sync-failures")}
                  disabled={!queueStats || (queueStats?.dataHealth?.shopifyOrderSyncFailures ?? 0) === 0}
                  className="flex-1"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

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
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <p className="font-medium">On-Hold Poll Worker</p>
                <p className="text-sm text-muted-foreground">
                  {queueStats?.onHoldWorkerStatus === 'awaiting_backfill_job' 
                    ? 'Paused while backfill job is running' 
                    : 'Polls ShipStation for on_hold shipments, 1 minute intervals'}
                </p>
                {queueStats?.onHoldWorkerStats && (
                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1">
                    <div>Last processed: {queueStats.onHoldWorkerStats.lastProcessedCount.toLocaleString()} orders</div>
                    <div>Total processed: {queueStats.onHoldWorkerStats.totalProcessedCount.toLocaleString()} orders</div>
                    <div>Started: {formatDistanceToNow(new Date(queueStats.onHoldWorkerStats.workerStartedAt), { addSuffix: true })}</div>
                    {queueStats.onHoldWorkerStats.lastCompletedAt && (
                      <div>Last run: {formatDistanceToNow(new Date(queueStats.onHoldWorkerStats.lastCompletedAt), { addSuffix: true })}</div>
                    )}
                  </div>
                )}
                {queueStats?.reverseSyncProgress?.inProgress && (
                  <div className="mt-2 p-2 border rounded bg-muted/30" data-testid="reverse-sync-progress">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Reverse Sync In Progress
                    </div>
                    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1">
                      <div>Page: {queueStats.reverseSyncProgress.currentPage} of ~{Math.ceil(queueStats.reverseSyncProgress.totalStaleAtStart / 50)}</div>
                      <div>Checked: {queueStats.reverseSyncProgress.checkedThisRun.toLocaleString()} / {queueStats.reverseSyncProgress.totalStaleAtStart.toLocaleString()}</div>
                      <div>Updated: {queueStats.reverseSyncProgress.updatedThisRun.toLocaleString()}</div>
                      {queueStats.reverseSyncProgress.startedAt && (
                        <div>Started: {formatDistanceToNow(new Date(queueStats.reverseSyncProgress.startedAt), { addSuffix: true })}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <Badge 
                variant={
                  queueStats?.onHoldWorkerStatus === 'running' 
                    ? 'default' 
                    : queueStats?.onHoldWorkerStatus === 'awaiting_backfill_job'
                    ? 'outline'
                    : 'secondary'
                } 
                data-testid={`badge-onhold-worker-${queueStats?.onHoldWorkerStatus || 'unknown'}`}
              >
                {queueStats?.onHoldWorkerStatus === 'running' && <Activity className="h-3 w-3 mr-1" />}
                {queueStats?.onHoldWorkerStatus === 'sleeping' && <Clock className="h-3 w-3 mr-1" />}
                {queueStats?.onHoldWorkerStatus === 'awaiting_backfill_job' && <Pause className="h-3 w-3 mr-1" />}
                {queueStats?.onHoldWorkerStatus === 'running' 
                  ? 'Running' 
                  : queueStats?.onHoldWorkerStatus === 'sleeping' 
                  ? 'Sleeping' 
                  : queueStats?.onHoldWorkerStatus === 'awaiting_backfill_job'
                  ? 'Awaiting Backfill'
                  : 'Unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <p className="font-medium">Firestore Session Sync Worker</p>
                <p className="text-sm text-muted-foreground">
                  {queueStats?.firestoreSessionSyncWorkerStatus === 'error' 
                    ? 'Error syncing sessions' 
                    : 'Syncs SkuVault sessions from Firestore, 1 minute intervals'}
                </p>
                {queueStats?.firestoreSessionSyncWorkerStats && (
                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1">
                    <div>Last synced: {queueStats.firestoreSessionSyncWorkerStats.lastSyncCount.toLocaleString()} sessions</div>
                    <div>Total synced: {queueStats.firestoreSessionSyncWorkerStats.totalSynced.toLocaleString()} sessions</div>
                    {queueStats.firestoreSessionSyncWorkerStats.lastSyncTimestamp && (
                      <div>Sync since: {new Date(queueStats.firestoreSessionSyncWorkerStats.lastSyncTimestamp).toLocaleString()}</div>
                    )}
                    <div>Started: {formatDistanceToNow(new Date(queueStats.firestoreSessionSyncWorkerStats.workerStartedAt), { addSuffix: true })}</div>
                    {queueStats.firestoreSessionSyncWorkerStats.lastSyncAt && (
                      <div>Last sync: {formatDistanceToNow(new Date(queueStats.firestoreSessionSyncWorkerStats.lastSyncAt), { addSuffix: true })}</div>
                    )}
                    {queueStats.firestoreSessionSyncWorkerStats.errorsCount > 0 && (
                      <div className="text-destructive">Errors: {queueStats.firestoreSessionSyncWorkerStats.errorsCount}</div>
                    )}
                  </div>
                )}
              </div>
              <Badge 
                variant={
                  queueStats?.firestoreSessionSyncWorkerStatus === 'running' 
                    ? 'default' 
                    : queueStats?.firestoreSessionSyncWorkerStatus === 'error'
                    ? 'destructive'
                    : 'secondary'
                } 
                data-testid={`badge-firestore-session-sync-worker-${queueStats?.firestoreSessionSyncWorkerStatus || 'unknown'}`}
              >
                {queueStats?.firestoreSessionSyncWorkerStatus === 'running' && <Activity className="h-3 w-3 mr-1" />}
                {queueStats?.firestoreSessionSyncWorkerStatus === 'sleeping' && <Clock className="h-3 w-3 mr-1" />}
                {queueStats?.firestoreSessionSyncWorkerStatus === 'error' && <AlertCircle className="h-3 w-3 mr-1" />}
                {queueStats?.firestoreSessionSyncWorkerStatus === 'running' 
                  ? 'Running' 
                  : queueStats?.firestoreSessionSyncWorkerStatus === 'sleeping' 
                  ? 'Sleeping' 
                  : queueStats?.firestoreSessionSyncWorkerStatus === 'error'
                  ? 'Error'
                  : 'Unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <p className="font-medium">Unified Shipment Sync Worker</p>
                <p className="text-sm text-muted-foreground">
                  {queueStats?.unifiedSyncWorker?.error 
                    ? 'Error syncing shipments' 
                    : `Cursor-based sync, ${queueStats?.unifiedSyncWorker?.pollIntervalSeconds || 30}s intervals`}
                </p>
                {queueStats?.unifiedSyncWorker && (
                  <div className="flex flex-col gap-0.5 text-xs text-muted-foreground mt-1">
                    {queueStats.unifiedSyncWorker.cursor && (
                      <div>Cursor: {new Date(queueStats.unifiedSyncWorker.cursor).toLocaleString()} {queueStats.unifiedSyncWorker.cursorAgeLabel && `(${queueStats.unifiedSyncWorker.cursorAgeLabel} old)`}</div>
                    )}
                    <div>Last poll: {queueStats.unifiedSyncWorker.shipmentsProcessedLastPoll.toLocaleString()} shipments</div>
                    <div>Total synced: {queueStats.unifiedSyncWorker.shipmentsProcessedTotal.toLocaleString()} shipments</div>
                    {queueStats.unifiedSyncWorker.lastPollAt && (
                      <div>Last sync: {formatDistanceToNow(new Date(queueStats.unifiedSyncWorker.lastPollAt), { addSuffix: true })} {queueStats.unifiedSyncWorker.lastPollDuration && `(${queueStats.unifiedSyncWorker.lastPollDuration}ms)`}</div>
                    )}
                    <div>Started: {formatDistanceToNow(new Date(queueStats.unifiedSyncWorker.workerStartedAt), { addSuffix: true })}</div>
                    {queueStats.unifiedSyncWorker.error && (
                      <div className="text-destructive">Error: {queueStats.unifiedSyncWorker.error}</div>
                    )}
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await apiRequest('/api/operations/trigger-unified-sync', { method: 'POST' });
                      } catch (err) {
                        console.error('Failed to trigger sync:', err);
                      }
                    }}
                    data-testid="button-trigger-unified-sync"
                  >
                    <Zap className="h-3 w-3 mr-1" />
                    Poll Now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await apiRequest('/api/operations/force-unified-resync', { method: 'POST' });
                      } catch (err) {
                        console.error('Failed to force resync:', err);
                      }
                    }}
                    data-testid="button-force-unified-resync"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Force Resync (7-day)
                  </Button>
                </div>
              </div>
              <Badge 
                variant={
                  queueStats?.unifiedSyncWorker?.status === 'running' 
                    ? 'default' 
                    : queueStats?.unifiedSyncWorker?.status === 'error'
                    ? 'destructive'
                    : 'secondary'
                } 
                data-testid={`badge-unified-sync-worker-${queueStats?.unifiedSyncWorker?.status || 'unknown'}`}
              >
                {queueStats?.unifiedSyncWorker?.status === 'running' && <Activity className="h-3 w-3 mr-1" />}
                {queueStats?.unifiedSyncWorker?.status === 'sleeping' && <Clock className="h-3 w-3 mr-1" />}
                {queueStats?.unifiedSyncWorker?.status === 'idle' && <Clock className="h-3 w-3 mr-1" />}
                {queueStats?.unifiedSyncWorker?.status === 'error' && <AlertCircle className="h-3 w-3 mr-1" />}
                {queueStats?.unifiedSyncWorker?.status === 'running' 
                  ? 'Running' 
                  : queueStats?.unifiedSyncWorker?.status === 'sleeping' 
                  ? 'Sleeping' 
                  : queueStats?.unifiedSyncWorker?.status === 'idle'
                  ? 'Idle'
                  : queueStats?.unifiedSyncWorker?.status === 'error'
                  ? 'Error'
                  : 'Unknown'}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-skuvault-credentials">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="h-5 w-5" />
              SkuVault Credentials
            </CardTitle>
            <CardDescription>Session token status</CardDescription>
          </div>
          <Badge
            data-testid="badge-skuvault-validation"
            variant={skuVaultValidation?.isValid ? "default" : "destructive"}
          >
            {skuVaultValidationLoading ? (
              "Checking..."
            ) : skuVaultValidation?.isValid ? (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Valid
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 mr-1" />
                Invalid
              </>
            )}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {skuVaultValidationLoading ? (
              <p className="text-sm text-muted-foreground">Checking credentials...</p>
            ) : skuVaultValidation?.isValid ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Session token valid
                </div>
                {skuVaultValidation.lastRefreshed && (
                  <p className="text-xs text-muted-foreground">
                    Token refreshed: {formatDistanceToNow(new Date(skuVaultValidation.lastRefreshed), { addSuffix: true })}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Last checked: {formatDistanceToNow(new Date(skuVaultValidation.lastChecked), { addSuffix: true })}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium text-destructive">Configuration Issues:</p>
                <ul className="space-y-1">
                  {skuVaultValidation?.errors.map((error, idx) => (
                    <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                      <span data-testid={`text-skuvault-error-${idx}`}>{error}</span>
                    </li>
                  ))}
                </ul>
                {skuVaultValidation?.lastChecked && (
                  <p className="text-xs text-muted-foreground">
                    Last checked: {formatDistanceToNow(new Date(skuVaultValidation.lastChecked), { addSuffix: true })}
                  </p>
                )}
              </div>
            )}
            <div className="pt-3 border-t">
              <Button
                onClick={() => rotateSkuVaultTokenMutation.mutate()}
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!skuVaultValidation?.credentialsConfigured || rotateSkuVaultTokenMutation.isPending}
                data-testid="button-rotate-skuvault-token"
              >
                <RefreshCw className={cn("h-4 w-4 mr-2", rotateSkuVaultTokenMutation.isPending && "animate-spin")} />
                {rotateSkuVaultTokenMutation.isPending ? "Rotating Token..." : "Rotate Token"}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Force a fresh login to SkuVault and refresh the session token
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-shopify-credentials">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Shopify Credentials
            </CardTitle>
            <CardDescription>API connection status (cached 10min)</CardDescription>
          </div>
          <Badge
            data-testid="badge-shopify-validation"
            variant={shopifyValidation?.isValid ? "default" : "destructive"}
          >
            {validationLoading ? (
              "Checking..."
            ) : shopifyValidation?.isValid ? (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Valid
              </>
            ) : (
              <>
                <AlertCircle className="h-3 w-3 mr-1" />
                Invalid
              </>
            )}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {validationLoading ? (
              <p className="text-sm text-muted-foreground">Validating credentials...</p>
            ) : shopifyValidation?.isValid ? (
              <div className="space-y-2">
                {shopifyValidation.shopName && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">Shop:</span>
                    <span className="text-sm text-muted-foreground" data-testid="text-shop-name">
                      {shopifyValidation.shopName}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  All credentials valid
                </div>
                <p className="text-xs text-muted-foreground">
                  Last checked: {formatDistanceToNow(new Date(shopifyValidation.lastChecked), { addSuffix: true })}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium text-destructive">Configuration Issues:</p>
                <ul className="space-y-1">
                  {shopifyValidation?.errors.map((error, idx) => (
                    <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                      <span data-testid={`text-error-${idx}`}>{error}</span>
                    </li>
                  ))}
                </ul>
                {shopifyValidation?.lastChecked && (
                  <p className="text-xs text-muted-foreground">
                    Last checked: {formatDistanceToNow(new Date(shopifyValidation.lastChecked), { addSuffix: true })}
                  </p>
                )}
              </div>
            )}
            <div className="pt-3 border-t">
              <Button
                onClick={() => setShowReregisterDialog(true)}
                variant="outline"
                size="sm"
                className="w-full"
                data-testid="button-reregister-webhooks"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Re-register Webhooks
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Use this after rotating your Shopify API secret to update webhook signatures
              </p>
            </div>

            {/* Webhooks List Section */}
            <div className="pt-3 border-t space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Registered Webhooks</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/operations/shopify-webhooks"] })}
                  data-testid="button-refresh-webhooks"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              {webhooksLoading ? (
                <p className="text-sm text-muted-foreground">Loading webhooks...</p>
              ) : webhooksData?.webhooks && webhooksData.webhooks.length > 0 ? (
                <div className="space-y-2">
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[30%]">Topic</TableHead>
                          <TableHead className="w-[45%]">Address</TableHead>
                          <TableHead className="w-[15%]">Created</TableHead>
                          <TableHead className="w-[10%]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {webhooksData.webhooks.map((webhook) => (
                          <TableRow key={webhook.id} data-testid={`row-webhook-${webhook.id}`}>
                            <TableCell className="font-mono text-xs" data-testid={`text-topic-${webhook.id}`}>
                              {webhook.topic}
                            </TableCell>
                            <TableCell className="text-xs truncate max-w-[200px]" title={webhook.address} data-testid={`text-address-${webhook.id}`}>
                              {webhook.address}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground" data-testid={`text-created-${webhook.id}`}>
                              {formatDistanceToNow(new Date(webhook.created_at), { addSuffix: true })}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setWebhookToDelete(webhook)}
                                data-testid={`button-delete-webhook-${webhook.id}`}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Total: {webhooksData.webhooks.length} webhook(s)
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No webhooks registered</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-shipstation-webhooks">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="h-5 w-5" />
            ShipStation Webhooks
          </CardTitle>
          <CardDescription>Registered webhooks for shipment tracking</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              {shipStationWebhooksLoading ? (
                <p className="text-sm text-muted-foreground">Loading webhooks...</p>
              ) : shipStationWebhooksData && shipStationWebhooksData.webhooks.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Registered Webhooks</h3>
                  </div>
                  <div className="border rounded-md">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[25%]">Name</TableHead>
                          <TableHead className="w-[20%]">Event</TableHead>
                          <TableHead className="w-[45%]">URL</TableHead>
                          <TableHead className="w-[10%]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shipStationWebhooksData.webhooks.map((webhook) => (
                          <TableRow key={webhook.webhook_id} data-testid={`row-shipstation-webhook-${webhook.webhook_id}`}>
                            <TableCell className="text-xs" data-testid={`text-name-${webhook.webhook_id}`}>
                              {webhook.name}
                            </TableCell>
                            <TableCell className="font-mono text-xs" data-testid={`text-event-${webhook.webhook_id}`}>
                              {webhook.event}
                            </TableCell>
                            <TableCell className="text-xs truncate max-w-[200px]" title={webhook.url} data-testid={`text-url-${webhook.webhook_id}`}>
                              {webhook.url}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShipStationWebhookToDelete(webhook)}
                                data-testid={`button-delete-shipstation-webhook-${webhook.webhook_id}`}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Total: {shipStationWebhooksData.webhooks.length} webhook(s)
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No webhooks registered</p>
              )}
            </div>
            <div className="pt-4 border-t">
              <Button
                onClick={() => setShowShipStationReregisterDialog(true)}
                variant="outline"
                size="sm"
                className="w-full"
                data-testid="button-reregister-shipstation-webhooks"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Re-register Webhooks
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Re-register ShipStation webhooks for shipment and tracking updates
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-environment">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Environment Configuration
          </CardTitle>
          <CardDescription>Verify system configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">Cache Server</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {envLoading ? "Loading..." : envInfo?.redis.host || "Not configured"}
                </p>
              </div>
              <Badge variant={envInfo?.redis.configured ? "default" : "destructive"} data-testid="badge-redis-status">
                {envInfo?.redis.configured ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertCircle className="h-3 w-3 mr-1" />}
                {envInfo?.redis.configured ? "Connected" : "Not configured"}
              </Badge>
            </div>
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">Webhook Base URL</p>
                <p className="text-sm text-muted-foreground font-mono break-all">
                  {envLoading ? "Loading..." : envInfo?.webhooks.baseUrl || "Not configured"}
                </p>
              </div>
              <Badge variant="outline" data-testid="badge-environment">
                {envInfo?.webhooks.environment || "unknown"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {(() => {
        const displayJob = queueStats?.backfill?.activeJob || queueStats?.backfill?.recentJobs?.[0];
        if (!displayJob) return null;
        
        const isActive = displayJob.status === "running" || displayJob.status === "pending";
        
        return (
          <Card data-testid="card-backfill-status">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Database className="h-5 w-5" />
                {isActive ? "Active Backfill Job" : "Most Recent Backfill Job"}
              </CardTitle>
              <CardDescription>
                {isActive ? "Historical order backfill in progress" : "Last completed backfill"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Date Range</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(displayJob.startDate).toLocaleDateString()} - {new Date(displayJob.endDate).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge 
                    variant={
                      displayJob.status === "running" ? "default" : 
                      displayJob.status === "completed" ? "default" :
                      displayJob.status === "failed" ? "destructive" :
                      displayJob.status === "cancelled" ? "secondary" :
                      "secondary"
                    }
                    data-testid="badge-backfill-status"
                  >
                    {displayJob.status === "running" && <RefreshCw className="h-3 w-3 mr-1 animate-spin" />}
                    {displayJob.status === "pending" && <Clock className="h-3 w-3 mr-1" />}
                    {displayJob.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {displayJob.status === "failed" && <XCircle className="h-3 w-3 mr-1" />}
                    {displayJob.status}
                  </Badge>
                </div>
                
                {/* Shopify Orders Progress */}
                {displayJob.shopifyOrdersTotal > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Shopify Orders</span>
                      <span className="font-medium">
                        {displayJob.shopifyOrdersImported.toLocaleString()} / {displayJob.shopifyOrdersTotal.toLocaleString()}
                        {(displayJob.shopifyOrdersFailed ?? 0) > 0 && (
                          <span className="text-destructive ml-1">
                            ({displayJob.shopifyOrdersFailed} failed)
                          </span>
                        )}
                      </span>
                    </div>
                    <Progress 
                      value={displayJob.shopifyOrdersTotal > 0 ? (displayJob.shopifyOrdersImported / displayJob.shopifyOrdersTotal) * 100 : 0}
                      data-testid="progress-backfill-shopify"
                    />
                  </div>
                )}
                
                {/* ShipStation Shipments Progress */}
                {displayJob.shipstationShipmentsTotal > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">ShipStation Shipments</span>
                      <span className="font-medium">
                        {displayJob.shipstationShipmentsImported.toLocaleString()} / {displayJob.shipstationShipmentsTotal.toLocaleString()}
                        {(displayJob.shipstationShipmentsFailed ?? 0) > 0 && (
                          <span className="text-destructive ml-1">
                            ({displayJob.shipstationShipmentsFailed} failed)
                          </span>
                        )}
                      </span>
                    </div>
                    <Progress 
                      value={displayJob.shipstationShipmentsTotal > 0 ? (displayJob.shipstationShipmentsImported / displayJob.shipstationShipmentsTotal) * 100 : 0}
                      data-testid="progress-backfill-shipstation"
                    />
                  </div>
                )}
                
                {/* Job Controls */}
                <div className="flex gap-2 pt-2">
                  {(displayJob.status === "running" || displayJob.status === "pending") && (
                    <BackfillCancelButton jobId={displayJob.id} />
                  )}
                  {(displayJob.status === "failed" || displayJob.status === "completed") && (
                    <BackfillRestartButton jobId={displayJob.id} />
                  )}
                  {displayJob.errorMessage && (
                    <div className="w-full rounded-md bg-destructive/10 p-3">
                      <p className="text-sm font-medium text-destructive">Error:</p>
                      <p className="text-sm text-muted-foreground">{displayJob.errorMessage}</p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* All Backfill Jobs List */}
      <Card data-testid="card-all-backfill-jobs">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="h-5 w-5" />
            All Backfill Jobs
          </CardTitle>
          <CardDescription>
            View and manage all historical backfill jobs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {backfillJobsLoading ? (
            <div className="text-center py-4 text-muted-foreground">Loading jobs...</div>
          ) : !allBackfillJobs || allBackfillJobs.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground">No backfill jobs found</div>
          ) : (
            <div className="space-y-2">
              {allBackfillJobs.map((job) => (
                <div 
                  key={job.id} 
                  className="flex items-center justify-between p-3 rounded-md border"
                  data-testid={`job-item-${job.id}`}
                >
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge 
                        variant={
                          job.status === "running" ? "default" : 
                          job.status === "completed" ? "default" :
                          job.status === "failed" ? "destructive" :
                          job.status === "cancelled" ? "secondary" :
                          "secondary"
                        }
                        data-testid={`badge-job-status-${job.id}`}
                      >
                        {job.status === "running" && <RefreshCw className="h-3 w-3 mr-1 animate-spin" />}
                        {job.status === "pending" && <Clock className="h-3 w-3 mr-1" />}
                        {job.status === "completed" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                        {job.status === "failed" && <XCircle className="h-3 w-3 mr-1" />}
                        {job.status}
                      </Badge>
                      <span className="font-medium text-sm">
                        {new Date(job.startDate).toLocaleDateString()} - {new Date(job.endDate).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>Shopify: {job.shopifyOrdersImported}/{job.shopifyOrdersTotal}</span>
                      <span>ShipStation: {job.shipstationShipmentsImported}/{job.shipstationShipmentsTotal}</span>
                      {job.startedAt && (
                        <span>Started: {new Date(job.startedAt).toLocaleString()}</span>
                      )}
                      {job.completedAt && (
                        <span>Completed: {new Date(job.completedAt).toLocaleString()}</span>
                      )}
                    </div>
                    {job.errorMessage && (
                      <div className="text-xs text-destructive mt-1">
                        Error: {job.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 ml-4">
                    {(job.status === "running" || job.status === "pending") && (
                      <BackfillCancelButton jobId={job.id} />
                    )}
                    {(job.status === "failed" || job.status === "completed" || job.status === "cancelled") && (
                      <>
                        <BackfillRestartButton jobId={job.id} />
                        <BackfillDeleteButton jobId={job.id} />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-clear-order-data" className="border-destructive">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2 text-destructive">
            <Database className="h-5 w-5" />
            Clear All Order Data
          </CardTitle>
          <CardDescription>Permanently delete all orders, items, shipments, and refunds</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="rounded-md bg-destructive/10 p-3 space-y-2">
              <p className="text-sm font-medium text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Danger Zone
              </p>
              <p className="text-sm text-muted-foreground">
                This will permanently delete all data from the following tables:
              </p>
              <ul className="list-disc list-inside text-sm text-muted-foreground ml-2">
                <li>Orders</li>
                <li>Order Items</li>
                <li>Shipments</li>
                <li>Order Refunds</li>
              </ul>
              <p className="text-sm font-semibold text-destructive">
                This action cannot be undone!
              </p>
            </div>
            <Button
              data-testid="button-clear-order-data"
              variant="destructive"
              size="sm"
              onClick={() => setShowClearOrderDataDialog(true)}
              className="w-full"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All Order Data
            </Button>
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
              {purgeAction === "shopify-order-sync" && "This will permanently delete all messages in the Shopify order sync queue. This action cannot be undone."}
              {purgeAction === "failures" && "This will permanently delete all failure records. This action cannot be undone."}
              {purgeAction === "shopify-order-sync-failures" && "This will permanently delete all Shopify order sync failure records. This action cannot be undone."}
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

      <AlertDialog open={showReregisterDialog} onOpenChange={setShowReregisterDialog}>
        <AlertDialogContent data-testid="dialog-reregister-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-register Shopify Webhooks</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                This will create <strong>new</strong> webhooks with your current API secret, then delete the old ones.
                Use this after rotating your SHOPIFY_API_SECRET to fix signature verification.
              </p>
              <div className="rounded-md bg-muted p-3 space-y-1 text-sm">
                <p className="font-medium">Safety Features:</p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>New webhooks registered BEFORE deleting old ones</li>
                  <li>If registration fails, old webhooks stay active</li>
                  <li>Automatic rollback on errors</li>
                </ul>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong>Note:</strong> Check server logs if this fails. You may need to verify Shopify API permissions or manually manage webhooks in Shopify admin.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reregister">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-reregister"
              onClick={() => reregisterWebhooksMutation.mutate()}
              disabled={reregisterWebhooksMutation.isPending}
            >
              {reregisterWebhooksMutation.isPending ? "Re-registering..." : "Re-register Webhooks"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showShipStationReregisterDialog} onOpenChange={setShowShipStationReregisterDialog}>
        <AlertDialogContent data-testid="dialog-reregister-shipstation-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-register ShipStation Webhooks</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                This will register all available ShipStation webhooks including:
              </p>
              <div className="rounded-md bg-muted p-3 space-y-1 text-sm">
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li><strong>fulfillment_shipped_v2</strong> - Shipment shipped events</li>
                  <li><strong>fulfillment_rejected_v2</strong> - Fulfillment rejections</li>
                  <li><strong>track</strong> - Tracking updates</li>
                  <li><strong>batch</strong> - Batch operations</li>
                </ul>
              </div>
              <p className="text-sm text-muted-foreground">
                <strong>Note:</strong> Existing webhooks for your environment will be preserved if already registered. On-hold status changes are tracked via the background polling worker.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reregister-shipstation">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-reregister-shipstation"
              onClick={() => reregisterShipStationWebhooksMutation.mutate()}
              disabled={reregisterShipStationWebhooksMutation.isPending}
            >
              {reregisterShipStationWebhooksMutation.isPending ? "Re-registering..." : "Re-register Webhooks"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!webhookToDelete} onOpenChange={() => setWebhookToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-webhook-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Webhook</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Are you sure you want to delete this webhook?
              </p>
              {webhookToDelete && (
                <div className="rounded-md bg-muted p-3 space-y-1 text-sm font-mono">
                  <p><strong>Topic:</strong> {webhookToDelete.topic}</p>
                  <p className="text-xs break-all"><strong>Address:</strong> {webhookToDelete.address}</p>
                </div>
              )}
              <p className="text-sm text-destructive">
                <strong>Warning:</strong> This action cannot be undone. Shopify will stop sending webhooks for this topic.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-webhook">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-webhook"
              onClick={() => webhookToDelete && deleteWebhookMutation.mutate(webhookToDelete.id)}
              disabled={deleteWebhookMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteWebhookMutation.isPending ? "Deleting..." : "Delete Webhook"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!shipStationWebhookToDelete} onOpenChange={() => setShipStationWebhookToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-shipstation-webhook-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete ShipStation Webhook</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Are you sure you want to delete this webhook?
              </p>
              {shipStationWebhookToDelete && (
                <div className="rounded-md bg-muted p-3 space-y-1 text-sm font-mono">
                  <p><strong>Name:</strong> {shipStationWebhookToDelete.name}</p>
                  <p><strong>Event:</strong> {shipStationWebhookToDelete.event}</p>
                  <p className="text-xs break-all"><strong>URL:</strong> {shipStationWebhookToDelete.url}</p>
                </div>
              )}
              <p className="text-sm text-destructive">
                <strong>Warning:</strong> This action cannot be undone. ShipStation will stop sending webhooks for this event.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-shipstation-webhook">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-shipstation-webhook"
              onClick={() => shipStationWebhookToDelete && deleteShipStationWebhookMutation.mutate(shipStationWebhookToDelete.webhook_id)}
              disabled={deleteShipStationWebhookMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteShipStationWebhookMutation.isPending ? "Deleting..." : "Delete Webhook"}
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
                          <div className="pt-2">
                            <Button
                              onClick={() => copyFailureForAI(failure)}
                              variant="outline"
                              size="sm"
                              className="w-full"
                              data-testid={`button-copy-ai-${failure.id}`}
                            >
                              <Copy className="h-4 w-4 mr-2" />
                              Copy for AI Analysis
                            </Button>
                          </div>
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

      <Dialog open={showShopifyOrderSyncFailuresDialog} onOpenChange={setShowShopifyOrderSyncFailuresDialog}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-shopify-order-sync-failures">
          <DialogHeader>
            <DialogTitle>Shopify Order Sync Failures</DialogTitle>
            <DialogDescription>
              Orders that failed to import from Shopify after multiple attempts
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                data-testid="input-search-shopify-order-sync-failures"
                placeholder="Search by order number or error message..."
                value={shopifyOrderSyncSearchTerm}
                onChange={(e) => {
                  setShopifyOrderSyncSearchTerm(e.target.value);
                  setShopifyOrderSyncCurrentPage(1);
                }}
                className="flex-1"
              />
            </div>

            {shopifyOrderSyncFailuresData && shopifyOrderSyncFailuresData.failures.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-no-shopify-order-sync-failures">
                No failures found
              </div>
            ) : (
              <div className="space-y-2">
                {shopifyOrderSyncFailuresData?.failures.map((failure) => (
                  <Collapsible
                    key={failure.id}
                    open={expandedFailure === failure.id}
                    onOpenChange={(open) => setExpandedFailure(open ? failure.id : null)}
                  >
                    <Card data-testid={`card-shopify-order-sync-failure-${failure.id}`}>
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
                              <pre className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded overflow-x-auto">
                                {JSON.stringify(JSON.parse(failure.requestData), null, 2)}
                              </pre>
                            </div>
                          )}
                          {failure.responseData && (
                            <div>
                              <p className="text-sm font-medium mb-1">Response Data</p>
                              <pre className="text-xs text-muted-foreground font-mono bg-muted p-2 rounded overflow-x-auto">
                                {JSON.stringify(JSON.parse(failure.responseData), null, 2)}
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

            {shopifyOrderSyncFailuresData && shopifyOrderSyncFailuresData.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  data-testid="button-prev-shopify-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setShopifyOrderSyncCurrentPage(p => Math.max(1, p - 1))}
                  disabled={shopifyOrderSyncCurrentPage === 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground" data-testid="text-shopify-page-info">
                  Page {shopifyOrderSyncCurrentPage} of {shopifyOrderSyncFailuresData.totalPages}
                </span>
                <Button
                  data-testid="button-next-shopify-page"
                  variant="outline"
                  size="sm"
                  onClick={() => setShopifyOrderSyncCurrentPage(p => Math.min(shopifyOrderSyncFailuresData.totalPages, p + 1))}
                  disabled={shopifyOrderSyncCurrentPage === shopifyOrderSyncFailuresData.totalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showClearOrderDataDialog} onOpenChange={setShowClearOrderDataDialog}>
        <AlertDialogContent data-testid="dialog-clear-order-data-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Clear All Order Data?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                This will <strong className="text-destructive">permanently delete</strong> all data from the following tables:
              </p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><strong>Orders</strong> - All order records</li>
                <li><strong>Order Items</strong> - All line item details</li>
                <li><strong>Shipments</strong> - All shipping information</li>
                <li><strong>Order Refunds</strong> - All refund records</li>
              </ul>
              <div className="rounded-md bg-destructive/10 p-3 border border-destructive">
                <p className="text-sm font-semibold text-destructive flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  WARNING: This action cannot be undone!
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  All historical order data will be permanently lost.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-clear-order-data">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => clearOrderDataMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-clear-order-data"
              disabled={clearOrderDataMutation.isPending}
            >
              {clearOrderDataMutation.isPending ? "Clearing..." : "Clear All Order Data"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
