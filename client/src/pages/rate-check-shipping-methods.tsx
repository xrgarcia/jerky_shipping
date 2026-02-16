import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Zap, CheckCircle, XCircle, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface RateCheckShippingMethod {
  id: number;
  name: string;
  allowRateCheck: boolean;
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

export default function RateCheckShippingMethods() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: methods, isLoading } = useQuery<RateCheckShippingMethod[]>({
    queryKey: ["/api/settings/rate-check-shipping-methods"],
  });

  const updateMutation = useMutation({
    mutationFn: async (data: { id: number; allowRateCheck: boolean }) => {
      const { id, ...body } = data;
      return apiRequest("PUT", `/api/settings/rate-check-shipping-methods/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/rate-check-shipping-methods"] });
      toast({
        title: "Updated",
        description: "Rate check shipping method settings saved.",
      });
      setUpdatingId(null);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update rate check shipping method",
        variant: "destructive",
      });
      setUpdatingId(null);
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/settings/rate-check-shipping-methods/sync");
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/rate-check-shipping-methods"] });
      toast({
        title: "Sync Complete",
        description: data.newMethods > 0 
          ? `Added ${data.newMethods} new rate check shipping method(s).`
          : "No new rate check shipping methods found.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to sync rate check shipping methods",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (method: RateCheckShippingMethod, value: boolean) => {
    setUpdatingId(method.id);
    updateMutation.mutate({
      id: method.id,
      allowRateCheck: value,
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
          <Zap className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Rate Checker Shipping Methods</h1>
            <p className="text-muted-foreground">Configure which candidate shipping methods the rate checker can use</p>
          </div>
        </div>
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
        <CardHeader>
          <CardTitle>Method Configuration</CardTitle>
          <CardDescription>
            These are the candidate shipping methods discovered by the rate checker. Toggle which ones are allowed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!methods || methods.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-empty-state">
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
            <strong className="text-foreground">Allow Rate Check:</strong> When enabled, this shipping method is a valid 
            candidate that the rate checker can recommend. Disable it to prevent the rate checker from ever selecting 
            this method, even if it offers the best rate.
          </div>
          <div>
            <strong className="text-foreground">Sync:</strong> The sync button discovers all unique shipping methods 
            that the rate checker has previously recommended and adds any new ones to this list. Existing settings are preserved.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
