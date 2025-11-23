import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { QCPassItemResponse } from "@shared/skuvault-types";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  ChevronDown,
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
  // Gift information
  isGift: boolean | null;
  notesForGift: string | null;
  notesFromBuyer: string | null;
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
  imageUrl?: string | null; // Product image URL
};

type ScanFeedback = {
  type: "success" | "error" | "info";
  title: string;
  message: string;
  sku?: string;
  productName?: string;
  imageUrl?: string | null;
  scannedCount?: number;
  expectedCount?: number;
  timestamp: number;
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
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  
  // Helper to normalize SKUs for comparison (uppercase, trimmed)
  const normalizeSku = (sku: string) => sku.trim().toUpperCase();

  // Audio feedback - Reuse single AudioContext to avoid browser limits
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioResumedRef = useRef(false);

  const getAudioContext = async () => {
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (error) {
        console.warn("AudioContext creation failed:", error);
        return null;
      }
    }
    
    // Resume context if suspended (browser autoplay policy)
    if (audioContextRef.current.state === "suspended" && !audioResumedRef.current) {
      try {
        await audioContextRef.current.resume();
        audioResumedRef.current = true;
      } catch (error) {
        console.warn("AudioContext resume failed:", error);
      }
    }
    
    return audioContextRef.current;
  };

  // Resume audio context on first user interaction (field focus/input)
  const handleFirstInteraction = useCallback(async () => {
    if (!audioResumedRef.current) {
      await getAudioContext();
    }
  }, []);

  const playBeep = async (frequency: number, duration: number) => {
    try {
      const audioContext = await getAudioContext();
      if (!audioContext || audioContext.state !== "running") return;

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = frequency;
      oscillator.type = "sine";

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + duration);
    } catch (error) {
      console.warn("Audio playback failed:", error);
    }
  };

  const playSuccessBeep = () => playBeep(800, 0.15); // High-pitched, short
  const playErrorBeep = () => playBeep(200, 0.3); // Low-pitched, longer

  // Haptic feedback - Trigger vibration
  const vibrate = (pattern: number | number[]) => {
    try {
      if ("vibrate" in navigator) {
        navigator.vibrate(pattern);
      }
    } catch (error) {
      console.warn("Vibration failed:", error);
    }
  };

  // Helper to show scan feedback with multi-channel feedback
  const showScanFeedback = (
    type: "success" | "error" | "info",
    title: string,
    message: string,
    options?: {
      sku?: string;
      productName?: string;
      imageUrl?: string | null;
      scannedCount?: number;
      expectedCount?: number;
    }
  ) => {
    // Visual feedback
    setScanFeedback({
      type,
      title,
      message,
      sku: options?.sku,
      productName: options?.productName,
      imageUrl: options?.imageUrl,
      scannedCount: options?.scannedCount,
      expectedCount: options?.expectedCount,
      timestamp: Date.now(),
    });

    // Audio feedback
    if (type === "success") {
      playSuccessBeep();
      vibrate(100); // Short vibration
    } else if (type === "error") {
      playErrorBeep();
      vibrate([100, 50, 100]); // Double vibration pattern
    } else {
      playSuccessBeep();
      vibrate(50); // Brief vibration
    }
  };

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
            imageUrl: item.imageUrl,
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
            imageUrl: item.imageUrl,
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

  // Clear packing history (for testing/re-scanning)
  const clearHistoryMutation = useMutation({
    mutationFn: async (shipmentId: string) => {
      const response = await apiRequest("DELETE", `/api/packing-logs/shipment/${shipmentId}`);
      return (await response.json()) as { success: boolean; message: string };
    },
    onSuccess: () => {
      // Reset local progress state
      if (currentShipment) {
        // Rebuild initial progress from shipment items (same logic as initial load)
        const progress = new Map<string, SkuProgress>();
        
        // Filter out non-physical items (discounts, adjustments, fees) - same as initial load
        const physicalItems = currentShipment.items.filter((item) => {
          // Exclude items with negative prices (discounts/adjustments)
          const unitPrice = item.unitPrice ? parseFloat(item.unitPrice) : 0;
          if (unitPrice < 0) {
            return false;
          }
          
          // Exclude items with no SKU AND no name (malformed data)
          if (!item.sku && !item.name) {
            return false;
          }
          
          return true;
        });
        
        physicalItems.forEach((item) => {
          const key = item.id;
          if (item.sku) {
            progress.set(key, {
              itemId: item.id,
              sku: item.sku,
              normalizedSku: normalizeSku(item.sku),
              name: item.name,
              expected: item.quantity,
              scanned: 0,
              remaining: item.quantity,
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
        // Clear scan feedback to start fresh
        setScanFeedback(null);
      }
      
      // Invalidate queries to refresh the list
      queryClient.invalidateQueries({
        queryKey: ["/api/packing-logs/shipment", currentShipment?.id],
      });
      
      toast({
        title: "History Cleared",
        description: "Packing history reset. You can now rescan this order.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
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
      
      // STEP 1: Find ANY matching SKU (regardless of remaining quantity)
      let matchingItemKey: string | null = null;
      let matchingProgress: SkuProgress | null = null;
      
      for (const [key, progress] of Array.from(skuProgress.entries())) {
        if (progress.normalizedSku === normalizedSku) {
          // Found a matching SKU - prioritize items with remaining units
          if (!matchingProgress || progress.remaining > 0) {
            matchingItemKey = key;
            matchingProgress = progress;
            if (progress.remaining > 0) {
              break; // Use first item with remaining units
            }
          }
        }
      }
      
      // STEP 2: Check if SKU exists in order at all
      if (!matchingProgress) {
        // SKU not in this order at all
        await createPackingLog({
          action: "product_scanned",
          productSku: product.Sku || "",
          scannedCode,
          skuVaultProductId: product.IdItem || null,
          success: false,
          errorMessage: `SKU ${product.Sku} not in this shipment`,
          skuVaultRawResponse: rawResponse,
        });

        showScanFeedback(
          "error",
          "WRONG ITEM",
          `${product.Sku} not in this order`,
          {
            sku: product.Sku || "",
            productName: product.Description || undefined,
            imageUrl: product.ProductPictures?.[0] || null,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
        return;
      }
      
      // STEP 3: Check if already fully scanned (duplicate scan)
      if (matchingProgress.remaining === 0) {
        await createPackingLog({
          action: "product_scanned",
          productSku: product.Sku || "",
          scannedCode,
          skuVaultProductId: product.IdItem || null,
          success: false,
          errorMessage: `Already scanned ${matchingProgress.scanned}/${matchingProgress.expected} units of ${product.Sku}`,
          skuVaultRawResponse: rawResponse,
        });

        showScanFeedback(
          "info",
          "ALREADY COMPLETE",
          "This item is fully scanned. Scan next item.",
          {
            sku: matchingProgress.sku,
            productName: matchingProgress.name,
            imageUrl: matchingProgress.imageUrl,
            scannedCount: matchingProgress.scanned,
            expectedCount: matchingProgress.expected,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
        return;
      }

      const progress = matchingProgress;

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
            
            showScanFeedback(
              "info",
              "SYNCED WITH SKUVAULT",
              `Updated from ${previousCount} to ${pickedQuantity} scanned (SkuVault already picked ${pickedQuantity - previousCount} units)`,
              {
                sku: product.Sku,
                productName: product.Description || undefined,
                imageUrl: progress.imageUrl,
                scannedCount: pickedQuantity,
                expectedCount: progress.expected,
              }
            );
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

        showScanFeedback(
          "info",
          "ALREADY COMPLETE",
          "This item is fully scanned. Scan next item.",
          {
            sku: currentProgress.sku,
            productName: currentProgress.name,
            imageUrl: currentProgress.imageUrl,
            scannedCount: currentProgress.scanned,
            expectedCount: currentProgress.expected,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
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

      showScanFeedback(
        "success",
        qcPassSuccess ? "SCAN ACCEPTED" : "SCAN ACCEPTED",
        qcPassSuccess 
          ? "Product validated & QC passed in SkuVault"
          : "Product validated (QC pass skipped - order not in SkuVault)",
        {
          sku: product.Sku || "",
          productName: product.Description || currentProgress.name,
          imageUrl: currentProgress.imageUrl,
          scannedCount: currentProgress.scanned + 1,
          expectedCount: currentProgress.expected,
        }
      );

      setProductScan("");
      setTimeout(() => productInputRef.current?.focus(), 0);
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

      showScanFeedback(
        "error",
        "PRODUCT NOT FOUND",
        error.message,
        {
          sku: scannedCode,
        }
      );

      setProductScan("");
      setTimeout(() => productInputRef.current?.focus(), 0);
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
    
    // Return focus to product input
    setTimeout(() => productInputRef.current?.focus(), 0);
  };

  // Calculate completion status
  const allItemsScanned = Array.from(skuProgress.values()).every((p) => p.scanned >= p.expected);
  const totalExpected = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.expected, 0);
  const totalScanned = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.scanned, 0);
  const successfulScans = packingLogs?.filter((log) => log.success && log.action === "product_scanned").length || 0;
  const failedScans = packingLogs?.filter((log) => !log.success && log.action === "product_scanned").length || 0;

  return (
    <div className="container mx-auto p-4 max-w-7xl">
      <div className="flex items-center gap-3 mb-4">
        <PackageCheck className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-bold">Packing Station</h1>
      </div>

      <div className="space-y-4">
        {!currentShipment ? (
          /* No Order Loaded - Show Scan Order Input */
          <Card>
            <CardContent className="pt-6">
              <form onSubmit={handleOrderScan} className="space-y-3">
                <label className="text-sm font-medium flex items-center gap-2">
                  <Scan className="h-4 w-4" />
                  Scan Order Barcode
                </label>
                <Input
                  ref={orderInputRef}
                  type="text"
                  placeholder="Scan order number..."
                  value={orderScan}
                  onChange={(e) => setOrderScan(e.target.value)}
                  disabled={loadShipmentMutation.isPending}
                  className="text-2xl h-16 text-center font-mono"
                  data-testid="input-order-scan"
                />
              </form>
            </CardContent>
          </Card>
        ) : (
          /* Order Loaded - Show Header and QC or Completion */
          <>
            {/* Compact Order Info Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Order</div>
                  <div className="text-xl font-bold font-mono" data-testid="badge-order-number">
                    {currentShipment.orderNumber}
                  </div>
                </div>
                <div className="h-12 w-[2px] bg-border" />
                <div>
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Ship To</div>
                  <div className="text-lg font-semibold" data-testid="text-ship-to-name">
                    {currentShipment.shipToName || 'N/A'}
                  </div>
                </div>
                <div className="h-12 w-[2px] bg-border" />
                <div className="min-w-[200px]">
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Gift Message</div>
                  <div className="text-sm" data-testid="text-gift-message">
                    {currentShipment.isGift && currentShipment.notesForGift ? (
                      <span className="italic text-pink-600">"{currentShipment.notesForGift}"</span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
                <div className="h-12 w-[2px] bg-border" />
                <div className="min-w-[200px]">
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Buyer Notes</div>
                  <div className="text-sm" data-testid="text-buyer-notes">
                    {currentShipment.notesFromBuyer ? (
                      <span className="text-blue-600">{currentShipment.notesFromBuyer}</span>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCurrentShipment(null);
                    setOrderScan("");
                    setPackingComplete(false);
                    setSkuProgress(new Map());
                    orderInputRef.current?.focus();
                  }}
                  data-testid="button-clear-order"
                >
                  Change Order
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => clearHistoryMutation.mutate(currentShipment.id)}
                  disabled={clearHistoryMutation.isPending}
                  data-testid="button-clear-history"
                >
                  {clearHistoryMutation.isPending ? "Clearing..." : "Clear History"}
                </Button>
              </div>
            </div>

            {/* Collapsible Shipping Details */}
            <Accordion type="single" collapsible>
              <AccordionItem value="shipping-details" className="border rounded-lg px-4">
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-4 w-full pr-4">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Shipping Details
                    </span>
                    {(currentShipment.shipToAddressLine1 || currentShipment.shipToCity) && (
                      <span className="text-xl font-bold font-mono text-muted-foreground">
                        {[
                          currentShipment.shipToAddressLine1,
                          currentShipment.shipToCity,
                          currentShipment.shipToState,
                          currentShipment.shipToPostalCode,
                          currentShipment.carrier && currentShipment.serviceCode 
                            ? `${currentShipment.carrier} ${currentShipment.serviceCode}`
                            : currentShipment.carrier
                        ].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-4 pt-2 pb-4">
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
                        <div className="pl-6 space-y-1 text-sm">
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
                            <p className="text-xs text-muted-foreground mt-2">
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
                    {(currentShipment.carrier || currentShipment.trackingNumber) && (
                      <div className="pt-3 border-t space-y-2">
                        {currentShipment.carrier && (
                          <div className="flex items-start gap-2">
                            <Truck className="h-4 w-4 text-muted-foreground mt-0.5" />
                            <div className="flex-1 text-sm">
                              <div className="text-muted-foreground">Carrier</div>
                              <div className="font-medium">
                                {currentShipment.carrier} {currentShipment.serviceCode}
                              </div>
                            </div>
                          </div>
                        )}

                        {currentShipment.trackingNumber && (
                          <div className="flex items-start gap-2">
                            <Package className="h-4 w-4 text-muted-foreground mt-0.5" />
                            <div className="flex-1 text-sm">
                              <div className="text-muted-foreground">Tracking</div>
                              <div className="font-mono text-xs" data-testid="text-tracking">
                                {currentShipment.trackingNumber}
                              </div>
                            </div>
                          </div>
                        )}

                        {currentShipment.statusDescription && (
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" data-testid="badge-status">
                              {currentShipment.statusDescription}
                            </Badge>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* QC Card - Product Scanning - Only show when not complete */}
            {!packingComplete && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Package className="h-5 w-5" />
                    Quality Control
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
              {/* Product Scanner Input - Only show when not complete */}
              {!allItemsScanned && (
                <form onSubmit={handleProductScan}>
                  <div className="relative">
                    <Input
                      ref={productInputRef}
                      type="text"
                      placeholder="Scan product barcode..."
                      value={productScan}
                      onChange={(e) => setProductScan(e.target.value)}
                      onFocus={handleFirstInteraction}
                      disabled={validateProductMutation.isPending}
                      className="text-2xl h-16 text-center font-mono pr-12"
                      data-testid="input-product-scan"
                    />
                    {validateProductMutation.isPending && (
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    )}
                  </div>
                </form>
              )}

              {/* Scan Feedback Strip - Always visible to prevent UI bouncing */}
              {!allItemsScanned && (
                <div
                  className={`p-4 rounded-lg border-2 transition-all min-h-[100px] flex items-center ${
                    scanFeedback
                      ? scanFeedback.type === "success"
                        ? "bg-green-50 dark:bg-green-950/30 border-green-600"
                        : scanFeedback.type === "error"
                        ? "bg-red-50 dark:bg-red-950/30 border-red-600"
                        : "bg-blue-50 dark:bg-blue-950/30 border-blue-600"
                      : "bg-muted/30 border-muted-foreground/20"
                  }`}
                  data-testid="scan-feedback-strip"
                >
                  {scanFeedback ? (
                    <div className="flex items-center gap-4 w-full">
                      {/* Status Icon */}
                      <div className="flex-shrink-0">
                        {scanFeedback.type === "success" ? (
                          <CheckCircle2 className="h-10 w-10 text-green-600" />
                        ) : scanFeedback.type === "error" ? (
                          <XCircle className="h-10 w-10 text-red-600" />
                        ) : (
                          <AlertCircle className="h-10 w-10 text-blue-600" />
                        )}
                      </div>
                      
                      {/* Product Image (large and prominent) */}
                      {scanFeedback.imageUrl && (
                        <div className="flex-shrink-0">
                          <img
                            src={scanFeedback.imageUrl}
                            alt={scanFeedback.productName || "Product"}
                            className="w-24 h-24 object-cover rounded-md border-2"
                          />
                        </div>
                      )}
                      
                      {/* Feedback Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-3">
                          {/* Text Content */}
                          <div className="flex-1 min-w-0">
                            <div className={`text-2xl font-bold mb-1 ${
                              scanFeedback.type === "success"
                                ? "text-green-900 dark:text-green-100"
                                : scanFeedback.type === "error"
                                ? "text-red-900 dark:text-red-100"
                                : "text-blue-900 dark:text-blue-100"
                            }`}>
                              {scanFeedback.title}
                            </div>
                            {scanFeedback.productName && (
                              <div className="text-lg font-semibold text-foreground mb-1 truncate">
                                {scanFeedback.productName}
                              </div>
                            )}
                            {scanFeedback.sku && (
                              <div className="text-sm font-mono text-muted-foreground">
                                {scanFeedback.sku}
                              </div>
                            )}
                            <div className="text-sm text-muted-foreground mt-1">
                              {scanFeedback.message}
                            </div>
                          </div>
                          
                          {/* Scanned Count (if available) */}
                          {scanFeedback.scannedCount !== undefined && scanFeedback.expectedCount !== undefined && (
                            <div className="flex-shrink-0 text-right">
                              <div className={`text-3xl font-bold ${
                                scanFeedback.type === "success"
                                  ? "text-green-900 dark:text-green-100"
                                  : scanFeedback.type === "error"
                                  ? "text-red-900 dark:text-red-100"
                                  : "text-blue-900 dark:text-blue-100"
                              }`}>
                                {scanFeedback.scannedCount} / {scanFeedback.expectedCount}
                              </div>
                              <div className="text-xs text-muted-foreground">units</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 w-full text-muted-foreground">
                      <Package className="h-8 w-8" />
                      <div>
                        <div className="text-lg font-medium">Ready to scan</div>
                        <div className="text-sm">Scan a product barcode to begin quality control</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Overall Progress - Only show when not complete */}
              {!allItemsScanned && (
                <div className="p-4 bg-muted rounded-lg">
                  <div className="text-3xl font-bold">
                    {totalExpected - totalScanned} {totalExpected - totalScanned === 1 ? "Item" : "Items"} Remaining
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {totalScanned} of {totalExpected} scanned
                  </div>
                  
                  {/* Progress Bar */}
                  <div className="mt-3 h-3 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${totalExpected > 0 ? (totalScanned / totalExpected) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Items to Pack - Dual-Stack: Pending (top) + Completed (bottom) */}
              <div className="space-y-4" data-testid="items-to-pack-section">
                {(() => {
                  // Split items into pending and completed arrays
                  const pendingItems: Array<[string, SkuProgress]> = [];
                  const completedItems: Array<[string, SkuProgress]> = [];
                  
                  Array.from(skuProgress.entries()).forEach(([key, progress]) => {
                    const isComplete = progress.scanned >= progress.expected;
                    if (isComplete) {
                      completedItems.push([key, progress]);
                    } else {
                      pendingItems.push([key, progress]);
                    }
                  });
                  
                  // Sort pending by remaining (most remaining first - prioritize work)
                  pendingItems.sort((a, b) => b[1].remaining - a[1].remaining);
                  
                  // Render function for item cards
                  const renderItem = ([key, progress]: [string, SkuProgress]) => {
                    const isComplete = progress.scanned >= progress.expected;
                    const isPartial = progress.scanned > 0 && progress.scanned < progress.expected;
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
                          {progress.imageUrl && (
                            <img
                              src={progress.imageUrl}
                              alt={progress.name}
                              className="w-28 h-28 object-cover rounded-md border-2 flex-shrink-0"
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
                  };
                  
                  return (
                    <>
                      {/* Pending Items Section - Only shown when items remain */}
                      {pendingItems.length > 0 && (
                        <div data-testid="section-pending-items">
                          <h3 className="font-semibold text-lg mb-3" data-testid="heading-pending-items">
                            Items to Pack ({pendingItems.length} remaining)
                          </h3>
                          <div className="space-y-3" data-testid="list-pending-items">
                            {pendingItems.map(renderItem)}
                          </div>
                        </div>
                      )}
                      
                      {/* Success Message - Only shown when all complete */}
                      {pendingItems.length === 0 && completedItems.length > 0 && (
                        <div className="text-center py-6 text-green-600" data-testid="message-all-complete">
                          <CheckCircle2 className="h-12 w-12 mx-auto mb-2" />
                          <p className="font-semibold text-lg">All items scanned!</p>
                          <p className="text-sm text-muted-foreground">Review completed items below</p>
                        </div>
                      )}
                      
                      {/* Completed Items Section - Collapsible */}
                      {completedItems.length > 0 && (
                        <Accordion type="single" collapsible data-testid="accordion-completed-items-container">
                          <AccordionItem value="completed-items" className="border rounded-lg px-4" data-testid="accordion-completed-items">
                            <AccordionTrigger className="hover:no-underline" data-testid="trigger-completed-items">
                              <span className="text-sm font-medium flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-green-600" />
                                Completed Items ({completedItems.length})
                              </span>
                            </AccordionTrigger>
                            <AccordionContent data-testid="content-completed-items">
                              <div className="space-y-3 pt-2 pb-4" data-testid="list-completed-items">
                                {completedItems.map(renderItem)}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      )}
                    </>
                  );
                })()}
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

            {/* Packing Complete Message - Only show when complete */}
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
          </>
        )}

        {/* Scan History - Shows when order is loaded AND has logs */}
        {currentShipment && packingLogs && packingLogs.length > 0 && (() => {
          const successfulScans = packingLogs.filter(log => log.success).length;
          const failedScans = packingLogs.filter(log => !log.success).length;
          const totalScans = packingLogs.length;
          const accuracy = totalScans > 0 ? Math.round((successfulScans / totalScans) * 100) : 0;
          
          return (
            <Accordion 
              type="single" 
              collapsible 
              defaultValue={allItemsScanned ? undefined : "scan-history"}
              data-testid="accordion-scan-history"
            >
              <AccordionItem value="scan-history">
                <AccordionTrigger 
                  className="px-6 hover:no-underline"
                  data-testid="trigger-scan-history"
                >
                  <div className="flex items-center justify-between w-full pr-2">
                    <span className="font-semibold">Scan History</span>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <span className="text-green-600 font-semibold">{successfulScans}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <XCircle className="h-4 w-4 text-red-600" />
                        <span className="text-red-600 font-semibold">{failedScans}</span>
                      </div>
                      <Badge variant="secondary" className="ml-2">
                        {accuracy}% accuracy
                      </Badge>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4">
                  <div className="space-y-2 max-h-96 overflow-y-auto" data-testid="list-scan-history">
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
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          );
        })()}
      </div>
    </div>
  );
}
