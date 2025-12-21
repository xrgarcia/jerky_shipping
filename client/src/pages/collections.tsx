import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Pencil, 
  Trash2, 
  RefreshCw,
  Layers,
  Search,
  Package,
  Check,
  X,
  Boxes,
  Upload,
  FileSpreadsheet
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ProductCollection } from "@shared/schema";

interface ProductCatalogItem {
  sku: string;
  productTitle: string | null;
  barcode: string | null;
  productCategory: string | null;
  isAssembledProduct: boolean;
  unitCost: string | null;
  productImageUrl: string | null;
}

interface CollectionWithCount extends ProductCollection {
  productCount: number;
}

interface CollectionMappingWithDetails {
  id: string;
  sku: string;
  productCollectionId: string;
  product?: ProductCatalogItem;
}

interface ProductCatalogResponse {
  products: ProductCatalogItem[];
  total: number;
}

interface CollectionsResponse {
  collections: CollectionWithCount[];
}

interface CollectionProductsResponse {
  mappings: CollectionMappingWithDetails[];
  collection: ProductCollection;
}

interface FiltersResponse {
  categories: string[];
}

interface UncategorizedProduct {
  sku: string;
  description: string | null;
  shipmentCount: number;
}

interface UncategorizedResponse {
  uncategorizedProducts: UncategorizedProduct[];
  stats: {
    totalProducts: number;
    categorizedProducts: number;
    totalShipments: number;
    shipmentsComplete: number;
    shipmentsPending: number;
  };
}

interface AssignedSkusResponse {
  assignedSkus: string[];
}

export default function Collections() {
  const { toast } = useToast();
  
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    summary?: {
      totalRows: number;
      collectionsCreated: number;
      collectionsExisting: number;
      mappingsCreated: number;
      mappingsSkipped: number;
      errors: number;
    };
    collectionsCreated?: string[];
    errors?: string[];
  } | null>(null);
  const [editingCollection, setEditingCollection] = useState<ProductCollection | null>(null);
  const [formData, setFormData] = useState({ 
    name: "", 
    description: "",
    incrementalQuantity: "",
    productCategory: "",
  });
  
  const [productSearch, setProductSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [kitFilter, setKitFilter] = useState("either");
  const [showUncategorizedOnly, setShowUncategorizedOnly] = useState(false);
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(productSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearch]);

  // Auto-enable uncategorized filter and clear search when a collection is selected
  useEffect(() => {
    if (selectedCollectionId) {
      setShowUncategorizedOnly(true);
      setProductSearch("");
      setDebouncedSearch("");
      setCategoryFilter("all");
      setKitFilter("either");
      setSelectedSkus(new Set());
    }
  }, [selectedCollectionId]);

  const { data: collectionsData, isLoading: collectionsLoading, refetch: refetchCollections } = useQuery<CollectionsResponse>({
    queryKey: ["/api/collections"],
  });

  const { data: collectionProductsData, isLoading: collectionProductsLoading } = useQuery<CollectionProductsResponse>({
    queryKey: ["/api/collections", selectedCollectionId, "products"],
    enabled: !!selectedCollectionId,
  });

  // Fetch filter options
  const { data: filtersData } = useQuery<FiltersResponse>({
    queryKey: ["/api/product-catalog/filters"],
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Fetch product categories for collection form dropdown
  const { data: categoriesData } = useQuery<{ categories: string[] }>({
    queryKey: ["/api/collections/categories"],
    staleTime: 5 * 60 * 1000,
  });
  const productCategories = categoriesData?.categories || [];

  // Fetch all SKUs that have collection assignments (for uncategorized filter)
  const { data: assignedSkusData } = useQuery<AssignedSkusResponse>({
    queryKey: ["/api/collections/assigned-skus"],
    staleTime: 30 * 1000,
  });

  const assignedSkusGlobal = useMemo(() => {
    return new Set(assignedSkusData?.assignedSkus || []);
  }, [assignedSkusData]);

  // Check if we have any active filters
  const hasActiveFilters = categoryFilter !== "all" || kitFilter !== "either" || showUncategorizedOnly;
  // Auto-load products when a collection is selected, or when searching/filtering
  const shouldQuery = !!selectedCollectionId || debouncedSearch.length >= 2 || hasActiveFilters;

  const productCatalogQuery = useQuery<ProductCatalogResponse>({
    queryKey: ["/api/product-catalog", { 
      search: debouncedSearch, 
      category: categoryFilter, 
      isKit: kitFilter,
      loadAll: showUncategorizedOnly || !!selectedCollectionId
    }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (kitFilter !== "either") params.set("isKit", kitFilter);
      // Load all products when showing uncategorized or when a collection is selected
      if (showUncategorizedOnly || selectedCollectionId) params.set("loadAll", "true");
      
      const res = await fetch(`/api/product-catalog?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch products");
      return res.json();
    },
    enabled: shouldQuery,
    staleTime: 0,
    gcTime: 0,
  });
  
  const catalogData = productCatalogQuery.data;
  const catalogLoading = productCatalogQuery.isLoading || productCatalogQuery.isFetching;

  const collections = collectionsData?.collections || [];
  const selectedCollection = collections.find(c => c.id === selectedCollectionId);
  const collectionProducts = collectionProductsData?.mappings || [];
  
  // Filter catalog products by uncategorized if checkbox is checked
  // Uses assignedSkusGlobal (all SKUs with ANY collection) for accurate filtering
  const catalogProducts = useMemo(() => {
    const products = catalogData?.products || [];
    if (!showUncategorizedOnly) return products;
    // Show products that are NOT in any collection
    return products.filter(p => !assignedSkusGlobal.has(p.sku));
  }, [catalogData?.products, showUncategorizedOnly, assignedSkusGlobal]);

  const assignedSkusInCollection = useMemo(() => {
    return new Set(collectionProducts.map(m => m.sku));
  }, [collectionProducts]);

  const defaultFormData = { 
    name: "", 
    description: "",
    incrementalQuantity: "",
    productCategory: "",
  };

  const createMutation = useMutation({
    mutationFn: async (data: { 
      name: string; 
      description?: string;
      incrementalQuantity?: number | null;
      productCategory?: string;
    }) => {
      const res = await apiRequest("POST", "/api/collections", data);
      return res.json();
    },
    onSuccess: (newCollection) => {
      toast({ title: "Geometry collection created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      setShowCreateDialog(false);
      setFormData(defaultFormData);
      setSelectedCollectionId(newCollection.id);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create collection",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { 
      id: string; 
      data: { 
        name?: string; 
        description?: string;
        incrementalQuantity?: number | null;
        productCategory?: string;
      } 
    }) => {
      const res = await apiRequest("PATCH", `/api/collections/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Geometry collection updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      setShowEditDialog(false);
      setEditingCollection(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update collection",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/collections/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Geometry collection deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      setShowDeleteDialog(false);
      if (selectedCollectionId === editingCollection?.id) {
        setSelectedCollectionId(null);
      }
      setEditingCollection(null);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to delete collection",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const addProductsMutation = useMutation({
    mutationFn: async ({ collectionId, skus }: { collectionId: string; skus: string[] }) => {
      const res = await apiRequest("POST", `/api/collections/${collectionId}/products`, { skus });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Products added to collection" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collections", selectedCollectionId, "products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collections/assigned-skus"] });
      setSelectedSkus(new Set());
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add products",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const removeProductMutation = useMutation({
    mutationFn: async ({ collectionId, mappingId }: { collectionId: string; mappingId: string }) => {
      const res = await apiRequest("DELETE", `/api/collections/${collectionId}/products/${mappingId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Product removed from collection" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collections", selectedCollectionId, "products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collections/assigned-skus"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to remove product",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/collections/bulk-import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Import failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/collections/assigned-skus"] });
      toast({ 
        title: "Import completed", 
        description: `Created ${data.summary.collectionsCreated} collections, ${data.summary.mappingsCreated} mappings` 
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Import failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleImport = () => {
    if (!importFile) return;
    importMutation.mutate(importFile);
  };

  // Query for pending fingerprint count
  const { data: pendingData, refetch: refetchPending } = useQuery<{ pendingCount: number }>({
    queryKey: ["/api/collections/pending-fingerprints"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Mutation for bulk recalculate fingerprints (pending only)
  const recalculateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/collections/recalculate-fingerprints");
      return res.json();
    },
    onSuccess: (data: { processed: number; completed: number; stillPending: number; errors: number; hasMore: boolean }) => {
      refetchPending();
      if (data.completed > 0) {
        toast({
          title: "Fingerprints recalculated",
          description: `${data.completed} shipments completed, ${data.stillPending} still pending (need product assignments)`,
        });
      } else if (data.stillPending > 0) {
        toast({
          title: "Products need assignment",
          description: `${data.stillPending} shipments have uncategorized products. Assign products to collections first.`,
          variant: "destructive",
        });
      }
      if (data.hasMore) {
        toast({
          title: "More to process",
          description: "Click recalculate again to process more shipments.",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Recalculation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Mutation for recalculate ALL fingerprints (including already completed ones)
  const recalculateAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/collections/recalculate-all-fingerprints");
      return res.json();
    },
    onSuccess: (data: { processed: number; completed: number; stillPending: number; errors: number; itemsUpdated: number; batches: number }) => {
      refetchPending();
      queryClient.invalidateQueries({ queryKey: ["/api/fingerprints"] });
      toast({
        title: "Recalculation complete",
        description: `${data.processed} shipments processed in ${data.batches} batches. ${data.completed} completed, ${data.stillPending} pending, ${data.itemsUpdated} items got weight data.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Recalculation failed",
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
      description: formData.description.trim() || undefined,
      incrementalQuantity: formData.incrementalQuantity ? parseInt(formData.incrementalQuantity, 10) : null,
      productCategory: formData.productCategory.trim() || undefined,
    });
  };

  const handleEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCollection || !formData.name.trim()) return;
    updateMutation.mutate({
      id: editingCollection.id,
      data: {
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        incrementalQuantity: formData.incrementalQuantity ? parseInt(formData.incrementalQuantity, 10) : null,
        productCategory: formData.productCategory.trim() || undefined,
      },
    });
  };

  const handleDelete = () => {
    if (!editingCollection) return;
    deleteMutation.mutate(editingCollection.id);
  };

  const openEditDialog = (collection: ProductCollection) => {
    setEditingCollection(collection);
    setFormData({
      name: collection.name,
      description: collection.description || "",
      incrementalQuantity: collection.incrementalQuantity != null ? String(collection.incrementalQuantity) : "",
      productCategory: collection.productCategory || "",
    });
    setShowEditDialog(true);
  };

  const openDeleteDialog = (collection: ProductCollection) => {
    setEditingCollection(collection);
    setShowDeleteDialog(true);
  };

  const toggleSkuSelection = (sku: string) => {
    setSelectedSkus(prev => {
      const next = new Set(prev);
      if (next.has(sku)) {
        next.delete(sku);
      } else {
        next.add(sku);
      }
      return next;
    });
  };

  // Get selectable products (visible products not already in collection)
  const selectableProducts = useMemo(() => {
    return catalogProducts.filter(p => !assignedSkusInCollection.has(p.sku));
  }, [catalogProducts, assignedSkusInCollection]);

  const allVisibleSelected = selectableProducts.length > 0 && 
    selectableProducts.every(p => selectedSkus.has(p.sku));

  const someVisibleSelected = selectableProducts.some(p => selectedSkus.has(p.sku));

  const handleSelectAll = () => {
    if (allVisibleSelected) {
      // Deselect all visible
      setSelectedSkus(prev => {
        const next = new Set(prev);
        selectableProducts.forEach(p => next.delete(p.sku));
        return next;
      });
    } else {
      // Select all visible
      setSelectedSkus(prev => {
        const next = new Set(prev);
        selectableProducts.forEach(p => next.add(p.sku));
        return next;
      });
    }
  };

  const handleAddSelectedProducts = () => {
    if (!selectedCollectionId || selectedSkus.size === 0) return;
    addProductsMutation.mutate({
      collectionId: selectedCollectionId,
      skus: Array.from(selectedSkus),
    });
  };

  return (
    <div className="flex h-full">
      {/* Left Panel: Collections List */}
      <div className="w-80 border-r flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold font-serif">Geometry Collections</h2>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setImportFile(null);
                  setImportResult(null);
                  setShowImportDialog(true);
                }}
                data-testid="button-import-collections"
              >
                <Upload className="h-4 w-4 mr-1" />
                Import
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setFormData(defaultFormData);
                  setShowCreateDialog(true);
                }}
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                data-testid="button-create-collection"
              >
                <Plus className="h-4 w-4 mr-1" />
                New
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Group products with similar physical characteristics
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => recalculateAllMutation.mutate()}
              disabled={recalculateAllMutation.isPending}
              className="text-xs h-6"
              data-testid="button-recalculate-all-fingerprints"
            >
              {recalculateAllMutation.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Recalculate All
                </>
              )}
            </Button>
          </div>
        </div>
        
        {/* Pending Fingerprints Banner */}
        {pendingData && pendingData.pendingCount > 0 && (
          <div className="px-4 py-2 border-b bg-amber-50 dark:bg-amber-950/30">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <RefreshCw className="h-4 w-4 text-amber-600 shrink-0" />
                <span className="text-sm text-amber-800 dark:text-amber-200 truncate">
                  {pendingData.pendingCount.toLocaleString()} shipments pending
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => recalculateMutation.mutate()}
                disabled={recalculateMutation.isPending}
                className="shrink-0 border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300"
                data-testid="button-recalculate-fingerprints"
              >
                {recalculateMutation.isPending ? (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Recalculate
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
        
        <ScrollArea className="flex-1">
          {collectionsLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : collections.length === 0 ? (
            <div className="p-6 text-center">
              <div className="w-12 h-12 mx-auto mb-3 bg-[#6B8E23]/10 rounded-full flex items-center justify-center">
                <Layers className="h-6 w-6 text-[#6B8E23]" />
              </div>
              <h3 className="font-medium mb-1">No Geometry Collections Yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first geometry collection to organize products
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setFormData(defaultFormData);
                  setShowCreateDialog(true);
                }}
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                data-testid="button-create-first-collection"
              >
                <Plus className="h-4 w-4 mr-1" />
                Create Geometry Collection
              </Button>
            </div>
          ) : (
            <div className="p-2">
              {collections.map((collection) => (
                <div
                  key={collection.id}
                  className={`p-3 rounded-lg cursor-pointer transition-all hover-elevate ${
                    selectedCollectionId === collection.id
                      ? "bg-[#6B8E23]/10 border border-[#6B8E23]/30"
                      : "hover:bg-muted/50"
                  }`}
                  onClick={() => setSelectedCollectionId(collection.id)}
                  data-testid={`collection-item-${collection.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium truncate" data-testid={`text-collection-name-${collection.id}`}>
                        {collection.name}
                      </h3>
                      {collection.description && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {collection.description}
                        </p>
                      )}
                    </div>
                    <Badge variant="secondary" className="shrink-0">
                      {collection.productCount}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditDialog(collection);
                      }}
                      data-testid={`button-edit-collection-${collection.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        openDeleteDialog(collection);
                      }}
                      data-testid={`button-delete-collection-${collection.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right Panel: Products */}
      <div className="flex-1 flex flex-col">
        {!selectedCollectionId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
                <Boxes className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium mb-1">Select a Collection</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                Choose a collection from the left panel to view and manage its products
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Collection Header */}
            <div className="p-4 border-b">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold font-serif" data-testid="text-selected-collection-name">
                    {selectedCollection?.name}
                  </h2>
                  {selectedCollection?.description && (
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {selectedCollection.description}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="text-sm">
                  {collectionProducts.length} products
                </Badge>
              </div>
            </div>

            {/* Products in Collection */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-4 border-b bg-muted/20">
                <h3 className="text-sm font-semibold text-foreground mb-2">Products in this Collection</h3>
                {collectionProductsLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : collectionProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No products assigned yet. Search below to add products.
                  </p>
                ) : (
                  <ScrollArea className="h-[200px]">
                    <div className="space-y-1">
                      {collectionProducts.map((mapping) => (
                        <div
                          key={mapping.id}
                          className="flex items-center justify-between gap-2 p-3 rounded-md bg-card border border-border"
                          data-testid={`product-in-collection-${mapping.sku}`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Package className="h-4 w-4 text-[#6B8E23] shrink-0" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold text-foreground">{mapping.sku}</span>
                                {mapping.product?.isAssembledProduct && (
                                  <Badge variant="secondary" className="text-xs">AP</Badge>
                                )}
                              </div>
                              {mapping.product?.productTitle && (
                                <p className="text-sm text-foreground/70 truncate">
                                  {mapping.product.productTitle}
                                </p>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 hover:bg-destructive/10 shrink-0"
                            onClick={() => removeProductMutation.mutate({
                              collectionId: selectedCollectionId,
                              mappingId: mapping.id,
                            })}
                            disabled={removeProductMutation.isPending}
                            data-testid={`button-remove-product-${mapping.sku}`}
                          >
                            <X className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>

              <Separator />

              {/* Product Search & Add */}
              <div className="p-4 flex-1 overflow-hidden flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <h3 className="text-sm font-semibold text-foreground">Add Products from Catalog</h3>
                  {selectedSkus.size > 0 && (
                    <Button
                      size="sm"
                      onClick={handleAddSelectedProducts}
                      disabled={addProductsMutation.isPending}
                      className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                      data-testid="button-add-selected-products"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add {selectedSkus.size} Selected
                    </Button>
                  )}
                </div>
                
                {/* Search Input */}
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by SKU, title, barcode, or category..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="pl-9"
                    data-testid="input-product-search"
                  />
                </div>

                {/* Filter Dropdowns */}
                <div className="grid grid-cols-3 gap-2 mb-3 items-center">
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-category-filter">
                      <SelectValue placeholder="Product Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {filtersData?.categories.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={kitFilter} onValueChange={setKitFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-kit-filter">
                      <SelectValue placeholder="Is Assembled Product" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="either">Either</SelectItem>
                      <SelectItem value="yes">AP Only</SelectItem>
                      <SelectItem value="no">Non-AP Only</SelectItem>
                    </SelectContent>
                  </Select>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="uncategorized-filter"
                      checked={showUncategorizedOnly}
                      onCheckedChange={(checked) => setShowUncategorizedOnly(checked === true)}
                      data-testid="checkbox-uncategorized-filter"
                    />
                    <Label htmlFor="uncategorized-filter" className="text-xs cursor-pointer">
                      Uncategorized only
                    </Label>
                  </div>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  {!shouldQuery ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      Type at least 2 characters or select a filter to search
                    </p>
                  ) : catalogLoading ? (
                    <div className="space-y-2">
                      {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : catalogProducts.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No products found matching your search/filters
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {/* Select All Row */}
                      {selectableProducts.length > 0 && (
                        <div 
                          className="flex items-center gap-3 p-3 rounded-md border border-border bg-muted/30 mb-2 sticky top-0 z-10"
                          data-testid="select-all-row"
                        >
                          <Checkbox
                            checked={allVisibleSelected}
                            ref={(el) => {
                              if (el) {
                                (el as any).indeterminate = someVisibleSelected && !allVisibleSelected;
                              }
                            }}
                            onCheckedChange={handleSelectAll}
                            data-testid="checkbox-select-all"
                          />
                          <span className="text-sm font-semibold text-foreground">
                            Select All ({selectableProducts.length} available)
                          </span>
                        </div>
                      )}
                      {catalogProducts.map((product) => {
                        const isInCollection = assignedSkusInCollection.has(product.sku);
                        const isSelected = selectedSkus.has(product.sku);
                        
                        return (
                          <div
                            key={product.sku}
                            className={`flex items-center gap-3 p-3 rounded-md border transition-all ${
                              isInCollection
                                ? "bg-muted/40 opacity-50 border-border/50"
                                : isSelected
                                  ? "bg-[#6B8E23]/10 border-[#6B8E23]/40"
                                  : "bg-card border-border hover:bg-muted/20"
                            }`}
                            data-testid={`catalog-product-${product.sku}`}
                          >
                            <Checkbox
                              checked={isSelected || isInCollection}
                              disabled={isInCollection}
                              onCheckedChange={() => toggleSkuSelection(product.sku)}
                              data-testid={`checkbox-product-${product.sku}`}
                            />
                            {product.productImageUrl && (
                              <img 
                                src={product.productImageUrl} 
                                alt={product.sku}
                                className="w-10 h-10 object-cover rounded border shrink-0"
                              />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold text-foreground">{product.sku}</span>
                                {product.isAssembledProduct && (
                                  <Badge variant="secondary" className="text-xs">AP</Badge>
                                )}
                                {isInCollection && (
                                  <Badge variant="outline" className="text-xs text-[#6B8E23] border-[#6B8E23]/40">
                                    <Check className="h-3 w-3 mr-0.5" />
                                    In Collection
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-foreground/70 truncate">
                                {product.productTitle}
                              </p>
                            </div>
                            {product.productCategory && (
                              <Badge variant="outline" className="text-xs shrink-0 bg-muted/50">
                                {product.productCategory}
                              </Badge>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create Geometry Collection Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Create Geometry Collection</DialogTitle>
            <DialogDescription>
              Group products with similar physical characteristics for shipping
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="create-name" className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="create-name"
                  placeholder='e.g., "2.5oz jerky bags"'
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-11"
                  data-testid="input-collection-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-description" className="text-sm font-medium">
                  Description
                </Label>
                <Input
                  id="create-description"
                  placeholder="Optional description of this collection"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="h-11"
                  data-testid="input-collection-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-incremental-qty" className="text-sm font-medium">
                  Incremental Qty
                </Label>
                <Input
                  id="create-incremental-qty"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="1"
                  value={formData.incrementalQuantity}
                  onChange={(e) => setFormData(prev => ({ ...prev, incrementalQuantity: e.target.value }))}
                  className="h-11"
                  data-testid="input-collection-incremental-qty"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-category" className="text-sm font-medium">
                  Product Category
                </Label>
                <Select 
                  value={formData.productCategory} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, productCategory: value }))}
                >
                  <SelectTrigger className="h-11" data-testid="select-collection-category">
                    <SelectValue placeholder="Select a category..." />
                  </SelectTrigger>
                  <SelectContent>
                    {productCategories.map(category => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Geometry Collection Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Edit Geometry Collection</DialogTitle>
            <DialogDescription>
              Update the geometry collection properties
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEdit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name" className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="edit-name"
                  placeholder='e.g., "2.5oz jerky bags"'
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-11"
                  data-testid="input-edit-collection-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-description" className="text-sm font-medium">
                  Description
                </Label>
                <Input
                  id="edit-description"
                  placeholder="Optional description of this collection"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="h-11"
                  data-testid="input-edit-collection-description"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-incremental-qty" className="text-sm font-medium">
                  Incremental Qty
                </Label>
                <Input
                  id="edit-incremental-qty"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="1"
                  value={formData.incrementalQuantity}
                  onChange={(e) => setFormData(prev => ({ ...prev, incrementalQuantity: e.target.value }))}
                  className="h-11"
                  data-testid="input-edit-collection-incremental-qty"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-category" className="text-sm font-medium">
                  Product Category
                </Label>
                <Select 
                  value={formData.productCategory} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, productCategory: value }))}
                >
                  <SelectTrigger className="h-11" data-testid="select-edit-collection-category">
                    <SelectValue placeholder="Select a category..." />
                  </SelectTrigger>
                  <SelectContent>
                    {productCategories.map(category => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Geometry Collection?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{editingCollection?.name}"? This will remove all product assignments from this geometry collection. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* CSV Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={(open) => {
        setShowImportDialog(open);
        if (!open) {
          setImportFile(null);
          setImportResult(null);
        }
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Import Collections from CSV
            </DialogTitle>
            <DialogDescription>
              Upload a CSV file to bulk create geometry collections and product mappings.
            </DialogDescription>
          </DialogHeader>
          
          {!importResult ? (
            <div className="space-y-4">
              <div className="border-2 border-dashed rounded-lg p-6 text-center">
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  className="hidden"
                  id="csv-upload"
                  data-testid="input-csv-upload"
                />
                <label 
                  htmlFor="csv-upload" 
                  className="cursor-pointer block"
                >
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  {importFile ? (
                    <p className="font-medium">{importFile.name}</p>
                  ) : (
                    <>
                      <p className="font-medium">Click to select CSV file</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        or drag and drop
                      </p>
                    </>
                  )}
                </label>
              </div>
              
              <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg">
                <p className="font-medium mb-1">Expected CSV columns:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Collection Name (required)</li>
                  <li>SKU (required)</li>
                  <li>Incremental Quantity</li>
                  <li>Classification/Category</li>
                </ul>
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => setShowImportDialog(false)}
                  data-testid="button-cancel-import"
                >
                  Cancel
                </Button>
                <Button 
                  onClick={handleImport}
                  disabled={!importFile || importMutation.isPending}
                  className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                  data-testid="button-submit-import"
                >
                  {importMutation.isPending ? "Importing..." : "Import"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <h4 className="font-medium text-green-800 dark:text-green-200 mb-2 flex items-center gap-2">
                  <Check className="h-4 w-4" />
                  Import Complete
                </h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Total Rows:</span>
                    <span className="ml-2 font-medium">{importResult.summary?.totalRows}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Collections Created:</span>
                    <span className="ml-2 font-medium">{importResult.summary?.collectionsCreated}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Collections Existing:</span>
                    <span className="ml-2 font-medium">{importResult.summary?.collectionsExisting}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Mappings Created:</span>
                    <span className="ml-2 font-medium">{importResult.summary?.mappingsCreated}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Mappings Skipped:</span>
                    <span className="ml-2 font-medium">{importResult.summary?.mappingsSkipped}</span>
                  </div>
                  {importResult.summary?.errors && importResult.summary.errors > 0 && (
                    <div>
                      <span className="text-muted-foreground">Errors:</span>
                      <span className="ml-2 font-medium text-destructive">{importResult.summary.errors}</span>
                    </div>
                  )}
                </div>
              </div>

              {importResult.collectionsCreated && importResult.collectionsCreated.length > 0 && (
                <div className="text-sm">
                  <p className="font-medium mb-1">New Collections:</p>
                  <div className="max-h-24 overflow-y-auto bg-muted/50 rounded p-2 text-xs">
                    {importResult.collectionsCreated.join(", ")}
                  </div>
                </div>
              )}

              {importResult.errors && importResult.errors.length > 0 && (
                <div className="text-sm">
                  <p className="font-medium mb-1 text-destructive">Errors:</p>
                  <div className="max-h-24 overflow-y-auto bg-destructive/10 rounded p-2 text-xs">
                    {importResult.errors.map((err, i) => (
                      <div key={i}>{err}</div>
                    ))}
                  </div>
                </div>
              )}

              <DialogFooter>
                <Button 
                  onClick={() => setShowImportDialog(false)}
                  className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                  data-testid="button-close-import"
                >
                  Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
