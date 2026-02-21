import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Truck, CheckCircle, XCircle, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface CustomerShippingMethod {
  id: number;
  name: string;
  allowAssignment: boolean;
  allowChange: boolean;
  minAllowedWeight: string | null;
  maxAllowedWeight: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface RateCheckShippingMethod {
  id: number;
  name: string;
  allowRateCheck: boolean;
  minAllowedWeight: string | null;
  maxAllowedWeight: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

function formatDate(dateValue: string | Date | null | undefined): string {
  if (!dateValue) return "N/A";
  try {
    const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return String(dateValue);
  }
}

function CustomerMethodsTab() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: methods, isLoading } = useQuery<CustomerShippingMethod[]>({
    queryKey: ["/api/settings/customer-shipping-methods"],
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; allowAssignment?: boolean; allowChange?: boolean; minAllowedWeight?: number | null; maxAllowedWeight?: number | null }) => {
      const { id, ...body } = data;
      return apiRequest("PUT", `/api/settings/customer-shipping-methods/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/customer-shipping-methods"] });
      toast({ title: "Updated", description: "Customer shipping method settings saved." });
      setUpdatingId(null);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to update", variant: "destructive" });
      setUpdatingId(null);
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/settings/customer-shipping-methods/sync"),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/customer-shipping-methods"] });
      toast({
        title: "Sync Complete",
        description: data.newMethods > 0 ? `Added ${data.newMethods} new customer shipping method(s).` : "No new customer shipping methods found.",
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to sync", variant: "destructive" });
    },
  });

  const handleToggle = (method: CustomerShippingMethod, field: 'allowAssignment' | 'allowChange', value: boolean) => {
    setUpdatingId(method.id);
    updateMutation.mutate({ id: method.id, [field]: value });
  };

  const handleWeightChange = (method: CustomerShippingMethod, field: 'minAllowedWeight' | 'maxAllowedWeight', value: string) => {
    const numValue = value.trim() === '' ? null : parseFloat(value);
    if (value.trim() !== '' && (isNaN(numValue as number) || (numValue as number) < 0)) return;
    setUpdatingId(method.id);
    updateMutation.mutate({ id: method.id, [field]: numValue });
  };

  if (isLoading) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          These are the shipping methods customers selected on their orders. Control assignment permissions and weight limits.
        </p>
        <Button
          variant="outline"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="button-sync-customer-methods"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
          Sync New Methods
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {!methods || methods.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-empty-customer-methods">
              No customer shipping methods found. Click "Sync New Methods" to populate from existing shipments.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method Name</TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Allow Change
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          When disabled, this method acts as a pass-through — the customer's shipping choice is always kept. When enabled, the rate checker can override it with a better option.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Allow Assignment
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          When enabled, this shipping method can be assigned to shipments during fulfillment.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Min Weight (oz)
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          Minimum package weight in ounces. Leave empty for no minimum limit.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Max Weight (oz)
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          Maximum package weight in ounces. Leave empty for no maximum limit.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead>Updated By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {methods.map((method) => (
                  <TableRow key={method.id} data-testid={`row-customer-method-${method.id}`}>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {method.name}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch
                          checked={method.allowChange}
                          onCheckedChange={(checked) => handleToggle(method, 'allowChange', checked)}
                          disabled={updatingId === method.id}
                          data-testid={`switch-allow-change-${method.id}`}
                        />
                        {method.allowChange ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch
                          checked={method.allowAssignment}
                          onCheckedChange={(checked) => handleToggle(method, 'allowAssignment', checked)}
                          disabled={updatingId === method.id}
                          data-testid={`switch-assignment-${method.id}`}
                        />
                        {method.allowAssignment ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="No limit"
                        className="w-24 text-center"
                        defaultValue={method.minAllowedWeight || ''}
                        onBlur={(e) => handleWeightChange(method, 'minAllowedWeight', e.target.value)}
                        disabled={updatingId === method.id}
                        data-testid={`input-min-weight-${method.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="No limit"
                        className="w-24 text-center"
                        defaultValue={method.maxAllowedWeight || ''}
                        onBlur={(e) => handleWeightChange(method, 'maxAllowedWeight', e.target.value)}
                        disabled={updatingId === method.id}
                        data-testid={`input-max-weight-${method.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(method.updatedAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {method.updatedBy || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RateCheckMethodsTab() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: methods, isLoading } = useQuery<RateCheckShippingMethod[]>({
    queryKey: ["/api/settings/rate-check-shipping-methods"],
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; allowRateCheck?: boolean; minAllowedWeight?: number | null; maxAllowedWeight?: number | null }) => {
      const { id, ...body } = data;
      return apiRequest("PUT", `/api/settings/rate-check-shipping-methods/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/rate-check-shipping-methods"] });
      toast({ title: "Updated", description: "Rate check shipping method settings saved." });
      setUpdatingId(null);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to update", variant: "destructive" });
      setUpdatingId(null);
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/settings/rate-check-shipping-methods/sync"),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/rate-check-shipping-methods"] });
      toast({
        title: "Sync Complete",
        description: data.newMethods > 0 ? `Added ${data.newMethods} new rate check shipping method(s).` : "No new rate check shipping methods found.",
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to sync", variant: "destructive" });
    },
  });

  const handleToggle = (method: RateCheckShippingMethod, value: boolean) => {
    setUpdatingId(method.id);
    updateMutation.mutate({ id: method.id, allowRateCheck: value });
  };

  const handleWeightChange = (method: RateCheckShippingMethod, field: 'minAllowedWeight' | 'maxAllowedWeight', value: string) => {
    const numValue = value.trim() === '' ? null : parseFloat(value);
    if (value.trim() !== '' && (isNaN(numValue as number) || (numValue as number) < 0)) return;
    setUpdatingId(method.id);
    updateMutation.mutate({ id: method.id, [field]: numValue });
  };

  if (isLoading) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          These are the candidate shipping methods the rate checker can recommend. Toggle which ones are allowed.
        </p>
        <Button
          variant="outline"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="button-sync-rate-methods"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
          Sync New Methods
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {!methods || methods.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-empty-rate-methods">
              No rate check shipping methods found. Click "Sync New Methods" to populate from rate analysis data.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Method Name</TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Allow Rate Check
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          When enabled, this shipping method can be selected as a candidate by the rate checker. Disable to exclude it from rate comparisons.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Min Weight (oz)
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          Minimum package weight in ounces for this method. Packages lighter than this won't use this method. Leave empty for no minimum.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Max Weight (oz)
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          Maximum package weight in ounces for this method. Packages heavier than this won't use this method. Leave empty for no maximum.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead>Updated By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {methods.map((method) => (
                  <TableRow key={method.id} data-testid={`row-rate-method-${method.id}`}>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {method.name}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch
                          checked={method.allowRateCheck}
                          onCheckedChange={(checked) => handleToggle(method, checked)}
                          disabled={updatingId === method.id}
                          data-testid={`switch-rate-check-${method.id}`}
                        />
                        {method.allowRateCheck ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Input
                        key={`min-${method.id}-${method.minAllowedWeight}-${method.updatedAt}`}
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="No limit"
                        className="w-24 text-center"
                        defaultValue={method.minAllowedWeight || ''}
                        onBlur={(e) => handleWeightChange(method, 'minAllowedWeight', e.target.value)}
                        disabled={updatingId === method.id || !method.allowRateCheck}
                        data-testid={`input-rate-min-weight-${method.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Input
                        key={`max-${method.id}-${method.maxAllowedWeight}-${method.updatedAt}`}
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="No limit"
                        className="w-24 text-center"
                        defaultValue={method.maxAllowedWeight || ''}
                        onBlur={(e) => handleWeightChange(method, 'maxAllowedWeight', e.target.value)}
                        disabled={updatingId === method.id || !method.allowRateCheck}
                        data-testid={`input-rate-max-weight-${method.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(method.updatedAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {method.updatedBy || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ShippingMethods() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Truck className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Shipping Methods</h1>
          <p className="text-muted-foreground">Manage customer shipping methods and rate checker candidates</p>
        </div>
      </div>

      <Tabs defaultValue="customer" className="w-full">
        <TabsList>
          <TabsTrigger value="customer" data-testid="tab-customer-methods">Customer Methods</TabsTrigger>
          <TabsTrigger value="rate-check" data-testid="tab-rate-check-methods">Rate Check Methods</TabsTrigger>
        </TabsList>
        <TabsContent value="customer" className="mt-6">
          <CustomerMethodsTab />
        </TabsContent>
        <TabsContent value="rate-check" className="mt-6">
          <RateCheckMethodsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
