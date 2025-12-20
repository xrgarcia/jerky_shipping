import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Package, ChevronLeft, ChevronRight, Filter, X, Download, Loader2 } from "lucide-react";
import type { SkuvaultProduct } from "@shared/schema";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_PLACEHOLDER_IMAGE = "https://placehold.co/64x64/e2e8f0/64748b?text=No+Image";
const DEFAULT_LARGE_PLACEHOLDER = "https://placehold.co/300x300/e2e8f0/64748b?text=No+Image";

interface SkuvaultProductsResponse {
  products: SkuvaultProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  categories: string[];
}

function ProductDetailDialog({
  product,
  open,
  onClose,
}: {
  product: SkuvaultProduct | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!product) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-lg">{product.sku}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex justify-center">
            <img
              src={product.productImageUrl || DEFAULT_LARGE_PLACEHOLDER}
              alt={product.productTitle || product.sku}
              className="w-64 h-64 object-contain rounded-lg border bg-muted"
              onError={(e) => {
                (e.target as HTMLImageElement).src = DEFAULT_LARGE_PLACEHOLDER;
              }}
            />
          </div>
          
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-muted-foreground">Title</label>
              <p className="text-sm" data-testid="detail-title">{product.productTitle || "-"}</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">SKU</label>
                <p className="text-sm font-mono" data-testid="detail-sku">{product.sku}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Barcode</label>
                <p className="text-sm font-mono" data-testid="detail-barcode">{product.barcode || "-"}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Product Category</label>
                <p className="text-sm" data-testid="detail-category">
                  {product.productCategory ? (
                    <Badge variant="secondary">{product.productCategory}</Badge>
                  ) : "-"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Is Assembled Product</label>
                <p className="text-sm" data-testid="detail-assembled">
                  {product.isAssembledProduct ? (
                    <Badge variant="default">Yes</Badge>
                  ) : (
                    <Badge variant="outline">No</Badge>
                  )}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-muted-foreground">Unit Cost</label>
                <p className="text-sm font-mono" data-testid="detail-cost">
                  {product.unitCost ? `$${parseFloat(product.unitCost).toFixed(2)}` : "-"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-muted-foreground">Stock Check Date</label>
                <p className="text-sm" data-testid="detail-stock-date">
                  {product.stockCheckDate ? new Date(product.stockCheckDate).toLocaleDateString() : "-"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MobileProductCard({
  product,
  onSelect,
}: {
  product: SkuvaultProduct;
  onSelect: (product: SkuvaultProduct) => void;
}) {
  return (
    <Card 
      className="hover-elevate cursor-pointer" 
      onClick={() => onSelect(product)}
      data-testid={`card-product-${product.sku}`}
    >
      <CardContent className="p-4">
        <div className="flex gap-4">
          <img
            src={product.productImageUrl || DEFAULT_PLACEHOLDER_IMAGE}
            alt={product.productTitle || product.sku}
            className="w-16 h-16 object-cover rounded border flex-shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).src = DEFAULT_PLACEHOLDER_IMAGE;
            }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded text-primary">
                {product.sku}
              </code>
              {product.isAssembledProduct && (
                <Badge variant="default" className="text-xs">Assembled</Badge>
              )}
            </div>
            <p className="text-sm mt-1 line-clamp-2 text-muted-foreground">
              {product.productTitle || "-"}
            </p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {product.productCategory && (
                <Badge variant="secondary" className="text-xs">{product.productCategory}</Badge>
              )}
              {product.unitCost && (
                <span className="text-xs font-mono text-muted-foreground">
                  ${parseFloat(product.unitCost).toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SkuvaultProducts() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [assembledFilter, setAssembledFilter] = useState<string>("all");
  const [selectedProduct, setSelectedProduct] = useState<SkuvaultProduct | null>(null);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
    const timeoutId = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
    return () => clearTimeout(timeoutId);
  };

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", page.toString());
    params.set("pageSize", pageSize.toString());
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (categoryFilter !== "all") params.set("category", categoryFilter);
    if (assembledFilter !== "all") params.set("isAssembled", assembledFilter);
    return params.toString();
  }, [page, pageSize, debouncedSearch, categoryFilter, assembledFilter]);

  const { data, isLoading } = useQuery<SkuvaultProductsResponse>({
    queryKey: [`/api/skuvault-products?${queryParams}`],
  });

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handlePageSizeChange = (newSize: string) => {
    setPageSize(parseInt(newSize));
    setPage(1);
  };

  const handleCategoryChange = (value: string) => {
    setCategoryFilter(value);
    setPage(1);
  };

  const handleAssembledChange = (value: string) => {
    setAssembledFilter(value);
    setPage(1);
  };

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setCategoryFilter("all");
    setAssembledFilter("all");
    setPage(1);
  };

  const hasActiveFilters = search || categoryFilter !== "all" || assembledFilter !== "all";

  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (assembledFilter !== "all") params.set("isAssembled", assembledFilter);
      
      const response = await fetch(`/api/skuvault-products/export?${params.toString()}`, {
        credentials: "include",
      });
      
      if (!response.ok) {
        throw new Error("Export failed");
      }
      
      // Get the filename from the Content-Disposition header or use default
      const contentDisposition = response.headers.get("Content-Disposition");
      let filename = `skuvault-products-${new Date().toISOString().slice(0, 10)}.csv`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match) filename = match[1];
      }
      
      // Download the CSV
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      setIsExporting(false);
    }
  };

  const products = data?.products || [];
  const totalProducts = data?.total || 0;
  const totalPages = data?.totalPages || 1;
  const categories = data?.categories || [];

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">SkuVault Products</h1>
          <p className="text-sm md:text-base text-muted-foreground mt-1">
            Centralized product catalog synced hourly from SkuVault
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Badge variant="outline" className="text-sm" data-testid="badge-total-products">
            <Package className="w-4 h-4 mr-1" />
            {totalProducts.toLocaleString()} products
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={isExporting || totalProducts === 0}
            data-testid="button-export-csv"
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-1" />
                Export CSV
              </>
            )}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="w-5 h-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            <div className="sm:col-span-2 lg:col-span-1 xl:col-span-2">
              <label className="text-sm font-medium mb-1.5 block">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by SKU, title, barcode..."
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                  data-testid="input-search"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">Product Category</label>
              <Select value={categoryFilter} onValueChange={handleCategoryChange}>
                <SelectTrigger data-testid="select-product-category">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">Is Assembled Product</label>
              <Select value={assembledFilter} onValueChange={handleAssembledChange}>
                <SelectTrigger data-testid="select-is-assembled-product">
                  <SelectValue placeholder="All products" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  <SelectItem value="true">Yes (Kits/APs)</SelectItem>
                  <SelectItem value="false">No (Individual SKUs)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">Per page</label>
              <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
                <SelectTrigger data-testid="select-page-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={size.toString()}>
                      {size} per page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {hasActiveFilters && (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Active filters:</span>
              {search && (
                <Badge variant="secondary" className="text-xs">
                  Search: "{search}"
                </Badge>
              )}
              {categoryFilter !== "all" && (
                <Badge variant="secondary" className="text-xs">
                  Category: {categoryFilter}
                </Badge>
              )}
              {assembledFilter !== "all" && (
                <Badge variant="secondary" className="text-xs">
                  Assembled: {assembledFilter === "true" ? "Yes" : "No"}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-6 px-2"
                data-testid="button-clear-filters"
              >
                <X className="w-3 h-3 mr-1" />
                Clear all
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="p-12 text-center">
              <Package className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No products found</h3>
              <p className="text-muted-foreground">
                {hasActiveFilters
                  ? "Try adjusting your filters or search term"
                  : "No products have been synced yet"}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile view - Card list */}
              <div className="md:hidden p-4 space-y-3">
                {products.map((product) => (
                  <MobileProductCard
                    key={product.sku}
                    product={product}
                    onSelect={setSelectedProduct}
                  />
                ))}
              </div>

              {/* Desktop view - Table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[80px]">Image</TableHead>
                      <TableHead className="w-[150px]">SKU</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead className="w-[140px]">Product Category</TableHead>
                      <TableHead className="w-[60px] text-center">AP</TableHead>
                      <TableHead className="w-[100px] text-right">Unit Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((product) => (
                      <TableRow key={product.sku} data-testid={`row-product-${product.sku}`}>
                        <TableCell>
                          <img
                            src={product.productImageUrl || DEFAULT_PLACEHOLDER_IMAGE}
                            alt={product.productTitle || product.sku}
                            className="w-12 h-12 object-cover rounded border"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = DEFAULT_PLACEHOLDER_IMAGE;
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => setSelectedProduct(product)}
                            className="text-left hover-elevate rounded px-1.5 py-0.5"
                            data-testid={`button-sku-${product.sku}`}
                          >
                            <code className="text-sm font-mono text-primary underline underline-offset-2">
                              {product.sku}
                            </code>
                          </button>
                        </TableCell>
                        <TableCell>
                          <span title={product.productTitle || ""}>
                            {product.productTitle || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          {product.productCategory ? (
                            <Badge variant="secondary" className="text-xs">
                              {product.productCategory}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {product.isAssembledProduct ? (
                            <Badge variant="default" className="text-xs">Yes</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">No</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {product.unitCost ? `$${parseFloat(product.unitCost).toFixed(2)}` : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex flex-col sm:flex-row items-center justify-between px-4 py-3 border-t gap-4">
                <div className="text-sm text-muted-foreground">
                  Showing {((page - 1) * pageSize) + 1} - {Math.min(page * pageSize, totalProducts)} of {totalProducts.toLocaleString()}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page - 1)}
                    disabled={page <= 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">Previous</span>
                  </Button>
                  <span className="text-sm px-2">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page + 1)}
                    disabled={page >= totalPages}
                    data-testid="button-next-page"
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Product Detail Dialog */}
      <ProductDetailDialog
        product={selectedProduct}
        open={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
      />
    </div>
  );
}
