import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Package, User, Box, Weight, ListChecks, RefreshCw, AlertCircle, Clock, MapPin, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ParsedSession } from "@shared/skuvault-types";
import { SessionState, parseSessionState } from "@shared/skuvault-types";

interface ErrorDetails {
  statusCode: number;
  message: string;
  responseData?: any;
}

interface SessionsResponse {
  sessions: ParsedSession[];
}

interface LockoutStatus {
  isLockedOut: boolean;
  remainingSeconds: number;
  endTime: number | null;
}

// Status color mapping
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
    default:
      return "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20";
  }
};

// Format status for display
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
    default:
      return status;
  }
};

// Format date
const formatDate = (dateString: string | null): string => {
  if (!dateString) return "N/A";
  
  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return dateString;
  }
};

// Format countdown time
const formatCountdown = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

export default function Sessions() {
  const { toast } = useToast();
  const [errorDetails, setErrorDetails] = useState<ErrorDetails | null>(null);
  const [hasAuthenticated, setHasAuthenticated] = useState(false);
  const [selectedPicklistId, setSelectedPicklistId] = useState<string | null>(null);
  
  // Only fetch sessions if user has authenticated successfully
  const { data, isLoading, error, refetch } = useQuery<SessionsResponse>({
    queryKey: ["/api/skuvault/sessions"],
    enabled: hasAuthenticated, // Only run after successful login
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  // Fetch detailed session directions when a session is selected
  const { data: sessionDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ["/api/skuvault/sessions", selectedPicklistId],
    queryFn: async () => {
      if (!selectedPicklistId) throw new Error("No picklist ID selected");
      const response = await fetch(`/api/skuvault/sessions/${selectedPicklistId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch session details: ${response.statusText}`);
      }
      return response.json();
    },
    enabled: !!selectedPicklistId,
    staleTime: 0, // Always fetch fresh data to ensure product images are included
  });

  // Query lockout status - poll every second to keep countdown updated  
  const { data: lockoutData } = useQuery<LockoutStatus>({
    queryKey: ["/api/skuvault/lockout-status"],
    refetchInterval: 1000, // Poll every second to keep countdown live
  });

  const isLockedOut = lockoutData?.isLockedOut || false;
  const remainingSeconds = lockoutData?.remainingSeconds || 0;

  const loginMutation = useMutation({
    mutationFn: async () => {
      try {
        const response = await fetch('/api/skuvault/login', {
          method: 'POST',
          credentials: 'include',
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          throw {
            statusCode: response.status,
            message: data.message || response.statusText,
            responseData: data,
          };
        }
        
        return data;
      } catch (err: any) {
        if (err.statusCode) {
          throw err;
        }
        throw {
          statusCode: 0,
          message: err.message || 'Network error',
          responseData: null,
        };
      }
    },
    onSuccess: () => {
      toast({
        title: "Connected to SkuVault",
        description: "Successfully authenticated with SkuVault. Fetching sessions...",
      });
      // Mark as authenticated to enable session fetching
      setHasAuthenticated(true);
      // Refetch sessions after successful login
      queryClient.invalidateQueries({ queryKey: ["/api/skuvault/sessions"] });
    },
    onError: (error: any) => {
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to connect to SkuVault. Please try again.",
        variant: "destructive",
      });
      
      // Show detailed error modal
      setErrorDetails({
        statusCode: error.statusCode || 0,
        message: error.message || "Unknown error",
        responseData: error.responseData || null,
      });
      
      // Refresh lockout status to check if we're now locked out
      queryClient.invalidateQueries({ queryKey: ["/api/skuvault/lockout-status"] });
    },
  });

  const sessions = data?.sessions || [];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex items-center gap-2">
            <Package className="h-8 w-8 text-primary" />
            <h1 className="text-4xl font-bold font-serif">SkuVault Sessions</h1>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} data-testid={`skeleton-session-${i}`}>
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-6 w-24" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <Skeleton className="h-16" />
                    <Skeleton className="h-16" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex items-center gap-2">
            <Package className="h-8 w-8 text-primary" />
            <h1 className="text-4xl font-bold font-serif">SkuVault Sessions</h1>
          </div>
          
          <Card className="border-destructive">
            <CardContent className="p-12 text-center space-y-4">
              <p className="text-destructive">
                Failed to load SkuVault sessions. Please check your connection and credentials.
              </p>
              {isLockedOut ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Locked out. Retry in {formatCountdown(remainingSeconds)}</span>
                </div>
              ) : (
                <Button 
                  onClick={() => loginMutation.mutate()}
                  disabled={loginMutation.isPending || isLockedOut}
                  data-testid="button-connect-skuvault"
                >
                  {loginMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Connect to SkuVault
                    </>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="h-8 w-8 text-primary" />
            <h1 className="text-4xl font-bold font-serif">SkuVault Sessions</h1>
          </div>
          <div className="flex items-center gap-3">
            {isLockedOut ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-md" data-testid="lockout-countdown">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Retry in {formatCountdown(remainingSeconds)}
                </span>
              </div>
            ) : (
              <Button 
                onClick={() => loginMutation.mutate()}
                disabled={loginMutation.isPending || isLockedOut}
                variant="outline"
                size="sm"
                data-testid="button-reconnect-skuvault"
              >
                {loginMutation.isPending ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Reconnect
                  </>
                )}
              </Button>
            )}
            <Badge variant="secondary" className="text-sm" data-testid="badge-session-count">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
            </Badge>
          </div>
        </div>
        
        {sessions.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Package className="h-16 w-16 mx-auto mb-4 text-muted-foreground" />
              <p className="text-xl text-muted-foreground">
                No active sessions found
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Sessions will appear here when they are created in SkuVault
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sessions.map((session) => (
              <Card 
                key={session.picklistId || session.sessionId} 
                className="hover-elevate"
                data-testid={`card-session-${session.sessionId}`}
              >
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <CardTitle className="text-xl font-bold" data-testid={`title-session-${session.sessionId}`}>
                      Session #{session.sessionId}
                    </CardTitle>
                    <Badge 
                      className={getStatusColor(session.status)}
                      data-testid={`badge-status-${session.sessionId}`}
                    >
                      {formatStatus(session.status)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Picklist ID */}
                  {session.picklistId && (
                    <div className="text-sm" data-testid={`text-picklist-${session.sessionId}`}>
                      <span className="text-muted-foreground">Picklist: </span>
                      <span className="font-mono text-xs">{session.picklistId}</span>
                    </div>
                  )}

                  {/* Assigned User */}
                  {session.assignedUser && (
                    <div className="flex items-center gap-2 text-sm" data-testid={`text-user-${session.sessionId}`}>
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span>{session.assignedUser}</span>
                    </div>
                  )}

                  {/* Created Date */}
                  {session.createdDate && (
                    <div className="text-sm text-muted-foreground" data-testid={`text-date-${session.sessionId}`}>
                      {formatDate(session.createdDate)}
                    </div>
                  )}

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <ListChecks className="h-3 w-3" />
                        <span>Orders</span>
                      </div>
                      <div className="text-2xl font-bold" data-testid={`text-orders-${session.sessionId}`}>
                        {session.orderCount || 0}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Box className="h-3 w-3" />
                        <span>SKUs</span>
                      </div>
                      <div className="text-2xl font-bold" data-testid={`text-skus-${session.sessionId}`}>
                        {session.skuCount || 0}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Package className="h-3 w-3" />
                        <span>Quantity</span>
                      </div>
                      <div className="text-lg font-semibold" data-testid={`text-quantity-${session.sessionId}`}>
                        {session.pickedQuantity || 0} / {session.totalQuantity || 0}
                      </div>
                    </div>

                    {session.totalWeight && session.totalWeight > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Weight className="h-3 w-3" />
                          <span>Weight</span>
                        </div>
                        <div className="text-lg font-semibold" data-testid={`text-weight-${session.sessionId}`}>
                          {session.totalWeight.toFixed(1)} lb
                        </div>
                      </div>
                    )}
                  </div>

                  {/* View Details Button */}
                  {session.picklistId && (
                    <div className="pt-2 border-t">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setSelectedPicklistId(session.picklistId)}
                        data-testid={`button-view-details-${session.sessionId}`}
                      >
                        <Package className="h-4 w-4 mr-2" />
                        View Details
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Session Detail Modal */}
      <Dialog open={!!selectedPicklistId} onOpenChange={() => setSelectedPicklistId(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh]" data-testid="dialog-session-details">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Session Details
            </DialogTitle>
            <DialogDescription>
              Picklist: {selectedPicklistId}
            </DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            {isLoadingDetails ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : sessionDetails ? (
              <div className="space-y-6">
                {/* Picklist Summary */}
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

                    {/* Orders */}
                    {sessionDetails.picklist.orders && sessionDetails.picklist.orders.length > 0 && (
                      <div>
                        <h3 className="text-lg font-semibold mb-3">Orders ({sessionDetails.picklist.orders.length})</h3>
                        <div className="space-y-4">
                          {sessionDetails.picklist.orders.map((order: any, index: number) => (
                            <Card key={order.id || index} data-testid={`card-order-${order.id}`}>
                              <CardHeader className="pb-3">
                                <CardTitle className="text-base flex items-center gap-2">
                                  <ListChecks className="h-4 w-4" />
                                  Order: {order.id}
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
                                        {/* Product Image */}
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

      {/* Error Details Modal */}
      <AlertDialog open={!!errorDetails} onOpenChange={() => setErrorDetails(null)}>
        <AlertDialogContent data-testid="dialog-error-details">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              SkuVault Connection Error
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 text-left">
                <div>
                  <div className="text-sm font-semibold text-foreground mb-1">Status Code</div>
                  <div className="text-sm font-mono bg-muted p-2 rounded" data-testid="text-error-status">
                    {errorDetails?.statusCode || 'N/A'}
                  </div>
                </div>
                
                <div>
                  <div className="text-sm font-semibold text-foreground mb-1">Error Message</div>
                  <div className="text-sm bg-muted p-2 rounded" data-testid="text-error-message">
                    {errorDetails?.message || 'No error message available'}
                  </div>
                </div>
                
                {errorDetails?.responseData && (
                  <div>
                    <div className="text-sm font-semibold text-foreground mb-1">Response Details</div>
                    <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-48" data-testid="text-error-response">
                      {JSON.stringify(errorDetails.responseData, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction data-testid="button-close-error-dialog">
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
