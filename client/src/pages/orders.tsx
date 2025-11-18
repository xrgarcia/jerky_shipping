import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Package, Clock, Truck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import type { Order } from "@shared/schema";

type OrderWithShipment = Order & { hasShipment?: boolean };

export default function Orders() {
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        if (isMounted) {
          toast({
            title: "Connection error",
            description: "Please refresh the page and log in again.",
            variant: "destructive",
          });
        }
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
            queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
            if (isMounted) {
              toast({
                title: "Order updated",
                description: `Order #${data.order.orderNumber} has been updated.`,
              });
            }
          } else if (data.type === 'print_queue_update') {
            queryClient.invalidateQueries({ queryKey: ["/api/print-queue"] });
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
          if (isMounted) {
            toast({
              title: "Connection lost",
              description: "Please refresh the page and log in again.",
              variant: "destructive",
            });
          }
          return;
        }
        
        if (event.code === 1008 || event.code === 1011) {
          console.error('WebSocket auth failed - please log in again');
          if (isMounted) {
            toast({
              title: "Connection lost",
              description: "Please refresh the page and log in again.",
              variant: "destructive",
            });
          }
          return;
        }
        
        if (isMounted) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
          reconnectAttempts++;
          reconnectTimeout = setTimeout(connect, delay);
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
  }, [toast]);

  const { data: ordersData, isLoading } = useQuery<{ orders: OrderWithShipment[] }>({
    queryKey: ["/api/orders", searchQuery],
    queryFn: async () => {
      const url = searchQuery
        ? `/api/orders?q=${encodeURIComponent(searchQuery)}`
        : "/api/orders";
      return fetch(url, { credentials: "include" }).then((res) => res.json());
    },
  });

  const orders = ordersData?.orders || [];

  const getFulfillmentBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline">Unfulfilled</Badge>;
    }
    if (status === "fulfilled") {
      return <Badge className="bg-green-600 text-white">Fulfilled</Badge>;
    }
    return <Badge variant="secondary">{status}</Badge>;
  };

  return (
    <>
      <div className="max-w-7xl mx-auto p-6 space-y-6 pb-32">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Orders</h1>
          <p className="text-muted-foreground text-lg">
            Search and manage warehouse fulfillment • Real-time updates
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                data-testid="input-search-orders"
                type="search"
                placeholder="Search by order number, customer name, or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 h-14 text-lg"
              />
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="text-center py-12">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
            <p className="text-muted-foreground text-lg">Loading orders...</p>
          </div>
        ) : orders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Package className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No orders found</h3>
              <p className="text-muted-foreground">
                {searchQuery
                  ? "Try a different search term"
                  : "Orders will appear here automatically when they come in from Shopify"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {orders.map((order) => (
              <Link key={order.id} href={`/orders/${order.id}`}>
                <Card className="hover-elevate active-elevate-2 cursor-pointer">
                  <CardHeader className="pb-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-3xl font-mono font-bold mb-2">
                          #{order.orderNumber}
                        </CardTitle>
                        <p className="text-2xl font-semibold text-foreground truncate">
                          {order.customerName}
                        </p>
                        <p className="text-lg text-muted-foreground mt-1">
                          {new Date(order.createdAt).toLocaleString()} •{" "}
                          {Array.isArray(order.lineItems) ? order.lineItems.length : 0} items
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {getFulfillmentBadge(order.fulfillmentStatus)}
                        {order.hasShipment ? (
                          <Badge className="bg-blue-600 text-white gap-1" data-testid={`badge-shipment-${order.id}`}>
                            <Truck className="h-3 w-3" />
                            ShipStation
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="gap-1" data-testid={`badge-no-shipment-${order.id}`}>
                            <Truck className="h-3 w-3" />
                            No Shipment
                          </Badge>
                        )}
                        <Badge variant="outline" className="gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(order.createdAt), { addSuffix: true })}
                        </Badge>
                        <p className="text-xl font-bold text-foreground">
                          ${order.totalPrice}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
