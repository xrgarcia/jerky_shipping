import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ClipboardList, RefreshCw, Loader2, Search, ChevronDown, ChevronRight, CheckCircle, XCircle, Package, Scan, FileCheck } from "lucide-react";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

const CST_TIMEZONE = 'America/Chicago';

interface PackingLog {
  id: string;
  createdAt: string;
  username: string;
  action: string;
  productSku: string | null;
  scannedCode: string | null;
  skuVaultProductId: string | null;
  success: boolean;
  errorMessage: string | null;
  skuVaultRawResponse: unknown | null;
}

interface PackingLogsResponse {
  orderNumber: string;
  totalLogs: number;
  logs: PackingLog[];
}

const extractUsername = (email: string) => {
  if (!email) return 'Unknown';
  return email.split('@')[0];
};

const formatDateTime = (dateStr: string) => {
  try {
    return formatInTimeZone(new Date(dateStr), CST_TIMEZONE, "MMM d, yyyy h:mm:ss a");
  } catch {
    return dateStr;
  }
};

const getActionBadgeVariant = (action: string, success: boolean): { variant: "default" | "secondary" | "destructive" | "outline"; className: string } => {
  if (!success) {
    return { variant: "destructive", className: "" };
  }
  
  switch (action) {
    case 'scan_order':
      return { variant: "default", className: "bg-blue-600 hover:bg-blue-700" };
    case 'scan_product':
      return { variant: "outline", className: "border-amber-500 text-amber-600" };
    case 'qc_pass':
      return { variant: "default", className: "bg-green-600 hover:bg-green-700" };
    case 'qc_fail':
      return { variant: "destructive", className: "" };
    case 'complete_order':
      return { variant: "default", className: "bg-purple-600 hover:bg-purple-700" };
    default:
      return { variant: "secondary", className: "" };
  }
};

const getActionIcon = (action: string) => {
  switch (action) {
    case 'scan_order':
      return <Package className="h-3 w-3 mr-1" />;
    case 'scan_product':
      return <Scan className="h-3 w-3 mr-1" />;
    case 'qc_pass':
      return <CheckCircle className="h-3 w-3 mr-1" />;
    case 'qc_fail':
      return <XCircle className="h-3 w-3 mr-1" />;
    case 'complete_order':
      return <FileCheck className="h-3 w-3 mr-1" />;
    default:
      return null;
  }
};

const formatActionLabel = (action: string) => {
  return action.replace(/_/g, ' ').toUpperCase();
};

function JsonViewer({ data, label }: { data: unknown; label: string }) {
  const [isOpen, setIsOpen] = useState(false);
  
  if (data === null || data === undefined) {
    return <span className="text-muted-foreground">-</span>;
  }
  
  const jsonString = JSON.stringify(data, null, 2);
  const isComplex = typeof data === 'object' && Object.keys(data as object).length > 2;
  
  if (!isComplex) {
    return (
      <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto max-w-md">
        {jsonString}
      </pre>
    );
  }
  
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700" data-testid={`button-expand-json-${label}`}>
        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {isOpen ? "Hide JSON" : "View JSON"}
        <Badge variant="outline" className="ml-2 text-xs">
          {Object.keys(data as object).length} fields
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-w-full whitespace-pre-wrap break-words">
          {jsonString}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function PackingLogsReport() {
  const [searchOrderNumber, setSearchOrderNumber] = useState('');
  const [orderNumber, setOrderNumber] = useState('');

  const { data, isLoading, refetch, isRefetching, isFetched } = useQuery<PackingLogsResponse>({
    queryKey: ['/api/reports/packing-logs', orderNumber],
    queryFn: async () => {
      const url = `/api/reports/packing-logs?orderNumber=${encodeURIComponent(orderNumber)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
    enabled: !!orderNumber,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchOrderNumber.trim()) {
      setOrderNumber(searchOrderNumber.trim());
    }
  };

  const handleClear = () => {
    setSearchOrderNumber('');
    setOrderNumber('');
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl font-bold text-foreground flex items-center gap-3" data-testid="text-page-title">
              <ClipboardList className="h-10 w-10 text-blue-500" />
              Packing Logs
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Search and view detailed packing logs by order number
            </p>
          </div>
          {orderNumber && (
            <Button
              variant="outline"
              onClick={() => refetch()}
              disabled={isRefetching}
              data-testid="button-refresh"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          )}
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Search className="h-5 w-5" />
              Search Order
            </CardTitle>
            <CardDescription>
              Enter an order number to view its packing logs
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSearch} className="flex items-end gap-4">
              <div className="space-y-2 flex-1 max-w-md">
                <Label htmlFor="order-number">Order Number</Label>
                <Input
                  id="order-number"
                  placeholder="e.g., JK3825350525"
                  value={searchOrderNumber}
                  onChange={(e) => setSearchOrderNumber(e.target.value)}
                  className="w-full"
                  data-testid="input-order-number"
                />
              </div>
              <Button type="submit" disabled={!searchOrderNumber.trim()} data-testid="button-search">
                <Search className="h-4 w-4 mr-2" />
                Search
              </Button>
              {orderNumber && (
                <Button type="button" variant="outline" onClick={handleClear} data-testid="button-clear">
                  Clear
                </Button>
              )}
            </form>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-3 text-lg text-muted-foreground">Loading packing logs...</span>
          </div>
        )}

        {isFetched && orderNumber && !isLoading && (
          <>
            {data && data.totalLogs > 0 ? (
              <>
                <Card className="border-blue-500/30 bg-blue-500/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Package className="h-5 w-5 text-blue-500" />
                      Order: {data.orderNumber}
                    </CardTitle>
                    <CardDescription>
                      {data.totalLogs} log entries found
                    </CardDescription>
                  </CardHeader>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-xl">
                      Log Entries
                    </CardTitle>
                    <CardDescription>
                      Chronological list of packing actions for this order
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="rounded-md border overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[180px]">Timestamp</TableHead>
                            <TableHead className="w-[120px]">User</TableHead>
                            <TableHead className="w-[140px]">Action</TableHead>
                            <TableHead className="w-[140px]">SKU</TableHead>
                            <TableHead className="w-[160px]">Scanned Code</TableHead>
                            <TableHead className="w-[80px]">Status</TableHead>
                            <TableHead>Error / Details</TableHead>
                            <TableHead>SkuVault Response</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.logs.map((log, index) => {
                            const actionStyle = getActionBadgeVariant(log.action, log.success);
                            return (
                              <TableRow key={log.id} data-testid={`row-log-${index}`}>
                                <TableCell className="text-sm whitespace-nowrap">
                                  {formatDateTime(log.createdAt)}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {extractUsername(log.username)}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge variant={actionStyle.variant} className={actionStyle.className}>
                                    {getActionIcon(log.action)}
                                    {formatActionLabel(log.action)}
                                  </Badge>
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                  {log.productSku || '-'}
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                  {log.scannedCode || '-'}
                                </TableCell>
                                <TableCell>
                                  {log.success ? (
                                    <Badge variant="outline" className="border-green-500 text-green-600">
                                      <CheckCircle className="h-3 w-3 mr-1" />
                                      Pass
                                    </Badge>
                                  ) : (
                                    <Badge variant="destructive">
                                      <XCircle className="h-3 w-3 mr-1" />
                                      Fail
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {log.errorMessage ? (
                                    <span className="text-red-600">{log.errorMessage}</span>
                                  ) : (
                                    log.skuVaultProductId ? (
                                      <span className="text-muted-foreground">ID: {log.skuVaultProductId}</span>
                                    ) : (
                                      <span className="text-muted-foreground">-</span>
                                    )
                                  )}
                                </TableCell>
                                <TableCell>
                                  <JsonViewer data={log.skuVaultRawResponse} label={log.id} />
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card>
                <CardContent className="py-12">
                  <div className="text-center text-muted-foreground">
                    <ClipboardList className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p className="text-lg font-medium">No packing logs found</p>
                    <p className="text-sm">No packing logs exist for order "{orderNumber}"</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {!orderNumber && !isLoading && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-muted-foreground">
                <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">Enter an order number to search</p>
                <p className="text-sm">Packing logs will be displayed here after searching</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
