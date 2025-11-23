import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { QCPassItemResponse } from "@shared/skuvault-types";
import {
  PackageCheck,
  Scan,
  CheckCircle2,
  XCircle,
  Package,
  Truck,
  MapPin,
  Loader2,
  AlertCircle,
  User,
  Mail,
  Phone,
} from "lucide-react";

type ShipmentItem = {
  id: string;
  shipmentId: string;
  orderItemId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  unitPrice: string | null;
  imageUrl: string | null;
};

type ShipmentWithItems = {
  id: string;
  shipmentId: string | null;
  orderNumber: string;
  trackingNumber: string | null;
  carrier: string | null;
  serviceCode: string | null;
  statusDescription: string | null;
  shipTo: string | null;
  totalWeight: string | null;
  createdAt: string;
  orderId: string | null;
  labelUrl: string | null;
  // Customer shipping details
  shipToName: string | null;
  shipToPhone: string | null;
  shipToEmail: string | null;
  shipToCompany: string | null;
  shipToAddressLine1: string | null;
  shipToAddressLine2: string | null;
  shipToAddressLine3: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToPostalCode: string | null;
  shipToCountry: string | null;
  shipToIsResidential: string | null;
  items: ShipmentItem[];
  saleId: string | null; // SkuVault SaleId (cached from initial lookup)
};

type PackingLog = {
  id: string;
  action: string;
  productSku: string | null;
  scannedCode: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
};

type SkuVaultProduct = {
  IdItem?: string | null;
  Sku?: string | null;
  Description?: string | null;
  Code?: string | null;
  PartNumber?: string | null;
  IsKit?: boolean | null;
  WeightPound?: number | null;
  ProductPictures?: string[] | null;
};

type SkuVaultProductResponse = {
  product: SkuVaultProduct;
  rawResponse: any; // Raw SkuVault API response for audit logging
};

type SkuProgress = {
  itemId: string; // Shipment item database ID
  sku: string;
  normalizedSku: string; // For matching scans
  name: string;
  expected: number;
  scanned: number;
  remaining: number; // Tracks remaining units to scan for this specific item
  requiresManualVerification?: boolean; // For items without SKU
};

export default function Packing() {
  const { toast } = useToast();
  const orderInputRef = useRef<HTMLInputElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);

  const [orderScan, setOrderScan] = useState("");
  const [productScan, setProductScan] = useState("");
  const [currentShipment, setCurrentShipment] = useState<ShipmentWithItems | null>(null);
  // Use item ID as key to handle duplicate SKUs properly
  const [skuProgress, setSkuProgress] = useState<Map<string, SkuProgress>>(new Map());
  const [packingComplete, setPackingComplete] = useState(false);
  
  // Helper to normalize SKUs for comparison (uppercase, trimmed)
  const normalizeSku = (sku: string) => sku.trim().toUpperCase();

  // Focus order input on mount
  useEffect(() => {
    orderInputRef.current?.focus();
  }, []);

  // Initialize SKU progress when shipment loads (keyed by item ID to handle duplicate SKUs)
  useEffect(() => {
    if (currentShipment?.items) {
      const progress = new Map<string, SkuProgress>();
      
      // Filter out non-physical items (discounts, adjustments, fees)
      const physicalItems = currentShipment.items.filter((item) => {
        // Exclude items with negative prices (discounts/adjustments)
        const unitPrice = item.unitPrice ? parseFloat(item.unitPrice) : 0;
        if (unitPrice < 0) {
          console.log(`[Packing] Filtering out discount/adjustment item: ${item.name} (price: ${unitPrice})`);
          return false;
        }
        
        // Exclude items with no SKU AND no name (malformed data)
        if (!item.sku && !item.name) {
          console.log(`[Packing] Filtering out malformed item with no SKU or name`);
          return false;
        }
        
        return true;
      });
      
      physicalItems.forEach((item) => {
        // Use item ID as key to handle duplicate SKUs properly
        const key = item.id;
        if (item.sku) {
          progress.set(key, {
            itemId: item.id,
            sku: item.sku, // Keep original for display
            normalizedSku: normalizeSku(item.sku), // For matching scans
            name: item.name,
            expected: item.quantity,
            scanned: 0,
            remaining: item.quantity, // Track remaining units for this specific item
            requiresManualVerification: false,
          });
        } else {
          progress.set(key, {
            itemId: item.id,
            sku: "NO SKU",
            normalizedSku: "",
            name: item.name,
            expected: item.quantity,
            scanned: 0,
            remaining: item.quantity,
            requiresManualVerification: true,
          });
        }
      });
      setSkuProgress(progress);
    } else {
      setSkuProgress(new Map());
    }
  }, [currentShipment]);

  // Load packing logs for current shipment
  const { data: packingLogs } = useQuery<PackingLog[]>({
    queryKey: currentShipment ? ["/api/packing-logs/shipment", currentShipment.id] : [],
    enabled: !!currentShipment,
  });

  // Restore SKU progress from historical packing logs when they load
  useEffect(() => {
    if (!packingLogs || packingLogs.length === 0 || skuProgress.size === 0) return;
    
    // Process logs chronologically (reverse since backend returns newest first)
    const chronologicalLogs = [...packingLogs].reverse();
    
    setSkuProgress((prevProgress) => {
      // Reset all counters to 0 to make restoration idempotent
      const updatedProgress = new Map<string, SkuProgress>();
      prevProgress.forEach((progress, key) => {
        updatedProgress.set(key, {
          ...progress,
          scanned: 0,
          remaining: progress.expected,
        });
      });
      
      // Process each log in chronological order
      chronologicalLogs.forEach((log) => {
        // Count successful product scans AND manual verifications
        if (log.success && (log.action === "product_scanned" || log.action === "manual_verification")) {
          if (!log.productSku) return;
          
          // Handle SKU-less items: logs store "NO SKU" but progress map uses empty string
          const isNoSku = log.productSku === "NO SKU";
          const normalizedSku = isNoSku ? "" : normalizeSku(log.productSku);
          
          // Find the first item with this SKU that still has remaining capacity
          for (const [key, progress] of Array.from(updatedProgress.entries())) {
            const skuMatches = isNoSku 
              ? progress.requiresManualVerification && progress.normalizedSku === ""
              : progress.normalizedSku === normalizedSku;
              
            if (skuMatches && progress.scanned < progress.expected) {
              // Increment this specific item's scan count
              updatedProgress.set(key, {
                ...progress,
                scanned: progress.scanned + 1,
                remaining: progress.remaining - 1,
              });
              break; // Only increment one item per scan
            }
          }
        }
      });
      
      return updatedProgress;
    });
    
    console.log(`[Packing] Restored progress from ${packingLogs.length} historical log(s)`);
  }, [packingLogs, skuProgress.size]); // Re-run when logs load or when skuProgress is initialized

  // Load shipment by order number (includes items from backend)
  const loadShipmentMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const response = await apiRequest("GET", `/api/shipments/by-order-number/${encodeURIComponent(orderNumber)}`);
      return (await response.json()) as ShipmentWithItems;
    },
    onSuccess: (shipment) => {
      if (!shipment.items || shipment.items.length === 0) {
        toast({
          title: "No Items Found",
          description: "This shipment has no items to pack",
          variant: "destructive",
        });
        setOrderScan("");
        return;
      }

      // Warn about items without SKUs - they'll require manual verification
      const itemsWithoutSku = shipment.items.filter((item) => !item.sku);
      if (itemsWithoutSku.length > 0) {
        toast({
          title: "Manual Verification Required",
          description: `${itemsWithoutSku.length} item(s) without SKU. Verify manually before completing.`,
        });
      }

      setCurrentShipment(shipment);
      setPackingComplete(false);
      
      // Log order loaded event
      logShipmentEvent("order_loaded", {
        shipmentId: shipment.id,
        itemCount: shipment.items.length,
        orderNumber: shipment.orderNumber,
      }, shipment.orderNumber);
      
      toast({
        title: "Order Loaded",
        description: `${shipment.items.length} item(s) ready for packing`,
      });
      // Focus product input after loading shipment
      setTimeout(() => productInputRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      toast({
        title: "Order Not Found",
        description: error.message,
        variant: "destructive",
      });
      setOrderScan("");
    },
  });

  // Pass QC item in SkuVault
  const passQcItemMutation = useMutation({
    mutationFn: async (params: {
      skuVaultProductId: string;
      scannedCode: string;
      saleId: string | null;
      orderNumber: string;
    }) => {
      const response = await apiRequest("POST", "/api/skuvault/qc/pass-item", {
        IdItem: params.skuVaultProductId,
        Quantity: 1,
        IdSale: params.saleId, // Cached SaleId (or null if not found in SkuVault)
        OrderNumber: params.orderNumber, // Fallback for backend lookup if needed
        ScannedCode: params.scannedCode,
        Note: null,
        SerialNumber: "",
      });
      return (await response.json()) as QCPassItemResponse;
    },
  });

  // Get picked quantity from SkuVault (for sync validation)
  const getPickedQuantityMutation = useMutation({
    mutationFn: async (params: {
      codeOrSku: string;
      saleId: string;
    }) => {
      const response = await apiRequest(
        "GET", 
        `/api/skuvault/qc/picked-quantity?codeOrSku=${encodeURIComponent(params.codeOrSku)}&saleId=${encodeURIComponent(params.saleId)}`
      );
      return (await response.json()) as { pickedQuantity: number | null };
    },
  });

  // Validate product with SkuVault QC
  const validateProductMutation = useMutation({
    mutationFn: async (scannedCode: string) => {
      const response = await apiRequest("GET", `/api/skuvault/qc/product/${encodeURIComponent(scannedCode)}`);
      return (await response.json()) as SkuVaultProductResponse;
    },
    onSuccess: async (data, scannedCode) => {
      const { product, rawResponse } = data;
      // Normalize scanned SKU for comparison (handle undefined Sku)
      const normalizedSku = normalizeSku(product.Sku || "");
      
      // Find first item with matching SKU that still has remaining units
      let matchingItemKey: string | null = null;
      let matchingProgress: SkuProgress | null = null;
      
      for (const [key, progress] of Array.from(skuProgress.entries())) {
        if (progress.normalizedSku === normalizedSku && progress.remaining > 0) {
          matchingItemKey = key;
          matchingProgress = progress;
          break; // Use first item with remaining units
        }
      }

      const progress = matchingProgress;
      
      if (!progress) {
        // SKU not in shipment
        await createPackingLog({
          action: "product_scanned",
          productSku: product.Sku || "",
          scannedCode,
          skuVaultProductId: product.IdItem || null,
          success: false,
          errorMessage: `SKU ${product.Sku} not in this shipment`,
          skuVaultRawResponse: rawResponse,
        });

        toast({
          title: "Wrong Product",
          description: `${product.Sku} is not in this shipment`,
          variant: "destructive",
        });

        setProductScan("");
        productInputRef.current?.focus();
        return;
      }

      // Sync with SkuVault picked quantity (call FIRST before proceeding with scan)
      let syncedFromSkuVault = false;
      let currentProgress = progress; // Track latest progress (including potential SkuVault sync)
      
      if (currentShipment?.saleId && product.Sku) {
        try {
          const { pickedQuantity } = await getPickedQuantityMutation.mutateAsync({
            codeOrSku: product.Sku,
            saleId: currentShipment.saleId,
          });
          
          if (pickedQuantity !== null && pickedQuantity > progress.scanned) {
            // SkuVault has more picks than us - sync our progress
            const previousCount = progress.scanned;
            
            // Update currentProgress to reflect SkuVault's state
            currentProgress = {
              ...progress,
              scanned: pickedQuantity,
              remaining: progress.expected - pickedQuantity,
            };
            
            // Update React state
            const newProgress = new Map(skuProgress);
            newProgress.set(matchingItemKey!, currentProgress);
            setSkuProgress(newProgress);
            
            // Log sync event
            await logShipmentEvent("skuvault_picked_quantity_sync", {
              sku: product.Sku,
              barcode: scannedCode,
              itemId: matchingItemKey,
              previousCount,
              skuVaultPickedCount: pickedQuantity,
              syncedCount: pickedQuantity - previousCount,
            });
            
            syncedFromSkuVault = true;
            
            toast({
              title: "Synced with SkuVault",
              description: `Updated ${product.Sku} from ${previousCount} to ${pickedQuantity} scanned (SkuVault already picked ${pickedQuantity - previousCount} units)`,
            });
          }
        } catch (error) {
          console.warn("[Packing] SkuVault sync check failed (non-blocking):", error);
          // Graceful degradation - continue with normal scan flow
        }
      }
      
      // Check if already scanned expected quantity (after potential SkuVault sync)
      if (currentProgress.scanned >= currentProgress.expected) {
        await createPackingLog({
          action: "product_scanned",
          productSku: product.Sku || "",
          scannedCode,
          skuVaultProductId: product.IdItem || null,
          success: false,
          errorMessage: `Already scanned ${currentProgress.scanned}/${currentProgress.expected} units of ${product.Sku}`,
          skuVaultRawResponse: rawResponse,
        });

        toast({
          title: "Already Scanned",
          description: `All ${currentProgress.expected} units of ${product.Sku} already scanned`,
          variant: "destructive",
        });

        setProductScan("");
        productInputRef.current?.focus();
        return;
      }

      // Mark as QC passed in SkuVault (optional - if order doesn't exist in SkuVault, we still proceed)
      let qcPassSuccess = false;
      let qcPassError: string | null = null;
      try {
        const qcResponse = await passQcItemMutation.mutateAsync({
          skuVaultProductId: product.IdItem || "0",
          scannedCode, // Send original scanned code, not normalized
          saleId: currentShipment!.saleId, // Cached SaleId (null if not found)
          orderNumber: currentShipment!.orderNumber, // Fallback for backend
        });
        
        // Validate QC response - SkuVault returns: {"Data": null, "Errors": [], "Success": true}
        const isSuccess = qcResponse.Success === true;
        const hasErrors = qcResponse.Errors && qcResponse.Errors.length > 0;
        
        if (!isSuccess || hasErrors) {
          // Extract error message from Errors array
          qcPassError = qcResponse.Errors?.join(", ") || "QC pass rejected by SkuVault";
          throw new Error(qcPassError);
        }
        
        qcPassSuccess = true;
      } catch (error: any) {
        console.warn("SkuVault QC pass failed (non-fatal):", error);
        qcPassError = error.message || "QC pass failed";
        
        // QC pass failure is non-fatal - we already validated the product exists in SkuVault
        // This typically happens when the order doesn't exist in SkuVault (e.g., Shopify/ShipStation orders)
        // Log the attempt but allow the scan to proceed
        console.log(`[Packing] QC pass skipped for ${product.Sku}: ${qcPassError} (order may not be in SkuVault)`);
      }

      // Log successful scan (product validated via lookup, QC pass is optional enhancement)
      await createPackingLog({
        action: "product_scanned",
        productSku: product.Sku || "",
        scannedCode,
        skuVaultProductId: product.IdItem || null,
        success: true,
        errorMessage: null,
        skuVaultRawResponse: rawResponse,
      });

      // Log shipment event for successful scan
      logShipmentEvent("product_scan_success", {
        sku: product.Sku || "",
        barcode: scannedCode,
        itemId: matchingItemKey,
        scannedCount: currentProgress.scanned + 1,
        expectedCount: currentProgress.expected,
        syncedFromSkuVault,
      });

      // Update progress (using item ID as key, tracking remaining units)
      const newProgress = new Map(skuProgress);
      newProgress.set(matchingItemKey!, {
        ...currentProgress,
        scanned: currentProgress.scanned + 1,
        remaining: currentProgress.remaining - 1, // Decrement remaining for this specific item
      });
      setSkuProgress(newProgress);

      toast({
        title: qcPassSuccess ? "Product Validated & QC Passed" : "Product Validated",
        description: qcPassSuccess 
          ? `${product.Sku} (${currentProgress.scanned + 1}/${currentProgress.expected})`
          : `${product.Sku} (${currentProgress.scanned + 1}/${currentProgress.expected}) - QC pass skipped`,
      });

      setProductScan("");
      productInputRef.current?.focus();
    },
    onError: async (error: Error, scannedCode) => {
      // Log failed scan
      await createPackingLog({
        action: "product_scanned",
        productSku: null,
        scannedCode,
        skuVaultProductId: null,
        success: false,
        errorMessage: error.message,
      });

      // Log shipment event for failed scan
      logShipmentEvent("product_scan_failed", {
        scannedCode,
        errorMessage: error.message,
      });

      toast({
        title: "Product Not Found",
        description: error.message,
        variant: "destructive",
      });

      setProductScan("");
      productInputRef.current?.focus();
    },
  });

  // Create packing log entry
  const createPackingLog = async (log: {
    action: string;
    productSku: string | null;
    scannedCode: string;
    skuVaultProductId: string | null;
    success: boolean;
    errorMessage: string | null;
    skuVaultRawResponse?: any; // Raw SkuVault API response for audit logging
  }) => {
    if (!currentShipment) return;

    await apiRequest("POST", "/api/packing-logs", {
      shipmentId: currentShipment.id,
      orderNumber: currentShipment.orderNumber,
      ...log,
    });

    // Invalidate packing logs to refresh the list
    queryClient.invalidateQueries({
      queryKey: ["/api/packing-logs/shipment", currentShipment.id],
    });
  };

  // Log shipment event (audit trail for analytics)
  const logShipmentEvent = async (eventName: string, metadata?: any, orderNumber?: string) => {
    try {
      await apiRequest("POST", "/api/shipment-events", {
        station: "packing",
        eventName,
        orderNumber: orderNumber || currentShipment?.orderNumber || null,
        metadata,
      });
    } catch (error) {
      console.error("[Packing] Failed to log shipment event:", error);
      // Don't block user workflow if event logging fails
    }
  };

  // Complete packing and queue print job
  const completePackingMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/packing/complete", {
        shipmentId: currentShipment!.id,
      });
      return (await response.json()) as { success: boolean; printQueued: boolean; message?: string };
    },
    onSuccess: (result) => {
      setPackingComplete(true);
      
      // Log packing completed event
      const totalScans = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.scanned, 0);
      logShipmentEvent("packing_completed", {
        totalScans,
        printQueued: result.printQueued,
      });
      
      toast({
        title: "Packing Complete",
        description: result.printQueued ? "Label queued for printing" : result.message || "Order complete",
      });

      // Reset for next order
      setTimeout(() => {
        setCurrentShipment(null);
        setPackingComplete(false);
        setOrderScan("");
        setSkuProgress(new Map());
        orderInputRef.current?.focus();
      }, 2000);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleOrderScan = (e: React.FormEvent) => {
    e.preventDefault();
    if (orderScan.trim()) {
      // Log order scan event
      logShipmentEvent("order_scanned", { scannedValue: orderScan.trim() }, orderScan.trim());
      loadShipmentMutation.mutate(orderScan.trim());
    }
  };

  const handleProductScan = (e: React.FormEvent) => {
    e.preventDefault();
    if (productScan.trim() && currentShipment) {
      validateProductMutation.mutate(productScan.trim());
    }
  };

  const handleCompletePacking = () => {
    completePackingMutation.mutate();
  };

  const handleManualVerify = async (progressKey: string) => {
    const progress = skuProgress.get(progressKey);
    if (!progress || !progress.requiresManualVerification) {
      console.error("Invalid manual verification attempt");
      return;
    }

    // Generate unique timestamp for this batch of manual verifications
    const batchTimestamp = Date.now();
    
    // Log each unit as manually verified with unique identifier
    const logPromises = [];
    for (let i = 0; i < progress.expected; i++) {
      logPromises.push(
        createPackingLog({
          action: "manual_verification",
          productSku: progress.sku,
          scannedCode: `MANUAL_${batchTimestamp}_ITEM_${progress.itemId}_UNIT_${i + 1}`,
          skuVaultProductId: null,
          success: true,
          errorMessage: `Manual verification by supervisor - Item: ${progress.name} (${progress.sku}), Unit ${i + 1} of ${progress.expected}`,
        })
      );
    }
    
    // Wait for all log entries to be created
    await Promise.all(logPromises);

    // Log shipment event for manual verification
    logShipmentEvent("manual_verification", {
      itemId: progress.itemId,
      sku: progress.sku,
      name: progress.name,
      quantity: progress.expected,
    });

    // Mark as verified (scanned)
    const newProgress = new Map(skuProgress);
    newProgress.set(progressKey, {
      ...progress,
      scanned: progress.expected,
      remaining: 0,
    });
    setSkuProgress(newProgress);

    toast({
      title: "Manual Verification Complete",
      description: `${progress.name} (${progress.expected} unit${progress.expected > 1 ? 's' : ''}) verified by supervisor`,
    });
  };

  // Calculate completion status
  const allItemsScanned = Array.from(skuProgress.values()).every((p) => p.scanned >= p.expected);
  const totalExpected = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.expected, 0);
  const totalScanned = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.scanned, 0);
  const successfulScans = packingLogs?.filter((log) => log.success && log.action === "product_scanned").length || 0;
  const failedScans = packingLogs?.filter((log) => !log.success && log.action === "product_scanned").length || 0;

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="flex items-center gap-3 mb-6">
        <PackageCheck className="h-8 w-8 text-primary" />
        <h1 className="text-3xl font-bold">Packing Station</h1>
      </div>

      <div className="space-y-6">
        {/* Row 1: Scan Order + Shipping Label */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Scan Order Barcode */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Scan className="h-5 w-5" />
                Scan Order Barcode
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleOrderScan} className="space-y-4">
                <Input
                  ref={orderInputRef}
                  type="text"
                  placeholder="Scan order number..."
                  value={orderScan}
                  onChange={(e) => setOrderScan(e.target.value)}
                  disabled={loadShipmentMutation.isPending || !!currentShipment}
                  className="text-2xl h-16 text-center font-mono"
                  data-testid="input-order-scan"
                />
                {currentShipment && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCurrentShipment(null);
                      setOrderScan("");
                      setPackingComplete(false);
                      setSkuProgress(new Map());
                      orderInputRef.current?.focus();
                    }}
                    className="w-full"
                    data-testid="button-clear-order"
                  >
                    Scan Different Order
                  </Button>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Shipping Label */}
          {currentShipment ? (
            <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <User className="h-5 w-5" />
                    Shipping Label
                  </CardTitle>
                  <Badge variant="outline" className="w-fit" data-testid="badge-order-number">
                    {currentShipment.orderNumber}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Customer Name */}
                  {currentShipment.shipToName && (
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Ship To</p>
                      <p className="text-xl font-semibold" data-testid="text-ship-to-name">
                        {currentShipment.shipToName}
                      </p>
                    </div>
                  )}

                  {/* Contact Information */}
                  {(currentShipment.shipToEmail || currentShipment.shipToPhone) && (
                    <div className="space-y-2">
                      {currentShipment.shipToEmail && (
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <a href={`mailto:${currentShipment.shipToEmail}`} className="hover:underline text-sm">
                            {currentShipment.shipToEmail}
                          </a>
                        </div>
                      )}
                      {currentShipment.shipToPhone && (
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <a href={`tel:${currentShipment.shipToPhone}`} className="hover:underline text-sm">
                            {currentShipment.shipToPhone}
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Shipping Address */}
                  {(currentShipment.shipToAddressLine1 || currentShipment.shipToCity) && (
                    <div>
                      <div className="flex items-start gap-2 mb-2">
                        <MapPin className="h-4 w-4 text-muted-foreground mt-1" />
                        <p className="text-sm text-muted-foreground">Address</p>
                      </div>
                      <div className="pl-6 space-y-1">
                        {currentShipment.shipToCompany && (
                          <p className="font-semibold">{currentShipment.shipToCompany}</p>
                        )}
                        {currentShipment.shipToAddressLine1 && <p>{currentShipment.shipToAddressLine1}</p>}
                        {currentShipment.shipToAddressLine2 && <p>{currentShipment.shipToAddressLine2}</p>}
                        {currentShipment.shipToAddressLine3 && <p>{currentShipment.shipToAddressLine3}</p>}
                        <p>
                          {[currentShipment.shipToCity, currentShipment.shipToState, currentShipment.shipToPostalCode]
                            .filter(Boolean)
                            .join(', ')}
                        </p>
                        {currentShipment.shipToCountry && <p>{currentShipment.shipToCountry}</p>}
                        {currentShipment.shipToIsResidential && (
                          <p className="text-sm text-muted-foreground mt-2">
                            {currentShipment.shipToIsResidential === 'yes' 
                              ? 'Residential Address' 
                              : currentShipment.shipToIsResidential === 'no' 
                              ? 'Commercial Address' 
                              : ''}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Shipping Method & Tracking */}
                  <div className="pt-4 border-t space-y-3">
                    {currentShipment.carrier && (
                      <div className="flex items-start gap-3">
                        <Package className="h-5 w-5 text-muted-foreground mt-0.5" />
                        <div className="flex-1">
                          <div className="text-sm text-muted-foreground">Shipping Method</div>
                          <div className="font-medium">
                            {currentShipment.carrier} {currentShipment.serviceCode}
                          </div>
                        </div>
                      </div>
                    )}

                    {currentShipment.trackingNumber && (
                      <div className="flex items-start gap-3">
                        <Truck className="h-5 w-5 text-muted-foreground mt-0.5" />
                        <div className="flex-1">
                          <div className="text-sm text-muted-foreground">Tracking Number</div>
                          <div className="font-mono text-sm" data-testid="text-tracking">
                            {currentShipment.trackingNumber}
                          </div>
                        </div>
                      </div>
                    )}

                    {currentShipment.statusDescription && (
                      <div>
                        <div className="text-sm text-muted-foreground mb-1">Status</div>
                        <Badge variant="secondary" data-testid="badge-status">
                          {currentShipment.statusDescription}
                        </Badge>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center text-muted-foreground">
                  <User className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>Scan an order to view shipping label</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Row 2: QC Section (Product Scanning & Items Progress) */}
        {currentShipment && !packingComplete && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Quality Control
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Product Scanner Input */}
              <form onSubmit={handleProductScan}>
                <Input
                  ref={productInputRef}
                  type="text"
                  placeholder="Scan product barcode..."
                  value={productScan}
                  onChange={(e) => setProductScan(e.target.value)}
                  disabled={validateProductMutation.isPending}
                  className="text-2xl h-16 text-center font-mono"
                  data-testid="input-product-scan"
                />
                {validateProductMutation.isPending && (
                  <div className="flex items-center justify-center gap-2 text-muted-foreground mt-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Validating...</span>
                  </div>
                )}
              </form>

              {/* Overall Progress */}
              <div className="p-4 bg-muted rounded-lg">
                <div className="text-sm text-muted-foreground mb-2">Overall Progress</div>
                <div className="flex items-center justify-between">
                  <div className="text-3xl font-bold">
                    {totalScanned} / {totalExpected}
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                      <div>
                        <div className="text-2xl font-bold">{successfulScans}</div>
                        <div className="text-xs text-muted-foreground">Valid</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-red-600" />
                      <div>
                        <div className="text-2xl font-bold">{failedScans}</div>
                        <div className="text-xs text-muted-foreground">Rejected</div>
                      </div>
                    </div>
                    {allItemsScanned && (
                      <CheckCircle2 className="h-8 w-8 text-green-600" />
                    )}
                  </div>
                </div>
                {!allItemsScanned && (
                  <div className="mt-2 h-2 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${totalExpected > 0 ? (totalScanned / totalExpected) * 100 : 0}%` }}
                    />
                  </div>
                )}
              </div>

              {/* Items to Pack - Organized by Status */}
              <div className="space-y-4">
                <h3 className="font-semibold text-lg">Items to Pack</h3>
                
                <div className="space-y-3">
                  {Array.from(skuProgress.entries()).map(([key, progress]) => {
                    const isComplete = progress.scanned >= progress.expected;
                    const isPartial = progress.scanned > 0 && progress.scanned < progress.expected;
                    // Find the matching shipment item to get the image URL
                    const shipmentItem = currentShipment?.items.find(item => item.id === progress.itemId);
                    
                    return (
                      <div
                        key={key}
                        className={`p-4 rounded-lg border-2 transition-all ${
                          isComplete
                            ? "border-green-600 bg-green-50 dark:bg-green-950/20"
                            : progress.requiresManualVerification
                            ? "border-orange-600 bg-orange-50 dark:bg-orange-950/20"
                            : isPartial
                            ? "border-blue-600 bg-blue-50 dark:bg-blue-950/20"
                            : "border-border"
                        }`}
                        data-testid={`progress-${progress.sku}`}
                      >
                        <div className="flex items-start gap-4 mb-3">
                          {/* Product Image */}
                          {shipmentItem?.imageUrl && (
                            <img
                              src={shipmentItem.imageUrl}
                              alt={progress.name}
                              className="w-20 h-20 object-cover rounded-md border flex-shrink-0"
                            />
                          )}
                          
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-lg truncate">{progress.name}</div>
                            <div className="text-sm text-muted-foreground font-mono">
                              {progress.sku}
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                            {isComplete ? (
                              <div className="flex items-center gap-2 text-green-600">
                                <CheckCircle2 className="h-6 w-6 flex-shrink-0" />
                                <span className="font-bold text-sm">Complete</span>
                              </div>
                            ) : progress.requiresManualVerification ? (
                              <AlertCircle className="h-6 w-6 text-orange-600 flex-shrink-0" />
                            ) : null}
                            <span className="text-2xl font-bold whitespace-nowrap">
                              {progress.scanned} / {progress.expected}
                            </span>
                          </div>
                        </div>
                        
                        {/* Show manual verification button for null-SKU items */}
                        {progress.requiresManualVerification && progress.scanned < progress.expected && (
                          <Button
                            onClick={() => handleManualVerify(key)}
                            variant="outline"
                            size="sm"
                            className="w-full mb-3 border-orange-600 text-orange-600 hover:bg-orange-50"
                            data-testid={`button-manual-verify-${progress.sku}`}
                          >
                            <AlertCircle className="h-4 w-4 mr-2" />
                            Verify Manually (Supervisor)
                          </Button>
                        )}

                        {/* Progress Bar */}
                        <div>
                          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                            <span>
                              {isComplete ? "All units scanned" : `${progress.remaining} remaining`}
                            </span>
                            <span>{Math.round((progress.scanned / progress.expected) * 100)}%</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all ${
                                isComplete
                                  ? "bg-green-600"
                                  : progress.requiresManualVerification
                                  ? "bg-orange-600"
                                  : "bg-blue-600"
                              }`}
                              style={{ width: `${(progress.scanned / progress.expected) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Complete Packing Button */}
              <Button
                onClick={handleCompletePacking}
                disabled={!allItemsScanned || completePackingMutation.isPending}
                className="w-full"
                size="lg"
                data-testid="button-complete-packing"
              >
                {completePackingMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Completing...
                  </>
                ) : allItemsScanned ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Complete Packing
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4 mr-2" />
                    Scan All Items First
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Packing Complete Message */}
        {packingComplete && (
          <Card className="border-green-600">
            <CardContent className="pt-6">
              <div className="text-center space-y-4">
                <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
                <div>
                  <h3 className="text-2xl font-bold text-green-600">Packing Complete!</h3>
                  <p className="text-muted-foreground mt-2">Loading next order...</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Row 3: Scan History */}
        {currentShipment && packingLogs && packingLogs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Scan History</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {packingLogs.map((log) => (
                  <div
                    key={log.id}
                    className={`p-3 rounded-lg border ${
                      log.success
                        ? "border-green-200 bg-green-50 dark:bg-green-950/20"
                        : "border-red-200 bg-red-50 dark:bg-red-950/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {log.success ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                          )}
                          <span className="font-medium text-sm">
                            {log.action === "product_scanned" ? "Product Scan" : "Manual Verification"}
                          </span>
                        </div>
                        <div className="text-sm space-y-1">
                          {log.productSku && (
                            <div className="font-mono text-muted-foreground">{log.productSku}</div>
                          )}
                          {log.scannedCode && (
                            <div className="font-mono text-xs text-muted-foreground">
                              Code: {log.scannedCode}
                            </div>
                          )}
                          {log.errorMessage && (
                            <div className="text-red-600 text-xs">{log.errorMessage}</div>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
