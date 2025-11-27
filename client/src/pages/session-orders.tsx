import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Search, 
  ChevronDown, 
  ChevronUp, 
  ChevronLeft, 
  ChevronRight,
  Package, 
  User, 
  Clock, 
  Hash, 
  Truck,
  MapPin,
  X,
  AlertCircle
} from "lucide-react";
import type { SkuVaultOrderSession, SkuVaultOrderSessionItem } from "@shared/firestore-schema";

interface SessionOrdersResponse {
  sessions: SkuVaultOrderSession[];
  total: number;
}

function SessionCard({ session }: { session: SkuVaultOrderSession }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'closed':
        return 'bg-green-600 hover:bg-green-700';
      case 'active':
        return 'bg-blue-600 hover:bg-blue-700';
      case 'pending':
        return 'bg-yellow-600 hover:bg-yellow-700';
      default:
        return '';
    }
  };

  const calculatePickDuration = (start: Date, end: Date) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffSecs = Math.floor((diffMs % 60000) / 1000);
    
    if (diffMins > 0) {
      return `${diffMins}m ${diffSecs}s`;
    }
    return `${diffSecs}s`;
  };

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const totalQuantity = session.order_items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Card className="overflow-hidden" data-testid={`card-session-${session.session_id}`}>
      <CardHeader className="pb-4">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_2fr_1.5fr] gap-6">
          {/* LEFT COLUMN: Session & Order Info */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <CardTitle className="text-2xl font-bold" data-testid={`title-session-${session.session_id}`}>
                Session #{session.session_id}
              </CardTitle>
              <Badge className={getStatusColor(session.session_status)} data-testid={`badge-status-${session.session_id}`}>
                {session.session_status}
              </Badge>
            </div>

            {session.order_number && (
              <div className="flex items-start gap-2">
                <Package className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-lg font-bold text-foreground" data-testid={`text-order-${session.session_id}`}>
                  #{session.order_number}
                </p>
              </div>
            )}

            {session.shipment_id && (
              <div className="flex items-start gap-2">
                <Truck className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
                <span className="text-sm text-muted-foreground font-mono" data-testid={`text-shipment-${session.session_id}`}>
                  {session.shipment_id}
                </span>
              </div>
            )}
          </div>

          {/* MIDDLE COLUMN: Picker & Timing */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <User className="h-5 w-5 text-muted-foreground" />
              <span className="text-lg font-semibold" data-testid={`text-picker-${session.session_id}`}>
                {session.picked_by_user_name}
              </span>
              <span className="text-sm text-muted-foreground">(ID: {session.picked_by_user_id})</span>
            </div>

            <div className="flex items-start gap-2">
              <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
              <div className="space-y-1">
                <div className="text-sm">
                  <span className="text-muted-foreground">Pick Duration: </span>
                  <span className="font-bold text-foreground" data-testid={`text-duration-${session.session_id}`}>
                    {calculatePickDuration(session.pick_start_datetime, session.pick_end_datetime)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDate(session.pick_start_datetime)} - {formatDate(session.pick_end_datetime)}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Spot:</span>
              <span className="font-medium" data-testid={`text-spot-${session.session_id}`}>{session.spot_number}</span>
            </div>
          </div>

          {/* RIGHT COLUMN: Stats & Actions */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Items</div>
                <div className="text-2xl font-bold" data-testid={`text-items-${session.session_id}`}>
                  {session.order_items.length}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Total Qty</div>
                <div className="text-2xl font-bold" data-testid={`text-qty-${session.session_id}`}>
                  {totalQuantity}
                </div>
              </div>
            </div>

            {session.saved_custom_field_2 && (
              <Badge variant="outline" className="border-green-500 text-green-700 dark:text-green-400">
                Custom Field Saved
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Expandable Order Items */}
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <Button 
            variant="ghost" 
            className="w-full flex items-center justify-center gap-2 py-2 border-t rounded-none"
            data-testid={`button-expand-${session.session_id}`}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                Hide Items ({session.order_items.length})
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                Show Items ({session.order_items.length})
              </>
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-4 border-t bg-muted/30">
            <div className="grid gap-3">
              {session.order_items.map((item, index) => (
                <OrderItemRow key={`${item.sku}-${index}`} item={item} index={index} />
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function OrderItemRow({ item, index }: { item: SkuVaultOrderSessionItem; index: number }) {
  return (
    <div 
      className="flex items-center justify-between p-3 bg-background rounded-lg border"
      data-testid={`item-row-${index}`}
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 text-primary font-bold text-sm">
          {item.quantity}x
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono font-bold text-sm truncate" data-testid={`text-sku-${index}`}>
            {item.sku}
          </div>
          {item.description && (
            <div className="text-sm text-muted-foreground truncate">
              {item.description}
            </div>
          )}
        </div>
      </div>
      
      <div className="flex items-center gap-3">
        {item.location && (
          <Badge variant="outline" className="font-mono text-xs" data-testid={`text-location-${index}`}>
            {item.location}
          </Badge>
        )}
        {item.picked === true && (
          <Badge className="bg-green-600">Picked</Badge>
        )}
        {item.picked === false && (
          <Badge variant="outline" className="border-yellow-500 text-yellow-700 dark:text-yellow-400">Pending</Badge>
        )}
      </div>
    </div>
  );
}

export default function SessionOrders() {
  const [search, setSearch] = useState("");
  const [pickerName, setPickerName] = useState<string>("all");
  const [sessionStatus, setSessionStatus] = useState<string>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const buildQueryParams = () => {
    const params = new URLSearchParams();
    if (search.trim()) params.append('search', search.trim());
    if (pickerName && pickerName !== 'all') params.append('pickerName', pickerName);
    if (sessionStatus && sessionStatus !== 'all') params.append('sessionStatus', sessionStatus);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    params.append('limit', pageSize.toString());
    params.append('offset', ((page - 1) * pageSize).toString());
    return params.toString();
  };

  const queryParams = buildQueryParams();

  const { data, isLoading, error } = useQuery<SessionOrdersResponse>({
    queryKey: ['/api/firestore/session-orders', queryParams],
    queryFn: async () => {
      const url = `/api/firestore/session-orders${queryParams ? `?${queryParams}` : ''}`;
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch session orders');
      }
      return response.json();
    },
  });

  const { data: pickerNames = [] } = useQuery<string[]>({
    queryKey: ['/api/firestore/session-orders/picker-names'],
  });

  const { data: statuses = [] } = useQuery<string[]>({
    queryKey: ['/api/firestore/session-orders/statuses'],
  });

  const sessions = data?.sessions || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / pageSize);

  const hasFilters = search || (pickerName && pickerName !== 'all') || (sessionStatus && sessionStatus !== 'all') || startDate || endDate;

  const clearFilters = () => {
    setSearch("");
    setPickerName("all");
    setSessionStatus("all");
    setStartDate("");
    setEndDate("");
    setPage(1);
  };

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold" data-testid="heading-session-orders">Session Orders</h1>
          <p className="text-muted-foreground mt-1">
            View SkuVault session orders with pick times and picker information
          </p>
        </div>
        {total > 0 && (
          <Badge variant="secondary" className="text-lg px-4 py-2" data-testid="text-total-count">
            {total} session{total !== 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Search */}
            <div className="lg:col-span-2 space-y-2">
              <Label htmlFor="search" className="text-sm font-medium">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Order #, Session ID, Shipment ID, Picker..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="pl-9"
                  data-testid="input-search"
                />
              </div>
            </div>

            {/* Picker Name */}
            <div className="space-y-2">
              <Label htmlFor="picker" className="text-sm font-medium">Picker</Label>
              <Select 
                value={pickerName} 
                onValueChange={(value) => {
                  setPickerName(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id="picker" data-testid="select-picker">
                  <SelectValue placeholder="All Pickers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Pickers</SelectItem>
                  {pickerNames.map((name) => (
                    <SelectItem key={name} value={name}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Status */}
            <div className="space-y-2">
              <Label htmlFor="status" className="text-sm font-medium">Status</Label>
              <Select 
                value={sessionStatus} 
                onValueChange={(value) => {
                  setSessionStatus(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id="status" data-testid="select-status">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {statuses.map((status) => (
                    <SelectItem key={status} value={status}>{status}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Date Range */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Date Range</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setPage(1);
                  }}
                  className="flex-1"
                  data-testid="input-start-date"
                />
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setPage(1);
                  }}
                  className="flex-1"
                  data-testid="input-end-date"
                />
              </div>
            </div>
          </div>

          {/* Clear Filters */}
          {hasFilters && (
            <div className="flex justify-end mt-4 pt-4 border-t">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4 mr-2" />
                Clear Filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-96 mt-2" />
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <div>
                <p className="font-semibold">Failed to load session orders</p>
                <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && !error && sessions.length === 0 && (
        <Card>
          <CardContent className="p-12 text-center">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No session orders found</h3>
            <p className="text-muted-foreground">
              {hasFilters 
                ? "Try adjusting your filters to see more results."
                : "Session orders will appear here once they are created in SkuVault."
              }
            </p>
          </CardContent>
        </Card>
      )}

      {/* Session Cards */}
      {!isLoading && !error && sessions.length > 0 && (
        <div className="space-y-4">
          {sessions.map((session) => (
            <SessionCard key={session.document_id} session={session} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > pageSize && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} total)
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
