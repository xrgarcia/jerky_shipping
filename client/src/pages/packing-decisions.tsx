import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Package,
  AlertCircle,
  CheckCircle2,
  Plus,
  Layers,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ProductCollection } from "@shared/schema";

interface UncategorizedProduct {
  sku: string;
  description: string | null;
  shipmentCount: number;
}

interface PackingDecisionsResponse {
  uncategorizedProducts: UncategorizedProduct[];
  stats: {
    totalProducts: number;
    categorizedProducts: number;
    totalShipments: number;
    shipmentsComplete: number;
    shipmentsPending: number;
    oldestOrderDate: string | null;
  };
}

interface CollectionWithCount extends ProductCollection {
  productCount: number;
}

interface CollectionsResponse {
  collections: CollectionWithCount[];
}

export default function PackingDecisions() {
  const { toast } = useToast();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [pendingAssignment, setPendingAssignment] = useState<{
    sku: string;
    description: string | null;
  } | null>(null);

  const {
    data,
    isLoading,
    refetch,
  } = useQuery<PackingDecisionsResponse>({
    queryKey: ["/api/packing-decisions/uncategorized"],
  });

  const { data: collectionsData } = useQuery<CollectionsResponse>({
    queryKey: ["/api/collections"],
  });

  const assignMutation = useMutation({
    mutationFn: async ({
      sku,
      collectionId,
    }: {
      sku: string;
      collectionId: string;
    }) => {
      const res = await apiRequest("POST", "/api/packing-decisions/assign", {
        sku,
        collectionId,
      });
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: "SKU assigned",
        description: `${result.footprintsCompleted} of ${result.shipmentsAffected} shipments now have complete footprints`,
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/packing-decisions/uncategorized"],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Assignment failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createCollectionMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/collections", { name });
      return res.json();
    },
    onSuccess: (newCollection) => {
      toast({ title: "Collection created" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      setShowCreateDialog(false);
      setNewCollectionName("");
      if (pendingAssignment) {
        assignMutation.mutate({
          sku: pendingAssignment.sku,
          collectionId: newCollection.id,
        });
        setPendingAssignment(null);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create collection",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const uncategorized = data?.uncategorizedProducts || [];
  const stats = data?.stats;
  const collections = collectionsData?.collections || [];

  const coveragePercent = stats
    ? Math.round(
        (stats.categorizedProducts / Math.max(stats.totalProducts, 1)) * 100
      )
    : 0;

  const shipmentsCompletePercent = stats
    ? Math.round(
        (stats.shipmentsComplete /
          Math.max(stats.shipmentsComplete + stats.shipmentsPending, 1)) *
          100
      )
    : 0;

  const formattedOldestDate = useMemo(() => {
    if (!stats?.oldestOrderDate) return null;
    try {
      const date = new Date(stats.oldestOrderDate);
      const centralTime = toZonedTime(date, "America/Chicago");
      return format(centralTime, "MMM d, yyyy");
    } catch {
      return null;
    }
  }, [stats?.oldestOrderDate]);

  const handleAssign = (sku: string, collectionId: string) => {
    assignMutation.mutate({ sku, collectionId });
  };

  const handleCreateNew = (sku: string, description: string | null) => {
    setPendingAssignment({ sku, description });
    setShowCreateDialog(true);
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-3 gap-4">
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">
            Packing Decisions
          </h1>
          <p className="text-muted-foreground">
            Categorize ordered items to enable automatic packaging decisions
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          data-testid="button-refresh"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              SKUs in Orders
            </CardTitle>
            {formattedOldestDate && (
              <CardDescription className="text-xs">
                Since {formattedOldestDate}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold"
                data-testid="text-coverage-percent"
              >
                {coveragePercent}%
              </span>
              <span className="text-sm text-muted-foreground">
                ({stats?.categorizedProducts || 0} of {stats?.totalProducts || 0}{" "}
                categorized)
              </span>
            </div>
            <Progress value={coveragePercent} className="mt-2 h-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Shipments Complete
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold"
                data-testid="text-shipments-complete"
              >
                {stats?.shipmentsComplete || 0}
              </span>
              <span className="text-sm text-muted-foreground">
                of {(stats?.shipmentsComplete || 0) + (stats?.shipmentsPending || 0)} with
                footprints
              </span>
            </div>
            <Progress value={shipmentsCompletePercent} className="mt-2 h-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Needs Categorization
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold text-amber-600"
                data-testid="text-pending-count"
              >
                {uncategorized.length}
              </span>
              <span className="text-sm text-muted-foreground">
                SKUs blocking {stats?.shipmentsPending || 0} shipments
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {uncategorized.length === 0 ? (
        <Card className="p-12 text-center">
          <CheckCircle2 className="h-12 w-12 mx-auto text-green-500 mb-4" />
          <h2 className="text-xl font-semibold mb-2">All SKUs categorized!</h2>
          <p className="text-muted-foreground">
            All SKUs in your orders have been assigned to collections.
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              Uncategorized SKUs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[500px]">
              <div className="space-y-2">
                {uncategorized.map((product) => (
                  <div
                    key={product.sku}
                    className="flex items-center gap-4 p-3 rounded-lg border bg-card"
                    data-testid={`row-product-${product.sku}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <span
                          className="font-mono text-sm font-medium truncate"
                          data-testid={`text-sku-${product.sku}`}
                        >
                          {product.sku}
                        </span>
                      </div>
                      {product.description && (
                        <p className="text-sm text-muted-foreground truncate mt-1 ml-6">
                          {product.description}
                        </p>
                      )}
                    </div>

                    <Badge
                      variant="secondary"
                      className="flex-shrink-0"
                      data-testid={`badge-shipments-${product.sku}`}
                    >
                      {product.shipmentCount} shipment
                      {product.shipmentCount !== 1 ? "s" : ""}
                    </Badge>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Select
                        onValueChange={(value) => {
                          if (value === "__create__") {
                            handleCreateNew(product.sku, product.description);
                          } else {
                            handleAssign(product.sku, value);
                          }
                        }}
                        disabled={assignMutation.isPending}
                      >
                        <SelectTrigger
                          className="w-[200px]"
                          data-testid={`select-collection-${product.sku}`}
                        >
                          <SelectValue placeholder="Assign to collection..." />
                        </SelectTrigger>
                        <SelectContent>
                          {collections.map((collection) => (
                            <SelectItem
                              key={collection.id}
                              value={collection.id}
                              data-testid={`option-collection-${collection.id}`}
                            >
                              <div className="flex items-center gap-2">
                                <Layers className="h-4 w-4" />
                                {collection.name}
                              </div>
                            </SelectItem>
                          ))}
                          <SelectItem value="__create__">
                            <div className="flex items-center gap-2 text-primary">
                              <Plus className="h-4 w-4" />
                              Create new collection...
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Collection</DialogTitle>
            <DialogDescription>
              {pendingAssignment && (
                <>
                  Create a collection for{" "}
                  <span className="font-mono font-medium">
                    {pendingAssignment.sku}
                  </span>
                  {pendingAssignment.description && (
                    <> ({pendingAssignment.description})</>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="collection-name">Collection Name</Label>
              <Input
                id="collection-name"
                placeholder="e.g., 2.5 oz jerky bags"
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                data-testid="input-collection-name"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreateDialog(false);
                setPendingAssignment(null);
                setNewCollectionName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createCollectionMutation.mutate(newCollectionName)}
              disabled={
                !newCollectionName.trim() || createCollectionMutation.isPending
              }
              data-testid="button-create-collection"
            >
              {createCollectionMutation.isPending ? (
                "Creating..."
              ) : (
                <>
                  Create & Assign
                  <ArrowRight className="h-4 w-4 ml-2" />
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
