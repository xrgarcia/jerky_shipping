import { useState, useEffect } from "react";
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
  Wifi,
  WifiOff,
  Printer
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Station } from "@shared/schema";
import { useLocation, useSearch } from "wouter";

interface StationWithSession extends Station {
  activeSession?: {
    id: string;
    userId: string;
    userName?: string;
    startedAt: string;
    expiresAt: string;
  } | null;
  isConnected?: boolean;
  printer?: {
    id: string;
    name: string;
    systemName: string;
  } | null;
}

interface ConnectionStats {
  total: number;
  connected: number;
  offline: number;
}

interface StationsResponse {
  stations: StationWithSession[];
  connectionStats?: ConnectionStats;
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
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const connectionFilter = searchParams.get("connection") as "online" | "offline" | null;
  
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedStation, setSelectedStation] = useState<StationWithSession | null>(null);
  const [formData, setFormData] = useState({ name: "", locationHint: "", isActive: true });

  const { data, isLoading, refetch, isRefetching } = useQuery<StationsResponse>({
    queryKey: ["/api/stations"],
  });

  // WebSocket connection for real-time station connection updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=default`;
    
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;
    let isMounted = true;
    const maxReconnectDelay = 30000;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        console.error('WebSocket creation error:', error);
        return;
      }

      ws.onopen = () => {
        console.log('WebSocket connected (Stations)');
        reconnectAttempts = 0;
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'station_connection_change') {
            // Desktop client connected/disconnected - refetch stations data immediately
            console.log(`[WS] Station ${message.stationId} connection change: ${message.isConnected ? 'online' : 'offline'}`);
            queryClient.invalidateQueries({ queryKey: ["/api/stations"] });
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        if (isMounted) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
          reconnectAttempts++;
          reconnectTimeout = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const setConnectionFilter = (filter: "online" | "offline" | null) => {
    if (filter) {
      setLocation(`/stations?connection=${filter}`);
    } else {
      setLocation("/stations");
    }
  };

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

  const allStations = data?.stations || [];
  const connectionStats = data?.connectionStats;
  
  // Apply connection filter
  const stations = connectionFilter
    ? allStations.filter(s => connectionFilter === "online" ? s.isConnected : !s.isConnected)
    : allStations;

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold font-serif text-foreground" data-testid="text-page-title">
            Packing Stations
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage packing stations for the desktop print app
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
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
            className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
            data-testid="button-create-station"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Station
          </Button>
        </div>
      </div>

      {/* Connection filter tabs */}
      {connectionStats && connectionStats.total > 0 && (
        <div className="flex items-center gap-2 mb-6" data-testid="connection-filter-tabs">
          <Button
            variant={connectionFilter === null ? "default" : "outline"}
            size="sm"
            onClick={() => setConnectionFilter(null)}
            className={connectionFilter === null ? "bg-[#6B8E23] hover:bg-[#5a7a1e] text-white" : ""}
            data-testid="filter-all"
          >
            All ({connectionStats.total})
          </Button>
          <Button
            variant={connectionFilter === "online" ? "default" : "outline"}
            size="sm"
            onClick={() => setConnectionFilter("online")}
            className={connectionFilter === "online" ? "bg-[#6B8E23] hover:bg-[#5a7a1e] text-white" : ""}
            data-testid="filter-online"
          >
            <Wifi className="h-3.5 w-3.5 mr-1.5" />
            Online ({connectionStats.connected})
          </Button>
          <Button
            variant={connectionFilter === "offline" ? "default" : "outline"}
            size="sm"
            onClick={() => setConnectionFilter("offline")}
            className={connectionFilter === "offline" ? "bg-[#6B8E23] hover:bg-[#5a7a1e] text-white" : ""}
            data-testid="filter-offline"
          >
            <WifiOff className="h-3.5 w-3.5 mr-1.5" />
            Offline ({connectionStats.offline})
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="shadow-md">
              <CardHeader className="pb-3">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-5 w-24 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-20 w-full rounded-lg" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : stations.length === 0 ? (
        <Card className="text-center py-16 shadow-lg border-dashed border-2">
          <CardContent>
            <div className="w-16 h-16 mx-auto mb-4 bg-[#6B8E23]/10 rounded-full flex items-center justify-center">
              <Monitor className="h-8 w-8 text-[#6B8E23]" />
            </div>
            <h3 className="text-xl font-semibold font-serif mb-2">No Stations Yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Create your first packing station to start managing print jobs from the desktop app
            </p>
            <Button
              onClick={() => {
                setFormData({ name: "", locationHint: "", isActive: true });
                setShowCreateDialog(true);
              }}
              className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
              data-testid="button-create-first-station"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Station
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {stations.map((station) => (
            <Card 
              key={station.id} 
              className={`shadow-md hover:shadow-lg transition-shadow ${!station.isActive ? "opacity-60" : ""}`}
              data-testid={`card-station-${station.id}`}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <CardTitle 
                      className="text-xl font-semibold font-serif truncate" 
                      data-testid={`text-station-name-${station.id}`}
                    >
                      {station.name}
                    </CardTitle>
                    {station.locationHint && (
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1.5">
                        <MapPin className="h-4 w-4 flex-shrink-0" />
                        <span data-testid={`text-station-location-${station.id}`}>{station.locationHint}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <Badge 
                      variant={station.isConnected ? "default" : "outline"}
                      className={station.isConnected 
                        ? "bg-emerald-600 hover:bg-emerald-700 text-white" 
                        : "text-muted-foreground border-muted-foreground/30"
                      }
                      data-testid={`badge-station-connection-${station.id}`}
                    >
                      {station.isConnected ? (
                        <>
                          <Wifi className="h-3 w-3 mr-1" />
                          Online
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-3 w-3 mr-1" />
                          Offline
                        </>
                      )}
                    </Badge>
                    <Badge 
                      variant={station.isActive ? "default" : "secondary"}
                      className={station.isActive ? "bg-[#6B8E23] hover:bg-[#5a7a1e]" : ""}
                      data-testid={`badge-station-status-${station.id}`}
                    >
                      {station.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {station.activeSession ? (
                  <div className="bg-[#6B8E23]/10 border border-[#6B8E23]/20 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-2 h-2 bg-[#6B8E23] rounded-full animate-pulse" />
                      <span className="text-sm font-medium text-[#6B8E23]">Active Session</span>
                    </div>
                    <p className="font-medium text-foreground" data-testid={`text-session-user-${station.id}`}>
                      {station.activeSession.userName || "Unknown User"}
                    </p>
                    <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                      <p>Started: {formatDate(station.activeSession.startedAt)}</p>
                      <p>Expires: {formatDate(station.activeSession.expiresAt)}</p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-muted/50 rounded-lg p-4 flex items-center gap-3">
                    <Monitor className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">No active session</span>
                  </div>
                )}
                
                <div className="flex items-center gap-3 p-3 rounded-lg border bg-background/50">
                  <Printer className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs text-muted-foreground">Printer</span>
                    {station.printer ? (
                      <p 
                        className="text-sm font-medium text-foreground truncate"
                        data-testid={`text-printer-name-${station.id}`}
                        title={station.printer.name}
                      >
                        {station.printer.name}
                      </p>
                    ) : (
                      <p 
                        className="text-sm font-medium text-red-500"
                        data-testid={`text-printer-none-${station.id}`}
                      >
                        None
                      </p>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center justify-between pt-2 border-t">
                  <p className="text-xs text-muted-foreground">
                    Created {formatDate(station.createdAt)}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditDialog(station)}
                      className="h-8 w-8 p-0"
                      data-testid={`button-edit-station-${station.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDeleteDialog(station)}
                      className="h-8 w-8 p-0 hover:bg-destructive/10"
                      data-testid={`button-delete-station-${station.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Create New Station</DialogTitle>
            <DialogDescription>
              Add a new packing station for the warehouse
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="create-name" className="text-sm font-medium">
                  Station Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="create-name"
                  placeholder="e.g., Packing Station 1"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-11"
                  data-testid="input-station-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-location" className="text-sm font-medium">
                  Location Hint
                </Label>
                <Input
                  id="create-location"
                  placeholder="e.g., Near shipping dock"
                  value={formData.locationHint}
                  onChange={(e) => setFormData(prev => ({ ...prev, locationHint: e.target.value }))}
                  className="h-11"
                  data-testid="input-station-location"
                />
                <p className="text-xs text-muted-foreground">
                  Optional description to help identify the physical location
                </p>
              </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
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
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                data-testid="button-submit-create"
              >
                {createMutation.isPending ? "Creating..." : "Create Station"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Edit Station</DialogTitle>
            <DialogDescription>
              Update station details
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEdit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name" className="text-sm font-medium">
                  Station Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="edit-name"
                  placeholder="e.g., Packing Station 1"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-11"
                  data-testid="input-edit-station-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-location" className="text-sm font-medium">
                  Location Hint
                </Label>
                <Input
                  id="edit-location"
                  placeholder="e.g., Near shipping dock"
                  value={formData.locationHint}
                  onChange={(e) => setFormData(prev => ({ ...prev, locationHint: e.target.value }))}
                  className="h-11"
                  data-testid="input-edit-station-location"
                />
              </div>
              <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                <div className="space-y-0.5">
                  <Label htmlFor="edit-active" className="text-sm font-medium">Station Active</Label>
                  <p className="text-xs text-muted-foreground">
                    Inactive stations cannot be claimed by users
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
            <DialogFooter className="gap-2 sm:gap-0">
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
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
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
