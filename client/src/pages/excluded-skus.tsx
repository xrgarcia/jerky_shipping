import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface ExcludedSku {
  id: number;
  sku: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

function formatDate(dateValue: string | Date | null | undefined): string {
  if (!dateValue) return "N/A";
  
  try {
    const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return String(dateValue);
  }
}

export default function ExcludedSkus() {
  const { toast } = useToast();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedSku, setSelectedSku] = useState<ExcludedSku | null>(null);
  const [formData, setFormData] = useState({ sku: "", reason: "" });

  const { data: skus, isLoading } = useQuery<ExcludedSku[]>({
    queryKey: ["/api/excluded-explosion-skus"],
  });

  const addMutation = useMutation({
    mutationFn: async (data: { sku: string; reason: string }) => {
      return apiRequest("POST", "/api/excluded-explosion-skus", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/excluded-explosion-skus"] });
      setShowAddDialog(false);
      setFormData({ sku: "", reason: "" });
      toast({
        title: "SKU Added",
        description: "The SKU has been added to the exclusion list.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add SKU",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/excluded-explosion-skus/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/excluded-explosion-skus"] });
      setShowDeleteDialog(false);
      setSelectedSku(null);
      toast({
        title: "SKU Removed",
        description: "The SKU has been removed from the exclusion list.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to remove SKU",
        variant: "destructive",
      });
    },
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.sku.trim()) return;
    addMutation.mutate({
      sku: formData.sku.trim().toUpperCase(),
      reason: formData.reason.trim() || "",
    });
  };

  const handleDelete = () => {
    if (selectedSku) {
      deleteMutation.mutate(selectedSku.id);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Excluded Explosion SKUs</h1>
          <p className="text-muted-foreground mt-1">
            SKUs that are filtered out during kit explosion in QC processing
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-sku">
          <Plus className="h-4 w-4 mr-2" />
          Add SKU
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Excluded SKUs
          </CardTitle>
          <CardDescription>
            These SKUs will be skipped when kits are exploded into their component items during QC item hydration.
            Common exclusions include assembly instruction cards like BUILDBAG, BUILDBOX, and BUILDJAS.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !skus || skus.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No excluded SKUs configured</p>
              <p className="text-sm mt-1">Add SKUs that should be filtered out during QC explosion</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Added By</TableHead>
                  <TableHead>Date Added</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skus.map((sku) => (
                  <TableRow key={sku.id} data-testid={`row-excluded-sku-${sku.id}`}>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono" data-testid={`text-sku-${sku.id}`}>
                        {sku.sku}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {sku.reason || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {sku.createdBy || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDate(sku.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedSku(sku);
                          setShowDeleteDialog(true);
                        }}
                        data-testid={`button-delete-sku-${sku.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Excluded SKU</DialogTitle>
            <DialogDescription>
              Add a SKU that should be excluded from kit explosion during QC processing.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="sku">SKU</Label>
                <Input
                  id="sku"
                  value={formData.sku}
                  onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                  placeholder="e.g., BUILDBAG"
                  className="font-mono"
                  data-testid="input-sku"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reason">Reason (optional)</Label>
                <Textarea
                  id="reason"
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  placeholder="Why is this SKU excluded?"
                  data-testid="input-reason"
                />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={!formData.sku.trim() || addMutation.isPending}
                data-testid="button-confirm-add"
              >
                {addMutation.isPending ? "Adding..." : "Add SKU"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Excluded SKU</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove{" "}
              <span className="font-mono font-semibold">{selectedSku?.sku}</span>{" "}
              from the exclusion list? This SKU will be included in future kit explosions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setSelectedSku(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
