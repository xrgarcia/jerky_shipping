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
  Boxes
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ProductCollection } from "@shared/schema";

interface ProductCatalogItem {
  sku: string;
  description: string;
  supplier: string | null;
  product_category: string | null;
  quantity_available: number | null;
  is_assembled_product: boolean;
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
  suppliers: string[];
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

export default function Collections() {
  const { toast } = useToast();
  
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingCollection, setEditingCollection] = useState<ProductCollection | null>(null);
  const [formData, setFormData] = useState({ name: "", description: "" });
  
  const [productSearch, setProductSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
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

  // Fetch uncategorized products
  const { data: uncategorizedData } = useQuery<UncategorizedResponse>({
    queryKey: ["/api/packing-decisions/uncategorized"],
    staleTime: 30 * 1000, // Refresh every 30 seconds
  });

  const uncategorizedSkus = useMemo(() => {
    return new Set(uncategorizedData?.uncategorizedProducts.map(p => p.sku) || []);
  }, [uncategorizedData]);

  const uncategorizedCount = uncategorizedData?.uncategorizedProducts.length || 0;

  // Check if we have any active filters
  const hasActiveFilters = categoryFilter !== "all" || supplierFilter !== "all" || kitFilter !== "either" || showUncategorizedOnly;
  // Auto-load products when a collection is selected, or when searching/filtering
  const shouldQuery = !!selectedCollectionId || debouncedSearch.length >= 2 || hasActiveFilters;

  const productCatalogQuery = useQuery<ProductCatalogResponse>({
    queryKey: ["/api/product-catalog", { 
      search: debouncedSearch, 
      category: categoryFilter, 
      supplier: supplierFilter, 
      isKit: kitFilter 
    }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (supplierFilter !== "all") params.set("supplier", supplierFilter);
      if (kitFilter !== "either") params.set("isKit", kitFilter);
      
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
  const catalogProducts = useMemo(() => {
    const products = catalogData?.products || [];
    if (!showUncategorizedOnly) return products;
    return products.filter(p => uncategorizedSkus.has(p.sku));
  }, [catalogData?.products, showUncategorizedOnly, uncategorizedSkus]);

  const assignedSkusInCollection = useMemo(() => {
    return new Set(collectionProducts.map(m => m.sku));
  }, [collectionProducts]);

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await apiRequest("POST", "/api/collections", data);
      return res.json();
    },
    onSuccess: (newCollection) => {
      toast({ title: "Collection created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/collections"] });
      setShowCreateDialog(false);
      setFormData({ name: "", description: "" });
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
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; description?: string } }) => {
      const res = await apiRequest("PATCH", `/api/collections/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Collection updated successfully" });
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
      toast({ title: "Collection deleted successfully" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/packing-decisions/uncategorized"] });
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
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to remove product",
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
            <h2 className="text-lg font-semibold font-serif">Collections</h2>
            <Button
              size="sm"
              onClick={() => {
                setFormData({ name: "", description: "" });
                setShowCreateDialog(true);
              }}
              className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
              data-testid="button-create-collection"
            >
              <Plus className="h-4 w-4 mr-1" />
              New
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Group products with similar physical characteristics
          </p>
        </div>
        
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
              <h3 className="font-medium mb-1">No Collections Yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first collection to organize products
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setFormData({ name: "", description: "" });
                  setShowCreateDialog(true);
                }}
                className="bg-[#6B8E23] hover:bg-[#5a7a1e] text-white"
                data-testid="button-create-first-collection"
              >
                <Plus className="h-4 w-4 mr-1" />
                Create Collection
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
              <div className="p-4 border-b bg-muted/30">
                <h3 className="text-sm font-medium mb-2">Products in this Collection</h3>
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
                          className="flex items-center justify-between gap-2 p-2 rounded bg-background border"
                          data-testid={`product-in-collection-${mapping.sku}`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-medium">{mapping.sku}</span>
                                {mapping.product?.is_assembled_product && (
                                  <Badge variant="secondary" className="text-xs">Kit/AP</Badge>
                                )}
                              </div>
                              {mapping.product?.description && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {mapping.product.description}
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
                  <h3 className="text-sm font-medium">Add Products from Catalog</h3>
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
                    placeholder="Search by SKU, description, category, or supplier..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="pl-9"
                    data-testid="input-product-search"
                  />
                </div>

                {/* Filter Dropdowns */}
                <div className="grid grid-cols-4 gap-2 mb-3 items-center">
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-category-filter">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {filtersData?.categories.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={supplierFilter} onValueChange={setSupplierFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-supplier-filter">
                      <SelectValue placeholder="Supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Suppliers</SelectItem>
                      {filtersData?.suppliers.map((sup) => (
                        <SelectItem key={sup} value={sup}>{sup}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={kitFilter} onValueChange={setKitFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-kit-filter">
                      <SelectValue placeholder="Kit/AP" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="either">Either</SelectItem>
                      <SelectItem value="yes">Kit/AP Only</SelectItem>
                      <SelectItem value="no">Non-Kit Only</SelectItem>
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
                      {uncategorizedCount > 0 && (
                        <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                          {uncategorizedCount}
                        </Badge>
                      )}
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
                          className="flex items-center gap-3 p-2 rounded border bg-muted/30 mb-2 sticky top-0 z-10"
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
                          <span className="text-sm font-medium">
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
                            className={`flex items-center gap-3 p-2 rounded border transition-all ${
                              isInCollection
                                ? "bg-muted/50 opacity-60"
                                : isSelected
                                  ? "bg-[#6B8E23]/10 border-[#6B8E23]/30"
                                  : "hover:bg-muted/30"
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
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-medium">{product.sku}</span>
                                {product.is_assembled_product && (
                                  <Badge variant="secondary" className="text-xs">Kit/AP</Badge>
                                )}
                                {isInCollection && (
                                  <Badge variant="outline" className="text-xs text-[#6B8E23]">
                                    <Check className="h-3 w-3 mr-0.5" />
                                    In Collection
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground truncate">
                                {product.description}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              {product.supplier && (
                                <p className="text-xs text-muted-foreground">{product.supplier}</p>
                              )}
                              {product.quantity_available !== null && (
                                <p className="text-xs font-medium">
                                  Stock: {product.quantity_available.toLocaleString()}
                                </p>
                              )}
                            </div>
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

      {/* Create Collection Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Create New Collection</DialogTitle>
            <DialogDescription>
              Group products with similar physical characteristics for shipping
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="create-name" className="text-sm font-medium">
                  Collection Name <span className="text-destructive">*</span>
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
                {createMutation.isPending ? "Creating..." : "Create Collection"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Collection Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-serif">Edit Collection</DialogTitle>
            <DialogDescription>
              Update the collection name and description
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEdit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name" className="text-sm font-medium">
                  Collection Name <span className="text-destructive">*</span>
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
            <AlertDialogTitle>Delete Collection?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{editingCollection?.name}"? This will remove all product assignments from this collection. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Collection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
