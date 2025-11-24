import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Clock, Printer, X, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { useEffect, useRef, useState, useCallback } from "react";

interface PrintJob {
  id: string;
  orderId: string;
  labelUrl: string;
  status: "queued" | "printing" | "printed";
  queuedAt: string;
  printedAt: string | null;
}

export function PrintQueueBar() {
  const { toast } = useToast();
  const isPrintingRef = useRef<boolean>(false);

  const { data: jobsData } = useQuery<{ jobs: PrintJob[] }>({
    queryKey: ["/api/print-queue"],
    refetchInterval: 2000,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
      toast({
        title: "Label complete",
        description: "Print job marked as complete.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to complete print job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handlePrintNow = (job: PrintJob) => {
    const proxyUrl = `/api/labels/proxy?url=${encodeURIComponent(job.labelUrl)}`;
    window.open(proxyUrl, '_blank');
  };

  const handleMarkComplete = (jobId: string) => {
    markCompleteMutation.mutate(jobId);
  };

  const jobs = jobsData?.jobs || [];
  const activeJobs = jobs.filter(j => j.status === "queued" || j.status === "printing");

  // Auto-print effect - triggers ONCE when a job has labelUrl and is still 'queued'
  // Uses server-side status as source of truth to prevent duplicate triggers
  useEffect(() => {
    // Guard: prevent multiple concurrent print attempts
    if (isPrintingRef.current) {
      return;
    }

    // Only trigger for jobs that are QUEUED with a labelUrl
    // Once we mark it as 'printing' on the server, it won't match this filter anymore
    const jobsNeedingPrint = activeJobs.filter(
      job => job.labelUrl && job.status === 'queued'
    );

    if (jobsNeedingPrint.length > 0) {
      const jobToPrint = jobsNeedingPrint[0];
      autoPrintLabel(jobToPrint);
    }
  }, [activeJobs]);

  const autoPrintLabel = useCallback(async (job: PrintJob) => {
    // Double-check guard
    if (isPrintingRef.current) {
      return;
    }

    // Mark as printing immediately to prevent re-entry
    isPrintingRef.current = true;

    try {
      // FIRST: Mark as printing on the server to prevent re-triggers
      // Use fetch directly since apiRequest throws on non-2xx
      const markResponse = await fetch(`/api/print-queue/${job.id}/printing`, {
        method: 'POST',
        credentials: 'include',
      });
      
      // Invalidate query cache regardless of response to get fresh status
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
      
      if (!markResponse.ok) {
        // Already in printing status or error - don't re-open the label
        isPrintingRef.current = false;
        return;
      }

      // Open PDF in new tab - browsers block automatic print() for security
      const proxyUrl = `/api/labels/proxy?url=${encodeURIComponent(job.labelUrl)}`;
      const printWindow = window.open(proxyUrl, '_blank');
      
      if (printWindow) {
        printWindow.focus();
        toast({
          title: "Label ready to print",
          description: `Order #${job.orderId} - Press Ctrl+P (or Cmd+P on Mac) to print. Click "Done" when finished.`,
          duration: 10000,
        });
      } else {
        toast({
          title: "Pop-up blocked",
          description: "Please allow pop-ups for this site, then click 'Print Now'",
          variant: "destructive",
          duration: 6000,
        });
      }
    } catch (error) {
      console.error('Auto-print error:', error);
      toast({
        title: "Failed to open label",
        description: "Click 'Print Now' to try again",
        variant: "destructive",
      });
    } finally {
      // Allow next print after a delay
      setTimeout(() => {
        isPrintingRef.current = false;
      }, 3000);
    }
  }, [toast]);

  if (activeJobs.length === 0) {
    return null;
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued":
        return <Badge variant="default" data-testid={`badge-status-queued`}>Ready</Badge>;
      case "printing":
        return <Badge variant="secondary" data-testid={`badge-status-printing`}>Printing</Badge>;
      default:
        return null;
    }
  };

  return (
    <div 
      className="absolute bottom-0 left-0 right-0 bg-card border-t border-border shadow-lg z-50"
      data-testid="container-print-queue-bar"
    >
      <div className="px-4 py-3">
        <div className="flex items-center gap-4 overflow-x-auto">
          <div className="flex-shrink-0 font-semibold text-sm">
            Print Queue ({activeJobs.length})
          </div>
          <div className="flex gap-3 overflow-x-auto">
            {activeJobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center gap-2 px-3 py-1.5 bg-background rounded-md border border-border flex-shrink-0"
                data-testid={`job-${job.id}`}
              >
                <span className="font-medium text-sm" data-testid={`text-order-${job.orderId}`}>
                  #{job.orderId}
                </span>
                {getStatusBadge(job.status)}
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  <span data-testid={`text-time-${job.id}`}>
                    {format(new Date(job.queuedAt), "HH:mm:ss")}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => handlePrintNow(job)}
                  data-testid={`button-print-${job.id}`}
                >
                  <Printer className="w-3 h-3 mr-1" />
                  Print Now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleMarkComplete(job.id)}
                  disabled={markCompleteMutation.isPending}
                  data-testid={`button-done-${job.id}`}
                >
                  <X className="w-3 h-3 mr-1" />
                  Done
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
