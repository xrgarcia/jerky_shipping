import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { Printer, Check, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

type PrintJob = {
  id: string;
  orderId: string;
  labelUrl: string;
  status: "queued" | "printing" | "printed";
  queuedAt: string;
  printedAt: string | null;
};

export default function PrintQueuePage() {
  const { toast } = useToast();
  const printedJobsRef = useRef<Set<string>>(new Set());

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
            } else if (data.data.type === 'job_completed') {
              toast({
                title: "Print completed",
                description: "Label has been successfully printed.",
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

  const { data: jobsData, isLoading } = useQuery<{ jobs: PrintJob[] }>({
    queryKey: ["/api/print-queue"],
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (jobsData?.jobs) {
      const keysToRemove: string[] = [];
      
      printedJobsRef.current.forEach(id => {
        const job = jobsData.jobs.find(j => j.id === id);
        if (!job || job.status !== "printing") {
          keysToRemove.push(id);
        }
      });
      
      keysToRemove.forEach(id => printedJobsRef.current.delete(id));
    }
  }, [jobsData]);

  const markPrintingMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const response = await apiRequest("POST", `/api/print-queue/${jobId}/printing`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to mark as printing");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
    },
    onError: (error: Error, variables: string) => {
      printedJobsRef.current.delete(variables);
      toast({
        title: "Failed to start printing",
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

  useEffect(() => {
    if (!jobsData?.jobs) return;

    const queuedJobs = jobsData.jobs.filter(
      (job) => job.status === "queued" && !printedJobsRef.current.has(job.id)
    );

    queuedJobs.forEach(async (job) => {
      try {
        await markPrintingMutation.mutateAsync(job.id);
        
        printedJobsRef.current.add(job.id);
        
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.src = job.labelUrl;
        document.body.appendChild(iframe);

        iframe.onload = () => {
          setTimeout(() => {
            try {
              iframe.contentWindow?.print();
              
              setTimeout(() => {
                markCompleteMutation.mutate(job.id);
                document.body.removeChild(iframe);
              }, 1000);
            } catch (error) {
              console.error("Error printing:", error);
              toast({
                title: "Print failed",
                description: "Failed to print label. Please try again.",
                variant: "destructive",
              });
              setTimeout(() => {
                document.body.removeChild(iframe);
              }, 500);
            }
          }, 500);
        };

        iframe.onerror = () => {
          console.error("Error loading label PDF");
          toast({
            title: "Failed to load label",
            description: "Could not load the label PDF.",
            variant: "destructive",
          });
          setTimeout(() => {
            document.body.removeChild(iframe);
          }, 500);
        };
      } catch (error) {
        console.error("Failed to mark as printing:", error);
      }
    });
  }, [jobsData, markCompleteMutation, markPrintingMutation, toast]);

  const jobs = jobsData?.jobs || [];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued":
        return <Badge data-testid={`badge-status-queued`} variant="outline">Queued</Badge>;
      case "printing":
        return <Badge data-testid={`badge-status-printing`} variant="default">Printing</Badge>;
      case "printed":
        return <Badge data-testid={`badge-status-printed`} variant="secondary">Printed</Badge>;
      default:
        return <Badge data-testid={`badge-status-unknown`} variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Print Queue</h1>
          <p className="text-muted-foreground" data-testid="text-page-description">
            Auto-print labels from active warehouse print jobs
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle data-testid="text-active-jobs-title">Active Print Jobs</CardTitle>
          <CardDescription data-testid="text-active-jobs-description">
            Labels will automatically print when added to the queue
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8" data-testid="loading-print-jobs">
              <Clock className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="empty-print-queue">
              <Printer className="h-12 w-12 text-muted-foreground mb-3" />
              <p className="text-lg font-medium" data-testid="text-no-jobs">No print jobs in queue</p>
              <p className="text-sm text-muted-foreground" data-testid="text-no-jobs-description">
                Labels will appear here when created from order details
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead data-testid="table-header-order">Order ID</TableHead>
                  <TableHead data-testid="table-header-status">Status</TableHead>
                  <TableHead data-testid="table-header-queued">Queued At</TableHead>
                  <TableHead data-testid="table-header-printed">Printed At</TableHead>
                  <TableHead data-testid="table-header-actions">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id} data-testid={`row-print-job-${job.id}`}>
                    <TableCell data-testid={`text-order-id-${job.id}`}>{job.orderId}</TableCell>
                    <TableCell data-testid={`status-${job.id}`}>{getStatusBadge(job.status)}</TableCell>
                    <TableCell data-testid={`text-queued-at-${job.id}`}>
                      {format(new Date(job.queuedAt), "PPp")}
                    </TableCell>
                    <TableCell data-testid={`text-printed-at-${job.id}`}>
                      {job.printedAt ? format(new Date(job.printedAt), "PPp") : "-"}
                    </TableCell>
                    <TableCell>
                      {job.status !== "printed" && (
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
