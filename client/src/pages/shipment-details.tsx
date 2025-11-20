import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Truck, Package, MapPin, User, Mail, Phone, Clock, Copy, ExternalLink, Calendar, Weight, Gift, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Shipment, Order, ShipmentItem, ShipmentTag } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

interface ShipmentWithOrder extends Shipment {
  order: Order | null;
}

export default function ShipmentDetails() {
  const [, params] = useRoute("/shipments/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const shipmentId = params?.id;

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
      "delivered": { variant: "default", className: "bg-green-600 hover:bg-green-700 text-lg", label: "Delivered" },
      "in_transit": { variant: "default", className: "bg-blue-600 hover:bg-blue-700 text-lg", label: "In Transit" },
      "shipped": { variant: "secondary", className: "text-lg", label: "Shipped" },
      "cancelled": { variant: "outline", className: "border-red-500 text-red-700 dark:text-red-400 text-lg", label: "Cancelled" },
    };

    const config = statusConfig[status.toLowerCase()] || { variant: "outline" as const, className: "text-lg", label: status };
    
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

      {/* Items */}
      {items && items.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Items ({items.length})
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
                    <tr key={index} className="hover-elevate">
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
