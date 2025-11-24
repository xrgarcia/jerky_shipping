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
  const printedJobsRef = useRef<Set<string>>(new Set());
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
    // Remove from printed jobs set when manually marked complete
    printedJobsRef.current.delete(jobId);
  };

  const jobs = jobsData?.jobs || [];
  const activeJobs = jobs.filter(j => j.status === "queued" || j.status === "printing");

  // Auto-print effect - triggers when a job gets a labelUrl
  useEffect(() => {
    // Guard: prevent multiple concurrent print attempts
    if (isPrintingRef.current) {
      return;
    }

    const jobsNeedingPrint = activeJobs.filter(
      job => job.labelUrl && 
             job.status === 'queued' && 
             !printedJobsRef.current.has(job.id)
    );

    if (jobsNeedingPrint.length > 0) {
      const jobToPrint = jobsNeedingPrint[0]; // Print one at a time
      autoPrintLabel(jobToPrint);
    }
  }, [activeJobs]);

  const autoPrintLabel = useCallback((job: PrintJob) => {
    // Double-check guards
    if (isPrintingRef.current || printedJobsRef.current.has(job.id)) {
      return;
    }

    // Mark as printing immediately to prevent re-entry
    isPrintingRef.current = true;
    printedJobsRef.current.add(job.id);

    try {
      // Open PDF in new tab - simple and reliable
      const proxyUrl = `/api/labels/proxy?url=${encodeURIComponent(job.labelUrl)}`;
      const printWindow = window.open(proxyUrl, '_blank');
      
      if (printWindow) {
        toast({
          title: "Label opened for printing",
          description: `Order #${job.orderId} - Use Ctrl+P or browser print button. Click "Done" when finished.`,
          duration: 8000,
        });
      } else {
        // Pop-up blocked
        printedJobsRef.current.delete(job.id);
        toast({
          title: "Pop-up blocked",
          description: "Please allow pop-ups for this site, then click 'Print Now'",
          variant: "destructive",
          duration: 6000,
        });
      }
    } catch (error) {
      console.error('Auto-print error:', error);
      printedJobsRef.current.delete(job.id);
      
      toast({
        title: "Failed to open label",
        description: "Click 'Print Now' to try again",
        variant: "destructive",
      });
    } finally {
      // Allow next print after a delay
      setTimeout(() => {
        isPrintingRef.current = false;
      }, 2000);
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
