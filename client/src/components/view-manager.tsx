import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, Save, Copy, Trash2, Settings2, Check, GripVertical, Eye, EyeOff, Link2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SavedView, SavedViewConfig } from "@shared/schema";

export interface ColumnDefinition {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  defaultVisible?: boolean;
}

interface ViewManagerProps {
  page: string;
  columns: ColumnDefinition[];
  visibleColumns: string[];
  onColumnsChange: (columns: string[]) => void;
  currentViewId: string | null;
  onViewChange: (viewId: string | null) => void;
  getCurrentConfig: () => SavedViewConfig;
}

export function ViewManager({
  page,
  columns,
  visibleColumns,
  onColumnsChange,
  currentViewId,
  onViewChange,
  getCurrentConfig,
}: ViewManagerProps) {
  const { toast } = useToast();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [viewToDelete, setViewToDelete] = useState<SavedView | null>(null);
  const [newViewName, setNewViewName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const { data: savedViews = [] } = useQuery<SavedView[]>({
    queryKey: ['/api/saved-views', page],
    queryFn: async () => {
      const response = await fetch(`/api/saved-views?page=${encodeURIComponent(page)}`);
      if (!response.ok) {
        throw new Error('Failed to fetch saved views');
      }
      return response.json();
    },
  });

  const currentView = savedViews.find(v => v.id === currentViewId);

  const createViewMutation = useMutation({
    mutationFn: async (data: { name: string; page: string; config: SavedViewConfig; isPublic: boolean }) => {
      const response = await apiRequest("POST", '/api/saved-views', data);
      return response.json() as Promise<SavedView>;
    },
    onSuccess: (view: SavedView) => {
      queryClient.invalidateQueries({ queryKey: ['/api/saved-views'] });
      onViewChange(view.id);
      setSaveDialogOpen(false);
      setNewViewName("");
      setIsPublic(false);
      toast({ title: "View saved", description: `"${view.name}" has been created.` });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save view.", variant: "destructive" });
    },
  });

  const updateViewMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<{ name: string; config: SavedViewConfig; isPublic: boolean }> }) => {
      const response = await apiRequest("PATCH", `/api/saved-views/${id}`, updates);
      return response.json() as Promise<SavedView>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/saved-views'] });
      toast({ title: "View updated", description: "Your changes have been saved." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update view.", variant: "destructive" });
    },
  });

  const deleteViewMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/saved-views/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/saved-views'] });
      if (currentViewId === viewToDelete?.id) {
        onViewChange(null);
      }
      setDeleteConfirmOpen(false);
      setViewToDelete(null);
      toast({ title: "View deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete view.", variant: "destructive" });
    },
  });

  const handleSaveNew = () => {
    if (!newViewName.trim()) return;
    createViewMutation.mutate({
      name: newViewName.trim(),
      page,
      config: getCurrentConfig(),
      isPublic,
    });
  };

  const handleUpdateCurrent = () => {
    if (!currentViewId) return;
    updateViewMutation.mutate({
      id: currentViewId,
      updates: { config: getCurrentConfig() },
    });
  };

  const handleCopyLink = () => {
    if (!currentViewId) return;
    const url = `${window.location.origin}${window.location.pathname}?view=${currentViewId}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied", description: "View link copied to clipboard." });
  };

  const handleDeleteClick = (view: SavedView, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewToDelete(view);
    setDeleteConfirmOpen(true);
  };

  const handleDragStart = (e: React.DragEvent, columnKey: string) => {
    setDraggedColumn(columnKey);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', columnKey);
  };

  const handleDragOver = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedColumn || draggedColumn === targetKey) return;
    setDragOverColumn(targetKey);
  };

  const handleDragLeave = () => {
    setDragOverColumn(null);
  };

  const handleDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    if (!draggedColumn || draggedColumn === targetKey) {
      setDraggedColumn(null);
      setDragOverColumn(null);
      return;
    }

    const newOrder = [...visibleColumns];
    const draggedIndex = newOrder.indexOf(draggedColumn);
    const targetIndex = newOrder.indexOf(targetKey);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      newOrder.splice(draggedIndex, 1);
      newOrder.splice(targetIndex, 0, draggedColumn);
      onColumnsChange(newOrder);
    }

    setDraggedColumn(null);
    setDragOverColumn(null);
  };

  const handleDragEnd = () => {
    setDraggedColumn(null);
    setDragOverColumn(null);
  };

  const toggleColumn = (columnKey: string) => {
    if (visibleColumns.includes(columnKey)) {
      if (visibleColumns.length > 1) {
        onColumnsChange(visibleColumns.filter(c => c !== columnKey));
      }
    } else {
      onColumnsChange([...visibleColumns, columnKey]);
    }
  };

  const resetToDefault = () => {
    const defaultColumns = columns
      .filter(c => c.defaultVisible !== false)
      .map(c => c.key);
    onColumnsChange(defaultColumns);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-w-[180px] justify-between" data-testid="button-view-selector">
              <span className="truncate">{currentView?.name || "Default View"}</span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem
              onClick={() => onViewChange(null)}
              data-testid="menu-item-default-view"
            >
              <span className="flex-1">Default View</span>
              {!currentViewId && <Check className="h-4 w-4" />}
            </DropdownMenuItem>
            {savedViews.length > 0 && <DropdownMenuSeparator />}
            {savedViews.map((view) => (
              <DropdownMenuItem
                key={view.id}
                onClick={() => onViewChange(view.id)}
                className="flex items-center justify-between"
                data-testid={`menu-item-view-${view.id}`}
              >
                <span className="flex-1 truncate">{view.name}</span>
                <div className="flex items-center gap-1">
                  {view.isPublic && <Link2 className="h-3 w-3 text-muted-foreground" />}
                  {currentViewId === view.id && <Check className="h-4 w-4" />}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => handleDeleteClick(view, e)}
                    data-testid={`button-delete-view-${view.id}`}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSaveDialogOpen(true)} data-testid="menu-item-save-view">
              <Save className="mr-2 h-4 w-4" />
              Save current as new view
            </DropdownMenuItem>
            {currentViewId && (
              <DropdownMenuItem onClick={handleUpdateCurrent} data-testid="menu-item-update-view">
                <Save className="mr-2 h-4 w-4" />
                Update "{currentView?.name}"
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="icon"
          onClick={() => setColumnSettingsOpen(true)}
          data-testid="button-column-settings"
        >
          <Settings2 className="h-4 w-4" />
        </Button>

        {currentViewId && currentView?.isPublic && (
          <Button
            variant="outline"
            size="icon"
            onClick={handleCopyLink}
            data-testid="button-copy-view-link"
          >
            <Copy className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent data-testid="dialog-save-view">
          <DialogHeader>
            <DialogTitle>Save View</DialogTitle>
            <DialogDescription>
              Save your current column configuration and filters as a named view.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="view-name">View Name</Label>
              <Input
                id="view-name"
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                placeholder="My Custom View"
                data-testid="input-view-name"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="is-public">Make Shareable</Label>
                <p className="text-sm text-muted-foreground">
                  Allow others to access this view via link
                </p>
              </div>
              <Switch
                id="is-public"
                checked={isPublic}
                onCheckedChange={setIsPublic}
                data-testid="switch-is-public"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)} data-testid="button-cancel-save">
              Cancel
            </Button>
            <Button
              onClick={handleSaveNew}
              disabled={!newViewName.trim() || createViewMutation.isPending}
              data-testid="button-confirm-save"
            >
              {createViewMutation.isPending ? "Saving..." : "Save View"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={columnSettingsOpen} onOpenChange={setColumnSettingsOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-column-settings">
          <DialogHeader>
            <DialogTitle>Column Settings</DialogTitle>
            <DialogDescription>
              Configure which columns are visible and their display order.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="flex justify-between items-center mb-4">
              <p className="text-sm text-muted-foreground">
                Drag to reorder, toggle visibility
              </p>
              <Button variant="outline" size="sm" onClick={resetToDefault} data-testid="button-reset-columns">
                Reset to Default
              </Button>
            </div>
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-1">
                {columns.map((column) => {
                  const isVisible = visibleColumns.includes(column.key);
                  const orderIndex = visibleColumns.indexOf(column.key);
                  const isDragging = draggedColumn === column.key;
                  const isDropTarget = dragOverColumn === column.key && draggedColumn !== column.key;
                  return (
                    <div
                      key={column.key}
                      draggable={isVisible}
                      onDragStart={(e) => handleDragStart(e, column.key)}
                      onDragOver={(e) => handleDragOver(e, column.key)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, column.key)}
                      onDragEnd={handleDragEnd}
                      className={`flex items-center gap-2 p-2 rounded-md border transition-colors ${
                        isVisible ? 'bg-background' : 'bg-muted/50'
                      } ${isDragging ? 'opacity-50 border-dashed' : ''} ${
                        isDropTarget ? 'border-primary bg-primary/10' : ''
                      }`}
                      data-testid={`column-item-${column.key}`}
                    >
                      {isVisible && (
                        <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab active:cursor-grabbing" />
                      )}
                      {!isVisible && <div className="w-4" />}
                      <span className="flex-1 text-sm select-none">
                        {column.label}
                        {isVisible && orderIndex !== -1 && (
                          <span className="ml-2 text-xs text-muted-foreground">#{orderIndex + 1}</span>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleColumn(column.key)}
                        data-testid={`button-toggle-column-${column.key}`}
                      >
                        {isVisible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button onClick={() => setColumnSettingsOpen(false)} data-testid="button-close-column-settings">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete View</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{viewToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => viewToDelete && deleteViewMutation.mutate(viewToDelete.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
