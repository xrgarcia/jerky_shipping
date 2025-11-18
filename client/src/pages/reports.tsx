import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, TrendingUp, DollarSign, Package, BarChart3 } from "lucide-react";
import { format } from "date-fns";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ReportSummary {
  totalOrders: number;
  totalRevenue: string;
  totalShipping: string;
  totalSubtotal: string;
  totalTax: string;
  totalDiscounts: string;
  averageOrderValue: string;
  averageShipping: string;
  dailyData: Array<{ date: string; total: number }>;
  statusCounts: { [key: string]: number };
  fulfillmentCounts: { [key: string]: number };
}

export default function Reports() {
  const [startDate, setStartDate] = useState<Date>(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date;
  });
  const [endDate, setEndDate] = useState<Date>(new Date());

  const formatDateForAPI = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const { data: summary, isLoading } = useQuery<ReportSummary>({
    queryKey: ['/api/reports/summary', formatDateForAPI(startDate), formatDateForAPI(endDate)],
    queryFn: async ({ queryKey }) => {
      const [endpoint, startDateStr, endDateStr] = queryKey as [string, string, string];
      const url = `${endpoint}?startDate=${startDateStr}&endDate=${endDateStr}`;
      const res = await fetch(url, { credentials: "include" });
      
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      
      return await res.json();
    },
  });

  const formatCurrency = (value: string) => {
    return `$${parseFloat(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatChartData = () => {
    if (!summary?.dailyData) return [];
    return summary.dailyData.map(item => ({
      date: format(new Date(item.date), 'MMM dd'),
      total: item.total,
    }));
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-foreground" data-testid="text-page-title">
              Shipping Reports
            </h1>
            <p className="text-lg text-muted-foreground mt-1">
              Order and shipping analytics for the selected date range
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Date Range</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4 items-center">
              <div className="space-y-2">
                <label className="text-sm font-medium">Start Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-[240px] justify-start text-left"
                      data-testid="button-start-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {format(startDate, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={(date) => date && setStartDate(date)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">End Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-[240px] justify-start text-left"
                      data-testid="button-end-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {format(endDate, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={endDate}
                      onSelect={(date) => date && setEndDate(date)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-lg text-muted-foreground">Loading reports...</div>
          </div>
        ) : summary ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-2xl flex items-center gap-2">
                  <BarChart3 className="h-6 w-6" />
                  Order Total by Day
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[400px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={formatChartData()}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="date"
                        style={{ fontSize: '14px' }}
                      />
                      <YAxis
                        style={{ fontSize: '14px' }}
                        tickFormatter={(value) => `$${value.toLocaleString()}`}
                      />
                      <Tooltip
                        formatter={(value: number) => [`$${value.toFixed(2)}`, 'Total']}
                        contentStyle={{ fontSize: '14px' }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="total"
                        stroke="#6B8E23"
                        strokeWidth={3}
                        name="Daily Revenue"
                        dot={{ r: 4 }}
                        activeDot={{ r: 6 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card data-testid="card-total-orders">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-lg font-semibold">Total Orders</CardTitle>
                  <Package className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" data-testid="text-total-orders">
                    {summary.totalOrders}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {format(startDate, 'MMM dd')} - {format(endDate, 'MMM dd')}
                  </p>
                </CardContent>
              </Card>

              <Card data-testid="card-shipping-revenue">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-lg font-semibold">Shipping Revenue</CardTitle>
                  <TrendingUp className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" data-testid="text-shipping-revenue">
                    {formatCurrency(summary.totalShipping)}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Avg: {formatCurrency(summary.averageShipping)} per order
                  </p>
                </CardContent>
              </Card>

              <Card data-testid="card-total-revenue">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-lg font-semibold">Total Revenue</CardTitle>
                  <DollarSign className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" data-testid="text-total-revenue">
                    {formatCurrency(summary.totalRevenue)}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Avg: {formatCurrency(summary.averageOrderValue)} per order
                  </p>
                </CardContent>
              </Card>

              <Card data-testid="card-product-value">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-lg font-semibold">Product Value</CardTitle>
                  <Package className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" data-testid="text-product-value">
                    {formatCurrency(summary.totalSubtotal)}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Before shipping & tax
                  </p>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">Revenue Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-base">Product Sales</span>
                    <span className="text-lg font-semibold">{formatCurrency(summary.totalSubtotal)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-base">Shipping</span>
                    <span className="text-lg font-semibold">{formatCurrency(summary.totalShipping)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-base">Tax</span>
                    <span className="text-lg font-semibold">{formatCurrency(summary.totalTax)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-base">Discounts</span>
                    <span className="text-lg font-semibold text-red-600">-{formatCurrency(summary.totalDiscounts)}</span>
                  </div>
                  <div className="flex justify-between items-center pt-3 border-t">
                    <span className="text-lg font-bold">Total Revenue</span>
                    <span className="text-xl font-bold">{formatCurrency(summary.totalRevenue)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-xl">Order Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <h4 className="font-semibold mb-2">Financial Status</h4>
                    {Object.entries(summary.statusCounts).map(([status, count]) => (
                      <div key={status} className="flex justify-between items-center py-1">
                        <span className="text-base capitalize">{status}</span>
                        <span className="text-lg font-semibold">{count}</span>
                      </div>
                    ))}
                  </div>
                  <div className="pt-3 border-t">
                    <h4 className="font-semibold mb-2">Fulfillment Status</h4>
                    {Object.entries(summary.fulfillmentCounts).map(([status, count]) => (
                      <div key={status} className="flex justify-between items-center py-1">
                        <span className="text-base capitalize">{status === 'null' ? 'Unfulfilled' : status}</span>
                        <span className="text-lg font-semibold">{count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center py-12">
            <div className="text-lg text-muted-foreground">No data available for the selected date range</div>
          </div>
        )}
      </div>
    </div>
  );
}
