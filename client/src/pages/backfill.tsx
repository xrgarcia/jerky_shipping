import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Loader2, RotateCw, Trash2, Database } from "lucide-react";
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
  createdAt: string;
  updatedAt: string;
};

export default function BackfillPage() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobToDelete, setJobToDelete] = useState<string | null>(null);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);
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
    refetchInterval: 2000,
  });

  const { data: shipmentSyncStatusData } = useQuery<{ queueLength: number; failureCount: number }>({
    queryKey: ["/api/shipment-sync/status"],
    refetchInterval: 2000,
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

  const purgeQueueMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/queue/clear");
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to purge queue");
      }
      return response.json();
    },
    onSuccess: (data: any) => {
      setShowPurgeDialog(false);
      queryClient.invalidateQueries({ queryKey: ["/api/webhooks/queue-status"] });
      toast({
        title: "Queue purged",
        description: `Cleared ${data.clearedCount} items from the queue.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to purge queue",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold mb-2" data-testid="heading-backfill">Order Backfill</h1>
          <p className="text-muted-foreground text-lg">
            Import historical orders from Shopify by date range
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-sm text-muted-foreground">Webhook Queue</div>
            <div className="text-2xl font-bold" data-testid="text-queue-length">
              {queueStatusData?.queueLength?.toLocaleString() ?? '...'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted-foreground">Shipment Sync Queue</div>
            <div className="text-2xl font-bold" data-testid="text-shipment-sync-queue-length">
              {shipmentSyncStatusData?.queueLength?.toLocaleString() ?? '...'}
            </div>
            {shipmentSyncStatusData && shipmentSyncStatusData.failureCount > 0 && (
              <div className="text-sm text-destructive mt-1">
                {shipmentSyncStatusData.failureCount} failed
              </div>
            )}
          </div>
          <Button
            variant="destructive"
            size="default"
            onClick={() => setShowPurgeDialog(true)}
            data-testid="button-purge-queue"
          >
            <Database className="mr-2 h-4 w-4" />
            Purge Queue
          </Button>
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

              <div className="text-xs text-muted-foreground">
                Started {format(new Date(activeJob.createdAt), "PPpp")}
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
            <AlertDialogTitle>Purge Queue</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to purge the entire processing queue? This will clear all pending webhooks and backfill jobs from the queue. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-purge">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => purgeQueueMutation.mutate()}
              data-testid="button-confirm-purge"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={purgeQueueMutation.isPending}
            >
              {purgeQueueMutation.isPending ? (
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
    </div>
  );
}
