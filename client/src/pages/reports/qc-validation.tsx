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
  const [pageSize] = useState(20);

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

      {/* Details Modal */}
      <Dialog open={!!selectedResult} onOpenChange={(open) => !open && setSelectedResult(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              QC Data Comparison - {selectedResult?.orderNumber}
            </DialogTitle>
            <DialogDescription>
              Found {selectedResult?.totalDifferences} difference(s) between local data and SkuVault
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex-1">
            {selectedResult && (
              <div className="space-y-6 pr-4">
                {/* Summary */}
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-lg font-semibold text-red-600">{selectedResult.missingInLocal}</p>
                      <p className="text-sm text-muted-foreground">Missing in Local</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-lg font-semibold text-orange-600">{selectedResult.missingInSkuvault}</p>
                      <p className="text-sm text-muted-foreground">Missing in SkuVault</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-lg font-semibold text-yellow-600">{selectedResult.fieldMismatches}</p>
                      <p className="text-sm text-muted-foreground">Field Mismatches</p>
                    </CardContent>
                  </Card>
                </div>

                {/* Side by Side Comparison */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Local Data */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Local (shipment_qc_items)</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">SKU</TableHead>
                            <TableHead className="text-xs">Barcode</TableHead>
                            <TableHead className="text-xs text-right">Qty</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedResult.localItems.map((item, idx) => {
                            const hasDiff = selectedResult.differences.some(d => d.sku === item.sku);
                            return (
                              <TableRow key={idx} className={hasDiff ? 'bg-yellow-50 dark:bg-yellow-900/10' : ''}>
                                <TableCell className="text-xs font-mono">{item.sku}</TableCell>
                                <TableCell className="text-xs">{item.barcode || '-'}</TableCell>
                                <TableCell className="text-xs text-right">{item.quantityExpected}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>

                  {/* SkuVault Data */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">SkuVault (Live)</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">SKU</TableHead>
                            <TableHead className="text-xs">Barcode</TableHead>
                            <TableHead className="text-xs text-right">Qty</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedResult.skuvaultItems.map((item, idx) => {
                            const hasDiff = selectedResult.differences.some(d => d.sku === item.sku);
                            return (
                              <TableRow key={idx} className={hasDiff ? 'bg-yellow-50 dark:bg-yellow-900/10' : ''}>
                                <TableCell className="text-xs font-mono">{item.sku}</TableCell>
                                <TableCell className="text-xs">{item.barcode || '-'}</TableCell>
                                <TableCell className="text-xs text-right">{item.quantity}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </div>

                {/* Difference Details */}
                {selectedResult.differences.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Detailed Differences</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">SKU</TableHead>
                            <TableHead className="text-xs">Field</TableHead>
                            <TableHead className="text-xs">Local Value</TableHead>
                            <TableHead className="text-xs">SkuVault Value</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedResult.differences.map((diff, idx) => (
                            <TableRow key={idx}>
                              <TableCell className="text-xs font-mono">{diff.sku}</TableCell>
                              <TableCell className="text-xs">{diff.field}</TableCell>
                              <TableCell className="text-xs text-red-600">
                                {diff.localValue === null ? '(missing)' : String(diff.localValue)}
                              </TableCell>
                              <TableCell className="text-xs text-green-600">
                                {diff.skuvaultValue === null ? '(missing)' : String(diff.skuvaultValue)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedResult(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
