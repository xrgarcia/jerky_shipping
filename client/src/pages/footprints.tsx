import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Layers,
  Package,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Box,
  Truck,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface FootprintData {
  id: string;
  signature: string;
  signatureHash: string;
  displayName: string | null;
  totalItems: number;
  collectionCount: number;
  createdAt: string;
  shipmentCount: number;
  packagingTypeId: string | null;
  packagingTypeName: string | null;
  stationType: string | null;
  humanReadableName: string;
  hasPackaging: boolean;
}

interface FootprintsResponse {
  footprints: FootprintData[];
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

export default function Footprints() {
  const { toast } = useToast();

  const {
    data,
    isLoading,
    refetch,
  } = useQuery<FootprintsResponse>({
    queryKey: ["/api/footprints"],
  });

  const { data: packagingTypesData } = useQuery<PackagingTypesResponse>({
    queryKey: ["/api/packaging-types"],
  });

  const assignMutation = useMutation({
    mutationFn: async ({
      footprintId,
      packagingTypeId,
    }: {
      footprintId: string;
      packagingTypeId: string;
    }) => {
      const res = await apiRequest("POST", `/api/footprints/${footprintId}/assign`, {
        packagingTypeId,
      });
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Packaging assigned",
        description: `${result.packagingTypeName} assigned to ${result.shipmentsUpdated} shipments`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/footprints"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Assignment failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const footprints = data?.footprints || [];
  const stats = data?.stats;
  const packagingTypes = packagingTypesData?.packagingTypes || [];

  const assignedPercent = stats
    ? Math.round((stats.assigned / Math.max(stats.total, 1)) * 100)
    : 0;

  const handleAssign = (footprintId: string, packagingTypeId: string) => {
    assignMutation.mutate({ footprintId, packagingTypeId });
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
            Learned Footprints
          </h1>
          <p className="text-muted-foreground">
            Assign packaging rules to order patterns the system has discovered
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
              Total Patterns
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold"
                data-testid="text-total-footprints"
              >
                {stats?.total || 0}
              </span>
              <span className="text-sm text-muted-foreground">
                unique footprints discovered
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Packaging Assigned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold text-green-600"
                data-testid="text-assigned-count"
              >
                {stats?.assigned || 0}
              </span>
              <span className="text-sm text-muted-foreground">
                ({assignedPercent}%) auto-routable
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Needs Decision
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-bold text-amber-600"
                data-testid="text-needs-decision"
              >
                {stats?.needsDecision || 0}
              </span>
              <span className="text-sm text-muted-foreground">
                patterns awaiting packaging rule
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {footprints.length === 0 ? (
        <Card className="p-12 text-center">
          <Layers className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No footprints yet</h2>
          <p className="text-muted-foreground">
            Footprints are discovered when orders are processed. Make sure all SKUs are categorized first.
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
            <ScrollArea className="h-[500px]">
              <div className="space-y-2">
                {footprints.map((footprint) => (
                  <div
                    key={footprint.id}
                    className={`flex items-center gap-4 p-4 rounded-lg border ${
                      footprint.hasPackaging
                        ? "bg-card border-border"
                        : "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
                    }`}
                    data-testid={`row-footprint-${footprint.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {footprint.hasPackaging ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                        )}
                        <span
                          className="font-medium"
                          data-testid={`text-footprint-name-${footprint.id}`}
                        >
                          {footprint.humanReadableName}
                        </span>
                        {footprint.hasPackaging && getStationBadge(footprint.stationType)}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Package className="h-3 w-3" />
                          {footprint.totalItems} items
                        </span>
                        <span className="flex items-center gap-1">
                          <Layers className="h-3 w-3" />
                          {footprint.collectionCount} collection{footprint.collectionCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>

                    <Badge
                      variant={footprint.hasPackaging ? "secondary" : "default"}
                      className="flex-shrink-0"
                      data-testid={`badge-shipments-${footprint.id}`}
                    >
                      <Truck className="h-3 w-3 mr-1" />
                      {footprint.shipmentCount} shipment{footprint.shipmentCount !== 1 ? 's' : ''}
                    </Badge>

                    <div className="flex items-center gap-2 flex-shrink-0 min-w-[220px]">
                      {footprint.hasPackaging ? (
                        <div className="flex items-center gap-2">
                          <Box className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            {footprint.packagingTypeName}
                          </span>
                          <Select
                            onValueChange={(value) => handleAssign(footprint.id, value)}
                            disabled={assignMutation.isPending}
                          >
                            <SelectTrigger
                              className="w-[140px]"
                              data-testid={`select-change-${footprint.id}`}
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
                          onValueChange={(value) => handleAssign(footprint.id, value)}
                          disabled={assignMutation.isPending}
                        >
                          <SelectTrigger
                            className="w-[220px]"
                            data-testid={`select-packaging-${footprint.id}`}
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
    </div>
  );
}
