import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Clock } from "lucide-react";
import { format } from "date-fns";
import printJS from "print-js";

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
  const processingJobsRef = useRef<Set<string>>(new Set());
  const failedJobsRef = useRef<Set<string>>(new Set());

  const { data: jobsData } = useQuery<{ jobs: PrintJob[] }>({
    queryKey: ["/api/print-queue"],
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (jobsData?.jobs) {
      const keysToRemove: string[] = [];
      
      printedJobsRef.current.forEach(id => {
        const job = jobsData.jobs.find(j => j.id === id);
        if (!job) {
          keysToRemove.push(id);
        }
      });
      
      keysToRemove.forEach(id => {
        printedJobsRef.current.delete(id);
        failedJobsRef.current.delete(id);
      });
      
      const processingKeysToRemove: string[] = [];
      processingJobsRef.current.forEach(id => {
        const job = jobsData.jobs.find(j => j.id === id);
        if (!job) {
          processingKeysToRemove.push(id);
        } else if (job.status === "printing") {
          processingKeysToRemove.push(id);
          printedJobsRef.current.add(id);
        }
      });
      
      processingKeysToRemove.forEach(id => processingJobsRef.current.delete(id));
    }
  }, [jobsData]);

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
      (job) => job.status === "queued" && 
               job.labelUrl &&
               !printedJobsRef.current.has(job.id) && 
               !processingJobsRef.current.has(job.id) &&
               !failedJobsRef.current.has(job.id)
    );

    queuedJobs.forEach(async (job) => {
      processingJobsRef.current.add(job.id);
      printedJobsRef.current.add(job.id);
      
      try {
        printJS({
          printable: job.labelUrl,
          type: 'pdf',
          showModal: false,
          onPrintDialogClose: async () => {
            try {
              await markCompleteMutation.mutateAsync(job.id);
              processingJobsRef.current.delete(job.id);
              
              toast({
                title: "Label printed",
                description: `Label for order #${job.orderId} sent to printer.`,
              });
            } catch (error) {
              console.error("Failed to mark print job complete:", error);
              processingJobsRef.current.delete(job.id);
              failedJobsRef.current.add(job.id);
              
              toast({
                title: "Print job error",
                description: `Print dialog closed but failed to update status. Please check order #${job.orderId}.`,
                variant: "destructive",
              });
            }
          },
          onError: (error: Error) => {
            console.error('Print.js error:', error);
            processingJobsRef.current.delete(job.id);
            failedJobsRef.current.add(job.id);
            
            toast({
              title: "Print failed",
              description: `Failed to print label for order #${job.orderId}. Please try manually from the order details.`,
              variant: "destructive",
            });
          }
        });
      } catch (error) {
        console.error("Failed to initiate print job:", error);
        processingJobsRef.current.delete(job.id);
        failedJobsRef.current.add(job.id);
        
        toast({
          title: "Print initialization failed",
          description: `Could not start printing for order #${job.orderId}. Please try manually.`,
          variant: "destructive",
        });
      }
    });
  }, [jobsData, markCompleteMutation, toast]);

  const jobs = jobsData?.jobs || [];
  const activeJobs = jobs.filter(j => j.status === "queued");

  if (activeJobs.length === 0) {
    return null;
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued":
        return <Badge variant="default" data-testid={`badge-status-queued`}>Queued</Badge>;
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
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
