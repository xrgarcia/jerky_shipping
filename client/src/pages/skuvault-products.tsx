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
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Package, ChevronLeft, ChevronRight, Filter, X } from "lucide-react";
import type { SkuvaultProduct } from "@shared/schema";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_PLACEHOLDER_IMAGE = "https://placehold.co/64x64/e2e8f0/64748b?text=No+Image";

interface SkuvaultProductsResponse {
  products: SkuvaultProduct[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  categories: string[];
}

export default function SkuvaultProducts() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [assembledFilter, setAssembledFilter] = useState<string>("all");

  // Debounce search input
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
    queryKey: ["/api/skuvault-products", queryParams],
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

  const products = data?.products || [];
  const totalProducts = data?.total || 0;
  const totalPages = data?.totalPages || 1;
  const categories = data?.categories || [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">SkuVault Products</h1>
          <p className="text-muted-foreground mt-1">
            Centralized product catalog synced hourly from SkuVault
          </p>
        </div>
        <Badge variant="outline" className="text-sm" data-testid="badge-total-products">
          <Package className="w-4 h-4 mr-1" />
          {totalProducts.toLocaleString()} products
        </Badge>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="w-5 h-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[250px]">
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

            <div className="w-[180px]">
              <label className="text-sm font-medium mb-1.5 block">Category</label>
              <Select value={categoryFilter} onValueChange={handleCategoryChange}>
                <SelectTrigger data-testid="select-category">
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

            <div className="w-[160px]">
              <label className="text-sm font-medium mb-1.5 block">Product Type</label>
              <Select value={assembledFilter} onValueChange={handleAssembledChange}>
                <SelectTrigger data-testid="select-assembled">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="true">Assembled (Kits)</SelectItem>
                  <SelectItem value="false">Individual</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-[120px]">
              <label className="text-sm font-medium mb-1.5 block">Per page</label>
              <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
                <SelectTrigger data-testid="select-page-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={size.toString()}>
                      {size} rows
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                className="h-9"
                data-testid="button-clear-filters"
              >
                <X className="w-4 h-4 mr-1" />
                Clear
              </Button>
            )}
          </div>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">Image</TableHead>
                    <TableHead className="w-[150px]">SKU</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-[150px]">Barcode</TableHead>
                    <TableHead className="w-[120px]">Category</TableHead>
                    <TableHead className="w-[80px] text-center">Type</TableHead>
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
                        <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded" data-testid={`text-sku-${product.sku}`}>
                          {product.sku}
                        </code>
                      </TableCell>
                      <TableCell>
                        <span className="line-clamp-2" title={product.productTitle || ""}>
                          {product.productTitle || "-"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-sm text-muted-foreground">
                          {product.barcode || "-"}
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
                          <Badge variant="default" className="text-xs">Kit</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Individual</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {product.unitCost ? `$${parseFloat(product.unitCost).toFixed(2)}` : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between px-4 py-3 border-t">
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
                    Previous
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
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
