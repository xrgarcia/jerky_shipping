import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Layers,
  Package,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Box,
  Truck,
  Check,
  X,
  Loader2,
  Plus,
  Settings,
  ChevronDown,
  Hand,
  Pencil,
  Tag,
  Play,
  ListPlus,
  Clock,
  Users,
  ArrowRight,
  Info,
  Eye,
  Trash2,
  MapPin,
  Scale,
  Filter,
  CheckSquare,
  Square,
  Copy,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface FingerprintData {
  id: string;
  signature: string;
  signatureHash: string;
  displayName: string | null;
  totalItems: number;
  collectionCount: number;
  totalWeight: number | null;
  weightUnit: string | null;
  createdAt: string;
  shipmentCount: number;
  packagingTypeId: string | null;
  packagingTypeName: string | null;
  stationType: string | null;
  humanReadableName: string;
  hasPackaging: boolean;
}

interface FingerprintsResponse {
  fingerprints: FingerprintData[];
  stats: {
    total: number;
    assigned: number;
    needsDecision: number;
  };
}

interface PackagingType {
  id: string;
  name: string;
  packageCode: string | null;
  stationType: string | null;
  isActive: boolean;
}

interface PackagingTypesResponse {
  packagingTypes: PackagingType[];
}

interface UncategorizedProduct {
  sku: string;
  description: string | null;
  productTitle: string | null;
  imageUrl: string | null;
  inSkuvaultCatalog: boolean;
  shipmentCount: number;
}

interface UncategorizedResponse {
  uncategorizedProducts: UncategorizedProduct[];
  stats: {
    categorizedProducts: number;
    totalProducts: number;
    totalShipments: number;
    shipmentsComplete: number;
    shipmentsPending: number;
    oldestOrderDate: string | null;
  };
}

interface Collection {
  id: string;
  name: string;
  description: string | null;
}

interface CollectionsResponse {
  collections: Collection[];
}

interface SessionPreview {
  stationType: string;
  stationName: string | null;
  orderCount: number;
  fingerprintGroups: { fingerprintId: string | null; count: number }[];
}

interface SessionPreviewResponse {
  success: boolean;
  preview: SessionPreview[];
  totalOrders: number;
}

interface BuildSessionsResult {
  success: boolean;
  sessionsCreated: number;
  shipmentsAssigned: number;
  errors: string[];
  sessions?: Array<{
    id: string;
    name: string;
    stationType: string;
    orderCount: number;
  }>;
}

interface FulfillmentSession {
  id: string;
  name: string | null;
  sequenceNumber: number | null;
  stationId: string | null;
  stationType: string;
  stationName: string | null;
  totalWeightOz: number | null;
  orderCount: number;
  maxOrders: number;
  status: 'draft' | 'ready' | 'picking' | 'packing' | 'completed' | 'cancelled';
  packedCount: number; // Number of orders that have been packed
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  pickingStartedAt: string | null;
  packingStartedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
}

interface SessionShipmentItem {
  sku: string | null;
  name: string;
  quantity: number;
  imageUrl: string | null;
  weightValue: number | null;
  weightUnit: string | null;
}

interface SessionShipment {
  id: string;
  orderNumber: string;
  fingerprintId: string | null;
  trackingNumber: string | null;
  lifecyclePhase: string | null;
  totalWeightOz: number | null;
  items: SessionShipmentItem[];
}

interface SessionDetailResponse extends FulfillmentSession {
  shipments: SessionShipment[];
}

interface FingerprintProduct {
  sku: string;
  title: string | null;
  weight: string | null;
  orderNumbers: string[];
}

interface FingerprintShipmentsResponse {
  fingerprint: {
    id: string;
    displayName: string | null;
    signature: string;
  };
  products: FingerprintProduct[];
  totalShipments: number;
  uniqueProducts: number;
}

interface SkuShipment {
  id: string;
  orderNumber: string;
  orderDate: string;
  shipmentStatus: string | null;
  fingerprintStatus: string | null;
}

interface SkuShipmentsResponse {
  sku: string;
  shipments: SkuShipment[];
  totalCount: number;
}

interface ReadyToSessionOrder {
  orderNumber: string;
  readyToSession: boolean;
  reason: string;
}

interface ReadyToSessionOrdersResponse {
  orders: ReadyToSessionOrder[];
  stats: {
    total: number;
    ready: number;
    notReady: number;
  };
}

function getStationBadge(stationType: string | null) {
  switch (stationType) {
    case 'boxing_machine':
      return <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Boxing Machine</Badge>;
    case 'poly_bag':
      return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Poly Bag</Badge>;
    case 'hand_pack':
      return <Badge variant="secondary" className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">Hand Pack</Badge>;
    default:
      return null;
  }
}

function getStationTypeLabel(stationType: string): string {
  switch (stationType) {
    case 'boxing_machine': return 'Boxing Machine';
    case 'poly_bag': return 'Poly Bag';
    case 'hand_pack': return 'Hand Pack';
    default: return stationType;
  }
}

type InlineStatus = { type: 'loading' } | { type: 'success'; message: string } | { type: 'error'; message: string };
type FilterOption = 'all' | 'needs-mapping' | 'mapped';
type WorkflowTab = 'categorize' | 'packaging' | 'sessions' | 'live';

const VALID_TABS: WorkflowTab[] = ['categorize', 'packaging', 'sessions', 'live'];
const VALID_SUB_TABS: FilterOption[] = ['all', 'needs-mapping', 'mapped'];

export default function Fingerprints() {
  const { toast } = useToast();
  const params = useParams<{ tab?: string; subTab?: string }>();
  const [, navigate] = useLocation();
  
  // Derive activeTab from URL params with validation
  const activeTab: WorkflowTab = VALID_TABS.includes(params.tab as WorkflowTab) 
    ? (params.tab as WorkflowTab) 
    : 'categorize';
  
  // Derive filter from URL params (only relevant for packaging tab)
  const filter: FilterOption = activeTab === 'packaging' && VALID_SUB_TABS.includes(params.subTab as FilterOption)
    ? (params.subTab as FilterOption)
    : 'all';
  
  // Navigation helpers
  const setActiveTab = (tab: WorkflowTab) => {
    if (tab === 'packaging') {
      navigate(`/fulfillment-prep/${tab}/all`);
    } else {
      navigate(`/fulfillment-prep/${tab}`);
    }
  };
  
  const setFilter = (subTab: FilterOption) => {
    navigate(`/fulfillment-prep/packaging/${subTab}`);
  };
  
  const [inlineStatus, setInlineStatus] = useState<Record<string, InlineStatus>>({});
  const [showPackagingSection, setShowPackagingSection] = useState(false);
  const [showCreatePackagingDialog, setShowCreatePackagingDialog] = useState(false);
  const [editingPackaging, setEditingPackaging] = useState<PackagingType | null>(null);
  const [packagingForm, setPackagingForm] = useState({
    name: "",
    stationType: "",
  });
  const [lastBuildResult, setLastBuildResult] = useState<BuildSessionsResult | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [sessionDetails, setSessionDetails] = useState<Record<string, SessionDetailResponse>>({});
  const [sessionToDelete, setSessionToDelete] = useState<FulfillmentSession | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<UncategorizedProduct | null>(null);
  const [selectedFingerprintForShipments, setSelectedFingerprintForShipments] = useState<string | null>(null);
  const [selectedSkuForShipments, setSelectedSkuForShipments] = useState<string | null>(null);
  
  // Weight filter and bulk selection state for packaging tab
  const [minWeight, setMinWeight] = useState<string>("");
  const [maxWeight, setMaxWeight] = useState<string>("");
  const [selectedFingerprintIds, setSelectedFingerprintIds] = useState<Set<string>>(new Set());
  const [bulkPackagingTypeId, setBulkPackagingTypeId] = useState<string>("");
  
  // Session selection state for bulk release
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timeouts: NodeJS.Timeout[] = [];
    Object.entries(inlineStatus).forEach(([id, status]) => {
      if (status.type === 'success' || status.type === 'error') {
        const timeout = setTimeout(() => {
          setInlineStatus(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
        }, 2500);
        timeouts.push(timeout);
      }
    });
    return () => timeouts.forEach(clearTimeout);
  }, [inlineStatus]);

  // Fingerprint stats only (lightweight - for summary cards)
  const { data: fingerprintStatsData } = useQuery<{ total: number; assigned: number; needsDecision: number }>({
    queryKey: ["/api/fingerprints/stats"],
  });

  // Fingerprints data (heavy - lazy loaded for packaging tab only)
  const {
    data: fingerprintsData,
    isLoading: fingerprintsLoading,
    refetch: refetchFingerprints,
  } = useQuery<FingerprintsResponse>({
    queryKey: ["/api/fingerprints"],
    enabled: activeTab === 'packaging',
  });

  // Packaging types (needed for packaging tab and categorize dropdowns)
  const { data: packagingTypesData } = useQuery<PackagingTypesResponse>({
    queryKey: ["/api/packaging-types"],
    enabled: activeTab === 'packaging' || activeTab === 'categorize',
  });

  // Uncategorized products count (lightweight - for summary cards)
  const { data: uncategorizedCountData } = useQuery<{ count: number }>({
    queryKey: ["/api/packing-decisions/uncategorized/count"],
  });

  // Uncategorized products (heavy - lazy loaded for categorize tab only)
  const {
    data: uncategorizedData,
    isLoading: uncategorizedLoading,
    refetch: refetchUncategorized,
  } = useQuery<UncategorizedResponse>({
    queryKey: ["/api/packing-decisions/uncategorized"],
    enabled: activeTab === 'categorize',
  });

  // Collections for categorization (lazy loaded for categorize tab only)
  const { data: collectionsData } = useQuery<CollectionsResponse>({
    queryKey: ["/api/collections"],
    enabled: activeTab === 'categorize',
  });

  // Fingerprint shipments (for shipment count modal)
  const { data: fingerprintShipmentsData, isLoading: fingerprintShipmentsLoading } = useQuery<FingerprintShipmentsResponse>({
    queryKey: ["/api/fingerprints", selectedFingerprintForShipments, "shipments"],
    enabled: !!selectedFingerprintForShipments,
  });

  // SKU shipments (for uncategorized product shipment count modal)
  const { data: skuShipmentsData, isLoading: skuShipmentsLoading } = useQuery<SkuShipmentsResponse>({
    queryKey: ["/api/uncategorized-products", selectedSkuForShipments, "shipments"],
    enabled: !!selectedSkuForShipments,
  });

  // Session preview (lazy loaded - only fetch when sessions tab is active)
  const {
    data: sessionPreviewData,
    isLoading: sessionPreviewLoading,
    refetch: refetchSessionPreview,
  } = useQuery<SessionPreviewResponse>({
    queryKey: ["/api/fulfillment-sessions/preview"],
    enabled: activeTab === 'sessions',
  });

  // Live sessions (active sessions not yet completed)
  const {
    data: liveSessionsData,
    isLoading: liveSessionsLoading,
    refetch: refetchLiveSessions,
  } = useQuery<FulfillmentSession[]>({
    queryKey: ["/api/fulfillment-sessions"],
  });

  // Ready-to-session orders (for Build Sessions tab table)
  // Lazy loaded - only fetch when Build tab is active
  const {
    data: readyToSessionOrdersData,
    isLoading: readyToSessionOrdersLoading,
    refetch: refetchReadyToSessionOrders,
  } = useQuery<ReadyToSessionOrdersResponse>({
    queryKey: ["/api/fulfillment-sessions/ready-to-session-orders"],
    enabled: activeTab === 'sessions',
  });

  // Mutations
  const assignMutation = useMutation({
    mutationFn: async ({
      fingerprintId,
      packagingTypeId,
    }: {
      fingerprintId: string;
      packagingTypeId: string;
    }) => {
      setInlineStatus(prev => ({ ...prev, [fingerprintId]: { type: 'loading' } }));
      const res = await apiRequest("POST", `/api/fingerprints/${fingerprintId}/assign`, {
        packagingTypeId,
      });
      return { ...(await res.json()), fingerprintId };
    },
    onSuccess: (result) => {
      setInlineStatus(prev => ({
        ...prev,
        [result.fingerprintId]: { type: 'success', message: `${result.shipmentsUpdated} updated` }
      }));
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/ready-to-session-orders"] });
    },
    onError: (error: Error, variables) => {
      setInlineStatus(prev => ({
        ...prev,
        [variables.fingerprintId]: { type: 'error', message: 'Failed' }
      }));
    },
  });

  const categorizeMutation = useMutation({
    mutationFn: async ({ sku, collectionId }: { sku: string; collectionId: string }) => {
      setInlineStatus(prev => ({ ...prev, [`cat-${sku}`]: { type: 'loading' } }));
      const res = await apiRequest("POST", "/api/packing-decisions/categorize", {
        sku,
        collectionId,
      });
      return { ...(await res.json()), sku };
    },
    onSuccess: (result) => {
      setInlineStatus(prev => ({
        ...prev,
        [`cat-${result.sku}`]: { type: 'success', message: 'Categorized' }
      }));
      queryClient.invalidateQueries({ queryKey: ["/api/packing-decisions/uncategorized"] });
      queryClient.invalidateQueries({ queryKey: ["/api/packing-decisions/uncategorized/count"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/ready-to-session-orders"] });
    },
    onError: (error: Error, variables) => {
      setInlineStatus(prev => ({
        ...prev,
        [`cat-${variables.sku}`]: { type: 'error', message: 'Failed' }
      }));
    },
  });

  const buildSessionsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/fulfillment-sessions/build", {});
      return res.json() as Promise<BuildSessionsResult>;
    },
    onSuccess: (result) => {
      if (result.success) {
        setLastBuildResult(result);
        toast({
          title: "Sessions Created",
          description: `Created ${result.sessionsCreated} sessions with ${result.shipmentsAssigned} orders`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/preview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/ready-to-session-orders"] });
        setActiveTab('live');
      } else {
        toast({
          title: "Failed to build sessions",
          description: result.errors.join(", "),
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error building sessions",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createPackagingMutation = useMutation({
    mutationFn: async (data: { name: string; stationType: string }) => {
      const res = await apiRequest("POST", "/api/packaging-types", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Packaging type created" });
      queryClient.invalidateQueries({ queryKey: ["/api/packaging-types"] });
      setShowCreatePackagingDialog(false);
      setPackagingForm({ name: "", stationType: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create", description: error.message, variant: "destructive" });
    },
  });

  const updatePackagingMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; stationType?: string } }) => {
      const res = await apiRequest("PATCH", `/api/packaging-types/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Packaging type updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/packaging-types"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints/stats"] });
      setEditingPackaging(null);
      setPackagingForm({ name: "", stationType: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("DELETE", `/api/fulfillment-sessions/${sessionId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Session deleted", description: "Orders have been released back to the queue" });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/preview"] });
      setSessionToDelete(null);
      setExpandedSessions(new Set());
      setSessionDetails({});
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete session", description: error.message, variant: "destructive" });
    },
  });

  // Release session to floor (draft -> ready)
  const releaseSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("PATCH", `/api/fulfillment-sessions/${sessionId}/status`, { status: 'ready' });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Session released", description: "Session is now ready for picking" });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to release session", description: error.message, variant: "destructive" });
    },
  });

  // Bulk release sessions to floor
  const bulkReleaseSessionsMutation = useMutation({
    mutationFn: async (sessionIds: string[]) => {
      const res = await apiRequest("POST", "/api/fulfillment-sessions/bulk-status", { 
        sessionIds, 
        status: 'ready' 
      });
      return res.json();
    },
    onSuccess: (result) => {
      toast({ 
        title: "Sessions released", 
        description: `${result.updated} session${result.updated !== 1 ? 's' : ''} released to floor` 
      });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions"] });
      setSelectedSessionIds(new Set());
    },
    onError: (error: Error) => {
      toast({ title: "Failed to release sessions", description: error.message, variant: "destructive" });
    },
  });

  // Bulk complete sessions (mark as on the dock)
  const bulkCompleteSessionsMutation = useMutation({
    mutationFn: async (sessionIds: string[]) => {
      const res = await apiRequest("POST", "/api/fulfillment-sessions/bulk-status", { 
        sessionIds, 
        status: 'completed' 
      });
      return res.json();
    },
    onSuccess: (result) => {
      toast({ 
        title: "Sessions completed", 
        description: `${result.updated} session${result.updated !== 1 ? 's' : ''} marked as on the dock` 
      });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to complete sessions", description: error.message, variant: "destructive" });
    },
  });

  // Bulk assign mutation for packaging tab
  const bulkAssignMutation = useMutation({
    mutationFn: async ({ fingerprintIds, packagingTypeId }: { fingerprintIds: string[]; packagingTypeId: string }) => {
      const res = await apiRequest("POST", "/api/fingerprints/bulk-assign", {
        fingerprintIds,
        packagingTypeId,
      });
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Bulk assignment complete",
        description: `Assigned ${result.packagingTypeName} to ${result.fingerprintsAssigned} fingerprints (${result.shipmentsUpdated} shipments updated)`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/fulfillment-sessions/ready-to-session-orders"] });
      setSelectedFingerprintIds(new Set());
      setBulkPackagingTypeId("");
    },
    onError: (error: Error) => {
      toast({
        title: "Bulk assignment failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const fingerprints = fingerprintsData?.fingerprints || [];
  // Use lightweight stats for summary cards, fall back to full data stats when available
  const stats = fingerprintStatsData || fingerprintsData?.stats;
  const packagingTypes = packagingTypesData?.packagingTypes || [];
  const uncategorizedProducts = uncategorizedData?.uncategorizedProducts || [];
  // Use lightweight count for summary cards, fall back to full data length when available
  const uncategorizedCount = uncategorizedCountData?.count ?? uncategorizedProducts.length;
  const collections = collectionsData?.collections || [];
  const sessionPreview = sessionPreviewData?.preview || [];
  const totalSessionableOrders = sessionPreviewData?.totalOrders || 0;
  const liveSessions = (liveSessionsData || []).filter(
    s => s.status !== 'completed' && s.status !== 'cancelled'
  );

  // Apply both status filter and weight filters
  const filteredFingerprints = fingerprints.filter((fp) => {
    // Status filter
    if (filter === 'needs-mapping' && fp.hasPackaging) return false;
    if (filter === 'mapped' && !fp.hasPackaging) return false;
    
    // Weight filters (only apply if values are set)
    const fpWeight = fp.totalWeight ?? 0;
    const minW = minWeight ? parseFloat(minWeight) : null;
    const maxW = maxWeight ? parseFloat(maxWeight) : null;
    
    if (minW !== null && !isNaN(minW) && fpWeight < minW) return false;
    if (maxW !== null && !isNaN(maxW) && fpWeight > maxW) return false;
    
    return true;
  });
  
  // Helper functions for bulk selection
  const toggleSelection = (id: string) => {
    setSelectedFingerprintIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  
  const selectAllVisible = () => {
    const needsMappingIds = filteredFingerprints
      .filter(fp => !fp.hasPackaging)
      .map(fp => fp.id);
    setSelectedFingerprintIds(new Set(needsMappingIds));
  };
  
  const clearSelection = () => {
    setSelectedFingerprintIds(new Set());
  };
  
  const handleBulkAssign = () => {
    if (selectedFingerprintIds.size === 0 || !bulkPackagingTypeId) return;
    bulkAssignMutation.mutate({
      fingerprintIds: Array.from(selectedFingerprintIds),
      packagingTypeId: bulkPackagingTypeId,
    });
  };

  const assignedPercent = stats
    ? Math.round((stats.assigned / Math.max(stats.total, 1)) * 100)
    : 0;

  const handleAssign = (fingerprintId: string, packagingTypeId: string) => {
    assignMutation.mutate({ fingerprintId, packagingTypeId });
  };

  const handleCategorize = (sku: string, collectionId: string) => {
    categorizeMutation.mutate({ sku, collectionId });
  };

  const getStatusIndicator = (id: string) => {
    const status = inlineStatus[id];
    if (!status) return null;
    
    switch (status.type) {
      case 'loading':
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case 'success':
        return (
          <span className="flex items-center gap-1 text-green-600 text-sm animate-in fade-in">
            <Check className="h-4 w-4" />
            {status.message}
          </span>
        );
      case 'error':
        return (
          <span className="flex items-center gap-1 text-red-600 text-sm animate-in fade-in">
            <X className="h-4 w-4" />
            {status.message}
          </span>
        );
    }
  };

  const handleRefreshAll = () => {
    refetchUncategorized();
    refetchFingerprints();
    refetchSessionPreview();
    refetchLiveSessions();
  };

  const toggleSessionExpand = async (sessionId: string) => {
    const newExpanded = new Set(expandedSessions);
    if (newExpanded.has(sessionId)) {
      newExpanded.delete(sessionId);
    } else {
      newExpanded.add(sessionId);
      // Fetch session details if not already loaded
      if (!sessionDetails[sessionId]) {
        try {
          const res = await fetch(`/api/fulfillment-sessions/${sessionId}`, {
            credentials: 'include',
          });
          if (res.ok) {
            const data = await res.json();
            setSessionDetails(prev => ({ ...prev, [sessionId]: data }));
          }
        } catch (error) {
          console.error('Failed to fetch session details:', error);
        }
      }
    }
    setExpandedSessions(newExpanded);
  };

  const getLifecycleBadge = (phase: string | null) => {
    switch (phase) {
      case 'picked':
        return <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">Picked</Badge>;
      case 'packed':
        return <Badge variant="outline" className="text-xs bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300">Packed</Badge>;
      case 'labelled':
        return <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">Labelled</Badge>;
      default:
        return <Badge variant="outline" className="text-xs">Pending</Badge>;
    }
  };

  const isLoading = fingerprintsLoading || uncategorizedLoading || sessionPreviewLoading || liveSessionsLoading;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Fulfillment Prep
          </h1>
          <p className="text-muted-foreground">
            Prepare orders for picking: categorize products, assign packaging, and build sessions
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefreshAll}
          data-testid="button-refresh"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card 
          className={`cursor-pointer transition-all ${activeTab === 'categorize' ? 'ring-2 ring-primary' : 'hover-elevate'}`}
          onClick={() => setActiveTab('categorize')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Tag className="h-4 w-4" />
              Step 1: Categorize
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-2xl font-bold ${uncategorizedCount > 0 ? 'text-amber-600' : 'text-green-600'}`}
                data-testid="text-uncategorized-count"
              >
                {uncategorizedCount}
              </span>
              <span className="text-sm text-muted-foreground">
                {uncategorizedCount === 0 ? 'all categorized' : 'need categories'}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card 
          className={`cursor-pointer transition-all ${activeTab === 'packaging' ? 'ring-2 ring-primary' : 'hover-elevate'}`}
          onClick={() => setActiveTab('packaging')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Package className="h-4 w-4" />
              Step 2: Packaging
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-2xl font-bold ${(stats?.needsDecision || 0) > 0 ? 'text-amber-600' : 'text-green-600'}`}
                data-testid="text-needs-packaging"
              >
                {stats?.needsDecision || 0}
              </span>
              <span className="text-sm text-muted-foreground">
                {(stats?.needsDecision || 0) === 0 ? 'all assigned' : 'need packaging'}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card 
          className={`cursor-pointer transition-all ${activeTab === 'sessions' ? 'ring-2 ring-primary' : 'hover-elevate'}`}
          onClick={() => setActiveTab('sessions')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ListPlus className="h-4 w-4" />
              Step 3: Build
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-2xl font-bold ${totalSessionableOrders > 0 ? 'text-blue-600' : 'text-muted-foreground'}`}
                data-testid="text-sessionable-count"
              >
                {totalSessionableOrders}
              </span>
              <span className="text-sm text-muted-foreground">
                ready to session
              </span>
            </div>
          </CardContent>
        </Card>

        <Card 
          className={`cursor-pointer transition-all ${activeTab === 'live' ? 'ring-2 ring-primary' : 'hover-elevate'}`}
          onClick={() => setActiveTab('live')}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Eye className="h-4 w-4" />
              Live Sessions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-2xl font-bold ${liveSessions.length > 0 ? 'text-green-600' : 'text-muted-foreground'}`}
                data-testid="text-live-sessions-count"
              >
                {liveSessions.length}
              </span>
              <span className="text-sm text-muted-foreground">
                active sessions
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Workflow Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WorkflowTab)}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="categorize" className="flex items-center gap-2" data-testid="tab-categorize">
            <Tag className="h-4 w-4" />
            Categorize
            {uncategorizedCount > 0 && (
              <Badge variant="secondary" className="ml-1 bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                {uncategorizedCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="packaging" className="flex items-center gap-2" data-testid="tab-packaging">
            <Package className="h-4 w-4" />
            Packaging
            {(stats?.needsDecision || 0) > 0 && (
              <Badge variant="secondary" className="ml-1 bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                {stats?.needsDecision}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="sessions" className="flex items-center gap-2" data-testid="tab-sessions">
            <ListPlus className="h-4 w-4" />
            Build
            {totalSessionableOrders > 0 && (
              <Badge variant="secondary" className="ml-1 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                {totalSessionableOrders}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="live" className="flex items-center gap-2" data-testid="tab-live">
            <Eye className="h-4 w-4" />
            Live
            {liveSessions.length > 0 && (
              <Badge variant="secondary" className="ml-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                {liveSessions.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Categorize SKUs Tab */}
        <TabsContent value="categorize" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Tag className="h-5 w-5" />
                Uncategorized Products
              </CardTitle>
              <CardDescription>
                Assign products to collections so fingerprints can be calculated
              </CardDescription>
            </CardHeader>
            <CardContent>
              {uncategorizedProducts.length === 0 ? (
                <div className="text-center py-12">
                  <CheckCircle2 className="h-12 w-12 mx-auto text-green-500 mb-4" />
                  <h3 className="text-lg font-semibold mb-2">All Products Categorized</h3>
                  <p className="text-muted-foreground">
                    No products need categorization. Fingerprints can be calculated.
                  </p>
                </div>
              ) : (
                <ScrollArea className="h-[600px]">
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {uncategorizedProducts.map((product, index) => (
                      <div
                        key={`${product.sku}-${index}`}
                        className="flex flex-col p-4 rounded-lg border bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
                        data-testid={`row-uncategorized-${product.sku}`}
                      >
                        <div className="flex gap-4 mb-3">
                          <div className="flex-shrink-0 w-24 h-24 rounded-md bg-muted overflow-hidden border">
                            {product.imageUrl ? (
                              <img
                                src={product.imageUrl}
                                alt={product.productTitle || product.sku}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement;
                                  target.style.display = 'none';
                                  target.nextElementSibling?.classList.remove('hidden');
                                }}
                              />
                            ) : null}
                            <div className={`w-full h-full flex items-center justify-center ${product.imageUrl ? 'hidden' : ''}`}>
                              <Package className="h-10 w-10 text-muted-foreground" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-sm leading-snug">
                              {product.description || product.productTitle || 'Unknown Product'}
                            </h4>
                            <p className="font-mono text-xs text-muted-foreground mt-1">{product.sku}</p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <Badge 
                                variant="secondary" 
                                className="text-xs cursor-pointer hover-elevate"
                                onClick={() => setSelectedSkuForShipments(product.sku)}
                                data-testid={`badge-shipments-${product.sku}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                {product.shipmentCount} shipment{product.shipmentCount !== 1 ? 's' : ''}
                              </Badge>
                              {!product.inSkuvaultCatalog && (
                                <Badge variant="destructive" className="text-xs" data-testid={`badge-not-in-catalog-${product.sku}`}>
                                  Not in Catalog
                                </Badge>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setSelectedProduct(product)}
                                data-testid={`button-view-${product.sku}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                View
                              </Button>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 mt-auto">
                          {getStatusIndicator(`cat-${product.sku}`)}
                          {product.inSkuvaultCatalog ? (
                            <Select
                              onValueChange={(value) => handleCategorize(product.sku, value)}
                              disabled={!!inlineStatus[`cat-${product.sku}`]}
                            >
                              <SelectTrigger
                                className="w-full"
                                data-testid={`select-collection-${product.sku}`}
                              >
                                <SelectValue placeholder="Assign to collection..." />
                              </SelectTrigger>
                              <SelectContent>
                                {collections.map((col) => (
                                  <SelectItem
                                    key={col.id}
                                    value={col.id}
                                    data-testid={`option-collection-${col.id}`}
                                  >
                                    {col.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">
                              Cannot assign — product missing from SkuVault catalog
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {/* Product Details Modal */}
              <Dialog open={!!selectedProduct} onOpenChange={(open) => !open && setSelectedProduct(null)}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Product Details</DialogTitle>
                    <DialogDescription>
                      Review product information before assigning to a collection
                    </DialogDescription>
                  </DialogHeader>
                  {selectedProduct && (
                    <div className="space-y-4">
                      <div className="flex justify-center">
                        <div className="w-48 h-48 rounded-lg bg-muted overflow-hidden border">
                          {selectedProduct.imageUrl ? (
                            <img
                              src={selectedProduct.imageUrl}
                              alt={selectedProduct.productTitle || selectedProduct.sku}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Package className="h-16 w-16 text-muted-foreground" />
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="space-y-3">
                        <div>
                          <Label className="text-xs text-muted-foreground">Product Name</Label>
                          <p className="font-medium">
                            {selectedProduct.description || selectedProduct.productTitle || 'Unknown Product'}
                          </p>
                        </div>
                        
                        <div>
                          <Label className="text-xs text-muted-foreground">SKU</Label>
                          <p className="font-mono text-sm">{selectedProduct.sku}</p>
                        </div>
                        
                        {selectedProduct.productTitle && selectedProduct.productTitle !== selectedProduct.description && (
                          <div>
                            <Label className="text-xs text-muted-foreground">Variant</Label>
                            <p className="text-sm">{selectedProduct.productTitle}</p>
                          </div>
                        )}
                        
                        <div>
                          <Label className="text-xs text-muted-foreground">Affected Shipments</Label>
                          <Badge variant="secondary" className="mt-1">
                            <Truck className="h-3 w-3 mr-1" />
                            {selectedProduct.shipmentCount} shipment{selectedProduct.shipmentCount !== 1 ? 's' : ''}
                          </Badge>
                        </div>
                        
                        <div>
                          <Label className="text-xs text-muted-foreground">Catalog Status</Label>
                          {selectedProduct.inSkuvaultCatalog ? (
                            <Badge variant="secondary" className="mt-1">In Catalog</Badge>
                          ) : (
                            <Badge variant="destructive" className="mt-1">Not in Catalog</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <DialogFooter>
                    {selectedProduct?.inSkuvaultCatalog ? (
                      <Select
                        onValueChange={(value) => {
                          if (selectedProduct) {
                            handleCategorize(selectedProduct.sku, value);
                            setSelectedProduct(null);
                          }
                        }}
                        disabled={selectedProduct ? !!inlineStatus[`cat-${selectedProduct.sku}`] : false}
                      >
                        <SelectTrigger className="w-full" data-testid="modal-select-collection">
                          <SelectValue placeholder="Assign to collection..." />
                        </SelectTrigger>
                        <SelectContent>
                          {collections.map((col) => (
                            <SelectItem key={col.id} value={col.id}>
                              {col.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm text-muted-foreground italic text-center w-full">
                        Cannot assign — product missing from SkuVault catalog
                      </p>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Assign Packaging Tab */}
        <TabsContent value="packaging" className="mt-6 space-y-6">
          {fingerprints.length === 0 ? (
            <Card className="p-12 text-center">
              <Layers className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold mb-2">No fingerprints yet</h2>
              <p className="text-muted-foreground">
                Fingerprints are discovered when orders are processed. Make sure all SKUs are categorized first.
              </p>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="h-5 w-5" />
                  Order Patterns
                </CardTitle>
                <CardDescription>
                  Sorted by shipment count - assign packaging to high-volume patterns first
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* Filter bar with status and weight filters */}
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                      <Button
                        variant={filter === 'all' ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setFilter('all')}
                        data-testid="button-filter-all"
                      >
                        All ({fingerprints.length})
                      </Button>
                      <Button
                        variant={filter === 'needs-mapping' ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setFilter('needs-mapping')}
                        className={filter !== 'needs-mapping' ? 'text-amber-600 hover:text-amber-700' : ''}
                        data-testid="button-filter-needs-mapping"
                      >
                        Needs Mapping ({stats?.needsDecision || 0})
                      </Button>
                      <Button
                        variant={filter === 'mapped' ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setFilter('mapped')}
                        className={filter !== 'mapped' ? 'text-green-600 hover:text-green-700' : ''}
                        data-testid="button-filter-mapped"
                      >
                        Mapped ({stats?.assigned || 0})
                      </Button>
                    </div>
                    
                    {/* Weight filter inputs */}
                    <div className="flex items-center gap-2">
                      <Scale className="h-4 w-4 text-muted-foreground" />
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          placeholder="Min oz"
                          value={minWeight}
                          onChange={(e) => setMinWeight(e.target.value)}
                          className="w-24 h-8"
                          data-testid="input-min-weight"
                        />
                        <span className="text-muted-foreground">-</span>
                        <Input
                          type="number"
                          placeholder="Max oz"
                          value={maxWeight}
                          onChange={(e) => setMaxWeight(e.target.value)}
                          className="w-24 h-8"
                          data-testid="input-max-weight"
                        />
                      </div>
                      {(minWeight || maxWeight) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setMinWeight(""); setMaxWeight(""); }}
                          className="h-8 px-2"
                          data-testid="button-clear-weight-filter"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                  
                  <span className="text-sm text-muted-foreground">
                    Showing {filteredFingerprints.length} of {fingerprints.length}
                  </span>
                </div>
                
                {/* Bulk action bar - appears when items are selected */}
                {selectedFingerprintIds.size > 0 && (
                  <div className="flex items-center justify-between gap-4 p-3 mb-4 bg-primary/10 border border-primary/20 rounded-lg">
                    <div className="flex items-center gap-3">
                      <CheckSquare className="h-4 w-4 text-primary" />
                      <span className="font-medium">
                        {selectedFingerprintIds.size} fingerprint{selectedFingerprintIds.size !== 1 ? 's' : ''} selected
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={clearSelection}
                        className="h-7"
                        data-testid="button-clear-selection"
                      >
                        Clear
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={bulkPackagingTypeId}
                        onValueChange={setBulkPackagingTypeId}
                      >
                        <SelectTrigger className="w-[180px]" data-testid="select-bulk-packaging">
                          <SelectValue placeholder="Select packaging..." />
                        </SelectTrigger>
                        <SelectContent>
                          {packagingTypes.map((pt) => (
                            <SelectItem key={pt.id} value={pt.id}>
                              {pt.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={handleBulkAssign}
                        disabled={!bulkPackagingTypeId || bulkAssignMutation.isPending}
                        data-testid="button-bulk-assign"
                      >
                        {bulkAssignMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Box className="h-4 w-4 mr-2" />
                        )}
                        Assign to Selected
                      </Button>
                    </div>
                  </div>
                )}
                
                {/* Select all visible needs-mapping checkbox */}
                {filteredFingerprints.filter(fp => !fp.hasPackaging).length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <Checkbox
                      id="select-all-visible"
                      checked={
                        filteredFingerprints.filter(fp => !fp.hasPackaging).every(fp => selectedFingerprintIds.has(fp.id)) &&
                        filteredFingerprints.filter(fp => !fp.hasPackaging).length > 0
                      }
                      onCheckedChange={(checked) => {
                        if (checked) {
                          selectAllVisible();
                        } else {
                          clearSelection();
                        }
                      }}
                      data-testid="checkbox-select-all"
                    />
                    <Label htmlFor="select-all-visible" className="text-sm text-muted-foreground cursor-pointer">
                      Select all {filteredFingerprints.filter(fp => !fp.hasPackaging).length} unassigned fingerprints
                    </Label>
                  </div>
                )}
                
                <ScrollArea className="h-[400px]">
                  <div className="space-y-2">
                    {filteredFingerprints.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        No fingerprints match this filter
                      </div>
                    ) : null}
                    {filteredFingerprints.map((fingerprint) => (
                      <div
                        key={fingerprint.id}
                        className={`flex items-center gap-4 p-4 rounded-lg border ${
                          selectedFingerprintIds.has(fingerprint.id)
                            ? "bg-primary/5 border-primary/30"
                            : fingerprint.hasPackaging
                            ? "bg-card border-border"
                            : "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
                        }`}
                        data-testid={`row-fingerprint-${fingerprint.id}`}
                      >
                        {/* Checkbox for bulk selection (only for needs-mapping) */}
                        {!fingerprint.hasPackaging && (
                          <Checkbox
                            checked={selectedFingerprintIds.has(fingerprint.id)}
                            onCheckedChange={() => toggleSelection(fingerprint.id)}
                            data-testid={`checkbox-fingerprint-${fingerprint.id}`}
                          />
                        )}
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {fingerprint.hasPackaging ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                            ) : (
                              <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                            )}
                            <span
                              className="font-medium"
                              data-testid={`text-fingerprint-name-${fingerprint.id}`}
                            >
                              {fingerprint.humanReadableName}
                            </span>
                            {fingerprint.hasPackaging && getStationBadge(fingerprint.stationType)}
                          </div>
                          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Package className="h-3 w-3" />
                              {fingerprint.totalItems} items
                            </span>
                            <span className="flex items-center gap-1">
                              <Layers className="h-3 w-3" />
                              {fingerprint.collectionCount} collection{fingerprint.collectionCount !== 1 ? 's' : ''}
                            </span>
                            {fingerprint.totalWeight !== null && fingerprint.totalWeight > 0 ? (
                              <span className="flex items-center gap-1">
                                <Scale className="h-3 w-3" />
                                {fingerprint.totalWeight.toFixed(1)} oz
                              </span>
                            ) : (
                              <Badge variant="destructive" className="text-xs">
                                Missing Weight
                              </Badge>
                            )}
                          </div>
                        </div>

                        <Badge
                          variant={fingerprint.hasPackaging ? "secondary" : "default"}
                          className="flex-shrink-0 cursor-pointer hover-elevate"
                          onClick={() => setSelectedFingerprintForShipments(fingerprint.id)}
                          data-testid={`badge-shipments-${fingerprint.id}`}
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          {fingerprint.shipmentCount} shipment{fingerprint.shipmentCount !== 1 ? 's' : ''}
                        </Badge>

                        <div className="flex items-center gap-2 flex-shrink-0 min-w-[280px] justify-end">
                          {getStatusIndicator(fingerprint.id)}
                          {fingerprint.hasPackaging ? (
                            <div className="flex items-center gap-2">
                              <Box className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-medium">
                                {fingerprint.packagingTypeName}
                              </span>
                              <Select
                                onValueChange={(value) => handleAssign(fingerprint.id, value)}
                                disabled={!!inlineStatus[fingerprint.id]}
                              >
                                <SelectTrigger
                                  className="w-[140px]"
                                  data-testid={`select-change-${fingerprint.id}`}
                                >
                                  <SelectValue placeholder="Change..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {packagingTypes.map((pt) => (
                                    <SelectItem
                                      key={pt.id}
                                      value={pt.id}
                                      data-testid={`option-packaging-${pt.id}`}
                                    >
                                      {pt.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <Select
                              onValueChange={(value) => handleAssign(fingerprint.id, value)}
                              disabled={!!inlineStatus[fingerprint.id]}
                            >
                              <SelectTrigger
                                className="w-[220px]"
                                data-testid={`select-packaging-${fingerprint.id}`}
                              >
                                <SelectValue placeholder="Assign packaging..." />
                              </SelectTrigger>
                              <SelectContent>
                                {packagingTypes.map((pt) => (
                                  <SelectItem
                                    key={pt.id}
                                    value={pt.id}
                                    data-testid={`option-packaging-${pt.id}`}
                                  >
                                    {pt.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}

          {/* Manage Packaging Types */}
          <Collapsible open={showPackagingSection} onOpenChange={setShowPackagingSection}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover-elevate">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Settings className="h-5 w-5" />
                      <CardTitle>Manage Packaging Types</CardTitle>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${showPackagingSection ? 'rotate-180' : ''}`} />
                  </div>
                  <CardDescription>
                    Define packaging options and their station routing
                  </CardDescription>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <div className="flex justify-end mb-4">
                    <Button
                      size="sm"
                      onClick={() => {
                        setPackagingForm({ name: "", stationType: "" });
                        setShowCreatePackagingDialog(true);
                      }}
                      data-testid="button-add-packaging"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Packaging Type
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {packagingTypes.map((pt) => (
                      <div
                        key={pt.id}
                        className="flex items-center justify-between p-3 rounded-lg border bg-card"
                        data-testid={`row-packaging-${pt.id}`}
                      >
                        <div className="flex items-center gap-3">
                          <Box className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{pt.name}</span>
                          {getStationBadge(pt.stationType)}
                          {!pt.stationType && (
                            <Badge variant="outline" className="text-amber-600 border-amber-300">
                              No station assigned
                            </Badge>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingPackaging(pt);
                            setPackagingForm({
                              name: pt.name,
                              stationType: pt.stationType || "",
                            });
                          }}
                          data-testid={`button-edit-packaging-${pt.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    {packagingTypes.length === 0 && (
                      <p className="text-center text-muted-foreground py-8">
                        No packaging types defined yet. Add one to get started.
                      </p>
                    )}
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>

        {/* Build Sessions Tab */}
        <TabsContent value="sessions" className="mt-6 space-y-6">
          {/* Ready to Session Orders Table */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="h-5 w-5" />
                    Orders Ready to Session
                  </CardTitle>
                  <CardDescription>
                    All orders waiting to be assigned to a picking session
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {readyToSessionOrdersData?.stats && (
                    <div className="flex items-center gap-3 text-sm">
                      <Badge variant="default" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                        {readyToSessionOrdersData.stats.ready} Ready
                      </Badge>
                      <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        {readyToSessionOrdersData.stats.notReady} Not Ready
                      </Badge>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchReadyToSessionOrders()}
                    data-testid="button-refresh-ready-to-session"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {readyToSessionOrdersLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map(i => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !readyToSessionOrdersData?.orders.length ? (
                <div className="text-center py-8 text-muted-foreground">
                  No orders in the ready-to-session phase
                </div>
              ) : (
                <ScrollArea className="h-[400px]">
                  <table className="w-full">
                    <thead className="sticky top-0 z-10 bg-card border-b shadow-sm">
                      <tr>
                        <th className="text-left py-3 px-3 font-medium text-sm bg-card">Order Number</th>
                        <th className="text-center py-3 px-3 font-medium text-sm bg-card">Ready to Session</th>
                        <th className="text-left py-3 px-3 font-medium text-sm bg-card">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {readyToSessionOrdersData.orders.map((order) => (
                        <tr 
                          key={order.orderNumber} 
                          className="border-b last:border-0 hover-elevate"
                          data-testid={`row-order-${order.orderNumber}`}
                        >
                          <td className="py-2 px-3 font-mono text-sm">
                            {order.orderNumber}
                          </td>
                          <td className="py-2 px-3 text-center">
                            {order.readyToSession ? (
                              <CheckCircle2 className="h-5 w-5 text-green-600 mx-auto" />
                            ) : (
                              <AlertCircle className="h-5 w-5 text-amber-500 mx-auto" />
                            )}
                          </td>
                          <td className="py-2 px-3 text-sm">
                            <span className={order.readyToSession ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                              {order.reason}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          {/* Session Preview Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <ListPlus className="h-5 w-5" />
                    Session Preview
                  </CardTitle>
                  <CardDescription>
                    Orders ready to be grouped into picking sessions (max 28 per cart)
                  </CardDescription>
                </div>
                {totalSessionableOrders > 0 && (
                  <Button
                    onClick={() => buildSessionsMutation.mutate()}
                    disabled={buildSessionsMutation.isPending}
                    data-testid="button-build-sessions"
                  >
                    {buildSessionsMutation.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Building...
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-2" />
                        Build Sessions
                      </>
                    )}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {totalSessionableOrders > 0 && (
                <div className="mb-6 p-4 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-blue-800 dark:text-blue-200 mb-1">
                        What does "Build Sessions" do?
                      </p>
                      <p className="text-sm text-blue-700 dark:text-blue-300">
                        Clicking Build Sessions will group the orders below into picking carts (max 28 orders each), 
                        sorted by station type and product similarity. Sessions will appear in the Live tab 
                        where you can monitor their progress through picking and packing.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {totalSessionableOrders === 0 ? (
                <div className="text-center py-12">
                  <ListPlus className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Orders Ready for Sessions</h3>
                  <p className="text-muted-foreground">
                    Orders need packaging assigned and station routing before they can be grouped into sessions.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {sessionPreview.map((station) => (
                    <div
                      key={station.stationType}
                      className="p-4 rounded-lg border bg-card"
                      data-testid={`preview-station-${station.stationType}`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          {getStationBadge(station.stationType)}
                          {station.stationName && (
                            <span className="text-sm text-muted-foreground">
                              {station.stationName}
                            </span>
                          )}
                        </div>
                        <Badge variant="default" className="text-lg px-3 py-1">
                          {station.orderCount} orders
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {Math.ceil(station.orderCount / 28)} session{Math.ceil(station.orderCount / 28) !== 1 ? 's' : ''} will be created
                        <span className="mx-2">·</span>
                        {station.fingerprintGroups.length} unique fingerprint{station.fingerprintGroups.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                  ))}

                  <div className="mt-6 p-4 bg-muted rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Total Sessions to Create</span>
                      <span className="text-xl font-bold">
                        {sessionPreview.reduce((sum, s) => sum + Math.ceil(s.orderCount / 28), 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-2 text-sm text-muted-foreground">
                      <span>Total Orders</span>
                      <span>{totalSessionableOrders}</span>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Live Sessions Tab */}
        <TabsContent value="live" className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Eye className="h-5 w-5" />
                    Active Sessions
                  </CardTitle>
                  <CardDescription>
                    Monitor sessions currently being picked or packed
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchLiveSessions()}
                  data-testid="button-refresh-sessions"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {lastBuildResult && (
                <div className="mb-6 p-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <span className="font-medium text-green-800 dark:text-green-200">Sessions Created Successfully</span>
                  </div>
                  <div className="text-sm text-green-700 dark:text-green-300">
                    Created {lastBuildResult.sessionsCreated} session{lastBuildResult.sessionsCreated !== 1 ? 's' : ''} with {lastBuildResult.shipmentsAssigned} order{lastBuildResult.shipmentsAssigned !== 1 ? 's' : ''}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-green-700 hover:text-green-800"
                    onClick={() => setLastBuildResult(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              )}

              {liveSessions.length === 0 ? (
                <div className="text-center py-12">
                  <Eye className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No Active Sessions</h3>
                  <p className="text-muted-foreground mb-4">
                    Build sessions from the Build tab to see them here
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setActiveTab('sessions')}
                    data-testid="button-go-to-build"
                  >
                    <ArrowRight className="h-4 w-4 mr-2" />
                    Go to Build Sessions
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Bulk release controls for draft sessions */}
                  {(() => {
                    const draftSessions = liveSessions.filter(s => s.status === 'draft');
                    if (draftSessions.length === 0) return null;
                    return (
                      <div className="flex items-center justify-between p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 text-amber-600" />
                          <span className="text-sm font-medium">
                            {draftSessions.length} draft session{draftSessions.length !== 1 ? 's' : ''} waiting to be released
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="default"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => bulkReleaseSessionsMutation.mutate(draftSessions.map(s => s.id))}
                          disabled={bulkReleaseSessionsMutation.isPending}
                          data-testid="button-release-all-drafts"
                        >
                          {bulkReleaseSessionsMutation.isPending ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              Releasing...
                            </>
                          ) : (
                            <>
                              <ArrowRight className="h-4 w-4 mr-1" />
                              Release All to Floor
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })()}
                  
                  {/* Bulk close controls for ready sessions */}
                  {(() => {
                    const readySessions = liveSessions.filter(s => s.status === 'ready');
                    if (readySessions.length === 0) return null;
                    return (
                      <div className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-green-600" />
                          <span className="text-sm font-medium">
                            {readySessions.length} session{readySessions.length !== 1 ? 's' : ''} released to floor
                          </span>
                        </div>
                        <Button
                          size="sm"
                          variant="default"
                          className="bg-blue-600 hover:bg-blue-700 text-white"
                          onClick={() => bulkCompleteSessionsMutation.mutate(readySessions.map(s => s.id))}
                          disabled={bulkCompleteSessionsMutation.isPending}
                          data-testid="button-close-all-released"
                        >
                          {bulkCompleteSessionsMutation.isPending ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              Closing...
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="h-4 w-4 mr-1" />
                              Close All Released
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })()}
                  
                  {['boxing_machine', 'poly_bag', 'hand_pack'].map((stationType, index) => {
                    const stationSessions = liveSessions.filter(s => s.stationType === stationType);
                    if (stationSessions.length === 0) return null;
                    
                    return (
                      <div key={stationType} className={`space-y-3 ${index > 0 ? 'mt-8 pt-6 border-t' : ''}`}>
                        <div className="flex items-center gap-3 mb-3">
                          {stationType === 'boxing_machine' && (
                            <Box className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                          )}
                          {stationType === 'poly_bag' && (
                            <Package className="h-6 w-6 text-green-600 dark:text-green-400" />
                          )}
                          {stationType === 'hand_pack' && (
                            <Hand className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                          )}
                          <h3 className="text-lg font-semibold">
                            {getStationTypeLabel(stationType)}
                          </h3>
                          <Badge variant="secondary" className="text-xs">
                            {stationSessions.length} session{stationSessions.length !== 1 ? 's' : ''}
                          </Badge>
                        </div>
                        
                        <div className="grid gap-3">
                          {stationSessions.map((session) => {
                            const isExpanded = expandedSessions.has(session.id);
                            const details = sessionDetails[session.id];
                            
                            return (
                              <div
                                key={session.id}
                                className="rounded-lg border bg-card overflow-hidden"
                                data-testid={`session-card-${session.id}`}
                              >
                                <button
                                  className="w-full p-4 text-left hover-elevate"
                                  onClick={() => toggleSessionExpand(session.id)}
                                  data-testid={`button-expand-session-${session.id}`}
                                >
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-3">
                                      <ChevronDown 
                                        className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
                                      />
                                      <span className="font-medium">
                                        {session.name || `Session #${session.sequenceNumber || session.id.slice(0, 8)}`}
                                      </span>
                                      <Badge 
                                        variant={session.status === 'picking' ? 'default' : session.status === 'packing' ? 'secondary' : 'outline'}
                                        className={
                                          session.status === 'draft' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' :
                                          session.status === 'ready' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                                          session.status === 'picking' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' :
                                          session.status === 'packing' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' :
                                          ''
                                        }
                                      >
                                        {session.status === 'draft' ? 'Draft' :
                                         session.status === 'ready' ? 'Ready to Pick' : 
                                         session.status === 'picking' ? 'Picking' : 
                                         session.status === 'packing' ? 'Packing' :
                                         session.status.charAt(0).toUpperCase() + session.status.slice(1)}
                                      </Badge>
                                      {/* Progress indicator for active sessions */}
                                      {(session.status === 'picking' || session.status === 'packing') && session.packedCount > 0 && (
                                        <Badge variant="outline" className="text-xs">
                                          {session.packedCount}/{session.orderCount} packed
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <Package className="h-4 w-4" />
                                        {session.orderCount} orders
                                      </span>
                                      {session.totalWeightOz != null && session.totalWeightOz > 0 && (
                                        <span className="flex items-center gap-1">
                                          <Scale className="h-4 w-4" />
                                          {session.totalWeightOz >= 16 
                                            ? `${(session.totalWeightOz / 16).toFixed(1)} lbs`
                                            : `${session.totalWeightOz} oz`}
                                        </span>
                                      )}
                                      {/* Release to Floor button for draft sessions */}
                                      {session.status === 'draft' && (
                                        <Button
                                          size="sm"
                                          variant="default"
                                          className="bg-green-600 hover:bg-green-700 text-white"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            releaseSessionMutation.mutate(session.id);
                                          }}
                                          disabled={releaseSessionMutation.isPending}
                                          data-testid={`button-release-session-${session.id}`}
                                        >
                                          <ArrowRight className="h-4 w-4 mr-1" />
                                          Release to Floor
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                  
                                  <div className="flex items-center gap-4 text-sm text-muted-foreground ml-7">
                                    {session.stationName && (
                                      <span className="flex items-center gap-1 font-medium text-foreground">
                                        <MapPin className="h-3 w-3" />
                                        {session.stationName}
                                      </span>
                                    )}
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      Created {new Date(session.createdAt).toLocaleString()}
                                    </span>
                                    {session.pickingStartedAt && (
                                      <span>
                                        Started picking {new Date(session.pickingStartedAt).toLocaleTimeString()}
                                      </span>
                                    )}
                                  </div>
                                </button>
                                
                                {isExpanded && (
                                  <div className="border-t bg-muted/30 p-4">
                                    {!details ? (
                                      <div className="flex items-center justify-center py-4">
                                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                                        <span className="ml-2 text-muted-foreground">Loading orders...</span>
                                      </div>
                                    ) : details.shipments.length === 0 ? (
                                      <p className="text-center text-muted-foreground py-4">No orders in this session</p>
                                    ) : (
                                      <div className="space-y-2">
                                        <div className="flex items-center justify-between mb-3">
                                          <span className="text-sm font-medium text-muted-foreground">
                                            Orders in Session ({details.shipments.length})
                                          </span>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setSessionToDelete(session);
                                            }}
                                            data-testid={`button-delete-session-${session.id}`}
                                          >
                                            <Trash2 className="h-4 w-4 mr-1" />
                                            Delete Session
                                          </Button>
                                        </div>
                                        <div className="space-y-5 max-h-[500px] overflow-y-auto pr-1">
                                          {details.shipments.map((shipment, idx) => (
                                            <div
                                              key={shipment.id}
                                              className="rounded-lg border-2 border-primary/30 bg-background overflow-hidden shadow-md"
                                              data-testid={`shipment-row-${shipment.id}`}
                                            >
                                              <div className="flex items-center justify-between px-4 py-3 bg-primary/10 border-b-2 border-primary/20">
                                                <div className="flex items-center gap-3">
                                                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-base font-bold shadow-sm">
                                                    {idx + 1}
                                                  </span>
                                                  <span className="font-mono text-lg font-bold text-foreground">
                                                    {shipment.orderNumber}
                                                  </span>
                                                  <Badge variant="secondary" className="text-xs">
                                                    {shipment.items?.length || 0} item{(shipment.items?.length || 0) !== 1 ? 's' : ''}
                                                  </Badge>
                                                  {shipment.totalWeightOz != null && shipment.totalWeightOz > 0 && (
                                                    <Badge variant="outline" className="text-xs flex items-center gap-1">
                                                      <Scale className="h-3 w-3" />
                                                      {shipment.totalWeightOz >= 16 
                                                        ? `${(shipment.totalWeightOz / 16).toFixed(1)} lbs`
                                                        : `${shipment.totalWeightOz} oz`}
                                                    </Badge>
                                                  )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                  {shipment.trackingNumber && (
                                                    <span className="text-xs text-muted-foreground font-mono">
                                                      {shipment.trackingNumber.slice(0, 12)}...
                                                    </span>
                                                  )}
                                                  {getLifecycleBadge(shipment.lifecyclePhase)}
                                                </div>
                                              </div>
                                              {shipment.items && shipment.items.length > 0 && (
                                                <div className="divide-y divide-border">
                                                  {shipment.items.map((item, itemIdx) => (
                                                    <div
                                                      key={`${shipment.id}-item-${itemIdx}`}
                                                      className="flex items-center gap-4 px-4 py-3 bg-background hover:bg-muted/20 transition-colors"
                                                      data-testid={`shipment-item-${shipment.id}-${itemIdx}`}
                                                    >
                                                      <div className="flex-shrink-0 w-14 h-14 rounded-md border-2 border-muted bg-white overflow-hidden flex items-center justify-center shadow-sm">
                                                        {item.imageUrl ? (
                                                          <img
                                                            src={item.imageUrl}
                                                            alt={item.name}
                                                            className="w-full h-full object-cover"
                                                            onError={(e) => {
                                                              (e.target as HTMLImageElement).style.display = 'none';
                                                              (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                                                            }}
                                                          />
                                                        ) : null}
                                                        <Package className={`h-6 w-6 text-muted-foreground ${item.imageUrl ? 'hidden' : ''}`} />
                                                      </div>
                                                      <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-foreground leading-snug" title={item.name}>
                                                          {item.name}
                                                        </p>
                                                        <div className="flex items-center gap-2 mt-0.5">
                                                          {item.sku && (
                                                            <span className="text-xs text-muted-foreground font-mono">
                                                              {item.sku}
                                                            </span>
                                                          )}
                                                          {item.weightValue != null && item.weightValue > 0 && (
                                                            <span className="text-xs text-muted-foreground">
                                                              • {item.weightValue} {item.weightUnit || 'oz'}
                                                            </span>
                                                          )}
                                                        </div>
                                                      </div>
                                                      <div className="flex-shrink-0">
                                                        <span className="inline-flex items-center justify-center min-w-[2.5rem] h-8 px-2 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-sm font-bold">
                                                          x{item.quantity}
                                                        </span>
                                                      </div>
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  
                  <div className="mt-6 p-4 bg-muted rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">Total Active Sessions</span>
                      <span className="text-xl font-bold">{liveSessions.length}</span>
                    </div>
                    <div className="flex items-center justify-between mt-2 text-sm text-muted-foreground">
                      <span>Total Orders in Sessions</span>
                      <span>{liveSessions.reduce((sum, s) => sum + s.orderCount, 0)}</span>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create Packaging Dialog */}
      <Dialog open={showCreatePackagingDialog} onOpenChange={setShowCreatePackagingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Packaging Type</DialogTitle>
            <DialogDescription>
              Define a new packaging option and which station type handles it
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="packaging-name">Name</Label>
              <Input
                id="packaging-name"
                placeholder='e.g., "Poly Bag 12x16" or "Box #2"'
                value={packagingForm.name}
                onChange={(e) => setPackagingForm(prev => ({ ...prev, name: e.target.value }))}
                data-testid="input-packaging-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Station Type</Label>
              <Select
                value={packagingForm.stationType}
                onValueChange={(value) => setPackagingForm(prev => ({ ...prev, stationType: value }))}
              >
                <SelectTrigger data-testid="select-packaging-station-type">
                  <SelectValue placeholder="Select station type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boxing_machine">
                    <div className="flex items-center gap-2">
                      <Box className="h-4 w-4" />
                      Boxing Machine
                    </div>
                  </SelectItem>
                  <SelectItem value="poly_bag">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Poly Bag
                    </div>
                  </SelectItem>
                  <SelectItem value="hand_pack">
                    <div className="flex items-center gap-2">
                      <Hand className="h-4 w-4" />
                      Hand Pack
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Orders using this packaging will route to stations of this type
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreatePackagingDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createPackagingMutation.mutate(packagingForm)}
              disabled={!packagingForm.name.trim() || createPackagingMutation.isPending}
              data-testid="button-save-packaging"
            >
              {createPackagingMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Packaging Dialog */}
      <Dialog open={!!editingPackaging} onOpenChange={(open) => !open && setEditingPackaging(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Packaging Type</DialogTitle>
            <DialogDescription>
              Update packaging details and station routing
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-packaging-name">Name</Label>
              <Input
                id="edit-packaging-name"
                value={packagingForm.name}
                onChange={(e) => setPackagingForm(prev => ({ ...prev, name: e.target.value }))}
                data-testid="input-edit-packaging-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Station Type</Label>
              <Select
                value={packagingForm.stationType}
                onValueChange={(value) => setPackagingForm(prev => ({ ...prev, stationType: value }))}
              >
                <SelectTrigger data-testid="select-edit-packaging-station-type">
                  <SelectValue placeholder="Select station type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boxing_machine">
                    <div className="flex items-center gap-2">
                      <Box className="h-4 w-4" />
                      Boxing Machine
                    </div>
                  </SelectItem>
                  <SelectItem value="poly_bag">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Poly Bag
                    </div>
                  </SelectItem>
                  <SelectItem value="hand_pack">
                    <div className="flex items-center gap-2">
                      <Hand className="h-4 w-4" />
                      Hand Pack
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingPackaging(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editingPackaging && updatePackagingMutation.mutate({
                id: editingPackaging.id,
                data: packagingForm,
              })}
              disabled={!packagingForm.name.trim() || updatePackagingMutation.isPending}
              data-testid="button-update-packaging"
            >
              {updatePackagingMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Session Confirmation Dialog */}
      <Dialog open={!!sessionToDelete} onOpenChange={(open) => !open && setSessionToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Session?</DialogTitle>
            <DialogDescription>
              This will remove the session and release all {sessionToDelete?.orderCount || 0} orders back to the queue.
              They can be reassigned to new sessions.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSessionToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => sessionToDelete && deleteSessionMutation.mutate(sessionToDelete.id)}
              disabled={deleteSessionMutation.isPending}
              data-testid="button-confirm-delete-session"
            >
              {deleteSessionMutation.isPending ? "Deleting..." : "Delete Session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fingerprint Shipments Modal */}
      <Dialog open={!!selectedFingerprintForShipments} onOpenChange={(open) => !open && setSelectedFingerprintForShipments(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              Shipments for Fingerprint
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 flex-wrap">
              <span>{fingerprintShipmentsData?.fingerprint.displayName || "Loading..."}</span>
              {fingerprintShipmentsData?.fingerprint.displayName?.endsWith("| 0oz") && (
                <Badge variant="destructive" className="text-xs">
                  Missing Weight
                </Badge>
              )}
            </DialogDescription>
          </DialogHeader>
          
          {fingerprintShipmentsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading...
            </div>
          ) : fingerprintShipmentsData ? (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-3 pr-4">
                {fingerprintShipmentsData.products.map((product) => (
                  <div
                    key={product.sku}
                    className="p-3 rounded-lg border bg-card"
                  >
                    <div className="flex items-start justify-between gap-4 mb-2">
                      <div>
                        <div className="font-medium">{product.sku}</div>
                        {product.title && (
                          <div className="text-sm text-muted-foreground">{product.title}</div>
                        )}
                      </div>
                      {product.weight && (
                        <Badge variant="secondary">{product.weight}</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {product.orderNumbers.map((orderNumber) => (
                        <div key={orderNumber} className="flex items-center gap-0.5">
                          <Badge
                            variant="outline"
                            className="cursor-pointer hover-elevate text-xs"
                            onClick={() => window.open(`/order/${orderNumber}`, '_blank')}
                          >
                            {orderNumber}
                          </Badge>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5"
                            onClick={() => {
                              const url = `${window.location.origin}/shipments/${orderNumber}`;
                              navigator.clipboard.writeText(url);
                              toast({
                                title: "Link copied",
                                description: `Shipments link for ${orderNumber} copied to clipboard`,
                              });
                            }}
                            data-testid={`button-copy-shipment-link-${orderNumber}`}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedFingerprintForShipments(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SKU Shipments Modal (for uncategorized products) */}
      <Dialog open={!!selectedSkuForShipments} onOpenChange={(open) => !open && setSelectedSkuForShipments(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              Shipments for SKU
            </DialogTitle>
            <DialogDescription className="font-mono">
              {selectedSkuForShipments || "Loading..."}
            </DialogDescription>
          </DialogHeader>
          
          {skuShipmentsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading...
            </div>
          ) : skuShipmentsData ? (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-2 pr-4">
                <p className="text-sm text-muted-foreground mb-3">
                  Found {skuShipmentsData.totalCount} shipment{skuShipmentsData.totalCount !== 1 ? 's' : ''} with pending categorization containing this SKU
                </p>
                {skuShipmentsData.shipments.map((shipment) => (
                  <div
                    key={shipment.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant="outline"
                        className="cursor-pointer hover-elevate"
                        onClick={() => window.open(`/order/${shipment.orderNumber}`, '_blank')}
                      >
                        {shipment.orderNumber}
                      </Badge>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => {
                          navigator.clipboard.writeText(shipment.orderNumber);
                          toast({
                            title: "Copied",
                            description: `Order ${shipment.orderNumber} copied to clipboard`,
                          });
                        }}
                        data-testid={`button-copy-order-${shipment.id}`}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        {new Date(shipment.orderDate).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {shipment.shipmentStatus && (
                        <Badge variant="secondary" className="text-xs">
                          {shipment.shipmentStatus}
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
                {skuShipmentsData.shipments.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No shipments found with this SKU
                  </div>
                )}
              </div>
            </ScrollArea>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedSkuForShipments(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
