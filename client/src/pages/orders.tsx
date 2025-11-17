import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, RefreshCw, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Order } from "@shared/schema";

export default function Orders() {
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();

  const { data: ordersData, isLoading } = useQuery<{ orders: Order[] }>({
    queryKey: ["/api/orders", searchQuery],
    queryFn: async () => {
      const url = searchQuery
        ? `/api/orders?q=${encodeURIComponent(searchQuery)}`
        : "/api/orders";
      return fetch(url, { credentials: "include" }).then((res) => res.json());
    },
  });

  const syncOrdersMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/orders/sync", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to sync");
      return res.json();
    },
    onSuccess: (data: { count: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      toast({
        title: "Orders synced",
        description: `Successfully synced ${data.count} orders from Shopify.`,
      });
    },
    onError: () => {
      toast({
        title: "Sync failed",
        description: "Failed to sync orders from Shopify.",
        variant: "destructive",
      });
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
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Orders</h1>
          <p className="text-muted-foreground text-lg">
            Search and manage warehouse fulfillment
          </p>
        </div>
        <Button
          data-testid="button-sync-orders"
          onClick={() => syncOrdersMutation.mutate()}
          disabled={syncOrdersMutation.isPending}
          size="lg"
        >
          <RefreshCw className={`mr-2 h-5 w-5 ${syncOrdersMutation.isPending ? "animate-spin" : ""}`} />
          {syncOrdersMutation.isPending ? "Syncing..." : "Sync Orders"}
        </Button>
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
            <p className="text-muted-foreground mb-6">
              {searchQuery
                ? "Try a different search term"
                : "Sync orders from Shopify to get started"}
            </p>
            {!searchQuery && (
              <Button
                data-testid="button-sync-orders-empty"
                onClick={() => syncOrdersMutation.mutate()}
                disabled={syncOrdersMutation.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync Orders
              </Button>
            )}
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
                        {new Date(order.createdAt).toLocaleDateString()} •{" "}
                        {Array.isArray(order.lineItems) ? order.lineItems.length : 0} items
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {getFulfillmentBadge(order.fulfillmentStatus)}
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
  );
}
