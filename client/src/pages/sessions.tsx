import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Package, User, Box, Weight, ListChecks } from "lucide-react";
import type { ParsedSession } from "@shared/skuvault-types";
import { SessionState } from "@shared/skuvault-types";

interface SessionsResponse {
  sessions: ParsedSession[];
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

export default function Sessions() {
  const { data, isLoading, error } = useQuery<SessionsResponse>({
    queryKey: ["/api/skuvault/sessions"],
    refetchInterval: 30000, // Refetch every 30 seconds
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
            <CardContent className="p-6">
              <p className="text-destructive">
                Failed to load SkuVault sessions. Please check your connection and credentials.
              </p>
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
          <Badge variant="secondary" className="text-sm" data-testid="badge-session-count">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          </Badge>
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

                  {/* View Link */}
                  {session.viewUrl && (
                    <div className="pt-2 border-t">
                      <a 
                        href={session.viewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline"
                        data-testid={`link-view-${session.sessionId}`}
                      >
                        View in SkuVault →
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
