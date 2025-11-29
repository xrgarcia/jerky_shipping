import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Plus, 
  MapPin, 
  Pencil, 
  Trash2, 
  RefreshCw,
  Monitor,
  User
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Station } from "@shared/schema";

interface StationWithSession extends Station {
  activeSession?: {
    id: string;
    userId: string;
    userName?: string;
    startedAt: string;
    expiresAt: string;
  } | null;
}

interface StationsResponse {
  stations: StationWithSession[];
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

export default function Stations() {
  const { toast } = useToast();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedStation, setSelectedStation] = useState<StationWithSession | null>(null);
  const [formData, setFormData] = useState({ name: "", locationHint: "", isActive: true });

  const { data, isLoading, refetch, isRefetching } = useQuery<StationsResponse>({
    queryKey: ["/api/stations"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; locationHint?: string }) => {
      const res = await apiRequest("POST", "/api/desktop/stations", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Station created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
      setShowCreateDialog(false);
      setFormData({ name: "", locationHint: "", isActive: true });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create station",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; locationHint?: string; isActive?: boolean } }) => {
      const res = await apiRequest("PATCH", `/api/desktop/stations/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Station updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
      setShowEditDialog(false);
      setSelectedStation(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update station",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/desktop/stations/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Station deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
      setShowDeleteDialog(false);
      setSelectedStation(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete station",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) return;
    createMutation.mutate({
      name: formData.name.trim(),
      locationHint: formData.locationHint.trim() || undefined,
    });
  };

  const handleEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStation || !formData.name.trim()) return;
    updateMutation.mutate({
      id: selectedStation.id,
      data: {
        name: formData.name.trim(),
        locationHint: formData.locationHint.trim() || undefined,
        isActive: formData.isActive,
      },
    });
  };

  const handleDelete = () => {
    if (!selectedStation) return;
    deleteMutation.mutate(selectedStation.id);
  };

  const openEditDialog = (station: StationWithSession) => {
    setSelectedStation(station);
    setFormData({
      name: station.name,
      locationHint: station.locationHint || "",
      isActive: station.isActive,
    });
    setShowEditDialog(true);
  };

  const openDeleteDialog = (station: StationWithSession) => {
    setSelectedStation(station);
    setShowDeleteDialog(true);
  };

  const stations = data?.stations || [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Packing Stations</h1>
          <p className="text-muted-foreground">Manage packing stations for the desktop print app</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
            data-testid="button-refresh-stations"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            onClick={() => {
              setFormData({ name: "", locationHint: "", isActive: true });
              setShowCreateDialog(true);
            }}
            data-testid="button-create-station"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Station
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-40" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : stations.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent>
            <Monitor className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No Stations</h3>
            <p className="text-muted-foreground mb-4">Create your first packing station to get started</p>
            <Button
              onClick={() => {
                setFormData({ name: "", locationHint: "", isActive: true });
                setShowCreateDialog(true);
              }}
              data-testid="button-create-first-station"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Station
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {stations.map((station) => (
            <Card 
              key={station.id} 
              className={!station.isActive ? "opacity-60" : undefined}
              data-testid={`card-station-${station.id}`}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg truncate" data-testid={`text-station-name-${station.id}`}>
                      {station.name}
                    </CardTitle>
                    <Badge 
                      variant={station.isActive ? "default" : "secondary"}
                      data-testid={`badge-station-status-${station.id}`}
                    >
                      {station.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {station.locationHint && (
                    <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
                      <MapPin className="h-3 w-3" />
                      <span data-testid={`text-station-location-${station.id}`}>{station.locationHint}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openEditDialog(station)}
                    data-testid={`button-edit-station-${station.id}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openDeleteDialog(station)}
                    data-testid={`button-delete-station-${station.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {station.activeSession ? (
                  <div className="bg-accent/50 rounded-lg p-3">
                    <div className="flex items-center gap-2 text-sm font-medium mb-1">
                      <User className="h-4 w-4 text-green-600" />
                      <span className="text-green-700 dark:text-green-400">Active Session</span>
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid={`text-session-user-${station.id}`}>
                      {station.activeSession.userName || "Unknown User"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Started: {formatDate(station.activeSession.startedAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Expires: {formatDate(station.activeSession.expiresAt)}
                    </p>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    <span>No active session</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-3">
                  Created: {formatDate(station.createdAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Station</DialogTitle>
            <DialogDescription>
              Add a new packing station for the warehouse
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">Station Name *</Label>
                <Input
                  id="create-name"
                  placeholder="e.g., Packing Station 1"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  data-testid="input-station-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-location">Location (optional)</Label>
                <Input
                  id="create-location"
                  placeholder="e.g., Near shipping dock"
                  value={formData.locationHint}
                  onChange={(e) => setFormData(prev => ({ ...prev, locationHint: e.target.value }))}
                  data-testid="input-station-location"
                />
              </div>
            </div>
            <DialogFooter>
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setShowCreateDialog(false)}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={!formData.name.trim() || createMutation.isPending}
                data-testid="button-submit-create"
              >
                {createMutation.isPending ? "Creating..." : "Create Station"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Station</DialogTitle>
            <DialogDescription>
              Update station details
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEdit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Station Name *</Label>
                <Input
                  id="edit-name"
                  placeholder="e.g., Packing Station 1"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  data-testid="input-edit-station-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-location">Location (optional)</Label>
                <Input
                  id="edit-location"
                  placeholder="e.g., Near shipping dock"
                  value={formData.locationHint}
                  onChange={(e) => setFormData(prev => ({ ...prev, locationHint: e.target.value }))}
                  data-testid="input-edit-station-location"
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="edit-active">Active</Label>
                  <p className="text-sm text-muted-foreground">
                    Inactive stations cannot be claimed
                  </p>
                </div>
                <Switch
                  id="edit-active"
                  checked={formData.isActive}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, isActive: checked }))}
                  data-testid="switch-station-active"
                />
              </div>
            </div>
            <DialogFooter>
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setShowEditDialog(false)}
                data-testid="button-cancel-edit"
              >
                Cancel
              </Button>
              <Button 
                type="submit" 
                disabled={!formData.name.trim() || updateMutation.isPending}
                data-testid="button-submit-edit"
              >
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Station</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedStation?.name}"? 
              {selectedStation?.activeSession && (
                <span className="block mt-2 text-destructive font-medium">
                  Warning: This station has an active session. The user will be immediately logged out.
                </span>
              )}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Station"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
