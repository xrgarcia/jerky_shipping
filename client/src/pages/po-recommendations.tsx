import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, Calendar, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import type { PORecommendation, PORecommendationStep } from "@shared/reporting-schema";

// 24 hours in milliseconds - data only changes once per day
const STALE_TIME = 24 * 60 * 60 * 1000;

export default function PORecommendations() {
  const [, setLocation] = useLocation();
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');
  
  const [selectedSku, setSelectedSku] = useState<{ sku: string; stockCheckDate: string } | null>(null);

  // Filter states
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [search, setSearch] = useState<string>('');
  const [isAssembledProduct, setIsAssembledProduct] = useState<string>('false');
  const [sortBy, setSortBy] = useState<string>('ninety_day_forecast');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  
  // Pagination states
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(100);

  // Initialize state from URL params
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    // Parse suppliers - can be comma-separated list or multiple params
    const suppliersParam = params.get('suppliers') || '';
    setSelectedSuppliers(suppliersParam ? suppliersParam.split(',').filter(s => s) : []);
    setSearch(params.get('search') || '');
    setIsAssembledProduct(params.get('isAssembledProduct') || 'false');
    setSortBy(params.get('sortBy') || 'ninety_day_forecast');
    setSortOrder((params.get('sortOrder') as 'asc' | 'desc') || 'asc');
    setPage(parseInt(params.get('page') || '1'));
    setPageSize(parseInt(params.get('pageSize') || '100'));
    
    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]);

  // Update URL when state changes
  useEffect(() => {
    if (!isInitialized) return;
    
    const params = new URLSearchParams();
    
    if (selectedSuppliers.length > 0) params.set('suppliers', selectedSuppliers.join(','));
    if (search) params.set('search', search);
    if (isAssembledProduct !== 'false') params.set('isAssembledProduct', isAssembledProduct);
    if (sortBy !== 'ninety_day_forecast') params.set('sortBy', sortBy);
    if (sortOrder !== 'asc') params.set('sortOrder', sortOrder);
    if (page !== 1) params.set('page', page.toString());
    if (pageSize !== 100) params.set('pageSize', pageSize.toString());
    
    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/po-recommendations${newUrl}`);
    }
  }, [selectedSuppliers, search, isAssembledProduct, sortBy, sortOrder, page, pageSize, isInitialized]);

  // Fetch full snapshot once - cached for 24 hours
  const { data: rawRecommendations = [], isLoading } = useQuery<PORecommendation[]>({
    queryKey: ['/api/reporting/po-recommendations'],
    staleTime: STALE_TIME,
    gcTime: STALE_TIME,
  });

  // Get unique suppliers from the data (computed locally)
  const suppliers = useMemo(() => {
    const supplierSet = new Set(rawRecommendations.map(r => r.supplier).filter((s): s is string => s != null));
    return Array.from(supplierSet).sort();
  }, [rawRecommendations]);

  // Filter and sort locally - instant performance!
  const recommendations = useMemo(() => {
    let filtered = rawRecommendations;

    // Filter by suppliers (multi-select)
    if (selectedSuppliers.length > 0) {
      filtered = filtered.filter(r => r.supplier && selectedSuppliers.includes(r.supplier));
    }

    // Filter by isAssembledProduct
    if (isAssembledProduct && isAssembledProduct !== 'all') {
      const isAssembled = isAssembledProduct === 'true';
      filtered = filtered.filter(r => r.is_assembled_product === isAssembled);
    }

    // Filter by search term
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(r => 
        r.sku?.toLowerCase().includes(searchLower) ||
        r.title?.toLowerCase().includes(searchLower) ||
        r.supplier?.toLowerCase().includes(searchLower)
      );
    }

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      const aVal = a[sortBy as keyof PORecommendation];
      const bVal = b[sortBy as keyof PORecommendation];
      
      // Handle null/undefined values (put them at the end)
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      
      // Compare values
      let comparison = 0;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }
      
      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return sorted;
  }, [rawRecommendations, selectedSuppliers, isAssembledProduct, search, sortBy, sortOrder]);

  const { data: steps = [] } = useQuery<PORecommendationStep[]>({
    queryKey: [`/api/reporting/po-recommendation-steps/${selectedSku?.sku}/${selectedSku?.stockCheckDate}`],
    enabled: !!selectedSku,
  });

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('asc');
    }
  };
  
  // Reset to page 1 when filters change
  useEffect(() => {
    if (isInitialized) {
      setPage(1);
    }
  }, [selectedSuppliers, search, isAssembledProduct, isInitialized]);
  
  // Calculate pagination
  const totalRecords = recommendations.length;
  const totalPages = Math.ceil(totalRecords / pageSize);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRecords);
  const paginatedRecommendations = recommendations.slice(startIndex, endIndex);

  const openStepsModal = (sku: string, stockCheckDate: Date) => {
    setSelectedSku({ 
      sku, 
      stockCheckDate: new Date(stockCheckDate).toISOString().split('T')[0] 
    });
  };

  const clearFilters = () => {
    setSelectedSuppliers([]);
    setSearch('');
    setIsAssembledProduct('false');
    setSortBy('ninety_day_forecast');
    setSortOrder('asc');
    setPage(1);
  };

  // Handler to toggle supplier selection
  const toggleSupplier = (supplier: string) => {
    setSelectedSuppliers(prev => 
      prev.includes(supplier) 
        ? prev.filter(s => s !== supplier)
        : [...prev, supplier]
    );
  };

  const SortableHeader = ({ column, children }: { column: string; children: React.ReactNode }) => {
    const isActive = sortBy === column;
    const Icon = isActive ? (sortOrder === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
    
    return (
      <Button
        variant="ghost"
        onClick={() => handleSort(column)}
        className="hover-elevate"
        data-testid={`button-sort-${column}`}
      >
        {children}
        <Icon className={`ml-2 h-4 w-4 ${isActive ? 'text-primary' : ''}`} />
      </Button>
    );
  };

  const dataTimestamp = recommendations.length > 0 
    ? new Date(recommendations[0].stock_check_date).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      })
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col gap-4 p-4 border-b">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">PO Recommendations</h1>
          {dataTimestamp && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-data-timestamp">
              <Calendar className="h-4 w-4" />
              <span>Data as of: <span className="font-medium text-foreground">{dataTimestamp}</span></span>
            </div>
          )}
        </div>
        
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground px-1">Suppliers</label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="w-64 justify-between"
                  data-testid="button-supplier-filter"
                >
                  <span className="truncate">
                    {selectedSuppliers.length === 0 
                      ? "All Suppliers" 
                      : selectedSuppliers.length === 1 
                        ? selectedSuppliers[0]
                        : `${selectedSuppliers.length} suppliers selected`}
                  </span>
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-0" align="start">
                <div className="p-2 border-b">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-sm"
                    onClick={() => setSelectedSuppliers([])}
                    data-testid="button-clear-suppliers"
                  >
                    <X className="mr-2 h-4 w-4" />
                    Clear selection
                  </Button>
                </div>
                <ScrollArea className="h-64">
                  <div className="p-2 space-y-1">
                    {suppliers.map((s) => (
                      <label
                        key={s}
                        className="flex items-center gap-2 p-2 rounded-md hover-elevate cursor-pointer"
                        data-testid={`checkbox-supplier-${s}`}
                      >
                        <Checkbox
                          checked={selectedSuppliers.includes(s)}
                          onCheckedChange={() => toggleSupplier(s)}
                        />
                        <span className="text-sm truncate">{s}</span>
                      </label>
                    ))}
                  </div>
                </ScrollArea>
                {selectedSuppliers.length > 0 && (
                  <div className="p-2 border-t">
                    <div className="flex flex-wrap gap-1">
                      {selectedSuppliers.map((s) => (
                        <Badge 
                          key={s} 
                          variant="secondary" 
                          className="text-xs cursor-pointer"
                          onClick={() => toggleSupplier(s)}
                        >
                          {s}
                          <X className="ml-1 h-3 w-3" />
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground px-1">Is Assembled Product</label>
            <Select 
              value={isAssembledProduct} 
              onValueChange={setIsAssembledProduct}
            >
              <SelectTrigger className="w-48" data-testid="select-is-assembled-product">
                <SelectValue placeholder="Is Assembled Product" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="true">True</SelectItem>
                <SelectItem value="false">False</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground px-1">Search</label>
            <Input
              placeholder="Search SKU, title, or supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-80"
              data-testid="input-search"
            />
          </div>

          {(selectedSuppliers.length > 0 || search || isAssembledProduct !== 'false') && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground px-1 opacity-0">Clear</label>
              <Button
                variant="outline"
                onClick={clearFilters}
                data-testid="button-clear-filters"
              >
                <X className="h-4 w-4 mr-2" />
                Clear Filters
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-64" data-testid="loading-spinner">
            <div className="text-muted-foreground">Loading recommendations...</div>
          </div>
        ) : (
          <Table containerClassName="h-full overflow-scroll" className="min-w-[2000px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="sku">SKU</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="supplier">Supplier</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="title">Title</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="lead_time">Lead Time</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="current_total_stock">Current Stock</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="recommended_quantity">Recommended Qty</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="base_velocity">Base Velocity</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="projected_velocity">Projected Velocity</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="growth_rate">Growth Rate</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="ninety_day_forecast">90-Day Forecast</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="current_days_cover">Days Cover</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="quantity_incoming">Qty Incoming</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="kit_driven_velocity">Kit Velocity</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="individual_velocity">Individual Velocity</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="case_adjustment_applied">Case Adjustment</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="moq_applied">MOQ Applied</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="is_assembled_product">Assembled</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="next_holiday_count_down_in_days">Next Holiday Days</SortableHeader>
                </TableHead>
                <TableHead className="text-right sticky top-0 bg-background z-20">
                  <SortableHeader column="next_holiday_recommended_quantity">Holiday Rec Qty</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="next_holiday_season">Holiday Season</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20">
                  <SortableHeader column="next_holiday_start_date">Holiday Start</SortableHeader>
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {totalRecords === 0 ? (
                <TableRow>
                  <TableCell colSpan={22} className="text-center text-muted-foreground" data-testid="text-no-results">
                    No recommendations found
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRecommendations.map((rec) => (
                  <TableRow key={`${rec.sku}-${rec.stock_check_date}`} data-testid={`row-recommendation-${rec.sku}`}>
                    <TableCell className="font-medium" data-testid={`text-sku-${rec.sku}`}>{rec.sku}</TableCell>
                    <TableCell data-testid={`text-supplier-${rec.sku}`}>{rec.supplier}</TableCell>
                    <TableCell className="max-w-xs truncate" data-testid={`text-title-${rec.sku}`}>{rec.title}</TableCell>
                    <TableCell className="text-right" data-testid={`text-lead-time-${rec.sku}`}>{rec.lead_time || '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-current-stock-${rec.sku}`}>{rec.current_total_stock?.toLocaleString() || '-'}</TableCell>
                    <TableCell className="text-right font-semibold" data-testid={`text-recommended-qty-${rec.sku}`}>{rec.recommended_quantity.toLocaleString()}</TableCell>
                    <TableCell className="text-right" data-testid={`text-base-velocity-${rec.sku}`}>{rec.base_velocity ? parseFloat(rec.base_velocity).toFixed(2) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-projected-velocity-${rec.sku}`}>{rec.projected_velocity ? parseFloat(rec.projected_velocity).toFixed(2) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-growth-rate-${rec.sku}`}>{rec.growth_rate ? `${(parseFloat(rec.growth_rate) * 100).toFixed(1)}%` : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-forecast-${rec.sku}`}>{rec.ninety_day_forecast ? parseFloat(rec.ninety_day_forecast).toFixed(0) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-days-cover-${rec.sku}`}>{rec.current_days_cover ? parseFloat(rec.current_days_cover).toFixed(1) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-qty-incoming-${rec.sku}`}>{rec.quantity_incoming?.toLocaleString() || '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-kit-velocity-${rec.sku}`}>{rec.kit_driven_velocity ? parseFloat(rec.kit_driven_velocity).toFixed(2) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-individual-velocity-${rec.sku}`}>{rec.individual_velocity ? parseFloat(rec.individual_velocity).toFixed(2) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-case-adjustment-${rec.sku}`}>{rec.case_adjustment_applied?.toLocaleString() || '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-moq-applied-${rec.sku}`}>{rec.moq_applied?.toLocaleString() || '-'}</TableCell>
                    <TableCell data-testid={`text-assembled-${rec.sku}`}>{rec.is_assembled_product ? 'Yes' : 'No'}</TableCell>
                    <TableCell data-testid={`text-next-holiday-days-${rec.sku}`}>{rec.next_holiday_count_down_in_days || '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-holiday-rec-qty-${rec.sku}`}>{rec.next_holiday_recommended_quantity?.toLocaleString() || '-'}</TableCell>
                    <TableCell data-testid={`text-holiday-season-${rec.sku}`}>{rec.next_holiday_season || '-'}</TableCell>
                    <TableCell data-testid={`text-holiday-start-${rec.sku}`}>
                      {rec.next_holiday_start_date 
                        ? new Date(rec.next_holiday_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : '-'
                      }
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openStepsModal(rec.sku, rec.stock_check_date)}
                        data-testid={`button-steps-${rec.sku}`}
                      >
                        Steps
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {!isLoading && totalRecords > 0 && (
        <div className="flex items-center justify-between gap-4 p-4 border-t">
          <div className="flex items-center gap-4">
            <div className="text-sm text-muted-foreground" data-testid="text-record-count">
              Showing {startIndex + 1} - {endIndex} of {totalRecords} records
            </div>
            <Select 
              value={pageSize.toString()} 
              onValueChange={(value) => {
                setPageSize(parseInt(value));
                setPage(1);
              }}
            >
              <SelectTrigger className="w-32" data-testid="select-page-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25 per page</SelectItem>
                <SelectItem value="50">50 per page</SelectItem>
                <SelectItem value="100">100 per page</SelectItem>
                <SelectItem value="200">200 per page</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <div className="text-sm text-muted-foreground" data-testid="text-page-info">
              Page {page} of {totalPages}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              data-testid="button-next-page"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={!!selectedSku} onOpenChange={(open) => !open && setSelectedSku(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto" data-testid="dialog-steps">
          <DialogHeader>
            <DialogTitle data-testid="text-dialog-title">
              Calculation Steps: {selectedSku?.sku}
            </DialogTitle>
          </DialogHeader>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step Name</TableHead>
                <TableHead>Commentary</TableHead>
                <TableHead className="text-right">Raw</TableHead>
                <TableHead className="text-right">Final</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step, idx) => (
                <TableRow key={idx} data-testid={`row-step-${idx}`}>
                  <TableCell className="font-medium" data-testid={`text-step-name-${idx}`}>{step.step_name}</TableCell>
                  <TableCell className="max-w-md" data-testid={`text-commentary-${idx}`}>
                    <div className="whitespace-pre-wrap text-sm">
                      {step.calculation_commentary}
                    </div>
                  </TableCell>
                  <TableCell className="text-right" data-testid={`text-raw-${idx}`}>
                    {step.raw_calculation ? parseFloat(step.raw_calculation).toFixed(2) : '-'}
                  </TableCell>
                  <TableCell className="text-right" data-testid={`text-final-${idx}`}>
                    {step.final_value ? parseFloat(step.final_value).toFixed(2) : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
