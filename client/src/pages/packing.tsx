import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { setWorkstationId } from "@/lib/workstation-guard";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  Zap,
  Boxes,
  Gift,
  Building2,
  CircleDashed,
  Clock,
  Printer,
  Wifi,
  WifiOff,
  RotateCcw,
  LogOut,
  Copy,
  ExternalLink,
} from "lucide-react";
import { SessionDetailDialog, parseCustomField2 } from "@/components/session-detail-dialog";
import { ShipmentChoiceDialog, type ShippableShipmentOption } from "@/components/shipment-choice-dialog";
import { AlreadyPackedDialog, type AlreadyPackedShipment } from "@/components/already-packed-dialog";

// Import sound files
import successSoundUrl from "@assets/20251206_105157_1765040537045.mp3"; // QC scan success (coin)
import errorSoundUrl from "@assets/20251206_144623_1765054040309.mp3"; // QC scan error
import completionSoundUrl from "@assets/smb_powerup_1765055020444.wav"; // Complete packing (powerup)

// Station session types
type StationSession = {
  id: string;
  stationId: string;
  stationName: string;
  stationLocationHint: string | null;
  selectedAt: string;
  expiresAt: string;
};

type Station = {
  id: string;
  name: string;
  locationHint: string | null;
  isActive: boolean;
};

type StationPrinterStatus = {
  id: string;
  name: string;
  isActive: boolean;
  isConnected: boolean;
  printer: {
    id: string;
    name: string;
    systemName: string;
    status: string;
  } | null;
};

type KitComponent = {
  id: string;
  sku: string | null;
  code: string | null; // Scannable barcode
  partNumber: string | null;
  name: string;
  quantity: number;
  scannedQuantity: number;
  baseScannedQuantity?: number; // Immutable baseline from SkuVault (for idempotent restoration)
  picture: string | null;
  skuvaultItemId: string | null;
};

type ShipmentItem = {
  id: string;
  shipmentId: string;
  orderItemId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  expectedQuantity: number | null; // From SkuVault (golden source)
  unitPrice: string | null;
  imageUrl: string | null;
  // SkuVault-specific fields (present when items come from SkuVault)
  skuvaultItemId?: string | null;
  skuvaultCode?: string | null;
  skuvaultPartNumber?: string | null;
  passedStatus?: string | null;
  // Kit-related fields (present when items come from SkuVault)
  isKit?: boolean; // True if this item is a kit parent
  kitComponents?: KitComponent[] | null; // Nested components for kit items
  totalComponentsExpected?: number | null; // Total component units expected
  totalComponentsScanned?: number | null; // Total component units scanned
};

type QCSale = {
  TotalItems?: number | null;
  Status?: string | null;
  SaleId?: string | null;
  OrderId?: string | null;
  PassedItems?: Array<{
    Sku?: string | null;
    Quantity?: number | null;
    ItemId?: string | null;
    Picture?: string | null;
  }> | null;
  Items?: Array<{
    Sku?: string | null;
    Quantity?: number | null;
    Id?: string | null;
    Picture?: string | null;
  }> | null;
};

type PendingPrintJob = {
  id: string;
  stationId: string;
  stationName: string;
  status: 'pending' | 'sent' | 'printing';
  errorMessage: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
};

// Warning when order is missing MOVE OVER tag (only when boxing allows loading anyway)
type NotShippableWarning = {
  code: string;
  message: string;
  explanation: string;
  resolution: string;
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
  orderDate: string | null; // ShipStation createDate - when the order/label was created
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
  // Session/spot from SkuVault
  customField2: string | null;
  items: ShipmentItem[];
  saleId: string | null; // SkuVault SaleId (cached from initial lookup)
  qcSale?: QCSale | null; // SkuVault QC Sale data (includes PassedItems, expected Items)
  validationWarnings?: string[]; // Warnings if items don't match between systems
  itemsSource?: 'skuvault' | 'shipstation'; // Which system provided the items list
  cacheSource?: 'warm_cache' | 'skuvault_api'; // Whether data came from pre-warmed cache or API
  sessionStatus?: string | null; // SkuVault session status (new, active, inactive, closed)
  // Pre-calculated pending print jobs (immediate display on order load)
  pendingPrintJobs?: PendingPrintJob[];
  hasPendingPrintJobs?: boolean;
  // Shippability warning (present when order loaded with allowNotShippable=true but missing MOVE OVER tag)
  notShippable?: NotShippableWarning | null;
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

type ShipmentEvent = {
  id: string;
  eventName: string;
  username: string; // Email of user who performed the action
  metadata: any;
  occurredAt: string; // Database field is occurredAt, not createdAt
  skuvaultImport?: boolean; // True if imported from SkuVault PassedItems
};

type ShipmentTag = {
  id: string;
  shipmentId: string;
  name: string;
  color: string | null;
  tagId: number | null;
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
  skuvaultSynced?: boolean; // True if this item was found in SkuVault PassedItems
  skuvaultBaseScanned?: number; // Immutable SkuVault baseline for idempotent restoration
  // Kit-related fields (for kits: shows aggregate component progress)
  isKit?: boolean; // True if this is a kit parent
  kitComponents?: KitComponent[] | null; // Nested components for collapsible UI
  totalComponentsExpected?: number; // Total component units expected (sum of all component quantities)
  totalComponentsScanned?: number; // Total component units scanned (sum of all component scans)
  skuvaultCode?: string | null; // Barcode from SkuVault
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

type LabelError = {
  code: string;
  message: string;
  shipStationError?: string;
  resolution: string;
};

type ScanErrorShipmentItem = {
  sku: string | null;
  name: string;
  quantity: number;
};

type ScanErrorShipment = {
  id: string;
  shipmentId: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  trackingNumber?: string | null;
  exclusionReason?: 'already_shipped' | 'on_hold' | 'eligible' | string;
  items: ScanErrorShipmentItem[];
};

type ScanError = {
  code: string;
  message: string;
  explanation: string;
  resolution: string;
  orderNumber?: string;
  shipments?: ScanErrorShipment[];
};

export default function Packing() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  
  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied", description: text, duration: 1500 });
    });
  }, [toast]);
  const orderInputRef = useRef<HTMLInputElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);
  const completeButtonRef = useRef<HTMLButtonElement>(null); // Ref for Complete Boxing button
  const progressRestoredRef = useRef(false); // Track if initial restoration has been done

  const [orderScan, setOrderScan] = useState("");
  const [productScan, setProductScan] = useState("");
  const [currentShipment, setCurrentShipment] = useState<ShipmentWithItems | null>(null);
  // Use item ID as key to handle duplicate SKUs properly
  const [skuProgress, setSkuProgress] = useState<Map<string, SkuProgress>>(new Map());
  const [packingComplete, setPackingComplete] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);
  const [scanError, setScanError] = useState<ScanError | null>(null); // Scan-level errors (all on hold, etc.)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showStationModal, setShowStationModal] = useState(false);
  
  // Optimistic state for print job creation (immediately shows warning after completing packing)
  const [justCreatedPrintJob, setJustCreatedPrintJob] = useState(false);
  
  // State for label creation error (displayed inline on packing page)
  const [labelError, setLabelError] = useState<LabelError | null>(null);
  
  // State for successful completion (displayed inline, requires acknowledgment)
  const [completionSuccess, setCompletionSuccess] = useState<{ printJobId: string; message: string } | null>(null);

  // State for "Already Packed" dialog (guard rail for re-scanning packed orders)
  // Supports multiple shipments for orders split across packages
  const [showAlreadyPackedDialog, setShowAlreadyPackedDialog] = useState(false);
  const [alreadyPackedShipments, setAlreadyPackedShipments] = useState<AlreadyPackedShipment[]>([]);

  // State for "Shipment Selection" dialog (when order has multiple shippable shipments)
  const [showShipmentChoiceDialog, setShowShipmentChoiceDialog] = useState(false);
  const [pendingOrderNumber, setPendingOrderNumber] = useState<string | null>(null);
  const [shippableShipmentOptions, setShippableShipmentOptions] = useState<ShippableShipmentOption[]>([]);

  // Concurrency protection: Local processing flags set IMMEDIATELY on interaction
  // These prevent double-clicks/scans before React Query's isPending can update
  const [isOrderScanProcessing, setIsOrderScanProcessing] = useState(false);
  const [isProductScanProcessing, setIsProductScanProcessing] = useState(false);
  const [isCompletingPacking, setIsCompletingPacking] = useState(false);

  // Fetch current user's station session
  const { data: stationSessionData, isLoading: isLoadingSession } = useQuery<{ session: StationSession | null }>({
    queryKey: ['/api/packing/station-session'],
  });

  // Fetch available stations for selection
  const { data: availableStations = [], isLoading: isLoadingStations } = useQuery<Station[]>({
    queryKey: ['/api/packing/stations'],
    enabled: showStationModal,
  });

  // State for workstation mismatch blocking
  const [workstationMismatch, setWorkstationMismatch] = useState<{
    workstationId: string;
    workstationName: string;
    userStationId: string;
    userStationName: string;
  } | null>(null);

  // Mutation to set station session
  const setStationMutation = useMutation({
    mutationFn: async ({ stationId, stationName }: { stationId: string; stationName: string }) => {
      return apiRequest('POST', '/api/packing/station-session', { stationId });
    },
    onSuccess: (_, { stationId, stationName }) => {
      // DISABLED: Workstation mismatch validation - always allow station selection
      // Store the selected station in localStorage (for future reference)
      setWorkstationId(stationId, stationName);
      setWorkstationMismatch(null);
      
      queryClient.invalidateQueries({ queryKey: ['/api/packing/station-session'] });
      setShowStationModal(false);
    },
    onError: (error: any) => {
      // Error is visible in the modal UI
      console.error('[Packing] Station selection failed:', error.message);
    },
  });

  // Current session state - check if session exists AND is not expired
  const currentStation = stationSessionData?.session;
  const isSessionExpired = currentStation ? new Date(currentStation.expiresAt) <= new Date() : true;
  const hasValidSession = !!currentStation && !isSessionExpired;

  // DISABLED: Workstation mismatch validation on session load
  // Just store the current station in localStorage without blocking
  useEffect(() => {
    if (!hasValidSession || !currentStation) return;
    
    // Store the current station (no mismatch validation)
    setWorkstationId(currentStation.stationId, currentStation.stationName);
    setWorkstationMismatch(null);
  }, [hasValidSession, currentStation?.stationId]);

  // Track real-time station connection status (updated via WebSocket)
  const [stationConnected, setStationConnected] = useState<boolean | null>(null);

  // Fetch station printer status for the current station
  type StationsResponse = {
    stations: StationPrinterStatus[];
    connectionStats: { total: number; connected: number; offline: number };
  };
  const { data: stationsData, isLoading: isLoadingStationStatus } = useQuery<StationsResponse>({
    queryKey: ['/api/stations'],
    enabled: hasValidSession && !!currentStation?.stationId,
    refetchInterval: 30000, // Refresh every 30 seconds as fallback
  });

  // Find the current station's printer status from the stations list
  const currentStationStatus = stationsData?.stations.find(s => s.id === currentStation?.stationId);
  const printerInfo = currentStationStatus?.printer ?? null;
  
  // Use WebSocket-updated connection status if available, otherwise use API data
  const isStationConnected = stationConnected ?? currentStationStatus?.isConnected ?? false;
  // Normalize printer status to lowercase for comparison (API may return 'ONLINE' or 'online')
  const printerStatusNormalized = printerInfo?.status?.toLowerCase() ?? '';
  const isPrinterReady = isStationConnected && printerInfo !== null && printerStatusNormalized === 'online';
  const printerNotConfigured = printerInfo === null;
  const printerOffline = printerInfo !== null && printerStatusNormalized !== 'online';

  // WebSocket ref for station status updates (prevents leaks across re-renders)
  const stationWsRef = useRef<WebSocket | null>(null);

  // WebSocket subscription for real-time station connection and printer status updates
  useEffect(() => {
    if (!hasValidSession || !currentStation?.stationId) return;
    
    // Close any existing socket before creating new one
    if (stationWsRef.current) {
      stationWsRef.current.close();
      stationWsRef.current = null;
    }
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    stationWsRef.current = ws;
    
    ws.onopen = () => {
      console.log("[Packing] WebSocket connected for station status");
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const stationId = currentStation?.stationId;
        
        // Handle station connection status updates
        if (message.type === 'station:connection' && message.stationId === stationId) {
          console.log(`[Packing] Station connection update: ${message.isConnected ? 'online' : 'offline'}`);
          setStationConnected(message.isConnected);
          // Refresh stations query to get updated printer info
          queryClient.invalidateQueries({ queryKey: ['/api/stations'] });
        }
        
        // Handle printer status updates (when printer goes online/offline)
        if (message.type === 'printer:status' && message.stationId === stationId) {
          console.log(`[Packing] Printer status update: ${message.status}`);
          // Refresh stations query to get updated printer status
          queryClient.invalidateQueries({ queryKey: ['/api/stations'] });
        }
        
        // Handle print job updates (may indicate printer issues)
        if (message.type === 'print:job:update' && message.stationId === stationId) {
          // Refresh stations query in case printer status changed
          queryClient.invalidateQueries({ queryKey: ['/api/stations'] });
        }
      } catch (e) {
        // Ignore parse errors
      }
    };
    
    ws.onerror = () => {
      console.error("[Packing] WebSocket error for station status");
    };
    
    return () => {
      // Always close the socket on cleanup
      if (stationWsRef.current) {
        stationWsRef.current.close();
        stationWsRef.current = null;
      }
    };
  }, [hasValidSession, currentStation?.stationId]);

  // Reset connection status when station changes
  useEffect(() => {
    setStationConnected(null);
  }, [currentStation?.stationId]);

  // Show station modal if no valid session (once loading is complete)
  useEffect(() => {
    if (!isLoadingSession && !hasValidSession) {
      setShowStationModal(true);
    }
  }, [isLoadingSession, hasValidSession]);

  // Fetch shipment tags to check for Gift tag
  const { data: shipmentTags = [] } = useQuery<ShipmentTag[]>({
    queryKey: ['/api/shipments', currentShipment?.id, 'tags'],
    enabled: !!currentShipment?.id,
  });

  // Stale job metrics type for blocking on critical print queue issues
  type StaleJobMetrics = {
    totalStale: number;
    warningCount: number;
    criticalCount: number;
    healthStatus: 'healthy' | 'warning' | 'critical';
    lastCheckedAt: string;
  };
  
  // Fetch stale job metrics (used to block scanning when queue has critical issues)
  const { data: staleJobMetrics, isLoading: isLoadingStaleMetrics } = useQuery<StaleJobMetrics>({
    queryKey: ['/api/print-queue/stale-metrics'],
    enabled: hasValidSession, // Only fetch when user has a valid station session
    refetchInterval: 10000, // Refresh every 10 seconds
  });
  
  // WebSocket for real-time stale job updates (before order is loaded)
  // Uses setQueryData for instant updates without API round-trip
  useEffect(() => {
    if (!hasValidSession) return;
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'stale_jobs_update' && message.metrics) {
          // Update cache directly with WebSocket data - no API round-trip
          queryClient.setQueryData(['/api/print-queue/stale-metrics'], {
            totalStale: message.metrics.totalStale,
            warningCount: message.metrics.warningCount,
            criticalCount: message.metrics.criticalCount,
            healthStatus: message.metrics.healthStatus,
            lastCheckedAt: message.metrics.lastCheckedAt,
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    };
    
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [hasValidSession]);
  
  const hasCriticalPrintQueue = staleJobMetrics?.healthStatus === 'critical';
  const hasWarningPrintQueue = staleJobMetrics?.healthStatus === 'warning';
  const printQueueJobCount = staleJobMetrics?.totalStale ?? 0;
  
  // Auto-focus order input when page loads and ready to scan
  // This handles returning to the page after printing a label
  useEffect(() => {
    // Wait for session and stale metrics to load before focusing
    if (isLoadingSession || isLoadingStaleMetrics) return;
    
    // Only focus when:
    // 1. Has valid session
    // 2. No current shipment loaded
    // 3. Print queue is not critical (not blocked)
    if (hasValidSession && !currentShipment && !hasCriticalPrintQueue) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        orderInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isLoadingSession, isLoadingStaleMetrics, hasValidSession, currentShipment, hasCriticalPrintQueue]);
  
  // Pending print jobs - use pre-calculated data from validate-order response for immediate display
  // The query is kept as a fallback for WebSocket updates after initial load
  const { data: pendingPrintJobsData, isLoading: isPendingJobsLoading } = useQuery<{ pendingJobs: PendingPrintJob[] }>({
    queryKey: ['/api/print-jobs/shipment', currentShipment?.id],
    enabled: !!currentShipment?.id,
    refetchInterval: 15000, // Relaxed polling - WebSocket handles real-time updates
    // Initialize cache with pre-calculated data from validate-order response for instant display
    placeholderData: currentShipment?.pendingPrintJobs 
      ? { pendingJobs: currentShipment.pendingPrintJobs }
      : undefined,
  });
  
  // Use pre-calculated data from shipment (instant) OR query data (for updates after load)
  const pendingPrintJobs = pendingPrintJobsData?.pendingJobs || currentShipment?.pendingPrintJobs || [];
  // Immediate display: use pre-calculated flag (instant) or optimistic state or confirmed data
  // Only show warning when there's an active shipment (prevent flash after completing)
  const hasPendingPrintJob = !!(currentShipment && (justCreatedPrintJob || currentShipment?.hasPendingPrintJobs || pendingPrintJobs.length > 0));
  
  // WebSocket subscription for real-time print job status updates
  useEffect(() => {
    if (!currentShipment?.id) return;
    
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // Handle print job status updates (not stale_jobs_update - that's for operations dashboard)
        if (message.type === 'job_completed' || message.type === 'job_failed' || 
            message.type === 'job_cancelled' || message.type === 'job_added' ||
            message.type === 'job_printing' || message.type === 'job_updated') {
          // Invalidate the pending print jobs query to refresh immediately
          queryClient.invalidateQueries({ 
            queryKey: ['/api/print-jobs/shipment', currentShipment.id] 
          });
          // Also clear optimistic state when we get server confirmation
          if (message.type === 'job_completed' || message.type === 'job_failed' || message.type === 'job_cancelled') {
            setJustCreatedPrintJob(false);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    };
    
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [currentShipment?.id]);
  
  // Reset optimistic state when loading a new shipment
  useEffect(() => {
    setJustCreatedPrintJob(false);
  }, [currentShipment?.id]);

  // Check if shipment is a gift (either has Gift tag OR isGift boolean)
  const hasGiftTag = shipmentTags.some(tag => tag.name === 'Gift');
  const isGift = hasGiftTag || Boolean(currentShipment?.isGift);
  
  // Check if shipment has MOVE OVER tag (means it's shippable)
  const hasMoveOverTag = shipmentTags.some(tag => tag.name === 'MOVE OVER');
  
  // Helper to normalize SKUs for comparison (uppercase, trimmed)
  const normalizeSku = (sku: string) => sku.trim().toUpperCase();
  
  // Helper to check if a scanned SKU is a component of a kit SKU
  // Kit pattern: base SKU with -X2, -X3, -X4, etc. suffix (e.g., JCB-POJ-6-16-X2)
  // Component pattern: base SKU without multiplier (e.g., JCB-POJ-6-16)
  const isComponentOfKit = (scannedSku: string, kitSku: string): boolean => {
    const normalizedScanned = scannedSku.toUpperCase().trim();
    const normalizedKit = kitSku.toUpperCase().trim();
    
    // Check for kit multiplier pattern: -X2, -X3, -X4, -X5, etc.
    const kitMultiplierPattern = /^(.+)-X(\d+)$/;
    const match = normalizedKit.match(kitMultiplierPattern);
    
    if (match) {
      const baseSku = match[1]; // The base SKU without multiplier
      // Check if scanned SKU matches the base SKU of the kit
      return normalizedScanned === baseSku;
    }
    
    return false;
  };
  
  // Check if scanned SKU matches expected SKU (exact match or kit-component match)
  const skuMatchesExpected = (scannedSku: string, expectedSku: string): boolean => {
    const normalizedScanned = normalizeSku(scannedSku);
    const normalizedExpected = normalizeSku(expectedSku);
    
    // Exact match
    if (normalizedScanned === normalizedExpected) {
      return true;
    }
    
    // Kit-component match (scanned component matches kit SKU)
    if (isComponentOfKit(normalizedScanned, normalizedExpected)) {
      return true;
    }
    
    return false;
  };
  
  // Helper to format order age
  const formatOrderAge = (orderDate: string | null): string => {
    if (!orderDate) return 'N/A';
    
    const now = new Date();
    const order = new Date(orderDate);
    const diffMs = now.getTime() - order.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) {
      return `${diffDays}d ${diffHours % 24}h`;
    } else if (diffHours > 0) {
      return `${diffHours}h ${diffMins % 60}m`;
    } else if (diffMins > 0) {
      return `${diffMins}m ${diffSecs % 60}s`;
    } else {
      return `${diffSecs}s`;
    }
  };

  // Audio feedback - Reuse single AudioContext to avoid browser limits
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioResumedRef = useRef(false);
  const successSoundRef = useRef<HTMLAudioElement | null>(null);
  const errorSoundRef = useRef<HTMLAudioElement | null>(null);
  const completionSoundRef = useRef<HTMLAudioElement | null>(null);

  // Preload sounds on mount
  useEffect(() => {
    const successAudio = new Audio(successSoundUrl);
    successAudio.preload = "auto";
    successAudio.volume = 0.5; // 50% volume
    successSoundRef.current = successAudio;

    const errorAudio = new Audio(errorSoundUrl);
    errorAudio.preload = "auto";
    errorAudio.volume = 0.7; // 70% volume for error (more attention-grabbing)
    errorSoundRef.current = errorAudio;

    const completionAudio = new Audio(completionSoundUrl);
    completionAudio.preload = "auto";
    completionAudio.volume = 0.6; // 60% volume for completion
    completionSoundRef.current = completionAudio;
  }, []);

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

  // Play success sound using preloaded MP3
  const playSuccessBeep = () => {
    try {
      if (successSoundRef.current) {
        successSoundRef.current.currentTime = 0; // Reset to start
        successSoundRef.current.play().catch(err => {
          console.warn("Success sound playback failed:", err);
        });
      }
    } catch (error) {
      console.warn("Success sound error:", error);
    }
  };
  
  // Play error sound using preloaded MP3
  const playErrorBeep = () => {
    try {
      if (errorSoundRef.current) {
        errorSoundRef.current.currentTime = 0; // Reset to start
        errorSoundRef.current.play().catch(err => {
          console.warn("Error sound playback failed:", err);
        });
      }
    } catch (error) {
      console.warn("Error sound error:", error);
    }
  };

  // Play completion sound using preloaded WAV (for Complete Packing button)
  const playCompletionSound = () => {
    try {
      if (completionSoundRef.current) {
        completionSoundRef.current.currentTime = 0; // Reset to start
        completionSoundRef.current.play().catch(err => {
          console.warn("Completion sound playback failed:", err);
        });
      }
    } catch (error) {
      console.warn("Completion sound error:", error);
    }
  };

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

    // Audio feedback - only play sound for final results (success/error), not intermediate "info" states
    if (type === "success") {
      playSuccessBeep();
      vibrate(100); // Short vibration
    } else if (type === "error") {
      playErrorBeep();
      vibrate([100, 50, 100]); // Double vibration pattern
    } else {
      // "info" type - no beep, just brief vibration for tactile feedback
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
      
      // Get SKUs and quantities that are already passed in SkuVault for this order
      const skuvaultPassedQuantities = new Map<string, number>(); // SKU -> total quantity passed
      if (currentShipment.qcSale?.PassedItems) {
        currentShipment.qcSale.PassedItems.forEach((passedItem) => {
          if (passedItem.Sku) {
            const normalizedSku = normalizeSku(passedItem.Sku);
            const qty = passedItem.Quantity || 0;
            skuvaultPassedQuantities.set(normalizedSku, (skuvaultPassedQuantities.get(normalizedSku) || 0) + qty);
          }
        });
      }
      
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
      
      // Track how many units we've allocated from SkuVault for each SKU
      const skuvaultAllocated = new Map<string, number>();
      
      if (skuvaultPassedQuantities.size > 0) {
        console.log(`[Packing] Found ${skuvaultPassedQuantities.size} unique SKUs already passed in SkuVault`);
      }
      
      physicalItems.forEach((item) => {
        // Use item ID as key to handle duplicate SKUs properly
        const key = item.id;
        // Use expectedQuantity from SkuVault session if available, otherwise fall back to ShipStation quantity
        const expectedQty = item.expectedQuantity ?? item.quantity;
        
        // Handle kit items specially - show as single row with aggregate component progress
        if (item.isKit && item.kitComponents && item.kitComponents.length > 0) {
          const totalComponentsExpected = item.totalComponentsExpected || 0;
          const totalComponentsScanned = item.totalComponentsScanned || 0;
          const remaining = totalComponentsExpected - totalComponentsScanned;
          
          // Set baseScannedQuantity on each component for idempotent restoration
          const componentsWithBase = item.kitComponents.map(comp => ({
            ...comp,
            baseScannedQuantity: comp.scannedQuantity, // Capture SkuVault baseline
          }));
          
          progress.set(key, {
            itemId: item.id,
            sku: item.sku || "KIT",
            normalizedSku: item.sku ? normalizeSku(item.sku) : "",
            name: item.name,
            expected: totalComponentsExpected, // Total component units
            scanned: totalComponentsScanned,
            remaining: remaining,
            requiresManualVerification: false,
            imageUrl: item.imageUrl,
            skuvaultSynced: remaining === 0, // Synced if all components scanned
            skuvaultBaseScanned: totalComponentsScanned, // Immutable SkuVault baseline
            isKit: true,
            kitComponents: componentsWithBase, // Components with baseline for restoration
            totalComponentsExpected,
            totalComponentsScanned,
            skuvaultCode: item.skuvaultCode,
          });
          
          console.log(`[Packing] Kit ${item.sku}: ${totalComponentsScanned}/${totalComponentsExpected} component units scanned`);
          return; // Skip to next item
        }
        
        if (item.sku) {
          const normalized = normalizeSku(item.sku);
          
          // Check how many units SkuVault has passed for this SKU
          const totalPassedInSkuvault = skuvaultPassedQuantities.get(normalized) || 0;
          const alreadyAllocated = skuvaultAllocated.get(normalized) || 0;
          const availableFromSkuvault = Math.max(0, totalPassedInSkuvault - alreadyAllocated);
          
          // Determine how many of this item's units were scanned in SkuVault
          const scannedInSkuvault = Math.min(expectedQty, availableFromSkuvault);
          skuvaultAllocated.set(normalized, alreadyAllocated + scannedInSkuvault);
          
          // Mark as synced ONLY if ALL units for this item were passed in SkuVault
          const skuvaultSynced = scannedInSkuvault === expectedQty;
          
          progress.set(key, {
            itemId: item.id,
            sku: item.sku, // Keep original for display
            normalizedSku: normalized, // For matching scans
            name: item.name,
            expected: expectedQty,
            scanned: scannedInSkuvault, // Start with what was scanned in SkuVault
            remaining: expectedQty - scannedInSkuvault, // Only remaining units need scanning
            requiresManualVerification: false,
            imageUrl: item.imageUrl,
            skuvaultSynced, // Flag if already scanned in SkuVault
            skuvaultBaseScanned: scannedInSkuvault, // Immutable SkuVault baseline
            isKit: item.isKit || false,
            skuvaultCode: item.skuvaultCode || null,
          });
          
          if (scannedInSkuvault > 0) {
            console.log(`[Packing] Item ${item.sku} has ${scannedInSkuvault}/${expectedQty} units already scanned in SkuVault`);
          }
        } else {
          progress.set(key, {
            itemId: item.id,
            sku: "NO SKU",
            normalizedSku: "",
            name: item.name,
            expected: expectedQty,
            scanned: 0,
            remaining: expectedQty,
            requiresManualVerification: true,
            imageUrl: item.imageUrl,
            skuvaultSynced: false,
            skuvaultBaseScanned: 0, // No SkuVault baseline for items without SKU
            isKit: false,
            skuvaultCode: item.skuvaultCode || null,
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

  // Load shipment events for current order (includes SkuVault imports)
  const { data: shipmentEvents } = useQuery<ShipmentEvent[]>({
    queryKey: currentShipment ? ["/api/shipment-events/order", currentShipment.orderNumber] : [],
    enabled: !!currentShipment,
    queryFn: async ({ queryKey }) => {
      // Extract order number from queryKey (queryKey[1] is the order number)
      const orderNumber = queryKey[1] as string;
      const response = await apiRequest("GET", `/api/shipment-events/order/${encodeURIComponent(orderNumber)}`);
      return await response.json();
    },
  });

  // Restore SKU progress from historical packing logs when they load
  // IMPORTANT: This should only run ONCE when the order is first loaded, not after every new scan
  useEffect(() => {
    // Skip if already restored for this session - prevents overwriting live scan updates
    if (progressRestoredRef.current) return;
    if (!packingLogs || packingLogs.length === 0 || skuProgress.size === 0) return;
    
    // Mark as restored so we don't run again when logs are refetched
    progressRestoredRef.current = true;
    
    // Process logs chronologically (reverse since backend returns newest first)
    const chronologicalLogs = [...packingLogs].reverse();
    
    setSkuProgress((prevProgress) => {
      // IDEMPOTENT restoration using immutable SkuVault baseline
      // The baseline represents scans already in SkuVault. Logs may include scans
      // that contributed to that baseline, so we must "consume" the baseline first
      // before counting logs as new increments.
      const updatedProgress = new Map<string, SkuProgress>();
      
      // Track remaining baseline to consume per item/component
      // Key format: "itemKey" for regular items, "itemKey:compIndex" for components
      const baselineRemaining = new Map<string, number>();
      
      prevProgress.forEach((progress, key) => {
        const baseScanned = progress.skuvaultBaseScanned ?? 0;
        
        // For kits, track baseline per component
        let resetComponents = progress.kitComponents;
        if (progress.isKit && progress.kitComponents) {
          resetComponents = progress.kitComponents.map((comp, idx) => {
            const compBase = comp.baseScannedQuantity ?? 0;
            baselineRemaining.set(`${key}:${idx}`, compBase);
            return {
              ...comp,
              scannedQuantity: compBase, // Start at baseline
            };
          });
        } else {
          // For regular items, track baseline
          baselineRemaining.set(key, baseScanned);
        }
        
        updatedProgress.set(key, {
          ...progress,
          scanned: baseScanned,
          remaining: progress.expected - baseScanned,
          kitComponents: resetComponents,
          totalComponentsScanned: baseScanned,
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
          let matched = false;
          for (const [key, progress] of Array.from(updatedProgress.entries())) {
            // For kit items, check if scanned SKU matches any component
            if (progress.isKit && progress.kitComponents) {
              for (let i = 0; i < progress.kitComponents.length; i++) {
                const comp = progress.kitComponents[i];
                const compNormalizedSku = comp.sku ? normalizeSku(comp.sku) : "";
                const compNormalizedCode = comp.code ? normalizeSku(comp.code) : "";
                const compNormalizedPartNumber = comp.partNumber ? normalizeSku(comp.partNumber) : "";
                
                const compMatches = normalizedSku === compNormalizedSku || 
                                   normalizedSku === compNormalizedCode ||
                                   normalizedSku === compNormalizedPartNumber;
                
                if (compMatches) {
                  const baseKey = `${key}:${i}`;
                  const remaining = baselineRemaining.get(baseKey) ?? 0;
                  
                  if (remaining > 0) {
                    // This log is part of the baseline - consume it, don't increment
                    baselineRemaining.set(baseKey, remaining - 1);
                    matched = true;
                    break;
                  } else if (comp.scannedQuantity < comp.quantity) {
                    // Baseline consumed - this is a new scan, increment
                    const updatedComponents = [...progress.kitComponents];
                    updatedComponents[i] = {
                      ...comp,
                      scannedQuantity: comp.scannedQuantity + 1,
                    };
                    
                    const newTotalScanned = updatedComponents.reduce((sum, c) => sum + c.scannedQuantity, 0);
                    const totalExpected = progress.totalComponentsExpected || 0;
                    
                    updatedProgress.set(key, {
                      ...progress,
                      kitComponents: updatedComponents,
                      scanned: newTotalScanned,
                      remaining: totalExpected - newTotalScanned,
                      totalComponentsScanned: newTotalScanned,
                    });
                    matched = true;
                    break;
                  }
                }
              }
              if (matched) break;
            } else {
              // Regular item matching
              const skuMatches = isNoSku 
                ? progress.requiresManualVerification && progress.normalizedSku === ""
                : progress.normalizedSku === normalizedSku;
                
              if (skuMatches) {
                const remaining = baselineRemaining.get(key) ?? 0;
                
                if (remaining > 0) {
                  // This log is part of the baseline - consume it, don't increment
                  baselineRemaining.set(key, remaining - 1);
                  matched = true;
                  break;
                } else if (progress.scanned < progress.expected) {
                  // Baseline consumed - this is a new scan, increment
                  updatedProgress.set(key, {
                    ...progress,
                    scanned: progress.scanned + 1,
                    remaining: progress.remaining - 1,
                  });
                  matched = true;
                  break;
                }
              }
            }
          }
        }
      });
      
      return updatedProgress;
    });
    
    console.log(`[Packing] Restored progress from ${packingLogs.length} historical log(s)`);
  }, [packingLogs, skuProgress.size]); // Re-run when logs load or when skuProgress is initialized

  // Load shipment by order number (includes items from backend + SkuVault validation)
  // Boxing uses allowNotShippable=true to load orders for QC even if not yet shippable
  // Supports explicit shipmentId for multi-shipment orders
  const loadShipmentMutation = useMutation({
    mutationFn: async ({ orderNumber, shipmentId }: { orderNumber: string; shipmentId?: string }) => {
      let url = `/api/packing/validate-order/${encodeURIComponent(orderNumber)}?allowNotShippable=true`;
      if (shipmentId) {
        url += `&shipmentId=${encodeURIComponent(shipmentId)}`;
      }
      const response = await apiRequest("GET", url);
      return (await response.json()) as ShipmentWithItems & { 
        requiresShipmentSelection?: boolean;
        shippableShipments?: ShippableShipmentOption[];
      };
    },
    onSuccess: (shipment) => {
      // Handle multi-shipment selection scenario
      if ((shipment as any).requiresShipmentSelection && (shipment as any).shippableShipments) {
        console.log(`[Packing] Order ${(shipment as any).orderNumber} has multiple shippable shipments - showing selection dialog`);
        setPendingOrderNumber((shipment as any).orderNumber);
        setShippableShipmentOptions((shipment as any).shippableShipments);
        setShowShipmentChoiceDialog(true);
        setOrderScan(""); // Clear the input
        return; // Don't proceed - wait for selection
      }

      if (!shipment.items || shipment.items.length === 0) {
        // No items - clear and refocus for next scan
        setOrderScan("");
        setTimeout(() => orderInputRef.current?.focus(), 100);
        return;
      }

      // GUARD RAIL: Check if order is already packed (has tracking number)
      // This interrupts the flow and requires deliberate action to continue
      if ((shipment as any).alreadyPacked) {
        console.log(`[Packing] Order ${shipment.orderNumber} is already packed - showing reprint dialog`);
        // Convert shipment to AlreadyPackedShipment format
        const alreadyPackedData: AlreadyPackedShipment = {
          id: shipment.id,
          orderNumber: shipment.orderNumber,
          trackingNumber: shipment.trackingNumber || null,
          carrier: shipment.carrier || null,
          serviceCode: shipment.serviceCode || null,
          shipToName: shipment.shipToName || null,
          shipToCity: shipment.shipToCity || null,
          shipToState: shipment.shipToState || null,
          items: shipment.items?.map(item => ({
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
            imageUrl: item.imageUrl,
          })),
        };
        setAlreadyPackedShipments([alreadyPackedData]);
        setShowAlreadyPackedDialog(true);
        setOrderScan(""); // Clear the input
        return; // Don't proceed with normal flow
      }

      setCurrentShipment(shipment);
      setPackingComplete(false);
      setLabelError(null); // Clear any previous label errors when loading new order
      setCompletionSuccess(null); // Clear any previous success state
      progressRestoredRef.current = false; // Reset so restoration runs for new order
      
      // Log order loaded event (include selected shipment ID for multi-shipment tracking)
      logShipmentEvent("order_loaded", {
        shipmentId: shipment.id,
        selectedShipmentId: (shipment as any).selectedShipmentId,
        shippableCount: (shipment as any).shippableCount,
        itemCount: shipment.items.length,
        orderNumber: shipment.orderNumber,
        skuvaultSaleId: shipment.saleId,
        hasSkuvaultData: !!shipment.qcSale,
        skuvaultPassedItems: shipment.qcSale?.PassedItems?.length ?? 0,
        station: "boxing",
      }, shipment.orderNumber);
      
      // Focus product input after loading shipment
      setTimeout(() => productInputRef.current?.focus(), 100);
    },
    onError: (error: any) => {
      console.error('[Packing] Order load failed:', error);
      setOrderScan("");
      
      // Check if this is a structured error (NO_ELIGIBLE_SHIPMENTS, ALL_ON_HOLD, NOT_SHIPPABLE, etc.)
      const errorCode = error.data?.error?.code;
      if (errorCode === 'NO_ELIGIBLE_SHIPMENTS' || errorCode === 'ALL_ON_HOLD' || errorCode === 'NOT_SHIPPABLE' || errorCode === 'SHIPMENT_NOT_SHIPPABLE') {
        const structuredError = error.data.error;
        // Display as scan error (on scan page)
        setScanError({
          code: structuredError.code,
          message: structuredError.message,
          explanation: structuredError.explanation || '',
          resolution: structuredError.resolution || '',
          orderNumber: error.data?.orderNumber,
          shipments: error.data?.shipments || undefined,
        });
        console.log(`[Packing] Scan error: ${structuredError.code} - ${structuredError.message}`);
      }
      
      // Focus on scan input for next order
      setTimeout(() => orderInputRef.current?.focus(), 100);
    },
    onSettled: () => {
      // Always clear processing flag when mutation completes (success or error)
      setIsOrderScanProcessing(false);
    },
  });

  // Clear packing history (for testing/re-scanning)
  const clearHistoryMutation = useMutation({
    mutationFn: async (shipmentId: string) => {
      const response = await apiRequest("DELETE", `/api/packing-logs/shipment/${shipmentId}`);
      return (await response.json()) as { success: boolean; message: string };
    },
    onSuccess: () => {
      // Clear current shipment to return to scan order page
      setCurrentShipment(null);
      setSkuProgress(new Map());
      setScanFeedback(null);
      setPackingComplete(false);
      setOrderScan(""); // Clear the order scan input
      progressRestoredRef.current = false; // Reset for next order
      
      // Set focus to order scan input
      setTimeout(() => orderInputRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      console.error('[Packing] Clear history failed:', error.message);
    },
  });

  // Refresh cache for current order (used when customer service makes order changes)
  const refreshCacheMutation = useMutation({
    mutationFn: async (orderNumber: string) => {
      const response = await apiRequest("POST", `/api/packing/refresh-cache/${encodeURIComponent(orderNumber)}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || data.resolution || 'Failed to refresh cache');
      }
      return data as { success: boolean; message: string };
    },
    onSuccess: (data, orderNumber) => {
      console.log(`[Packing] Cache refreshed for order ${orderNumber}`);
      toast({
        title: "Cache Refreshed",
        description: "Order data has been refreshed from SkuVault.",
      });
      // Re-validate the order to pick up fresh cache
      if (currentShipment?.orderNumber) {
        loadShipmentMutation.mutate({ orderNumber: currentShipment.orderNumber, shipmentId: currentShipment.id });
      }
    },
    onError: (error: Error) => {
      console.error('[Packing] Cache refresh failed:', error.message);
      toast({
        title: "Refresh Failed",
        description: error.message || "Could not refresh order data. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Reprint label for already-packed orders
  const reprintLabelMutation = useMutation({
    mutationFn: async ({ shipmentId, orderNumber }: { shipmentId: string; orderNumber: string }) => {
      const response = await apiRequest("POST", "/api/packing/reprint-label", { shipmentId, orderNumber, station: "boxing" });
      return (await response.json()) as { success: boolean; printQueued: boolean; printJobId?: string; message?: string };
    },
    onSuccess: (data) => {
      console.log('[Packing] Reprint label queued:', data.printJobId);
      toast({
        title: "Label Reprint Queued",
        description: "The label will print shortly.",
      });
      // Close dialog and reset
      setShowAlreadyPackedDialog(false);
      setAlreadyPackedShipments([]);
      setOrderScan("");
      // Focus order input for next scan
      setTimeout(() => orderInputRef.current?.focus(), 100);
    },
    onError: (error: Error) => {
      console.error('[Packing] Reprint failed:', error.message);
      toast({
        title: "Reprint Failed",
        description: error.message || "Could not queue label reprint. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Handle cancel from already-packed dialog
  const handleCancelAlreadyPacked = () => {
    setShowAlreadyPackedDialog(false);
    setAlreadyPackedShipments([]);
    setOrderScan("");
    // Focus order input for next scan
    setTimeout(() => orderInputRef.current?.focus(), 100);
  };

  // Handle proceed to QC from already-packed dialog
  const handleProceedToQCFromAlreadyPacked = (shipment: AlreadyPackedShipment) => {
    console.log(`[Packing] Proceeding to QC for already-packed order ${shipment.orderNumber}`);
    // Re-load the shipment to get full data for QC scanning
    loadShipmentMutation.mutate({ 
      orderNumber: shipment.orderNumber, 
      shipmentId: shipment.id 
    });
    setShowAlreadyPackedDialog(false);
    setAlreadyPackedShipments([]);
  };

  // Handle reprint from already-packed dialog
  const handleReprintFromAlreadyPacked = (shipmentId: string, orderNumber: string) => {
    reprintLabelMutation.mutate({ shipmentId, orderNumber });
  };

  // Handle shipment selection from multi-shipment dialog
  const handleShipmentSelect = (shipmentId: string) => {
    console.log(`[Packing] User selected shipment: ${shipmentId} for order ${pendingOrderNumber}`);
    setShowShipmentChoiceDialog(false);
    setShippableShipmentOptions([]);
    // Re-load with explicit shipment selection
    if (pendingOrderNumber) {
      setIsOrderScanProcessing(true);
      loadShipmentMutation.mutate({ orderNumber: pendingOrderNumber, shipmentId });
    }
    setPendingOrderNumber(null);
  };

  // Handle cancel from shipment selection dialog
  const handleCancelShipmentSelection = () => {
    setShowShipmentChoiceDialog(false);
    setShippableShipmentOptions([]);
    setPendingOrderNumber(null);
    setOrderScan("");
    // Focus order input for next scan
    setTimeout(() => orderInputRef.current?.focus(), 100);
  };

  // SkuVault barcode validation (cached lookup including kit components)
  type LocalBarcodeResponse = {
    valid: boolean;
    sku?: string;
    barcode?: string;
    title?: string;
    quantity?: number;
    itemId?: string;          // SkuVault Item ID
    saleId?: string;          // SkuVault Sale ID
    isKitComponent?: boolean; // True if this is a kit component
    kitId?: string;           // Parent kit's SkuVault ID (for kit components)
    kitSku?: string;          // Parent kit's SKU
    kitTitle?: string;        // Parent kit's title
    error?: string;
    orderNumber?: string;
    scannedValue?: string;
  };

  // Synchronous SkuVault QC scan - verifies item in order and marks as passed
  type QCScanResponse = {
    success: boolean;
    message?: string;
    error?: string;
    sku?: string;
    orderNumber?: string;
    quantity?: number;
    skuVaultError?: boolean;
  };

  // QC scan parameters - saleId and idItem are optional cached values to reduce API calls
  type QCScanParams = {
    orderNumber: string;
    sku: string;
    quantity: number;
    saleId?: string | null;      // Cached from initial order load
    idItem?: string | null;      // Cached item ID from SkuVault (component ID for kits)
    isKitComponent?: boolean;    // True if scanning a kit component
    kitId?: string | null;       // Parent kit's SkuVault ID (required for kit component scans)
  };

  const qcScanMutation = useMutation({
    mutationFn: async (params: QCScanParams) => {
      const response = await apiRequest("POST", "/api/packing/qc-scan", params);
      return (await response.json()) as QCScanResponse;
    },
  });

  // Validate product with SkuVault cached lookup (includes kit components)
  const validateProductMutation = useMutation({
    mutationFn: async (scannedCode: string) => {
      // Use orderNumber from currentShipment to look up in SkuVault cache
      const orderNumber = currentShipment?.orderNumber;
      if (!orderNumber) {
        return { valid: false, error: "No order selected" } as LocalBarcodeResponse;
      }
      const response = await apiRequest("GET", `/api/packing/validate-barcode/${encodeURIComponent(orderNumber)}/${encodeURIComponent(scannedCode)}`);
      return (await response.json()) as LocalBarcodeResponse;
    },
    onSuccess: async (data, scannedCode) => {
      // Handle invalid barcode (not found in local DB)
      if (!data.valid || !data.sku) {
        await createPackingLog({
          action: "product_scanned",
          productSku: null,
          scannedCode,
          skuVaultProductId: null,
          success: false,
          errorMessage: data.error || "Product not found in local database",
        });

        logShipmentEvent("product_scan_failed", {
          scannedCode,
          errorMessage: data.error || "Product not found",
          station: "boxing",
        });

        showScanFeedback(
          "error",
          "PRODUCT NOT FOUND",
          "Check barcode → Scan any remaining item below",
          {
            sku: scannedCode,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
        return;
      }

      // Normalize scanned SKU for comparison
      const normalizedSku = normalizeSku(data.sku);
      
      // STEP 1: Find ANY matching SKU (supports regular items AND kit components)
      let matchingItemKey: string | null = null;
      let matchingProgress: SkuProgress | null = null;
      let matchingComponentIndex: number | null = null; // Track which component was matched for kits
      
      for (const [key, progress] of Array.from(skuProgress.entries())) {
        // For kit items, check if scanned barcode matches any component
        if (progress.isKit && progress.kitComponents && progress.kitComponents.length > 0) {
          for (let i = 0; i < progress.kitComponents.length; i++) {
            const comp = progress.kitComponents[i];
            const compRemaining = comp.quantity - comp.scannedQuantity;
            // Match against component code, SKU, or part number
            const compNormalizedCode = comp.code ? normalizeSku(comp.code) : "";
            const compNormalizedSku = comp.sku ? normalizeSku(comp.sku) : "";
            const compNormalizedPartNumber = comp.partNumber ? normalizeSku(comp.partNumber) : "";
            
            if (normalizedSku === compNormalizedCode || 
                normalizedSku === compNormalizedSku || 
                normalizedSku === compNormalizedPartNumber) {
              // Found matching component - prioritize those with remaining units
              if (!matchingProgress || compRemaining > 0) {
                matchingItemKey = key;
                matchingProgress = progress;
                matchingComponentIndex = i;
                if (compRemaining > 0) {
                  break; // Use first component with remaining units
                }
              }
            }
          }
          if (matchingProgress && matchingComponentIndex !== null) {
            const comp = matchingProgress.kitComponents![matchingComponentIndex];
            if (comp.quantity - comp.scannedQuantity > 0) {
              break; // Found a kit component with remaining - stop searching
            }
          }
        } else {
          // Regular item - use skuMatchesExpected for exact and pattern matches
          if (skuMatchesExpected(normalizedSku, progress.normalizedSku)) {
            // Found a matching SKU - prioritize items with remaining units
            if (!matchingProgress || progress.remaining > 0) {
              matchingItemKey = key;
              matchingProgress = progress;
              matchingComponentIndex = null; // Not a kit component
              if (progress.remaining > 0) {
                break; // Use first item with remaining units
              }
            }
          }
        }
      }
      
      // STEP 2: Check if SKU exists in order at all
      if (!matchingProgress) {
        // SKU not in this order at all
        await createPackingLog({
          action: "product_scanned",
          productSku: data.sku,
          scannedCode,
          skuVaultProductId: data.itemId || null,
          success: false,
          errorMessage: `SKU ${data.sku} not in this shipment`,
        });

        showScanFeedback(
          "error",
          "WRONG ITEM - Not in this order",
          `Set aside → Scan any remaining item below`,
          {
            sku: data.sku,
            productName: data.title || undefined,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
        return;
      }
      
      // STEP 3: Check if already fully scanned (duplicate scan)
      // For kit components, check the specific component's remaining quantity
      let componentRemaining = 0;
      let componentName = "";
      let componentExpected = 0;
      let componentScanned = 0;
      
      if (matchingProgress.isKit && matchingComponentIndex !== null && matchingProgress.kitComponents) {
        const comp = matchingProgress.kitComponents[matchingComponentIndex];
        componentRemaining = comp.quantity - comp.scannedQuantity;
        componentName = comp.name;
        componentExpected = comp.quantity;
        componentScanned = comp.scannedQuantity;
      } else {
        componentRemaining = matchingProgress.remaining;
        componentName = matchingProgress.name;
        componentExpected = matchingProgress.expected;
        componentScanned = matchingProgress.scanned;
      }
      
      if (componentRemaining === 0) {
        const errorMsg = matchingProgress.isKit && matchingComponentIndex !== null
          ? `Kit component ${componentName} already fully scanned (${componentScanned}/${componentExpected})`
          : `Already scanned ${matchingProgress.scanned}/${matchingProgress.expected} units of ${data.sku}`;
          
        await createPackingLog({
          action: "product_scanned",
          productSku: data.sku,
          scannedCode,
          skuVaultProductId: data.itemId || null,
          success: false,
          errorMessage: errorMsg,
        });

        showScanFeedback(
          "info",
          matchingProgress.isKit ? "COMPONENT COMPLETE" : "ALREADY COMPLETE",
          matchingProgress.isKit 
            ? `This kit component is fully scanned. Scan a different component.`
            : "This item is fully scanned. Scan next item.",
          {
            sku: matchingProgress.isKit && matchingProgress.kitComponents 
              ? matchingProgress.kitComponents[matchingComponentIndex!].sku || data.sku
              : matchingProgress.sku,
            productName: componentName,
            imageUrl: matchingProgress.isKit && matchingProgress.kitComponents
              ? matchingProgress.kitComponents[matchingComponentIndex!].picture || matchingProgress.imageUrl
              : matchingProgress.imageUrl,
            scannedCount: componentScanned,
            expectedCount: componentExpected,
          }
        );

        setProductScan("");
        setTimeout(() => productInputRef.current?.focus(), 0);
        return;
      }

      const currentProgress = matchingProgress;

      // Show pending feedback while QC sync happens
      showScanFeedback(
        "info",
        "VERIFYING WITH SKUVAULT...",
        "Please wait",
        {
          sku: data.sku,
          productName: currentProgress.name || data.title,
          imageUrl: currentProgress.imageUrl,
        }
      );

      // Synchronous SkuVault QC scan - verify item is in order and mark as passed
      // OPTIMIZATION: Pass cached SaleId and IdItem to avoid redundant SkuVault API calls
      // When both saleId and idItem are available (SkuVault-sourced orders), we skip the
      // getQCSalesByOrderNumber call and go directly to passQCItem (~45% API reduction).
      // For ShipStation-only orders or stale data, backend falls back to fresh SkuVault lookup.
      try {
        // Determine the IdItem based on whether this is a kit component or regular item
        const isKitComponent = currentProgress.isKit && matchingComponentIndex !== null;
        let idItem: string | null = null;
        let kitId: string | null = null; // Parent kit's SkuVault ID (for kit component scans)
        
        // Cache optimization only works for SkuVault-sourced orders
        // ShipStation-only orders won't have skuvaultItemId and will use fallback path
        if (isKitComponent && currentProgress.kitComponents) {
          // For kit components, use the component's skuvaultItemId (from SkuVault KitProducts[].Id)
          const component = currentProgress.kitComponents[matchingComponentIndex!];
          idItem = component.skuvaultItemId || null;
          
          // Get the parent kit's SkuVault ID from the shipment item
          const matchingKitItem = currentShipment?.items.find(item => 
            item.id === currentProgress.itemId
          );
          kitId = matchingKitItem?.skuvaultItemId || null;
          
          if (!idItem || !kitId) {
            console.log(`[Packing] Kit component ${component.sku} missing IDs - componentId=${idItem}, kitId=${kitId} - will use fallback lookup`);
          } else {
            console.log(`[Packing] Kit component scan: componentIndex=${matchingComponentIndex}, componentId=${idItem}, kitId=${kitId}, componentSku=${component.sku}`);
          }
        } else {
          // For regular items, use the item's skuvaultItemId from the shipment (from SkuVault Items[].Id)
          const matchingItem = currentShipment?.items.find(item => 
            item.id === currentProgress.itemId
          );
          idItem = matchingItem?.skuvaultItemId || null;
          if (!idItem) {
            console.log(`[Packing] Item ${currentProgress.sku} missing skuvaultItemId - will use fallback lookup`);
          } else {
            console.log(`[Packing] Regular item scan: itemId=${currentProgress.itemId}, skuvaultItemId=${idItem}`);
          }
        }
        
        const cachedSaleId = currentShipment!.saleId;
        const usingCachedData = !!cachedSaleId && !!idItem && (!isKitComponent || !!kitId);
        console.log(`[Packing] QC scan: saleId=${cachedSaleId}, idItem=${idItem}, kitId=${kitId}, isKitComponent=${isKitComponent}, usingCache=${usingCachedData}`);
        
        const qcResult = await qcScanMutation.mutateAsync({
          orderNumber: currentShipment!.orderNumber,
          sku: data.sku,
          quantity: 1,
          saleId: currentShipment!.saleId,  // Pass cached SaleId
          idItem,                            // Pass cached IdItem (component ID for kits)
          isKitComponent,
          kitId,                             // Pass parent kit's SkuVault ID (for kit components)
        });

        if (!qcResult.success) {
          // QC verification failed - item not in order or SkuVault error
          await createPackingLog({
            action: "product_scanned",
            productSku: data.sku,
            scannedCode,
            skuVaultProductId: data.itemId || null,
            success: false,
            errorMessage: qcResult.error || "SkuVault QC verification failed",
          });

          logShipmentEvent("product_scan_failed", {
            scannedCode,
            sku: data.sku,
            errorMessage: qcResult.error || "SkuVault QC verification failed",
            skuVaultError: true,
            station: "boxing",
          });

          showScanFeedback(
            "error",
            "SKUVAULT QC FAILED",
            qcResult.error || "Could not verify item in SkuVault",
            {
              sku: data.sku,
              productName: currentProgress.name || data.title,
            }
          );

          setProductScan("");
          setTimeout(() => productInputRef.current?.focus(), 0);
          return;
        }

        // QC passed successfully - now update local progress
        await createPackingLog({
          action: "product_scanned",
          productSku: data.sku,
          scannedCode,
          skuVaultProductId: data.itemId || null,
          success: true,
          errorMessage: null,
        });

        logShipmentEvent("product_scan_success", {
          sku: data.sku,
          barcode: scannedCode,
          itemId: matchingItemKey,
          scannedCount: currentProgress.scanned + 1,
          expectedCount: currentProgress.expected,
          station: "boxing",
          skuVaultVerified: true,
          isKitComponent: matchingComponentIndex !== null,
        });

        // Update progress (using item ID as key, tracking remaining units)
        const newProgress = new Map(skuProgress);
        
        // Handle kit component scanning vs regular item scanning
        if (currentProgress.isKit && matchingComponentIndex !== null && currentProgress.kitComponents) {
          // Kit component scan - update component scannedQuantity and recalculate aggregates
          const updatedComponents = [...currentProgress.kitComponents];
          updatedComponents[matchingComponentIndex] = {
            ...updatedComponents[matchingComponentIndex],
            scannedQuantity: updatedComponents[matchingComponentIndex].scannedQuantity + 1,
          };
          
          // Recalculate kit aggregate totals
          const newTotalScanned = updatedComponents.reduce((sum, c) => sum + c.scannedQuantity, 0);
          const totalExpected = currentProgress.totalComponentsExpected || 0;
          
          newProgress.set(matchingItemKey!, {
            ...currentProgress,
            kitComponents: updatedComponents,
            scanned: newTotalScanned,
            remaining: totalExpected - newTotalScanned,
            totalComponentsScanned: newTotalScanned,
          });
          
          console.log(`[Packing] Kit component scan: ${data.sku}, kit aggregate now ${newTotalScanned}/${totalExpected}`);
        } else {
          // Regular item scan
          newProgress.set(matchingItemKey!, {
            ...currentProgress,
            scanned: currentProgress.scanned + 1,
            remaining: currentProgress.remaining - 1,
          });
        }
        setSkuProgress(newProgress);

        // Show appropriate feedback
        const newScannedCount = currentProgress.isKit && matchingComponentIndex !== null
          ? currentProgress.scanned + 1  // Kit aggregate
          : currentProgress.scanned + 1;
          
        showScanFeedback(
          "success",
          currentProgress.isKit ? "KIT COMPONENT VERIFIED" : "SCAN VERIFIED",
          currentProgress.isKit ? `Component added to ${currentProgress.name}` : "Item confirmed in SkuVault",
          {
            sku: data.sku,
            productName: currentProgress.isKit 
              ? `${currentProgress.kitComponents?.[matchingComponentIndex!]?.name || data.title}`
              : (currentProgress.name || data.title),
            imageUrl: currentProgress.isKit 
              ? currentProgress.kitComponents?.[matchingComponentIndex!]?.picture || currentProgress.imageUrl
              : currentProgress.imageUrl,
            scannedCount: newScannedCount,
            expectedCount: currentProgress.expected,
          }
        );

      } catch (qcError: any) {
        // Network or unexpected error during QC
        console.error("[Packing] QC scan error:", qcError);
        
        await createPackingLog({
          action: "product_scanned",
          productSku: data.sku,
          scannedCode,
          skuVaultProductId: data.itemId || null,
          success: false,
          errorMessage: qcError.message || "SkuVault QC request failed",
        });

        logShipmentEvent("product_scan_failed", {
          scannedCode,
          sku: data.sku,
          errorMessage: qcError.message || "SkuVault QC request failed",
          networkError: true,
          station: "boxing",
        });

        showScanFeedback(
          "error",
          "QC VERIFICATION ERROR",
          "Could not reach SkuVault. Try again.",
          {
            sku: data.sku,
            productName: currentProgress.name || data.title,
          }
        );
      }

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
        station: "boxing",
      });

      showScanFeedback(
        "error",
        "VALIDATION ERROR",
        "Check barcode → Scan any remaining item below",
        {
          sku: scannedCode,
        }
      );

      setProductScan("");
      setTimeout(() => productInputRef.current?.focus(), 0);
    },
    onSettled: () => {
      // Always clear processing flag when mutation completes (success or error)
      setIsProductScanProcessing(false);
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
      station: "boxing",
      stationId: currentStation?.stationId || null,
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
        station: "boxing",
        stationId: currentStation?.stationId || null, // Specific workstation ID
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
  // When order is notShippable, we pass skipLabel=true for QC-only completion
  const completePackingMutation = useMutation({
    mutationFn: async () => {
      const isQcOnly = !!currentShipment?.notShippable;
      
      // Only set optimistic print job state if we're actually printing
      if (!isQcOnly) {
        setJustCreatedPrintJob(true);
      }
      
      const response = await apiRequest("POST", "/api/packing/complete", {
        shipmentId: currentShipment!.id,
        skipLabel: isQcOnly, // Skip label printing for non-shippable orders
      });
      return (await response.json()) as { 
        success: boolean; 
        printQueued: boolean; 
        qcOnly?: boolean;
        printJobId?: string; 
        message?: string 
      };
    },
    onSuccess: (result) => {
      // Play completion sound
      playCompletionSound();
      
      // Log packing completed event before resetting state
      const totalScans = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.scanned, 0);
      logShipmentEvent("packing_completed", {
        totalScans,
        printQueued: result.printQueued,
        qcOnly: result.qcOnly || false,
        station: "boxing",
      });
      
      // Show QC-only toast for non-shippable orders
      if (result.qcOnly) {
        toast({
          title: "QC Complete",
          description: "Quality check recorded. Label not printed - order is not yet shippable.",
          variant: "default",
        });
      }
      
      // Auto-reset to order scan state - ready for next order
      setCompletionSuccess(null);
      setJustCreatedPrintJob(false);
      setCurrentShipment(null);
      setPackingComplete(false);
      setOrderScan("");
      setSkuProgress(new Map());
      setLabelError(null);
      setScanFeedback(null); // Clear last scanned item feedback
      progressRestoredRef.current = false;
      
      // Focus the order input after state resets
      setTimeout(() => orderInputRef.current?.focus(), 0);
    },
    onError: (error: any) => {
      // Clear optimistic state on error
      setJustCreatedPrintJob(false);
      
      // Try to extract structured error from the response (ApiError includes parsed data)
      let parsedError: LabelError | null = null;
      
      // Check if error has structured data from ApiError
      if (error.data?.error) {
        parsedError = error.data.error as LabelError;
      }
      
      if (parsedError) {
        // Set the label error state to display inline on the page
        setLabelError(parsedError);
        console.log('[Packing] Label creation failed:', parsedError);
      } else {
        // Fallback: create a generic error for inline display
        setLabelError({
          code: 'UNKNOWN_ERROR',
          message: 'Failed to complete packing',
          shipStationError: error.message || 'Unknown error occurred',
          resolution: 'Please try again. If the problem persists, check ShipStation for this order.'
        });
      }
    },
    onSettled: () => {
      // Always clear processing flag when mutation completes (success or error)
      setIsCompletingPacking(false);
    },
  });

  const handleOrderScan = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard: require valid station session
    if (!hasValidSession) {
      setShowStationModal(true);
      return;
    }
    // Guard: prevent double-submission if already processing
    if (isOrderScanProcessing || loadShipmentMutation.isPending) {
      return;
    }
    if (orderScan.trim()) {
      // Clear any previous scan error before new scan
      setScanError(null);
      // Set processing flag IMMEDIATELY to prevent double-clicks
      setIsOrderScanProcessing(true);
      // Log order scan event
      logShipmentEvent("order_scanned", { scannedValue: orderScan.trim(), station: "boxing" }, orderScan.trim());
      loadShipmentMutation.mutate({ orderNumber: orderScan.trim() });
    }
  };

  const handleProductScan = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard: require valid station session
    if (!hasValidSession) {
      setShowStationModal(true);
      return;
    }
    // Guard: prevent double-submission if already processing
    if (isProductScanProcessing || validateProductMutation.isPending) {
      return;
    }
    if (productScan.trim() && currentShipment) {
      // Set processing flag IMMEDIATELY to prevent double-scans
      setIsProductScanProcessing(true);
      validateProductMutation.mutate(productScan.trim());
    }
  };

  const handleCompletePacking = () => {
    // Guard: require valid station session
    if (!hasValidSession) {
      setShowStationModal(true);
      return;
    }
    // Guard: prevent double-submission if already processing
    if (isCompletingPacking || completePackingMutation.isPending) {
      return;
    }
    // Set processing flag IMMEDIATELY to prevent double-clicks
    setIsCompletingPacking(true);
    completePackingMutation.mutate();
  };

  const handleManualVerify = async (progressKey: string) => {
    // Guard: require valid station session
    if (!hasValidSession) {
      setShowStationModal(true);
      return;
    }
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
      station: "boxing",
    });

    // Mark as verified (scanned)
    const newProgress = new Map(skuProgress);
    newProgress.set(progressKey, {
      ...progress,
      scanned: progress.expected,
      remaining: 0,
    });
    setSkuProgress(newProgress);
    
    // Return focus to product input
    setTimeout(() => productInputRef.current?.focus(), 0);
  };

  // Calculate completion status
  const allItemsScanned = Array.from(skuProgress.values()).every((p) => p.scanned >= p.expected);
  const totalExpected = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.expected, 0);
  const totalScanned = Array.from(skuProgress.values()).reduce((sum, p) => sum + p.scanned, 0);
  const successfulScans = packingLogs?.filter((log) => log.success && log.action === "product_scanned").length || 0;
  const failedScans = packingLogs?.filter((log) => !log.success && log.action === "product_scanned").length || 0;

  // Auto-focus Complete Boxing button when all items are scanned
  // This allows user to simply press Enter to print the label
  useEffect(() => {
    if (allItemsScanned && currentShipment && !hasPendingPrintJob && isPrinterReady) {
      // Small delay to ensure DOM is ready after state updates
      const timer = setTimeout(() => {
        completeButtonRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [allItemsScanned, currentShipment, hasPendingPrintJob, isPrinterReady]);

  return (
    <div className="container mx-auto p-4 max-w-7xl">
      {/* Station Selection Modal */}
      <Dialog open={showStationModal} onOpenChange={(open) => {
        // Only allow closing if user has a valid session
        if (!open && hasValidSession) {
          setShowStationModal(false);
        }
      }}>
        <DialogContent 
          className="sm:max-w-md" 
          onInteractOutside={(e) => {
            // Prevent closing by clicking outside if no session or mismatch
            if (!hasValidSession || workstationMismatch) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            // Prevent closing with Escape if no session or mismatch
            if (!hasValidSession || workstationMismatch) e.preventDefault();
          }}
          hideCloseButton={!hasValidSession || !!workstationMismatch}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Select Your Boxing Station
            </DialogTitle>
            <DialogDescription>
              Choose which station you're working at today. This selection resets at midnight.
            </DialogDescription>
          </DialogHeader>
          
          {/* Required station message */}
          {!hasValidSession && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md">
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                You must select a station to fulfill orders. A station is required to print shipping labels.
              </p>
            </div>
          )}
          
          <div className="grid gap-2 py-4">
            {isLoadingStations ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : availableStations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No active stations available. Please contact an administrator.
              </div>
            ) : (
              availableStations.map((station) => (
                <Button
                  key={station.id}
                  variant={currentStation?.stationId === station.id ? "default" : "outline"}
                  className="w-full justify-start h-auto py-4 px-4"
                  onClick={() => setStationMutation.mutate({ stationId: station.id, stationName: station.name })}
                  disabled={setStationMutation.isPending}
                  data-testid={`button-select-station-${station.id}`}
                >
                  <div className="flex flex-col items-start gap-1">
                    <div className="font-semibold text-lg">{station.name}</div>
                    {station.locationHint && (
                      <div className="text-sm text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {station.locationHint}
                      </div>
                    )}
                  </div>
                </Button>
              ))
            )}
          </div>
          
          {/* Exit button - only show when no valid session */}
          {!hasValidSession && (
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={() => setLocation("/shipments")}
                className="w-full"
                data-testid="button-exit-station-selection"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Exit
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Already Packed Dialog - Guard Rail for re-scanning packed orders */}
      {/* Supports multiple shipments for orders split across packages */}
      <AlreadyPackedDialog
        open={showAlreadyPackedDialog}
        shipments={alreadyPackedShipments}
        isReprintPending={reprintLabelMutation.isPending}
        onReprint={handleReprintFromAlreadyPacked}
        onProceedToQC={handleProceedToQCFromAlreadyPacked}
        onCancel={handleCancelAlreadyPacked}
      />

      {/* Shipment Selection Dialog - For orders with multiple shippable shipments */}
      <ShipmentChoiceDialog
        open={showShipmentChoiceDialog}
        orderNumber={pendingOrderNumber || ""}
        shippableShipments={shippableShipmentOptions}
        onSelect={handleShipmentSelect}
        onCancel={handleCancelShipmentSelection}
      />

      {/* Workstation Mismatch Blocking Screen */}
      {workstationMismatch && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
          <Card className="max-w-lg w-full">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-red-100 dark:bg-red-950 flex items-center justify-center">
                <AlertCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>
              <CardTitle className="text-xl">Wrong Workstation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="text-center text-muted-foreground">
                <p className="mb-4">
                  This computer is configured for <span className="font-semibold text-foreground">{workstationMismatch.workstationName}</span>, 
                  but you're assigned to <span className="font-semibold text-foreground">{workstationMismatch.userStationName}</span>.
                </p>
                <p className="text-sm">
                  Labels would print to the wrong printer if you continue here.
                </p>
              </div>
              
              <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
                <p className="text-sm font-medium text-center">Choose one option:</p>
                
                <Button
                  className="w-full"
                  onClick={() => setShowStationModal(true)}
                  data-testid="button-change-station-mismatch"
                >
                  <Building2 className="h-4 w-4 mr-2" />
                  Work at This Computer (Select {workstationMismatch.workstationName})
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  You'll need to select {workstationMismatch.workstationName} as your station
                </p>
                
                <div className="flex items-center gap-2 py-2">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <div className="flex-1 h-px bg-border" />
                </div>
                
                <p className="text-xs text-muted-foreground text-center">
                  Go to the computer configured for {workstationMismatch.userStationName}
                </p>
              </div>
              
              <div className="space-y-2 pt-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={async () => {
                    try {
                      await apiRequest('POST', '/api/auth/logout');
                      window.location.href = '/';
                    } catch (e) {
                      console.error('Logout failed:', e);
                    }
                  }}
                  data-testid="button-logout-mismatch"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Log Out (Let Someone Else Use This Computer)
                </Button>
                
                <Button
                  variant="ghost"
                  className="w-full text-muted-foreground"
                  onClick={() => setLocation("/shipments")}
                  data-testid="button-exit-mismatch"
                >
                  Go Back to Shipments
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Page Header with Station Indicator - only show if no mismatch */}
      {!workstationMismatch && (<>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <PackageCheck className="h-7 w-7 text-primary" />
          <h1 className="text-2xl font-bold">Boxing Station</h1>
        </div>
        
        {/* Station Indicator with Printer Status */}
        {isLoadingSession ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        ) : currentStation ? (
          <div className="flex items-center gap-2">
            {/* Station/Printer Status Indicator */}
            {isLoadingStationStatus ? (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Checking...</span>
              </div>
            ) : isPrinterReady ? (
              <div 
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-100 dark:bg-green-950 border border-green-200 dark:border-green-800"
                data-testid="indicator-printer-ready"
              >
                <Wifi className="h-3 w-3 text-green-600 dark:text-green-400" />
                <Printer className="h-3 w-3 text-green-600 dark:text-green-400" />
                <span className="text-xs font-medium text-green-700 dark:text-green-300">Ready</span>
              </div>
            ) : printerNotConfigured ? (
              <div 
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-100 dark:bg-amber-950 border border-amber-200 dark:border-amber-800"
                data-testid="indicator-printer-not-configured"
              >
                <Printer className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-300">No Printer</span>
              </div>
            ) : !isStationConnected ? (
              <div 
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-100 dark:bg-red-950 border border-red-200 dark:border-red-800"
                data-testid="indicator-station-offline"
              >
                <WifiOff className="h-3 w-3 text-red-600 dark:text-red-400" />
                <span className="text-xs font-medium text-red-700 dark:text-red-300">Station Offline</span>
              </div>
            ) : (
              <div 
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-100 dark:bg-amber-950 border border-amber-200 dark:border-amber-800"
                data-testid="indicator-printer-offline"
              >
                <Wifi className="h-3 w-3 text-green-600 dark:text-green-400" />
                <Printer className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Printer Offline</span>
              </div>
            )}
            
            {/* Station Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowStationModal(true)}
              className="flex items-center gap-2"
              data-testid="button-change-station"
            >
              <Building2 className="h-4 w-4" />
              <span className="font-medium">{currentStation.stationName}</span>
              {currentStation.stationLocationHint && (
                <span className="text-muted-foreground text-xs">
                  ({currentStation.stationLocationHint})
                </span>
              )}
            </Button>
          </div>
        ) : (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowStationModal(true)}
            data-testid="button-select-station"
          >
            <AlertCircle className="h-4 w-4 mr-2" />
            Select Station
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {/* Show blocking message if no station selected */}
        {!hasValidSession && !isLoadingSession ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Station Selected</h3>
                <p className="text-muted-foreground mb-4">
                  Please select your packing station to start scanning orders.
                </p>
                <Button onClick={() => setShowStationModal(true)} data-testid="button-open-station-modal">
                  Select Station
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : !currentShipment ? (
          /* No Order Loaded - Show Scan Order Input */
          <>
            {/* Order Scan Card - Entire card is clickable to focus input */}
            <Card 
              className={`cursor-text hover-elevate transition-shadow ${hasCriticalPrintQueue ? 'opacity-50' : ''}`}
              onClick={() => !hasCriticalPrintQueue && orderInputRef.current?.focus()}
            >
              <CardContent className="pt-6">
                <form onSubmit={handleOrderScan} className="space-y-3">
                  <label className="text-sm font-medium flex items-center gap-2">
                    <Scan className="h-4 w-4" />
                    Scan Order Barcode
                  </label>
                  <Input
                    ref={orderInputRef}
                    type="text"
                    placeholder={hasCriticalPrintQueue ? "Resolve print queue first..." : "Scan order number..."}
                    value={orderScan}
                    onChange={(e) => setOrderScan(e.target.value)}
                    disabled={isOrderScanProcessing || loadShipmentMutation.isPending || !hasValidSession || hasCriticalPrintQueue}
                    className="text-2xl h-16 text-center font-mono"
                    data-testid="input-order-scan"
                  />
                  {(isOrderScanProcessing || loadShipmentMutation.isPending) && (
                    <div className="flex items-center justify-center gap-2 text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      <span className="text-sm">Loading order...</span>
                    </div>
                  )}
                </form>
              </CardContent>
            </Card>
            
            {/* Scan Error Display - Shows when order cannot be scanned (all on hold, etc.) */}
            {scanError && (
              <div 
                className="bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 rounded-lg p-4 space-y-3"
                data-testid="alert-scan-error"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-semibold text-amber-800 dark:text-amber-200 text-lg">
                      {scanError.code === 'NO_ELIGIBLE_SHIPMENTS' || scanError.code === 'ALL_ON_HOLD'
                        ? 'No Shipments Available' 
                        : scanError.message}
                    </h4>
                    
                    {scanError.orderNumber && (
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-amber-700 dark:text-amber-300">Order:</span>
                        <Badge 
                          variant="outline" 
                          className="font-mono cursor-pointer hover-elevate"
                          onClick={() => copyToClipboard(scanError.orderNumber!)}
                        >
                          {scanError.orderNumber}
                          <Copy className="h-3 w-3 ml-1" />
                        </Badge>
                      </div>
                    )}
                    
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      {scanError.explanation}
                    </p>
                    
                    <div className="bg-amber-100 dark:bg-amber-900 rounded p-3">
                      <p className="text-sm text-amber-800 dark:text-amber-200">
                        <strong>What to do:</strong> {scanError.resolution}
                      </p>
                    </div>
                    
                    {/* Shipments accordion - helps warehouse distinguish between orders */}
                    {scanError.shipments && scanError.shipments.length > 0 && (
                      <Accordion type="multiple" className="w-full">
                        {scanError.shipments.map((shipment, index) => (
                          <AccordionItem 
                            key={shipment.id} 
                            value={shipment.id}
                            className="border-amber-300 dark:border-amber-700"
                          >
                            <AccordionTrigger 
                              className="text-sm text-amber-800 dark:text-amber-200 hover:no-underline py-2"
                              data-testid={`accordion-trigger-shipment-${index}`}
                            >
                              <div className="flex items-center gap-2 text-left flex-wrap">
                                <Package className="h-4 w-4 flex-shrink-0" />
                                <span className="font-medium">
                                  Shipment {index + 1}: {shipment.shipToName || 'Unknown'}
                                </span>
                                {shipment.exclusionReason && (
                                  <Badge 
                                    variant={shipment.exclusionReason === 'already_shipped' ? 'secondary' : 'outline'}
                                    className={`text-xs ${
                                      shipment.exclusionReason === 'already_shipped' 
                                        ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border-green-300 dark:border-green-700' 
                                        : shipment.exclusionReason === 'on_hold'
                                          ? 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700'
                                          : ''
                                    }`}
                                  >
                                    {shipment.exclusionReason === 'already_shipped' ? 'Already Shipped' : 
                                     shipment.exclusionReason === 'on_hold' ? 'On Hold' : 
                                     shipment.exclusionReason}
                                  </Badge>
                                )}
                                {shipment.trackingNumber && (
                                  <Badge 
                                    variant="outline" 
                                    className="text-xs font-mono cursor-pointer hover-elevate"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      copyToClipboard(shipment.trackingNumber!);
                                    }}
                                  >
                                    {shipment.trackingNumber}
                                    <Copy className="h-3 w-3 ml-1" />
                                  </Badge>
                                )}
                                {(shipment.shipToCity || shipment.shipToState) && (
                                  <span className="text-amber-600 dark:text-amber-400 text-xs">
                                    ({shipment.shipToCity || 'Unknown'}, {shipment.shipToState || 'Unknown'})
                                  </span>
                                )}
                              </div>
                            </AccordionTrigger>
                            <AccordionContent className="pb-2">
                              <div className="space-y-1 pl-6">
                                {shipment.items.length > 0 ? (
                                  shipment.items.map((item, itemIndex) => (
                                    <div 
                                      key={itemIndex}
                                      className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300"
                                    >
                                      <span className="font-mono text-xs bg-amber-200 dark:bg-amber-800 px-1 rounded">
                                        {item.quantity}x
                                      </span>
                                      <span className="font-mono text-xs">{item.sku || 'N/A'}</span>
                                      <span className="truncate">{item.name}</span>
                                    </div>
                                  ))
                                ) : (
                                  <p className="text-sm text-amber-600 dark:text-amber-400 italic">
                                    No items found
                                  </p>
                                )}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        ))}
                      </Accordion>
                    )}
                    
                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setScanError(null)}
                        data-testid="button-dismiss-scan-error"
                      >
                        Dismiss
                      </Button>
                      {scanError.orderNumber && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(`https://ship11.shipstation.com/orders/all-orders-search-result?quickSearch=${encodeURIComponent(scanError.orderNumber!)}`, '_blank')}
                          data-testid="button-view-in-shipstation"
                        >
                          <ExternalLink className="h-3 w-3 mr-1" />
                          View in ShipStation
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            
            {/* Print Queue Status Indicator - Separate container below scan card */}
            {!isLoadingStaleMetrics && printQueueJobCount > 0 && (
              <div 
                className={`rounded-lg p-4 ${
                  hasCriticalPrintQueue 
                    ? 'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800' 
                    : 'bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800'
                }`}
                data-testid="alert-print-queue-status"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className={`h-5 w-5 flex-shrink-0 mt-0.5 ${
                    hasCriticalPrintQueue 
                      ? 'text-red-600 dark:text-red-400' 
                      : 'text-amber-600 dark:text-amber-400'
                  }`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className={`font-medium ${
                        hasCriticalPrintQueue 
                          ? 'text-red-800 dark:text-red-200' 
                          : 'text-amber-800 dark:text-amber-200'
                      }`}>
                        Print Queue {hasCriticalPrintQueue ? 'Blocked' : 'Warning'}
                      </h4>
                      <Badge 
                        variant={hasCriticalPrintQueue ? 'destructive' : 'outline'}
                        className="text-xs"
                      >
                        {printQueueJobCount} job{printQueueJobCount !== 1 ? 's' : ''} stale
                      </Badge>
                    </div>
                    <p className={`text-sm ${
                      hasCriticalPrintQueue 
                        ? 'text-red-700 dark:text-red-300' 
                        : 'text-amber-700 dark:text-amber-300'
                    }`}>
                      {hasCriticalPrintQueue 
                        ? 'Critical print jobs are stuck. Please resolve the print queue before scanning orders.' 
                        : 'Some print jobs are taking longer than expected. Check the print queue if needed.'}
                    </p>
                  </div>
                </div>
                <Button 
                  variant={hasCriticalPrintQueue ? 'destructive' : 'outline'} 
                  size="sm" 
                  className="w-full mt-3"
                  onClick={() => setLocation('/print-queue')}
                  data-testid="button-resolve-print-queue"
                >
                  {hasCriticalPrintQueue ? 'Resolve Print Queue' : 'View Print Queue'}
                </Button>
              </div>
            )}
          </>
        ) : (
          /* Order Loaded - Show Header and QC or Completion */
          <>
            {/* Compact Order Info Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Order</div>
                  <div className="flex items-center gap-1">
                    <span className="text-xl font-bold font-mono" data-testid="badge-order-number">
                      {currentShipment.orderNumber}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 p-0"
                      onClick={() => copyToClipboard(currentShipment.orderNumber)}
                      data-testid="button-copy-order-number"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
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
                <div>
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Order Age</div>
                  <div className="text-lg font-semibold font-mono" data-testid="text-order-age">
                    {formatOrderAge(currentShipment.orderDate)}
                  </div>
                </div>
                {/* Session/Spot Info */}
                {(() => {
                  const sessionInfo = parseCustomField2(currentShipment.customField2);
                  if (!sessionInfo) return null;
                  return (
                    <>
                      <div className="h-12 w-[2px] bg-border" />
                      <div>
                        <div className="text-xs text-muted-foreground font-semibold mb-1 flex items-center gap-1">
                          <Boxes className="h-3 w-3" />
                          Session
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setSelectedSessionId(sessionInfo.sessionId)}
                            className="text-lg font-semibold text-primary hover:underline cursor-pointer"
                            data-testid={`link-session-${sessionInfo.sessionId}`}
                          >
                            {sessionInfo.sessionId}
                          </button>
                          <Badge variant="secondary" className="text-xs">
                            #{sessionInfo.spot}
                          </Badge>
                        </div>
                      </div>
                    </>
                  );
                })()}

                {/* Status Indicators */}
                <div className="h-12 w-[2px] bg-border" />
                <div>
                  <div className="text-xs text-muted-foreground font-semibold mb-1">Status</div>
                  <div className="flex items-center gap-2">
                    {hasMoveOverTag ? (
                      <Badge 
                        className="bg-green-600 hover:bg-green-600 text-white text-sm px-3 py-1"
                        data-testid="badge-shippable"
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" />
                        Shippable
                      </Badge>
                    ) : (
                      <Badge 
                        className="bg-red-600 hover:bg-red-600 text-white text-sm px-3 py-1"
                        data-testid="badge-not-shippable"
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Not Shippable
                      </Badge>
                    )}
                    {isGift && (
                      <Badge 
                        className="bg-pink-600 hover:bg-pink-600 text-white text-sm px-3 py-1"
                        data-testid="badge-gift"
                      >
                        <Gift className="h-4 w-4 mr-1" />
                        Add $5 Gift Card
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Show refresh button only for orders that are ready to pack (session closed, no tracking) */}
                {/* This is for when customer service makes order changes and packing needs fresh data */}
                {currentShipment?.sessionStatus === 'closed' && !currentShipment?.trackingNumber && currentShipment?.orderNumber && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => refreshCacheMutation.mutate(currentShipment.orderNumber)}
                    disabled={refreshCacheMutation.isPending}
                    title="Refresh order data from SkuVault (use if customer service made changes)"
                    data-testid="button-refresh-cache"
                  >
                    <RotateCcw className={`h-4 w-4 mr-1 ${refreshCacheMutation.isPending ? 'animate-spin' : ''}`} />
                    {refreshCacheMutation.isPending ? "Refreshing..." : "Refresh"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCurrentShipment(null);
                    setOrderScan("");
                    setPackingComplete(false);
                    setSkuProgress(new Map());
                    progressRestoredRef.current = false; // Reset for next order
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const url = `https://ship11.shipstation.com/orders/all-orders-search-result?quickSearch=${encodeURIComponent(currentShipment.orderNumber)}`;
                    window.open(url, '_blank');
                  }}
                  data-testid="button-view-shipstation"
                >
                  <ExternalLink className="h-4 w-4 mr-1" />
                  View in ShipStation
                </Button>
              </div>
            </div>

            {/* Collapsible Shipping Details */}
            <Accordion type="single" collapsible>
              <AccordionItem value="shipping-details" className="border rounded-lg px-4 bg-muted/50">
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
                          currentShipment.serviceCode
                        ].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 pb-4">
                    {/* Left Column: Shipping Information */}
                    <div className="space-y-4">
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

                    {/* Right Column: Order Notes */}
                    <div className="space-y-4 md:border-l md:pl-6">
                      {/* Gift Message */}
                      <div>
                        <div className="text-xs text-muted-foreground font-semibold mb-2">Gift Message</div>
                        <div className="text-sm" data-testid="text-gift-message">
                          {isGift && currentShipment.notesForGift ? (
                            <span className="italic text-pink-600">"{currentShipment.notesForGift}"</span>
                          ) : (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </div>
                      </div>

                      {/* Buyer Notes */}
                      <div>
                        <div className="text-xs text-muted-foreground font-semibold mb-2">Buyer Notes</div>
                        <div className="text-sm" data-testid="text-buyer-notes">
                          {currentShipment.notesFromBuyer ? (
                            <span className="text-blue-600">{currentShipment.notesFromBuyer}</span>
                          ) : (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </div>
                      </div>

                      {/* Shipment ID */}
                      <div>
                        <div className="text-xs text-muted-foreground font-semibold mb-2">Shipment ID</div>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-sm select-all cursor-text" data-testid="text-shipment-id">
                            {currentShipment.shipmentId}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 p-0"
                            onClick={() => copyToClipboard(currentShipment.shipmentId)}
                            data-testid="button-copy-shipment-id"
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
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
              {/* Unified Scanning Station - Combines input + feedback */}
              {!allItemsScanned && (
                <div
                  className={`rounded-lg border-4 transition-all ${
                    isProductScanProcessing || validateProductMutation.isPending
                      ? "border-primary bg-primary/5 animate-pulse-border"
                      : scanFeedback
                      ? scanFeedback.type === "success"
                        ? "bg-green-50 dark:bg-green-950/30 border-green-600"
                        : scanFeedback.type === "error"
                        ? "bg-red-50 dark:bg-red-950/30 border-red-600"
                        : "bg-blue-50 dark:bg-blue-950/30 border-blue-600"
                      : "bg-muted/30 border-muted-foreground/20"
                  }`}
                  data-testid="scan-station"
                >
                  {/* Scan Input - Always visible at top */}
                  <form onSubmit={handleProductScan} className="p-4 pb-0">
                    <Input
                      ref={productInputRef}
                      type="text"
                      placeholder="Scan product barcode..."
                      value={productScan}
                      onChange={(e) => setProductScan(e.target.value)}
                      onFocus={handleFirstInteraction}
                      disabled={isProductScanProcessing || validateProductMutation.isPending}
                      className="text-2xl h-16 text-center font-mono"
                      data-testid="input-product-scan"
                    />
                  </form>

                  {/* Feedback Area - State-dependent content - Click to refocus input */}
                  <div 
                    className="p-4 min-h-[120px] flex items-center cursor-pointer"
                    onClick={() => productInputRef.current?.focus()}
                    data-testid="feedback-area"
                  >
                    {isProductScanProcessing || validateProductMutation.isPending ? (
                      // VALIDATING STATE - Large spinner + explicit status message
                      <div className="flex flex-col items-center gap-3 w-full">
                        <Loader2 className="h-16 w-16 animate-spin text-primary" />
                        <div className="text-center">
                          <div className="text-2xl font-bold text-primary mb-1">Validating Scan...</div>
                          <div className="text-lg text-muted-foreground">Please wait - checking product with SkuVault</div>
                        </div>
                      </div>
                    ) : scanFeedback ? (
                      // SUCCESS/ERROR STATE - Show feedback
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
                        
                        {/* Product Image */}
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
                                <div className="text-xl font-semibold text-foreground mb-1 truncate">
                                  {scanFeedback.productName}
                                </div>
                              )}
                              {scanFeedback.sku && (
                                <div className="text-lg font-mono text-muted-foreground">
                                  {scanFeedback.sku}
                                </div>
                              )}
                              <div className="text-lg text-muted-foreground mt-1">
                                {scanFeedback.message}
                              </div>
                            </div>
                            
                            {/* Scanned Count */}
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
                      // IDLE STATE - Ready to scan with prominent guidance
                      <div className="flex items-center gap-4 w-full">
                        <Package className="h-12 w-12 text-primary" />
                        <div>
                          <div className="text-2xl font-bold text-foreground">Ready to Scan</div>
                          <div className="text-lg text-muted-foreground">Scan a product barcode to begin quality control</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Overall Progress - Only show when not complete */}
              {!allItemsScanned && (
                <div className="p-4 bg-muted/50 rounded-lg">
                  <div className="text-3xl font-bold">
                    {totalExpected - totalScanned} {totalExpected - totalScanned === 1 ? "Item" : "Items"} Remaining
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {totalScanned} of {totalExpected} scanned
                  </div>
                  
                  {/* Progress Bar */}
                  <div className="mt-3 h-3 bg-background rounded-full overflow-hidden">
                    <div
                      className="h-full bg-muted-foreground/50 transition-all"
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
                  
                  // Sort by remaining items (most remaining first)
                  pendingItems.sort((a, b) => b[1].remaining - a[1].remaining);
                  
                  // Render function for item cards
                  const renderItem = ([key, progress]: [string, SkuProgress], index: number) => {
                    const isComplete = progress.scanned >= progress.expected;
                    const isPartial = progress.scanned > 0 && progress.scanned < progress.expected;
                    const isFirstPending = index === 0 && !isComplete;
                    
                    // Kit item with collapsible components
                    if (progress.isKit && progress.kitComponents && progress.kitComponents.length > 0) {
                      return (
                        <div
                          key={key}
                          className={`rounded-lg transition-all border-2 ${
                            isComplete
                              ? "border-muted-foreground/30 bg-muted/50"
                              : isFirstPending
                              ? "border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/30 border-l-8 border-l-primary"
                              : "border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/30"
                          }`}
                          data-testid={`progress-kit-${progress.sku}`}
                        >
                          {/* Kit Header with Progress */}
                          <div className="p-4">
                            <div className="flex items-start gap-4 mb-3">
                              {progress.imageUrl && (
                                <img
                                  src={progress.imageUrl}
                                  alt={progress.name}
                                  className="w-28 h-28 object-cover rounded-md border-2 flex-shrink-0"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge className="bg-purple-600 hover:bg-purple-700 text-white flex-shrink-0 text-xs">
                                    <Boxes className="h-3 w-3 mr-1" />
                                    Kit
                                  </Badge>
                                  <div className="font-semibold text-xl truncate">{progress.name}</div>
                                  {isFirstPending && !isComplete && (
                                    <Badge variant="default" className="flex-shrink-0 text-xs">
                                      <Zap className="h-3 w-3 mr-1" />
                                      Scan Next
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-sm text-muted-foreground mt-1" data-testid={`text-kit-sku-${progress.sku}`}>
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs">SKU:</span>
                                    <span className="font-mono select-all cursor-text" data-testid={`text-kit-sku-value-${progress.sku}`}>{progress.sku}</span>
                                  </div>
                                  {/* Always show code with copy button - show N/A if no barcode available */}
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs">Code:</span>
                                    <span className="font-mono select-all cursor-text" data-testid={`text-kit-barcode-value-${progress.sku}`}>
                                      {progress.skuvaultCode || 'N/A'}
                                    </span>
                                    {progress.skuvaultCode && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-5 w-5 p-0"
                                        onClick={() => copyToClipboard(progress.skuvaultCode!)}
                                        data-testid={`button-copy-kit-barcode-${progress.sku}`}
                                      >
                                        <Copy className="h-3 w-3" />
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                <div className="text-sm text-purple-600 dark:text-purple-400 mt-1">
                                  {progress.kitComponents.length} component{progress.kitComponents.length !== 1 ? 's' : ''} • Scan any component barcode
                                </div>
                              </div>
                              <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                                {isComplete ? (
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <CheckCircle2 className="h-6 w-6 flex-shrink-0" />
                                    <span className="font-medium text-sm">Complete</span>
                                  </div>
                                ) : null}
                                <span className="text-2xl font-bold whitespace-nowrap">
                                  {progress.scanned} / {progress.expected}
                                </span>
                              </div>
                            </div>
                            
                            {/* Kit Progress Bar */}
                            <div>
                              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                                <span>
                                  {isComplete ? "All components scanned" : `${progress.remaining} remaining`}
                                </span>
                                <span>{progress.expected > 0 ? Math.round((progress.scanned / progress.expected) * 100) : 0}%</span>
                              </div>
                              <div className="h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-purple-500 transition-all"
                                  style={{ width: `${progress.expected > 0 ? (progress.scanned / progress.expected) * 100 : 0}%` }}
                                />
                              </div>
                            </div>
                          </div>
                          
                          {/* Collapsible Components Section */}
                          <Accordion type="single" collapsible className="border-t border-purple-200 dark:border-purple-800">
                            <AccordionItem value="components" className="border-0">
                              <AccordionTrigger className="px-4 py-2 hover:no-underline text-sm text-purple-600 dark:text-purple-400">
                                <span className="flex items-center gap-2">
                                  <Boxes className="h-4 w-4" />
                                  View {progress.kitComponents.length} Component{progress.kitComponents.length !== 1 ? 's' : ''}
                                </span>
                              </AccordionTrigger>
                              <AccordionContent className="px-4 pb-4">
                                <div className="space-y-2 mt-2">
                                  {progress.kitComponents.map((comp) => {
                                    const compComplete = comp.scannedQuantity >= comp.quantity;
                                    const compPartial = comp.scannedQuantity > 0 && comp.scannedQuantity < comp.quantity;
                                    const progressPercent = comp.quantity > 0 ? (comp.scannedQuantity / comp.quantity) * 100 : 0;
                                    
                                    // Determine status colors - purple accent for untouched state
                                    const statusColor = compComplete 
                                      ? "text-green-600 dark:text-green-500" 
                                      : compPartial 
                                        ? "text-amber-600 dark:text-amber-500" 
                                        : "text-purple-500 dark:text-purple-400";
                                    const progressBarColor = compComplete 
                                      ? "bg-green-500" 
                                      : compPartial 
                                        ? "bg-amber-500" 
                                        : "bg-purple-200 dark:bg-purple-800";
                                    const borderColor = compComplete
                                      ? "border-green-200 dark:border-green-800"
                                      : compPartial
                                        ? "border-amber-200 dark:border-amber-800"
                                        : "border-purple-200 dark:border-purple-800";
                                    
                                    return (
                                      <div 
                                        key={comp.id}
                                        className={`p-3 rounded-lg border ${
                                          compComplete 
                                            ? "bg-green-50/50 dark:bg-green-950/20" 
                                            : compPartial
                                              ? "bg-amber-50/50 dark:bg-amber-950/20"
                                              : "bg-white dark:bg-background"
                                        } ${borderColor}`}
                                        data-testid={`kit-component-${comp.sku || comp.id}`}
                                      >
                                        <div className="flex items-start gap-3">
                                          {/* Component Product Image */}
                                          {comp.picture && (
                                            <img
                                              src={comp.picture}
                                              alt={comp.name}
                                              className="w-14 h-14 object-cover rounded-md border-2 flex-shrink-0"
                                              data-testid={`img-component-${comp.sku || comp.id}`}
                                            />
                                          )}
                                          <div className="flex-1 min-w-0">
                                            <div className="font-medium text-sm truncate">{comp.name}</div>
                                            <div className="text-xs text-muted-foreground" data-testid={`text-comp-barcode-${comp.sku || comp.id}`}>
                                              <div className="flex items-center gap-1">
                                                <span>SKU:</span>
                                                <span className="font-mono select-all cursor-text" data-testid={`text-comp-sku-value-${comp.sku || comp.id}`}>{comp.sku || 'N/A'}</span>
                                              </div>
                                              {/* Always show code with copy button - show N/A if no barcode available */}
                                              <div className="flex items-center gap-1">
                                                <span>Code:</span>
                                                <span className="font-mono select-all cursor-text" data-testid={`text-comp-barcode-value-${comp.sku || comp.id}`}>
                                                  {comp.code || 'N/A'}
                                                </span>
                                                {comp.code && (
                                                  <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-4 w-4 p-0"
                                                    onClick={() => copyToClipboard(comp.code!)}
                                                    data-testid={`button-copy-comp-barcode-${comp.sku || comp.id}`}
                                                  >
                                                    <Copy className="h-2.5 w-2.5" />
                                                  </Button>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-2 flex-shrink-0">
                                            {/* Status Icon */}
                                            {compComplete ? (
                                              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-500" />
                                            ) : compPartial ? (
                                              <Clock className="h-5 w-5 text-amber-600 dark:text-amber-500" />
                                            ) : (
                                              <CircleDashed className="h-5 w-5 text-purple-500 dark:text-purple-400" />
                                            )}
                                            {/* Progress Text */}
                                            <span className={`font-bold text-sm min-w-[3rem] text-right ${statusColor}`}>
                                              {comp.scannedQuantity} / {comp.quantity}
                                            </span>
                                          </div>
                                        </div>
                                        {/* Mini Progress Bar */}
                                        <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                                          <div
                                            className={`h-full transition-all ${progressBarColor}`}
                                            style={{ width: `${progressPercent}%` }}
                                          />
                                        </div>
                                        {/* Status Label */}
                                        <div className={`mt-1 text-xs ${statusColor}`}>
                                          {compComplete 
                                            ? "Complete" 
                                            : compPartial 
                                              ? `${comp.scannedQuantity} of ${comp.quantity} picked` 
                                              : "Not started"}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>
                        </div>
                      );
                    }
                    
                    // Regular item (non-kit)
                    return (
                      <div
                        key={key}
                        className={`p-4 rounded-lg transition-all ${
                          isComplete
                            ? "border-2 border-muted-foreground/30 bg-muted/50"
                            : progress.requiresManualVerification
                            ? "border-2 border-orange-600 bg-orange-50 dark:bg-orange-950/20"
                            : isFirstPending
                            ? "border-2 border-muted-foreground/30 bg-card border-l-8 border-l-primary"
                            : isPartial
                            ? "border-2 border-muted-foreground/30 bg-card"
                            : "border-2 border-muted-foreground/20 bg-card"
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
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="font-semibold text-xl truncate">{progress.name}</div>
                              {isFirstPending && !isComplete && (
                                <Badge variant="default" className="flex-shrink-0 text-xs">
                                  <Zap className="h-3 w-3 mr-1" />
                                  Scan Next
                                </Badge>
                              )}
                              {progress.skuvaultSynced && (
                                <Badge variant="secondary" className="flex-shrink-0 text-xs">
                                  <CheckCircle2 className="h-3 w-3 mr-1" />
                                  SkuVault
                                </Badge>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground" data-testid={`text-barcode-${progress.sku}`}>
                              <div className="flex items-center gap-1">
                                <span className="text-xs">SKU:</span>
                                <span className="font-mono select-all cursor-text" data-testid={`text-sku-value-${progress.sku}`}>{progress.sku}</span>
                              </div>
                              {/* Always show code with copy button - show N/A if no barcode available */}
                              <div className="flex items-center gap-1">
                                <span className="text-xs">Code:</span>
                                <span className="font-mono select-all cursor-text" data-testid={`text-barcode-value-${progress.sku}`}>
                                  {progress.skuvaultCode || 'N/A'}
                                </span>
                                {progress.skuvaultCode && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-5 w-5 p-0"
                                    onClick={() => copyToClipboard(progress.skuvaultCode!)}
                                    data-testid={`button-copy-barcode-${progress.sku}`}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                            {isComplete ? (
                              <div className="flex items-center gap-2 text-muted-foreground">
                                <CheckCircle2 className="h-6 w-6 flex-shrink-0" />
                                <span className="font-medium text-sm">Complete</span>
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
                                progress.requiresManualVerification
                                  ? "bg-orange-600"
                                  : "bg-muted-foreground/50"
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
                        <div className="text-center py-6" data-testid="message-all-complete">
                          <CheckCircle2 className="h-12 w-12 mx-auto mb-2 text-muted-foreground" />
                          <p className="font-semibold text-lg">All items scanned!</p>
                          <p className="text-sm text-muted-foreground">Review completed items below</p>
                          {isGift && (
                            <Badge 
                              className="bg-pink-600 hover:bg-pink-600 text-white text-lg px-4 py-2 mt-4"
                              data-testid="badge-gift-reminder"
                            >
                              <Gift className="h-5 w-5 mr-2" />
                              Add $5 Gift Card
                            </Badge>
                          )}
                        </div>
                      )}
                      
                      {/* Completed Items Section - Collapsible */}
                      {completedItems.length > 0 && (
                        <Accordion type="single" collapsible data-testid="accordion-completed-items-container">
                          <AccordionItem value="completed-items" className="border rounded-lg px-4" data-testid="accordion-completed-items">
                            <AccordionTrigger className="hover:no-underline" data-testid="trigger-completed-items">
                              <span className="text-sm font-medium flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
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

              {/* Pending Print Job Warning */}
              {hasPendingPrintJob && (
                <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-3" data-testid="alert-pending-print-job">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="font-medium text-amber-800 dark:text-amber-200">Print Job In Progress</h4>
                      <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        A label is already queued for printing. Please wait for it to complete or resolve the issue before packing again.
                      </p>
                      <div className="mt-2 text-sm">
                        {pendingPrintJobs.map(job => (
                          <div key={job.id} className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                            <Badge variant="outline" className="text-xs">
                              {job.status === 'pending' ? 'Queued' : job.status === 'sent' ? 'Sent to Printer' : 'Printing'}
                            </Badge>
                            <span>at {job.stationName}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="w-full"
                    onClick={() => setLocation('/print-queue')}
                    data-testid="button-view-print-queue"
                  >
                    View Print Queue
                  </Button>
                </div>
              )}

              {/* Not Shippable Warning - Order loaded but cannot print label */}
              {currentShipment?.notShippable && (
                <div 
                  className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-2"
                  data-testid="alert-not-shippable"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="font-medium text-amber-800 dark:text-amber-200">
                        {currentShipment.notShippable.message}
                      </h4>
                      <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                        {currentShipment.notShippable.explanation}
                      </p>
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 font-medium">
                        {currentShipment.notShippable.resolution}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Printer Not Ready Warning */}
              {!isPrinterReady && !isLoadingStationStatus && (
                <div 
                  className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-4 space-y-2"
                  data-testid="alert-printer-not-ready"
                >
                  <div className="flex items-start gap-3">
                    {!isStationConnected ? (
                      <WifiOff className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <Printer className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1">
                      <h4 className="font-medium text-red-800 dark:text-red-200">
                        {!isStationConnected 
                          ? 'Station Offline' 
                          : printerNotConfigured 
                            ? 'No Printer Configured'
                            : 'Printer Offline'}
                      </h4>
                      <p className="text-sm text-red-700 dark:text-red-300 mt-1">
                        {!isStationConnected 
                          ? 'The desktop printing app is not connected. Please start the app on this station.' 
                          : printerNotConfigured 
                            ? 'No printer is configured for this station. Please set up a printer in the desktop app.'
                            : 'The printer is not responding. Please check the printer connection.'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Complete Packing Button */}
              {/* For notShippable orders: enable button for QC-only completion (no label print) */}
              {/* For shippable orders: require printer ready before enabling */}
              <Button
                ref={completeButtonRef}
                onClick={handleCompletePacking}
                disabled={
                  !allItemsScanned || 
                  isCompletingPacking ||
                  completePackingMutation.isPending || 
                  (currentShipment?.notShippable ? false : (hasPendingPrintJob || !isPrinterReady))
                }
                className="w-full focus:ring-4 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background focus:scale-[1.02] transition-all"
                size="lg"
                data-testid="button-complete-packing"
              >
                {isCompletingPacking || completePackingMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Completing...
                  </>
                ) : currentShipment?.notShippable && allItemsScanned ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Complete Packing
                  </>
                ) : !isPrinterReady && !currentShipment?.notShippable ? (
                  <>
                    <WifiOff className="h-4 w-4 mr-2" />
                    Printer Not Ready
                  </>
                ) : hasPendingPrintJob ? (
                  <>
                    <AlertCircle className="h-4 w-4 mr-2" />
                    Print Job Pending
                  </>
                ) : allItemsScanned ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Complete Boxing
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-4 w-4 mr-2" />
                    Scan All Items First
                  </>
                )}
              </Button>

              {/* Success Completion Panel - Requires acknowledgment before moving to next order */}
              {completionSuccess && (
                <div 
                  className="bg-green-50 dark:bg-green-950 border border-green-300 dark:border-green-700 rounded-lg p-4 space-y-3"
                  data-testid="alert-completion-success"
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <h4 className="font-semibold text-green-800 dark:text-green-200 text-xl">
                        Boxing Complete!
                      </h4>
                      <p className="text-base text-green-700 dark:text-green-300">
                        {completionSuccess.message}
                      </p>
                      {completionSuccess.printJobId && (
                        <p className="text-sm text-green-600 dark:text-green-400">
                          Print Job ID: {completionSuccess.printJobId}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 pt-3 border-t border-green-200 dark:border-green-800">
                    <Button
                      onClick={() => {
                        setCompletionSuccess(null);
                        setJustCreatedPrintJob(false);
                        setCurrentShipment(null);
                        setPackingComplete(false);
                        setOrderScan("");
                        setSkuProgress(new Map());
                        setLabelError(null);
                        progressRestoredRef.current = false;
                        orderInputRef.current?.focus();
                      }}
                      size="lg"
                      className="w-full"
                      data-testid="button-next-order"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Next Order
                    </Button>
                  </div>
                </div>
              )}

              {/* Label Creation Error Panel */}
              {labelError && (() => {
                // Error codes that cannot be fixed from the packing page - no retry
                const nonRetriableCodes = ['SHIPMENT_ON_HOLD', 'ADDRESS_VALIDATION_FAILED', 'CARRIER_ERROR'];
                const canRetry = !nonRetriableCodes.includes(labelError.code);
                
                return (
                <div 
                  className="bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 rounded-lg p-4 space-y-3"
                  data-testid="alert-label-error"
                >
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <h4 className="font-semibold text-red-800 dark:text-red-200 text-lg">
                        {labelError.code === 'SHIPMENT_ON_HOLD' 
                          ? 'Shipment On Hold - Cannot Print Label'
                          : labelError.code === 'ADDRESS_VALIDATION_FAILED'
                            ? 'Address Error - Cannot Create Label'
                            : labelError.code === 'CARRIER_ERROR'
                              ? 'Carrier Issue - Cannot Create Label'
                              : labelError.message}
                      </h4>
                      
                      {/* Show specific guidance based on error code */}
                      {labelError.code === 'SHIPMENT_ON_HOLD' && (
                        <div className="bg-amber-100 dark:bg-amber-900 border border-amber-300 dark:border-amber-700 rounded p-3 space-y-2">
                          <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                            This order has a hold date set in ShipStation.
                          </p>
                          <p className="text-sm text-amber-700 dark:text-amber-300">
                            Labels cannot be created until the hold is removed. Someone needs to go into ShipStation and release the hold on this shipment.
                          </p>
                          {labelError.shipStationError && (
                            <p className="text-xs text-amber-600 dark:text-amber-400 font-mono bg-amber-50 dark:bg-amber-950 p-2 rounded">
                              {labelError.shipStationError}
                            </p>
                          )}
                        </div>
                      )}
                      
                      {labelError.code === 'ADDRESS_VALIDATION_FAILED' && (
                        <div className="bg-orange-100 dark:bg-orange-900 border border-orange-300 dark:border-orange-700 rounded p-3">
                          <p className="text-sm text-orange-800 dark:text-orange-200">
                            The shipping address could not be validated. Check and correct the address in ShipStation before trying again.
                          </p>
                        </div>
                      )}
                      
                      {labelError.code === 'CARRIER_ERROR' && (
                        <div className="bg-orange-100 dark:bg-orange-900 border border-orange-300 dark:border-orange-700 rounded p-3">
                          <p className="text-sm text-orange-800 dark:text-orange-200">
                            There's an issue with the shipping carrier or service. Check ShipStation to verify the carrier is available.
                          </p>
                        </div>
                      )}
                      
                      {labelError.code === 'RATE_LIMIT_EXCEEDED' && (
                        <div className="bg-blue-100 dark:bg-blue-900 border border-blue-300 dark:border-blue-700 rounded p-3">
                          <p className="text-sm text-blue-800 dark:text-blue-200">
                            ShipStation is temporarily limiting requests. Wait 30-60 seconds before retrying.
                          </p>
                        </div>
                      )}
                      
                      {/* Show raw ShipStation error for debugging (except for on-hold which shows it inline) */}
                      {labelError.shipStationError && labelError.code !== 'SHIPMENT_ON_HOLD' && (
                        <div className="bg-red-100 dark:bg-red-900 rounded p-2">
                          <p className="text-xs text-red-600 dark:text-red-400 font-mono break-all">
                            {labelError.shipStationError}
                          </p>
                        </div>
                      )}
                      
                      <div className="flex items-start gap-2 mt-2">
                        <span className="text-sm font-medium text-red-800 dark:text-red-200">How to fix:</span>
                        <p className="text-sm text-red-700 dark:text-red-300">
                          {labelError.resolution}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2 border-t border-red-200 dark:border-red-800">
                    {/* Only show Retry for errors that can potentially be fixed by retrying */}
                    {canRetry && (
                      <Button
                        onClick={() => {
                          // Guard: prevent double-submission
                          if (isCompletingPacking || completePackingMutation.isPending) return;
                          setIsCompletingPacking(true);
                          setLabelError(null);
                          // Revalidate printer status before retrying
                          queryClient.invalidateQueries({ queryKey: ['/api/stations'] });
                          completePackingMutation.mutate();
                        }}
                        disabled={isCompletingPacking || completePackingMutation.isPending}
                        size="sm"
                        data-testid="button-retry-label"
                      >
                        {isCompletingPacking || completePackingMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            Retrying...
                          </>
                        ) : (
                          <>
                            <RotateCcw className="h-4 w-4 mr-2" />
                            Retry
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      onClick={() => setLabelError(null)}
                      variant="ghost"
                      size="sm"
                      data-testid="button-dismiss-error"
                    >
                      {!canRetry ? 'Acknowledge' : 'Dismiss'}
                    </Button>
                  </div>
                </div>
                );
              })()}
                </CardContent>
              </Card>
            )}

            {/* Boxing Complete Message - Only show when complete */}
            {packingComplete && (
              <Card className="border-green-600">
                <CardContent className="pt-6">
                  <div className="text-center space-y-4">
                    <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
                    <div>
                      <h3 className="text-2xl font-bold text-green-600">Boxing Complete!</h3>
                      <p className="text-muted-foreground mt-2">Loading next order...</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Events Timeline - Shows when order is loaded AND has events or logs */}
        {currentShipment && ((packingLogs && packingLogs.length > 0) || (shipmentEvents && shipmentEvents.length > 0)) && (() => {
          // Merge logs and events, sorted by timestamp (newest first)
          type TimelineEntry = {
            id: string;
            type: 'log' | 'event';
            timestamp: string;
            data: PackingLog | ShipmentEvent;
          };

          const timeline: TimelineEntry[] = [];
          
          if (packingLogs) {
            packingLogs.forEach(log => {
              timeline.push({
                id: log.id,
                type: 'log',
                timestamp: log.createdAt,
                data: log
              });
            });
          }
          
          if (shipmentEvents) {
            shipmentEvents.forEach(event => {
              timeline.push({
                id: event.id,
                type: 'event',
                timestamp: event.occurredAt,
                data: event
              });
            });
          }
          
          // Sort by timestamp (newest first)
          timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          
          // Calculate stats from logs only (not events)
          const successfulScans = packingLogs?.filter(log => log.success).length || 0;
          const failedScans = packingLogs?.filter(log => !log.success).length || 0;
          const totalScans = (packingLogs?.length || 0);
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
                    <span className="font-semibold">Events Timeline</span>
                    {totalScans > 0 && (
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
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-6 pb-4">
                  <div className="space-y-2 max-h-96 overflow-y-auto" data-testid="list-scan-history">
                    {timeline.map((entry) => {
                      if (entry.type === 'log') {
                        const log = entry.data as PackingLog;
                        return (
                          <div
                            key={entry.id}
                            className={`p-3 rounded-lg border ${
                              log.success
                                ? "border-green-200 bg-green-50 dark:bg-green-950/20"
                                : "border-red-200 bg-red-50 dark:bg-red-950/20"
                            }`}
                          >
                            <div className="grid grid-cols-[1fr,auto,auto] gap-4 items-start">
                              {/* Column 1: Event Details */}
                              <div className="min-w-0">
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
                              
                              {/* Column 2: User */}
                              <div className="text-xs text-muted-foreground whitespace-nowrap">
                                System
                              </div>
                              
                              {/* Column 3: Timestamp */}
                              <div className="text-xs text-muted-foreground whitespace-nowrap">
                                {new Date(log.createdAt).toLocaleString()}
                              </div>
                            </div>
                          </div>
                        );
                      } else {
                        const event = entry.data as ShipmentEvent;
                        // Format event name for display
                        const getEventDisplayName = (eventName: string) => {
                          const nameMap: Record<string, string> = {
                            'product_scan_success': 'Product Scanned',
                            'order_scanned': 'Order Scanned',
                            'order_loaded': 'Order Loaded',
                            'product_scan_failed': 'Scan Failed',
                            'manual_verification': 'Manual Verification',
                            'packing_completed': 'Boxing Completed',
                          };
                          return nameMap[eventName] || eventName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        };
                        
                        return (
                          <div
                            key={entry.id}
                            className="p-3 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20"
                          >
                            <div className="grid grid-cols-[1fr,auto,auto] gap-4 items-start">
                              {/* Column 1: Event Details */}
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Zap className="h-4 w-4 text-blue-600 flex-shrink-0" />
                                  <span className="font-medium text-sm">
                                    {getEventDisplayName(event.eventName)}
                                  </span>
                                  {event.skuvaultImport && (
                                    <Badge variant="outline" className="ml-2 text-xs border-blue-400 text-blue-700 dark:text-blue-300">
                                      SkuVault
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-sm space-y-1">
                                  {event.metadata?.sku && (
                                    <div className="font-mono text-muted-foreground">{event.metadata.sku}</div>
                                  )}
                                  {event.metadata?.message && (
                                    <div className="text-xs text-muted-foreground">{event.metadata.message}</div>
                                  )}
                                  {!event.metadata?.sku && !event.metadata?.message && event.metadata && (
                                    <div className="text-xs text-muted-foreground">
                                      {JSON.stringify(event.metadata).slice(0, 100)}
                                    </div>
                                  )}
                                </div>
                              </div>
                              
                              {/* Column 2: User */}
                              <div className="text-xs text-muted-foreground whitespace-nowrap">
                                {event.username || 'N/A'}
                              </div>
                              
                              {/* Column 3: Timestamp */}
                              <div className="text-xs text-muted-foreground whitespace-nowrap">
                                {new Date(event.occurredAt).toLocaleString()}
                              </div>
                            </div>
                          </div>
                        );
                      }
                    })}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          );
        })()}
      </div>
      </>)}

      {/* Session Detail Modal */}
      <SessionDetailDialog 
        picklistId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
