import { useState, useEffect } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ClipboardList, RefreshCw, Loader2, Search, CheckCircle, XCircle, Package, Scan, FileCheck, Eye, Copy, Sparkles, Truck, ChevronDown } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { useToast } from "@/hooks/use-toast";

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
  shipmentId: string | null;
  totalLogs: number;
  logs: PackingLog[];
}

interface ShipmentItem {
  id: string;
  sku: string | null;
  name: string;
  quantity: number;
  imageUrl: string | null;
}

interface ShipmentWithItems {
  id: string;
  shipmentId: string;
  trackingNumber: string | null;
  carrier: string | null;
  serviceCode: string | null;
  status: string | null;
  createdAt: string;
  items: ShipmentItem[];
}

interface ShipmentsByOrderResponse {
  orderNumber: string;
  shipments: ShipmentWithItems[];
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

const generateAIPrompt = (log: PackingLog, orderNumber: string): string => {
  const timestamp = formatDateTime(log.createdAt);
  const jsonResponse = log.skuVaultRawResponse 
    ? JSON.stringify(log.skuVaultRawResponse, null, 2)
    : 'No SkuVault response data';
  
  return `You are diagnosing a packing log anomaly in a warehouse fulfillment system. Please analyze the following log entry and help identify potential issues or explain what happened.

## Context
This log is from a warehouse packing station where workers scan orders and products for quality control (QC) validation against SkuVault inventory system.

## Log Entry Details

**Order Number:** ${orderNumber}
**Log ID:** ${log.id}
**Timestamp (CST):** ${timestamp}
**User:** ${extractUsername(log.username)}
**Action Type:** ${formatActionLabel(log.action)}
**Success:** ${log.success ? 'Yes' : 'No'}
**Product SKU:** ${log.productSku || 'N/A'}
**Scanned Barcode:** ${log.scannedCode || 'N/A'}
**SkuVault Product ID:** ${log.skuVaultProductId || 'N/A'}
**Error Message:** ${log.errorMessage || 'None'}

## SkuVault Raw Response
\`\`\`json
${jsonResponse}
\`\`\`

## Questions to Answer
1. What does this log entry indicate happened during packing?
2. If this is a failure, what is the likely root cause?
3. What steps should the warehouse team take to resolve this issue?
4. Are there any patterns or red flags in the SkuVault response that suggest configuration issues?

Please provide a clear, actionable analysis.`;
};

const generateAllLogsAIPrompt = (logs: PackingLog[], orderNumber: string): string => {
  const successCount = logs.filter(l => l.success).length;
  const failureCount = logs.filter(l => !l.success).length;
  
  const actionCounts: Record<string, number> = {};
  logs.forEach(log => {
    const action = formatActionLabel(log.action);
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  });
  const actionSummary = Object.entries(actionCounts)
    .map(([action, count]) => `${count}× ${action}`)
    .join(', ');
  
  const patterns: string[] = [];
  
  const completeOrderCount = logs.filter(l => l.action === 'complete_order' || l.action === 'complete_order_success').length;
  if (completeOrderCount > 1) {
    patterns.push(`Order was completed ${completeOrderCount} times (possible reprints or retries)`);
  }
  
  const failedBarcodes = logs.filter(l => !l.success && l.scannedCode).map(l => l.scannedCode);
  const barcodeCounts: Record<string, number> = {};
  failedBarcodes.forEach(code => {
    if (code) barcodeCounts[code] = (barcodeCounts[code] || 0) + 1;
  });
  Object.entries(barcodeCounts).forEach(([code, count]) => {
    if (count > 1) {
      patterns.push(`Same invalid barcode "${code}" scanned ${count} times`);
    }
  });
  
  const failedLogs = logs.filter(l => !l.success);
  if (failedLogs.length > 1) {
    const failedUsers = Array.from(new Set(failedLogs.map(l => extractUsername(l.username))));
    if (failedUsers.length === 1) {
      patterns.push(`All ${failedLogs.length} failures by same user: ${failedUsers[0]}`);
    }
  }
  
  const timingGaps: string[] = [];
  for (let i = 1; i < logs.length; i++) {
    const prevTime = new Date(logs[i - 1].createdAt).getTime();
    const currTime = new Date(logs[i].createdAt).getTime();
    const gapMinutes = (currTime - prevTime) / 60000;
    if (gapMinutes >= 5) {
      timingGaps.push(`${Math.round(gapMinutes)} min gap between Entry ${i} and Entry ${i + 1}`);
    }
  }
  
  let durationStr = '';
  if (logs.length >= 2) {
    const firstTime = new Date(logs[0].createdAt).getTime();
    const lastTime = new Date(logs[logs.length - 1].createdAt).getTime();
    const totalMinutes = Math.round((lastTime - firstTime) / 60000);
    durationStr = totalMinutes >= 60 
      ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
      : `${totalMinutes} minutes`;
  }
  
  const logEntries = logs.map((log, index) => {
    const timestamp = formatDateTime(log.createdAt);
    const jsonResponse = log.skuVaultRawResponse 
      ? JSON.stringify(log.skuVaultRawResponse, null, 2)
      : 'No data';
    
    return `### Entry ${index + 1}
- **Timestamp:** ${timestamp}
- **User:** ${extractUsername(log.username)}
- **Action:** ${formatActionLabel(log.action)}
- **Success:** ${log.success ? 'Yes' : 'No'}
- **SKU:** ${log.productSku || 'N/A'}
- **Scanned Barcode:** ${log.scannedCode || 'N/A'}
- **SkuVault Product ID:** ${log.skuVaultProductId || 'N/A'}
- **Error:** ${log.errorMessage || 'None'}
- **SkuVault Response:** \`${jsonResponse === 'No data' ? jsonResponse : 'See below'}\`
${jsonResponse !== 'No data' ? `\`\`\`json\n${jsonResponse}\n\`\`\`` : ''}`;
  }).join('\n\n');

  const patternsSection = patterns.length > 0 
    ? `\n## Detected Patterns\n${patterns.map(p => `- ${p}`).join('\n')}\n` 
    : '';
  
  const timingSection = timingGaps.length > 0
    ? `\n## Significant Timing Gaps\n${timingGaps.map(t => `- ${t}`).join('\n')}\n`
    : '';

  return `You are analyzing packing logs from a warehouse fulfillment system. Please review all log entries for this order and provide a comprehensive analysis.

## Context
These logs are from a warehouse packing station where workers scan orders and products for quality control (QC) validation against SkuVault inventory system.

## Order Summary

**Order Number:** ${orderNumber}
**Total Log Entries:** ${logs.length}
**Successful Actions:** ${successCount}
**Failed Actions:** ${failureCount}
${durationStr ? `**Total Duration:** ${durationStr}` : ''}

## Action Breakdown
${actionSummary}
${patternsSection}${timingSection}
## All Log Entries (Chronological)

${logEntries}

## Questions to Answer

1. **Timeline Analysis:** What is the sequence of events that occurred during packing?
2. **Failure Patterns:** Are there any patterns in the failures? (e.g., same user, same SKU, same error type)
3. **Root Cause:** If there are failures, what is the likely root cause?
4. **User Behavior:** Did any workers scan the wrong items or make procedural errors?
5. **System Issues:** Are there any red flags suggesting system configuration problems?
6. **Recommendations:** What steps should the warehouse team take to prevent similar issues?

Please provide a clear, actionable analysis with specific recommendations.`;
};

function LogDetailsModal({ 
  log, 
  orderNumber, 
  isOpen, 
  onClose 
}: { 
  log: PackingLog | null; 
  orderNumber: string;
  isOpen: boolean; 
  onClose: () => void;
}) {
  const { toast } = useToast();
  
  if (!log) return null;
  
  const actionStyle = getActionBadgeVariant(log.action, log.success);
  const jsonString = log.skuVaultRawResponse 
    ? JSON.stringify(log.skuVaultRawResponse, null, 2) 
    : null;
  
  const handleCopyForAI = async () => {
    const prompt = generateAIPrompt(log, orderNumber);
    
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(prompt);
        toast({
          title: "Copied to clipboard",
          description: "AI analysis prompt copied. Paste it into ChatGPT or Claude to analyze.",
        });
        return;
      } catch (error) {
        console.warn('Clipboard API failed, falling back to textarea method:', error);
      }
    }
    
    try {
      const textArea = document.createElement('textarea');
      textArea.value = prompt;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (successful) {
        toast({
          title: "Copied to clipboard",
          description: "AI analysis prompt copied. Paste it into ChatGPT or Claude to analyze.",
        });
      } else {
        throw new Error('execCommand copy failed');
      }
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Your browser doesn't support clipboard access.",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Log Entry Details
          </DialogTitle>
          <DialogDescription>
            Full details for this packing log entry
          </DialogDescription>
        </DialogHeader>
        
        <ScrollArea className="flex-1 overflow-auto pr-4">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs">Timestamp</Label>
                <p className="font-medium">{formatDateTime(log.createdAt)}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">User</Label>
                <p className="font-medium">{extractUsername(log.username)}</p>
              </div>
            </div>
            
            <Separator />
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs">Action</Label>
                <div className="mt-1">
                  <Badge variant={actionStyle.variant} className={actionStyle.className}>
                    {getActionIcon(log.action)}
                    {formatActionLabel(log.action)}
                  </Badge>
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Status</Label>
                <div className="mt-1">
                  {log.success ? (
                    <Badge variant="outline" className="border-green-500 text-green-600">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Success
                    </Badge>
                  ) : (
                    <Badge variant="destructive">
                      <XCircle className="h-3 w-3 mr-1" />
                      Failed
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            
            <Separator />
            
            <div className="space-y-3">
              <div>
                <Label className="text-muted-foreground text-xs">Product SKU</Label>
                <p className="font-mono">{log.productSku || 'N/A'}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Scanned Code</Label>
                <p className="font-mono">{log.scannedCode || 'N/A'}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">SkuVault Product ID</Label>
                <p className="font-mono">{log.skuVaultProductId || 'N/A'}</p>
              </div>
            </div>
            
            {log.errorMessage && (
              <>
                <Separator />
                <div>
                  <Label className="text-muted-foreground text-xs">Error Message</Label>
                  <p className="text-destructive font-medium">{log.errorMessage}</p>
                </div>
              </>
            )}
            
            {jsonString && (
              <>
                <Separator />
                <div>
                  <Label className="text-muted-foreground text-xs">SkuVault Raw Response</Label>
                  <div className="bg-muted rounded-md p-3 max-h-64 overflow-auto">
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                      {jsonString}
                    </pre>
                  </div>
                </div>
              </>
            )}
          </div>
        </ScrollArea>
        
        <DialogFooter className="flex-shrink-0 gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={handleCopyForAI}
            className="gap-2"
            data-testid="button-copy-ai"
          >
            <Sparkles className="h-4 w-4" />
            Copy for AI Analysis
          </Button>
          <Button variant="secondary" onClick={onClose} data-testid="button-close-modal">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PackingLogsReport() {
  const { toast } = useToast();
  const [searchOrderNumber, setSearchOrderNumber] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<PackingLog | null>(null);

  const { data: shipmentsData, isLoading: isLoadingShipments, isFetched: isShipmentsFetched } = useQuery<ShipmentsByOrderResponse>({
    queryKey: ['/api/reports/shipments-by-order', orderNumber],
    queryFn: async () => {
      const url = `/api/reports/shipments-by-order?orderNumber=${encodeURIComponent(orderNumber)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
    enabled: !!orderNumber,
  });

  useEffect(() => {
    if (shipmentsData?.shipments?.length && !selectedShipmentId) {
      setSelectedShipmentId(shipmentsData.shipments[0].id);
    }
  }, [shipmentsData, selectedShipmentId]);

  const selectedShipment = shipmentsData?.shipments?.find(s => s.id === selectedShipmentId);

  const { data: logsData, isLoading: isLoadingLogs, refetch, isRefetching, isFetched: isLogsFetched } = useQuery<PackingLogsResponse>({
    queryKey: ['/api/reports/packing-logs', orderNumber, selectedShipmentId],
    queryFn: async () => {
      let url = `/api/reports/packing-logs?orderNumber=${encodeURIComponent(orderNumber)}`;
      if (selectedShipmentId) {
        url += `&shipmentId=${encodeURIComponent(selectedShipmentId)}`;
      }
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return await res.json();
    },
    enabled: !!orderNumber && !!selectedShipmentId,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchOrderNumber.trim()) {
      setSelectedShipmentId(null);
      setOrderNumber(searchOrderNumber.trim());
    }
  };

  const handleClear = () => {
    setSearchOrderNumber('');
    setOrderNumber('');
    setSelectedShipmentId(null);
  };

  const handleCopyAllForAI = async (logs: PackingLog[], orderNum: string) => {
    const prompt = generateAllLogsAIPrompt(logs, orderNum);
    
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(prompt);
        toast({
          title: "Copied to clipboard",
          description: `AI analysis prompt for all ${logs.length} logs copied. Paste it into ChatGPT or Claude.`,
        });
        return;
      } catch (error) {
        console.warn('Clipboard API failed, falling back to textarea method:', error);
      }
    }
    
    try {
      const textArea = document.createElement('textarea');
      textArea.value = prompt;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (successful) {
        toast({
          title: "Copied to clipboard",
          description: `AI analysis prompt for all ${logs.length} logs copied. Paste it into ChatGPT or Claude.`,
        });
      } else {
        throw new Error('execCommand copy failed');
      }
    } catch (error) {
      toast({
        title: "Copy failed",
        description: "Your browser doesn't support clipboard access. Please manually select and copy the text.",
        variant: "destructive",
      });
    }
  };

  const isLoading = isLoadingShipments || isLoadingLogs;
  const shipments = shipmentsData?.shipments || [];
  const hasMultipleShipments = shipments.length > 1;

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
          {orderNumber && selectedShipmentId && (
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

        {isLoadingShipments && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-3 text-lg text-muted-foreground">Loading shipments...</span>
          </div>
        )}

        {isShipmentsFetched && orderNumber && !isLoadingShipments && shipments.length > 0 && (
          <>
            <Card className="border-blue-500/30 bg-blue-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="h-5 w-5 text-blue-500" />
                  Order: {shipmentsData?.orderNumber}
                </CardTitle>
                <CardDescription>
                  {shipments.length} shipment{shipments.length > 1 ? 's' : ''} found
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasMultipleShipments && (
                  <div className="space-y-2">
                    <Label>Select Shipment</Label>
                    <Select
                      value={selectedShipmentId || ''}
                      onValueChange={(value) => setSelectedShipmentId(value)}
                    >
                      <SelectTrigger className="w-full max-w-md" data-testid="select-shipment">
                        <SelectValue placeholder="Select a shipment" />
                      </SelectTrigger>
                      <SelectContent>
                        {shipments.map((shipment, index) => (
                          <SelectItem key={shipment.id} value={shipment.id} data-testid={`option-shipment-${index}`}>
                            <div className="flex items-center gap-2">
                              <Truck className="h-4 w-4" />
                              <span className="font-mono text-sm">{shipment.shipmentId}</span>
                              {shipment.trackingNumber && (
                                <span className="text-muted-foreground text-xs">
                                  ({shipment.trackingNumber})
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {selectedShipment && (
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="items" className="border rounded-md px-4">
                      <AccordionTrigger className="hover:no-underline" data-testid="accordion-items">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4" />
                          <span>Shipment Items ({selectedShipment.items.length})</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2 pt-2">
                          {selectedShipment.items.map((item, index) => (
                            <div 
                              key={item.id} 
                              className="flex items-center gap-3 p-2 rounded-md bg-muted/50"
                              data-testid={`item-${index}`}
                            >
                              {item.imageUrl && (
                                <img 
                                  src={item.imageUrl} 
                                  alt={item.name}
                                  className="w-10 h-10 object-cover rounded"
                                />
                              )}
                              <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{item.name}</p>
                                <p className="text-sm text-muted-foreground font-mono">
                                  {item.sku || 'No SKU'}
                                </p>
                              </div>
                              <Badge variant="secondary">
                                Qty: {item.quantity}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                )}

                {!hasMultipleShipments && selectedShipment && (
                  <div className="text-sm text-muted-foreground">
                    <span className="font-mono">{selectedShipment.shipmentId}</span>
                    {selectedShipment.trackingNumber && (
                      <span> - Tracking: {selectedShipment.trackingNumber}</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {isLoadingLogs && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <span className="ml-3 text-lg text-muted-foreground">Loading packing logs...</span>
              </div>
            )}

            {isLogsFetched && !isLoadingLogs && logsData && (
              <>
                {logsData.totalLogs > 0 ? (
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                      <div>
                        <CardTitle className="text-xl">
                          Log Entries
                        </CardTitle>
                        <CardDescription>
                          {logsData.totalLogs} log entries for this shipment. Click "View" to see full details.
                        </CardDescription>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => handleCopyAllForAI(logsData.logs, logsData.orderNumber)}
                        data-testid="button-copy-all-ai"
                      >
                        <Sparkles className="h-4 w-4 mr-2" />
                        Copy All for AI Analysis
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <div className="rounded-md border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[180px]">Timestamp</TableHead>
                              <TableHead className="w-[100px]">User</TableHead>
                              <TableHead className="w-[140px]">Action</TableHead>
                              <TableHead className="w-[140px]">SKU</TableHead>
                              <TableHead className="w-[80px]">Status</TableHead>
                              <TableHead className="w-[80px] text-right">Details</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {logsData.logs.map((log, index) => {
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
                                  <TableCell className="text-right">
                                    <Button 
                                      size="sm" 
                                      variant="ghost"
                                      onClick={() => setSelectedLog(log)}
                                      data-testid={`button-view-${index}`}
                                    >
                                      <Eye className="h-4 w-4 mr-1" />
                                      View
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="py-12">
                      <div className="text-center text-muted-foreground">
                        <ClipboardList className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p className="text-lg font-medium">No packing logs found</p>
                        <p className="text-sm">No packing logs exist for this shipment</p>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </>
        )}

        {isShipmentsFetched && orderNumber && !isLoadingShipments && shipments.length === 0 && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-muted-foreground">
                <ClipboardList className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">No shipments found</p>
                <p className="text-sm">No shipments exist for order "{orderNumber}"</p>
              </div>
            </CardContent>
          </Card>
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
      
      <LogDetailsModal
        log={selectedLog}
        orderNumber={logsData?.orderNumber || orderNumber}
        isOpen={!!selectedLog}
        onClose={() => setSelectedLog(null)}
      />
    </div>
  );
}
