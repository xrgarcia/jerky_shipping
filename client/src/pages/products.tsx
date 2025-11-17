import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Search, Package2, Box } from "lucide-react";
import type { Product, ProductVariant } from "@shared/schema";

interface ProductDetail {
  product: Product;
  variants: ProductVariant[];
}

export default function Products() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);

  const { data: productsData, isLoading } = useQuery<{ productsWithVariants: ProductDetail[] }>({
    queryKey: ["/api/products"],
  });

  const productsWithVariants = productsData?.productsWithVariants || [];

  const filteredProducts = productsWithVariants.filter(({ product, variants }) => {
    // Filter by active status if checkbox is checked
    if (activeOnly && product.status !== 'active') {
      return false;
    }

    // If no search query, show all (that passed active filter)
    if (!searchQuery) return true;
    
    const query = searchQuery.toLowerCase();
    
    // Search in product fields
    if (product.title.toLowerCase().includes(query) ||
        product.id.includes(query)) {
      return true;
    }
    
    // Search in variant fields (SKU and barcode)
    return variants.some(variant => 
      variant.sku?.toLowerCase().includes(query) ||
      variant.barCode?.toLowerCase().includes(query) ||
      variant.title?.toLowerCase().includes(query)
    );
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex items-center gap-2">
            <Box className="h-8 w-8 text-primary" />
            <h1 className="text-4xl font-bold font-serif">Products</h1>
          </div>
          
          <Skeleton className="h-14 w-full" data-testid="skeleton-search" />

          <div className="flex items-center gap-4">
            <Skeleton className="h-5 w-32" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} data-testid={`skeleton-product-${i}`}>
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <Skeleton className="h-8 w-3/4" />
                    <Skeleton className="h-6 w-16" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <Skeleton className="aspect-square" />
                    <div className="space-y-3">
                      <div>
                        <Skeleton className="h-4 w-16 mb-1" />
                        <Skeleton className="h-10 w-20" />
                      </div>
                      <div>
                        <Skeleton className="h-4 w-16 mb-1" />
                        <Skeleton className="h-8 w-24" />
                      </div>
                      <div>
                        <Skeleton className="h-4 w-20 mb-1" />
                        <Skeleton className="h-8 w-16" />
                      </div>
                    </div>
                  </div>
                  <div className="border-t pt-4">
                    <Skeleton className="h-5 w-32 mb-3" />
                    <div className="space-y-3">
                      <Skeleton className="h-20 w-full" />
                      <Skeleton className="h-20 w-full" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-2">
          <Box className="h-8 w-8 text-primary" />
          <h1 className="text-4xl font-bold font-serif">Products</h1>
        </div>
        
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by name, ID, SKU, or barcode..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-12 h-14 text-lg"
              data-testid="input-search-products"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Package2 className="h-4 w-4" />
              <span data-testid="text-product-count">
                {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="active-only"
                checked={activeOnly}
                onCheckedChange={(checked) => setActiveOnly(checked as boolean)}
                data-testid="checkbox-active-only"
              />
              <Label
                htmlFor="active-only"
                className="text-sm font-medium cursor-pointer"
                data-testid="label-active-only"
              >
                Active Only
              </Label>
            </div>
          </div>
        </div>

        {filteredProducts.length === 0 && searchQuery && (
          <Card>
            <CardContent className="p-12 text-center">
              <Package2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-xl font-semibold mb-2">No products found</p>
              <p className="text-muted-foreground">
                Try adjusting your search query
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredProducts.map(({ product, variants }) => (
            <Card 
              key={product.id} 
              className="hover-elevate transition-shadow"
              data-testid={`card-product-${product.id}`}
            >
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="text-2xl font-bold line-clamp-2" data-testid={`text-product-title-${product.id}`}>
                    {product.title}
                  </CardTitle>
                  <Badge 
                    variant={product.status === 'active' ? 'default' : 'secondary'}
                    className="shrink-0"
                    data-testid={`badge-product-status-${product.id}`}
                  >
                    {product.status}
                  </Badge>
                </div>
              </CardHeader>
              
              <CardContent className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    {product.imageUrl && (
                      <div className="aspect-square relative overflow-hidden rounded-md bg-muted">
                        <img
                          src={product.imageUrl}
                          alt={product.title}
                          className="object-cover w-full h-full"
                          data-testid={`img-product-${product.id}`}
                        />
                      </div>
                    )}
                    
                    {!product.imageUrl && (
                      <div className="aspect-square flex items-center justify-center bg-muted rounded-md">
                        <Package2 className="h-16 w-16 text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <p className="text-sm text-muted-foreground mb-1">Variants</p>
                      <p className="text-3xl font-bold font-mono" data-testid={`text-variant-count-${product.id}`}>
                        {variants.length}
                      </p>
                    </div>

                    {variants.length > 0 && (
                      <>
                        {variants[0].price && (
                          <div>
                            <p className="text-sm text-muted-foreground mb-1">Price</p>
                            <p className="text-2xl font-semibold" data-testid={`text-price-${product.id}`}>
                              ${variants[0].price}
                            </p>
                          </div>
                        )}

                        <div>
                          <p className="text-sm text-muted-foreground mb-1">Inventory</p>
                          <p className="text-2xl font-semibold font-mono" data-testid={`text-inventory-${product.id}`}>
                            {variants.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0)}
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {variants.length > 0 && (
                  <div className="border-t pt-4">
                    <p className="text-base font-semibold mb-3">Variant Details</p>
                    <div className="space-y-3">
                      {variants.map((variant) => (
                        <div 
                          key={variant.id}
                          className="flex items-center justify-between gap-4 p-3 bg-muted rounded-md"
                          data-testid={`variant-${variant.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-base font-medium truncate">{variant.title}</p>
                            {variant.sku && (
                              <p className="text-lg font-mono mt-1" data-testid={`text-sku-${variant.id}`}>
                                SKU: {variant.sku}
                              </p>
                            )}
                            {variant.barCode && (
                              <p className="text-base font-mono text-muted-foreground mt-1">
                                Barcode: {variant.barCode}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xl font-semibold">${variant.price}</p>
                            <Badge 
                              variant={variant.inventoryQuantity > 0 ? "default" : "secondary"}
                              className="mt-2"
                            >
                              Qty: {variant.inventoryQuantity}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
