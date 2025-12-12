import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Loader2, Database, RefreshCw, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
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
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  shopifyOrdersTotal: number;
  shopifyOrdersImported: number;
  shopifyOrdersFailed?: number;
  shipstationShipmentsTotal: number;
  shipstationShipmentsImported: number;
  shipstationShipmentsFailed?: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type QueueStats = {
  backfill?: {
    activeJob: BackfillJob | null;
    recentJobs: BackfillJob[];
  };
};

export default function BackfillPage() {
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const { toast } = useToast();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      startDate: new Date(new Date().setDate(new Date().getDate() - 7)),
      endDate: new Date(),
    },
  });

  // WebSocket connection for real-time backfill updates
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;
    let isMounted = true;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=backfill`;
      
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected (Backfill)');
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === 'queue_status' && message.data.backfill) {
            setQueueStats({
              backfill: message.data.backfill,
            });
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
    onSuccess: () => {
      form.reset();
      toast({
        title: "Backfill started",
        description: "Historical data import has been initiated.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot start backfill",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: FormData) => {
    startBackfillMutation.mutate(data);
  };

  const displayJob = queueStats?.backfill?.activeJob || queueStats?.backfill?.recentJobs?.[0];
  const isActive = displayJob && (displayJob.status === "running" || displayJob.status === "pending");

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold mb-2" data-testid="heading-backfill">Order Backfill</h1>
          <p className="text-muted-foreground text-lg">
            Import historical orders and shipments from Shopify and ShipStation by date range
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Start New Backfill</CardTitle>
            <CardDescription>
              Select a date range to import orders and shipments
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
                  disabled={startBackfillMutation.isPending || isActive}
                  data-testid="button-start-backfill"
                >
                  {startBackfillMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {isActive ? "Backfill In Progress..." : "Start Backfill"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {displayJob && (
          <Card data-testid="card-backfill-status">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Database className="h-5 w-5" />
                {isActive ? "Active Backfill Job" : "Most Recent Backfill Job"}
              </CardTitle>
              <CardDescription>
                {isActive ? "Historical data import in progress" : "Last completed backfill"}
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

                {displayJob.errorMessage && (
                  <div className="rounded-md bg-destructive/10 p-3">
                    <p className="text-sm text-destructive font-medium">Error</p>
                    <p className="text-sm text-muted-foreground mt-1">{displayJob.errorMessage}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
