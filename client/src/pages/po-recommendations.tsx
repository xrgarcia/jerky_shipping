import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { ArrowUpDown, Search } from "lucide-react";
import type { PORecommendation, PORecommendationStep } from "@shared/reporting-schema";

export default function PORecommendations() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(location.split('?')[1] || '');
  
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');
  const [selectedSku, setSelectedSku] = useState<{ sku: string; stockCheckDate: string } | null>(null);

  const supplier = searchParams.get('supplier') || undefined;
  const stockCheckDate = searchParams.get('stockCheckDate') || undefined;
  const search = searchParams.get('search') || undefined;
  const sortBy = searchParams.get('sortBy') || 'sku';
  const sortOrder = (searchParams.get('sortOrder') || 'asc') as 'asc' | 'desc';

  const { data: recommendations = [], isLoading } = useQuery<PORecommendation[]>({
    queryKey: ['/api/reporting/po-recommendations', { supplier, stockCheckDate, search, sortBy, sortOrder }],
  });

  const { data: steps = [] } = useQuery<PORecommendationStep[]>({
    queryKey: ['/api/reporting/po-recommendation-steps', selectedSku?.sku, selectedSku?.stockCheckDate],
    enabled: !!selectedSku,
  });

  const updateSearchParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(location.split('?')[1] || '');
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const newSearch = params.toString();
    setLocation(`/po-recommendations${newSearch ? `?${newSearch}` : ''}`);
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      updateSearchParam('sortOrder', sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      updateSearchParam('sortBy', column);
      updateSearchParam('sortOrder', 'asc');
    }
  };

  const handleSearch = () => {
    updateSearchParam('search', searchInput || null);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const openStepsModal = (sku: string, stockCheckDate: Date) => {
    setSelectedSku({ 
      sku, 
      stockCheckDate: new Date(stockCheckDate).toISOString().split('T')[0] 
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-4 p-4 border-b">
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">PO Recommendations</h1>
        
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search SKU, title, or supplier..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyPress={handleKeyPress}
            className="w-80"
            data-testid="input-search"
          />
          <Button 
            onClick={handleSearch} 
            size="icon"
            data-testid="button-search"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-64" data-testid="loading-spinner">
            <div className="text-muted-foreground">Loading recommendations...</div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort('sku')}
                    className="hover-elevate"
                    data-testid="button-sort-sku"
                  >
                    SKU <ArrowUpDown className="ml-2 h-4 w-4" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghost"
                    onClick={() => handleSort('supplier')}
                    className="hover-elevate"
                    data-testid="button-sort-supplier"
                  >
                    Supplier <ArrowUpDown className="ml-2 h-4 w-4" />
                  </Button>
                </TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Current Stock</TableHead>
                <TableHead className="text-right">Recommended Qty</TableHead>
                <TableHead className="text-right">Base Velocity</TableHead>
                <TableHead className="text-right">90-Day Forecast</TableHead>
                <TableHead className="text-right">Days Cover</TableHead>
                <TableHead className="text-right">Qty Incoming</TableHead>
                <TableHead>Next Holiday</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recommendations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground" data-testid="text-no-results">
                    No recommendations found
                  </TableCell>
                </TableRow>
              ) : (
                recommendations.map((rec) => (
                  <TableRow key={`${rec.sku}-${rec.stock_check_date}`} data-testid={`row-recommendation-${rec.sku}`}>
                    <TableCell className="font-medium" data-testid={`text-sku-${rec.sku}`}>{rec.sku}</TableCell>
                    <TableCell data-testid={`text-supplier-${rec.sku}`}>{rec.supplier}</TableCell>
                    <TableCell className="max-w-xs truncate" data-testid={`text-title-${rec.sku}`}>{rec.title}</TableCell>
                    <TableCell className="text-right" data-testid={`text-current-stock-${rec.sku}`}>{rec.current_total_stock?.toLocaleString() || '-'}</TableCell>
                    <TableCell className="text-right font-semibold" data-testid={`text-recommended-qty-${rec.sku}`}>{rec.recommended_quantity.toLocaleString()}</TableCell>
                    <TableCell className="text-right" data-testid={`text-base-velocity-${rec.sku}`}>{rec.base_velocity ? parseFloat(rec.base_velocity).toFixed(2) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-forecast-${rec.sku}`}>{rec.ninety_day_forecast ? parseFloat(rec.ninety_day_forecast).toFixed(0) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-days-cover-${rec.sku}`}>{rec.current_days_cover ? parseFloat(rec.current_days_cover).toFixed(1) : '-'}</TableCell>
                    <TableCell className="text-right" data-testid={`text-qty-incoming-${rec.sku}`}>{rec.quantity_incoming?.toLocaleString() || '-'}</TableCell>
                    <TableCell data-testid={`text-next-holiday-${rec.sku}`}>
                      {rec.next_holiday_season && (
                        <div className="text-sm">
                          <div>{rec.next_holiday_season}</div>
                          {rec.next_holiday_count_down_in_days !== null && (
                            <div className="text-muted-foreground">{rec.next_holiday_count_down_in_days}d</div>
                          )}
                        </div>
                      )}
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
