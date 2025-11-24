import { useState, useEffect, useRef } from "react";
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
import { ArrowUpDown, ArrowUp, ArrowDown, Search, X, Calendar } from "lucide-react";
import type { PORecommendation, PORecommendationStep } from "@shared/reporting-schema";

export default function PORecommendations() {
  const [, setLocation] = useLocation();
  const searchParams = useSearch();
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSyncedSearchRef = useRef<string>('');
  
  const [selectedSku, setSelectedSku] = useState<{ sku: string; stockCheckDate: string } | null>(null);

  // Filter states
  const [supplier, setSupplier] = useState<string>('');
  const [stockCheckDate, setStockCheckDate] = useState<string>('');
  const [search, setSearch] = useState<string>('');
  const [sortBy, setSortBy] = useState<string>('recommended_qty');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Initialize state from URL params
  useEffect(() => {
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (lastSyncedSearchRef.current === currentSearch && isInitialized) {
      return;
    }
    
    const params = new URLSearchParams(currentSearch);
    
    setSupplier(params.get('supplier') || '');
    setStockCheckDate(params.get('stockCheckDate') || '');
    setSearch(params.get('search') || '');
    setSortBy(params.get('sortBy') || 'recommended_qty');
    setSortOrder((params.get('sortOrder') as 'asc' | 'desc') || 'desc');
    
    lastSyncedSearchRef.current = currentSearch;
    setIsInitialized(true);
  }, [searchParams]);

  // Update URL when state changes
  useEffect(() => {
    if (!isInitialized) return;
    
    const params = new URLSearchParams();
    
    if (supplier) params.set('supplier', supplier);
    if (stockCheckDate) params.set('stockCheckDate', stockCheckDate);
    if (search) params.set('search', search);
    if (sortBy !== 'recommended_qty') params.set('sortBy', sortBy);
    if (sortOrder !== 'desc') params.set('sortOrder', sortOrder);
    
    const newSearch = params.toString();
    const currentSearch = searchParams.startsWith('?') ? searchParams.slice(1) : searchParams;
    
    if (currentSearch !== newSearch) {
      lastSyncedSearchRef.current = newSearch;
      const newUrl = newSearch ? `?${newSearch}` : '';
      window.history.replaceState({}, '', `/po-recommendations${newUrl}`);
    }
  }, [supplier, stockCheckDate, search, sortBy, sortOrder, isInitialized]);

  const { data: recommendations = [], isLoading } = useQuery<PORecommendation[]>({
    queryKey: ['/api/reporting/po-recommendations', supplier, stockCheckDate, search, sortBy, sortOrder],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (supplier) params.set('supplier', supplier);
      if (stockCheckDate) params.set('stockCheckDate', stockCheckDate);
      if (search) params.set('search', search);
      if (sortBy) params.set('sortBy', sortBy);
      if (sortOrder) params.set('sortOrder', sortOrder);
      const qs = params.toString();
      const url = `/api/reporting/po-recommendations${qs ? `?${qs}` : ''}`;
      
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch recommendations');
      return response.json();
    },
  });

  const { data: suppliers = [] } = useQuery<string[]>({
    queryKey: ['/api/reporting/unique-suppliers'],
  });

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

  const openStepsModal = (sku: string, stockCheckDate: Date) => {
    setSelectedSku({ 
      sku, 
      stockCheckDate: new Date(stockCheckDate).toISOString().split('T')[0] 
    });
  };

  const clearFilters = () => {
    setSupplier('');
    setStockCheckDate('');
    setSearch('');
    setSortBy('recommended_qty');
    setSortOrder('desc');
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
          <Select 
            value={supplier || 'all'} 
            onValueChange={(value) => setSupplier(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-48" data-testid="select-supplier">
              <SelectValue placeholder="All Suppliers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Suppliers</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            placeholder="Search SKU, title, or supplier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-80"
            data-testid="input-search"
          />
          <Button 
            size="icon"
            data-testid="button-search"
            className="opacity-0 pointer-events-none"
          >
            <Search className="h-4 w-4" />
          </Button>

          {(supplier || search) && (
            <Button
              variant="outline"
              onClick={clearFilters}
              data-testid="button-clear-filters"
            >
              <X className="h-4 w-4 mr-2" />
              Clear Filters
            </Button>
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
              {recommendations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={22} className="text-center text-muted-foreground" data-testid="text-no-results">
                    No recommendations found
                  </TableCell>
                </TableRow>
              ) : (
                recommendations.map((rec) => (
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
