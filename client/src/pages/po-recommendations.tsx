import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
import { Card } from "@/components/ui/card";
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, Calendar, ChevronLeft, ChevronRight, ChevronDown, RefreshCw } from "lucide-react";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { parseISO, format } from "date-fns";

const CST_TIMEZONE = 'America/Chicago';
import { ViewManager, type ColumnDefinition } from "@/components/view-manager";
import type { PORecommendation, PORecommendationStep } from "@shared/reporting-schema";
import type { SavedView, SavedViewConfig } from "@shared/schema";

// Column definitions for the PO Recommendations table
const ALL_COLUMNS: ColumnDefinition[] = [
  { key: 'sku', label: 'SKU', align: 'left', defaultVisible: true },
  { key: 'supplier', label: 'Supplier', align: 'left', defaultVisible: true },
  { key: 'title', label: 'Title', align: 'left', defaultVisible: true },
  { key: 'lead_time', label: 'Lead Time', align: 'right', defaultVisible: true },
  { key: 'current_total_stock', label: 'Current Stock', align: 'right', defaultVisible: true },
  { key: 'recommended_quantity', label: 'Recommended Qty', align: 'right', defaultVisible: true },
  { key: 'base_velocity', label: 'Base Velocity', align: 'right', defaultVisible: true },
  { key: 'projected_velocity', label: 'Projected Velocity', align: 'right', defaultVisible: true },
  { key: 'growth_rate', label: 'Growth Rate', align: 'right', defaultVisible: true },
  { key: 'ninety_day_forecast', label: '90-Day Forecast', align: 'right', defaultVisible: true },
  { key: 'current_days_cover', label: 'Days Cover', align: 'right', defaultVisible: true },
  { key: 'quantity_incoming', label: 'Qty Incoming', align: 'right', defaultVisible: true },
  { key: 'kit_driven_velocity', label: 'Kit Velocity', align: 'right', defaultVisible: false },
  { key: 'individual_velocity', label: 'Individual Velocity', align: 'right', defaultVisible: false },
  { key: 'case_adjustment_applied', label: 'Case Adjustment', align: 'right', defaultVisible: false },
  { key: 'moq_applied', label: 'MOQ Applied', align: 'right', defaultVisible: false },
  { key: 'is_assembled_product', label: 'Assembled', align: 'left', defaultVisible: false },
  { key: 'next_holiday_count_down_in_days', label: 'Next Holiday Days', align: 'left', defaultVisible: false },
  { key: 'next_holiday_recommended_quantity', label: 'Holiday Rec Qty', align: 'right', defaultVisible: false },
  { key: 'next_holiday_season', label: 'Holiday Season', align: 'left', defaultVisible: false },
  { key: 'next_holiday_start_date', label: 'Holiday Start', align: 'left', defaultVisible: false },
];

const DEFAULT_VISIBLE_COLUMNS = ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key);

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

  // View and column states
  const [currentViewId, setCurrentViewId] = useState<string | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE_COLUMNS);
  
  // Date picker state
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Fetch a specific saved view if referenced in URL
  const viewIdFromUrl = useMemo(() => {
    const params = new URLSearchParams(searchParams.startsWith('?') ? searchParams.slice(1) : searchParams);
    return params.get('view');
  }, [searchParams]);

  const { data: loadedView } = useQuery<SavedView>({
    queryKey: ['/api/saved-views', viewIdFromUrl],
    enabled: !!viewIdFromUrl,
  });

  // Apply loaded view config when view changes
  useEffect(() => {
    if (loadedView && loadedView.config) {
      const config = loadedView.config as SavedViewConfig;
      if (config.columns && config.columns.length > 0) {
        setVisibleColumns(config.columns);
      }
      if (config.filters) {
        if (config.filters.suppliers) setSelectedSuppliers(config.filters.suppliers);
        if (config.filters.search) setSearch(config.filters.search);
        if (config.filters.isAssembledProduct) setIsAssembledProduct(config.filters.isAssembledProduct);
      }
      if (config.sort) {
        setSortBy(config.sort.column);
        setSortOrder(config.sort.order);
      }
      setCurrentViewId(loadedView.id);
    }
  }, [loadedView]);

  // Initialize state from URL params (excluding view param which is handled separately)
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    // Skip if loading a view (view params take precedence)
    if (params.has('view')) {
      lastSyncedSearchRef.current = currentSearch;
      setIsInitialized(true);
      return;
    }
    
    // Parse suppliers - can be comma-separated list or multiple params
    const suppliersParam = params.get('suppliers') || '';
    setSelectedSuppliers(suppliersParam ? suppliersParam.split(',').filter(s => s) : []);
    setSearch(params.get('search') || '');
    setIsAssembledProduct(params.get('isAssembledProduct') || 'false');
    setSortBy(params.get('sortBy') || 'ninety_day_forecast');
    setSortOrder((params.get('sortOrder') as 'asc' | 'desc') || 'asc');
    setPage(parseInt(params.get('page') || '1'));
    setPageSize(parseInt(params.get('pageSize') || '100'));
    
    // Parse columns from URL
    const columnsParam = params.get('columns');
    if (columnsParam) {
      const columns = columnsParam.split(',').filter(c => ALL_COLUMNS.some(col => col.key === c));
      if (columns.length > 0) {
        setVisibleColumns(columns);
      }
    }
    
    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]);

  // Update URL when state changes
  useEffect(() => {
    if (!isInitialized) return;
    
    const params = new URLSearchParams();
    
    // If we have a view selected, preserve it in URL
    if (currentViewId) {
      params.set('view', currentViewId);
    }
    
    if (selectedSuppliers.length > 0) params.set('suppliers', selectedSuppliers.join(','));
    if (search) params.set('search', search);
    if (isAssembledProduct !== 'false') params.set('isAssembledProduct', isAssembledProduct);
    if (sortBy !== 'ninety_day_forecast') params.set('sortBy', sortBy);
    if (sortOrder !== 'asc') params.set('sortOrder', sortOrder);
    if (page !== 1) params.set('page', page.toString());
    if (pageSize !== 100) params.set('pageSize', pageSize.toString());
    
    // Only include columns in URL if different from default
    const columnsChanged = visibleColumns.length !== DEFAULT_VISIBLE_COLUMNS.length ||
      visibleColumns.some((c, i) => c !== DEFAULT_VISIBLE_COLUMNS[i]);
    if (columnsChanged) {
      params.set('columns', visibleColumns.join(','));
    }
    
    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/po-recommendations${newUrl}`);
    }
  }, [selectedSuppliers, search, isAssembledProduct, sortBy, sortOrder, page, pageSize, isInitialized, currentViewId, visibleColumns]);

  // Get current config for saving views
  const getCurrentConfig = useCallback((): SavedViewConfig => {
    return {
      columns: visibleColumns,
      filters: {
        suppliers: selectedSuppliers,
        search,
        isAssembledProduct,
      },
      sort: {
        column: sortBy,
        order: sortOrder,
      },
    };
  }, [visibleColumns, selectedSuppliers, search, isAssembledProduct, sortBy, sortOrder]);

  // Handle view change
  const handleViewChange = useCallback((viewId: string | null) => {
    setCurrentViewId(viewId);
    if (!viewId) {
      // Reset to defaults when clearing view
      setVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
    }
  }, []);

  // Fetch available dates for the date picker
  const { data: availableDatesData } = useQuery<{ dates: string[] }>({
    queryKey: ['/api/reporting/po-recommendations/available-dates'],
    staleTime: STALE_TIME,
    gcTime: STALE_TIME,
  });
  
  const availableDates = availableDatesData?.dates ?? [];
  
  // Set default selected date to the latest available date
  useEffect(() => {
    if (availableDates.length > 0 && selectedDate === null) {
      setSelectedDate(availableDates[0]); // First date is the latest (desc order)
    }
  }, [availableDates, selectedDate]);

  // Fetch recommendations - cached for 24 hours, refetches when date changes
  const { data: rawRecommendations = [], isLoading } = useQuery<PORecommendation[]>({
    queryKey: ['/api/reporting/po-recommendations', selectedDate],
    queryFn: async () => {
      const url = selectedDate 
        ? `/api/reporting/po-recommendations?date=${selectedDate}`
        : '/api/reporting/po-recommendations';
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch recommendations');
      return response.json();
    },
    staleTime: STALE_TIME,
    gcTime: STALE_TIME,
    enabled: selectedDate !== null || availableDates.length === 0, // Fetch once date is selected, or if no dates available
  });

  // Cache refresh mutation
  const refreshCacheMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/reporting/invalidate-cache');
      return response.json();
    },
    onSuccess: () => {
      // Invalidate all PO recommendation queries to force refetch
      queryClient.invalidateQueries({ queryKey: ['/api/reporting/po-recommendations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/reporting/po-recommendations/available-dates'] });
    },
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

    // Columns that should be sorted numerically (even if stored as strings)
    const numericColumns = new Set([
      'lead_time',
      'current_total_stock',
      'base_velocity',
      'projected_velocity',
      'growth_rate',
      'kit_driven_velocity',
      'individual_velocity',
      'ninety_day_forecast',
      'case_adjustment_applied',
      'current_days_cover',
      'moq_applied',
      'quantity_incoming',
      'recommended_quantity',
      'next_holiday_count_down_in_days',
      'next_holiday_recommended_quantity',
    ]);

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
      
      // Check if this column should be sorted numerically
      if (numericColumns.has(sortBy)) {
        const aNum = typeof aVal === 'number' ? aVal : parseFloat(String(aVal));
        const bNum = typeof bVal === 'number' ? bVal : parseFloat(String(bVal));
        
        // Handle NaN (non-numeric strings) - put them at the end
        if (isNaN(aNum) && isNaN(bNum)) comparison = 0;
        else if (isNaN(aNum)) comparison = 1;
        else if (isNaN(bNum)) comparison = -1;
        else comparison = aNum - bNum;
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

  // Format the selected date for display
  const formattedSelectedDate = selectedDate 
    ? formatInTimeZone(parseISO(selectedDate), CST_TIMEZONE, 'MMMM d, yyyy')
    : null;
  
  // Convert available dates to Date objects for the calendar
  const availableDateSet = useMemo(() => new Set(availableDates), [availableDates]);
  
  // Disable dates that aren't in the available dates list
  const disabledDates = useCallback((date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return !availableDateSet.has(dateStr);
  }, [availableDateSet]);
  
  // Handle date selection from calendar
  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      const dateStr = format(date, 'yyyy-MM-dd');
      if (availableDateSet.has(dateStr)) {
        setSelectedDate(dateStr);
        setDatePickerOpen(false);
      }
    }
  };

  // Helper function to render cell values based on column type
  const renderCellValue = (rec: PORecommendation, columnKey: string): React.ReactNode => {
    switch (columnKey) {
      case 'sku':
        return rec.sku;
      case 'supplier':
        return rec.supplier;
      case 'title':
        return rec.title;
      case 'lead_time':
        return rec.lead_time || '-';
      case 'current_total_stock':
        return rec.current_total_stock?.toLocaleString() || '-';
      case 'recommended_quantity':
        return rec.recommended_quantity.toLocaleString();
      case 'base_velocity':
        return rec.base_velocity ? parseFloat(rec.base_velocity).toFixed(2) : '-';
      case 'projected_velocity':
        return rec.projected_velocity ? parseFloat(rec.projected_velocity).toFixed(2) : '-';
      case 'growth_rate':
        return rec.growth_rate ? `${(parseFloat(rec.growth_rate) * 100).toFixed(1)}%` : '-';
      case 'ninety_day_forecast':
        return rec.ninety_day_forecast ? parseFloat(rec.ninety_day_forecast).toFixed(0) : '-';
      case 'current_days_cover':
        return rec.current_days_cover ? parseFloat(rec.current_days_cover).toFixed(1) : '-';
      case 'quantity_incoming':
        return rec.quantity_incoming?.toLocaleString() || '-';
      case 'kit_driven_velocity':
        return rec.kit_driven_velocity ? parseFloat(rec.kit_driven_velocity).toFixed(2) : '-';
      case 'individual_velocity':
        return rec.individual_velocity ? parseFloat(rec.individual_velocity).toFixed(2) : '-';
      case 'case_adjustment_applied':
        return rec.case_adjustment_applied?.toLocaleString() || '-';
      case 'moq_applied':
        return rec.moq_applied?.toLocaleString() || '-';
      case 'is_assembled_product':
        return rec.is_assembled_product ? 'Yes' : 'No';
      case 'next_holiday_count_down_in_days':
        return rec.next_holiday_count_down_in_days || '-';
      case 'next_holiday_recommended_quantity':
        return rec.next_holiday_recommended_quantity?.toLocaleString() || '-';
      case 'next_holiday_season':
        return rec.next_holiday_season || '-';
      case 'next_holiday_start_date':
        return rec.next_holiday_start_date 
          ? new Date(rec.next_holiday_start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '-';
      default:
        return '-';
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col gap-4 p-4 border-b">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">PO Recommendations</h1>
          <div className="flex items-center gap-4">
            <ViewManager
              page="po-recommendations"
              columns={ALL_COLUMNS}
              visibleColumns={visibleColumns}
              onColumnsChange={setVisibleColumns}
              currentViewId={currentViewId}
              onViewChange={handleViewChange}
              getCurrentConfig={getCurrentConfig}
            />
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button 
                  variant="outline" 
                  className="flex items-center gap-2"
                  data-testid="button-date-picker"
                >
                  <Calendar className="h-4 w-4" />
                  <span>
                    Data as of: <span className="font-medium">{formattedSelectedDate || 'Select date'}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <CalendarComponent
                  mode="single"
                  selected={selectedDate ? parseISO(selectedDate) : undefined}
                  onSelect={handleDateSelect}
                  disabled={disabledDates}
                  initialFocus
                />
                {availableDates.length > 0 && (
                  <div className="p-2 border-t">
                    <p className="text-xs text-muted-foreground text-center">
                      {availableDates.length} date{availableDates.length !== 1 ? 's' : ''} available
                    </p>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="icon"
              onClick={() => refreshCacheMutation.mutate()}
              disabled={refreshCacheMutation.isPending}
              title="Refresh data from database"
              data-testid="button-refresh-cache"
            >
              <RefreshCw className={`h-4 w-4 ${refreshCacheMutation.isPending ? 'animate-spin' : ''}`} />
            </Button>
          </div>
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

      <div className="flex-1 min-h-0 p-4">
        <Card className="h-full overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-64" data-testid="loading-spinner">
              <div className="text-muted-foreground">Loading recommendations...</div>
            </div>
          ) : (
            <Table containerClassName="h-full overflow-scroll" className={`min-w-[${Math.max(800, visibleColumns.length * 120)}px]`}>
            <TableHeader>
              <TableRow>
                {visibleColumns.map((columnKey) => {
                  const columnDef = ALL_COLUMNS.find(c => c.key === columnKey);
                  if (!columnDef) return null;
                  return (
                    <TableHead 
                      key={columnKey}
                      className={`sticky top-0 bg-background z-20 ${columnDef.align === 'right' ? 'text-right' : ''}`}
                    >
                      <SortableHeader column={columnKey}>{columnDef.label}</SortableHeader>
                    </TableHead>
                  );
                })}
                <TableHead className="sticky top-0 bg-background z-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {totalRecords === 0 ? (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + 1} className="text-center text-muted-foreground" data-testid="text-no-results">
                    No recommendations found
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRecommendations.map((rec) => (
                  <TableRow key={`${rec.sku}-${rec.stock_check_date}`} data-testid={`row-recommendation-${rec.sku}`}>
                    {visibleColumns.map((columnKey) => {
                      const columnDef = ALL_COLUMNS.find(c => c.key === columnKey);
                      if (!columnDef) return null;
                      return (
                        <TableCell 
                          key={columnKey}
                          className={`${columnDef.align === 'right' ? 'text-right' : ''} ${columnKey === 'sku' ? 'font-medium' : ''} ${columnKey === 'title' ? 'max-w-xs truncate' : ''} ${columnKey === 'recommended_quantity' ? 'font-semibold' : ''}`}
                          data-testid={`text-${columnKey}-${rec.sku}`}
                        >
                          {renderCellValue(rec, columnKey)}
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => selectedDate && openStepsModal(rec.sku, new Date(selectedDate))}
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
        </Card>
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
