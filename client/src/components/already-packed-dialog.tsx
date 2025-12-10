import { useState, useEffect } from "react";
import {
  Package,
  MapPin,
  Truck,
  Printer,
  Loader2,
  AlertCircle,
  Copy,
  CheckCircle2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/hooks/use-toast";

export interface AlreadyPackedShipmentItem {
  sku: string | null;
  name: string;
  quantity: number;
  imageUrl?: string | null;
}

export interface AlreadyPackedShipment {
  id: string;
  orderNumber: string;
  trackingNumber: string | null;
  carrier: string | null;
  serviceCode: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  items?: AlreadyPackedShipmentItem[];
}

interface AlreadyPackedDialogProps {
  open: boolean;
  shipments: AlreadyPackedShipment[];
  isReprintPending: boolean;
  onReprint: (shipmentId: string, orderNumber: string) => void;
  onProceedToQC: (shipment: AlreadyPackedShipment) => void;
  onCancel: () => void;
}

export function AlreadyPackedDialog({
  open,
  shipments,
  isReprintPending,
  onReprint,
  onProceedToQC,
  onCancel,
}: AlreadyPackedDialogProps) {
  const { toast } = useToast();
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);

  // Reset selection when shipments change (handles dialog open/close cycles and new orders)
  useEffect(() => {
    if (shipments.length === 1) {
      // Auto-select when there's only one shipment
      setSelectedShipmentId(shipments[0]?.id || null);
    } else if (shipments.length > 1) {
      // Reset selection for multi-shipment - user must choose
      setSelectedShipmentId(null);
    } else {
      // No shipments - reset
      setSelectedShipmentId(null);
    }
  }, [shipments]);

  const isMultipleShipments = shipments.length > 1;
  const selectedShipment = shipments.find((s) => s.id === selectedShipmentId);
  const orderNumber = shipments[0]?.orderNumber || "";

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied", description: text, duration: 1500 });
    });
  };

  const handleSelectShipment = (shipmentId: string) => {
    setSelectedShipmentId(shipmentId);
  };

  const handleReprint = () => {
    if (selectedShipment) {
      onReprint(selectedShipment.id, selectedShipment.orderNumber);
    }
  };

  const handleProceedToQC = () => {
    if (selectedShipment) {
      onProceedToQC(selectedShipment);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(openState) => {
        if (!openState) onCancel();
      }}
    >
      <DialogContent
        className={isMultipleShipments ? "sm:max-w-2xl max-h-[85vh] overflow-y-auto" : "sm:max-w-md"}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        hideCloseButton
        data-testid="dialog-already-packed"
      >
        <DialogHeader>
          <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center">
            <AlertCircle className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          </div>
          <DialogTitle className="text-center text-xl">
            Order Already Packed
          </DialogTitle>
          <DialogDescription className="text-center">
            {isMultipleShipments ? (
              <>
                This order has <span className="font-semibold text-foreground">{shipments.length} shipments</span> that are already packed.
                Select which shipment you want to reprint or proceed to QC.
              </>
            ) : (
              "This order has already been packed and has a shipping label."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isMultipleShipments ? (
            <div className="grid gap-3" data-testid="shipment-selection-list">
              {shipments.map((shipment, index) => {
                const isSelected = selectedShipmentId === shipment.id;
                return (
                  <Card
                    key={shipment.id}
                    className={`transition-all cursor-pointer hover-elevate ${
                      isSelected
                        ? "border-2 border-primary ring-2 ring-primary/20 bg-primary/5"
                        : "border-2 border-transparent hover:border-muted-foreground/30"
                    }`}
                    onClick={() => handleSelectShipment(shipment.id)}
                    data-testid={`card-shipment-${shipment.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isSelected && (
                              <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0" />
                            )}
                            <Badge variant="outline" className="font-mono">
                              Shipment {index + 1}
                            </Badge>
                            {shipment.carrier && (
                              <Badge
                                variant="secondary"
                                className="flex items-center gap-1"
                              >
                                <Truck className="h-3 w-3" />
                                {shipment.carrier}
                                {shipment.serviceCode &&
                                  ` - ${shipment.serviceCode}`}
                              </Badge>
                            )}
                          </div>

                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <MapPin className="h-4 w-4" />
                            <span className="font-medium text-foreground">
                              {shipment.shipToName || "Unknown"}
                            </span>
                            {(shipment.shipToCity || shipment.shipToState) && (
                              <span>
                                —{" "}
                                {[shipment.shipToCity, shipment.shipToState]
                                  .filter(Boolean)
                                  .join(", ")}
                              </span>
                            )}
                          </div>

                          {shipment.trackingNumber && (
                            <div className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">
                                Tracking:
                              </span>
                              <Badge
                                variant="outline"
                                className="font-mono text-xs cursor-pointer hover-elevate"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyToClipboard(shipment.trackingNumber!);
                                }}
                              >
                                {shipment.trackingNumber}
                                <Copy className="h-3 w-3 ml-1" />
                              </Badge>
                            </div>
                          )}

                          {shipment.items && shipment.items.length > 0 && (
                            <Accordion
                              type="single"
                              collapsible
                              className="w-full"
                            >
                              <AccordionItem value="items" className="border-0 border-none">
                                <AccordionTrigger
                                  className="py-2 text-sm text-muted-foreground hover:no-underline focus:outline-none focus-visible:outline-none focus-visible:ring-0"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`accordion-trigger-items-${shipment.id}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <Package className="h-4 w-4" />
                                    <span>
                                      {shipment.items.length} item
                                      {shipment.items.length > 1 ? "s" : ""}
                                    </span>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent
                                  className="pb-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="space-y-1 pl-6 pt-1">
                                    {shipment.items.map((item, itemIndex) => (
                                      <div
                                        key={itemIndex}
                                        className="flex items-center gap-2 text-sm"
                                        data-testid={`item-${shipment.id}-${itemIndex}`}
                                      >
                                        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                                          {item.quantity}x
                                        </span>
                                        <span className="font-mono text-xs text-muted-foreground">
                                          {item.sku || "N/A"}
                                        </span>
                                        <span className="truncate text-foreground">
                                          {item.name}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Order Number:</span>
                <span className="font-semibold">{orderNumber}</span>
              </div>
              {shipments[0]?.trackingNumber && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tracking:</span>
                  <Badge
                    variant="outline"
                    className="font-mono text-xs cursor-pointer hover-elevate"
                    onClick={() => copyToClipboard(shipments[0].trackingNumber!)}
                  >
                    {shipments[0].trackingNumber}
                    <Copy className="h-3 w-3 ml-1" />
                  </Badge>
                </div>
              )}
              
              {shipments[0]?.items && shipments[0].items.length > 0 && (
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="items" className="border-0 border-none">
                    <AccordionTrigger
                      className="py-2 text-sm text-muted-foreground hover:no-underline focus:outline-none focus-visible:outline-none focus-visible:ring-0"
                      data-testid="accordion-trigger-items-single"
                    >
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4" />
                        <span>
                          {shipments[0].items.length} item
                          {shipments[0].items.length > 1 ? "s" : ""}
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-0">
                      <div className="space-y-1 pt-1">
                        {shipments[0].items.map((item, itemIndex) => (
                          <div
                            key={itemIndex}
                            className="flex items-center gap-2 text-sm"
                            data-testid={`item-single-${itemIndex}`}
                          >
                            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                              {item.quantity}x
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {item.sku || "N/A"}
                            </span>
                            <span className="truncate text-foreground">
                              {item.name}
                            </span>
                          </div>
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>
          )}

          {isMultipleShipments && !selectedShipmentId && (
            <p className="text-sm text-center text-muted-foreground">
              Select a shipment above to reprint or proceed to QC
            </p>
          )}

          {(selectedShipmentId || !isMultipleShipments) && (
            <p className="text-sm text-center text-muted-foreground">
              Do you want to reprint the shipping label?
            </p>
          )}

          <div className="flex justify-center">
            <Button
              variant="destructive"
              onClick={handleReprint}
              disabled={isReprintPending || !selectedShipmentId}
              data-testid="button-reprint-label"
            >
              {isReprintPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reprinting...
                </>
              ) : (
                <>
                  <Printer className="h-4 w-4 mr-2" />
                  Re-print Label
                </>
              )}
            </Button>
          </div>
        </div>

        <DialogFooter className="flex gap-2 sm:justify-center">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1"
            data-testid="button-cancel-already-packed"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleProceedToQC}
            disabled={!selectedShipmentId}
            className="flex-1"
            data-testid="button-proceed-to-qc"
          >
            Proceed to QC
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
