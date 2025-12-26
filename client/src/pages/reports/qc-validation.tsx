import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  RefreshCw,
  Calendar,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  Eye,
  Play,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Package,
  FileSearch,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { subDays } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { apiRequest } from "@/lib/queryClient";

const CST_TIMEZONE = 'America/Chicago';

interface ShipmentForValidation {
  id: string;
  orderNumber: string;
  orderDate: string | null;
  shipmentStatus: string | null;
  qcItemCount: number;
}

interface ShipmentsResponse {
  shipments: ShipmentForValidation[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface QcItemDifference {
  sku: string;
  field: string;
  localValue: string | number | null;
  skuvaultValue: string | number | null;
}

interface ProductInfoItem {
  sku: string;
  productCategory: string | null;
  isAssembledProduct: boolean;
  parentSku: string | null;
  kitComponents: Array<{ componentSku: string; componentQuantity: number }> | null;
  foundInCatalog: boolean;
}

interface ComparisonResult {
  shipmentId: string;
  orderNumber: string;
  totalDifferences: number;
  missingInLocal: number;
  missingInSkuvault: number;
  fieldMismatches: number;
  differences: QcItemDifference[];
  localItems: Array<{
    sku: string;
    barcode: string | null;
    description: string | null;
    quantityExpected: number;
  }>;
  skuvaultItems: Array<{
    sku: string;
    barcode: string | null;
    title: string | null;
    quantity: number;
  }>;
  productInfo: ProductInfoItem[];
  error?: string;
}

interface AnalysisResponse {
  results: ComparisonResult[];
  totalAnalyzed: number;
  totalWithDifferences: number;
  totalDifferences: number;
}

export default function QcValidationReport() {
  const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
  const today = formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  const sevenDaysAgo = formatInTimeZone(subDays(cstNow, 7), CST_TIMEZONE, 'yyyy-MM-dd');

  const [startDate, setStartDate] = useState(sevenDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [search, setSearch] = useState("");
  const [shipmentStatus, setShipmentStatus] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const pageSizeOptions = [10, 25, 50, 100, 200] as const;

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResponse | null>(null);
  const [selectedResult, setSelectedResult] = useState<ComparisonResult | null>(null);

  const { toast } = useToast();

  // Fetch shipments with QC items for the selected filters
  const { data: shipmentsData, isLoading, refetch } = useQuery<ShipmentsResponse>({
    queryKey: ["/api/reports/qc-validation/shipments", { startDate, endDate, search, shipmentStatus, page, pageSize }],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.append('startDate', startDate);
      params.append('endDate', endDate);
      params.append('page', page.toString());
      params.append('pageSize', pageSize.toString());
      if (search) params.append('search', search);
      if (shipmentStatus && shipmentStatus !== 'all') params.append('shipmentStatus', shipmentStatus);

      const response = await fetch(`/api/reports/qc-validation/shipments?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch shipments");
      return response.json();
    },
  });

  const shipments = shipmentsData?.shipments || [];
  const totalPages = shipmentsData?.totalPages || 1;

  // Get shipment IDs for the current page
  const shipmentIds = useMemo(() => shipments.map(s => s.id), [shipments]);

  // Analyze current page against SkuVault
  const analyzeCurrentPage = async () => {
    if (shipmentIds.length === 0) {
      toast({
        title: "No shipments to analyze",
        description: "Load some shipments first",
        variant: "destructive",
      });
      return;
    }

    setIsAnalyzing(true);
    setAnalysisResults(null);

    try {
      const response = await apiRequest("POST", "/api/reports/qc-validation/analyze", {
        shipmentIds,
      });

      if (!response.ok) {
        throw new Error("Analysis failed");
      }

      const data: AnalysisResponse = await response.json();
      setAnalysisResults(data);

      toast({
        title: "Analysis Complete",
        description: `Analyzed ${data.totalAnalyzed} shipments. ${data.totalWithDifferences} have differences.`,
      });
    } catch (error) {
      console.error("Analysis error:", error);
      toast({
        title: "Analysis Failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Get analysis result for a specific shipment
  const getAnalysisResult = (shipmentId: string): ComparisonResult | undefined => {
    return analysisResults?.results.find(r => r.shipmentId === shipmentId);
  };

  // Copy order number to clipboard
  const copyOrderNumber = async (orderNumber: string) => {
    try {
      await navigator.clipboard.writeText(orderNumber);
      toast({
        title: "Copied",
        description: `${orderNumber} copied to clipboard`,
      });
    } catch {
      toast({
        title: "Failed to copy",
        description: "Could not copy to clipboard",
        variant: "destructive",
      });
    }
  };

  // Clear analysis when changing page or filters
  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    setAnalysisResults(null);
  };

  const handleFilterChange = () => {
    setPage(1);
    setAnalysisResults(null);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3" data-testid="text-page-title">
            <FileSearch className="h-8 w-8" />
            QC Validation Report
          </h1>
          <p className="text-muted-foreground mt-1">
            Compare shipment_qc_items with live SkuVault QC data
          </p>
        </div>
        <Button
          onClick={() => refetch()}
          variant="outline"
          size="sm"
          data-testid="button-refresh"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="startDate">Start Date</Label>
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  handleFilterChange();
                }}
                className="w-40"
                data-testid="input-start-date"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="endDate">End Date</Label>
              <Input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  handleFilterChange();
                }}
                className="w-40"
                data-testid="input-end-date"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="search">Search Order</Label>
              <Input
                id="search"
                type="text"
                placeholder="Order number..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  handleFilterChange();
                }}
                className="w-48"
                data-testid="input-search"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="shipmentStatus">Shipment Status</Label>
              <Select
                value={shipmentStatus}
                onValueChange={(value) => {
                  setShipmentStatus(value);
                  handleFilterChange();
                }}
              >
                <SelectTrigger className="w-40" data-testid="select-shipment-status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="shipped">Shipped</SelectItem>
                  <SelectItem value="on_hold">On Hold</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={analyzeCurrentPage}
              disabled={isAnalyzing || shipments.length === 0}
              className="ml-auto"
              data-testid="button-analyze"
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Analyze Page ({shipments.length})
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Summary Stats */}
      {analysisResults && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <Package className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-2xl font-bold">{analysisResults.totalAnalyzed}</p>
                  <p className="text-sm text-muted-foreground">Shipments Analyzed</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
                <div>
                  <p className="text-2xl font-bold">
                    {analysisResults.totalAnalyzed - analysisResults.totalWithDifferences}
                  </p>
                  <p className="text-sm text-muted-foreground">Matching</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-yellow-600" />
                <div>
                  <p className="text-2xl font-bold">{analysisResults.totalWithDifferences}</p>
                  <p className="text-sm text-muted-foreground">With Differences</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-8 w-8 text-red-600" />
                <div>
                  <p className="text-2xl font-bold">{analysisResults.totalDifferences}</p>
                  <p className="text-sm text-muted-foreground">Total Differences</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results Table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">
              Shipments {shipmentsData && `(${shipmentsData.totalCount} total)`}
            </CardTitle>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Show</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => {
                    setPageSize(Number(value));
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-[70px] h-8" data-testid="select-page-size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pageSizeOptions.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page <= 1}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground px-2">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page + 1)}
                  disabled={page >= totalPages}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : shipments.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No shipments found for the selected filters</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order Number</TableHead>
                  <TableHead>Order Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-center">QC Items</TableHead>
                  <TableHead className="text-center">Analysis Result</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipments.map((shipment) => {
                  const result = getAnalysisResult(shipment.id);
                  return (
                    <TableRow key={shipment.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="cursor-pointer hover-elevate font-mono"
                            onClick={() => window.open(`/shipments/${shipment.id}`, '_blank')}
                          >
                            {shipment.orderNumber}
                          </Badge>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            onClick={() => copyOrderNumber(shipment.orderNumber)}
                            data-testid={`button-copy-${shipment.id}`}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        {shipment.orderDate
                          ? formatInTimeZone(new Date(shipment.orderDate), CST_TIMEZONE, 'MMM d, yyyy')
                          : '-'}
                      </TableCell>
                      <TableCell>
                        {shipment.shipmentStatus ? (
                          <Badge variant="secondary">{shipment.shipmentStatus}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {shipment.qcItemCount}
                      </TableCell>
                      <TableCell className="text-center">
                        {result ? (
                          result.error ? (
                            <Badge variant="destructive">Error</Badge>
                          ) : result.totalDifferences === 0 ? (
                            <Badge className="bg-green-600 hover:bg-green-700">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              Match
                            </Badge>
                          ) : (
                            <Badge variant="destructive">
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              {result.totalDifferences} diff{result.totalDifferences !== 1 ? 's' : ''}
                            </Badge>
                          )
                        ) : (
                          <span className="text-muted-foreground text-sm">Not analyzed</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {result && !result.error && result.totalDifferences > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedResult(result)}
                            data-testid={`button-view-details-${shipment.id}`}
                          >
                            <Eye className="h-4 w-4 mr-1" />
                            Details
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Details Modal - Unified Diff Style */}
      <Dialog open={!!selectedResult} onOpenChange={(open) => !open && setSelectedResult(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              QC Data Comparison - {selectedResult?.orderNumber}
            </DialogTitle>
            <DialogDescription>
              Found {selectedResult?.totalDifferences} difference(s) between local data and SkuVault
            </DialogDescription>
          </DialogHeader>

          {selectedResult && (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-3 gap-3">
                <Card className={selectedResult.missingInLocal > 0 ? 'border-red-300 bg-red-50 dark:bg-red-900/20' : ''}>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xl font-bold text-red-600">{selectedResult.missingInLocal}</p>
                    <p className="text-xs text-muted-foreground">Missing in Local</p>
                  </CardContent>
                </Card>
                <Card className={selectedResult.missingInSkuvault > 0 ? 'border-orange-300 bg-orange-50 dark:bg-orange-900/20' : ''}>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xl font-bold text-orange-600">{selectedResult.missingInSkuvault}</p>
                    <p className="text-xs text-muted-foreground">Missing in SkuVault</p>
                  </CardContent>
                </Card>
                <Card className={selectedResult.fieldMismatches > 0 ? 'border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20' : ''}>
                  <CardContent className="pt-3 pb-3">
                    <p className="text-xl font-bold text-yellow-600">{selectedResult.fieldMismatches}</p>
                    <p className="text-xs text-muted-foreground">Qty Mismatches</p>
                  </CardContent>
                </Card>
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 text-xs border rounded-md p-2 bg-muted/30">
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-green-100 border border-green-400" />
                  <span>Match</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-red-100 border border-red-400" />
                  <span>Missing in Local (in SkuVault only)</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-orange-100 border border-orange-400" />
                  <span>Missing in SkuVault (in Local only)</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-yellow-100 border border-yellow-400" />
                  <span>Qty Mismatch</span>
                </div>
              </div>

              {/* Unified Diff Table */}
              <div className="flex-1 overflow-auto border rounded-md">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="text-xs w-[160px]">SKU</TableHead>
                      <TableHead className="text-xs text-center w-[70px]">Local Qty</TableHead>
                      <TableHead className="text-xs text-center w-[70px]">SV Qty</TableHead>
                      <TableHead className="text-xs text-center w-[70px]">SV On Hand</TableHead>
                      <TableHead className="text-xs w-[100px]">Status</TableHead>
                      <TableHead className="text-xs">Diagnosis</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(() => {
                      // Build unified diff rows
                      const allSkus = new Set<string>();
                      const localBySku = new Map<string, number>();
                      const skuvaultBySku = new Map<string, number>();
                      
                      selectedResult.localItems.forEach(item => {
                        allSkus.add(item.sku);
                        localBySku.set(item.sku, (localBySku.get(item.sku) || 0) + item.quantityExpected);
                      });
                      
                      selectedResult.skuvaultItems.forEach(item => {
                        allSkus.add(item.sku);
                        skuvaultBySku.set(item.sku, (skuvaultBySku.get(item.sku) || 0) + item.quantity);
                      });
                      
                      // Build quantity on hand map from skuvaultRawItems
                      const qtyOnHandBySku = new Map<string, number>();
                      (selectedResult.skuvaultRawItems || []).forEach((item: any) => {
                        if (item.Sku && item.QuantityOnHand !== undefined) {
                          qtyOnHandBySku.set(item.Sku, item.QuantityOnHand);
                        }
                      });
                      
                      // Build a map from SKU to diagnosis
                      const diagnosisBySku = new Map<string, { category: string; reason: string; parentSku?: string; quantityOnHand?: number }>();
                      selectedResult.differences?.forEach(diff => {
                        if (diff.diagnosis) {
                          diagnosisBySku.set(diff.sku, diff.diagnosis);
                        }
                      });
                      
                      // Group SKUs: parent products first, then their components together
                      // Build parent-to-children map from diagnosis data
                      const parentToChildren = new Map<string, string[]>();
                      const childToParent = new Map<string, string>();
                      
                      diagnosisBySku.forEach((diag, sku) => {
                        if (diag.parentSku) {
                          childToParent.set(sku, diag.parentSku);
                          const children = parentToChildren.get(diag.parentSku) || [];
                          children.push(sku);
                          parentToChildren.set(diag.parentSku, children);
                        }
                      });
                      
                      // Sort SKUs: parents first with their children, then orphan SKUs alphabetically
                      const sortedSkus: string[] = [];
                      const processedSkus = new Set<string>();
                      
                      // Get all parent SKUs (sorted alphabetically)
                      const parentSkus = Array.from(parentToChildren.keys()).sort();
                      
                      // Add each parent followed by its children
                      for (const parentSku of parentSkus) {
                        // Add parent if it exists in allSkus and not processed
                        if (allSkus.has(parentSku) && !processedSkus.has(parentSku)) {
                          sortedSkus.push(parentSku);
                          processedSkus.add(parentSku);
                        }
                        // Add children (sorted alphabetically)
                        const children = parentToChildren.get(parentSku) || [];
                        children.sort().forEach(child => {
                          if (allSkus.has(child) && !processedSkus.has(child)) {
                            sortedSkus.push(child);
                            processedSkus.add(child);
                          }
                        });
                      }
                      
                      // Add remaining SKUs that aren't part of parent-child groups (sorted alphabetically)
                      Array.from(allSkus).sort().forEach(sku => {
                        if (!processedSkus.has(sku)) {
                          sortedSkus.push(sku);
                        }
                      });
                      
                      return sortedSkus.map((sku, idx) => {
                        const localQty = localBySku.get(sku);
                        const svQty = skuvaultBySku.get(sku);
                        const diagnosis = diagnosisBySku.get(sku);
                        const qtyOnHand = qtyOnHandBySku.get(sku);
                        const parentSku = childToParent.get(sku);
                        const isChild = !!parentSku;
                        
                        let status: 'match' | 'missing_local' | 'missing_sv' | 'mismatch';
                        let rowClass = '';
                        let statusLabel = '';
                        let statusBadgeClass = '';
                        
                        if (localQty === undefined) {
                          status = 'missing_local';
                          rowClass = 'bg-red-50 dark:bg-red-900/20';
                          statusLabel = 'Missing in Local';
                          statusBadgeClass = 'bg-red-100 text-red-800 border-red-300';
                        } else if (svQty === undefined) {
                          status = 'missing_sv';
                          rowClass = 'bg-orange-50 dark:bg-orange-900/20';
                          statusLabel = 'Missing in SkuVault';
                          statusBadgeClass = 'bg-orange-100 text-orange-800 border-orange-300';
                        } else if (localQty !== svQty) {
                          status = 'mismatch';
                          rowClass = 'bg-yellow-50 dark:bg-yellow-900/20';
                          statusLabel = 'Qty Mismatch';
                          statusBadgeClass = 'bg-yellow-100 text-yellow-800 border-yellow-300';
                        } else {
                          status = 'match';
                          rowClass = 'bg-green-50/50 dark:bg-green-900/10';
                          statusLabel = 'Match';
                          statusBadgeClass = 'bg-green-100 text-green-800 border-green-300';
                        }
                        
                        // Determine diagnosis category badge color
                        const getCategoryBadge = (cat: string) => {
                          switch (cat) {
                            case 'AP_EXPLODED_SKUVAULT':
                              return { label: 'AP Exploded (SV)', class: 'bg-purple-100 text-purple-800 border-purple-300' };
                            case 'AP_EXPLODED_LOCAL':
                              return { label: 'AP Exploded (Local)', class: 'bg-purple-100 text-purple-800 border-purple-300' };
                            case 'KIT_MAPPING_MISMATCH':
                              return { label: 'Kit Mapping', class: 'bg-blue-100 text-blue-800 border-blue-300' };
                            case 'INDIVIDUAL_MISSING_LOCAL':
                              return { label: 'Missing SKU', class: 'bg-gray-100 text-gray-800 border-gray-300' };
                            case 'INDIVIDUAL_MISSING_SKUVAULT':
                              return { label: 'Not in SV', class: 'bg-gray-100 text-gray-800 border-gray-300' };
                            case 'QUANTITY_MISMATCH':
                              return { label: 'Qty Issue', class: 'bg-yellow-100 text-yellow-800 border-yellow-300' };
                            default:
                              return { label: 'Unknown', class: 'bg-gray-100 text-gray-600 border-gray-300' };
                          }
                        };
                        
                        return (
                          <TableRow key={idx} className={rowClass}>
                            <TableCell className="text-xs font-mono py-2">
                              {isChild && <span className="text-muted-foreground mr-1">└</span>}
                              {sku}
                            </TableCell>
                            <TableCell className={`text-xs text-center py-2 ${status === 'missing_local' ? 'text-muted-foreground' : ''}`}>
                              {localQty !== undefined ? localQty : '-'}
                            </TableCell>
                            <TableCell className={`text-xs text-center py-2 ${status === 'missing_sv' ? 'text-muted-foreground' : ''}`}>
                              {svQty !== undefined ? svQty : '-'}
                            </TableCell>
                            <TableCell className={`text-xs text-center py-2 ${qtyOnHand === 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'}`}>
                              {qtyOnHand !== undefined ? qtyOnHand : '-'}
                            </TableCell>
                            <TableCell className="py-2">
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${statusBadgeClass}`}>
                                {statusLabel}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-2 text-xs">
                              {diagnosis ? (
                                <div className="space-y-1">
                                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${getCategoryBadge(diagnosis.category).class}`}>
                                    {getCategoryBadge(diagnosis.category).label}
                                  </Badge>
                                  <p className="text-[10px] text-muted-foreground leading-tight">
                                    {diagnosis.reason}
                                  </p>
                                  {diagnosis.parentSku && (
                                    <p className="text-[10px] font-mono text-blue-600">
                                      Parent: {diagnosis.parentSku}
                                    </p>
                                  )}
                                </div>
                              ) : status === 'match' ? (
                                <span className="text-muted-foreground">-</span>
                              ) : (
                                <span className="text-muted-foreground italic">Analyzing...</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      });
                    })()}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          <DialogFooter className="pt-2 flex justify-between">
            <Button
              variant="outline"
              onClick={() => {
                if (!selectedResult) return;
                
                // Build comprehensive analysis context
                const lines: string[] = [];
                lines.push("=== QC DATA COMPARISON ANALYSIS REQUEST ===");
                lines.push("");
                lines.push(`Order Number: ${selectedResult.orderNumber}`);
                lines.push(`Shipment ID: ${selectedResult.shipmentId}`);
                lines.push("");
                lines.push("--- SUMMARY ---");
                lines.push(`Total Differences: ${selectedResult.totalDifferences}`);
                lines.push(`Missing in Local (ship.): ${selectedResult.missingInLocal}`);
                lines.push(`Missing in SkuVault: ${selectedResult.missingInSkuvault}`);
                lines.push(`Quantity Mismatches: ${selectedResult.fieldMismatches}`);
                lines.push("");
                
                lines.push("--- LOCAL DATA (shipment_qc_items table) ---");
                lines.push("SKU | Barcode | Description | Qty");
                selectedResult.localItems.forEach(item => {
                  lines.push(`${item.sku} | ${item.barcode || 'null'} | ${item.description || 'null'} | ${item.quantityExpected}`);
                });
                lines.push("");
                
                lines.push("--- SKUVAULT LIVE DATA (QC Sale API) ---");
                lines.push("SKU | Barcode | Title | Qty");
                selectedResult.skuvaultItems.forEach(item => {
                  lines.push(`${item.sku} | ${item.barcode || 'null'} | ${item.title || 'null'} | ${item.quantity}`);
                });
                lines.push("");
                
                lines.push("--- SKUVAULT RAW ITEMS (with inventory levels) ---");
                lines.push("SKU | Is Kit? | Qty On Hand | Kit Components");
                if (selectedResult.skuvaultRawItems && selectedResult.skuvaultRawItems.length > 0) {
                  (selectedResult.skuvaultRawItems as any[]).forEach((item: any) => {
                    const kitComps = item.KitProducts && item.KitProducts.length > 0 
                      ? item.KitProducts.map((kp: any) => `${kp.Sku}x${kp.Quantity}`).join(', ')
                      : 'none';
                    lines.push(`${item.Sku} | ${item.IsKit ? 'YES' : 'no'} | ${item.QuantityOnHand !== undefined ? item.QuantityOnHand : 'N/A'} | ${kitComps}`);
                  });
                } else {
                  lines.push("(No raw items data available)");
                }
                lines.push("");
                
                lines.push("--- DETAILED DIFFERENCES WITH DIAGNOSIS ---");
                if (selectedResult.differences.length === 0) {
                  lines.push("No field-level differences detected.");
                } else {
                  lines.push("SKU | Field | Local Value | SkuVault Value | Diagnosis Category | Diagnosis Reason");
                  selectedResult.differences.forEach((diff: any) => {
                    const diagCat = diff.diagnosis?.category || 'N/A';
                    const diagReason = diff.diagnosis?.reason || 'N/A';
                    const parentSku = diff.diagnosis?.parentSku ? ` (Parent: ${diff.diagnosis.parentSku})` : '';
                    lines.push(`${diff.sku} | ${diff.field} | ${diff.localValue === null ? '(missing)' : diff.localValue} | ${diff.skuvaultValue === null ? '(missing)' : diff.skuvaultValue} | ${diagCat} | ${diagReason}${parentSku}`);
                  });
                }
                lines.push("");
                
                lines.push("--- PRODUCT CATALOG INFO (from skuvault_products table) ---");
                lines.push("SKU | Category | Is AP? | Parent SKU | In Catalog? | Kit Components | Member of Kits");
                if (selectedResult.productInfo && selectedResult.productInfo.length > 0) {
                  selectedResult.productInfo.forEach((info: any) => {
                    const kitComps = info.kitComponents 
                      ? info.kitComponents.map((c: any) => `${c.componentSku}x${c.componentQuantity}`).join(', ')
                      : 'none';
                    const parentKits = info.parentKits 
                      ? info.parentKits.join(', ')
                      : 'none';
                    lines.push(`${info.sku} | ${info.productCategory || 'null'} | ${info.isAssembledProduct ? 'YES' : 'no'} | ${info.parentSku || 'null'} | ${info.foundInCatalog ? 'yes' : 'NO'} | ${kitComps} | ${parentKits}`);
                  });
                } else {
                  lines.push("(No product info available)");
                }
                lines.push("");
                
                lines.push("--- BUSINESS RULES: KITS vs ASSEMBLED PRODUCTS (APs) ---");
                lines.push("KITS = Built at fulfillment time by picker. EXPLODED into components. Should have category='kit'.");
                lines.push("APs = Pre-built products, ship as-is. NOT exploded. Have is_assembled_product=true.");
                lines.push("");
                lines.push("--- HOW shipment_qc_items GETS POPULATED ---");
                lines.push("When orders sync to ship., the QC item hydrator populates shipment_qc_items:");
                lines.push("1. Products with product_category='kit' → EXPLODED into component SKUs using kit_mappings_cache");
                lines.push("2. Variants (where sku != parent_sku) → Stored as-is (the variant SKU)");
                lines.push("3. Regular products → Stored as-is");
                lines.push("4. Products with is_assembled_product=true but category != 'kit' → NOT exploded (stored as parent SKU)");
                lines.push("");
                lines.push("SkuVault (golden source) determines what actually gets exploded at fulfillment time.");
                lines.push("If SkuVault explodes a product but ship. didn't, the product is miscategorized in the catalog.");
                lines.push("");
                lines.push("--- CONTEXT ---");
                lines.push("- 'Local' = ship. database (shipment_qc_items table, populated when orders are synced)");
                lines.push("- 'SkuVault' = Live data from SkuVault QC Sale API (GOLDEN SOURCE for what picker scans)");
                lines.push("- 'Missing in Local' = SKUs exist in SkuVault but not in our shipment_qc_items");
                lines.push("- 'Missing in SkuVault' = SKUs exist in local but SkuVault QC API doesn't return them");
                lines.push("- 'Is AP' = isAssembledProduct flag (pre-built products, should NOT be exploded)");
                lines.push("- 'Category' = product_category ('kit' = should be exploded at fulfillment)");
                lines.push("- Kit Components = Expected components from kit_mappings_cache (sourced from GCP reporting DB)");
                lines.push("");
                lines.push("--- COMMON ISSUES ---");
                lines.push("1. MISCATEGORIZED PRODUCT: Local has parent SKU, SkuVault has components");
                lines.push("   - Product has is_assembled_product=true but category != 'kit'");
                lines.push("   - SkuVault exploded it (treating as kit) but ship. didn't");
                lines.push("   - FIX: Update product to have product_category='kit' in the source catalog");
                lines.push("2. MISSING KIT MAPPING: Product is category='kit' but no components in kit_mappings_cache");
                lines.push("   - The kit definition may not exist in GCP vw_internal_kit_component_inventory_latest view");
                lines.push("3. STALE KIT MAPPING: Components don't match between local and SkuVault");
                lines.push("   - Kit definition changed in SkuVault but kit_mappings_cache has old data");
                lines.push("   - Cache refreshes hourly from GCP reporting database");
                
                const text = lines.join("\n");
                navigator.clipboard.writeText(text);
                toast({
                  title: "Copied to clipboard",
                  description: "Analysis context ready to paste",
                });
              }}
              data-testid="button-copy-for-ai"
            >
              <Copy className="h-4 w-4 mr-1" />
              Copy for AI Analysis
            </Button>
            <Button variant="outline" onClick={() => setSelectedResult(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
