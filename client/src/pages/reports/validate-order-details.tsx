import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarIcon, Search, AlertTriangle, CheckCircle2, XCircle, DollarSign } from "lucide-react";
import { subDays, parse } from "date-fns";
import { toZonedTime, formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ValidationResult {
  summary: {
    shopifyOrderCount: number;
    reportingOrderCount: number;
    missingInReportingCount: number;
    missingInShopifyCount: number;
    subtotalMismatchCount: number;
  };
  missingInReporting: Array<{
    orderNumber: string;
    createdAt: string | null;
    subtotalPrice: string;
  }>;
  missingInShopify: Array<{
    orderNumber: string;
    orderDate: string;
    subtotalPrice: string;
  }>;
  subtotalMismatches: Array<{
    orderNumber: string;
    shopifySubtotal: string;
    reportingSubtotal: string;
    difference: string;
    createdAt: string | null;
  }>;
}

export default function ValidateOrderDetails() {
  const CST_TIMEZONE = 'America/Chicago';
  
  const toCalendarDate = (dateStr: string): Date => {
    return parse(dateStr, 'yyyy-MM-dd', new Date());
  };
  
  const toCstDateString = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  
  const toCstMidnightUtc = (dateStr: string): Date => {
    return fromZonedTime(`${dateStr} 00:00:00`, CST_TIMEZONE);
  };
  
  const [startDateStr, setStartDateStr] = useState<string>(() => {
    const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
    const sevenDaysAgo = subDays(cstNow, 7);
    return formatInTimeZone(sevenDaysAgo, CST_TIMEZONE, 'yyyy-MM-dd');
  });
  
  const [endDateStr, setEndDateStr] = useState<string>(() => {
    const cstNow = toZonedTime(new Date(), CST_TIMEZONE);
    return formatInTimeZone(cstNow, CST_TIMEZONE, 'yyyy-MM-dd');
  });
  
  const [shouldFetch, setShouldFetch] = useState(false);

  const { data: result, isLoading, isFetching } = useQuery<ValidationResult>({
    queryKey: ['/api/reports/validate-orders', startDateStr, endDateStr],
    queryFn: async ({ queryKey }) => {
      const [endpoint, start, end] = queryKey as [string, string, string];
      const url = `${endpoint}?startDate=${start}&endDate=${end}`;
      const res = await fetch(url, { credentials: "include" });
      
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      
      return await res.json();
    },
    enabled: shouldFetch,
  });

  const formatCurrency = (value: string | number) => {
    const num = typeof value === 'number' ? value : (parseFloat(value) || 0);
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const handleAnalyze = () => {
    setShouldFetch(true);
  };

  const hasDifferences = result && (
    result.summary.missingInReportingCount > 0 ||
    result.summary.missingInShopifyCount > 0 ||
    result.summary.subtotalMismatchCount > 0
  );

  const missingInShopifyTotal = result?.missingInShopify.reduce(
    (sum, order) => sum + (parseFloat(order.subtotalPrice) || 0), 0
  ) || 0;

  const missingInReportingTotal = result?.missingInReporting.reduce(
    (sum, order) => sum + (parseFloat(order.subtotalPrice) || 0), 0
  ) || 0;

  const subtotalMismatchDifferenceTotal = result?.subtotalMismatches.reduce(
    (sum, order) => sum + (parseFloat(order.difference) || 0), 0
  ) || 0;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground" data-testid="text-page-title">
              Validate Order Details
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Compare orders between Shopify and Reporting databases
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Select Date Range</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4 items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium">Start Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-[240px] justify-start text-left"
                      data-testid="button-start-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formatInTimeZone(toCstMidnightUtc(startDateStr), CST_TIMEZONE, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={toCalendarDate(startDateStr)}
                      onSelect={(date) => {
                        if (date) {
                          setStartDateStr(toCstDateString(date));
                          setShouldFetch(false);
                        }
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">End Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-[240px] justify-start text-left"
                      data-testid="button-end-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formatInTimeZone(toCstMidnightUtc(endDateStr), CST_TIMEZONE, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={toCalendarDate(endDateStr)}
                      onSelect={(date) => {
                        if (date) {
                          setEndDateStr(toCstDateString(date));
                          setShouldFetch(false);
                        }
                      }}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <Button 
                onClick={handleAnalyze} 
                disabled={isLoading || isFetching}
                data-testid="button-analyze"
              >
                <Search className="mr-2 h-4 w-4" />
                {isLoading || isFetching ? "Analyzing..." : "Analyze"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {!shouldFetch && !result && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-muted-foreground">
                <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg">Select a date range and click Analyze to compare orders</p>
              </div>
            </CardContent>
          </Card>
        )}

        {(isLoading || isFetching) && (
          <Card>
            <CardContent className="py-12">
              <div className="text-center text-muted-foreground">
                <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                <p className="text-lg">Analyzing orders...</p>
              </div>
            </CardContent>
          </Card>
        )}

        {result && !isLoading && !isFetching && (
          <>
            {!hasDifferences ? (
              <Card>
                <CardContent className="py-8">
                  <div className="text-center">
                    <CheckCircle2 className="h-12 w-12 mx-auto mb-4 text-green-600" />
                    <p className="text-lg font-semibold text-green-600">All orders match!</p>
                    <p className="text-muted-foreground">No differences found between Shopify and Reporting databases.</p>
                    <p className="text-sm text-muted-foreground mt-2">
                      Shopify: {result.summary.shopifyOrderCount} orders | Reporting: {result.summary.reportingOrderCount} orders
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Tabs defaultValue="missing-shopify" className="space-y-4">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="missing-shopify" className="flex items-center gap-2" data-testid="tab-missing-shopify">
                    Missing in Shopify
                    {result.missingInShopify.length > 0 && (
                      <Badge variant="destructive" className="ml-1">{result.missingInShopify.length}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="missing-reporting" className="flex items-center gap-2" data-testid="tab-missing-reporting">
                    Missing in Reporting
                    {result.missingInReporting.length > 0 && (
                      <Badge variant="destructive" className="ml-1">{result.missingInReporting.length}</Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="mismatches" className="flex items-center gap-2" data-testid="tab-mismatches">
                    Subtotal Mismatches
                    {result.subtotalMismatches.length > 0 && (
                      <Badge variant="outline" className="ml-1 border-yellow-500 text-yellow-600">{result.subtotalMismatches.length}</Badge>
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="missing-shopify" className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card data-testid="card-missing-shopify-count">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Orders Missing</CardTitle>
                        <XCircle className="h-4 w-4 text-destructive" />
                      </CardHeader>
                      <CardContent>
                        <div className={`text-2xl font-bold ${result.missingInShopify.length > 0 ? 'text-destructive' : 'text-green-600'}`}>
                          {result.missingInShopify.length}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Orders in Reporting DB but not in Shopify DB
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-missing-shopify-total">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Subtotal Value</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold">
                          {formatCurrency(missingInShopifyTotal)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Sum of missing order subtotals
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-reporting-total">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Reporting DB Orders</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold">{result.summary.reportingOrderCount}</div>
                        <p className="text-xs text-muted-foreground">
                          Total orders in reporting database
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {result.missingInShopify.length > 0 ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                          Orders in Reporting DB Missing from Shopify
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="rounded-md border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Order Number</TableHead>
                                <TableHead>Order Date</TableHead>
                                <TableHead className="text-right">Subtotal</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {result.missingInShopify.map((order) => (
                                <TableRow key={order.orderNumber} data-testid={`row-missing-shopify-${order.orderNumber}`}>
                                  <TableCell className="font-mono font-medium">{order.orderNumber}</TableCell>
                                  <TableCell>{order.orderDate}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(order.subtotalPrice)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="py-8">
                        <div className="text-center">
                          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
                          <p className="text-muted-foreground">No orders missing from Shopify database</p>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="missing-reporting" className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card data-testid="card-missing-reporting-count">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Orders Missing</CardTitle>
                        <XCircle className="h-4 w-4 text-destructive" />
                      </CardHeader>
                      <CardContent>
                        <div className={`text-2xl font-bold ${result.missingInReporting.length > 0 ? 'text-destructive' : 'text-green-600'}`}>
                          {result.missingInReporting.length}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Orders in Shopify DB but not in Reporting DB
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-missing-reporting-total">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Subtotal Value</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold">
                          {formatCurrency(missingInReportingTotal)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Sum of missing order subtotals
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-shopify-total">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Shopify DB Orders</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold">{result.summary.shopifyOrderCount}</div>
                        <p className="text-xs text-muted-foreground">
                          Total orders in Shopify database
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {result.missingInReporting.length > 0 ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                          Orders in Shopify DB Missing from Reporting
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="rounded-md border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Order Number</TableHead>
                                <TableHead>Created At (CST)</TableHead>
                                <TableHead className="text-right">Subtotal</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {result.missingInReporting.map((order) => (
                                <TableRow key={order.orderNumber} data-testid={`row-missing-reporting-${order.orderNumber}`}>
                                  <TableCell className="font-mono font-medium">{order.orderNumber}</TableCell>
                                  <TableCell>{order.createdAt || '-'}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(order.subtotalPrice)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="py-8">
                        <div className="text-center">
                          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
                          <p className="text-muted-foreground">No orders missing from Reporting database</p>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="mismatches" className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card data-testid="card-mismatch-count">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Mismatched Orders</CardTitle>
                        <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      </CardHeader>
                      <CardContent>
                        <div className={`text-2xl font-bold ${result.subtotalMismatches.length > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
                          {result.subtotalMismatches.length}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Orders with different subtotals
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-mismatch-difference">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Difference</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <div className={`text-2xl font-bold ${subtotalMismatchDifferenceTotal >= 0 ? 'text-green-600' : 'text-destructive'}`}>
                          {subtotalMismatchDifferenceTotal >= 0 ? '+' : ''}{formatCurrency(subtotalMismatchDifferenceTotal)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Shopify - Reporting sum
                        </p>
                      </CardContent>
                    </Card>

                    <Card data-testid="card-matched-orders">
                      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Matched Orders</CardTitle>
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl font-bold text-green-600">
                          {Math.min(result.summary.shopifyOrderCount, result.summary.reportingOrderCount) - 
                           result.summary.missingInShopifyCount - 
                           result.summary.missingInReportingCount - 
                           result.summary.subtotalMismatchCount}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Orders with matching subtotals
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {result.subtotalMismatches.length > 0 ? (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                          Orders with Subtotal Differences
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="rounded-md border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Order Number</TableHead>
                                <TableHead>Created At (CST)</TableHead>
                                <TableHead className="text-right">Shopify Subtotal</TableHead>
                                <TableHead className="text-right">Reporting Subtotal</TableHead>
                                <TableHead className="text-right">Difference</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {result.subtotalMismatches.map((order) => (
                                <TableRow key={order.orderNumber} data-testid={`row-mismatch-${order.orderNumber}`}>
                                  <TableCell className="font-mono font-medium">{order.orderNumber}</TableCell>
                                  <TableCell>{order.createdAt || '-'}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(order.shopifySubtotal)}</TableCell>
                                  <TableCell className="text-right">{formatCurrency(order.reportingSubtotal)}</TableCell>
                                  <TableCell className={`text-right font-semibold ${parseFloat(order.difference) > 0 ? 'text-green-600' : 'text-destructive'}`}>
                                    {parseFloat(order.difference) > 0 ? '+' : ''}{formatCurrency(order.difference)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="py-8">
                        <div className="text-center">
                          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
                          <p className="text-muted-foreground">All matching orders have identical subtotals</p>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              </Tabs>
            )}
          </>
        )}
      </div>
    </div>
  );
}
