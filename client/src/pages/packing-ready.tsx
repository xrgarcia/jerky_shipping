import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Search, RefreshCw, Database, Package, CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface PassedItem {
  KitId?: string | null;
  Code?: string | null;
  ScannedCode?: string | null;
  Sku: string;
  Quantity: number;
  ItemId?: string | null;
  UserName?: string | null;
  DateTimeUtc?: string | null;
}

interface QCSaleItem {
  Sku: string;
  Quantity: number;
  Code?: string | null;
  ItemId?: string | null;
}

interface QCSaleData {
  SaleId: string;
  OrderId: string;
  Status: string;
  TotalItems: number;
  ItemsCount: number;
  PassedItemsCount: number;
  PassedItems: PassedItem[];
  Items: QCSaleItem[];
}

interface ShipmentInfo {
  id: string;
  shipmentId: string;
  orderNumber: string;
  sessionStatus: string;
  trackingNumber: string | null;
  qcCompleted: boolean;
  shipmentStatus: string;
}

interface CacheDebugData {
  orderNumber: string;
  cachedAt: string | null;
  warmedAt: string | null;
  defaultQcSale: QCSaleData | null;
  qcSalesByShipment: Record<string, QCSaleData>;
  shippableShipments: any[];
  defaultShipmentId: string | null;
  shippableReason: string | null;
  databaseShipments: ShipmentInfo[];
  lookupMapKeys: string[];
  lookupMapsByShipmentKeys: Record<string, string[]>;
}

export default function PackingReadyPage() {
  const [searchOrder, setSearchOrder] = useState("");
  const [submittedOrder, setSubmittedOrder] = useState<string | null>(null);

  const { data: cacheData, isLoading, error, refetch, isRefetching } = useQuery<CacheDebugData>({
    queryKey: ["/api/packing/cache-debug", submittedOrder],
    queryFn: async () => {
      if (!submittedOrder) return null;
      const response = await apiRequest("GET", `/api/packing/cache-debug/${encodeURIComponent(submittedOrder)}`);
      return response.json();
    },
    enabled: !!submittedOrder,
    retry: false,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchOrder.trim()) {
      setSubmittedOrder(searchOrder.trim());
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "N/A";
    return new Date(dateStr).toLocaleString();
  };

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Packing Ready - Cache Debug</h1>
        <p className="text-muted-foreground">
          View cached SkuVault QCSale data to debug packing issues. Enter an order number to see what's in the cache.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Search Order Cache
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              data-testid="input-order-search"
              placeholder="Enter order number (e.g., TEST-121025-RG)"
              value={searchOrder}
              onChange={(e) => setSearchOrder(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" data-testid="button-search" disabled={isLoading || isRefetching}>
              {(isLoading || isRefetching) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              <span className="ml-2">Search</span>
            </Button>
            {submittedOrder && (
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => refetch()}
                data-testid="button-refresh"
                disabled={isRefetching}
              >
                <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="mb-6 border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">
                {(error as any)?.message || "Failed to load cache data"}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {cacheData && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Cache Overview: {cacheData.orderNumber}
              </CardTitle>
              <CardDescription>
                Cached at: {formatDate(cacheData.cachedAt)} | Warmed at: {formatDate(cacheData.warmedAt)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div className="bg-muted p-3 rounded-md">
                  <div className="text-sm text-muted-foreground">Shippable Reason</div>
                  <div className="font-medium">{cacheData.shippableReason || "N/A"}</div>
                </div>
                <div className="bg-muted p-3 rounded-md">
                  <div className="text-sm text-muted-foreground">Default Shipment ID</div>
                  <div className="font-mono text-xs break-all">{cacheData.defaultShipmentId || "N/A"}</div>
                </div>
                <div className="bg-muted p-3 rounded-md">
                  <div className="text-sm text-muted-foreground">Shippable Shipments</div>
                  <div className="font-medium">{cacheData.shippableShipments?.length ?? 0}</div>
                </div>
                <div className="bg-muted p-3 rounded-md">
                  <div className="text-sm text-muted-foreground">QCSales by Shipment</div>
                  <div className="font-medium">{Object.keys(cacheData.qcSalesByShipment || {}).length}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Database Shipments
              </CardTitle>
              <CardDescription>
                All shipments for this order from PostgreSQL
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {cacheData.databaseShipments.map((shipment) => (
                  <div 
                    key={shipment.id} 
                    className="border rounded-md p-3 flex flex-wrap items-center gap-3"
                    data-testid={`shipment-row-${shipment.id}`}
                  >
                    <div className="flex-1 min-w-[200px]">
                      <div className="font-mono text-xs text-muted-foreground">{shipment.id}</div>
                      <div className="font-medium">ShipStation: {shipment.shipmentId}</div>
                    </div>
                    <Badge variant={shipment.trackingNumber ? "default" : "secondary"}>
                      {shipment.trackingNumber ? "Has Tracking" : "No Tracking"}
                    </Badge>
                    <Badge variant={shipment.qcCompleted ? "default" : "outline"}>
                      {shipment.qcCompleted ? (
                        <><CheckCircle className="h-3 w-3 mr-1" /> QC Complete</>
                      ) : (
                        <><XCircle className="h-3 w-3 mr-1" /> QC Pending</>
                      )}
                    </Badge>
                    <Badge variant="outline">{shipment.sessionStatus || "no session"}</Badge>
                    <Badge variant="outline">{shipment.shipmentStatus || "unknown"}</Badge>
                    {cacheData.qcSalesByShipment[shipment.id] && (
                      <Badge variant="default" className="bg-green-600">
                        Has Cache Entry
                      </Badge>
                    )}
                    {!cacheData.qcSalesByShipment[shipment.id] && (
                      <Badge variant="destructive">
                        No Cache Entry
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Default QCSale (Backward Compat)</CardTitle>
              <CardDescription>
                This is used when no shipment-specific cache entry is found
              </CardDescription>
            </CardHeader>
            <CardContent>
              {cacheData.defaultQcSale ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-muted p-2 rounded">
                      <div className="text-xs text-muted-foreground">SaleId</div>
                      <div className="font-mono text-xs break-all">{cacheData.defaultQcSale.SaleId}</div>
                    </div>
                    <div className="bg-muted p-2 rounded">
                      <div className="text-xs text-muted-foreground">Status</div>
                      <div className="font-medium">{cacheData.defaultQcSale.Status}</div>
                    </div>
                    <div className="bg-muted p-2 rounded">
                      <div className="text-xs text-muted-foreground">Total Items</div>
                      <div className="font-medium">{cacheData.defaultQcSale.TotalItems}</div>
                    </div>
                    <div className="bg-muted p-2 rounded">
                      <div className="text-xs text-muted-foreground">Passed Items Count</div>
                      <div className="font-medium text-green-600">{cacheData.defaultQcSale.PassedItemsCount}</div>
                    </div>
                  </div>
                  
                  <Accordion type="multiple" className="w-full">
                    <AccordionItem value="default-items">
                      <AccordionTrigger>
                        Expected Items ({cacheData.defaultQcSale.ItemsCount})
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2">
                          {cacheData.defaultQcSale.Items.map((item, idx) => (
                            <div key={idx} className="flex items-center gap-2 text-sm border-b pb-2">
                              <span className="font-mono">{item.Sku}</span>
                              <Badge variant="outline">x{item.Quantity}</Badge>
                              {item.Code && <span className="text-muted-foreground">Code: {item.Code}</span>}
                            </div>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                    <AccordionItem value="default-passed">
                      <AccordionTrigger>
                        Passed Items ({cacheData.defaultQcSale.PassedItemsCount})
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-2">
                          {cacheData.defaultQcSale.PassedItems.length === 0 ? (
                            <div className="text-muted-foreground text-sm">No items have been scanned yet</div>
                          ) : (
                            cacheData.defaultQcSale.PassedItems.map((item, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-sm border-b pb-2">
                                <CheckCircle className="h-4 w-4 text-green-600" />
                                <span className="font-mono">{item.Sku}</span>
                                <Badge variant="outline">x{item.Quantity}</Badge>
                                {item.ScannedCode && <span className="text-muted-foreground">Scanned: {item.ScannedCode}</span>}
                                {item.UserName && <span className="text-muted-foreground">By: {item.UserName}</span>}
                                {item.DateTimeUtc && (
                                  <span className="text-xs text-muted-foreground">
                                    {new Date(item.DateTimeUtc).toLocaleString()}
                                  </span>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </div>
              ) : (
                <div className="text-muted-foreground">No default QCSale data</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>QCSales By Shipment (Multi-Shipment Support)</CardTitle>
              <CardDescription>
                Each shipment should have its own QCSale with separate PassedItems
              </CardDescription>
            </CardHeader>
            <CardContent>
              {Object.keys(cacheData.qcSalesByShipment).length === 0 ? (
                <div className="text-muted-foreground">No shipment-specific QCSale data found</div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(cacheData.qcSalesByShipment).map(([shipmentId, qcSale]) => {
                    const dbShipment = cacheData.databaseShipments.find(s => s.id === shipmentId);
                    return (
                      <div key={shipmentId} className="border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <div className="font-medium">Shipment: {dbShipment?.shipmentId || shipmentId}</div>
                            <div className="font-mono text-xs text-muted-foreground">{shipmentId}</div>
                          </div>
                          <div className="flex gap-2">
                            {dbShipment?.trackingNumber && (
                              <Badge variant="default">Has Tracking</Badge>
                            )}
                            {dbShipment?.qcCompleted && (
                              <Badge variant="default" className="bg-green-600">QC Complete</Badge>
                            )}
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                          <div className="bg-muted p-2 rounded">
                            <div className="text-xs text-muted-foreground">SaleId</div>
                            <div className="font-mono text-xs break-all">{qcSale.SaleId}</div>
                          </div>
                          <div className="bg-muted p-2 rounded">
                            <div className="text-xs text-muted-foreground">Status</div>
                            <div className="font-medium">{qcSale.Status}</div>
                          </div>
                          <div className="bg-muted p-2 rounded">
                            <div className="text-xs text-muted-foreground">Expected Items</div>
                            <div className="font-medium">{qcSale.ItemsCount}</div>
                          </div>
                          <div className="bg-muted p-2 rounded">
                            <div className="text-xs text-muted-foreground">Passed Items</div>
                            <div className="font-medium text-green-600">{qcSale.PassedItemsCount}</div>
                          </div>
                        </div>
                        
                        <Accordion type="multiple" className="w-full">
                          <AccordionItem value={`${shipmentId}-items`}>
                            <AccordionTrigger className="text-sm">
                              Expected Items ({qcSale.ItemsCount})
                            </AccordionTrigger>
                            <AccordionContent>
                              <div className="space-y-2">
                                {qcSale.Items.map((item, idx) => (
                                  <div key={idx} className="flex items-center gap-2 text-sm border-b pb-2">
                                    <span className="font-mono">{item.Sku}</span>
                                    <Badge variant="outline">x{item.Quantity}</Badge>
                                    {item.Code && <span className="text-muted-foreground">Code: {item.Code}</span>}
                                  </div>
                                ))}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                          <AccordionItem value={`${shipmentId}-passed`}>
                            <AccordionTrigger className="text-sm">
                              Passed Items ({qcSale.PassedItemsCount})
                            </AccordionTrigger>
                            <AccordionContent>
                              <div className="space-y-2">
                                {qcSale.PassedItems.length === 0 ? (
                                  <div className="text-muted-foreground text-sm">No items have been scanned yet for this shipment</div>
                                ) : (
                                  qcSale.PassedItems.map((item, idx) => (
                                    <div key={idx} className="flex items-center gap-2 text-sm border-b pb-2">
                                      <CheckCircle className="h-4 w-4 text-green-600" />
                                      <span className="font-mono">{item.Sku}</span>
                                      <Badge variant="outline">x{item.Quantity}</Badge>
                                      {item.ScannedCode && <span className="text-muted-foreground">Scanned: {item.ScannedCode}</span>}
                                      {item.UserName && <span className="text-muted-foreground">By: {item.UserName}</span>}
                                      {item.DateTimeUtc && (
                                        <span className="text-xs text-muted-foreground">
                                          {new Date(item.DateTimeUtc).toLocaleString()}
                                        </span>
                                      )}
                                    </div>
                                  ))
                                )}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Barcode Lookup Maps</CardTitle>
              <CardDescription>
                Keys available for barcode validation
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="default-lookup">
                  <AccordionTrigger>
                    Default Lookup Map ({cacheData.lookupMapKeys.length} keys)
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-wrap gap-1">
                      {cacheData.lookupMapKeys.map((key) => (
                        <Badge key={key} variant="outline" className="font-mono text-xs">
                          {key}
                        </Badge>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
                {Object.entries(cacheData.lookupMapsByShipmentKeys).map(([shipmentId, keys]) => {
                  const dbShipment = cacheData.databaseShipments.find(s => s.id === shipmentId);
                  return (
                    <AccordionItem key={shipmentId} value={`lookup-${shipmentId}`}>
                      <AccordionTrigger>
                        {dbShipment?.shipmentId || shipmentId} ({keys.length} keys)
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="flex flex-wrap gap-1">
                          {keys.map((key) => (
                            <Badge key={key} variant="outline" className="font-mono text-xs">
                              {key}
                            </Badge>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
