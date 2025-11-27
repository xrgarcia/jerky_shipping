import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Package, User, ListChecks, MapPin, Loader2 } from "lucide-react";
import { SessionState, parseSessionState } from "@shared/skuvault-types";

const getStatusColor = (status: SessionState | null): string => {
  switch (status) {
    case SessionState.ACTIVE:
      return "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
    case SessionState.READY_TO_SHIP:
      return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20";
    case SessionState.CLOSED:
      return "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20";
    case SessionState.NEW:
      return "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20";
    case SessionState.INACTIVE:
      return "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20";
    case SessionState.PICKED:
      return "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20";
    case SessionState.SHIPPED:
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20";
    case SessionState.CANCELLED:
      return "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";
    default:
      return "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20";
  }
};

const formatStatus = (status: SessionState | null): string => {
  if (!status) return "Unknown";
  
  switch (status) {
    case SessionState.READY_TO_SHIP:
      return "Ready to Ship";
    case SessionState.ACTIVE:
      return "Active";
    case SessionState.CLOSED:
      return "Closed";
    case SessionState.NEW:
      return "New";
    case SessionState.INACTIVE:
      return "Inactive";
    case SessionState.PICKED:
      return "Picked";
    case SessionState.SHIPPED:
      return "Shipped";
    case SessionState.CANCELLED:
      return "Cancelled";
    default:
      return "Unknown";
  }
};

interface SessionDetailDialogProps {
  picklistId: string | null;
  onClose: () => void;
}

export function SessionDetailDialog({ picklistId, onClose }: SessionDetailDialogProps) {
  const { data: sessionDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ["/api/skuvault/sessions", picklistId],
    queryFn: async () => {
      if (!picklistId) throw new Error("No picklist ID selected");
      const response = await fetch(`/api/skuvault/sessions/${picklistId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch session details: ${response.statusText}`);
      }
      return response.json();
    },
    enabled: !!picklistId,
    staleTime: 0,
  });

  return (
    <Dialog open={!!picklistId} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh]" data-testid="dialog-session-details">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Session Details
          </DialogTitle>
          <DialogDescription>
            Picklist: {picklistId}
          </DialogDescription>
        </DialogHeader>
        
        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          {isLoadingDetails ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sessionDetails ? (
            <div className="space-y-6">
              {sessionDetails.picklist && (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold mb-3">Picklist Summary</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Status</div>
                        <Badge className={getStatusColor(parseSessionState(sessionDetails.picklist.state))}>
                          {formatStatus(parseSessionState(sessionDetails.picklist.state))}
                        </Badge>
                      </div>
                      {sessionDetails.picklist.assigned && (
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Assigned To</div>
                          <div className="flex items-center gap-2">
                            <User className="h-3 w-3" />
                            <span className="text-sm font-medium">{sessionDetails.picklist.assigned.name}</span>
                          </div>
                        </div>
                      )}
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Orders</div>
                        <div className="text-lg font-semibold">{sessionDetails.picklist.orderCount || 0}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">SKUs</div>
                        <div className="text-lg font-semibold">{sessionDetails.picklist.skuCount || 0}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Total Quantity</div>
                        <div className="text-lg font-semibold">{sessionDetails.picklist.totalQuantity || 0}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Picked</div>
                        <div className="text-lg font-semibold">{sessionDetails.picklist.pickedQuantity || 0}</div>
                      </div>
                      {sessionDetails.picklist.totalItemsWeight && (
                        <div className="space-y-1">
                          <div className="text-xs text-muted-foreground">Weight</div>
                          <div className="text-lg font-semibold">{sessionDetails.picklist.totalItemsWeight.toFixed(1)} lb</div>
                        </div>
                      )}
                    </div>
                  </div>

                  <Separator />

                  {sessionDetails.picklist.orders && sessionDetails.picklist.orders.length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold mb-3">Orders ({sessionDetails.picklist.orders.length})</h3>
                      <div className="space-y-4">
                        {sessionDetails.picklist.orders.map((order: any, index: number) => (
                          <Card key={order.id || index} data-testid={`card-order-${order.id}`}>
                            <CardHeader className="pb-3">
                              <CardTitle className="text-base flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <ListChecks className="h-4 w-4" />
                                  <span>Order: {order.id}</span>
                                </div>
                                {order.spot_number && (
                                  <Badge variant="secondary" data-testid={`badge-spot-${order.spot_number}`}>
                                    Spot #{order.spot_number}
                                  </Badge>
                                )}
                              </CardTitle>
                            </CardHeader>
                            <CardContent>
                              {order.items && order.items.length > 0 && (
                                <div className="space-y-3">
                                  {order.items.map((item: any, itemIndex: number) => (
                                    <div 
                                      key={item.sku || itemIndex} 
                                      className="flex gap-4 p-3 bg-muted/50 rounded-md"
                                      data-testid={`item-${item.sku}`}
                                    >
                                      {item.imageUrl && (
                                        <div className="flex-shrink-0">
                                          <img 
                                            src={item.imageUrl} 
                                            alt={item.sku}
                                            className="w-16 h-16 object-cover rounded"
                                            data-testid={`img-product-${item.sku}`}
                                          />
                                        </div>
                                      )}
                                      
                                      <div className="flex-1 space-y-1">
                                        <div className="font-medium">{item.sku}</div>
                                        {item.description && (
                                          <div className="text-sm text-muted-foreground">{item.description}</div>
                                        )}
                                        {item.location && (
                                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                            <MapPin className="h-3 w-3" />
                                            <span>{item.location}</span>
                                          </div>
                                        )}
                                      </div>
                                      <div className="text-right space-y-1">
                                        <div className="text-sm text-muted-foreground">Quantity</div>
                                        <div className="text-lg font-semibold">
                                          {item.picked || 0} / {item.quantity || 0}
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No details available
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export interface ParsedSessionInfo {
  sessionId: string;
  spot: string;
  raw: string;
}

export function parseCustomField2(customField2: string | null | undefined): ParsedSessionInfo | null {
  if (!customField2 || !customField2.trim()) {
    return null;
  }

  const parts = customField2.split(',').map(p => p.trim());
  const lastEntry = parts[parts.length - 1];
  
  if (!lastEntry) {
    return null;
  }

  const match = lastEntry.match(/(\d+)\s*#(\d+)/);
  
  if (match) {
    return {
      sessionId: match[1],
      spot: match[2],
      raw: customField2,
    };
  }

  return null;
}
