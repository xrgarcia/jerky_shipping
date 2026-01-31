import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Package,
  Pencil,
  Box,
  Hand,
  Layers,
  RefreshCw,
  Info,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { PackagingType } from "@shared/schema";

interface PackagingTypeWithCount extends PackagingType {
  fingerprintCount: number;
}

interface PackagingTypesResponse {
  packagingTypes: PackagingTypeWithCount[];
}

const STATION_TYPES = [
  { value: "boxing_machine", label: "Boxing Machine", icon: Box },
  { value: "poly_bag", label: "Poly Bag Station", icon: Package },
  { value: "hand_pack", label: "Hand Pack", icon: Hand },
] as const;

function StationBadge({ stationType }: { stationType: string | null }) {
  const found = STATION_TYPES.find(s => s.value === stationType);
  if (!found) {
    return <Badge variant="outline">Not assigned</Badge>;
  }
  const Icon = found.icon;
  return (
    <Badge variant="secondary" className="gap-1">
      <Icon className="h-3 w-3" />
      {found.label}
    </Badge>
  );
}

export default function PackagingTypes() {
  const { toast } = useToast();
  const [editingType, setEditingType] = useState<PackagingTypeWithCount | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    packageCode: "",
    stationType: "",
    dimensionLength: "",
    dimensionWidth: "",
    dimensionHeight: "",
  });

  const {
    data,
    isLoading,
    refetch,
  } = useQuery<PackagingTypesResponse>({
    queryKey: ["/api/packaging-types", showInactive],
    queryFn: async () => {
      const res = await fetch(`/api/packaging-types?includeInactive=${showInactive}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<typeof formData> & { isActive?: boolean } }) => {
      const res = await apiRequest("PATCH", `/api/packaging-types/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Packaging type updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/packaging-types"] });
      setEditingType(null);
      resetForm();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update packaging type",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setFormData({
      name: "",
      packageCode: "",
      stationType: "",
      dimensionLength: "",
      dimensionWidth: "",
      dimensionHeight: "",
    });
  };

  const openEditDialog = (type: PackagingTypeWithCount) => {
    setEditingType(type);
    setFormData({
      name: type.name,
      packageCode: type.packageCode || "",
      stationType: type.stationType || "",
      dimensionLength: type.dimensionLength || "",
      dimensionWidth: type.dimensionWidth || "",
      dimensionHeight: type.dimensionHeight || "",
    });
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast({
        title: "Name is required",
        variant: "destructive",
      });
      return;
    }

    if (editingType) {
      updateMutation.mutate({ id: editingType.id, data: formData });
    }
  };

  const handleToggleActive = (type: PackagingType) => {
    updateMutation.mutate({
      id: type.id,
      data: { isActive: !type.isActive },
    });
  };

  const packagingTypes = data?.packagingTypes || [];
  const activeCount = packagingTypes.filter(t => t.isActive).length;
  const inactiveCount = packagingTypes.filter(t => !t.isActive).length;

  const isDialogOpen = !!editingType;
  const isPending = updateMutation.isPending;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Package className="h-8 w-8" />
            Packaging Types
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage packaging options for order fulfillment
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="show-inactive"
              checked={showInactive}
              onCheckedChange={setShowInactive}
              data-testid="switch-show-inactive"
            />
            <Label htmlFor="show-inactive" className="text-sm text-muted-foreground">
              Show inactive
            </Label>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            data-testid="button-refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground" data-testid="info-sync-note">
        <Info className="h-4 w-4 shrink-0" />
        <span>Packaging types are automatically synced from ShipStation every hour. You can edit station assignments and active status locally.</span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-count">
              {isLoading ? <Skeleton className="h-8 w-16" /> : packagingTypes.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600" data-testid="text-active-count">
              {isLoading ? <Skeleton className="h-8 w-16" /> : activeCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Inactive
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground" data-testid="text-inactive-count">
              {isLoading ? <Skeleton className="h-8 w-16" /> : inactiveCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            Packaging Types
          </CardTitle>
          <CardDescription>
            Each packaging type can be assigned to a station type for routing
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : packagingTypes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No packaging types found</p>
              <p className="text-sm">Create your first packaging type to get started</p>
            </div>
          ) : (
            <ScrollArea className="h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Package Code</TableHead>
                    <TableHead>Dimensions (L x W x H)</TableHead>
                    <TableHead>Station Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packagingTypes.map((type) => (
                    <TableRow key={type.id} data-testid={`row-packaging-type-${type.id}`}>
                      <TableCell className="font-medium">{type.name}</TableCell>
                      <TableCell>
                        {type.packageCode ? (
                          <code className="text-xs bg-muted px-1 py-0.5 rounded">
                            {type.packageCode}
                          </code>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {type.dimensionLength && type.dimensionWidth && type.dimensionHeight ? (
                          <span className="text-sm">
                            {type.dimensionLength} x {type.dimensionWidth} x {type.dimensionHeight} {type.dimensionUnit || "in"}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StationBadge stationType={type.stationType} />
                      </TableCell>
                      <TableCell>
                        {type.isActive ? (
                          <Badge variant="default">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(type)}
                            data-testid={`button-edit-${type.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Switch
                            checked={type.isActive}
                            onCheckedChange={() => handleToggleActive(type)}
                            data-testid={`switch-active-${type.id}`}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setEditingType(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Packaging Type</DialogTitle>
            <DialogDescription>
              Update the packaging type details
            </DialogDescription>
          </DialogHeader>

          {editingType && editingType.fingerprintCount > 0 && (
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg" data-testid="fingerprint-count-info">
              <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{editingType.fingerprintCount.toLocaleString()}</span> shipments use this packaging type
              </span>
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder='e.g., "Box #2 (13 x 13 x 13)"'
                data-testid="input-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="packageCode">Package Code</Label>
              <Input
                id="packageCode"
                value={formData.packageCode}
                onChange={(e) => setFormData({ ...formData, packageCode: e.target.value })}
                placeholder="ShipStation package code"
                data-testid="input-package-code"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="stationType">Station Type</Label>
              <Select
                value={formData.stationType}
                onValueChange={(value) => setFormData({ ...formData, stationType: value === "none" ? "" : value })}
              >
                <SelectTrigger data-testid="select-station-type">
                  <SelectValue placeholder="Select station type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not assigned</SelectItem>
                  {STATION_TYPES.map((st) => (
                    <SelectItem key={st.value} value={st.value}>
                      {st.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Dimensions (optional)</Label>
              <div className="grid grid-cols-3 gap-2">
                <Input
                  value={formData.dimensionLength}
                  onChange={(e) => setFormData({ ...formData, dimensionLength: e.target.value })}
                  placeholder="Length"
                  data-testid="input-dimension-length"
                />
                <Input
                  value={formData.dimensionWidth}
                  onChange={(e) => setFormData({ ...formData, dimensionWidth: e.target.value })}
                  placeholder="Width"
                  data-testid="input-dimension-width"
                />
                <Input
                  value={formData.dimensionHeight}
                  onChange={(e) => setFormData({ ...formData, dimensionHeight: e.target.value })}
                  placeholder="Height"
                  data-testid="input-dimension-height"
                />
              </div>
              <p className="text-xs text-muted-foreground">Dimensions in inches</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingType(null);
                resetForm();
              }}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending}
              data-testid="button-submit"
            >
              {isPending ? "Saving..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
