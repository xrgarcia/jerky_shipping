import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Truck, Package, MapPin, User, Mail, Phone, Clock, Copy, ExternalLink, Calendar, Weight, Gift, AlertTriangle, Boxes, Play, Timer, CheckCircle, FileText, Info, ShoppingCart, PackageCheck, Fingerprint, Hash, MapPinned, Box } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, Order, ShipmentItem, ShipmentTag, ShipmentPackage, ShipmentQcItem } from "@shared/schema";
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

  const getWorkflowStepBadge = (shipment: ShipmentWithOrder): { badge: JSX.Element; step: string; reason: string; matchedFields: string[] } => {
    const hasTracking = !!shipment.trackingNumber;
    const sessionStatus = shipment.sessionStatus?.toLowerCase();
    const shipmentStatus = shipment.shipmentStatus?.toLowerCase();
    // Normalize status to uppercase for consistent comparison with raw ShipStation codes
    const status = shipment.status?.toUpperCase();

    if (status === 'DE' || status === 'DELIVERED') {
      return {
        step: 'Delivered',
        reason: `status = 'DE' (ShipStation delivered)`,
        matchedFields: ['status'],
        badge: <Badge className="bg-green-600 text-white">Delivered</Badge>
      };
    }

    if (shipmentStatus === 'on_hold') {
      return {
        step: 'On Hold',
        reason: `shipmentStatus = 'on_hold' (checked before tracking/session)`,
        matchedFields: ['shipmentStatus'],
        badge: <Badge className="bg-amber-600 text-white">On Hold</Badge>
      };
    }

    // On the Dock: Label purchased AND status = 'AC' (Accepted - carrier awaiting pickup)
    if (shipmentStatus === 'label_purchased' && status === 'AC') {
      return {
        step: 'On the Dock',
        reason: `shipmentStatus = 'label_purchased' AND status = 'AC' (Accepted - carrier awaiting pickup)`,
        matchedFields: ['shipmentStatus', 'status'],
        badge: <Badge className="bg-blue-600 text-white">On the Dock</Badge>
      };
    }

    if (sessionStatus === 'inactive') {
      return {
        step: 'Picking Issues',
        reason: `sessionStatus = 'inactive' (flagged for supervisor attention)`,
        matchedFields: ['sessionStatus'],
        badge: <Badge className="bg-orange-600 text-white">Picking Issues</Badge>
      };
    }

    if (sessionStatus === 'closed' && !hasTracking) {
      return {
        step: 'Packing Ready',
        reason: `sessionStatus = 'closed' AND trackingNumber = null (cache is warmed)`,
        matchedFields: ['sessionStatus', 'trackingNumber'],
        badge: <Badge className="bg-purple-600 text-white">Packing Ready</Badge>
      };
    }

    if (sessionStatus === 'active') {
      return {
        step: 'Picking',
        reason: `sessionStatus = 'active' (picker is working on it)`,
        matchedFields: ['sessionStatus'],
        badge: <Badge className="bg-cyan-600 text-white">Picking</Badge>
      };
    }

    if (sessionStatus === 'new') {
      return {
        step: 'Ready to Pick',
        reason: `sessionStatus = 'new' (in pick queue)`,
        matchedFields: ['sessionStatus'],
        badge: <Badge className="bg-yellow-600 text-white">Ready to Pick</Badge>
      };
    }

    return {
      step: 'Awaiting Pick',
      reason: `No sessionStatus (value: ${shipment.sessionStatus || 'null'}), shipmentStatus = '${shipment.shipmentStatus || 'null'}'`,
      matchedFields: [],
      badge: <Badge variant="outline">Awaiting Pick</Badge>
    };
  };

  const workflowCriteria = [
    { step: 'Delivered', criteria: "status = 'delivered'", colorClass: 'bg-green-600', order: 1 },
    { step: 'On Hold', criteria: "shipmentStatus = 'on_hold' (checked FIRST, before tracking)", colorClass: 'bg-amber-600', order: 2 },
    { step: 'On the Dock', criteria: "shipmentStatus = 'label_purchased' AND status = 'AC' (Accepted - carrier awaiting pickup)", colorClass: 'bg-blue-600', order: 3 },
    { step: 'Picking Issues', criteria: "sessionStatus = 'inactive'", colorClass: 'bg-orange-600', order: 4 },
    { step: 'Packing Ready', criteria: "sessionStatus = 'closed' AND no trackingNumber", colorClass: 'bg-purple-600', order: 5 },
    { step: 'Picking', criteria: "sessionStatus = 'active'", colorClass: 'bg-cyan-600', order: 6 },
    { step: 'Ready to Pick', criteria: "sessionStatus = 'new'", colorClass: 'bg-yellow-600', order: 7 },
    { step: 'Awaiting Pick', criteria: "No matching conditions (fallback)", colorClass: 'bg-gray-600', order: 8 },
  ];

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

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => setLocation("/shipments")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Shipments
        </Button>
      </div>

      {/* Main Info Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Truck className="h-8 w-8 text-muted-foreground" />
                <CardTitle className="text-4xl font-mono font-bold">
                  {shipment.trackingNumber || "No Tracking Number"}
                </CardTitle>
                {shipment.trackingNumber && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyToClipboard(shipment.trackingNumber!, "Tracking number")}
                    data-testid="button-copy-tracking"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                )}
              </div>
              
              {shipment.orderNumber && (
                <div className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-muted-foreground" />
                  <p className="text-2xl font-semibold">Order #{shipment.orderNumber}</p>
                </div>
              )}
            </div>

            <div className="flex flex-col items-end gap-3">
              {getStatusBadge(shipment.status)}
              <div className="flex flex-wrap gap-2 justify-end">
                {shipment.isReturn && (
                  <Badge variant="outline" className="border-purple-500 text-purple-700 dark:text-purple-400">
                    Return
                  </Badge>
                )}
                {shipment.isGift && (
                  <Badge variant="outline" className="border-pink-500 text-pink-700 dark:text-pink-400">
                    Gift
                  </Badge>
                )}
                {shipment.saturdayDelivery && (
                  <Badge variant="outline" className="border-blue-500 text-blue-700 dark:text-blue-400">
                    Saturday Delivery
                  </Badge>
                )}
                {shipment.containsAlcohol && (
                  <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                    Contains Alcohol
                  </Badge>
                )}
              </div>
            </div>
          </div>
          
          {shipment.statusDescription && (
            <p className="text-lg text-muted-foreground mt-2">{shipment.statusDescription}</p>
          )}
        </CardHeader>
      </Card>

      {/* Workflow Status Card */}
      <Card className="border-2 border-dashed border-muted-foreground/30">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2">
              <Info className="h-5 w-5" />
              Workflow Status
            </CardTitle>
            {(() => {
              const workflow = getWorkflowStepBadge(shipment);
              return (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Current Step:</span>
                  {workflow.badge}
                </div>
              );
            })()}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Why This Category */}
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span className="font-semibold">Why This Category?</span>
            </div>
            <code className="text-sm bg-background px-2 py-1 rounded block">
              {getWorkflowStepBadge(shipment).reason}
            </code>
          </div>

          {/* Current Status Values */}
          {(() => {
            const workflow = getWorkflowStepBadge(shipment);
            const isMatched = (field: string) => workflow.matchedFields.includes(field);
            const matchedClass = 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 ring-2 ring-green-500';
            const notMatchedClass = 'bg-muted';
            
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Tracking Status</p>
                  <code className={`text-lg font-mono px-2 py-1 rounded block ${isMatched('status') ? matchedClass : notMatchedClass}`}>
                    {shipment.status || 'null'}
                  </code>
                  <p className="text-xs text-muted-foreground">status field {isMatched('status') && '✓ matched'}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Shipment Status</p>
                  <code className={`text-lg font-mono px-2 py-1 rounded block ${isMatched('shipmentStatus') ? matchedClass : notMatchedClass}`}>
                    {shipment.shipmentStatus || 'null'}
                  </code>
                  <p className="text-xs text-muted-foreground">shipmentStatus field {isMatched('shipmentStatus') && '✓ matched'}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Session Status</p>
                  <code className={`text-lg font-mono px-2 py-1 rounded block ${isMatched('sessionStatus') ? matchedClass : notMatchedClass}`}>
                    {shipment.sessionStatus || 'null'}
                  </code>
                  <p className="text-xs text-muted-foreground">sessionStatus field {isMatched('sessionStatus') && '✓ matched'}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide">Has Tracking #</p>
                  <code className={`text-lg font-mono px-2 py-1 rounded block ${isMatched('trackingNumber') ? matchedClass : (shipment.trackingNumber ? 'bg-muted' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400')}`}>
                    {shipment.trackingNumber ? 'YES' : 'NO'}
                  </code>
                  <p className="text-xs text-muted-foreground truncate" title={shipment.trackingNumber || undefined}>
                    {isMatched('trackingNumber') ? '✓ matched • ' : ''}{shipment.trackingNumber ? shipment.trackingNumber.substring(0, 16) + (shipment.trackingNumber.length > 16 ? '...' : '') : 'No tracking'}
                  </p>
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
                {shipment.pickerName && (
                  <Badge variant="secondary">Picker: {shipment.pickerName}</Badge>
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

          {/* Workflow Criteria Reference */}
          <div className="border-t pt-4">
            <div className="flex items-center gap-2 mb-3">
              <Play className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">All Workflow Stages & Criteria</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
              {workflowCriteria.map((item) => {
                const currentStep = getWorkflowStepBadge(shipment).step;
                const isActive = item.step === currentStep;
                return (
                  <div 
                    key={item.step}
                    className={`flex items-start gap-2 p-2 rounded ${isActive ? 'bg-primary/10 ring-1 ring-primary' : ''}`}
                  >
                    <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${item.colorClass}`} />
                    <div>
                      <span className={`font-medium ${isActive ? 'text-primary' : ''}`}>{item.step}</span>
                      <p className="text-xs text-muted-foreground font-mono">{item.criteria}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Customer Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Shipping Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shipment.shipToName && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Name</p>
                <p className="text-xl font-semibold">{shipment.shipToName}</p>
              </div>
            )}

            {(shipment.shipToEmail || shipment.shipToPhone) && (
              <div className="space-y-2">
                {shipment.shipToEmail && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <a href={`mailto:${shipment.shipToEmail}`} className="hover:underline">
                      {shipment.shipToEmail}
                    </a>
                  </div>
                )}
                {shipment.shipToPhone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <a href={`tel:${shipment.shipToPhone}`} className="hover:underline">
                      {shipment.shipToPhone}
                    </a>
                  </div>
                )}
              </div>
            )}

            {(shipment.shipToAddressLine1 || shipment.shipToCity) && (
              <div>
                <div className="flex items-start gap-2 mb-2">
                  <MapPin className="h-4 w-4 text-muted-foreground mt-1" />
                  <p className="text-sm text-muted-foreground">Address</p>
                </div>
                <div className="pl-6 space-y-1">
                  {shipment.shipToCompany && <p className="font-semibold">{shipment.shipToCompany}</p>}
                  {shipment.shipToAddressLine1 && <p>{shipment.shipToAddressLine1}</p>}
                  {shipment.shipToAddressLine2 && <p>{shipment.shipToAddressLine2}</p>}
                  {shipment.shipToAddressLine3 && <p>{shipment.shipToAddressLine3}</p>}
                  <p>
                    {[shipment.shipToCity, shipment.shipToState, shipment.shipToPostalCode]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  {shipment.shipToCountry && <p>{shipment.shipToCountry}</p>}
                  {shipment.shipToIsResidential && (
                    <p className="text-sm text-muted-foreground mt-2">
                      {shipment.shipToIsResidential === 'yes' ? 'Residential Address' : shipment.shipToIsResidential === 'no' ? 'Commercial Address' : ''}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Shipping Details */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Shipping Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shipment.carrierCode && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Carrier</p>
                <p className="text-xl font-semibold uppercase">{shipment.carrierCode}</p>
              </div>
            )}

            {shipment.serviceCode && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Service</p>
                <p className="text-lg">{shipment.serviceCode}</p>
              </div>
            )}

            {shipment.totalWeight && (
              <div className="flex items-center gap-2">
                <Weight className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Weight</p>
                  <p className="text-lg font-semibold">{shipment.totalWeight}</p>
                </div>
              </div>
            )}

            {shipment.orderDate && (
              <div className="flex items-start gap-2">
                <Clock className="h-4 w-4 text-muted-foreground mt-1" />
                <div>
                  <p className="text-sm text-muted-foreground">Created</p>
                  <p className="text-lg">{new Date(shipment.orderDate).toLocaleString()}</p>
                  <p className="text-sm text-muted-foreground">({formatRelativeTime(shipment.orderDate)})</p>
                </div>
              </div>
            )}

            {shipment.shipDate && (
              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground mt-1" />
                <div>
                  <p className="text-sm text-muted-foreground">Shipped</p>
                  <p className="text-lg">{new Date(shipment.shipDate).toLocaleString()}</p>
                </div>
              </div>
            )}

            {/* Session/Spot Info */}
            {(() => {
              const sessionInfo = parseCustomField2(shipment.customField2);
              if (!sessionInfo) return null;
              return (
                <div className="flex items-start gap-2">
                  <Boxes className="h-4 w-4 text-muted-foreground mt-1" />
                  <div>
                    <p className="text-sm text-muted-foreground">Pick Session</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedSessionId(sessionInfo.sessionId)}
                        className="text-lg font-semibold text-primary hover:underline cursor-pointer"
                        data-testid={`link-session-${sessionInfo.sessionId}`}
                      >
                        Session {sessionInfo.sessionId}
                      </button>
                      <Badge variant="secondary">
                        Spot #{sessionInfo.spot}
                      </Badge>
                    </div>
                  </div>
                </div>
              );
            })()}

            {shipment.labelUrl && (
              <div className="pt-2">
                <Button
                  variant="default"
                  className="w-full"
                  onClick={() => window.open(shipment.labelUrl!, '_blank')}
                  data-testid="button-view-label"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Shipping Label
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Special Notes */}
      {(shipment.notesForGift || shipment.notesFromBuyer) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Special Instructions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {shipment.notesForGift && (
              <div className="bg-pink-50 dark:bg-pink-950/20 border border-pink-200 dark:border-pink-800 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Gift className="h-5 w-5 text-pink-600 dark:text-pink-400" />
                  <p className="font-semibold text-pink-700 dark:text-pink-400">Gift Message</p>
                </div>
                <p className="text-lg" data-testid="text-gift-message">{shipment.notesForGift}</p>
              </div>
            )}
            {shipment.notesFromBuyer && (
              <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-sm font-semibold text-blue-700 dark:text-blue-400 mb-2">Customer Notes</p>
                <p className="text-lg" data-testid="text-buyer-notes">{shipment.notesFromBuyer}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Items - with tabs for Purchased vs Fulfilled */}
      {((items && items.length > 0) || (qcItems && qcItems.length > 0)) && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Items
              </CardTitle>
              {tags && tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag, index) => (
                    <Badge key={index} variant="secondary">
                      {tag.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="purchased" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="purchased" className="flex items-center gap-2" data-testid="tab-purchased-items">
                  <ShoppingCart className="h-4 w-4" />
                  Purchased Items ({items?.length || 0})
                </TabsTrigger>
                <TabsTrigger value="fulfilled" className="flex items-center gap-2" data-testid="tab-fulfilled-items">
                  <PackageCheck className="h-4 w-4" />
                  Fulfilled Items ({qcItems?.length || 0})
                </TabsTrigger>
              </TabsList>
              
              {/* Purchased Items Tab */}
              <TabsContent value="purchased">
                {items && items.length > 0 ? (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left px-6 py-4 font-semibold">SKU</th>
                          <th className="text-left px-6 py-4 font-semibold">Product</th>
                          <th className="text-center px-6 py-4 font-semibold">Quantity</th>
                          <th className="text-right px-6 py-4 font-semibold">Unit Price</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {items.map((item, index) => (
                          <tr key={index} className="hover-elevate" data-testid={`row-purchased-item-${index}`}>
                            <td className="px-6 py-4">
                              <code className="text-sm font-mono bg-muted px-3 py-1.5 rounded">
                                {item.sku || 'N/A'}
                              </code>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                {item.imageUrl && (
                                  <img 
                                    src={item.imageUrl} 
                                    alt={item.name || 'Product'}
                                    className="w-16 h-16 object-cover rounded border"
                                  />
                                )}
                                <span className="text-base font-medium">{item.name || 'Unknown Product'}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className="text-xl font-bold">{item.quantity}</span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-lg">
                                {item.unitPrice ? `$${parseFloat(item.unitPrice).toFixed(2)}` : 'N/A'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    No purchased items found
                  </div>
                )}
              </TabsContent>
              
              {/* Fulfilled Items Tab (QC Items - exploded kits) */}
              <TabsContent value="fulfilled">
                {qcItems && qcItems.length > 0 ? (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left px-6 py-4 font-semibold">SKU</th>
                          <th className="text-left px-6 py-4 font-semibold">Barcode</th>
                          <th className="text-left px-6 py-4 font-semibold">Product</th>
                          <th className="text-center px-6 py-4 font-semibold">Qty Expected</th>
                          <th className="text-right px-6 py-4 font-semibold">Weight</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {qcItems.map((qcItem, index) => (
                          <tr key={qcItem.id || index} className="hover-elevate" data-testid={`row-fulfilled-item-${index}`}>
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                <code className="text-sm font-mono bg-muted px-3 py-1.5 rounded">
                                  {qcItem.sku || 'N/A'}
                                </code>
                                {qcItem.isKitComponent && qcItem.parentSku && (
                                  <span className="text-xs text-muted-foreground">
                                    from kit: {qcItem.parentSku}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <code className="text-sm font-mono text-muted-foreground">
                                {qcItem.barcode || 'N/A'}
                              </code>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                {qcItem.imageUrl && (
                                  <img 
                                    src={qcItem.imageUrl} 
                                    alt={qcItem.description || 'Product'}
                                    className="w-16 h-16 object-cover rounded border"
                                  />
                                )}
                                <span className="text-base font-medium">{qcItem.description || 'Unknown Product'}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className="text-xl font-bold">{qcItem.quantityExpected}</span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-lg">
                                {qcItem.weightValue ? `${qcItem.weightValue} ${qcItem.weightUnit || 'oz'}` : 'N/A'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No fulfilled items yet</p>
                    <p className="text-sm mt-1">Fulfilled items appear once the order is tagged "MOVE OVER" and ready for picking</p>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      {/* Packages */}
      {packages && packages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Boxes className="h-5 w-5" />
              Packages ({packages.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left px-6 py-4 font-semibold">Package</th>
                    <th className="text-center px-6 py-4 font-semibold">Weight</th>
                    <th className="text-center px-6 py-4 font-semibold">Dimensions</th>
                    <th className="text-right px-6 py-4 font-semibold">Insured Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {packages.map((pkg, index) => {
                    const hasSize = pkg.dimensionLength && pkg.dimensionWidth && pkg.dimensionHeight &&
                      (parseFloat(pkg.dimensionLength) > 0 || parseFloat(pkg.dimensionWidth) > 0 || parseFloat(pkg.dimensionHeight) > 0);
                    
                    return (
                      <tr key={pkg.id || index} className="hover-elevate" data-testid={`row-package-${index}`}>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="text-base font-medium">{pkg.packageName || 'Package'}</span>
                            {pkg.packageCode && (
                              <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1 rounded w-fit">
                                {pkg.packageCode}
                              </code>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center">
                          {pkg.weightValue && pkg.weightUnit ? (
                            <span className="text-lg font-medium">
                              {pkg.weightValue} {pkg.weightUnit}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {hasSize ? (
                            <span className="text-sm">
                              {pkg.dimensionLength} x {pkg.dimensionWidth} x {pkg.dimensionHeight} {pkg.dimensionUnit}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {pkg.insuredAmount && parseFloat(pkg.insuredAmount) > 0 ? (
                            <span className="text-lg">
                              ${parseFloat(pkg.insuredAmount).toFixed(2)} {pkg.insuredCurrency?.toUpperCase()}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Smart Session Info */}
      {smartSessionInfo && (smartSessionInfo.fingerprint || smartSessionInfo.session || smartSessionInfo.packagingType || smartSessionInfo.qcStation) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Fingerprint className="h-5 w-5" />
              Smart Session
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Fingerprint */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
                  <Fingerprint className="h-4 w-4" />
                  Fingerprint
                </div>
                {smartSessionInfo.fingerprint ? (
                  <div className="space-y-1">
                    <p className="text-base font-medium">
                      {smartSessionInfo.fingerprint.displayName || 'Unnamed'}
                    </p>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {smartSessionInfo.fingerprint.totalItems} items
                      </Badge>
                      {smartSessionInfo.fingerprint.totalWeight && (
                        <Badge variant="outline" className="text-xs">
                          {smartSessionInfo.fingerprint.totalWeight} {smartSessionInfo.fingerprint.weightUnit}
                        </Badge>
                      )}
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
              </div>

              {/* Session ID & Spot */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
                  <Hash className="h-4 w-4" />
                  Session
                </div>
                {smartSessionInfo.session ? (
                  <div className="space-y-1">
                    <p className="text-base font-medium">
                      {smartSessionInfo.session.name || `Session #${smartSessionInfo.session.id}`}
                    </p>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {smartSessionInfo.session.status}
                      </Badge>
                      {smartSessionInfo.spotNumber && (
                        <Badge variant="secondary" className="text-xs">
                          Spot #{smartSessionInfo.spotNumber}
                        </Badge>
                      )}
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
              </div>

              {/* Packaging Type */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
                  <Box className="h-4 w-4" />
                  Packaging Type
                </div>
                {smartSessionInfo.packagingType ? (
                  <div className="space-y-1">
                    <p className="text-base font-medium">{smartSessionInfo.packagingType.name}</p>
                    {smartSessionInfo.packagingType.stationType && (
                      <Badge variant="outline" className="text-xs">
                        {smartSessionInfo.packagingType.stationType.replace(/_/g, ' ')}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
              </div>

              {/* QC Station */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-muted-foreground text-sm font-medium">
                  <MapPinned className="h-4 w-4" />
                  QC Station
                </div>
                {smartSessionInfo.qcStation ? (
                  <div className="space-y-1">
                    <p className="text-base font-medium">{smartSessionInfo.qcStation.name}</p>
                    {smartSessionInfo.qcStation.stationType && (
                      <Badge variant="outline" className="text-xs">
                        {smartSessionInfo.qcStation.stationType.replace(/_/g, ' ')}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not assigned</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session Detail Modal */}
      <SessionDetailDialog 
        picklistId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
