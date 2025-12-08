import { Package, MapPin, Truck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export interface ShippableShipmentOption {
  id: string;
  shipmentId: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentStatus: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  trackingNumber: string | null;
}

interface ShipmentChoiceDialogProps {
  open: boolean;
  orderNumber: string;
  shippableShipments: ShippableShipmentOption[];
  onSelect: (shipmentId: string) => void;
  onCancel: () => void;
}

export function ShipmentChoiceDialog({
  open,
  orderNumber,
  shippableShipments,
  onSelect,
  onCancel,
}: ShipmentChoiceDialogProps) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="max-w-2xl" data-testid="dialog-shipment-choice">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-xl">
            <Package className="h-6 w-6 text-primary" />
            Multiple Shipments Found
          </AlertDialogTitle>
          <AlertDialogDescription className="text-base">
            Order <span className="font-semibold text-foreground">{orderNumber}</span> has{" "}
            <span className="font-semibold text-foreground">{shippableShipments.length}</span>{" "}
            shippable shipments. Select which one you are packing:
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-3 py-4" data-testid="shipment-options-list">
          {shippableShipments.map((shipment, index) => (
            <Card
              key={shipment.id}
              className="cursor-pointer transition-colors hover-elevate border-2 hover:border-primary/50"
              data-testid={`card-shipment-option-${shipment.id}`}
              onClick={() => onSelect(shipment.id)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono">
                        Shipment {index + 1}
                      </Badge>
                      {shipment.carrierCode && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                          <Truck className="h-3 w-3" />
                          {shipment.carrierCode}
                          {shipment.serviceCode && ` - ${shipment.serviceCode}`}
                        </Badge>
                      )}
                      {shipment.trackingNumber && (
                        <Badge variant="destructive">Already Shipped</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      <span className="font-medium text-foreground">{shipment.shipToName || "Unknown"}</span>
                      {(shipment.shipToCity || shipment.shipToState) && (
                        <span>
                          — {[shipment.shipToCity, shipment.shipToState].filter(Boolean).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      ID: {shipment.shipmentId || shipment.id}
                    </div>
                  </div>
                  <Button
                    size="lg"
                    data-testid={`button-select-shipment-${shipment.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(shipment.id);
                    }}
                  >
                    Select
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={onCancel}
            data-testid="button-cancel-shipment-selection"
          >
            Cancel
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
