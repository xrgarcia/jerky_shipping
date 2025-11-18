import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ArrowLeft, Printer, FileText, Mail, Phone, ChevronLeft, ChevronRight, Search, Truck, Package, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Order, Shipment } from "@shared/schema";

interface LineItem {
  id: number;
  name: string;
  quantity: number;
  price: string;
  sku?: string;
  product_id?: number;
  variant_id?: number;
}

interface ShippingAddress {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
}

export default function OrderDetail() {
  const [, params] = useRoute("/orders/:id");
  const orderId = params?.id;
  const [, navigate] = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const { toast } = useToast();

  const { data: orderData, isLoading } = useQuery<{ order: Order; shipments: Shipment[] }>({
    queryKey: ["/api/orders", orderId],
    enabled: !!orderId,
  });

  const { data: allOrdersData } = useQuery<{ orders: Order[] }>({
    queryKey: ["/api/orders"],
  });

  interface PrintJob {
    id: string;
    orderId: string;
    labelUrl: string | null;
    status: "queued" | "printing" | "printed" | "failed";
    error: string | null;
    queuedAt: string;
    printedAt: string | null;
  }

  const { data: printJobsData } = useQuery<{ printJobs: PrintJob[] }>({
    queryKey: ["/api/orders", orderId, "print-jobs"],
    enabled: !!orderId,
    refetchInterval: 2000,
  });

  const order = orderData?.order;
  const shipments = orderData?.shipments || [];
  const allOrders = allOrdersData?.orders || [];
  const printJobs = printJobsData?.printJobs || [];

  const currentIndex = allOrders.findIndex(o => o.id === orderId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < allOrders.length - 1;

  const handlePrintPackingSlip = () => {
    window.print();
  };

  const createLabelMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const response = await apiRequest("POST", `/api/orders/${orderId}/create-label`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create label");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders", orderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
      toast({
        title: "Label created",
        description: "Shipping label added to print queue. Check the bottom of the Orders page.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create label",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreateLabel = () => {
    if (!orderId) return;
    createLabelMutation.mutate(orderId);
  };

  const handlePrevious = () => {
    if (hasPrev) {
      navigate(`/orders/${allOrders[currentIndex - 1].id}`);
    }
  };

  const handleNext = () => {
    if (hasNext) {
      navigate(`/orders/${allOrders[currentIndex + 1].id}`);
    }
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
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
        console.log('WebSocket connected');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'order_update') {
            if (data.order.id === orderId) {
              queryClient.invalidateQueries({ queryKey: ["/api/orders", orderId] });
              queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
              
              toast({
                title: "Shipment tracking updated",
                description: `Tracking information updated for order #${data.order.orderNumber}`,
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
        
        if (event.code === 1008 || event.code === 1011) {
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
  }, [orderId, toast]);

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <p className="text-lg text-muted-foreground">Loading order...</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <Card>
          <CardContent className="py-12 text-center">
            <h2 className="text-2xl font-semibold mb-2">Order not found</h2>
            <p className="text-muted-foreground mb-6">
              The order you're looking for doesn't exist.
            </p>
            <Link href="/orders">
              <Button>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Orders
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const lineItems = (order.lineItems as LineItem[]) || [];
  const shippingAddress = (order.shippingAddress as ShippingAddress) || {};

  return (
    <>
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput placeholder="Search orders by number or customer name..." />
        <CommandList>
          <CommandEmpty>No orders found.</CommandEmpty>
          <CommandGroup heading="Orders">
            {allOrders.map((o) => (
              <CommandItem
                key={o.id}
                value={`${o.orderNumber} ${o.customerName}`}
                onSelect={() => {
                  navigate(`/orders/${o.id}`);
                  setSearchOpen(false);
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <div>
                    <p className="font-mono font-semibold">#{o.orderNumber}</p>
                    <p className="text-sm text-muted-foreground">{o.customerName}</p>
                  </div>
                  <Badge variant={o.fulfillmentStatus === "fulfilled" ? "default" : "outline"}>
                    {o.fulfillmentStatus || "Unfulfilled"}
                  </Badge>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <div className="print:hidden w-full p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Link href="/orders">
            <Button variant="outline" data-testid="button-back">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Orders
            </Button>
          </Link>
          
          <div className="flex items-center gap-4 flex-1 justify-center">
            <Button
              variant="outline"
              size="lg"
              onClick={handlePrevious}
              disabled={!hasPrev}
              data-testid="button-prev-order"
              className="h-12 px-6"
            >
              <ChevronLeft className="h-6 w-6 mr-2" />
              <span className="text-lg font-semibold">Previous</span>
            </Button>
            
            <Button
              variant="outline"
              size="lg"
              onClick={() => setSearchOpen(true)}
              data-testid="button-search-orders"
              className="h-12 px-6"
            >
              <Search className="h-5 w-5 mr-2" />
              <span className="text-lg">Search Orders</span>
              <kbd className="pointer-events-none ml-3 hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
                <span className="text-xs">⌘</span>K
              </kbd>
            </Button>

            <Button
              variant="outline"
              size="lg"
              onClick={handleNext}
              disabled={!hasNext}
              data-testid="button-next-order"
              className="h-12 px-6"
            >
              <span className="text-lg font-semibold">Next</span>
              <ChevronRight className="h-6 w-6 ml-2" />
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              data-testid="button-print-label"
              onClick={handleCreateLabel}
              variant="outline"
              size="lg"
              disabled={createLabelMutation.isPending}
            >
              <FileText className="mr-2 h-5 w-5" />
              {createLabelMutation.isPending ? "Creating..." : "Create Shipping Label"}
            </Button>
            <Button
              data-testid="button-print-packing-slip"
              onClick={handlePrintPackingSlip}
              size="lg"
            >
              <Printer className="mr-2 h-5 w-5" />
              Print Packing Slip
            </Button>
          </div>
        </div>

        <div>
          <h1 className="text-5xl font-mono font-bold mb-2">#{order.orderNumber}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant={order.fulfillmentStatus === "fulfilled" ? "default" : "outline"}>
              {order.fulfillmentStatus || "Unfulfilled"}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(new Date(order.createdAt), { addSuffix: true })}
            </Badge>
            <span className="text-lg text-muted-foreground">
              {new Date(order.createdAt).toLocaleString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-2">
                <p className="text-3xl font-bold uppercase">{order.customerName}</p>
                {shippingAddress.address1 && (
                  <div className="text-2xl space-y-1">
                    <p>{shippingAddress.address1}</p>
                    {shippingAddress.address2 && <p>{shippingAddress.address2}</p>}
                    <p>
                      {shippingAddress.city}, {shippingAddress.province} {shippingAddress.zip}
                    </p>
                    <p>{shippingAddress.country}</p>
                  </div>
                )}
              </div>
              <div className="space-y-2 pt-2">
                {order.customerEmail && (
                  <div className="flex items-center gap-2 text-lg text-muted-foreground">
                    <Mail className="h-5 w-5" />
                    <span>{order.customerEmail}</span>
                  </div>
                )}
                {order.customerPhone && (
                  <div className="flex items-center gap-2 text-lg text-muted-foreground">
                    <Phone className="h-5 w-5" />
                    <span>{order.customerPhone}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-4">
                {lineItems.map((item) => (
                  <Card key={item.id}>
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <h3 className="text-2xl font-semibold mb-2" data-testid={`text-product-name-${item.id}`}>
                            {item.name}
                          </h3>
                          {item.sku && (
                            <p className="text-lg font-mono text-muted-foreground mb-2">
                              SKU: {item.sku}
                            </p>
                          )}
                          <p className="text-xl text-muted-foreground">
                            ${item.price} each
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="bg-primary text-primary-foreground px-4 py-2 rounded-md">
                            <p className="text-sm font-semibold uppercase tracking-wide">Quantity</p>
                            <p className="text-3xl font-bold" data-testid={`text-quantity-${item.id}`}>
                              {item.quantity}
                            </p>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                <div className="pt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-2xl font-semibold">Total</p>
                    <p className="text-4xl font-bold">${order.totalPrice}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {shipments.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Truck className="h-6 w-6" />
                Shipment Tracking
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {shipments.map((shipment) => (
                  <Card key={shipment.id}>
                    <CardContent className="pt-6">
                      <div className="grid gap-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 space-y-3">
                            {shipment.trackingNumber && (
                              <div>
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                                  Tracking Number
                                </p>
                                <p className="text-2xl font-mono font-bold" data-testid={`text-tracking-${shipment.id}`}>
                                  {shipment.trackingNumber}
                                </p>
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-4">
                              {shipment.carrierCode && (
                                <div>
                                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                                    Carrier
                                  </p>
                                  <p className="text-lg font-semibold uppercase">
                                    {shipment.carrierCode}
                                  </p>
                                </div>
                              )}
                              {shipment.serviceCode && (
                                <div>
                                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                                    Service
                                  </p>
                                  <p className="text-lg">
                                    {shipment.serviceCode}
                                  </p>
                                </div>
                              )}
                            </div>
                            {shipment.shipDate && (
                              <div>
                                <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                                  Ship Date
                                </p>
                                <p className="text-lg">
                                  {new Date(shipment.shipDate).toLocaleDateString("en-US", {
                                    year: "numeric",
                                    month: "long",
                                    day: "numeric",
                                  })}
                                </p>
                              </div>
                            )}
                          </div>
                          <div>
                            <Badge 
                              className={
                                shipment.status === 'delivered' ? 'bg-green-600 text-white' :
                                shipment.status === 'shipped' ? 'bg-blue-600 text-white' :
                                shipment.status === 'cancelled' ? 'bg-red-600 text-white' : ''
                              }
                              data-testid={`badge-status-${shipment.id}`}
                            >
                              {shipment.statusDescription || shipment.status}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {printJobs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl">
                <Printer className="h-6 w-6" />
                Print History ({printJobs.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion type="single" collapsible className="w-full">
                {printJobs.map((job, index) => (
                  <AccordionItem key={job.id} value={`job-${job.id}`}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center justify-between w-full pr-4">
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-semibold">Print Job #{printJobs.length - index}</span>
                          <Badge 
                            variant={
                              job.status === 'printed' ? 'default' :
                              job.status === 'printing' ? 'secondary' :
                              job.status === 'failed' ? 'destructive' : 'outline'
                            }
                            data-testid={`badge-print-status-${job.id}`}
                          >
                            {job.status}
                          </Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(job.queuedAt), { addSuffix: true })}
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="grid gap-3 pt-2 text-base">
                        <div>
                          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                            Queued At
                          </p>
                          <p className="text-lg">
                            {new Date(job.queuedAt).toLocaleString("en-US", {
                              year: "numeric",
                              month: "long",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </p>
                        </div>
                        {job.printedAt && (
                          <div>
                            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                              Printed At
                            </p>
                            <p className="text-lg">
                              {new Date(job.printedAt).toLocaleString("en-US", {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                                hour12: true,
                              })}
                            </p>
                          </div>
                        )}
                        {job.error && (
                          <div>
                            <p className="text-sm font-semibold text-destructive uppercase tracking-wide mb-1">
                              Error
                            </p>
                            <p className="text-lg text-destructive">{job.error}</p>
                          </div>
                        )}
                        {job.labelUrl && (
                          <div>
                            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                              Label
                            </p>
                            <a 
                              href={job.labelUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="text-lg text-primary hover:underline"
                              data-testid={`link-label-${job.id}`}
                            >
                              View Label PDF
                            </a>
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="hidden print:block p-8 bg-white text-black">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">PACKING SLIP</h1>
          <p className="text-2xl">Order #{order.orderNumber}</p>
          <p className="text-lg">
            {new Date(order.createdAt).toLocaleDateString()}
          </p>
        </div>

        <div className="mb-8 border-t-2 border-black pt-4">
          <h2 className="text-2xl font-bold mb-4">SHIP TO:</h2>
          <p className="text-xl font-bold">{order.customerName}</p>
          {shippingAddress.address1 && (
            <div className="text-lg mt-2">
              <p>{shippingAddress.address1}</p>
              {shippingAddress.address2 && <p>{shippingAddress.address2}</p>}
              <p>
                {shippingAddress.city}, {shippingAddress.province} {shippingAddress.zip}
              </p>
              <p>{shippingAddress.country}</p>
            </div>
          )}
        </div>

        <div className="mb-8 border-t-2 border-black pt-4">
          <h2 className="text-2xl font-bold mb-4">ITEMS:</h2>
          <table className="w-full text-lg">
            <thead>
              <tr className="border-b-2 border-black">
                <th className="text-left py-2">Product</th>
                <th className="text-left py-2">SKU</th>
                <th className="text-right py-2">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item) => (
                <tr key={item.id} className="border-b border-gray-300">
                  <td className="py-3">{item.name}</td>
                  <td className="py-3 font-mono">{item.sku || "-"}</td>
                  <td className="py-3 text-right font-bold text-2xl">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t-2 border-black pt-4">
          <p className="text-2xl font-bold">TOTAL: ${order.totalPrice}</p>
        </div>
      </div>
    </>
  );
}
