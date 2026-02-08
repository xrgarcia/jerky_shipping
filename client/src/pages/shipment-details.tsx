import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Truck, Package, MapPin, User, Mail, Phone, Clock, Copy, ExternalLink, Calendar, Weight, Gift, AlertTriangle, Boxes, Play, Timer, CheckCircle, FileText, Info, ShoppingCart, PackageCheck, Fingerprint, Hash, MapPinned, Box, ChevronRight, CircleDot, Circle, CheckCircle2, AlertCircle, TrendingDown, DollarSign, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, Order, ShipmentItem, ShipmentTag, ShipmentPackage, ShipmentQcItem, ShipmentRateAnalysis } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { SessionDetailDialog, parseCustomField2 } from "@/components/session-detail-dialog";

interface ShipmentWithOrder extends Shipment {
  order: Order | null;
}

interface SmartSessionInfo {
  fingerprint: {
    id: string;
    displayName: string | null;
    signature: string;
    totalItems: number;
    totalWeight: number | null;
    weightUnit: string | null;
  } | null;
  session: {
    id: number;
    name: string | null;
    status: string;
    stationType: string;
    orderCount: number;
  } | null;
  spotNumber: number | null;
  packagingType: {
    id: string;
    name: string;
    stationType: string | null;
  } | null;
  qcStation: {
    id: string;
    name: string;
    stationType: string | null;
  } | null;
  autoPackageStatus: 'feature_disabled' | 'no_fingerprint' | 'needs_geometry_collection' | 'needs_packaging_rule' | 'ready';
  uncategorizedSkus?: { sku: string; description: string | null }[];
}

export default function ShipmentDetails() {
  const [, params] = useRoute("/shipments/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const shipmentId = params?.id;
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const { data: shipment, isLoading, isError } = useQuery<ShipmentWithOrder>({
    queryKey: ['/api/shipments', shipmentId],
    enabled: !!shipmentId,
  });

  const { data: items } = useQuery<ShipmentItem[]>({
    queryKey: ['/api/shipments', shipmentId, 'items'],
    enabled: !!shipmentId,
  });

  const { data: tags } = useQuery<ShipmentTag[]>({
    queryKey: ['/api/shipments', shipmentId, 'tags'],
    enabled: !!shipmentId,
  });

  const { data: packages } = useQuery<ShipmentPackage[]>({
    queryKey: ['/api/shipments', shipmentId, 'packages'],
    enabled: !!shipmentId,
  });

  const { data: qcItems } = useQuery<ShipmentQcItem[]>({
    queryKey: ['/api/shipments', shipmentId, 'qc-items'],
    enabled: !!shipmentId,
  });

  const { data: smartSessionInfo } = useQuery<SmartSessionInfo>({
    queryKey: ['/api/shipments', shipmentId, 'smart-session-info'],
    enabled: !!shipmentId,
  });

  const { data: rateAnalysisData } = useQuery<{ rateAnalysis: ShipmentRateAnalysis | null }>({
    queryKey: ['/api/shipments', shipmentId, 'rate-analysis'],
    enabled: !!shipmentId,
  });

  const syncPackageMutation = useMutation({
    mutationFn: async () => {
      const orderNumber = shipment?.orderNumber;
      if (!orderNumber) throw new Error("No order number");
      return apiRequest("POST", `/api/shipments/${orderNumber}/trigger-lifecycle`, { reason: "packaging" });
    },
    onSuccess: () => {
      toast({ title: "Package sync triggered", description: "The package will be pushed to ShipStation shortly." });
      queryClient.invalidateQueries({ queryKey: ['/api/shipments', shipmentId, 'smart-session-info'] });
      queryClient.invalidateQueries({ queryKey: ['/api/shipments', shipmentId, 'packages'] });
    },
    onError: () => {
      toast({ title: "Sync failed", description: "Could not trigger package sync. Try again.", variant: "destructive" });
    },
  });

  const packageMatchesAssignment = (() => {
    if (!smartSessionInfo?.packagingType?.name || !packages?.length) return null;
    const assignedName = smartSessionInfo.packagingType.name;
    const shipstationName = packages[0]?.packageName;
    if (!shipstationName || shipstationName === 'Package') return false;
    return assignedName.toLowerCase() === shipstationName.toLowerCase();
  })();

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied!",
      description: `${label} copied to clipboard`,
    });
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) {
      return <Badge variant="outline" className="text-lg">Unknown</Badge>;
    }

    const statusConfig: Record<string, { variant: "default" | "secondary" | "outline"; className?: string; label: string }> = {
      // Raw ShipStation tracking codes (UPPERCASE - matches production)
      "DE": { variant: "default", className: "bg-green-600 hover:bg-green-700 text-lg", label: "Delivered" },
      "IT": { variant: "default", className: "bg-blue-600 hover:bg-blue-700 text-lg", label: "In Transit" },
      "AC": { variant: "default", className: "bg-cyan-600 hover:bg-cyan-700 text-lg", label: "Accepted" },
      "SP": { variant: "default", className: "bg-green-500 hover:bg-green-600 text-lg", label: "Delivered (Locker)" },
      "AT": { variant: "default", className: "bg-orange-500 hover:bg-orange-600 text-lg", label: "Attempted Delivery" },
      "EX": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400 text-lg", label: "Exception" },
      "UN": { variant: "outline", className: "border-gray-500 text-gray-700 dark:text-gray-400 text-lg", label: "Unknown" },
      // Legacy/normalized values for backwards compatibility
      "delivered": { variant: "default", className: "bg-green-600 hover:bg-green-700 text-lg", label: "Delivered" },
      "in_transit": { variant: "default", className: "bg-blue-600 hover:bg-blue-700 text-lg", label: "In Transit" },
      "shipped": { variant: "secondary", className: "text-lg", label: "Shipped" },
      "cancelled": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400 text-lg", label: "Cancelled" },
      "pending": { variant: "outline", className: "border-amber-500 text-amber-700 dark:text-amber-400 text-lg", label: "Pending" },
    };

    // Try exact match first, then uppercase for resilience
    const config = statusConfig[status] || statusConfig[status.toUpperCase()] || { variant: "outline" as const, className: "text-lg", label: status };
    
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

  // Derive hasMoveOverTag from tags array
  const hasMoveOverTag = tags?.some(tag => tag.name === 'MOVE OVER') ?? false;

  type LifecyclePhase = 'delivered' | 'in_transit' | 'on_dock' | 'ready_to_fulfill' | 'picking_issues' | 'packing_ready' | 'picking' | 'ready_to_pick' | 'ready_to_session' | 'ready_for_skuvault' | 'fulfillment_prep' | 'cancelled' | 'problem';
  
  interface LifecycleInfo {
    phase: LifecyclePhase;
    label: string;
    description: string;
    whyThisStatus: string;
    whatHappensNext: string;
    colorClass: string;
    badgeClass: string;
    isException?: boolean;
    isTerminal?: boolean;
    matchedFields: string[];
  }

  const LIFECYCLE_INFO_MAP: Record<string, Omit<LifecycleInfo, 'matchedFields'>> = {
    delivered: {
      phase: 'delivered', label: 'Delivered', description: 'Package has been delivered to the customer',
      whyThisStatus: 'The carrier confirmed delivery.', whatHappensNext: 'Order complete! No further action needed.',
      colorClass: 'bg-green-600', badgeClass: 'bg-green-600 text-white', isTerminal: true,
    },
    in_transit: {
      phase: 'in_transit', label: 'In Transit', description: 'Package is on its way to the customer',
      whyThisStatus: 'The carrier has picked up the package.', whatHappensNext: 'Waiting for carrier to deliver.',
      colorClass: 'bg-blue-500', badgeClass: 'bg-blue-500 text-white',
    },
    on_dock: {
      phase: 'on_dock', label: 'On the Dock', description: 'Packaged and waiting for carrier pickup',
      whyThisStatus: 'Label printed, package ready.', whatHappensNext: 'Carrier will pick up during their next visit.',
      colorClass: 'bg-blue-600', badgeClass: 'bg-blue-600 text-white',
    },
    cancelled: {
      phase: 'cancelled', label: 'Cancelled', description: 'Order has been cancelled',
      whyThisStatus: 'This order was cancelled.', whatHappensNext: 'No further action needed.',
      colorClass: 'bg-red-600', badgeClass: 'bg-red-600 text-white', isTerminal: true,
    },
    problem: {
      phase: 'problem', label: 'Problem', description: 'Shipment has a carrier problem (SP/UN/EX)',
      whyThisStatus: 'The carrier reported a problem with this shipment.', whatHappensNext: 'Customer service needs to investigate.',
      colorClass: 'bg-orange-700', badgeClass: 'bg-orange-700 text-white', isTerminal: true,
    },
    ready_to_fulfill: {
      phase: 'ready_to_fulfill', label: 'Ready to Fulfill', description: 'On hold in ShipStation, waiting to be released',
      whyThisStatus: 'Order is on hold with "MOVE OVER" tag.', whatHappensNext: 'Will be released when the hold date passes.',
      colorClass: 'bg-amber-600', badgeClass: 'bg-amber-600 text-white',
    },
    picking_issues: {
      phase: 'picking_issues', label: 'Picking Issues', description: 'Problem during picking - needs supervisor attention',
      whyThisStatus: 'The picker marked this as inactive.', whatHappensNext: 'A supervisor needs to review.',
      colorClass: 'bg-red-600', badgeClass: 'bg-red-600 text-white', isException: true,
    },
    packing_ready: {
      phase: 'packing_ready', label: 'Packing Ready', description: 'Picked and ready to be packed',
      whyThisStatus: 'All items picked, ready for QC and packing.', whatHappensNext: 'A packer will scan and pack this order.',
      colorClass: 'bg-purple-600', badgeClass: 'bg-purple-600 text-white',
    },
    picking: {
      phase: 'picking', label: 'Picking', description: 'A picker is currently working on this order',
      whyThisStatus: 'This order is in an active picking session.', whatHappensNext: 'Picker will complete, then it moves to packing.',
      colorClass: 'bg-cyan-600', badgeClass: 'bg-cyan-600 text-white',
    },
    ready_to_pick: {
      phase: 'ready_to_pick', label: 'Ready to Pick', description: 'In the pick queue, waiting for a picker',
      whyThisStatus: 'Assigned to a session, waiting to be picked.', whatHappensNext: 'A picker will start working on this session.',
      colorClass: 'bg-yellow-600', badgeClass: 'bg-yellow-600 text-white',
    },
    ready_for_skuvault: {
      phase: 'ready_for_skuvault', label: 'Ready for SkuVault', description: 'Local session built, waiting for SkuVault wave picking',
      whyThisStatus: 'Session has been created locally.', whatHappensNext: 'SkuVault will create a wave picking session.',
      colorClass: 'bg-violet-600', badgeClass: 'bg-violet-600 text-white',
    },
    ready_to_session: {
      phase: 'ready_to_session', label: 'Ready to Session', description: 'Waiting to be added to a pick session',
      whyThisStatus: 'Order is released and ready for sessioning.', whatHappensNext: 'System will assign to a picking session.',
      colorClass: 'bg-teal-600', badgeClass: 'bg-teal-600 text-white',
    },
    fulfillment_prep: {
      phase: 'fulfillment_prep', label: 'Fulfillment Prep', description: 'Being prepared for fulfillment (hydration, fingerprinting, packaging, etc.)',
      whyThisStatus: 'Needs more information (fingerprint, packaging type, etc.).', whatHappensNext: 'System will resolve automatically or needs manual input.',
      colorClass: 'bg-gray-500', badgeClass: 'bg-gray-500 text-white',
    },
  };

  const getLifecycleInfo = (shipment: ShipmentWithOrder): LifecycleInfo => {
    const phase = shipment.lifecyclePhase as string;
    const info = LIFECYCLE_INFO_MAP[phase];
    if (info) {
      return { ...info, matchedFields: ['lifecyclePhase'] };
    }
    return { ...LIFECYCLE_INFO_MAP['fulfillment_prep'], matchedFields: [] };
  };

  const NORMAL_FLOW_STEPS: { phase: LifecyclePhase; label: string }[] = [
    { phase: 'ready_to_fulfill', label: 'Ready to Fulfill' },
    { phase: 'ready_to_session', label: 'Ready to Session' },
    { phase: 'ready_to_pick', label: 'Ready to Pick' },
    { phase: 'picking', label: 'Picking' },
    { phase: 'packing_ready', label: 'Packing Ready' },
    { phase: 'on_dock', label: 'On the Dock' },
    { phase: 'in_transit', label: 'In Transit' },
  ];

  const TERMINAL_STEPS: Record<string, { phase: LifecyclePhase; label: string }> = {
    delivered: { phase: 'delivered', label: 'Delivered' },
    cancelled: { phase: 'cancelled', label: 'Cancelled' },
    problem: { phase: 'problem', label: 'Problem' },
  };

  const getLifecycleFlowSteps = (currentPhase: string) => {
    const terminal = TERMINAL_STEPS[currentPhase];
    if (terminal) {
      return [...NORMAL_FLOW_STEPS, terminal];
    }
    return [...NORMAL_FLOW_STEPS, TERMINAL_STEPS['delivered']];
  };

  const inferLastReachedStep = (shipment: ShipmentWithOrder): number => {
    const hasTracking = !!shipment.trackingNumber;
    const sessionStatus = shipment.sessionStatus?.toLowerCase();
    const shipmentStatus = shipment.shipmentStatus?.toLowerCase();

    if (hasTracking && shipmentStatus === 'label_purchased') return 6;
    if (shipmentStatus === 'label_purchased') return 5;
    if (sessionStatus === 'closed') return 4;
    if (sessionStatus === 'active') return 3;
    if (sessionStatus === 'new') return 2;
    if (sessionStatus) return 2;
    if (shipmentStatus === 'pending') return 1;
    if (shipmentStatus === 'on_hold') return 0;
    return -1;
  };

  // Legacy wrapper for backward compatibility
  const getWorkflowStepBadge = (shipment: ShipmentWithOrder): { badge: JSX.Element; step: string; reason: string; matchedFields: string[] } => {
    const info = getLifecycleInfo(shipment);
    return {
      step: info.label,
      reason: info.whyThisStatus,
      matchedFields: info.matchedFields,
      badge: <Badge className={info.badgeClass}>{info.label}</Badge>
    };
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <div className="text-center py-12">
          <Truck className="h-12 w-12 text-muted-foreground mx-auto mb-4 animate-pulse" />
          <p className="text-muted-foreground text-lg">Loading shipment...</p>
        </div>
      </div>
    );
  }

  if (isError || !shipment) {
    return (
      <div className="max-w-7xl mx-auto p-6">
        <Button variant="ghost" onClick={() => setLocation("/shipments")} className="mb-4">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Shipments
        </Button>
        <Card>
          <CardContent className="py-12 text-center">
            <Truck className="h-16 w-16 text-destructive mx-auto mb-4" />
            <h3 className="text-xl font-semibold mb-2">Shipment not found</h3>
            <p className="text-muted-foreground">The shipment you're looking for doesn't exist or has been removed.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check if any QC items are out of stock (availableQuantity may be enriched by API)
  const hasOutOfStockItems = qcItems?.some(item => {
    const available = (item as any).availableQuantity;
    return available !== undefined && available !== null && available < (item.quantityExpected ?? 0);
  }) ?? false;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => setLocation("/shipments")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Shipments
        </Button>
      </div>

      {/* TIER 1: Order Header - Critical Information */}
      <Card>
        <CardContent className="pt-6 space-y-5">
          {/* Row 1: Order Number + Status + ShipStation Link */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Order Number</p>
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-bold font-mono" data-testid="text-order-number">
                    {shipment.orderNumber || 'Unknown'}
                  </span>
                  {shipment.orderNumber && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => copyToClipboard(shipment.orderNumber!, "Order number")}
                      data-testid="button-copy-order"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-3 flex-wrap">
              {/* Stock Status Badge - always show either IN STOCK or OUT OF STOCK */}
              {qcItems && qcItems.length > 0 && (
                hasOutOfStockItems ? (
                  <Badge variant="outline" className="border-red-500 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 gap-1" data-testid="badge-out-of-stock">
                    <AlertTriangle className="h-3 w-3" />
                    OUT OF STOCK
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 gap-1" data-testid="badge-in-stock">
                    <CheckCircle className="h-3 w-3" />
                    IN STOCK
                  </Badge>
                )
              )}
              
              {/* Status Badge */}
              {getStatusBadge(shipment.shipmentStatus || shipment.status)}
              
              {/* ShipStation Link */}
              {shipment.orderNumber && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`https://ship11.shipstation.com/orders/all-orders-search-result?quickSearch=${shipment.orderNumber}`, '_blank')}
                  data-testid="button-open-shipstation"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  ShipStation
                </Button>
              )}
            </div>
          </div>

          {/* Row 2: Lifecycle Stepper */}
          {(() => {
            const currentInfo = getLifecycleInfo(shipment);
            const currentPhase = currentInfo.phase;
            const isTerminal = currentInfo.isTerminal && currentPhase !== 'delivered';
            const isExceptionState = currentInfo.isException || currentPhase === 'fulfillment_prep' || currentPhase === 'ready_for_skuvault';
            const isOffPath = isTerminal || isExceptionState;
            const lifecycleFlowSteps = getLifecycleFlowSteps(currentPhase);
            const currentIndex = lifecycleFlowSteps.findIndex(s => s.phase === currentPhase);
            const lastReachedIndex = isOffPath ? inferLastReachedStep(shipment) : currentIndex;
            
            return (
              <div className="space-y-3 border-t pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Life Cycle</span>
                  <Badge className={currentInfo.badgeClass}>{currentInfo.label}</Badge>
                </div>
                
                {/* Main Flow */}
                <div className="overflow-x-auto overflow-y-visible pt-4 pb-3">
                  <div className="flex items-start gap-1 min-w-max">
                    {lifecycleFlowSteps.map((step, index) => {
                      const isTheTerminalStep = isTerminal && index === lifecycleFlowSteps.length - 1;
                      const isPast = !isOffPath && currentIndex > index;
                      const isCompleted = isOffPath && !isTheTerminalStep && index <= lastReachedIndex;
                      const isCurrent = !isOffPath && currentPhase === step.phase;
                      const isFuture = !isOffPath && currentIndex < index;
                      const isSkipped = isOffPath && !isTheTerminalStep && index > lastReachedIndex;
                      
                      return (
                        <div key={step.phase} className="flex items-start">
                          <div className="flex flex-col items-center w-[70px]">
                            <div className={`
                              w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all flex-shrink-0
                              ${isPast || isCompleted ? 'bg-green-100 dark:bg-green-900/30 border-green-500 text-green-600' : ''}
                              ${isCurrent ? 'bg-primary text-primary-foreground border-primary ring-4 ring-primary/20 scale-110' : ''}
                              ${isFuture ? 'bg-muted border-muted-foreground/30 text-muted-foreground' : ''}
                              ${isSkipped ? 'bg-muted/50 border-dashed border-muted-foreground/20 text-muted-foreground/50' : ''}
                              ${isTheTerminalStep ? 'bg-red-100 dark:bg-red-900/30 border-red-500 text-red-600 ring-4 ring-red-500/20 scale-110' : ''}
                            `}>
                              {isPast || isCompleted ? (
                                <CheckCircle2 className="h-5 w-5" />
                              ) : isCurrent ? (
                                <CircleDot className="h-5 w-5" />
                              ) : isTheTerminalStep ? (
                                <AlertCircle className="h-5 w-5" />
                              ) : (
                                <Circle className="h-5 w-5" />
                              )}
                            </div>
                            <span className={`
                              text-xs mt-2 text-center leading-tight h-8 flex items-start justify-center
                              ${isCurrent ? 'font-bold text-primary' : ''}
                              ${isPast || isCompleted ? 'text-green-600 dark:text-green-500' : ''}
                              ${isFuture || isSkipped ? 'text-muted-foreground' : ''}
                              ${isTheTerminalStep ? 'font-bold text-red-600 dark:text-red-400' : ''}
                            `}>
                              {step.label}
                            </span>
                          </div>
                          {index < lifecycleFlowSteps.length - 1 && (
                            <ChevronRight className={`
                              h-4 w-4 mt-3 flex-shrink-0
                              ${(isPast || isCompleted) && index < lastReachedIndex ? 'text-green-500' : 'text-muted-foreground/30'}
                            `} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Exception State Warning */}
                {isExceptionState && (
                  <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-3 flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <span className="font-medium text-red-800 dark:text-red-200">{currentInfo.label}</span>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-0.5">{currentInfo.description}</p>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Row 3: Tags */}
          {tags && tags.length > 0 && (
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-muted-foreground mb-2">Tags</p>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag, index) => (
                  <Badge 
                    key={index} 
                    variant={tag.name === 'MOVE OVER' ? 'default' : 'secondary'}
                    className={tag.name === 'MOVE OVER' ? 'bg-green-600 hover:bg-green-700' : ''}
                  >
                    {tag.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Row 4: Gift Information (if applicable) */}
          {(shipment.isGift || shipment.notesForGift) && (
            <div className="border-t pt-4">
              <div className="bg-pink-50 dark:bg-pink-950/20 border border-pink-200 dark:border-pink-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Gift className="h-5 w-5 text-pink-600 dark:text-pink-400" />
                  <span className="font-semibold text-pink-700 dark:text-pink-400">Gift Order</span>
                </div>
                {shipment.notesForGift && (
                  <p className="text-base" data-testid="text-gift-message">{shipment.notesForGift}</p>
                )}
              </div>
            </div>
          )}

          {/* Collapsible Lifecycle Details */}
          <details className="group border-t pt-4">
            <summary className="cursor-pointer flex items-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
              <span className="font-medium">Lifecycle Details</span>
            </summary>
            
            <div className="pt-4 space-y-6">
              {/* Why This Status & What Happens Next */}
              {(() => {
                const info = getLifecycleInfo(shipment);
                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-muted/50 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Info className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold text-sm">Why This Status?</span>
                      </div>
                      <p className="text-sm text-muted-foreground">{info.whyThisStatus}</p>
                    </div>
                    <div className="bg-primary/5 rounded-lg p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Play className="h-4 w-4 text-primary" />
                        <span className="font-semibold text-sm">What Happens Next?</span>
                      </div>
                      <p className="text-sm text-muted-foreground">{info.whatHappensNext}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Current Status Values */}
              {(() => {
                const info = getLifecycleInfo(shipment);
                const isMatched = (field: string) => info.matchedFields.includes(field);
                const matchedClass = 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 ring-2 ring-green-500';
                const notMatchedClass = 'bg-muted';
                
                return (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Shipment Status</p>
                      <code className={`text-sm font-mono px-2 py-1 rounded block ${isMatched('shipmentStatus') ? matchedClass : notMatchedClass}`}>
                        {shipment.shipmentStatus || 'null'}
                      </code>
                      {isMatched('shipmentStatus') && <p className="text-xs text-green-600">✓ matched</p>}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Tracking Status</p>
                      <code className={`text-sm font-mono px-2 py-1 rounded block ${isMatched('status') ? matchedClass : notMatchedClass}`}>
                        {shipment.status || 'null'}
                      </code>
                      {isMatched('status') && <p className="text-xs text-green-600">✓ matched</p>}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Session Status</p>
                      <code className={`text-sm font-mono px-2 py-1 rounded block ${isMatched('sessionStatus') ? matchedClass : notMatchedClass}`}>
                        {shipment.sessionStatus || 'null'}
                      </code>
                      {isMatched('sessionStatus') && <p className="text-xs text-green-600">✓ matched</p>}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">MOVE OVER Tag</p>
                      <code className={`text-sm font-mono px-2 py-1 rounded block ${isMatched('hasMoveOverTag') ? matchedClass : (hasMoveOverTag ? 'bg-green-100 dark:bg-green-900/30' : notMatchedClass)}`}>
                        {hasMoveOverTag ? 'YES' : 'NO'}
                      </code>
                      {isMatched('hasMoveOverTag') && <p className="text-xs text-green-600">✓ matched</p>}
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Has Tracking #</p>
                      <code className={`text-sm font-mono px-2 py-1 rounded block ${isMatched('trackingNumber') ? matchedClass : (shipment.trackingNumber ? 'bg-muted' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400')}`}>
                        {shipment.trackingNumber ? 'YES' : 'NO'}
                      </code>
                      {isMatched('trackingNumber') && <p className="text-xs text-green-600">✓ matched</p>}
                    </div>
                  </div>
                );
              })()}

              {/* Label Preview & Session Info Row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Label Section */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">Shipping Label</span>
                  </div>
                  {shipment.labelUrl ? (
                    <div className="flex items-center gap-2">
                      <Badge className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800">
                        Label Available
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(shipment.labelUrl!, '_blank')}
                        data-testid="button-view-label"
                      >
                        <ExternalLink className="h-3 w-3 mr-1" />
                        View Label
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      No Label Generated
                    </Badge>
                  )}
                </div>

                {/* Session Info */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Boxes className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">Session Info</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {shipment.sessionId ? (
                      <Badge variant="secondary">Session: {shipment.sessionId}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">No Session</Badge>
                    )}
                  </div>
                </div>
              </div>

              {/* Timestamps */}
              <div className="border-t pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Timer className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Timestamps</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Pick Started</p>
                    <p className="font-mono">{shipment.pickStartedAt ? new Date(shipment.pickStartedAt).toLocaleString() : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Pick Ended</p>
                    <p className="font-mono">{shipment.pickEndedAt ? new Date(shipment.pickEndedAt).toLocaleString() : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Ship Date</p>
                    <p className="font-mono">{shipment.shipDate ? new Date(shipment.shipDate).toLocaleString() : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last Updated</p>
                    <p className="font-mono">{shipment.updatedAt ? new Date(shipment.updatedAt).toLocaleString() : '—'}</p>
                  </div>
                </div>
              </div>

              {/* Technical Details (Nested Collapsible) */}
              <details className="border-t pt-4">
                <summary className="cursor-pointer flex items-center gap-2 mb-3 text-sm text-muted-foreground hover:text-foreground">
                  <Play className="h-4 w-4" />
                  <span className="font-semibold">Technical Details (for debugging)</span>
                </summary>
                <div className="mt-3 space-y-3">
                  {/* Current field values */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">shipmentStatus:</span>
                      <code className="block font-mono">{shipment.shipmentStatus || 'null'}</code>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">status:</span>
                      <code className="block font-mono">{shipment.status || 'null'}</code>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">sessionStatus:</span>
                      <code className="block font-mono">{shipment.sessionStatus || 'null'}</code>
                    </div>
                    <div className="bg-muted/50 rounded p-2">
                      <span className="text-muted-foreground">hasMoveOverTag:</span>
                      <code className="block font-mono">{hasMoveOverTag ? 'true' : 'false'}</code>
                    </div>
                  </div>
                  
                  {/* All lifecycle phases reference */}
                  <div className="text-xs">
                    <p className="text-muted-foreground mb-2">Lifecycle phase priority (checked in order):</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground font-mono">
                      <li>DELIVERED: shipmentStatus='label_purchased' AND status='DE'</li>
                      <li>IN_TRANSIT: shipmentStatus='label_purchased' AND status='IT'</li>
                      <li>ON_DOCK: shipmentStatus='label_purchased' AND status IN ('NY', 'AC')</li>
                      <li>READY_TO_FULFILL: shipmentStatus='on_hold' AND hasMoveOverTag</li>
                      <li>PICKING_ISSUES: sessionStatus='inactive'</li>
                      <li>PACKING_READY: sessionStatus='closed' AND !trackingNumber AND shipmentStatus='pending'</li>
                      <li>PICKING: sessionStatus='active'</li>
                      <li>READY_TO_PICK: sessionStatus='new'</li>
                      <li>READY_TO_SESSION: shipmentStatus='pending' AND hasMoveOverTag AND !sessionStatus</li>
                      <li>FULFILLMENT_PREP: fallback</li>
                    </ol>
                  </div>
                </div>
              </details>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* TIER 2: Shipping */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Shipping
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Row 1: Carrier, Service, Tracking, Order Date, Ship Date, Total Weight */}
          {(() => {
            // Parse carrier from service_code (e.g., "usps_ground_advantage" -> "USPS")
            const parseCarrier = (serviceCode: string | null): string => {
              if (!serviceCode) return '—';
              const carrier = serviceCode.split('_')[0];
              return carrier ? carrier.toUpperCase() : '—';
            };
            
            // Parse service name from service_code (e.g., "usps_ground_advantage" -> "Ground Advantage")
            const parseService = (serviceCode: string | null): string => {
              if (!serviceCode) return '—';
              const parts = serviceCode.split('_');
              if (parts.length <= 1) return serviceCode;
              return parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
            };

            return (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-x-6 gap-y-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Carrier</p>
                  <p className="font-semibold">{parseCarrier(shipment.serviceCode)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Service</p>
                  <p className="font-medium">{parseService(shipment.serviceCode)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Tracking Number</p>
                  {shipment.trackingNumber ? (
                    <div className="flex items-center gap-1">
                      <code className="font-mono text-sm truncate">{shipment.trackingNumber}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 flex-shrink-0"
                        onClick={() => copyToClipboard(shipment.trackingNumber!, "Tracking number")}
                        data-testid="button-copy-tracking"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Order Date</p>
                  <p className="font-mono">{shipment.orderDate ? new Date(shipment.orderDate).toLocaleDateString() : '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Ship Date</p>
                  <p className="font-mono">{shipment.shipDate ? new Date(shipment.shipDate).toLocaleDateString() : '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Total Weight</p>
                  <p className="font-medium">{shipment.totalWeight || '—'}</p>
                </div>
              </div>
            );
          })()}

          {/* Divider */}
          <div className="border-t" />

          {/* Row 2: 3 sections - Address, Contact, Notes */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Section 1: Ship To Address */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Ship To</p>
              <div className="space-y-1">
                <p className="text-lg font-semibold">{shipment.shipToName || 'Unknown'}</p>
                {shipment.shipToCompany && (
                  <p className="text-muted-foreground">{shipment.shipToCompany}</p>
                )}
                <div className="text-sm space-y-0.5">
                  {shipment.shipToAddressLine1 && <p>{shipment.shipToAddressLine1}</p>}
                  {shipment.shipToAddressLine2 && <p>{shipment.shipToAddressLine2}</p>}
                  {shipment.shipToAddressLine3 && <p>{shipment.shipToAddressLine3}</p>}
                  <p>
                    {[shipment.shipToCity, shipment.shipToState, shipment.shipToPostalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  {shipment.shipToCountry && <p>{shipment.shipToCountry}</p>}
                </div>
                {shipment.shipToIsResidential && (
                  <Badge variant="outline" className="mt-2">
                    {shipment.shipToIsResidential === 'yes' ? 'Residential' : 'Commercial'}
                  </Badge>
                )}
              </div>
            </div>

            {/* Section 2: Customer Contact */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Contact</p>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-muted-foreground truncate">{shipment.shipToEmail || '—'}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span>{shipment.shipToPhone || '—'}</span>
                </div>
              </div>
            </div>

            {/* Section 3: Notes */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Notes</p>
              <div className="space-y-3">
                <div className={shipment.notesFromBuyer ? "bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2" : ""}>
                  <p className="text-xs text-muted-foreground mb-0.5">Customer Notes</p>
                  <p className="text-sm" data-testid="text-buyer-notes">{shipment.notesFromBuyer || '—'}</p>
                </div>
                <div className={shipment.notesForGift ? "bg-purple-50 dark:bg-purple-950/20 border border-purple-200 dark:border-purple-800 rounded-lg p-2" : ""}>
                  <p className="text-xs text-muted-foreground mb-0.5">Gift Notes</p>
                  <p className="text-sm" data-testid="text-gift-notes">{shipment.notesForGift || '—'}</p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* TIER 3: Fulfillment Items */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5" />
            Fulfillment Items
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Session Info Bar */}
          {(() => {
            const sessionInfo = parseCustomField2(shipment.customField2);
            return (
              <div className="bg-muted/50 rounded-lg p-4 flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-6">
                  {smartSessionInfo?.session ? (
                    <div className="flex items-center gap-2">
                      <Boxes className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Session</p>
                        <button
                          type="button"
                          onClick={() => setSelectedSessionId(String(smartSessionInfo.session!.id))}
                          className="font-semibold text-primary hover:underline cursor-pointer"
                          data-testid={`link-session-${smartSessionInfo.session.id}`}
                        >
                          {smartSessionInfo.session.name || `Session ${smartSessionInfo.session.id}`}
                        </button>
                      </div>
                    </div>
                  ) : sessionInfo ? (
                    <div className="flex items-center gap-2">
                      <Boxes className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Session</p>
                        <button
                          type="button"
                          onClick={() => setSelectedSessionId(sessionInfo.sessionId)}
                          className="font-semibold text-primary hover:underline cursor-pointer"
                          data-testid={`link-session-${sessionInfo.sessionId}`}
                        >
                          Session {sessionInfo.sessionId}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Boxes className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">Session</p>
                        <span className="text-muted-foreground">Not assigned</span>
                      </div>
                    </div>
                  )}
                  
                  {smartSessionInfo?.spotNumber && (
                    <div>
                      <p className="text-xs text-muted-foreground">Spot</p>
                      <Badge variant="secondary">#{smartSessionInfo.spotNumber}</Badge>
                    </div>
                  )}
                  
                  {shipment.sessionStatus && (
                    <div>
                      <p className="text-xs text-muted-foreground">Session Status</p>
                      <Badge variant={shipment.sessionStatus === 'closed' ? 'default' : 'secondary'}>
                        {shipment.sessionStatus}
                      </Badge>
                    </div>
                  )}
                </div>
                
                <div className="text-sm text-muted-foreground">
                  {qcItems?.length || 0} QC items / {items?.length || 0} ordered
                </div>
              </div>
            );
          })()}

          {/* Items Tabs - QC Items is default */}
          <Tabs defaultValue="qc" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="qc" className="flex items-center gap-2" data-testid="tab-qc-items">
                <PackageCheck className="h-4 w-4" />
                QC Items ({qcItems?.length || 0})
              </TabsTrigger>
              <TabsTrigger value="purchased" className="flex items-center gap-2" data-testid="tab-purchased-items">
                <ShoppingCart className="h-4 w-4" />
                Ordered Items ({items?.length || 0})
              </TabsTrigger>
            </TabsList>
            
            {/* QC Items Tab (default) */}
            <TabsContent value="qc">
              {qcItems && qcItems.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-4 py-3 font-semibold">SKU</th>
                        <th className="text-left px-4 py-3 font-semibold">Product</th>
                        <th className="text-center px-4 py-3 font-semibold">Expected</th>
                        <th className="text-center px-4 py-3 font-semibold">Available</th>
                        <th className="text-right px-4 py-3 font-semibold">Weight</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {qcItems.map((qcItem, index) => {
                        const available = (qcItem as any).availableQuantity ?? null;
                        const expected = qcItem.quantityExpected ?? 0;
                        const isOutOfStock = available !== null && available < expected;
                        
                        return (
                          <tr 
                            key={qcItem.id || index} 
                            className={isOutOfStock ? 'bg-red-50 dark:bg-red-950/20' : ''} 
                            data-testid={`row-qc-item-${index}`}
                          >
                            <td className="px-4 py-3">
                              <div className="flex flex-col gap-1">
                                <code className="text-sm font-mono bg-muted px-2 py-1 rounded inline-block">
                                  {qcItem.sku || 'N/A'}
                                </code>
                                {qcItem.isKitComponent && qcItem.parentSku && (
                                  <span className="text-xs text-muted-foreground">
                                    from kit: {qcItem.parentSku}
                                  </span>
                                )}
                                {qcItem.barcode && (
                                  <span className="text-xs text-muted-foreground font-mono">
                                    {qcItem.barcode}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                {qcItem.imageUrl && (
                                  <img 
                                    src={qcItem.imageUrl} 
                                    alt={qcItem.description || 'Product'}
                                    className="w-12 h-12 object-cover rounded border flex-shrink-0"
                                  />
                                )}
                                <span className="text-sm font-medium">{qcItem.description || 'Unknown Product'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className="text-lg font-bold">{expected}</span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {available !== null ? (
                                <div className="flex items-center justify-center gap-1">
                                  <span className={`text-lg font-bold ${isOutOfStock ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                                    {available}
                                  </span>
                                  {isOutOfStock && (
                                    <AlertTriangle className="h-4 w-4 text-red-500" />
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-sm">
                                {qcItem.weightValue ? `${qcItem.weightValue} ${qcItem.weightUnit || 'oz'}` : '—'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground border rounded-lg">
                  <PackageCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No QC items yet</p>
                  <p className="text-sm mt-1">QC items appear once the order is tagged "MOVE OVER" and ready for picking</p>
                </div>
              )}
            </TabsContent>
            
            {/* Ordered Items Tab */}
            <TabsContent value="purchased">
              {items && items.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-4 py-3 font-semibold">SKU</th>
                        <th className="text-left px-4 py-3 font-semibold">Product</th>
                        <th className="text-center px-4 py-3 font-semibold">Quantity</th>
                        <th className="text-right px-4 py-3 font-semibold">Unit Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.map((item, index) => (
                        <tr key={index} data-testid={`row-purchased-item-${index}`}>
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
                                  className="w-12 h-12 object-cover rounded border flex-shrink-0"
                                />
                              )}
                              <span className="text-sm font-medium">{item.name || 'Unknown Product'}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="text-lg font-bold">{item.quantity}</span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-sm">
                              {item.unitPrice ? `$${parseFloat(item.unitPrice).toFixed(2)}` : 'N/A'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground border rounded-lg">
                  <ShoppingCart className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No ordered items found</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* TIER 4: Package Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Box className="h-5 w-5" />
            Package Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Auto Package, Fingerprint & QC Station */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Auto Package Assignment */}
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">Auto Package Assignment</p>
              {smartSessionInfo?.autoPackageStatus === 'ready' ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-green-600 dark:bg-green-700">Ready</Badge>
                    {smartSessionInfo?.packagingType && (
                      <span className="text-xs text-muted-foreground">{smartSessionInfo.packagingType.name}</span>
                    )}
                  </div>
                  {shipment?.lifecyclePhase === 'fulfillment_prep' && packageMatchesAssignment === false && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        ShipStation shows "{packages?.[0]?.packageName || 'Package'}" — expected "{smartSessionInfo?.packagingType?.name}"
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => syncPackageMutation.mutate()}
                        disabled={syncPackageMutation.isPending}
                        data-testid="button-sync-package"
                      >
                        <RefreshCw className={`w-3 h-3 mr-1 ${syncPackageMutation.isPending ? 'animate-spin' : ''}`} />
                        {syncPackageMutation.isPending ? 'Syncing...' : 'Sync'}
                      </Button>
                    </div>
                  )}
                  {shipment?.lifecyclePhase === 'fulfillment_prep' && packageMatchesAssignment === true && (
                    <div className="flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" />
                      <span className="text-xs text-green-600 dark:text-green-400">Synced to ShipStation</span>
                    </div>
                  )}
                </div>
              ) : shipment?.requiresManualPackage ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="destructive">Sync Failed</Badge>
                  </div>
                  <p className="text-xs text-destructive">
                    {shipment.packageAssignmentError || 'Auto-sync to ShipStation failed after multiple attempts.'}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => syncPackageMutation.mutate()}
                    disabled={syncPackageMutation.isPending}
                    data-testid="button-retry-package-sync"
                  >
                    <RefreshCw className={`w-3 h-3 mr-1 ${syncPackageMutation.isPending ? 'animate-spin' : ''}`} />
                    {syncPackageMutation.isPending ? 'Retrying...' : 'Retry Sync'}
                  </Button>
                </div>
              ) : smartSessionInfo?.autoPackageStatus === 'feature_disabled' ? (
                <Badge variant="secondary">Feature disabled</Badge>
              ) : smartSessionInfo?.autoPackageStatus === 'no_fingerprint' ? (
                <span className="text-sm text-muted-foreground">No fingerprint</span>
              ) : smartSessionInfo?.autoPackageStatus === 'needs_geometry_collection' ? (
                <div className="space-y-1">
                  <span className="text-sm text-muted-foreground">Needs geometry collection</span>
                  {smartSessionInfo?.uncategorizedSkus && smartSessionInfo.uncategorizedSkus.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {smartSessionInfo.uncategorizedSkus.map((item: { sku: string; description: string | null }) => (
                        <div key={item.sku} className="text-xs bg-destructive/10 text-destructive rounded px-2 py-1">
                          <span className="font-mono font-medium">{item.sku}</span>
                          {item.description && (
                            <span className="text-muted-foreground ml-1">— {item.description}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : smartSessionInfo?.autoPackageStatus === 'needs_packaging_rule' ? (
                <span className="text-sm text-muted-foreground">Needs packaging rule</span>
              ) : (
                <span className="text-muted-foreground">Loading...</span>
              )}
            </div>

            {/* Fingerprint */}
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">Fingerprint</p>
              {smartSessionInfo?.fingerprint ? (
                <div className="space-y-1">
                  <p className="font-medium">{smartSessionInfo.fingerprint.displayName || 'Unnamed'}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{smartSessionInfo.fingerprint.totalItems} items</span>
                    {smartSessionInfo.fingerprint.totalWeight && (
                      <span>{smartSessionInfo.fingerprint.totalWeight} {smartSessionInfo.fingerprint.weightUnit}</span>
                    )}
                  </div>
                </div>
              ) : (
                <span className="text-muted-foreground">Not assigned</span>
              )}
            </div>

            {/* QC Station */}
            <div className="bg-muted/50 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">QC Station</p>
              {smartSessionInfo?.qcStation ? (
                <p className="font-medium">{smartSessionInfo.qcStation.name}</p>
              ) : (
                <span className="text-muted-foreground">Not assigned</span>
              )}
            </div>
          </div>

          {/* Package Details */}
          {packages && packages.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-3">Packages ({packages.length})</p>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold text-sm">Package</th>
                      <th className="text-center px-4 py-3 font-semibold text-sm">Weight</th>
                      <th className="text-center px-4 py-3 font-semibold text-sm">Dimensions</th>
                      <th className="text-right px-4 py-3 font-semibold text-sm">Insured</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {packages.map((pkg, index) => {
                      const hasSize = pkg.dimensionLength && pkg.dimensionWidth && pkg.dimensionHeight &&
                        (parseFloat(pkg.dimensionLength) > 0 || parseFloat(pkg.dimensionWidth) > 0 || parseFloat(pkg.dimensionHeight) > 0);
                      
                      return (
                        <tr key={pkg.id || index} data-testid={`row-package-${index}`}>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <span className="font-medium">{pkg.packageName || 'Package'}</span>
                              {pkg.packageCode && (
                                <code className="text-xs font-mono text-muted-foreground">
                                  {pkg.packageCode}
                                </code>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {pkg.weightValue && pkg.weightUnit ? (
                              <span className="font-medium">
                                {pkg.weightValue} {pkg.weightUnit}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {hasSize ? (
                              <span className="text-sm">
                                {pkg.dimensionLength} x {pkg.dimensionWidth} x {pkg.dimensionHeight} {pkg.dimensionUnit}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {pkg.insuredAmount && parseFloat(pkg.insuredAmount) > 0 ? (
                              <span>
                                ${parseFloat(pkg.insuredAmount).toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* No packages yet */}
          {(!packages || packages.length === 0) && (
            <div className="text-center py-4 text-muted-foreground border rounded-lg">
              <Boxes className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No package details yet</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* TIER 5: Rate Checker */}
      <Card data-testid="card-rate-checker">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5" />
            Rate Checker
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rateAnalysisData?.rateAnalysis ? (
            (() => {
              const analysis = rateAnalysisData.rateAnalysis;
              const hasSavings = analysis.costSavings && parseFloat(analysis.costSavings) > 0;
              const isOptimal = analysis.smartShippingMethod === analysis.customerShippingMethod;
              
              return (
                <div className="space-y-4">
                  {/* Status Badge */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    {hasSavings ? (
                      <Badge className="bg-green-600 gap-1" data-testid="badge-savings-available">
                        <DollarSign className="h-3 w-3" />
                        Savings Available
                      </Badge>
                    ) : (
                      <Badge className="bg-blue-600 gap-1" data-testid="badge-optimal-choice">
                        <CheckCircle className="h-3 w-3" />
                        Optimal Choice
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground" data-testid="text-rates-compared">
                      Compared {analysis.ratesComparedCount} rates
                    </span>
                  </div>

                  {/* Comparison Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Customer's Choice */}
                    <div className="bg-muted/50 rounded-lg p-4 space-y-2" data-testid="card-customer-choice">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">Customer Selected</p>
                      <p className="font-medium text-lg" data-testid="text-customer-method">
                        {analysis.customerShippingMethod?.replace(/_/g, ' ').toUpperCase() || 'Unknown'}
                      </p>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="font-bold text-lg" data-testid="text-customer-cost">
                          ${parseFloat(analysis.customerShippingCost || '0').toFixed(2)}
                        </span>
                        {analysis.customerDeliveryDays && (
                          <span className="text-muted-foreground" data-testid="text-customer-days">
                            {analysis.customerDeliveryDays} {analysis.customerDeliveryDays === 1 ? 'day' : 'days'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Smart Recommendation */}
                    <div className={`rounded-lg p-4 space-y-2 ${hasSavings ? 'bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800' : 'bg-muted/50'}`} data-testid="card-smart-recommendation">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide">
                        {hasSavings ? 'Recommended' : 'Best Option'}
                      </p>
                      <p className="font-medium text-lg" data-testid="text-smart-method">
                        {analysis.smartShippingMethod?.replace(/_/g, ' ').toUpperCase() || 'Unknown'}
                      </p>
                      <div className="flex items-center gap-4 text-sm">
                        <span className={`font-bold text-lg ${hasSavings ? 'text-green-700 dark:text-green-400' : ''}`} data-testid="text-smart-cost">
                          ${parseFloat(analysis.smartShippingCost || '0').toFixed(2)}
                        </span>
                        {analysis.smartDeliveryDays && (
                          <span className="text-muted-foreground" data-testid="text-smart-days">
                            {analysis.smartDeliveryDays} {analysis.smartDeliveryDays === 1 ? 'day' : 'days'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Savings Highlight */}
                  {hasSavings && (
                    <div className="bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-700 rounded-lg p-4 flex items-center justify-between gap-4" data-testid="savings-highlight">
                      <div className="flex items-center gap-2">
                        <TrendingDown className="h-5 w-5 text-green-600 dark:text-green-400" />
                        <span className="font-medium text-green-800 dark:text-green-200">
                          Potential Savings
                        </span>
                      </div>
                      <span className="text-2xl font-bold text-green-700 dark:text-green-300" data-testid="text-savings-amount">
                        ${parseFloat(analysis.costSavings || '0').toFixed(2)}
                      </span>
                    </div>
                  )}

                  {/* Route Info */}
                  <div className="flex items-center gap-4 text-sm text-muted-foreground pt-2 border-t">
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {analysis.originPostalCode} → {analysis.destinationPostalCode}
                    </span>
                    {analysis.destinationState && (
                      <span className="font-medium">{analysis.destinationState}</span>
                    )}
                    {analysis.updatedAt && (
                      <span className="ml-auto">
                        Analyzed {formatRelativeTime(analysis.updatedAt)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="text-center py-6 text-muted-foreground border rounded-lg">
              <Clock className="h-6 w-6 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Rate analysis pending</p>
              <p className="text-xs mt-1">Analysis runs automatically during shipment sync</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session Detail Modal */}
      <SessionDetailDialog 
        picklistId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
