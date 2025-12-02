import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Truck, Package, ChevronDown, ChevronUp, Filter, X, ArrowUpDown, ChevronLeft, ChevronRight, PackageOpen, Clock, MapPin, User, Mail, Phone, Scale, Hash, Boxes, Play, CheckCircle, Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, ShipmentItem, ShipmentTag } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { SessionDetailDialog, parseCustomField2 } from "@/components/session-detail-dialog";

interface ShipmentWithItemCount extends Shipment {
  itemCount?: number;
}

interface ShipmentsResponse {
  shipments: ShipmentWithItemCount[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface TabCounts {
  inProgress: number;
  packingQueue: number;
  shipped: number;
  all: number;
}

type WorkflowTab = 'in_progress' | 'packing_queue' | 'shipped' | 'all';

function ShipmentCard({ shipment, tags }: { shipment: ShipmentWithItemCount; tags?: ShipmentTag[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setLocation] = useLocation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  
  const shipmentIdOrUuid = shipment.shipmentId ?? shipment.id;
  const sessionInfo = parseCustomField2(shipment.customField2);

  const { data: items, isLoading: isLoadingItems } = useQuery<ShipmentItem[]>({
    queryKey: ['/api/shipments', shipmentIdOrUuid, 'items'],
    enabled: isExpanded && !!shipmentIdOrUuid,
  });

  const isOrphanedShipment = (shipment: ShipmentWithItemCount) => {
    return !shipment.trackingNumber && !shipment.shipDate && !shipment.shipmentId;
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline" className="border-gray-400 text-gray-600 dark:text-gray-400">Unknown</Badge>;
    }

    const statusConfig: Record<string, { variant: "default" | "secondary" | "outline"; className?: string; label: string }> = {
      "delivered": { variant: "default", className: "bg-green-600 hover:bg-green-700", label: "Delivered" },
      "in_transit": { variant: "default", className: "bg-blue-600 hover:bg-blue-700", label: "In Transit" },
      "shipped": { variant: "secondary", label: "Shipped" },
      "pending": { variant: "outline", className: "border-gray-500 text-gray-700 dark:text-gray-400", label: "Awaiting Label" },
      "cancelled": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400", label: "Cancelled" },
    };

    const config = statusConfig[status.toLowerCase()] || { variant: "outline" as const, label: status };
    
    return (
      <Badge variant={config.variant} className={config.className}>
        {config.label}
      </Badge>
    );
  };

  const formatRelativeTime = (date: Date | string | null) => {
    if (!date) return null;
    try {
      const dateObj = typeof date === 'string' ? new Date(date) : date;
      return formatDistanceToNow(dateObj, { addSuffix: true });
    } catch (e) {
      return null;
    }
  };

  const calculatePickDuration = (start: Date | string | null, end: Date | string | null) => {
    if (!start || !end) return null;
    try {
      const startDate = typeof start === 'string' ? new Date(start) : start;
      const endDate = typeof end === 'string' ? new Date(end) : end;
      const diffMs = endDate.getTime() - startDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffSecs = Math.floor((diffMs % 60000) / 1000);
      
      if (diffMins > 0) {
        return `${diffMins}m ${diffSecs}s`;
      }
      return `${diffSecs}s`;
    } catch (e) {
      return null;
    }
  };

  const getSessionStatusBadge = (status: string | null | undefined) => {
    if (!status) return null;
    
    const statusLower = status.toLowerCase();
    if (statusLower === 'closed') {
      return <Badge className="bg-green-600 hover:bg-green-700 text-xs">Closed</Badge>;
    }
    if (statusLower === 'active') {
      return <Badge className="bg-blue-600 hover:bg-blue-700 text-xs">Active</Badge>;
    }
    if (statusLower === 'inactive') {
      return <Badge variant="outline" className="border-gray-500 text-gray-700 dark:text-gray-400 text-xs">Inactive</Badge>;
    }
    if (statusLower === 'new') {
      return <Badge variant="outline" className="border-yellow-500 text-yellow-700 dark:text-yellow-400 text-xs">New</Badge>;
    }
    return <Badge variant="secondary" className="text-xs">{status}</Badge>;
  };

  return (
    <Card className="overflow-hidden" data-testid={`card-shipment-${shipment.id}`}>
      <CardHeader className="pb-4">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_2fr_1.5fr] gap-6">
          {/* LEFT COLUMN: Customer Information */}
          <div className="space-y-3">
            {/* Customer Name - Most Important */}
            {shipment.shipToName && (
              <div className="flex items-start gap-2">
                <User className="h-6 w-6 text-muted-foreground flex-shrink-0 mt-0.5" />
                <CardTitle className="text-2xl font-bold leading-tight">
                  {shipment.shipToName}
                </CardTitle>
              </div>
            )}

            {/* Order Number - Second Most Important */}
            {shipment.orderNumber && (
              <div className="flex items-start gap-2">
                <Package className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <p className="text-lg font-bold text-foreground">
                  #{shipment.orderNumber}
                </p>
              </div>
            )}

            {/* Age/Order Date */}
            {shipment.orderDate && (
              <div className="flex items-start gap-2">
                <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {formatRelativeTime(shipment.orderDate)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(shipment.orderDate).toLocaleDateString('en-US', { 
                      month: 'short', 
                      day: 'numeric', 
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                </div>
              </div>
            )}

            {/* Shipping Address */}
            {shipment.shipToCity && (
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
                <span className="text-sm text-muted-foreground">
                  {[shipment.shipToCity, shipment.shipToState, shipment.shipToPostalCode].filter(Boolean).join(', ')}
                </span>
              </div>
            )}
          </div>

          {/* MIDDLE COLUMN: Session & Shipping Info */}
          <div className="space-y-3">
            {/* Session Info - Only show if has session data */}
            {(shipment.sessionId || shipment.pickedByUserName) && (
              <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Boxes className="h-4 w-4 text-primary" />
                  <span>Session Info</span>
                  {getSessionStatusBadge(shipment.sessionStatus)}
                </div>
                
                {/* Picker Name */}
                {shipment.pickedByUserName && (
                  <div className="flex items-center gap-2 text-sm">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Picked by:</span>
                    <span className="font-medium">{shipment.pickedByUserName}</span>
                  </div>
                )}

                {/* Pick Duration */}
                {shipment.pickStartedAt && shipment.pickEndedAt && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Timer className="h-3.5 w-3.5" />
                    <span>Pick time: {calculatePickDuration(shipment.pickStartedAt, shipment.pickEndedAt)}</span>
                  </div>
                )}

                {/* Spot Number */}
                {shipment.spotNumber && (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs font-mono">
                      Spot #{shipment.spotNumber}
                    </Badge>
                  </div>
                )}

                {/* Session ID link */}
                {shipment.sessionId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedSessionId(shipment.sessionId);
                    }}
                    className="text-xs text-primary hover:underline cursor-pointer"
                    data-testid={`link-session-${shipment.sessionId}`}
                  >
                    View Session #{shipment.sessionId}
                  </button>
                )}
              </div>
            )}

            {/* Carrier Info */}
            {(shipment.carrierCode || shipment.serviceCode) && (
              <div className="flex items-start gap-2">
                <Truck className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="flex items-center gap-2 flex-wrap">
                  {shipment.carrierCode && (
                    <Badge variant="secondary" className="font-mono text-xs">
                      {shipment.carrierCode}
                    </Badge>
                  )}
                  {shipment.serviceCode && (
                    <span className="text-sm">{shipment.serviceCode}</span>
                  )}
                </div>
              </div>
            )}

            {/* Items Count */}
            {shipment.itemCount != null && shipment.itemCount > 0 && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <PackageOpen className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>Order contains {shipment.itemCount} item{shipment.itemCount !== 1 ? 's' : ''}</span>
              </div>
            )}

            {/* Weight */}
            {shipment.totalWeight && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <Scale className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span className="font-medium">Shipping weight {shipment.totalWeight}</span>
              </div>
            )}

            {/* Tracking Number */}
            {shipment.trackingNumber && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <Hash className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span className="font-mono">{shipment.trackingNumber}</span>
              </div>
            )}

            {/* ShipStation Tags only */}
            {tags && tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag, index) => (
                  <Badge key={index} variant="secondary" className="text-xs">
                    {tag.name}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT COLUMN: Actions */}
          <div className="flex flex-col gap-3 lg:items-end">
            {/* View Details Button */}
            <Button
              variant="default"
              size="default"
              onClick={() => setLocation(`/shipments/${shipment.shipmentId ?? shipment.id}`)}
              className="w-full lg:w-auto lg:min-w-[180px]"
              data-testid={`button-view-details-${shipment.shipmentId ?? shipment.id}`}
            >
              View Details
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>

            {/* Status Badge */}
            <div className="flex flex-col gap-1.5 lg:items-end">
              {getStatusBadge(shipment.status)}
            </div>

            {/* Status & Special Handling Badges */}
            <div className="flex flex-wrap items-center justify-end gap-2 w-full">
              {isOrphanedShipment(shipment) && (
                <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-400 text-xs">
                  Orphaned
                </Badge>
              )}
              {shipment.shipmentStatus === 'on_hold' && (
                <Badge variant="outline" className="border-yellow-500 text-yellow-700 dark:text-yellow-400 text-xs font-semibold" data-testid="badge-on-hold">
                  ON HOLD
                </Badge>
              )}
              {shipment.shipmentStatus === 'pending' && !shipment.trackingNumber && (
                <Badge variant="outline" className="border-gray-500 text-gray-700 dark:text-gray-400 text-xs" data-testid="badge-pending">
                  Awaiting Label
                </Badge>
              )}
              {shipment.isReturn && (
                <Badge variant="outline" className="border-purple-500 text-purple-700 dark:text-purple-400 text-xs">
                  Return
                </Badge>
              )}
              {(shipment.isGift || tags?.some(tag => tag.name === 'Gift')) && (
                <Badge variant="outline" className="border-pink-500 text-pink-700 dark:text-pink-400 text-xs">
                  Gift
                </Badge>
              )}
              {shipment.saturdayDelivery && (
                <Badge variant="outline" className="border-blue-500 text-blue-700 dark:text-blue-400 text-xs" data-testid="badge-saturday-delivery">
                  Saturday
                </Badge>
              )}
              {shipment.containsAlcohol && (
                <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400 text-xs" data-testid="badge-contains-alcohol">
                  Alcohol
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      {/* Collapsible Items Section */}
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-between px-6 py-3 border-t hover-elevate"
            data-testid={`button-toggle-items-${shipment.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <PackageOpen className="h-4 w-4" />
              <span className="font-semibold">
                {isExpanded ? "Hide Items" : "Show Items"}
              </span>
            </div>
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-4 pb-6">
            {isLoadingItems ? (
              <div className="text-center py-6">
                <div className="animate-pulse text-muted-foreground">Loading items...</div>
              </div>
            ) : items && items.length > 0 ? (
              <div className="space-y-4">
                {/* Gift Message and Buyer Notes */}
                {(shipment.notesForGift || shipment.notesFromBuyer) && (
                  <div className="space-y-3 pb-4 border-b">
                    {shipment.notesForGift && (
                      <div className="bg-pink-50 dark:bg-pink-950/20 border border-pink-200 dark:border-pink-800 rounded-md p-3">
                        <p className="text-xs font-semibold text-pink-700 dark:text-pink-400 mb-1">Gift Message</p>
                        <p className="text-sm text-foreground" data-testid="text-gift-message">{shipment.notesForGift}</p>
                      </div>
                    )}
                    {shipment.notesFromBuyer && (
                      <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-md p-3">
                        <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1">Customer Notes</p>
                        <p className="text-sm text-foreground" data-testid="text-buyer-notes">{shipment.notesFromBuyer}</p>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Items Table */}
                <div className="border rounded-md overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-4 py-3 font-semibold text-sm">SKU</th>
                        <th className="text-left px-4 py-3 font-semibold text-sm">Product</th>
                        <th className="text-center px-4 py-3 font-semibold text-sm">Quantity</th>
                        <th className="text-right px-4 py-3 font-semibold text-sm">Unit Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.map((item, index) => (
                        <tr key={index} className="hover-elevate">
                          <td className="px-4 py-3">
                            <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                              {item.sku || 'N/A'}
                            </code>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              {item.imageUrl && (
                                <img 
                                  src={item.imageUrl} 
                                  alt={item.name || 'Product'}
                                  className="w-12 h-12 object-cover rounded border"
                                />
                              )}
                              <span className="text-sm">{item.name || 'Unknown Product'}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="font-semibold">{item.quantity}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {item.unitPrice ? `$${parseFloat(item.unitPrice).toFixed(2)}` : 'N/A'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                No items found for this shipment
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>

      {/* Session Detail Modal */}
      <SessionDetailDialog 
        picklistId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </Card>
  );
}

export default function Shipments() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [warehouseStatusDropdownOpen, setWarehouseStatusDropdownOpen] = useState(false);
  const warehouseStatusDropdownRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');

  // Workflow tab state
  const [activeTab, setActiveTab] = useState<WorkflowTab>('in_progress');

  // Filter states
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(""); // Single status for cascading filter
  const [statusDescription, setStatusDescription] = useState<string>("");
  const [shipmentStatus, setShipmentStatus] = useState<string[]>([]); // Warehouse status filter (multi-select)
  const [carrierCode, setCarrierCode] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [showWithoutOrders, setShowWithoutOrders] = useState(false);
  const [showShippedWithoutTracking, setShowShippedWithoutTracking] = useState(false);

  // Pagination and sorting
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState("orderDate");
  const [sortOrder, setSortOrder] = useState("desc");

  // Initialize state from URL params (runs when URL changes, including browser navigation)
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    // Skip if this is the same URL we just synced to avoid loops
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    // Always reset to defaults, then apply URL params
    setActiveTab((params.get('tab') as WorkflowTab) || 'in_progress');
    setSearch(params.get('search') || '');
    setStatus(params.get('status') || ''); // Single status value
    setStatusDescription(params.get('statusDescription') || '');
    const shipmentStatusValues = params.getAll('shipmentStatus');
    setShipmentStatus(shipmentStatusValues);
    setCarrierCode(params.getAll('carrierCode'));
    setDateFrom(params.get('dateFrom') || '');
    setDateTo(params.get('dateTo') || '');
    setShowOrphanedOnly(params.get('orphaned') === 'true');
    setShowWithoutOrders(params.get('withoutOrders') === 'true');
    setShowShippedWithoutTracking(params.get('shippedWithoutTracking') === 'true');
    setPage(parseInt(params.get('page') || '1'));
    setPageSize(parseInt(params.get('pageSize') || '50'));
    setSortBy(params.get('sortBy') || 'orderDate');
    setSortOrder((params.get('sortOrder') as 'asc' | 'desc') || 'desc');
    
    // Open filters if any are active
    const hasActiveFilters = params.get('search') || 
      params.get('status') ||
      params.get('statusDescription') ||
      params.getAll('shipmentStatus').length ||
      params.getAll('carrierCode').length ||
      params.get('dateFrom') ||
      params.get('dateTo') ||
      params.get('orphaned') === 'true' ||
      params.get('withoutOrders') === 'true' ||
      params.get('shippedWithoutTracking') === 'true';
    
    if (hasActiveFilters) {
      setFiltersOpen(true);
    }
    
    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]); // Re-run when URL changes (including browser navigation)

  // Update URL when state changes
  useEffect(() => {
    if (!isInitialized) return; // Don't update URL during initialization
    
    const params = new URLSearchParams();
    
    if (activeTab !== 'in_progress') params.set('tab', activeTab);
    if (search) params.set('search', search);
    if (status) params.set('status', status); // Single status value
    if (statusDescription) params.set('statusDescription', statusDescription);
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (showOrphanedOnly) params.set('orphaned', 'true');
    if (showWithoutOrders) params.set('withoutOrders', 'true');
    if (showShippedWithoutTracking) params.set('shippedWithoutTracking', 'true');
    
    if (page !== 1) params.set('page', page.toString());
    if (pageSize !== 50) params.set('pageSize', pageSize.toString());
    if (sortBy !== 'orderDate') params.set('sortBy', sortBy);
    if (sortOrder !== 'desc') params.set('sortOrder', sortOrder);
    
    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    // Only update if different to avoid infinite loops
    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/shipments${newUrl}`);
    }
  }, [activeTab, search, status, statusDescription, shipmentStatus, carrierCode, dateFrom, dateTo, showOrphanedOnly, showWithoutOrders, showShippedWithoutTracking, page, pageSize, sortBy, sortOrder, isInitialized]);

  // Close warehouse status dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (warehouseStatusDropdownRef.current && !warehouseStatusDropdownRef.current.contains(event.target as Node)) {
        setWarehouseStatusDropdownOpen(false);
      }
    };

    if (warehouseStatusDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [warehouseStatusDropdownOpen]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?room=orders`;
      
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
          if (data.type === 'order_update' && data.order) {
            // Silently refresh data - no toast notifications
            queryClient.invalidateQueries({ queryKey: ["/api/shipments"] });
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

  // Build query string
  const buildQueryString = () => {
    const params = new URLSearchParams();
    
    // Add workflow tab filter
    params.append('workflowTab', activeTab);
    
    if (search) params.append('search', search);
    if (status) params.append('status', status); // Single status value
    if (statusDescription) params.append('statusDescription', statusDescription);
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    
    if (dateFrom) params.append('dateFrom', dateFrom);
    if (dateTo) params.append('dateTo', dateTo);
    if (showOrphanedOnly) params.append('orphaned', 'true');
    if (showWithoutOrders) params.append('withoutOrders', 'true');
    if (showShippedWithoutTracking) params.append('shippedWithoutTracking', 'true');
    
    params.append('page', page.toString());
    params.append('pageSize', pageSize.toString());
    params.append('sortBy', sortBy);
    params.append('sortOrder', sortOrder);
    
    return params.toString();
  };

  // Fetch tab counts
  const { data: tabCountsData } = useQuery<TabCounts>({
    queryKey: ["/api/shipments/tab-counts"],
  });

  const tabCounts = tabCountsData || { inProgress: 0, packingQueue: 0, shipped: 0, all: 0 };

  // Fetch distinct statuses for the status filter dropdown
  const { data: statusesData } = useQuery<{ statuses: string[] }>({
    queryKey: ["/api/shipments/statuses"],
  });

  const statuses = statusesData?.statuses || [];

  // Fetch distinct status descriptions for the sub status filter dropdown (filtered by status if selected)
  const { data: statusDescriptionsData } = useQuery<{ statusDescriptions: string[] }>({
    queryKey: ["/api/shipments/status-descriptions", { status }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.append('status', status);
      const url = `/api/shipments/status-descriptions?${params.toString()}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error("Failed to fetch status descriptions");
      }
      return response.json();
    },
  });

  const statusDescriptions = statusDescriptionsData?.statusDescriptions || [];

  // Fetch distinct shipment statuses for the shipment status filter dropdown
  const { data: shipmentStatusesData } = useQuery<{ shipmentStatuses: Array<string | null> }>({
    queryKey: ["/api/shipments/shipment-statuses"],
  });

  const shipmentStatuses = shipmentStatusesData?.shipmentStatuses || [];

  const { data: shipmentsData, isLoading, isError, error } = useQuery<ShipmentsResponse>({
    queryKey: ["/api/shipments", { activeTab, search, status, statusDescription, shipmentStatus, carrierCode, dateFrom, dateTo, showOrphanedOnly, showWithoutOrders, showShippedWithoutTracking, page, pageSize, sortBy, sortOrder }],
    queryFn: async () => {
      const queryString = buildQueryString();
      const url = `/api/shipments?${queryString}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error("Failed to fetch shipments");
      }
      return response.json();
    },
  });

  // Show error toast when query fails
  useEffect(() => {
    if (isError && error) {
      toast({
        title: "Failed to load shipments",
        description: error instanceof Error ? error.message : "An error occurred while fetching shipments",
        variant: "destructive",
      });
    }
  }, [isError, error, toast]);

  // Only derive data when not in error state to avoid showing stale data
  const shipments = !isError && shipmentsData?.shipments ? shipmentsData.shipments : [];
  const total = !isError && shipmentsData?.total ? shipmentsData.total : 0;
  const totalPages = !isError && shipmentsData?.totalPages ? shipmentsData.totalPages : 1;

  // Batch fetch tags for all shipments (reduces N+1 queries from 50+ to 1)
  const shipmentIds = shipments.map(s => s.id);
  const { data: batchTagsData } = useQuery<Record<string, ShipmentTag[]>>({
    queryKey: ["/api/shipments/tags/batch", shipmentIds],
    queryFn: async () => {
      if (shipmentIds.length === 0) return {};
      const response = await apiRequest("POST", "/api/shipments/tags/batch", { shipmentIds });
      return response.json();
    },
    enabled: shipmentIds.length > 0,
  });

  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setStatusDescription("");
    setShipmentStatus([]);
    setCarrierCode([]);
    setDateFrom("");
    setDateTo("");
    setShowOrphanedOnly(false);
    setShowWithoutOrders(false);
    setShowShippedWithoutTracking(false);
    setPage(1);
  };

  const activeFiltersCount = [
    search,
    status,
    statusDescription,
    shipmentStatus.length > 0,
    carrierCode.length > 0,
    dateFrom,
    dateTo,
    showOrphanedOnly,
    showWithoutOrders,
    showShippedWithoutTracking,
  ].filter(Boolean).length;

  const toggleArrayFilter = (value: string, current: string[], setter: (val: string[]) => void) => {
    if (current.includes(value)) {
      setter(current.filter(v => v !== value));
    } else {
      setter([...current, value]);
    }
    setPage(1);
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value as WorkflowTab);
    setPage(1);
  };

  const getTabDescription = () => {
    switch (activeTab) {
      case 'in_progress':
        return 'Orders currently being picked (New or Active sessions)';
      case 'packing_queue':
        return 'Orders ready to pack (all items picked, awaiting shipment)';
      case 'shipped':
        return 'Orders that have been shipped';
      case 'all':
        return 'All shipments regardless of status';
    }
  };

  return (
    <>
      <div className="max-w-7xl mx-auto p-6 space-y-6 pb-32">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground mb-2">Shipments</h1>
          <p className="text-muted-foreground text-lg">
            Manage orders through the fulfillment workflow
          </p>
        </div>

        {/* Workflow Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="grid w-full grid-cols-4 h-auto p-1">
            <TabsTrigger 
              value="in_progress" 
              className="flex flex-col gap-1 py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-in-progress"
            >
              <div className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                <span className="font-semibold">In Progress</span>
              </div>
              <span className="text-xs opacity-80">{tabCounts.inProgress} orders</span>
            </TabsTrigger>
            <TabsTrigger 
              value="packing_queue" 
              className="flex flex-col gap-1 py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-packing-queue"
            >
              <div className="flex items-center gap-2">
                <PackageOpen className="h-4 w-4" />
                <span className="font-semibold">Packing Queue</span>
              </div>
              <span className="text-xs opacity-80">{tabCounts.packingQueue} orders</span>
            </TabsTrigger>
            <TabsTrigger 
              value="shipped" 
              className="flex flex-col gap-1 py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-shipped"
            >
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4" />
                <span className="font-semibold">Shipped</span>
              </div>
              <span className="text-xs opacity-80">{tabCounts.shipped} orders</span>
            </TabsTrigger>
            <TabsTrigger 
              value="all" 
              className="flex flex-col gap-1 py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
              data-testid="tab-all"
            >
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4" />
                <span className="font-semibold">All</span>
              </div>
              <span className="text-xs opacity-80">{tabCounts.all} total</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Tab Description */}
        <p className="text-sm text-muted-foreground italic">{getTabDescription()}</p>

        {/* Search and Filters */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                data-testid="input-search-shipments"
                type="search"
                placeholder="Search by order #, tracking #, customer name, shipment ID..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-10 h-14 text-lg"
              />
            </div>

            <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
              <div className="flex items-center justify-between gap-4">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" className="gap-2" data-testid="button-toggle-filters">
                    <Filter className="h-4 w-4" />
                    Advanced Filters
                    {activeFiltersCount > 0 && (
                      <Badge variant="secondary" className="ml-1">{activeFiltersCount}</Badge>
                    )}
                    {filtersOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                
                {activeFiltersCount > 0 && (
                  <Button variant="ghost" onClick={clearFilters} className="gap-2" data-testid="button-clear-filters">
                    <X className="h-4 w-4" />
                    Clear Filters
                  </Button>
                )}
              </div>

              <CollapsibleContent className="pt-4 space-y-4">
                {/* Fulfillment Status */}
                <div className="space-y-2">
                  <label className="text-sm font-semibold">Fulfillment Status</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select value={status || "all"} onValueChange={(val) => { 
                      const newStatus = val === "all" ? "" : val;
                      setStatus(newStatus);
                      // Clear sub status when status changes to prevent invalid combinations
                      setStatusDescription("");
                      setPage(1); 
                    }}>
                      <SelectTrigger className="w-40" data-testid="select-status">
                        <SelectValue placeholder="All statuses" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" data-testid="status-all">All statuses</SelectItem>
                        {statuses.map((s) => (
                          <SelectItem key={s} value={s} data-testid={`status-${s}`}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select 
                      value={statusDescription || "all"} 
                      onValueChange={(val) => { 
                        setStatusDescription(val === "all" ? "" : val); 
                        setPage(1); 
                      }}
                      disabled={!status && statusDescriptions.length === 0}
                    >
                      <SelectTrigger className="w-48" data-testid="select-sub-status">
                        <SelectValue placeholder={status ? "All sub statuses" : "Select a status first"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all" data-testid="sub-status-all">All sub statuses</SelectItem>
                        {statusDescriptions.map((desc) => (
                          <SelectItem key={desc} value={desc} data-testid={`sub-status-${desc}`}>
                            {desc}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Carrier Filter */}
                <div className="space-y-2">
                  <label className="text-sm font-semibold">Carrier</label>
                  <div className="flex flex-wrap gap-2">
                    {['usps', 'fedex', 'ups', 'dhl'].map(carrier => (
                      <Badge
                        key={carrier}
                        variant={carrierCode.includes(carrier) ? "default" : "outline"}
                        className="cursor-pointer hover-elevate"
                        onClick={() => toggleArrayFilter(carrier, carrierCode, setCarrierCode)}
                        data-testid={`filter-carrier-${carrier}`}
                      >
                        {carrier.toUpperCase()}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Date Filter */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Ship Date Range</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                        placeholder="From"
                        data-testid="input-date-from"
                      />
                      <Input
                        type="date"
                        value={dateTo}
                        onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                        placeholder="To"
                        data-testid="input-date-to"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Other Filters</label>
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="orphaned-filter"
                          checked={showOrphanedOnly}
                          onCheckedChange={(checked) => {
                            setShowOrphanedOnly(checked as boolean);
                            setPage(1);
                          }}
                          data-testid="checkbox-orphaned-filter"
                        />
                        <label
                          htmlFor="orphaned-filter"
                          className="text-sm cursor-pointer"
                        >
                          Show orphaned shipments only
                        </label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="without-orders-filter"
                          checked={showWithoutOrders}
                          onCheckedChange={(checked) => {
                            setShowWithoutOrders(checked as boolean);
                            setPage(1);
                          }}
                          data-testid="checkbox-without-orders-filter"
                        />
                        <label
                          htmlFor="without-orders-filter"
                          className="text-sm cursor-pointer"
                        >
                          Show shipments without orders only
                        </label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="shipped-without-tracking-filter"
                          checked={showShippedWithoutTracking}
                          onCheckedChange={(checked) => {
                            setShowShippedWithoutTracking(checked as boolean);
                            setPage(1);
                          }}
                          data-testid="checkbox-shipped-without-tracking-filter"
                        />
                        <label
                          htmlFor="shipped-without-tracking-filter"
                          className="text-sm cursor-pointer"
                        >
                          Show shipped without tracking only
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Warehouse Status, Sort and Page Size */}
            <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
              {/* Warehouse Status Dropdown */}
              <div className="flex items-center gap-2 relative" ref={warehouseStatusDropdownRef}>
                <span className="text-sm font-semibold">Warehouse Status:</span>
                <div className="relative">
                  <button 
                    onClick={() => setWarehouseStatusDropdownOpen(!warehouseStatusDropdownOpen)}
                    className="px-3 py-2 border rounded-md text-sm hover-elevate active-elevate-2 flex items-center gap-2 bg-background"
                    data-testid="button-warehouse-status-dropdown"
                  >
                    {shipmentStatus.length > 0 ? `${shipmentStatus.length} selected` : "All"}
                    <ChevronDown className={`h-4 w-4 transition-transform ${warehouseStatusDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {warehouseStatusDropdownOpen && (
                    <div className="absolute left-0 mt-1 w-48 bg-background border rounded-md shadow-lg z-50 p-2 space-y-2">
                      {shipmentStatuses.map(s => {
                        const value = s ?? "null";
                        const label = s ?? "No Status";
                        return (
                          <div key={value} className="flex items-center gap-2">
                            <Checkbox
                              id={`warehouse-status-${value}`}
                              checked={shipmentStatus.includes(value)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setShipmentStatus([...shipmentStatus, value]);
                                } else {
                                  setShipmentStatus(shipmentStatus.filter(v => v !== value));
                                }
                                setPage(1);
                              }}
                              data-testid={`checkbox-warehouse-status-${value}`}
                            />
                            <label htmlFor={`warehouse-status-${value}`} className="text-sm cursor-pointer">
                              {label}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Sort Options */}
              <div className="flex items-center gap-2">
                <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Sort by:</span>
                <Select value={sortBy} onValueChange={(val) => { setSortBy(val); setPage(1); }}>
                  <SelectTrigger className="w-40" data-testid="select-sort-by">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="orderDate" data-testid="sort-option-orderDate">Order Date</SelectItem>
                    <SelectItem value="createdAt" data-testid="sort-option-createdAt">Created Date</SelectItem>
                    <SelectItem value="shipDate" data-testid="sort-option-shipDate">Ship Date</SelectItem>
                    <SelectItem value="trackingNumber" data-testid="sort-option-trackingNumber">Tracking #</SelectItem>
                    <SelectItem value="status" data-testid="sort-option-status">Status</SelectItem>
                    <SelectItem value="carrierCode" data-testid="sort-option-carrierCode">Carrier</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortOrder} onValueChange={(val) => { setSortOrder(val); setPage(1); }}>
                  <SelectTrigger className="w-32" data-testid="select-sort-order">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc" data-testid="sort-order-desc">Newest</SelectItem>
                    <SelectItem value="asc" data-testid="sort-order-asc">Oldest</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm font-semibold">Show:</span>
                <Select value={pageSize.toString()} onValueChange={(val) => { setPageSize(parseInt(val)); setPage(1); }}>
                  <SelectTrigger className="w-24" data-testid="select-page-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25" data-testid="page-size-25">25</SelectItem>
                    <SelectItem value="50" data-testid="page-size-50">50</SelectItem>
                    <SelectItem value="100" data-testid="page-size-100">100</SelectItem>
                    <SelectItem value="200" data-testid="page-size-200">200</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Shipments List - Explicit branching for loading, error, empty, and success states */}
        {isLoading ? (
          <div className="text-center py-12">
            <Truck className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
            <p className="text-muted-foreground text-lg">Loading shipments...</p>
          </div>
        ) : isError ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Truck className="h-16 w-16 text-destructive mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Failed to load shipments</h3>
              <p className="text-muted-foreground mb-4">
                {error instanceof Error ? error.message : "An error occurred while fetching shipments"}
              </p>
              <Button
                variant="outline"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/shipments"] })}
                data-testid="button-retry-shipments"
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : shipments.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Truck className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No shipments found</h3>
              <p className="text-muted-foreground">
                {activeFiltersCount > 0
                  ? "Try adjusting your filters or clearing them to see more results"
                  : activeTab === 'in_progress'
                  ? "No orders are currently being picked"
                  : activeTab === 'packing_queue'
                  ? "No orders are ready for packing"
                  : activeTab === 'shipped'
                  ? "No shipped orders match your criteria"
                  : "Shipments will appear here when orders are fulfilled through ShipStation"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Results Summary and Pagination - Only shown in success state */}
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground" data-testid="text-results-summary">
                Showing {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, total)} of {total.toLocaleString()} shipments
              </p>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm px-2" data-testid="text-page-info">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-next-page"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>

            {/* Shipment Cards */}
            <div className="grid gap-4">
              {shipments.map((shipment) => (
                <ShipmentCard 
                  key={shipment.id} 
                  shipment={shipment} 
                  tags={batchTagsData?.[shipment.id]}
                />
              ))}
            </div>

            {/* Bottom Pagination - Only shown in success state */}
            <div className="flex items-center justify-between pt-4">
              <p className="text-muted-foreground">
                Showing {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, total)} of {total.toLocaleString()} shipments
              </p>
              
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  data-testid="button-prev-page-bottom"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm px-2">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  data-testid="button-next-page-bottom"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
