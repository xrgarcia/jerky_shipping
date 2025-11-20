import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { Fragment } from "react";
import { Calendar as CalendarIcon, Loader2, RotateCw, Trash2, Database, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  startDate: z.date({
    required_error: "Start date is required",
  }),
  endDate: z.date({
    required_error: "End date is required",
  }),
}).refine((data) => data.startDate <= data.endDate, {
  message: "End date must be after start date",
  path: ["endDate"],
});

type FormData = z.infer<typeof formSchema>;

type BackfillJob = {
  id: string;
  startDate: string;
  endDate: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  totalOrders: number;
  processedOrders: number;
  failedOrders: number;
  errorMessage: string | null;
  lastActivityAt: string | null;
  currentStage: string | null;
  currentOrderIndex: number | null;
  errorLog: Array<{
    orderNumber: string;
    orderIndex: number;
    error: string;
    timestamp: string;
  }> | null;
  createdAt: string;
  updatedAt: string;
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

export default function BackfillPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobToDelete, setJobToDelete] = useState<string | null>(null);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);
  const [showFailuresDialog, setShowFailuresDialog] = useState(false);
  const [shopifyQueueLength, setShopifyQueueLength] = useState<number>(0);
  const [shipmentSyncQueueLength, setShipmentSyncQueueLength] = useState<number>(0);
  const [shipmentFailureCount, setShipmentFailureCount] = useState<number>(0);
  const { toast } = useToast();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      startDate: new Date(new Date().setDate(new Date().getDate() - 7)),
      endDate: new Date(),
    },
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery<{ jobs: BackfillJob[] }>({
    queryKey: ["/api/backfill/jobs"],
    refetchInterval: 2000,
  });

  const { data: queueStatusData } = useQuery<{ queueLength: number }>({
    queryKey: ["/api/webhooks/queue-status"],
  });

  const { data: shipmentSyncStatusData } = useQuery<{ queueLength: number; failureCount: number }>({
    queryKey: ["/api/shipment-sync/status"],
  });

  const { data: selectedJobData } = useQuery<{ job: BackfillJob }>({
    queryKey: ["/api/backfill/jobs", selectedJobId],
    enabled: !!selectedJobId,
    refetchInterval: (query) => {
      const job = query.state.data?.job;
      return job && job.status === "in_progress" ? 2000 : false;
    },
  });

  const startBackfillMutation = useMutation({
    mutationFn: async (data: FormData) => {
      const response = await apiRequest("POST", "/api/backfill/start", {
        startDate: data.startDate.toISOString(),
        endDate: data.endDate.toISOString(),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to start backfill");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      setSelectedJobId(data.job.id);
      form.reset();
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot start backfill",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("DELETE", `/api/backfill/jobs/${jobId}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      setJobToDelete(null);
      toast({
        title: "Job deleted",
        description: "Backfill job has been deleted successfully.",
      });
    },
  });

  const restartJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/backfill/jobs/${jobId}/restart`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to restart backfill");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      setSelectedJobId(data.job.id);
      toast({
        title: "Job restarted",
        description: "Backfill job has been restarted with the same date range.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot restart job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const cancelJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/backfill/jobs/${jobId}/cancel`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to cancel backfill");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backfill/jobs"] });
      toast({
        title: "Job cancelled",
        description: "Backfill job has been cancelled successfully.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot cancel job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const purgeShopifyQueueMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/queue/clear");
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to purge Shopify queue");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      setShowPurgeDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/webhooks/queue-status"] });
      toast({
        title: "Shopify queue purged",
        description: `Cleared ${data.clearedCount} items from the Shopify queue.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to purge Shopify queue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const purgeShipmentSyncQueueMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/shipment-sync/clear");
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to purge shipment sync queue");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/shipment-sync/status"] });
      toast({
        title: "Shipment sync queue purged",
        description: `Cleared ${data.clearedCount} items from the shipment sync queue.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to purge shipment sync queue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Initialize queue counts from API on mount
  useEffect(() => {
    if (queueStatusData) {
      setShopifyQueueLength(queueStatusData.queueLength);
    }
  }, [queueStatusData]);

  useEffect(() => {
    if (shipmentSyncStatusData) {
      setShipmentSyncQueueLength(shipmentSyncStatusData.queueLength);
      setShipmentFailureCount(shipmentSyncStatusData.failureCount);
    }
  }, [shipmentSyncStatusData]);

  // WebSocket connection for real-time queue updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;
    let isMounted = true;

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
        console.log('WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'queue_status') {
            setShopifyQueueLength(message.data.shopifyQueue);
            setShipmentSyncQueueLength(message.data.shipmentSyncQueue);
            setShipmentFailureCount(message.data.shipmentFailureCount);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (isMounted) {
          reconnectTimeout = setTimeout(connect, 3000);
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

  const onSubmit = (data: FormData) => {
    startBackfillMutation.mutate(data);
  };

  const handleDeleteClick = (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    setJobToDelete(jobId);
  };

  const confirmDelete = () => {
    if (jobToDelete) {
      deleteJobMutation.mutate(jobToDelete);
    }
  };

  const handleRestart = (e: React.MouseEvent, jobId: string) => {
    e.stopPropagation();
    restartJobMutation.mutate(jobId);
  };

  const jobs = jobsData?.jobs || [];
  const activeJob = jobs.find((j) => j.status === "in_progress") || selectedJobData?.job;

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      pending: "secondary",
      in_progress: "default",
      completed: "outline",
      failed: "destructive",
    };
    return (
      <Badge variant={variants[status] || "default"} data-testid={`badge-status-${status}`}>
        {status.replace("_", " ").toUpperCase()}
      </Badge>
    );
  };

  const getProgressPercentage = (job: BackfillJob) => {
    if (job.totalOrders === 0) return 0;
    return Math.round((job.processedOrders / job.totalOrders) * 100);
  };

  const getLastActivityText = (lastActivityAt: string | null) => {
    if (!lastActivityAt) return null;
    
    const now = Date.now();
    const activityTime = new Date(lastActivityAt).getTime();
    const seconds = Math.floor((now - activityTime) / 1000);
    
    if (seconds < 10) return "Active now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 120) return "1m ago";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    
    return `${Math.floor(seconds / 3600)}h ago`;
  };

  const getStageName = (stage: string | null) => {
    if (!stage) return null;
    
    const stageNames: Record<string, string> = {
      fetching_orders: "Fetching orders from Shopify",
      storing_orders: "Storing orders in database",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    
    return stageNames[stage] || stage;
  };

  const isJobStuck = (job: BackfillJob) => {
    if (job.status !== "in_progress") return false;
    if (!job.lastActivityAt) return false;
    
    const now = Date.now();
    const activityTime = new Date(job.lastActivityAt).getTime();
    const seconds = Math.floor((now - activityTime) / 1000);
    
    // Consider stuck if no activity for 60+ seconds
    return seconds > 60;
  };

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold mb-2" data-testid="heading-backfill">Order Backfill</h1>
          <p className="text-muted-foreground text-lg">
            Import historical orders from Shopify by date range
          </p>
        </div>
        <div className="flex items-start gap-6">
          <div className="flex flex-col items-center gap-2">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">Shopify Queue</div>
              <div className="text-2xl font-bold" data-testid="text-queue-length">
                {shopifyQueueLength.toLocaleString()}
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowPurgeDialog(true)}
              data-testid="button-purge-shopify-queue"
            >
              <Database className="mr-2 h-4 w-4" />
              Purge
            </Button>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">Shipment Sync Queue</div>
              <div className="text-2xl font-bold" data-testid="text-shipment-sync-queue-length">
                {shipmentSyncQueueLength.toLocaleString()}
              </div>
              {shipmentFailureCount > 0 && (
                <button 
                  onClick={() => setShowFailuresDialog(true)}
                  className="text-sm text-destructive hover:underline cursor-pointer"
                  data-testid="button-view-failures"
                >
                  {shipmentFailureCount} failed
                </button>
              )}
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => purgeShipmentSyncQueueMutation.mutate()}
              disabled={purgeShipmentSyncQueueMutation.isPending}
              data-testid="button-purge-shipment-sync-queue"
            >
              {purgeShipmentSyncQueueMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Purging...
                </>
              ) : (
                <>
                  <Database className="mr-2 h-4 w-4" />
                  Purge
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Start New Backfill</CardTitle>
            <CardDescription>
              Select a date range to import orders from Shopify
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>Start Date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !field.value && "text-muted-foreground"
                              )}
                              data-testid="button-start-date"
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {field.value ? format(field.value, "PPP") : "Pick a date"}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={field.value}
                            onSelect={(date) => {
                              if (date) {
                                field.onChange(date);
                              }
                            }}
                            initialFocus
                            data-testid="calendar-start-date"
                          />
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>End Date</FormLabel>
                      <Popover>
                        <PopoverTrigger asChild>
                          <FormControl>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !field.value && "text-muted-foreground"
                              )}
                              data-testid="button-end-date"
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {field.value ? format(field.value, "PPP") : "Pick a date"}
                            </Button>
                          </FormControl>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={field.value}
                            onSelect={(date) => {
                              if (date) {
                                field.onChange(date);
                              }
                            }}
                            initialFocus
                            data-testid="calendar-end-date"
                          />
                        </PopoverContent>
                      </Popover>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  className="w-full"
                  disabled={startBackfillMutation.isPending}
                  data-testid="button-start-backfill"
                >
                  {startBackfillMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Start Backfill
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {activeJob && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Active Job
                {getStatusBadge(activeJob.status)}
              </CardTitle>
              <CardDescription>
                {format(new Date(activeJob.startDate), "PPP")} - {format(new Date(activeJob.endDate), "PPP")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Last Activity & Current Stage */}
              {activeJob.status === "in_progress" && (
                <div className="flex flex-col gap-2 text-sm">
                  {activeJob.lastActivityAt && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Last activity:</span>
                      <span className={cn(
                        "font-medium",
                        isJobStuck(activeJob) ? "text-destructive" : "text-foreground"
                      )} data-testid="text-last-activity">
                        {getLastActivityText(activeJob.lastActivityAt)}
                        {isJobStuck(activeJob) && (
                          <AlertCircle className="inline ml-1 h-4 w-4" />
                        )}
                      </span>
                    </div>
                  )}
                  {activeJob.currentStage && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Current stage:</span>
                      <span className="font-medium" data-testid="text-current-stage">
                        {getStageName(activeJob.currentStage)}
                      </span>
                    </div>
                  )}
                  {activeJob.currentOrderIndex && activeJob.totalOrders > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Processing:</span>
                      <span className="font-medium" data-testid="text-current-order">
                        Order {activeJob.currentOrderIndex} of {activeJob.totalOrders}
                      </span>
                    </div>
                  )}
                  {isJobStuck(activeJob) && (
                    <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-md">
                      <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
                      <div className="text-sm text-destructive">
                        <div className="font-medium">Job may be stuck</div>
                        <div className="text-xs mt-1">
                          No activity detected for over 60 seconds. Consider cancelling and restarting.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span>Progress</span>
                  <span className="font-medium" data-testid="text-progress">
                    {activeJob.processedOrders} / {activeJob.totalOrders} orders
                  </span>
                </div>
                <Progress value={getProgressPercentage(activeJob)} data-testid="progress-bar" />
                <div className="text-xs text-muted-foreground mt-1">
                  {getProgressPercentage(activeJob)}% complete
                </div>
              </div>

              {activeJob.failedOrders > 0 && (
                <div className="text-sm">
                  <span className="text-destructive font-medium" data-testid="text-failed-orders">
                    {activeJob.failedOrders} failed
                  </span>
                </div>
              )}

              {activeJob.errorMessage && (
                <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md" data-testid="text-error-message">
                  {activeJob.errorMessage}
                </div>
              )}

              {/* Error Log Viewer */}
              {activeJob.errorLog && activeJob.errorLog.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="w-full justify-between" data-testid="button-toggle-error-log">
                      <span className="text-destructive">View error log ({activeJob.errorLog.length} errors)</span>
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 max-h-64 overflow-y-auto border rounded-md">
                      <div className="divide-y">
                        {activeJob.errorLog.map((error, idx) => (
                          <div key={idx} className="p-3 text-sm" data-testid={`error-log-${idx}`}>
                            <div className="flex justify-between items-start mb-1">
                              <span className="font-medium">Order {error.orderNumber}</span>
                              <span className="text-xs text-muted-foreground">
                                {format(new Date(error.timestamp), "HH:mm:ss")}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">Index: {error.orderIndex}</div>
                            <div className="text-xs text-destructive mt-1">{error.error}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t">
                <div className="text-xs text-muted-foreground">
                  Started {format(new Date(activeJob.createdAt), "PPpp")}
                </div>
                {(activeJob.status === "in_progress" || activeJob.status === "pending") && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => cancelJobMutation.mutate(activeJob.id)}
                    disabled={cancelJobMutation.isPending}
                    data-testid="button-cancel-job"
                  >
                    {cancelJobMutation.isPending ? "Cancelling..." : "Cancel Job"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Backfill History</CardTitle>
          <CardDescription>
            Previous and ongoing backfill jobs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No backfill jobs yet. Start one above.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date Range</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="w-24">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow
                    key={job.id}
                    className="cursor-pointer hover-elevate"
                    onClick={() => setSelectedJobId(job.id)}
                    data-testid={`row-job-${job.id}`}
                  >
                    <TableCell>
                      <div className="text-sm">
                        {format(new Date(job.startDate), "PP")} - {format(new Date(job.endDate), "PP")}
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(job.status)}</TableCell>
                    <TableCell>
                      <div className="w-24">
                        <Progress value={getProgressPercentage(job)} className="h-2" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {job.processedOrders} / {job.totalOrders}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-muted-foreground">
                        {format(new Date(job.createdAt), "PP p")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={(e) => handleRestart(e, job.id)}
                          disabled={restartJobMutation.isPending}
                          data-testid={`button-restart-${job.id}`}
                          title="Restart with same date range"
                        >
                          <RotateCw className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={(e) => handleDeleteClick(e, job.id)}
                          disabled={deleteJobMutation.isPending}
                          data-testid={`button-delete-${job.id}`}
                          title="Delete job"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!jobToDelete} onOpenChange={(open) => !open && setJobToDelete(null)}>
        <AlertDialogContent data-testid="dialog-delete-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Backfill Job</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this backfill job? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              data-testid="button-confirm-delete"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showPurgeDialog} onOpenChange={setShowPurgeDialog}>
        <AlertDialogContent data-testid="dialog-purge-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>Purge Shopify Queue</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to purge the Shopify queue? This will clear all pending webhooks from the queue. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-purge">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => purgeShopifyQueueMutation.mutate()}
              data-testid="button-confirm-purge"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={purgeShopifyQueueMutation.isPending}
            >
              {purgeShopifyQueueMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Purging...
                </>
              ) : (
                'Purge Queue'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Failures Dialog */}
      <FailuresDialog open={showFailuresDialog} onOpenChange={setShowFailuresDialog} />
    </div>
  );
}

// Failures Dialog Component
function FailuresDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const { data: failuresData, isLoading } = useQuery<{ 
    failures: ShipmentSyncFailure[]; 
    totalCount: number;
    limit: number;
    offset: number;
  }>({
    queryKey: ["/api/shipment-sync/failures"],
    enabled: open,
  });

  const toggleRow = (id: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedRows(newExpanded);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col" data-testid="dialog-failures">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" />
            Shipment Sync Failures
          </DialogTitle>
          <DialogDescription>
            {failuresData?.totalCount ? `${failuresData.totalCount} failed shipment sync attempts` : 'Loading...'}
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : failuresData && failuresData.failures.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead>Order Number</TableHead>
                  <TableHead>Error Message</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Failed At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failuresData.failures.map((failure) => (
                  <Fragment key={failure.id}>
                    <TableRow className="cursor-pointer hover:bg-muted/50" data-testid={`row-failure-${failure.id}`}>
                      <TableCell>
                        <button onClick={() => toggleRow(failure.id)} className="p-1">
                          {expandedRows.has(failure.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="font-mono text-sm" data-testid={`text-order-number-${failure.id}`}>
                        {failure.orderNumber}
                      </TableCell>
                      <TableCell className="max-w-md truncate" data-testid={`text-error-${failure.id}`}>
                        {failure.errorMessage}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{failure.reason}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(failure.failedAt), "MMM d, yyyy h:mm a")}
                      </TableCell>
                    </TableRow>
                    {expandedRows.has(failure.id) && (
                      <TableRow>
                        <TableCell colSpan={5} className="bg-muted/30">
                          <div className="p-4 space-y-4">
                            <div>
                              <div className="font-semibold text-sm mb-1">Full Error Message</div>
                              <div className="text-sm bg-background p-3 rounded border">
                                {failure.errorMessage}
                              </div>
                            </div>
                            
                            {failure.requestData && (
                              <div>
                                <div className="font-semibold text-sm mb-1">Request Data</div>
                                <pre className="text-xs bg-background p-3 rounded border overflow-auto max-h-40">
                                  {JSON.stringify(failure.requestData, null, 2)}
                                </pre>
                              </div>
                            )}
                            
                            {failure.responseData && (
                              <div>
                                <div className="font-semibold text-sm mb-1">Response Data</div>
                                <pre className="text-xs bg-background p-3 rounded border overflow-auto max-h-40">
                                  {JSON.stringify(failure.responseData, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center text-muted-foreground p-8">
              No failures found
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
