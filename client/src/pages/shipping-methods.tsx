import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
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
  allowRateCheck: boolean;
  allowAssignment: boolean;
  allowChange: boolean;
  minAllowedWeight: string | null;
  maxAllowedWeight: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

function formatMethodName(name: string): string {
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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

export default function CustomerShippingMethods() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: methods, isLoading } = useQuery<CustomerShippingMethod[]>({
    queryKey: ["/api/settings/customer-shipping-methods"],
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; allowRateCheck?: boolean; allowAssignment?: boolean; allowChange?: boolean; minAllowedWeight?: number | null; maxAllowedWeight?: number | null }) => {
      const { id, ...body } = data;
      return apiRequest("PUT", `/api/settings/customer-shipping-methods/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/customer-shipping-methods"] });
      toast({
        title: "Updated",
        description: "Customer shipping method settings saved.",
      });
      setUpdatingId(null);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update customer shipping method",
        variant: "destructive",
      });
      setUpdatingId(null);
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/settings/customer-shipping-methods/sync");
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/customer-shipping-methods"] });
      toast({
        title: "Sync Complete",
        description: data.newMethods > 0 
          ? `Added ${data.newMethods} new customer shipping method(s).`
          : "No new customer shipping methods found.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to sync customer shipping methods",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (method: CustomerShippingMethod, field: 'allowRateCheck' | 'allowAssignment' | 'allowChange', value: boolean) => {
    setUpdatingId(method.id);
    updateMutation.mutate({
      id: method.id,
      [field]: value,
    });
  };

  const handleWeightChange = (method: CustomerShippingMethod, field: 'minAllowedWeight' | 'maxAllowedWeight', value: string) => {
    const numValue = value.trim() === '' ? null : parseFloat(value);
    if (value.trim() !== '' && (isNaN(numValue as number) || (numValue as number) < 0)) return;
    setUpdatingId(method.id);
    updateMutation.mutate({
      id: method.id,
      [field]: numValue,
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Truck className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Customer Shipping Methods</h1>
            <p className="text-muted-foreground">Configure rate checking and assignment permissions for customer shipping methods</p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          data-testid="button-sync-methods"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
          Sync New Methods
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Method Configuration</CardTitle>
          <CardDescription>
            Control which shipping methods are included in rate checking and can be assigned to shipments
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!methods || methods.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No customer shipping methods found. Click "Sync New Methods" to populate from existing shipments.
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
                          When enabled, orders with this shipping method will be included in the rate checker service.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableHead>
                  <TableHead className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      Allow Change
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          When disabled, this method acts as a pass-through — the customer's shipping choice is always kept, no matter what the rate checker finds. When enabled, the rate checker can override it with a better option.
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
                  <TableRow key={method.id} data-testid={`row-method-${method.id}`}>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {method.name}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Switch
                          checked={method.allowRateCheck}
                          onCheckedChange={(checked) => handleToggle(method, 'allowRateCheck', checked)}
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

      <Card>
        <CardHeader>
          <CardTitle>About These Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div>
            <strong className="text-foreground">Allow Rate Check:</strong> When enabled, orders with this shipping method 
            will be included in the rate checker service. Disable this for methods that should always be excluded from rate comparisons.
          </div>
          <div>
            <strong className="text-foreground">Allow Change:</strong> Controls whether the rate checker can override the customer's 
            shipping choice. When disabled, this method acts as a pass-through — the customer's selected shipping method 
            is always kept regardless of what rates the checker finds. When enabled, the rate checker may switch to a 
            different method if a better rate is available.
          </div>
          <div>
            <strong className="text-foreground">Allow Assignment:</strong> When enabled, this shipping method can be 
            assigned to shipments during fulfillment. Disable this for deprecated or restricted methods.
          </div>
          <div>
            <strong className="text-foreground">Min/Max Weight:</strong> Optional weight limits in ounces. When set, this 
            shipping method will only be considered for packages within this weight range. Leave empty for no limit.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
