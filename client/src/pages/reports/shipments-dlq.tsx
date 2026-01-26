import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Search, ChevronDown, ChevronRight, Inbox, ChevronLeft, ChevronsLeft, ChevronsRight, Copy, Check, MapPin, Package, Calendar } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { useToast } from "@/hooks/use-toast";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const CST_TIMEZONE = 'America/Chicago';

interface DeadLetter {
  shipmentId: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string | null;
  data: any;
}

interface DLQResponse {
  deadLetters: DeadLetter[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function ShipmentsDLQReport() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const limit = 25;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  };

  const { data, isLoading, refetch, isRefetching } = useQuery<DLQResponse>({
    queryKey: ['/api/reports/shipments-dlq', debouncedSearch, page, limit],
    queryFn: async ({ queryKey }) => {
      const [endpoint, searchTerm, pageNum, limitNum] = queryKey as [string, string, number, number];
      const params = new URLSearchParams();
      if (searchTerm) params.set('search', searchTerm);
      params.set('page', String(pageNum));
      params.set('limit', String(limitNum));
      const url = `${endpoint}?${params.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
  });

  const toggleRow = (shipmentId: string) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(shipmentId)) {
      newExpanded.delete(shipmentId);
    } else {
      newExpanded.add(shipmentId);
    }
    setExpandedRows(newExpanded);
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    try {
      return formatInTimeZone(new Date(dateString), CST_TIMEZONE, "MMM d, yyyy h:mm a");
    } catch {
      return dateString;
    }
  };

  const getReasonBadge = (reason: string | null) => {
    switch (reason) {
      case 'null_order_number':
        return <Badge variant="secondary">No Order Number</Badge>;
      default:
        return <Badge variant="outline">{reason || "Unknown"}</Badge>;
    }
  };

  const getShipToSummary = (data: any) => {
    const shipTo = data?.ship_to;
    if (!shipTo) return "No address data";
    const parts = [shipTo.city_locality, shipTo.state_province].filter(Boolean);
    return parts.join(", ") || "Unknown location";
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Inbox className="h-5 w-5" />
                Shipments Dead Letter Queue
              </CardTitle>
              <CardDescription>
                Shipments that failed ETL processing and were set aside for review
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isRefetching}
              data-testid="button-refresh-dlq"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by shipment ID, city, state..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10"
                data-testid="input-search-dlq"
              />
            </div>
            {data && (
              <Badge variant="outline" className="text-sm">
                {data.total} shipment{data.total !== 1 ? 's' : ''} in DLQ
              </Badge>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : data?.deadLetters.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Inbox className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No dead-lettered shipments found</p>
              {debouncedSearch && <p className="text-sm mt-1">Try a different search term</p>}
            </div>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Shipment ID</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.deadLetters.map((dl) => (
                      <Collapsible key={dl.shipmentId} asChild open={expandedRows.has(dl.shipmentId)}>
                        <>
                          <TableRow 
                            className="cursor-pointer hover-elevate"
                            onClick={() => toggleRow(dl.shipmentId)}
                            data-testid={`row-dlq-${dl.shipmentId}`}
                          >
                            <TableCell>
                              <CollapsibleTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-6 w-6">
                                  {expandedRows.has(dl.shipmentId) ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </Button>
                              </CollapsibleTrigger>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <code className="text-sm font-mono">{dl.shipmentId}</code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyToClipboard(dl.shipmentId, dl.shipmentId);
                                  }}
                                  data-testid={`button-copy-${dl.shipmentId}`}
                                >
                                  {copiedId === dl.shipmentId ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell>{getReasonBadge(dl.reason)}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <MapPin className="h-3 w-3" />
                                <span className="text-sm">{getShipToSummary(dl.data)}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <Calendar className="h-3 w-3" />
                                <span className="text-sm">{formatDate(dl.createdAt)}</span>
                              </div>
                            </TableCell>
                          </TableRow>
                          <CollapsibleContent asChild>
                            <TableRow className="bg-muted/30">
                              <TableCell colSpan={5} className="p-0">
                                <div className="p-4 space-y-4">
                                  <div className="grid grid-cols-2 gap-4">
                                    <div>
                                      <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                                        <MapPin className="h-4 w-4" />
                                        Ship To
                                      </h4>
                                      <div className="text-sm text-muted-foreground space-y-1">
                                        <p>{dl.data?.ship_to?.name || "No name"}</p>
                                        <p>{dl.data?.ship_to?.address_line1 || "No address"}</p>
                                        <p>
                                          {[
                                            dl.data?.ship_to?.city_locality,
                                            dl.data?.ship_to?.state_province,
                                            dl.data?.ship_to?.postal_code,
                                          ].filter(Boolean).join(", ")}
                                        </p>
                                        <p>Phone: {dl.data?.ship_to?.phone || "N/A"}</p>
                                      </div>
                                    </div>
                                    <div>
                                      <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                                        <Package className="h-4 w-4" />
                                        Package Info
                                      </h4>
                                      <div className="text-sm text-muted-foreground space-y-1">
                                        <p>Status: {dl.data?.shipment_status || "Unknown"}</p>
                                        <p>Items: {dl.data?.items?.length || 0}</p>
                                        <p>
                                          Weight: {dl.data?.total_weight?.value || "N/A"}{" "}
                                          {dl.data?.total_weight?.unit || ""}
                                        </p>
                                        {dl.data?.packages?.[0]?.dimensions && (
                                          <p>
                                            Dimensions: {dl.data.packages[0].dimensions.length}x
                                            {dl.data.packages[0].dimensions.width}x
                                            {dl.data.packages[0].dimensions.height}{" "}
                                            {dl.data.packages[0].dimensions.unit}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <div>
                                    <h4 className="text-sm font-medium mb-2">Raw JSON Data</h4>
                                    <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap">
                                      {JSON.stringify(dl.data, null, 2)}
                                    </pre>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          </CollapsibleContent>
                        </>
                      </Collapsible>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {data && data.totalPages > 1 && (
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to {Math.min(page * limit, data.total)} of {data.total}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(1)}
                      disabled={page === 1}
                      data-testid="button-first-page"
                    >
                      <ChevronsLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm px-2">
                      Page {page} of {data.totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                      disabled={page === data.totalPages}
                      data-testid="button-next-page"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setPage(data.totalPages)}
                      disabled={page === data.totalPages}
                      data-testid="button-last-page"
                    >
                      <ChevronsRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
