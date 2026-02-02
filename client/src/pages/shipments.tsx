import { useState, useEffect, useRef, useMemo } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Search, Truck, Package, ChevronDown, ChevronUp, Filter, X, ArrowUpDown, ChevronLeft, ChevronRight, PackageOpen, Clock, MapPin, User, Mail, Phone, Scale, Hash, Boxes, Play, CheckCircle, Timer, AlertTriangle, Zap, Ban } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, ShipmentItem, ShipmentTag, ShipmentPackage } from "@shared/schema";
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
  readyToFulfill: number;
  readyToSession: number;
  inProgress: number;
  shipped: number;
  all: number;
}

interface LifecycleTabCounts {
  all: number;
  readyToFulfill: number;
  readyToSession: number;
  readyToPick: number;
  picking: number;
  packingReady: number;
  onDock: number;
  pickingIssues: number;
}

type WorkflowTab = 'ready_to_fulfill' | 'in_progress' | 'shipped' | 'all';
type LifecycleTab = 'ready_to_session' | 'ready_to_pick' | 'picking' | 'packing_ready' | 'on_dock' | 'picking_issues';
type ViewMode = 'workflow' | 'lifecycle';

interface CacheStatus {
  orderNumber: string;
  isWarmed: boolean;
  warmedAt: string | null;
}

// Special package name that indicates a shipment should NOT be shipped and requires manager alert
const DO_NOT_SHIP_PACKAGE = "**DO NOT SHIP (ALERT MGR)**";

// Lifecycle phase descriptions for popover explanations
const LIFECYCLE_PHASE_INFO: Record<string, { title: string; description: string; nextSteps: string }> = {
  on_dock: {
    title: "On the Dock",
    description: "This order has a shipping label printed and is ready for carrier pickup. The package is physically on the dock waiting to be scanned by the carrier.",
    nextSteps: "Wait for carrier to pick up and scan the package. Status will update to 'In Transit' once scanned."
  },
  picking_issues: {
    title: "Picking Issues",
    description: "There was a problem during the picking process. This could be due to missing inventory, damaged items, or picker-reported issues.",
    nextSteps: "Review the picking notes and resolve the issue. May need to cancel/reroute or wait for inventory."
  },
  packing_ready: {
    title: "Packing Ready",
    description: "All items have been picked and the order is ready to be packed. The picker has completed their session and validated all items.",
    nextSteps: "Take to a packing station, scan to begin packing, then print the shipping label."
  },
  picking: {
    title: "Picking",
    description: "A picker is actively collecting items for this order from the warehouse shelves. The session is in progress.",
    nextSteps: "Wait for the picker to complete the session. They will validate items and mark it ready for packing."
  },
  ready_to_pick: {
    title: "Ready to Pick",
    description: "This order has been assigned to a fulfillment session and is waiting for a picker to start. The session is created but not yet active.",
    nextSteps: "A picker will start the session on their device and begin collecting items."
  },
  ready_to_fulfill: {
    title: "Ready to Fulfill",
    description: "This order has the MOVE OVER tag but is still on hold in ShipStation. It's waiting to be released before fulfillment can begin.",
    nextSteps: "Wait for the order to be released from hold in ShipStation. Once released, it will move to Ready to Session."
  },
  ready_to_session: {
    title: "Ready to Session",
    description: "This order has all required information (fingerprint, packaging) and is ready to be added to a fulfillment session for picking.",
    nextSteps: "Use the Session Builder to create a new session including this order."
  },
  needs_categorization: {
    title: "Needs Categorization",
    description: "One or more products in this order haven't been categorized yet. We need to know if items are kits (need QC explosion) or assembled products.",
    nextSteps: "Categorize the products on the Products page, then the order will progress automatically."
  },
  needs_fingerprint: {
    title: "Needs Fingerprint",
    description: "The order's fingerprint (unique combination of SKUs and quantities) hasn't been calculated yet. This is needed to determine packaging.",
    nextSteps: "The system will automatically calculate fingerprints. If stuck, check for product data issues."
  },
  needs_packaging: {
    title: "Needs Packaging",
    description: "The order fingerprint exists but no packaging assignment has been made. We don't know what box or bag size to use.",
    nextSteps: "Assign packaging for this fingerprint on the Packaging page, or pack a similar order to auto-assign."
  },
  needs_session: {
    title: "Needs Session",
    description: "The order is ready for fulfillment but hasn't been added to a picking session yet.",
    nextSteps: "Include this order in a new fulfillment session using the Session Builder."
  },
  ready_for_skuvault: {
    title: "Ready for SkuVault",
    description: "All prerequisites are met and the order is ready to be synced to SkuVault for wave picking.",
    nextSteps: "The system will sync this to SkuVault automatically, or manually trigger a sync."
  },
  delivered: {
    title: "Delivered",
    description: "The carrier has confirmed delivery to the customer's address. The order fulfillment is complete.",
    nextSteps: "No action needed. Order is complete."
  },
  processing: {
    title: "Processing",
    description: "The order is being processed but hasn't reached a specific lifecycle stage yet. This is a transitional state.",
    nextSteps: "The system is working on this order. Check back shortly for an updated status."
  }
};

// Helper to check if any package is a DO NOT SHIP package
function hasDoNotShipPackage(packages?: ShipmentPackage[]): boolean {
  if (!packages || packages.length === 0) return false;
  return packages.some(pkg => pkg.packageName === DO_NOT_SHIP_PACKAGE);
}

function ShipmentCard({ shipment, tags, packages, cacheStatus }: { shipment: ShipmentWithItemCount; tags?: ShipmentTag[]; packages?: ShipmentPackage[]; cacheStatus?: CacheStatus }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [, setLocation] = useLocation();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  
  const shipmentIdOrUuid = shipment.shipmentId ?? shipment.id;
  const sessionInfo = parseCustomField2(shipment.customField2);
  
  // Check if this shipment has the DO NOT SHIP package
  const isDoNotShip = hasDoNotShipPackage(packages);

  // Determine if this order is ready to pack (closed session, no tracking, pending status)
  // Must match cache warmer criteria: sessionStatus='closed', no tracking, shipmentStatus='pending'
  const isReadyToPack = shipment.sessionStatus?.toLowerCase() === 'closed' 
    && !shipment.trackingNumber 
    && shipment.shipmentStatus === 'pending';
  
  const getCacheStatusBadge = () => {
    if (!isReadyToPack) return null;
    
    if (cacheStatus?.isWarmed) {
      return (
        <Badge className="bg-green-600/20 text-green-700 dark:text-green-400 border border-green-500/30 text-xs gap-1" data-testid={`badge-cache-warmed-${shipment.orderNumber}`}>
          <Zap className="h-3 w-3" />
          Cache Ready
        </Badge>
      );
    }
    
    return (
      <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 text-xs gap-1" data-testid={`badge-cache-cold-${shipment.orderNumber}`}>
        <Clock className="h-3 w-3" />
        Warming...
      </Badge>
    );
  };

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
      // Raw ShipStation tracking codes (UPPERCASE - matches production)
      "DE": { variant: "default", className: "bg-green-600 hover:bg-green-700", label: "Delivered" },
      "IT": { variant: "default", className: "bg-blue-600 hover:bg-blue-700", label: "In Transit" },
      "AC": { variant: "default", className: "bg-cyan-600 hover:bg-cyan-700", label: "Accepted" },
      "SP": { variant: "default", className: "bg-green-500 hover:bg-green-600", label: "Delivered (Locker)" },
      "AT": { variant: "default", className: "bg-orange-500 hover:bg-orange-600", label: "Attempted Delivery" },
      "EX": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400", label: "Exception" },
      "UN": { variant: "outline", className: "border-gray-500 text-gray-700 dark:text-gray-400", label: "Unknown" },
      // Legacy/normalized values for backwards compatibility
      "delivered": { variant: "default", className: "bg-green-600 hover:bg-green-700", label: "Delivered" },
      "in_transit": { variant: "default", className: "bg-blue-600 hover:bg-blue-700", label: "In Transit" },
      "shipped": { variant: "secondary", label: "Shipped" },
      "pending": { variant: "outline", className: "border-gray-500 text-gray-700 dark:text-gray-400", label: "Awaiting Label" },
      "cancelled": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400", label: "Cancelled" },
    };

    // Try exact match first, then uppercase, then lowercase for resilience
    const config = statusConfig[status] || statusConfig[status.toUpperCase()] || statusConfig[status.toLowerCase()] || { variant: "outline" as const, label: status };
    
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

  // Helper to wrap a badge in a popover with phase information
  const wrapBadgeWithPopover = (phaseKey: string, badge: JSX.Element) => {
    const info = LIFECYCLE_PHASE_INFO[phaseKey];
    if (!info) return badge;
    
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="cursor-pointer" data-testid={`popover-trigger-${shipment.orderNumber}`}>
            {badge}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-3">
            <h4 className="font-semibold text-sm">{info.title}</h4>
            <p className="text-sm text-muted-foreground">{info.description}</p>
            <div className="pt-2 border-t">
              <p className="text-xs font-medium text-foreground">Next Steps:</p>
              <p className="text-xs text-muted-foreground mt-1">{info.nextSteps}</p>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  // Get the lifecycle phase badge based on stored lifecyclePhase and decisionSubphase fields
  const getWorkflowStepBadge = () => {
    const lifecyclePhase = shipment.lifecyclePhase;
    const decisionSubphaseValue = shipment.decisionSubphase;
    const sessionStatus = shipment.sessionStatus?.toLowerCase();
    const hasTracking = !!shipment.trackingNumber;
    const status = shipment.status?.toUpperCase();
    
    // Priority 1: Check for terminal states first (Delivered)
    if (status === 'DE' || status === 'DELIVERED') {
      const badge = (
        <Badge className="bg-green-700 hover:bg-green-800 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
          <CheckCircle className="h-3 w-3" />
          Delivered
        </Badge>
      );
      return wrapBadgeWithPopover('delivered', badge);
    }
    
    // Priority 2: Use stored lifecycle phase for proper badge display
    switch (lifecyclePhase) {
      case 'ready_to_fulfill': {
        const badge = (
          <Badge className="bg-slate-600 hover:bg-slate-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Timer className="h-3 w-3" />
            Ready to Fulfill
          </Badge>
        );
        return wrapBadgeWithPopover('ready_to_fulfill', badge);
      }
      
      case 'on_dock': {
        const badge = (
          <Badge className="bg-blue-600 hover:bg-blue-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Truck className="h-3 w-3" />
            On the Dock
          </Badge>
        );
        return wrapBadgeWithPopover('on_dock', badge);
      }
      
      case 'picking_issues': {
        const badge = (
          <Badge className="bg-orange-600 hover:bg-orange-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <AlertTriangle className="h-3 w-3" />
            Picking Issues
          </Badge>
        );
        return wrapBadgeWithPopover('picking_issues', badge);
      }
      
      case 'packing_ready': {
        const badge = (
          <Badge className="bg-purple-600 hover:bg-purple-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Package className="h-3 w-3" />
            Packing Ready
          </Badge>
        );
        return wrapBadgeWithPopover('packing_ready', badge);
      }
      
      case 'picking': {
        const badge = (
          <Badge className="bg-cyan-600 hover:bg-cyan-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Play className="h-3 w-3" />
            Picking
          </Badge>
        );
        return wrapBadgeWithPopover('picking', badge);
      }
      
      case 'ready_to_pick': {
        const badge = (
          <Badge className="bg-yellow-600 hover:bg-yellow-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Timer className="h-3 w-3" />
            Ready to Pick
          </Badge>
        );
        return wrapBadgeWithPopover('ready_to_pick', badge);
      }
      
      case 'ready_to_session': {
        const badge = (
          <Badge className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Clock className="h-3 w-3" />
            Ready to Session
          </Badge>
        );
        return wrapBadgeWithPopover('ready_to_session', badge);
      }
      
      case 'awaiting_decisions':
        // Show decision subphase within awaiting_decisions
        switch (decisionSubphaseValue) {
          case 'needs_categorization': {
            const badge = (
              <Badge className="bg-rose-600 hover:bg-rose-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <AlertTriangle className="h-3 w-3" />
                Needs Categorization
              </Badge>
            );
            return wrapBadgeWithPopover('needs_categorization', badge);
          }
          case 'needs_fingerprint': {
            const badge = (
              <Badge className="bg-amber-600 hover:bg-amber-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <Clock className="h-3 w-3" />
                Needs Fingerprint
              </Badge>
            );
            return wrapBadgeWithPopover('needs_fingerprint', badge);
          }
          case 'needs_packaging': {
            const badge = (
              <Badge className="bg-orange-500 hover:bg-orange-600 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <Package className="h-3 w-3" />
                Needs Packaging
              </Badge>
            );
            return wrapBadgeWithPopover('needs_packaging', badge);
          }
          case 'needs_session': {
            const badge = (
              <Badge className="bg-indigo-500 hover:bg-indigo-600 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <Clock className="h-3 w-3" />
                Needs Session
              </Badge>
            );
            return wrapBadgeWithPopover('needs_session', badge);
          }
          case 'ready_for_skuvault': {
            const badge = (
              <Badge className="bg-teal-600 hover:bg-teal-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <CheckCircle className="h-3 w-3" />
                Ready for SkuVault
              </Badge>
            );
            return wrapBadgeWithPopover('ready_for_skuvault', badge);
          }
          default: {
            const badge = (
              <Badge className="bg-gray-500 hover:bg-gray-600 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
                <Clock className="h-3 w-3" />
                Awaiting Decisions
              </Badge>
            );
            return wrapBadgeWithPopover('processing', badge);
          }
        }
      
      default:
        // Fallback for shipments without lifecycle phase set
        // Use session-based derivation for backwards compatibility
        if (sessionStatus === 'closed' && !hasTracking) {
          const badge = (
            <Badge className="bg-purple-600 hover:bg-purple-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
              <Package className="h-3 w-3" />
              Packing Ready
            </Badge>
          );
          return wrapBadgeWithPopover('packing_ready', badge);
        }
        if (sessionStatus === 'active') {
          const badge = (
            <Badge className="bg-cyan-600 hover:bg-cyan-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
              <Play className="h-3 w-3" />
              Picking
            </Badge>
          );
          return wrapBadgeWithPopover('picking', badge);
        }
        if (sessionStatus === 'new') {
          const badge = (
            <Badge className="bg-yellow-600 hover:bg-yellow-700 text-white text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
              <Timer className="h-3 w-3" />
              Ready to Pick
            </Badge>
          );
          return wrapBadgeWithPopover('ready_to_pick', badge);
        }
        const fallbackBadge = (
          <Badge variant="outline" className="border-gray-400 text-gray-600 dark:text-gray-400 text-xs gap-1" data-testid={`badge-workflow-${shipment.orderNumber}`}>
            <Clock className="h-3 w-3" />
            Processing
          </Badge>
        );
        return wrapBadgeWithPopover('processing', fallbackBadge);
    }
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
                <div className="flex items-center gap-2 text-sm font-semibold flex-wrap">
                  <Boxes className="h-4 w-4 text-primary" />
                  <span>Session Info</span>
                  {getSessionStatusBadge(shipment.sessionStatus)}
                  {getCacheStatusBadge()}
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

            {/* Packages */}
            {packages && packages.length > 0 && (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <Boxes className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  {packages.slice(0, 3).map((pkg, index) => {
                    const hasSize = pkg.dimensionLength && pkg.dimensionWidth && pkg.dimensionHeight &&
                      (parseFloat(pkg.dimensionLength) > 0 || parseFloat(pkg.dimensionWidth) > 0 || parseFloat(pkg.dimensionHeight) > 0);
                    const sizeStr = hasSize 
                      ? `${pkg.dimensionLength}x${pkg.dimensionWidth}x${pkg.dimensionHeight} ${pkg.dimensionUnit || ''}`
                      : (pkg.weightValue && pkg.weightUnit ? `${pkg.weightValue} ${pkg.weightUnit}` : '');
                    const displayStr = [pkg.packageName || 'Package', sizeStr].filter(Boolean).join(', ');
                    
                    return (
                      <span key={pkg.id || index} data-testid={`text-package-${index}`}>
                        {displayStr}
                      </span>
                    );
                  })}
                  {packages.length > 3 && (
                    <span className="text-xs text-muted-foreground">+{packages.length - 3} more</span>
                  )}
                </div>
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

            {/* Workflow Step Badge */}
            <div className="flex flex-col gap-1.5 lg:items-end">
              {getWorkflowStepBadge()}
            </div>

            {/* Status & Special Handling Badges */}
            <div className="flex flex-wrap items-center justify-end gap-2 w-full">
              {/* DO NOT SHIP Badge - Critical alert, show first */}
              {isDoNotShip && (
                <Badge className="bg-red-700 hover:bg-red-800 text-white text-xs gap-1 animate-pulse" data-testid={`badge-do-not-ship-${shipment.orderNumber}`}>
                  <AlertTriangle className="h-3 w-3" />
                  DO NOT SHIP
                </Badge>
              )}
              {/* Cancelled Badge */}
              {(shipment.status === 'cancelled' || shipment.shipmentStatus === 'cancelled') && (
                <Badge className="bg-red-600 hover:bg-red-700 text-white text-xs gap-1" data-testid={`badge-cancelled-${shipment.orderNumber}`}>
                  <Ban className="h-3 w-3" />
                  Cancelled
                </Badge>
              )}
              {isOrphanedShipment(shipment) && (
                <Badge variant="outline" className="border-orange-500 text-orange-700 dark:text-orange-400 text-xs">
                  Orphaned
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
  const [packageTypeDropdownOpen, setPackageTypeDropdownOpen] = useState(false);
  const packageTypeDropdownRef = useRef<HTMLDivElement>(null);
  const [carrierDropdownOpen, setCarrierDropdownOpen] = useState(false);
  const carrierDropdownRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');

  // View mode and tab state - Default to "All" view (workflow mode with tab=all)
  const [viewMode, setViewMode] = useState<ViewMode>('workflow');
  const [activeTab, setActiveTab] = useState<WorkflowTab>('all');
  const [activeLifecycleTab, setActiveLifecycleTab] = useState<LifecycleTab>('ready_to_pick');

  // Filter states
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(""); // Single status for cascading filter
  const [statusDescription, setStatusDescription] = useState<string>("");
  const [shipmentStatus, setShipmentStatus] = useState<string[]>([]); // Warehouse status filter (multi-select)
  const [carrierCode, setCarrierCode] = useState<string[]>([]);
  const [serviceCode, setServiceCode] = useState<string[]>([]); // Shipping service filter (multi-select)
  const [packageName, setPackageName] = useState<string[]>([]); // Package type filter (multi-select)
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [showWithoutOrders, setShowWithoutOrders] = useState(false);
  const [showShippedWithoutTracking, setShowShippedWithoutTracking] = useState(false);
  const [showDoNotShipOnly, setShowDoNotShipOnly] = useState(false);
  const [showNeedsManualPackage, setShowNeedsManualPackage] = useState(false);
  
  // Sessioning-related filter states
  const [hasFingerprint, setHasFingerprint] = useState<string>(""); // "", "true", "false"
  const [decisionSubphase, setDecisionSubphase] = useState<string>("");
  const [hasPackaging, setHasPackaging] = useState<string>(""); // "", "true", "false"
  const [assignedStationId, setAssignedStationId] = useState<string>("");
  const [hasSession, setHasSession] = useState<string>(""); // "", "true", "false"
  const [lifecyclePhaseFilter, setLifecyclePhaseFilter] = useState<string>("");

  // Pagination and sorting
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sortBy, setSortBy] = useState("orderDate");
  const [sortOrder, setSortOrder] = useState("desc");

  // Valid values for URL hydration
  const validWorkflowTabs: WorkflowTab[] = ['ready_to_fulfill', 'in_progress', 'shipped', 'all'];
  const validLifecycleTabs: LifecycleTab[] = ['ready_to_session', 'ready_to_pick', 'picking', 'packing_ready', 'on_dock', 'picking_issues'];
  const validViewModes: ViewMode[] = ['workflow', 'lifecycle'];

  // Initialize state from URL params (runs when URL changes, including browser navigation)
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    // Skip if this is the same URL we just synced to avoid loops
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    // Hydrate viewMode from URL (default to lifecycle)
    const urlViewMode = params.get('viewMode') as ViewMode | null;
    const urlTab = params.get('tab') as WorkflowTab | null;
    
    // Determine view mode: if tab=all, force workflow mode; otherwise use URL viewMode or default to lifecycle
    let hydratedViewMode: ViewMode;
    let hydratedTab: WorkflowTab;
    
    if (urlTab === 'all') {
      // "All" view is always workflow mode with tab=all
      hydratedViewMode = 'workflow';
      hydratedTab = 'all';
    } else if (urlViewMode && validViewModes.includes(urlViewMode)) {
      hydratedViewMode = urlViewMode;
      // Only set tab for workflow mode, ignore for lifecycle
      hydratedTab = hydratedViewMode === 'workflow' && urlTab && validWorkflowTabs.includes(urlTab) 
        ? urlTab 
        : 'in_progress';
    } else {
      // Default to "All" view (workflow mode with tab=all)
      hydratedViewMode = 'workflow';
      hydratedTab = 'all';
    }
    
    setViewMode(hydratedViewMode);
    setActiveTab(hydratedTab);
    
    // Hydrate lifecycleTab with validation (map legacy 'all' to 'ready_to_pick')
    const urlLifecycleTab = params.get('lifecycleTab');
    const hydratedLifecycleTab = urlLifecycleTab && validLifecycleTabs.includes(urlLifecycleTab as LifecycleTab) 
      ? urlLifecycleTab as LifecycleTab 
      : 'ready_to_pick';
    setActiveLifecycleTab(hydratedLifecycleTab);
    
    setSearch(params.get('search') || '');
    setStatus(params.get('status') || ''); // Single status value
    setStatusDescription(params.get('statusDescription') || '');
    const shipmentStatusValues = params.getAll('shipmentStatus');
    setShipmentStatus(shipmentStatusValues);
    setCarrierCode(params.getAll('carrierCode'));
    setServiceCode(params.getAll('serviceCode'));
    setPackageName(params.getAll('packageName'));
    setDateFrom(params.get('dateFrom') || '');
    setDateTo(params.get('dateTo') || '');
    setShowOrphanedOnly(params.get('orphaned') === 'true');
    setShowWithoutOrders(params.get('withoutOrders') === 'true');
    setShowShippedWithoutTracking(params.get('shippedWithoutTracking') === 'true');
    setShowDoNotShipOnly(params.get('doNotShip') === 'true');
    setShowNeedsManualPackage(params.get('needsManualPackage') === 'true');
    
    // Sessioning-related filters
    setHasFingerprint(params.get('hasFingerprint') || '');
    setDecisionSubphase(params.get('decisionSubphase') || '');
    setHasPackaging(params.get('hasPackaging') || '');
    setAssignedStationId(params.get('assignedStationId') || '');
    setHasSession(params.get('hasSession') || '');
    setLifecyclePhaseFilter(params.get('lifecyclePhaseFilter') || '');
    
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
      params.getAll('packageName').length ||
      params.get('dateFrom') ||
      params.get('dateTo') ||
      params.get('orphaned') === 'true' ||
      params.get('withoutOrders') === 'true' ||
      params.get('shippedWithoutTracking') === 'true' ||
      params.get('doNotShip') === 'true' ||
      params.get('hasFingerprint') ||
      params.get('decisionSubphase') ||
      params.get('hasPackaging') ||
      params.get('assignedStationId') ||
      params.get('hasSession') ||
      params.get('lifecyclePhaseFilter');
    
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
    
    // Include viewMode only when not the default "All" view (workflow with tab=all)
    // "All" view is the default, so we only add params for lifecycle or non-all workflow tabs
    const isDefaultAllView = viewMode === 'workflow' && activeTab === 'all';
    
    if (viewMode === 'lifecycle') {
      params.set('viewMode', 'lifecycle');
      // Include lifecycleTab only when not the default
      if (activeLifecycleTab !== 'ready_to_pick') {
        params.set('lifecycleTab', activeLifecycleTab);
      }
    } else if (viewMode === 'workflow' && activeTab !== 'all') {
      // Workflow mode but not "all" tab
      params.set('viewMode', 'workflow');
      params.set('tab', activeTab);
    }
    // If isDefaultAllView, we don't add viewMode or tab params (clean URL)
    if (search) params.set('search', search);
    if (status) params.set('status', status); // Single status value
    if (statusDescription) params.set('statusDescription', statusDescription);
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    serviceCode.forEach(s => params.append('serviceCode', s));
    packageName.forEach(p => params.append('packageName', p));
    
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    if (showOrphanedOnly) params.set('orphaned', 'true');
    if (showWithoutOrders) params.set('withoutOrders', 'true');
    if (showShippedWithoutTracking) params.set('shippedWithoutTracking', 'true');
    if (showDoNotShipOnly) params.set('doNotShip', 'true');
    if (showNeedsManualPackage) params.set('needsManualPackage', 'true');
    
    // Sessioning-related filters
    if (hasFingerprint) params.set('hasFingerprint', hasFingerprint);
    if (decisionSubphase) params.set('decisionSubphase', decisionSubphase);
    if (hasPackaging) params.set('hasPackaging', hasPackaging);
    if (assignedStationId) params.set('assignedStationId', assignedStationId);
    if (hasSession) params.set('hasSession', hasSession);
    if (lifecyclePhaseFilter) params.set('lifecyclePhaseFilter', lifecyclePhaseFilter);
    
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
  }, [viewMode, activeTab, activeLifecycleTab, search, status, statusDescription, shipmentStatus, carrierCode, packageName, dateFrom, dateTo, showOrphanedOnly, showWithoutOrders, showShippedWithoutTracking, showDoNotShipOnly, showNeedsManualPackage, page, pageSize, sortBy, sortOrder, isInitialized]);

  // Close warehouse status dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (warehouseStatusDropdownRef.current && !warehouseStatusDropdownRef.current.contains(event.target as Node)) {
        setWarehouseStatusDropdownOpen(false);
      }
      if (packageTypeDropdownRef.current && !packageTypeDropdownRef.current.contains(event.target as Node)) {
        setPackageTypeDropdownOpen(false);
      }
      if (carrierDropdownRef.current && !carrierDropdownRef.current.contains(event.target as Node)) {
        setCarrierDropdownOpen(false);
      }
    };

    if (warehouseStatusDropdownOpen || packageTypeDropdownOpen || carrierDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [warehouseStatusDropdownOpen, packageTypeDropdownOpen, carrierDropdownOpen]);

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
            // Also refresh tab counts so numbers match when clicking into tabs
            queryClient.invalidateQueries({ queryKey: ["/api/shipments/tab-counts"] });
            queryClient.invalidateQueries({ queryKey: ["/api/shipments/lifecycle-counts"] });
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
    
    // Add tab filter based on view mode
    if (viewMode === 'workflow') {
      params.append('workflowTab', activeTab);
    } else {
      params.append('lifecycleTab', activeLifecycleTab);
    }
    
    if (search) params.append('search', search);
    if (status) params.append('status', status); // Single status value
    if (statusDescription) params.append('statusDescription', statusDescription);
    shipmentStatus.forEach(s => params.append('shipmentStatus', s));
    carrierCode.forEach(c => params.append('carrierCode', c));
    serviceCode.forEach(s => params.append('serviceCode', s));
    packageName.forEach(p => params.append('packageName', p));
    
    if (dateFrom) params.append('dateFrom', dateFrom);
    if (dateTo) params.append('dateTo', dateTo);
    if (showOrphanedOnly) params.append('orphaned', 'true');
    if (showWithoutOrders) params.append('withoutOrders', 'true');
    if (showShippedWithoutTracking) params.append('shippedWithoutTracking', 'true');
    if (showDoNotShipOnly) params.append('doNotShip', 'true');
    if (showNeedsManualPackage) params.append('needsManualPackage', 'true');
    
    // Sessioning-related filters
    if (hasFingerprint) params.append('hasFingerprint', hasFingerprint);
    if (decisionSubphase) params.append('decisionSubphase', decisionSubphase);
    if (hasPackaging) params.append('hasPackaging', hasPackaging);
    if (assignedStationId) params.append('assignedStationId', assignedStationId);
    if (hasSession) params.append('hasSession', hasSession);
    if (lifecyclePhaseFilter) params.append('lifecyclePhaseFilter', lifecyclePhaseFilter);
    
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

  const tabCounts = tabCountsData || { readyToFulfill: 0, readyToSession: 0, inProgress: 0, shipped: 0, all: 0 };

  // Fetch lifecycle tab counts
  const { data: lifecycleCountsData } = useQuery<LifecycleTabCounts>({
    queryKey: ["/api/shipments/lifecycle-counts"],
  });

  const lifecycleCounts = lifecycleCountsData || { all: 0, readyToFulfill: 0, readyToSession: 0, readyToPick: 0, picking: 0, packingReady: 0, onDock: 0, pickingIssues: 0 };

  // Fetch stations for the station filter dropdown
  const { data: stationsData } = useQuery<{ id: string; name: string; stationType: string }[]>({
    queryKey: ["/api/stations"],
  });

  const stations = Array.isArray(stationsData) ? stationsData : [];

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

  // Fetch distinct package names for the package type filter dropdown
  const { data: packageNamesData } = useQuery<{ packageNames: string[] }>({
    queryKey: ["/api/shipments/package-names"],
  });

  const packageNames = packageNamesData?.packageNames || [];

  // Fetch distinct service codes for the carrier/shipping method filter dropdown
  const { data: serviceCodesData } = useQuery<{ serviceCodes: string[] }>({
    queryKey: ["/api/shipments/service-codes"],
  });

  const serviceCodes = serviceCodesData?.serviceCodes || [];

  // Utility function to format service codes nicely
  const formatServiceCode = (code: string): string => {
    // Extract carrier prefix and format
    const parts = code.split('_');
    if (parts.length === 0) return code;
    
    // First part is typically the carrier
    const carrier = parts[0].toUpperCase();
    const service = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    
    return `${carrier} ${service}`.trim();
  };

  // Get carrier from service code for grouping
  const getCarrierFromServiceCode = (code: string): string => {
    const carrier = code.split('_')[0]?.toUpperCase() || 'OTHER';
    return carrier;
  };

  const { data: shipmentsData, isLoading, isError, error } = useQuery<ShipmentsResponse>({
    queryKey: ["/api/shipments", { viewMode, activeTab, activeLifecycleTab, search, status, statusDescription, shipmentStatus, carrierCode, serviceCode, packageName, dateFrom, dateTo, showOrphanedOnly, showWithoutOrders, showShippedWithoutTracking, showDoNotShipOnly, showNeedsManualPackage, hasFingerprint, decisionSubphase, hasPackaging, assignedStationId, hasSession, lifecyclePhaseFilter, page, pageSize, sortBy, sortOrder }],
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

  // Batch fetch packages for all shipments
  const { data: batchPackagesData } = useQuery<Record<string, ShipmentPackage[]>>({
    queryKey: ["/api/shipments/packages/batch", shipmentIds],
    queryFn: async () => {
      if (shipmentIds.length === 0) return {};
      const response = await apiRequest("POST", "/api/shipments/packages/batch", { shipmentIds });
      return response.json();
    },
    enabled: shipmentIds.length > 0,
  });

  // Get order numbers for orders ready to pack (closed session, no tracking, pending status)
  // Must match cache warmer criteria exactly for cache status to be in sync
  const orderNumbersReadyToPack = useMemo(() => {
    return shipments
      .filter(s => s.sessionStatus?.toLowerCase() === 'closed' 
        && !s.trackingNumber 
        && s.shipmentStatus === 'pending'
        && s.orderNumber)
      .map(s => s.orderNumber as string);
  }, [shipments]);
  
  // Only fetch cache status when viewing packing-related tabs
  const shouldFetchCacheStatus = 
    (viewMode === 'lifecycle' && activeLifecycleTab === 'packing_ready');

  // API returns { statuses: { [orderNumber]: { isWarmed: boolean; warmedAt: number | null } } }
  type CacheStatusResponse = {
    statuses: Record<string, { isWarmed: boolean; warmedAt: number | null }>;
  };

  // Batch fetch cache status for orders ready to pack
  // Only runs when viewing packing-related tabs and there are orders to check
  const { data: cacheStatusData } = useQuery<CacheStatusResponse>({
    queryKey: ["/api/operations/warm-cache-status", orderNumbersReadyToPack],
    queryFn: async () => {
      if (orderNumbersReadyToPack.length === 0) return { statuses: {} };
      const response = await apiRequest("POST", "/api/operations/warm-cache-status", { orderNumbers: orderNumbersReadyToPack });
      return response.json();
    },
    enabled: shouldFetchCacheStatus && orderNumbersReadyToPack.length > 0,
    staleTime: 30000, // 30 seconds - cache status doesn't change too frequently
  });

  // Create a map of order number -> cache status for easy lookup
  const cacheStatusMap = useMemo(() => {
    if (!cacheStatusData?.statuses || typeof cacheStatusData.statuses !== 'object') {
      return new Map<string, CacheStatus>();
    }
    // API returns object with order numbers as keys
    const entries = Object.entries(cacheStatusData.statuses).map(([orderNumber, data]) => [
      orderNumber,
      {
        orderNumber,
        isWarmed: data.isWarmed,
        warmedAt: data.warmedAt ? new Date(data.warmedAt).toISOString() : null,
      } as CacheStatus
    ] as [string, CacheStatus]);
    return new Map(entries);
  }, [cacheStatusData]);

  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setStatusDescription("");
    setShipmentStatus([]);
    setCarrierCode([]);
    setServiceCode([]);
    setPackageName([]);
    setDateFrom("");
    setDateTo("");
    setShowOrphanedOnly(false);
    setShowWithoutOrders(false);
    setShowShippedWithoutTracking(false);
    setShowDoNotShipOnly(false);
    setShowNeedsManualPackage(false);
    // Sessioning-related filters
    setHasFingerprint("");
    setDecisionSubphase("");
    setHasPackaging("");
    setAssignedStationId("");
    setHasSession("");
    setLifecyclePhaseFilter("");
    setPage(1);
  };

  const activeFiltersCount = [
    search,
    status,
    statusDescription,
    shipmentStatus.length > 0,
    carrierCode.length > 0,
    serviceCode.length > 0,
    packageName.length > 0,
    dateFrom,
    dateTo,
    showOrphanedOnly,
    showWithoutOrders,
    showShippedWithoutTracking,
    showDoNotShipOnly,
    showNeedsManualPackage,
    hasFingerprint,
    decisionSubphase,
    hasPackaging,
    assignedStationId,
    hasSession,
    lifecyclePhaseFilter,
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
    if (viewMode === 'workflow') {
      setActiveTab(value as WorkflowTab);
      // Clear lifecycle phase filter when in workflow view
      setLifecyclePhaseFilter('');
    } else {
      setActiveLifecycleTab(value as LifecycleTab);
      // Auto-set lifecycle phase filter to match the selected tab
      setLifecyclePhaseFilter(value);
    }
    setPage(1);
  };

  const getTabDescription = () => {
    if (viewMode === 'workflow') {
      switch (activeTab) {
        case 'ready_to_fulfill':
          return 'Orders on hold with MOVE OVER tag - waiting to be released from ShipStation';
        case 'in_progress':
          return 'Orders truly in progress - Ready to Pick + Picking + Packing Ready';
        case 'shipped':
          return 'Orders with labels purchased and in transit to customer';
        case 'all':
          return 'All shipments regardless of status';
      }
    } else {
      switch (activeLifecycleTab) {
        case 'ready_to_pick':
          return 'Orders ready to be picked - session created, waiting to start';
        case 'picking':
          return 'Orders currently being picked in the warehouse (Active sessions)';
        case 'packing_ready':
          return 'Orders ready to pack - picking complete, cache is warmed for fast scanning';
        case 'on_dock':
          return 'Orders on the dock - labeled and waiting for carrier pickup';
        case 'picking_issues':
          return 'Picking issues - sessions stuck or paused, needs supervisor attention';
      }
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

        {/* View Mode Toggle */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant={activeTab === 'all' && viewMode === 'workflow' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setViewMode('workflow');
                setActiveTab('all');
                setActiveLifecycleTab('ready_to_pick'); // Reset lifecycle tab to prevent stale state
                setPage(1);
              }}
              className="gap-2"
              data-testid="button-view-all"
            >
              <Package className="h-4 w-4" />
              All
            </Button>
            <Button
              variant={viewMode === 'lifecycle' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setViewMode('lifecycle');
                setActiveLifecycleTab('ready_to_pick');
                setActiveTab('in_progress'); // Reset workflow tab to prevent stale state
                setPage(1);
              }}
              className="gap-2"
              data-testid="button-view-lifecycle"
            >
              <Zap className="h-4 w-4" />
              Lifecycle View
            </Button>
            <Button
              variant={viewMode === 'workflow' && activeTab !== 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setViewMode('workflow');
                setActiveTab('in_progress');
                setActiveLifecycleTab('ready_to_pick'); // Reset lifecycle tab to prevent stale state
                setPage(1);
              }}
              className="gap-2"
              data-testid="button-view-workflow"
            >
              <Boxes className="h-4 w-4" />
              Workflow View
            </Button>
          </div>
          <p className="text-xs text-muted-foreground hidden md:block">
            {activeTab === 'all' && viewMode === 'workflow'
              ? 'All shipments regardless of status'
              : viewMode === 'lifecycle' 
                ? 'Track orders through warehouse lifecycle stages' 
                : 'Traditional fulfillment workflow view'}
          </p>
        </div>

        {/* Lifecycle Tabs */}
        {viewMode === 'lifecycle' ? (
          <Tabs value={activeLifecycleTab} onValueChange={handleTabChange} className="w-full">
            <div className="overflow-x-auto scrollbar-thin">
              <TabsList className="grid grid-cols-6 w-max sm:w-full h-auto p-1 gap-1">
                <TabsTrigger 
                  value="ready_to_session" 
                  className="flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[95px] sm:min-w-0 data-[state=active]:bg-indigo-600 data-[state=active]:text-white"
                  data-testid="tab-lifecycle-ready-to-session"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <Clock className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Ready to Session</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.readyToSession} orders</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="ready_to_pick" 
                  className="flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[90px] sm:min-w-0 data-[state=active]:bg-blue-600 data-[state=active]:text-white"
                  data-testid="tab-lifecycle-ready-to-pick"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <Timer className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Ready to Pick</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.readyToPick} orders</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="picking" 
                  className="flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[70px] sm:min-w-0 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  data-testid="tab-lifecycle-picking"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <Play className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Picking</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.picking} orders</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="packing_ready" 
                  className="flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[95px] sm:min-w-0 data-[state=active]:bg-green-600 data-[state=active]:text-white"
                  data-testid="tab-lifecycle-packing-ready"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <PackageOpen className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Packing Ready</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.packingReady} orders</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="on_dock" 
                  className="flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[85px] sm:min-w-0 data-[state=active]:bg-purple-600 data-[state=active]:text-white"
                  data-testid="tab-lifecycle-on-dock"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <Truck className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">On the Dock</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.onDock} orders</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="picking_issues" 
                  className={`flex flex-col gap-1 py-2 sm:py-3 px-2 sm:px-4 min-w-[95px] sm:min-w-0 data-[state=active]:bg-amber-600 data-[state=active]:text-white ${lifecycleCounts.pickingIssues > 0 ? 'border-2 border-amber-500' : ''}`}
                  data-testid="tab-lifecycle-picking-issues"
                >
                  <div className="flex items-center gap-1 sm:gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Picking Issues</span>
                  </div>
                  <span className="text-[10px] sm:text-xs opacity-80">{lifecycleCounts.pickingIssues} orders</span>
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
        ) : activeTab === 'all' ? (
          /* All View - no tabs, just show all shipments */
          null
        ) : (
          /* Workflow Tabs */
          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <TabsList className="grid w-full grid-cols-3 h-auto p-1 gap-1">
              <TabsTrigger 
                value="ready_to_fulfill" 
                className="flex flex-col gap-1 py-2 sm:py-3 data-[state=active]:bg-slate-600 data-[state=active]:text-white"
                data-testid="tab-ready-to-fulfill"
              >
                <div className="flex items-center gap-1 sm:gap-2">
                  <Timer className="h-4 w-4 flex-shrink-0" />
                  <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">Ready to Fulfill</span>
                </div>
                <span className="text-[10px] sm:text-xs opacity-80">{tabCounts.readyToFulfill} orders</span>
              </TabsTrigger>
              <TabsTrigger 
                value="in_progress" 
                className="flex flex-col gap-1 py-2 sm:py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                data-testid="tab-in-progress"
              >
                <div className="flex items-center gap-1 sm:gap-2">
                  <Play className="h-4 w-4 flex-shrink-0" />
                  <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">In Progress</span>
                </div>
                <span className="text-[10px] sm:text-xs opacity-80">{tabCounts.inProgress} orders</span>
              </TabsTrigger>
              <TabsTrigger 
                value="shipped" 
                className="flex flex-col gap-1 py-2 sm:py-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                data-testid="tab-shipped"
              >
                <div className="flex items-center gap-1 sm:gap-2">
                  <Truck className="h-4 w-4 flex-shrink-0" />
                  <span className="font-semibold text-[11px] sm:text-sm whitespace-nowrap">On the Way</span>
                </div>
                <span className="text-[10px] sm:text-xs opacity-80">{tabCounts.shipped} orders</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

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
                placeholder="Search by order #, SKU, tracking #, customer name, shipment ID, session ID..."
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

                {/* Shipping Method Filter */}
                {serviceCodes.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Shipping Method</label>
                    <div className="relative" ref={carrierDropdownRef}>
                      <button 
                        onClick={() => setCarrierDropdownOpen(!carrierDropdownOpen)}
                        className="px-3 py-2 border rounded-md text-sm hover-elevate active-elevate-2 flex items-center gap-2 bg-background w-full justify-between"
                        data-testid="button-shipping-method-dropdown"
                      >
                        <span>{serviceCode.length > 0 ? `${serviceCode.length} selected` : "All Shipping Methods"}</span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${carrierDropdownOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {carrierDropdownOpen && (
                        <div className="absolute left-0 mt-1 w-80 bg-background border rounded-md shadow-lg z-50 p-2 space-y-2 max-h-80 overflow-y-auto">
                          {/* Check All / Uncheck All */}
                          <div className="flex gap-2 pb-2 border-b">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setServiceCode([...serviceCodes]);
                                setPage(1);
                              }}
                              data-testid="button-shipping-check-all"
                            >
                              Check All
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setServiceCode([]);
                                setPage(1);
                              }}
                              data-testid="button-shipping-uncheck-all"
                            >
                              Uncheck All
                            </Button>
                          </div>
                          {serviceCodes.map(code => (
                            <div key={code} className="flex items-center gap-2">
                              <Checkbox
                                id={`service-code-${code}`}
                                checked={serviceCode.includes(code)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setServiceCode([...serviceCode, code]);
                                  } else {
                                    setServiceCode(serviceCode.filter(v => v !== code));
                                  }
                                  setPage(1);
                                }}
                                data-testid={`checkbox-service-${code.replace(/\s+/g, '-').toLowerCase()}`}
                              />
                              <label htmlFor={`service-code-${code}`} className="text-sm cursor-pointer">
                                {formatServiceCode(code)}
                              </label>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Package Type Filter */}
                {packageNames.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-semibold">Package Type</label>
                    <div className="relative" ref={packageTypeDropdownRef}>
                      <button 
                        onClick={() => setPackageTypeDropdownOpen(!packageTypeDropdownOpen)}
                        className="px-3 py-2 border rounded-md text-sm hover-elevate active-elevate-2 flex items-center gap-2 bg-background w-full justify-between"
                        data-testid="button-package-type-dropdown"
                      >
                        <span>{packageName.length > 0 ? `${packageName.length} selected` : "All Package Types"}</span>
                        <ChevronDown className={`h-4 w-4 transition-transform ${packageTypeDropdownOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {packageTypeDropdownOpen && (
                        <div className="absolute left-0 mt-1 w-64 bg-background border rounded-md shadow-lg z-50 p-2 space-y-2 max-h-64 overflow-y-auto">
                          {/* Check All / Uncheck All */}
                          <div className="flex gap-2 pb-2 border-b">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPackageName([...packageNames]);
                                setPage(1);
                              }}
                              data-testid="button-package-check-all"
                            >
                              Check All
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPackageName([]);
                                setPage(1);
                              }}
                              data-testid="button-package-uncheck-all"
                            >
                              Uncheck All
                            </Button>
                          </div>
                          {packageNames.map(pkg => (
                            <div key={pkg} className="flex items-center gap-2">
                              <Checkbox
                                id={`package-type-${pkg}`}
                                checked={packageName.includes(pkg)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setPackageName([...packageName, pkg]);
                                  } else {
                                    setPackageName(packageName.filter(v => v !== pkg));
                                  }
                                  setPage(1);
                                }}
                                data-testid={`checkbox-package-${pkg.replace(/\s+/g, '-').toLowerCase()}`}
                              />
                              <label htmlFor={`package-type-${pkg}`} className="text-sm cursor-pointer">
                                {pkg}
                              </label>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

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
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="do-not-ship-filter"
                          checked={showDoNotShipOnly}
                          onCheckedChange={(checked) => {
                            setShowDoNotShipOnly(checked as boolean);
                            setPage(1);
                          }}
                          data-testid="checkbox-do-not-ship-filter"
                        />
                        <label
                          htmlFor="do-not-ship-filter"
                          className="text-sm cursor-pointer text-red-600 dark:text-red-400 font-semibold"
                        >
                          Show DO NOT SHIP only
                        </label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="needs-manual-package-filter"
                          checked={showNeedsManualPackage}
                          onCheckedChange={(checked) => {
                            setShowNeedsManualPackage(checked as boolean);
                            setPage(1);
                          }}
                          data-testid="checkbox-needs-manual-package-filter"
                        />
                        <label
                          htmlFor="needs-manual-package-filter"
                          className="text-sm cursor-pointer text-amber-600 dark:text-amber-400 font-semibold"
                        >
                          Needs Manual Package
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sessioning Filters */}
                <div className="space-y-4 pt-4 border-t">
                  <label className="text-sm font-semibold">Sessioning Filters</label>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Has Fingerprint */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Has Fingerprint</label>
                      <Select 
                        value={hasFingerprint || "all"} 
                        onValueChange={(val) => { 
                          setHasFingerprint(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-has-fingerprint">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Decision Subphase */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Decision Subphase</label>
                      <Select 
                        value={decisionSubphase || "all"} 
                        onValueChange={(val) => { 
                          setDecisionSubphase(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-decision-subphase">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="needs_categorization">Needs Categorization</SelectItem>
                          <SelectItem value="needs_fingerprint">Needs Fingerprint</SelectItem>
                          <SelectItem value="needs_packaging">Needs Packaging</SelectItem>
                          <SelectItem value="needs_session">Needs Session</SelectItem>
                          <SelectItem value="ready_for_skuvault">Ready for SkuVault</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Has Packaging */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Has Packaging</label>
                      <Select 
                        value={hasPackaging || "all"} 
                        onValueChange={(val) => { 
                          setHasPackaging(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-has-packaging">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Assigned Station */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Assigned Station</label>
                      <Select 
                        value={assignedStationId || "all"} 
                        onValueChange={(val) => { 
                          setAssignedStationId(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-assigned-station">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Stations</SelectItem>
                          {stations.map((station) => (
                            <SelectItem key={station.id} value={station.id}>
                              {station.name} ({station.stationType})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* In Session */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">In Session</label>
                      <Select 
                        value={hasSession || "all"} 
                        onValueChange={(val) => { 
                          setHasSession(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-has-session">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="true">Yes</SelectItem>
                          <SelectItem value="false">No</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Lifecycle Phase */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Lifecycle Phase</label>
                      <Select 
                        value={lifecyclePhaseFilter || "all"} 
                        onValueChange={(val) => { 
                          setLifecyclePhaseFilter(val === "all" ? "" : val); 
                          setPage(1); 
                        }}
                      >
                        <SelectTrigger className="w-full" data-testid="select-lifecycle-phase">
                          <SelectValue placeholder="All" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="ready_to_fulfill">Ready to Fulfill</SelectItem>
                          <SelectItem value="ready_to_session">Ready to Session</SelectItem>
                          <SelectItem value="awaiting_decisions">Awaiting Decisions</SelectItem>
                          <SelectItem value="ready_to_pick">Ready to Pick</SelectItem>
                          <SelectItem value="picking">Picking</SelectItem>
                          <SelectItem value="packing_ready">Packing Ready</SelectItem>
                          <SelectItem value="on_dock">On Dock</SelectItem>
                          <SelectItem value="picking_issues">Picking Issues</SelectItem>
                        </SelectContent>
                      </Select>
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
                  : viewMode === 'lifecycle'
                  ? activeLifecycleTab === 'ready_to_session'
                    ? "No orders are waiting to be processed - all shipments have been fingerprinted"
                    : activeLifecycleTab === 'ready_to_pick'
                    ? "No orders are waiting to be picked"
                    : activeLifecycleTab === 'picking'
                    ? "No orders are currently being picked"
                    : activeLifecycleTab === 'packing_ready'
                    ? "No orders are ready for packing"
                    : activeLifecycleTab === 'on_dock'
                    ? "No orders are on the dock waiting for carrier pickup"
                    : activeLifecycleTab === 'picking_issues'
                    ? "No picking issues - all sessions are progressing normally"
                    : "Shipments will appear here when orders are fulfilled"
                  : activeTab === 'in_progress'
                  ? "No orders are currently in progress"
                  : activeTab === 'shipped'
                  ? "No orders are on the way to customers"
                  : activeTab === 'all'
                  ? "Shipments will appear here when orders are fulfilled through ShipStation"
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
                  packages={batchPackagesData?.[shipment.id]}
                  cacheStatus={shipment.orderNumber ? cacheStatusMap.get(shipment.orderNumber) : undefined}
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
