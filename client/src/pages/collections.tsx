import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Upload,
  FileSpreadsheet,
  Eye,
  AlertTriangle,
  ExternalLink
} from "lucide-react";
import { Link } from "wouter";
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

interface AssignedSkusResponse {
  assignedSkus: string[];
}

export default function Collections() {
  const { toast } = useToast();
  
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showViewEditDialog, setShowViewEditDialog] = useState(false);
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
  const [editingCollection, setEditingCollection] = useState<CollectionWithCount | null>(null);
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
  const [tableSearch, setTableSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(productSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [productSearch]);

  // Clear selected SKUs when filters change
  useEffect(() => {
    setSelectedSkus(new Set());
  }, [categoryFilter, kitFilter, showUncategorizedOnly, debouncedSearch]);

  // Reset product search state when modal opens/closes
  useEffect(() => {
    if (showViewEditDialog && selectedCollectionId) {
      setShowUncategorizedOnly(true);
      setProductSearch("");
      setDebouncedSearch("");
      setSelectedSkus(new Set());
    }
  }, [showViewEditDialog, selectedCollectionId]);

  const { data: collectionsData, isLoading: collectionsLoading } = useQuery<CollectionsResponse>({
    queryKey: ["/api/collections"],
  });

  const { data: collectionProductsData, isLoading: collectionProductsLoading, refetch: refetchProducts } = useQuery<CollectionProductsResponse>({
    queryKey: ["/api/collections", selectedCollectionId, "products"],
    enabled: !!selectedCollectionId && showViewEditDialog,
  });

  const { data: filtersData } = useQuery<FiltersResponse>({
    queryKey: ["/api/product-catalog/filters"],
    staleTime: 5 * 60 * 1000,
  });

  const { data: categoriesData } = useQuery<{ categories: string[] }>({
    queryKey: ["/api/collections/categories"],
    staleTime: 5 * 60 * 1000,
  });
  const productCategories = categoriesData?.categories || [];

  const { data: assignedSkusData } = useQuery<AssignedSkusResponse>({
    queryKey: ["/api/collections/assigned-skus"],
    staleTime: 30 * 1000,
  });

  const assignedSkusGlobal = useMemo(() => {
    return new Set(assignedSkusData?.assignedSkus || []);
  }, [assignedSkusData]);

  const hasActiveFilters = categoryFilter !== "all" || kitFilter !== "either" || showUncategorizedOnly;
  const shouldQuery = (showViewEditDialog && !!selectedCollectionId) || debouncedSearch.length >= 2 || hasActiveFilters;

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
  const collectionProducts = collectionProductsData?.mappings || [];
  
  // Filter and sort collections by name
  const filteredCollections = useMemo(() => {
    let result = [...collections];
    
    if (tableSearch.trim()) {
      const search = tableSearch.toLowerCase();
      result = result.filter(c => 
        c.name.toLowerCase().includes(search) ||
        (c.description?.toLowerCase().includes(search)) ||
        (c.productCategory?.toLowerCase().includes(search))
      );
    }
    
    // Always sort alphabetically by name
    result.sort((a, b) => a.name.localeCompare(b.name));
    
    return result;
  }, [collections, tableSearch]);
  
  const catalogProducts = useMemo(() => {
    const products = catalogData?.products || [];
    if (!showUncategorizedOnly) return products;
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
      // Open the view/edit modal for the new collection with form data populated
      setSelectedCollectionId(newCollection.id);
      setEditingCollection(newCollection);
      setFormData({
        name: newCollection.name || "",
        description: newCollection.description || "",
        incrementalQuantity: newCollection.incrementalQuantity != null ? String(newCollection.incrementalQuantity) : "",
        productCategory: newCollection.productCategory || "",
      });
      setShowViewEditDialog(true);
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
      setShowViewEditDialog(false);
      setSelectedCollectionId(null);
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

  const { data: pendingData, refetch: refetchPending } = useQuery<{ pendingCount: number; uncategorizedProductCount: number }>({
    queryKey: ["/api/collections/pending-fingerprints"],
    refetchInterval: 30000,
  });

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
          description: `${data.completed} shipments completed, ${data.stillPending} still pending`,
        });
      } else if (data.stillPending > 0) {
        toast({
          title: "Products need assignment",
          description: `${data.stillPending} shipments have uncategorized products`,
          variant: "destructive",
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

  const handleSaveChanges = () => {
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

  const openViewEditDialog = (collection: CollectionWithCount) => {
    setEditingCollection(collection);
    setSelectedCollectionId(collection.id);
    setFormData({
      name: collection.name,
      description: collection.description || "",
      incrementalQuantity: collection.incrementalQuantity != null ? String(collection.incrementalQuantity) : "",
      productCategory: collection.productCategory || "",
    });
    setShowViewEditDialog(true);
  };

  const openDeleteDialog = (collection: CollectionWithCount) => {
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

  const selectableProducts = useMemo(() => {
    return catalogProducts.filter(p => !assignedSkusInCollection.has(p.sku));
  }, [catalogProducts, assignedSkusInCollection]);

  const allVisibleSelected = selectableProducts.length > 0 && 
    selectableProducts.every(p => selectedSkus.has(p.sku));

  const someVisibleSelected = selectableProducts.some(p => selectedSkus.has(p.sku));

  const handleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedSkus(prev => {
        const next = new Set(prev);
        selectableProducts.forEach(p => next.delete(p.sku));
        return next;
      });
    } else {
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
    <div className="p-6 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold font-serif">Geometry Collections</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Group products with similar physical characteristics for shipping
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingData && pendingData.pendingCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-md border border-amber-200 dark:border-amber-800">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="text-sm text-amber-800 dark:text-amber-200">
                {pendingData.pendingCount.toLocaleString()} orders waiting on{" "}
                <strong>{pendingData.uncategorizedProductCount || 0}</strong> uncategorized product{pendingData.uncategorizedProductCount !== 1 ? "s" : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                asChild
                className="h-7 text-xs border-amber-300"
                data-testid="button-view-uncategorized"
              >
                <Link href="/fulfillment-prep?tab=categorize">
                  <ExternalLink className="h-3 w-3 mr-1" />
                  View Products
                </Link>
              </Button>
            </div>
          )}
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
            New Collection
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search collections by name, description, or category..."
          value={tableSearch}
          onChange={(e) => setTableSearch(e.target.value)}
          className="pl-9 max-w-md"
          data-testid="input-table-search"
        />
      </div>

      {/* Collections Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[250px]">Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[150px]">Product Category</TableHead>
              <TableHead className="w-[100px] text-center">Products</TableHead>
              <TableHead className="w-[80px] text-center">Inc. Qty</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collectionsLoading ? (
              [...Array(5)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-5 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-60" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-12 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-10 mx-auto" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-20 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : filteredCollections.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Layers className="h-10 w-10 text-muted-foreground" />
                    <p className="text-muted-foreground">
                      {tableSearch ? "No collections match your search" : "No geometry collections yet"}
                    </p>
                    {!tableSearch && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setFormData(defaultFormData);
                          setShowCreateDialog(true);
                        }}
                        className="mt-2 bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Create First Collection
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredCollections.map((collection) => (
                <TableRow 
                  key={collection.id} 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => openViewEditDialog(collection)}
                  data-testid={`collection-row-${collection.id}`}
                >
                  <TableCell className="font-medium" data-testid={`text-collection-name-${collection.id}`}>
                    {collection.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground truncate max-w-[300px]">
                    {collection.description || "—"}
                  </TableCell>
                  <TableCell>
                    {collection.productCategory ? (
                      <Badge variant="outline" className="text-xs">
                        {collection.productCategory}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{collection.productCount}</Badge>
                  </TableCell>
                  <TableCell className="text-center text-muted-foreground">
                    {collection.incrementalQuantity ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          openViewEditDialog(collection);
                        }}
                        data-testid={`button-view-collection-${collection.id}`}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="hover:bg-destructive/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeleteDialog(collection);
                        }}
                        data-testid={`button-delete-collection-${collection.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create Collection Dialog */}
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
              <div className="grid grid-cols-2 gap-4">
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
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      {productCategories.map(category => (
                        <SelectItem key={category} value={category}>{category}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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

      {/* View/Edit Collection Modal */}
      <Dialog open={showViewEditDialog} onOpenChange={(open) => {
        if (!open) {
          setShowViewEditDialog(false);
          setSelectedCollectionId(null);
          setEditingCollection(null);
        }
      }}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif flex items-center gap-3">
              {editingCollection?.name}
              <Badge variant="secondary">{collectionProducts.length} products</Badge>
            </DialogTitle>
            {editingCollection?.productCategory && (
              <p className="text-sm text-muted-foreground">
                Auto-populated from category: <span className="font-medium">{editingCollection.productCategory}</span>
              </p>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* Collection Details Form */}
            <div className="grid grid-cols-4 gap-3 p-4 bg-muted/30 rounded-lg border">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Name</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="h-9"
                  data-testid="input-edit-collection-name"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Description</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  className="h-9"
                  data-testid="input-edit-collection-description"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Inc. Qty</Label>
                <Input
                  type="number"
                  min="1"
                  value={formData.incrementalQuantity}
                  onChange={(e) => setFormData(prev => ({ ...prev, incrementalQuantity: e.target.value }))}
                  className="h-9"
                  data-testid="input-edit-collection-incremental-qty"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Category</Label>
                <Select 
                  value={formData.productCategory} 
                  onValueChange={(value) => setFormData(prev => ({ ...prev, productCategory: value }))}
                >
                  <SelectTrigger className="h-9" data-testid="select-edit-collection-category">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {productCategories.map(category => (
                      <SelectItem key={category} value={category}>{category}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Two-Column Layout: Products in Collection | Add Products */}
            <div className="flex-1 grid grid-cols-2 gap-4 min-h-0 overflow-hidden">
              {/* Left: Products IN Collection */}
              <div className="flex flex-col border rounded-lg overflow-hidden">
                <div className="p-3 bg-[#6B8E23]/10 border-b flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-[#6B8E23]" />
                    <span className="font-semibold text-sm">Products IN Collection</span>
                  </div>
                  <Badge className="bg-[#6B8E23] text-white">{collectionProducts.length}</Badge>
                </div>
                <ScrollArea className="flex-1">
                  {collectionProductsLoading ? (
                    <div className="p-3 space-y-2">
                      {[...Array(4)].map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : collectionProducts.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-sm">
                      No products assigned yet
                    </div>
                  ) : (
                    <div className="p-2 space-y-1">
                      {collectionProducts.map((mapping) => (
                        <div
                          key={mapping.id}
                          className="flex items-center justify-between gap-2 p-2 rounded-md bg-card border"
                          data-testid={`product-in-collection-${mapping.sku}`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Package className="h-4 w-4 text-[#6B8E23] shrink-0" />
                            <div className="min-w-0">
                              <span className="font-mono text-xs font-semibold">{mapping.sku}</span>
                              {mapping.product?.productTitle && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {mapping.product.productTitle}
                                </p>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 hover:bg-destructive/10 shrink-0"
                            onClick={() => removeProductMutation.mutate({
                              collectionId: selectedCollectionId!,
                              mappingId: mapping.id,
                            })}
                            disabled={removeProductMutation.isPending}
                            data-testid={`button-remove-product-${mapping.sku}`}
                          >
                            <X className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>

              {/* Right: Search & Add Products */}
              <div className="flex flex-col border rounded-lg overflow-hidden">
                <div className="p-3 bg-muted/50 border-b flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <span className="font-semibold text-sm">Add Products</span>
                  </div>
                  {selectedSkus.size > 0 && (
                    <Button
                      size="sm"
                      onClick={handleAddSelectedProducts}
                      disabled={addProductsMutation.isPending}
                      className="h-7 bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                      data-testid="button-add-selected-products"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add {selectedSkus.size}
                    </Button>
                  )}
                </div>

                <div className="p-2 border-b space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <Input
                      placeholder="Search SKU, title, barcode..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      className="pl-7 h-8 text-xs"
                      data-testid="input-product-search"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                      <SelectTrigger className="h-7 text-xs flex-1" data-testid="select-category-filter">
                        <SelectValue placeholder="Category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Categories</SelectItem>
                        {filtersData?.categories.map((cat) => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1">
                      <Checkbox
                        id="uncategorized-modal"
                        checked={showUncategorizedOnly}
                        onCheckedChange={(checked) => setShowUncategorizedOnly(checked === true)}
                        data-testid="checkbox-uncategorized-filter"
                      />
                      <Label htmlFor="uncategorized-modal" className="text-xs cursor-pointer whitespace-nowrap">
                        Not in any collection
                      </Label>
                    </div>
                  </div>
                </div>

                <ScrollArea className="flex-1">
                  {catalogLoading ? (
                    <div className="p-2 space-y-2">
                      {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : catalogProducts.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-sm">
                      No products found
                    </div>
                  ) : (
                    <div className="p-2 space-y-1">
                      {selectableProducts.length > 0 && (
                        <div 
                          className="flex items-center gap-2 p-2 rounded-md border bg-muted/30 sticky top-0 z-10"
                          data-testid="select-all-row"
                        >
                          <Checkbox
                            checked={allVisibleSelected}
                            onCheckedChange={handleSelectAll}
                            data-testid="checkbox-select-all"
                          />
                          <span className="text-xs font-semibold">
                            Select All ({selectableProducts.length})
                          </span>
                        </div>
                      )}
                      {catalogProducts.map((product) => {
                        const isInCollection = assignedSkusInCollection.has(product.sku);
                        const isSelected = selectedSkus.has(product.sku);
                        
                        return (
                          <div
                            key={product.sku}
                            className={`flex items-center gap-2 p-2 rounded-md border text-xs ${
                              isInCollection
                                ? "bg-muted/40 opacity-50"
                                : isSelected
                                  ? "bg-[#6B8E23]/10 border-[#6B8E23]/40"
                                  : "bg-card hover:bg-muted/20"
                            }`}
                            data-testid={`catalog-product-${product.sku}`}
                          >
                            <Checkbox
                              checked={isSelected || isInCollection}
                              disabled={isInCollection}
                              onCheckedChange={() => toggleSkuSelection(product.sku)}
                              data-testid={`checkbox-product-${product.sku}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="font-mono font-semibold">{product.sku}</span>
                                {isInCollection && (
                                  <Badge variant="outline" className="text-[10px] h-4 text-[#6B8E23]">
                                    Added
                                  </Badge>
                                )}
                              </div>
                              <p className="text-muted-foreground truncate">
                                {product.productTitle}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 border-t pt-4">
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => openDeleteDialog(editingCollection!)}
              data-testid="button-delete-from-modal"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
            <div className="flex-1" />
            <Button
              variant="outline"
              onClick={() => setShowViewEditDialog(false)}
              data-testid="button-close-modal"
            >
              Close
            </Button>
            <Button
              onClick={handleSaveChanges}
              disabled={!formData.name.trim() || updateMutation.isPending}
              className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
              data-testid="button-save-changes"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Geometry Collection?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{editingCollection?.name}" and remove all product assignments.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Import Collections</DialogTitle>
            <DialogDescription>
              Upload a CSV file with collection_name and sku columns
            </DialogDescription>
          </DialogHeader>
          
          {!importResult ? (
            <div className="space-y-4 py-4">
              <div className="border-2 border-dashed rounded-lg p-6 text-center">
                <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-3">
                  CSV format: collection_name, sku
                </p>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  className="max-w-xs mx-auto"
                  data-testid="input-import-file"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-4">
              <div className="p-4 rounded-lg bg-muted">
                <h4 className="font-medium mb-2">Import Summary</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>Total Rows: {importResult.summary?.totalRows}</div>
                  <div>Collections Created: {importResult.summary?.collectionsCreated}</div>
                  <div>Collections Existing: {importResult.summary?.collectionsExisting}</div>
                  <div>Mappings Created: {importResult.summary?.mappingsCreated}</div>
                  <div>Mappings Skipped: {importResult.summary?.mappingsSkipped}</div>
                  <div className="text-destructive">Errors: {importResult.summary?.errors}</div>
                </div>
              </div>
              {importResult.errors && importResult.errors.length > 0 && (
                <div className="p-4 rounded-lg bg-destructive/10 text-sm">
                  <h4 className="font-medium mb-2 text-destructive">Errors:</h4>
                  <ul className="list-disc list-inside space-y-1">
                    {importResult.errors.slice(0, 10).map((err, i) => (
                      <li key={i} className="text-destructive">{err}</li>
                    ))}
                    {importResult.errors.length > 10 && (
                      <li className="text-muted-foreground">...and {importResult.errors.length - 10} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button 
              variant="outline" 
              onClick={() => {
                setShowImportDialog(false);
                setImportResult(null);
                setImportFile(null);
              }}
              data-testid="button-close-import"
            >
              {importResult ? "Close" : "Cancel"}
            </Button>
            {!importResult && (
              <Button 
                onClick={handleImport}
                disabled={!importFile || importMutation.isPending}
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                data-testid="button-submit-import"
              >
                {importMutation.isPending ? "Importing..." : "Import"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
