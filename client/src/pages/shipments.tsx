import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Truck, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, Order } from "@shared/schema";

interface ShipmentWithOrder extends Shipment {
  order: Order | null;
}

export default function Shipments() {
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();

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
        toast({
          title: "Connection error",
          description: "Please refresh the page and log in again.",
          variant: "destructive",
        });
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'order_update' && data.order) {
            queryClient.invalidateQueries({ queryKey: ["/api/shipments"] });
            toast({
              title: `Order ${data.order.orderNumber} updated`,
              description: `Shipment tracking information updated for ${data.order.customerName}`,
            });
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
          console.error('WebSocket failed to connect - auth may have failed');
          toast({
            title: "Connection lost",
            description: "Please refresh the page and log in again.",
            variant: "destructive",
          });
          return;
        }
        
        if (event.code === 1008 || event.code === 1011) {
          console.error('WebSocket auth failed - please log in again');
          toast({
            title: "Connection lost",
            description: "Please refresh the page and log in again.",
            variant: "destructive",
          });
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

  const { data: shipmentsData, isLoading } = useQuery<{ shipments: ShipmentWithOrder[] }>({
    queryKey: ["/api/shipments", searchQuery],
    queryFn: async () => {
      const url = searchQuery
        ? `/api/shipments?q=${encodeURIComponent(searchQuery)}`
        : "/api/shipments";
      return fetch(url, { credentials: "include" }).then((res) => res.json());
    },
  });

  const shipments = shipmentsData?.shipments || [];

  const getStatusBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline">Unknown</Badge>;
    }
    if (status === "delivered") {
      return <Badge className="bg-green-600 text-white">Delivered</Badge>;
    }
    if (status === "shipped") {
      return <Badge className="bg-blue-600 text-white">Shipped</Badge>;
    }
    if (status === "cancelled") {
      return <Badge className="bg-red-600 text-white">Cancelled</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Shipments</h1>
        <p className="text-muted-foreground text-lg">
          Track all shipments • Real-time carrier updates
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              data-testid="input-search-shipments"
              type="search"
              placeholder="Search by tracking number, carrier, order number, or customer name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-14 text-lg"
            />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-center py-12">
          <Truck className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
          <p className="text-muted-foreground text-lg">Loading shipments...</p>
        </div>
      ) : shipments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Truck className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-xl font-semibold mb-2">No shipments found</h3>
            <p className="text-muted-foreground">
              {searchQuery
                ? "Try a different search term"
                : "Shipments will appear here when orders are fulfilled through ShipStation"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {shipments.map((shipment) => (
            <Link 
              key={shipment.id} 
              href={shipment.order ? `/orders/${shipment.order.id}` : "#"}
            >
              <Card 
                className="hover-elevate active-elevate-2 cursor-pointer"
                data-testid={`card-shipment-${shipment.id}`}
              >
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-3">
                        <Truck className="h-6 w-6 text-muted-foreground" />
                        <CardTitle className="text-2xl font-mono font-bold">
                          {shipment.trackingNumber || "No tracking"}
                        </CardTitle>
                      </div>
                      {shipment.order && (
                        <div className="space-y-1">
                          <p className="text-xl font-semibold text-foreground">
                            Order #{shipment.order.orderNumber}
                          </p>
                          <p className="text-lg text-muted-foreground">
                            {shipment.order.customerName}
                          </p>
                        </div>
                      )}
                      <div className="flex items-center gap-4 mt-3 text-lg text-muted-foreground">
                        {shipment.carrierCode && (
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4" />
                            <span className="font-semibold uppercase">{shipment.carrierCode}</span>
                          </div>
                        )}
                        {shipment.shipDate && (
                          <span>
                            {new Date(shipment.shipDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {getStatusBadge(shipment.status)}
                      {shipment.serviceCode && (
                        <p className="text-sm text-muted-foreground">
                          {shipment.serviceCode}
                        </p>
                      )}
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
