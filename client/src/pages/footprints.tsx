import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Layers,
  Package,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Box,
  Truck,
  Check,
  X,
  Loader2,
  Plus,
  Settings,
  ChevronDown,
  Hand,
  Pencil,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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

type InlineStatus = { type: 'loading' } | { type: 'success'; message: string } | { type: 'error'; message: string };

type FilterOption = 'all' | 'needs_mapping' | 'mapped';

export default function Footprints() {
  const { toast } = useToast();
  const [inlineStatus, setInlineStatus] = useState<Record<string, InlineStatus>>({});
  const [filter, setFilter] = useState<FilterOption>('all');
  const [showPackagingSection, setShowPackagingSection] = useState(false);
  const [showCreatePackagingDialog, setShowCreatePackagingDialog] = useState(false);
  const [editingPackaging, setEditingPackaging] = useState<PackagingType | null>(null);
  const [packagingForm, setPackagingForm] = useState({
    name: "",
    stationType: "",
  });

  useEffect(() => {
    const timeouts: NodeJS.Timeout[] = [];
    Object.entries(inlineStatus).forEach(([id, status]) => {
      if (status.type === 'success' || status.type === 'error') {
        const timeout = setTimeout(() => {
          setInlineStatus(prev => {
            const { [id]: _, ...rest } = prev;
            return rest;
          });
        }, 2500);
        timeouts.push(timeout);
      }
    });
    return () => timeouts.forEach(clearTimeout);
  }, [inlineStatus]);

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
      setInlineStatus(prev => ({ ...prev, [footprintId]: { type: 'loading' } }));
      const res = await apiRequest("POST", `/api/footprints/${footprintId}/assign`, {
        packagingTypeId,
      });
      return { ...(await res.json()), footprintId };
    },
    onSuccess: (result) => {
      setInlineStatus(prev => ({
        ...prev,
        [result.footprintId]: { type: 'success', message: `${result.shipmentsUpdated} updated` }
      }));
      queryClient.invalidateQueries({ queryKey: ["/api/footprints"] });
    },
    onError: (error: Error, variables) => {
      setInlineStatus(prev => ({
        ...prev,
        [variables.footprintId]: { type: 'error', message: 'Failed' }
      }));
    },
  });

  const createPackagingMutation = useMutation({
    mutationFn: async (data: { name: string; stationType: string }) => {
      const res = await apiRequest("POST", "/api/packaging-types", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Packaging type created" });
      queryClient.invalidateQueries({ queryKey: ["/api/packaging-types"] });
      setShowCreatePackagingDialog(false);
      setPackagingForm({ name: "", stationType: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create", description: error.message, variant: "destructive" });
    },
  });

  const updatePackagingMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; stationType?: string } }) => {
      const res = await apiRequest("PATCH", `/api/packaging-types/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Packaging type updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/packaging-types"] });
      queryClient.invalidateQueries({ queryKey: ["/api/footprints"] });
      setEditingPackaging(null);
      setPackagingForm({ name: "", stationType: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  const footprints = data?.footprints || [];
  const stats = data?.stats;
  const packagingTypes = packagingTypesData?.packagingTypes || [];

  const filteredFootprints = footprints.filter((fp) => {
    if (filter === 'needs_mapping') return !fp.hasPackaging;
    if (filter === 'mapped') return fp.hasPackaging;
    return true;
  });

  const assignedPercent = stats
    ? Math.round((stats.assigned / Math.max(stats.total, 1)) * 100)
    : 0;

  const handleAssign = (footprintId: string, packagingTypeId: string) => {
    assignMutation.mutate({ footprintId, packagingTypeId });
  };

  const getStatusIndicator = (footprintId: string) => {
    const status = inlineStatus[footprintId];
    if (!status) return null;
    
    switch (status.type) {
      case 'loading':
        return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
      case 'success':
        return (
          <span className="flex items-center gap-1 text-green-600 text-sm animate-in fade-in">
            <Check className="h-4 w-4" />
            {status.message}
          </span>
        );
      case 'error':
        return (
          <span className="flex items-center gap-1 text-red-600 text-sm animate-in fade-in">
            <X className="h-4 w-4" />
            {status.message}
          </span>
        );
    }
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
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                <Button
                  variant={filter === 'all' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter('all')}
                  data-testid="button-filter-all"
                >
                  All ({footprints.length})
                </Button>
                <Button
                  variant={filter === 'needs_mapping' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter('needs_mapping')}
                  className={filter !== 'needs_mapping' ? 'text-amber-600 hover:text-amber-700' : ''}
                  data-testid="button-filter-needs-mapping"
                >
                  Needs Mapping ({stats?.needsDecision || 0})
                </Button>
                <Button
                  variant={filter === 'mapped' ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setFilter('mapped')}
                  className={filter !== 'mapped' ? 'text-green-600 hover:text-green-700' : ''}
                  data-testid="button-filter-mapped"
                >
                  Mapped ({stats?.assigned || 0})
                </Button>
              </div>
              <span className="text-sm text-muted-foreground">
                Showing {filteredFootprints.length} of {footprints.length}
              </span>
            </div>
            <ScrollArea className="h-[500px]">
              <div className="space-y-2">
                {filteredFootprints.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No footprints match this filter
                  </div>
                ) : null}
                {filteredFootprints.map((footprint) => (
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

                    <div className="flex items-center gap-2 flex-shrink-0 min-w-[280px] justify-end">
                      {getStatusIndicator(footprint.id)}
                      {footprint.hasPackaging ? (
                        <div className="flex items-center gap-2">
                          <Box className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            {footprint.packagingTypeName}
                          </span>
                          <Select
                            onValueChange={(value) => handleAssign(footprint.id, value)}
                            disabled={!!inlineStatus[footprint.id]}
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
                          disabled={!!inlineStatus[footprint.id]}
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

      <Collapsible open={showPackagingSection} onOpenChange={setShowPackagingSection}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover-elevate">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  <CardTitle>Manage Packaging Types</CardTitle>
                </div>
                <ChevronDown className={`h-5 w-5 transition-transform ${showPackagingSection ? 'rotate-180' : ''}`} />
              </div>
              <CardDescription>
                Define packaging options and their station routing
              </CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              <div className="flex justify-end mb-4">
                <Button
                  size="sm"
                  onClick={() => {
                    setPackagingForm({ name: "", stationType: "" });
                    setShowCreatePackagingDialog(true);
                  }}
                  data-testid="button-add-packaging"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Packaging Type
                </Button>
              </div>
              <div className="space-y-2">
                {packagingTypes.map((pt) => (
                  <div
                    key={pt.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card"
                    data-testid={`row-packaging-${pt.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <Box className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{pt.name}</span>
                      {getStationBadge(pt.stationType)}
                      {!pt.stationType && (
                        <Badge variant="outline" className="text-amber-600 border-amber-300">
                          No station assigned
                        </Badge>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingPackaging(pt);
                        setPackagingForm({
                          name: pt.name,
                          stationType: pt.stationType || "",
                        });
                      }}
                      data-testid={`button-edit-packaging-${pt.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {packagingTypes.length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No packaging types defined yet. Add one to get started.
                  </p>
                )}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <Dialog open={showCreatePackagingDialog} onOpenChange={setShowCreatePackagingDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Packaging Type</DialogTitle>
            <DialogDescription>
              Define a new packaging option and which station type handles it
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="packaging-name">Name</Label>
              <Input
                id="packaging-name"
                placeholder='e.g., "Poly Bag 12x16" or "Box #2"'
                value={packagingForm.name}
                onChange={(e) => setPackagingForm(prev => ({ ...prev, name: e.target.value }))}
                data-testid="input-packaging-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Station Type</Label>
              <Select
                value={packagingForm.stationType}
                onValueChange={(value) => setPackagingForm(prev => ({ ...prev, stationType: value }))}
              >
                <SelectTrigger data-testid="select-packaging-station-type">
                  <SelectValue placeholder="Select station type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boxing_machine">
                    <div className="flex items-center gap-2">
                      <Box className="h-4 w-4" />
                      Boxing Machine
                    </div>
                  </SelectItem>
                  <SelectItem value="poly_bag">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Poly Bag
                    </div>
                  </SelectItem>
                  <SelectItem value="hand_pack">
                    <div className="flex items-center gap-2">
                      <Hand className="h-4 w-4" />
                      Hand Pack
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Orders using this packaging will route to stations of this type
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreatePackagingDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createPackagingMutation.mutate(packagingForm)}
              disabled={!packagingForm.name.trim() || createPackagingMutation.isPending}
              data-testid="button-save-packaging"
            >
              {createPackagingMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingPackaging} onOpenChange={(open) => !open && setEditingPackaging(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Packaging Type</DialogTitle>
            <DialogDescription>
              Update packaging details and station routing
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-packaging-name">Name</Label>
              <Input
                id="edit-packaging-name"
                value={packagingForm.name}
                onChange={(e) => setPackagingForm(prev => ({ ...prev, name: e.target.value }))}
                data-testid="input-edit-packaging-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Station Type</Label>
              <Select
                value={packagingForm.stationType}
                onValueChange={(value) => setPackagingForm(prev => ({ ...prev, stationType: value }))}
              >
                <SelectTrigger data-testid="select-edit-packaging-station-type">
                  <SelectValue placeholder="Select station type..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boxing_machine">
                    <div className="flex items-center gap-2">
                      <Box className="h-4 w-4" />
                      Boxing Machine
                    </div>
                  </SelectItem>
                  <SelectItem value="poly_bag">
                    <div className="flex items-center gap-2">
                      <Package className="h-4 w-4" />
                      Poly Bag
                    </div>
                  </SelectItem>
                  <SelectItem value="hand_pack">
                    <div className="flex items-center gap-2">
                      <Hand className="h-4 w-4" />
                      Hand Pack
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingPackaging(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => editingPackaging && updatePackagingMutation.mutate({
                id: editingPackaging.id,
                data: packagingForm,
              })}
              disabled={!packagingForm.name.trim() || updatePackagingMutation.isPending}
              data-testid="button-update-packaging"
            >
              {updatePackagingMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
