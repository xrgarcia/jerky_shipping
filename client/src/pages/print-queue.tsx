import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { format, differenceInSeconds } from "date-fns";
import { Printer, Check, Clock, AlertCircle, RefreshCw, XCircle, AlertTriangle, ChevronUp, ChevronDown, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type PrintJob = {
  id: string;
  orderId: string | null;
  orderNumber: string;
  stationId: string;
  stationName: string;
  shipmentId: string | null;
  jobType: string;
  status: "pending" | "sent" | "printing" | "completed" | "failed" | "cancelled";
  labelUrl: string | null;
  trackingNumber: string | null;
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
  queuedAt: string;
  sentAt: string | null;
  printedAt: string | null;
  createdAt: string;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
};

type PrintQueueResponse = {
  jobs: PrintJob[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type SortField = "createdAt" | "status" | "stationName" | "orderNumber";
type SortOrder = "asc" | "desc";

export default function PrintQueuePage() {
  const { toast } = useToast();
  
  // Filter and pagination state
  const [myJobsOnly, setMyJobsOnly] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortField>("createdAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1); // Reset to first page on search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [myJobsOnly, statusFilter, sortBy, sortOrder, pageSize]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=home`;
      
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'print_queue_update') {
            queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
            
            if (data.data.type === 'job_added') {
              toast({
                title: "New print job",
                description: "A new label has been added to the print queue.",
              });
            } else if (data.data.type === 'job_completed' || data.data.status === 'completed') {
              toast({
                title: "Print completed",
                description: "Label has been successfully printed.",
              });
            } else if (data.data.type === 'job_updated' && data.data.status === 'failed') {
              toast({
                title: "Print failed",
                description: data.data.errorMessage || "Label printing failed.",
                variant: "destructive",
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
          return;
        }
        
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
      }
    };
  }, [toast]);

  // Build query params
  const queryParams = new URLSearchParams();
  if (myJobsOnly) queryParams.set("myJobs", "true");
  if (debouncedSearch) queryParams.set("search", debouncedSearch);
  if (statusFilter && statusFilter !== "all") queryParams.set("status", statusFilter);
  queryParams.set("sortBy", sortBy);
  queryParams.set("sortOrder", sortOrder);
  queryParams.set("page", page.toString());
  queryParams.set("limit", pageSize.toString());

  const { data: jobsData, isLoading } = useQuery<PrintQueueResponse>({
    queryKey: ["/api/print-queue", queryParams.toString()],
    queryFn: async () => {
      const response = await fetch(`/api/print-queue?${queryParams.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Failed to fetch print queue");
      }
      return response.json();
    },
    refetchInterval: 5000,
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/desktop/print-jobs/${jobId}/retry`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to retry job");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
      toast({
        title: "Job retrying",
        description: "Print job has been queued for retry.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to retry job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const markCompleteMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/print-queue/${jobId}/complete`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to mark as complete");
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
      if (data.success) {
        toast({
          title: "Print job completed",
          description: "Label has been marked as printed.",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to complete print job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const jobs = jobsData?.jobs || [];
  const totalPages = jobsData?.totalPages || 1;
  const total = jobsData?.total || 0;

  // Staleness thresholds (in seconds)
  const WARNING_THRESHOLD = 35;
  const CRITICAL_THRESHOLD = 60;

  // Calculate job age and health status
  const getJobHealth = (job: PrintJob): { ageSeconds: number; healthStatus: 'healthy' | 'warning' | 'critical' } | null => {
    if (!['pending', 'sent', 'printing'].includes(job.status)) {
      return null; // Terminal states don't have health status
    }
    
    const now = Date.now();
    let ageSeconds: number;
    
    if (job.status === 'pending') {
      ageSeconds = differenceInSeconds(now, new Date(job.createdAt));
    } else {
      // For 'sent' and 'printing', use sentAt if available
      ageSeconds = job.sentAt 
        ? differenceInSeconds(now, new Date(job.sentAt))
        : differenceInSeconds(now, new Date(job.createdAt));
    }
    
    let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (ageSeconds >= CRITICAL_THRESHOLD) {
      healthStatus = 'critical';
    } else if (ageSeconds >= WARNING_THRESHOLD) {
      healthStatus = 'warning';
    }
    
    return { ageSeconds, healthStatus };
  };

  const getHealthBadge = (job: PrintJob) => {
    const health = getJobHealth(job);
    if (!health || health.healthStatus === 'healthy') {
      return null;
    }
    
    if (health.healthStatus === 'warning') {
      return (
        <Badge 
          variant="outline" 
          className="ml-1 bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800"
          data-testid={`badge-health-warning-${job.id}`}
        >
          <AlertTriangle className="h-3 w-3 mr-1" />
          {health.ageSeconds}s
        </Badge>
      );
    }
    
    return (
      <Badge 
        variant="destructive" 
        className="ml-1"
        data-testid={`badge-health-critical-${job.id}`}
      >
        <AlertCircle className="h-3 w-3 mr-1" />
        {health.ageSeconds}s
      </Badge>
    );
  };

  const getStatusBadge = (job: PrintJob) => {
    switch (job.status) {
      case "pending":
        return <Badge data-testid={`badge-status-pending`} variant="outline">Pending</Badge>;
      case "sent":
        return <Badge data-testid={`badge-status-sent`} variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Sent</Badge>;
      case "printing":
        return <Badge data-testid={`badge-status-printing`} variant="default">Printing</Badge>;
      case "completed":
        return <Badge data-testid={`badge-status-completed`} variant="secondary" className="bg-green-50 text-green-700 border-green-200">Completed</Badge>;
      case "failed":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge data-testid={`badge-status-failed`} variant="destructive" className="cursor-help">
                <AlertCircle className="h-3 w-3 mr-1" />
                Failed ({job.attempts}/{job.maxAttempts})
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{job.errorMessage || "Unknown error"}</p>
            </TooltipContent>
          </Tooltip>
        );
      case "cancelled":
        return <Badge data-testid={`badge-status-cancelled`} variant="outline" className="text-muted-foreground">Cancelled</Badge>;
      default:
        return <Badge data-testid={`badge-status-unknown`} variant="outline">{job.status}</Badge>;
    }
  };

  // Sortable header component
  const SortableHeader = ({ field, label }: { field: SortField; label: string }) => {
    const isActive = sortBy === field;
    const handleSort = () => {
      if (isActive) {
        setSortOrder(sortOrder === "asc" ? "desc" : "asc");
      } else {
        setSortBy(field);
        setSortOrder("desc");
      }
    };

    return (
      <TableHead 
        className="cursor-pointer hover-elevate select-none"
        onClick={handleSort}
        data-testid={`table-header-${field}`}
      >
        <div className="flex items-center gap-1">
          {label}
          {isActive && (
            sortOrder === "asc" 
              ? <ChevronUp className="h-4 w-4" />
              : <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </TableHead>
    );
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Print Queue</h1>
          <p className="text-muted-foreground" data-testid="text-page-description">
            Desktop print jobs for shipping labels
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle data-testid="text-active-jobs-title">Print Jobs</CardTitle>
              <CardDescription data-testid="text-active-jobs-description">
                {total > 0 ? `${total} total jobs` : "No jobs found"}
              </CardDescription>
            </div>
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-4 pt-4">
            {/* My Jobs Only Checkbox */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="myJobsOnly"
                checked={myJobsOnly}
                onCheckedChange={(checked) => setMyJobsOnly(checked === true)}
                data-testid="checkbox-my-jobs"
              />
              <label 
                htmlFor="myJobsOnly" 
                className="text-sm font-medium cursor-pointer"
                data-testid="label-my-jobs"
              >
                My print jobs
              </label>
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[200px] max-w-[300px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search order number..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                data-testid="input-search"
              />
            </div>

            {/* Status Filter */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="printing">Printing</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>

            {/* Page Size */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Show</span>
              <Select value={pageSize.toString()} onValueChange={(v) => setPageSize(parseInt(v))}>
                <SelectTrigger className="w-[70px]" data-testid="select-page-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8" data-testid="loading-print-jobs">
              <Clock className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="empty-print-queue">
              <Printer className="h-12 w-12 text-muted-foreground mb-3" />
              <p className="text-lg font-medium" data-testid="text-no-jobs">No print jobs</p>
              <p className="text-sm text-muted-foreground" data-testid="text-no-jobs-description">
                {debouncedSearch || statusFilter !== "all" 
                  ? "Try adjusting your filters" 
                  : "Print jobs will appear here when packing is completed"}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader field="orderNumber" label="Order" />
                    <SortableHeader field="stationName" label="Station" />
                    <TableHead data-testid="table-header-tracking">Tracking</TableHead>
                    <SortableHeader field="status" label="Status" />
                    <TableHead data-testid="table-header-requested-by">Requested By</TableHead>
                    <SortableHeader field="createdAt" label="Queued At" />
                    <TableHead data-testid="table-header-printed">Printed At</TableHead>
                    <TableHead data-testid="table-header-actions">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id} data-testid={`row-print-job-${job.id}`}>
                      <TableCell data-testid={`text-order-${job.id}`}>
                        <span className="font-medium">{job.orderNumber || job.orderId || '-'}</span>
                      </TableCell>
                      <TableCell data-testid={`text-station-${job.id}`}>
                        {job.stationName}
                      </TableCell>
                      <TableCell data-testid={`text-tracking-${job.id}`}>
                        <span className="font-mono text-sm">{job.trackingNumber || '-'}</span>
                      </TableCell>
                      <TableCell data-testid={`status-${job.id}`}>
                        <div className="flex items-center">
                          {getStatusBadge(job)}
                          {getHealthBadge(job)}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-requested-by-${job.id}`}>
                        {job.requestedByName ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">{job.requestedByName}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{job.requestedByEmail}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-queued-at-${job.id}`}>
                        {job.queuedAt ? format(new Date(job.queuedAt), "MMM d, h:mm a") : "-"}
                      </TableCell>
                      <TableCell data-testid={`text-printed-at-${job.id}`}>
                        {job.printedAt ? format(new Date(job.printedAt), "MMM d, h:mm a") : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          {job.status === "failed" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => retryMutation.mutate(job.id)}
                              disabled={retryMutation.isPending}
                              data-testid={`button-retry-${job.id}`}
                            >
                              <RefreshCw className="h-4 w-4 mr-1" />
                              Retry
                            </Button>
                          )}
                          {(job.status === "pending" || job.status === "sent") && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => markCompleteMutation.mutate(job.id)}
                              disabled={markCompleteMutation.isPending}
                              data-testid={`button-mark-complete-${job.id}`}
                            >
                              <Check className="h-4 w-4 mr-1" />
                              Mark Complete
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-2 pt-4 border-t mt-4">
                  <div className="text-sm text-muted-foreground" data-testid="text-pagination-info">
                    Page {page} of {totalPages} ({total} total)
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(1)}
                      disabled={page === 1}
                      data-testid="button-first-page"
                    >
                      First
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(page - 1)}
                      disabled={page === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(page + 1)}
                      disabled={page === totalPages}
                      data-testid="button-next-page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(totalPages)}
                      disabled={page === totalPages}
                      data-testid="button-last-page"
                    >
                      Last
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
