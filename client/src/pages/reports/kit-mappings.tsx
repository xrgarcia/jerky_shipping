import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Package,
  ArrowLeftRight,
  Database,
} from "lucide-react";

interface KitMapping {
  kitSku: string;
  componentSku: string;
  componentQuantity: number;
}

interface ComponentDifference {
  kitSku: string;
  componentSku: string;
  normalQuantity: number | null;
  slashbinQuantity: number | null;
  diffType: 'missing_in_slashbin' | 'missing_in_normal' | 'quantity_mismatch';
}

interface ComparisonResponse {
  summary: {
    normalKitCount: number;
    slashbinKitCount: number;
    normalTotalMappings: number;
    slashbinTotalMappings: number;
  };
  kitsOnlyInNormal: KitMapping[];
  kitsOnlyInSlashbin: KitMapping[];
  componentDifferences: ComponentDifference[];
}

export default function KitMappingsReport() {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("summary");

  const { data, isLoading, error, refetch, isFetching } = useQuery<ComparisonResponse>({
    queryKey: ["/api/reports/kit-mappings-comparison"],
    staleTime: 5 * 60 * 1000,
  });

  const filteredKitsOnlyInNormal = useMemo(() => {
    if (!data?.kitsOnlyInNormal) return [];
    if (!searchTerm.trim()) return data.kitsOnlyInNormal;
    const search = searchTerm.toLowerCase();
    return data.kitsOnlyInNormal.filter(
      (k) => k.kitSku.toLowerCase().includes(search) || k.componentSku.toLowerCase().includes(search)
    );
  }, [data?.kitsOnlyInNormal, searchTerm]);

  const filteredKitsOnlyInSlashbin = useMemo(() => {
    if (!data?.kitsOnlyInSlashbin) return [];
    if (!searchTerm.trim()) return data.kitsOnlyInSlashbin;
    const search = searchTerm.toLowerCase();
    return data.kitsOnlyInSlashbin.filter(
      (k) => k.kitSku.toLowerCase().includes(search) || k.componentSku.toLowerCase().includes(search)
    );
  }, [data?.kitsOnlyInSlashbin, searchTerm]);

  const filteredComponentDifferences = useMemo(() => {
    if (!data?.componentDifferences) return [];
    if (!searchTerm.trim()) return data.componentDifferences;
    const search = searchTerm.toLowerCase();
    return data.componentDifferences.filter(
      (c) => c.kitSku.toLowerCase().includes(search) || c.componentSku.toLowerCase().includes(search)
    );
  }, [data?.componentDifferences, searchTerm]);

  const uniqueKitsOnlyInNormal = useMemo(() => {
    if (!data?.kitsOnlyInNormal) return 0;
    return new Set(data.kitsOnlyInNormal.map((k) => k.kitSku)).size;
  }, [data?.kitsOnlyInNormal]);

  const uniqueKitsOnlyInSlashbin = useMemo(() => {
    if (!data?.kitsOnlyInSlashbin) return 0;
    return new Set(data.kitsOnlyInSlashbin.map((k) => k.kitSku)).size;
  }, [data?.kitsOnlyInSlashbin]);

  const totalDifferences = useMemo(() => {
    if (!data) return 0;
    return (
      (data.kitsOnlyInNormal?.length || 0) +
      (data.kitsOnlyInSlashbin?.length || 0) +
      (data.componentDifferences?.length || 0)
    );
  }, [data]);

  const getDiffTypeBadge = (diffType: string) => {
    switch (diffType) {
      case 'missing_in_slashbin':
        return <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">Missing in Slashbin</Badge>;
      case 'missing_in_normal':
        return <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Missing in Normal</Badge>;
      case 'quantity_mismatch':
        return <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Quantity Mismatch</Badge>;
      default:
        return <Badge variant="secondary">{diffType}</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="m-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span>Failed to load kit mappings comparison</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowLeftRight className="h-6 w-6" />
            Kit Mappings Comparison
          </h1>
          <p className="text-muted-foreground mt-1">
            Compare kit component mappings between Normal (GCP) and Slashbin tables
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          {isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-2" />
          )}
          Refresh
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="summary" data-testid="tab-summary">
            Summary
          </TabsTrigger>
          <TabsTrigger value="only-normal" data-testid="tab-only-normal">
            Only in Normal
            {uniqueKitsOnlyInNormal > 0 && (
              <Badge variant="secondary" className="ml-2">{uniqueKitsOnlyInNormal}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="only-slashbin" data-testid="tab-only-slashbin">
            Only in Slashbin
            {uniqueKitsOnlyInSlashbin > 0 && (
              <Badge variant="secondary" className="ml-2">{uniqueKitsOnlyInSlashbin}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="component-diffs" data-testid="tab-component-diffs">
            Component Diffs
            {(data?.componentDifferences?.length || 0) > 0 && (
              <Badge variant="secondary" className="ml-2">{data?.componentDifferences?.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Normal Table (GCP)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data?.summary.normalKitCount.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground">{data?.summary.normalTotalMappings.toLocaleString()} total mappings</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Slashbin Table</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data?.summary.slashbinKitCount.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground">{data?.summary.slashbinTotalMappings.toLocaleString()} total mappings</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Total Differences</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${totalDifferences === 0 ? 'text-green-600' : 'text-amber-600'}`}>
                  {totalDifferences}
                </div>
                <p className="text-xs text-muted-foreground">
                  {totalDifferences === 0 ? 'Tables are in sync' : 'Rows with differences'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Sync Status</CardTitle>
              </CardHeader>
              <CardContent>
                {totalDifferences === 0 ? (
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-6 w-6" />
                    <span className="text-lg font-medium">In Sync</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-amber-600">
                    <AlertTriangle className="h-6 w-6" />
                    <span className="text-lg font-medium">Out of Sync</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {totalDifferences > 0 && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-lg">Difference Breakdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center justify-between py-2 border-b">
                    <span>Kits only in Normal table</span>
                    <Badge variant={uniqueKitsOnlyInNormal > 0 ? "secondary" : "outline"}>
                      {uniqueKitsOnlyInNormal} kits ({data?.kitsOnlyInNormal?.length || 0} components)
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b">
                    <span>Kits only in Slashbin table</span>
                    <Badge variant={uniqueKitsOnlyInSlashbin > 0 ? "secondary" : "outline"}>
                      {uniqueKitsOnlyInSlashbin} kits ({data?.kitsOnlyInSlashbin?.length || 0} components)
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span>Component differences (same kit, different components/quantities)</span>
                    <Badge variant={(data?.componentDifferences?.length || 0) > 0 ? "secondary" : "outline"}>
                      {data?.componentDifferences?.length || 0} differences
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="only-normal" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Kits Only in Normal Table (GCP)
              </CardTitle>
              <CardDescription>
                These kits exist in the normal kit_component_mappings table but not in slashbin
              </CardDescription>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by kit or component SKU..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  data-testid="input-search-normal"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filteredKitsOnlyInNormal.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-5 w-5 mr-2 text-green-600" />
                  No kits found only in Normal table
                </div>
              ) : (
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kit SKU</TableHead>
                        <TableHead>Component SKU</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredKitsOnlyInNormal.map((item, idx) => (
                        <TableRow key={`${item.kitSku}-${item.componentSku}-${idx}`} data-testid={`row-normal-${idx}`}>
                          <TableCell className="font-mono text-sm">{item.kitSku}</TableCell>
                          <TableCell className="font-mono text-sm">{item.componentSku}</TableCell>
                          <TableCell className="text-right">{item.componentQuantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="only-slashbin" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Kits Only in Slashbin Table
              </CardTitle>
              <CardDescription>
                These kits exist in slashbin_kit_component_mappings but not in the normal table
              </CardDescription>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by kit or component SKU..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  data-testid="input-search-slashbin"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filteredKitsOnlyInSlashbin.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-5 w-5 mr-2 text-green-600" />
                  No kits found only in Slashbin table
                </div>
              ) : (
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kit SKU</TableHead>
                        <TableHead>Component SKU</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredKitsOnlyInSlashbin.map((item, idx) => (
                        <TableRow key={`${item.kitSku}-${item.componentSku}-${idx}`} data-testid={`row-slashbin-${idx}`}>
                          <TableCell className="font-mono text-sm">{item.kitSku}</TableCell>
                          <TableCell className="font-mono text-sm">{item.componentSku}</TableCell>
                          <TableCell className="text-right">{item.componentQuantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="component-diffs" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5" />
                Component Differences
              </CardTitle>
              <CardDescription>
                For kits that exist in both tables, these are the component or quantity differences
              </CardDescription>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by kit or component SKU..."
                  className="pl-9"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  data-testid="input-search-diffs"
                />
              </div>
            </CardHeader>
            <CardContent>
              {filteredComponentDifferences.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <CheckCircle2 className="h-5 w-5 mr-2 text-green-600" />
                  No component differences found
                </div>
              ) : (
                <ScrollArea className="h-[500px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Kit SKU</TableHead>
                        <TableHead>Component SKU</TableHead>
                        <TableHead className="text-right">Normal Qty</TableHead>
                        <TableHead className="text-right">Slashbin Qty</TableHead>
                        <TableHead>Difference Type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredComponentDifferences.map((item, idx) => (
                        <TableRow key={`${item.kitSku}-${item.componentSku}-${idx}`} data-testid={`row-diff-${idx}`}>
                          <TableCell className="font-mono text-sm">{item.kitSku}</TableCell>
                          <TableCell className="font-mono text-sm">{item.componentSku}</TableCell>
                          <TableCell className="text-right">
                            {item.normalQuantity !== null ? item.normalQuantity : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            {item.slashbinQuantity !== null ? item.slashbinQuantity : <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          <TableCell>{getDiffTypeBadge(item.diffType)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
