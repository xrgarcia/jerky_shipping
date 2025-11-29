import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { 
  Settings, 
  Save, 
  RefreshCw,
  Clock,
  Wifi,
  Timer,
  RotateCcw,
  Heart,
  Key,
  WifiOff
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { DesktopConfig } from "@shared/schema";

interface ConfigFormData {
  connectionTimeout: number;
  baseReconnectDelay: number;
  maxReconnectDelay: number;
  heartbeatInterval: number;
  reconnectInterval: number;
  tokenRefreshInterval: number;
  offlineTimeout: number;
}

const MIN_VALUES = {
  connectionTimeout: 5000,
  baseReconnectDelay: 1000,
  maxReconnectDelay: 5000,
  heartbeatInterval: 10000,
  reconnectInterval: 1000,
  tokenRefreshInterval: 300000,
  offlineTimeout: 500,
};

function formatMs(ms: number): string {
  if (ms >= 3600000) {
    const hours = ms / 3600000;
    return `${hours}h`;
  }
  if (ms >= 60000) {
    const minutes = ms / 60000;
    return `${minutes}m`;
  }
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${seconds}s`;
  }
  return `${ms}ms`;
}

function ConfigField({ 
  label, 
  description, 
  value, 
  onChange, 
  icon: Icon,
  unit = "ms",
  testId,
  minValue
}: { 
  label: string; 
  description: string; 
  value: number; 
  onChange: (value: number) => void;
  icon: React.ComponentType<{ className?: string }>;
  unit?: string;
  testId: string;
  minValue: number;
}) {
  const isValid = value >= minValue;
  
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <Label htmlFor={testId} className="font-medium">{label}</Label>
        <Badge variant="secondary" className="text-xs font-normal">
          {formatMs(value)}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="flex items-center gap-2">
        <Input
          id={testId}
          type="number"
          value={value}
          min={minValue}
          onChange={(e) => {
            const parsed = parseInt(e.target.value);
            onChange(isNaN(parsed) ? minValue : Math.max(parsed, minValue));
          }}
          className={`max-w-[200px] ${!isValid ? 'border-destructive' : ''}`}
          data-testid={testId}
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      <p className="text-xs text-muted-foreground">Minimum: {formatMs(minValue)}</p>
    </div>
  );
}

export default function DesktopConfigPage() {
  const { toast } = useToast();
  const [formData, setFormData] = useState<ConfigFormData | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: config, isLoading, refetch, isRefetching } = useQuery<DesktopConfig>({
    queryKey: ["/api/desktop/config"],
  });

  useEffect(() => {
    if (config && !formData) {
      setFormData({
        connectionTimeout: config.connectionTimeout,
        baseReconnectDelay: config.baseReconnectDelay,
        maxReconnectDelay: config.maxReconnectDelay,
        heartbeatInterval: config.heartbeatInterval,
        reconnectInterval: config.reconnectInterval,
        tokenRefreshInterval: config.tokenRefreshInterval,
        offlineTimeout: config.offlineTimeout,
      });
    }
  }, [config, formData]);

  useEffect(() => {
    if (config && formData) {
      const changed = 
        config.connectionTimeout !== formData.connectionTimeout ||
        config.baseReconnectDelay !== formData.baseReconnectDelay ||
        config.maxReconnectDelay !== formData.maxReconnectDelay ||
        config.heartbeatInterval !== formData.heartbeatInterval ||
        config.reconnectInterval !== formData.reconnectInterval ||
        config.tokenRefreshInterval !== formData.tokenRefreshInterval ||
        config.offlineTimeout !== formData.offlineTimeout;
      setHasChanges(changed);
    }
  }, [config, formData]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<ConfigFormData>) => {
      const res = await apiRequest("PATCH", "/api/desktop/config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/desktop/config"] });
      toast({
        title: "Configuration Updated",
        description: "Desktop client settings have been saved. Connected clients will apply the new settings.",
      });
      setHasChanges(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Update Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleFieldChange = (field: keyof ConfigFormData) => (value: number) => {
    setFormData(prev => prev ? { ...prev, [field]: value } : null);
  };

  const handleSave = () => {
    if (formData) {
      updateMutation.mutate(formData);
    }
  };

  const handleReset = () => {
    if (config) {
      setFormData({
        connectionTimeout: config.connectionTimeout,
        baseReconnectDelay: config.baseReconnectDelay,
        maxReconnectDelay: config.maxReconnectDelay,
        heartbeatInterval: config.heartbeatInterval,
        reconnectInterval: config.reconnectInterval,
        tokenRefreshInterval: config.tokenRefreshInterval,
        offlineTimeout: config.offlineTimeout,
      });
      setHasChanges(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Settings className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Desktop Configuration</h1>
            <p className="text-muted-foreground">
              Configure timing settings for all desktop clients remotely
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isRefetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wifi className="h-5 w-5" />
            WebSocket Connection Settings
          </CardTitle>
          <CardDescription>
            These settings control how desktop clients connect and maintain their WebSocket connections.
            Changes are broadcast to all connected clients in real-time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          {formData && (
            <>
              <div className="grid gap-6 md:grid-cols-2">
                <ConfigField
                  label="Connection Timeout"
                  description="Maximum time to wait for initial WebSocket connection"
                  value={formData.connectionTimeout}
                  onChange={handleFieldChange("connectionTimeout")}
                  icon={Clock}
                  testId="input-connection-timeout"
                  minValue={MIN_VALUES.connectionTimeout}
                />
                <ConfigField
                  label="Base Reconnect Delay"
                  description="Initial delay before attempting to reconnect after disconnect"
                  value={formData.baseReconnectDelay}
                  onChange={handleFieldChange("baseReconnectDelay")}
                  icon={Timer}
                  testId="input-base-reconnect-delay"
                  minValue={MIN_VALUES.baseReconnectDelay}
                />
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <ConfigField
                  label="Max Reconnect Delay"
                  description="Maximum delay between reconnection attempts (exponential backoff cap)"
                  value={formData.maxReconnectDelay}
                  onChange={handleFieldChange("maxReconnectDelay")}
                  icon={RotateCcw}
                  testId="input-max-reconnect-delay"
                  minValue={MIN_VALUES.maxReconnectDelay}
                />
                <ConfigField
                  label="Reconnect Interval"
                  description="Base interval for reconnection attempt scheduling"
                  value={formData.reconnectInterval}
                  onChange={handleFieldChange("reconnectInterval")}
                  icon={RefreshCw}
                  testId="input-reconnect-interval"
                  minValue={MIN_VALUES.reconnectInterval}
                />
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <ConfigField
                  label="Heartbeat Interval"
                  description="How often desktop clients send heartbeat pings to maintain connection"
                  value={formData.heartbeatInterval}
                  onChange={handleFieldChange("heartbeatInterval")}
                  icon={Heart}
                  testId="input-heartbeat-interval"
                  minValue={MIN_VALUES.heartbeatInterval}
                />
                <ConfigField
                  label="Token Refresh Interval"
                  description="How often authentication tokens are refreshed"
                  value={formData.tokenRefreshInterval}
                  onChange={handleFieldChange("tokenRefreshInterval")}
                  icon={Key}
                  testId="input-token-refresh-interval"
                  minValue={MIN_VALUES.tokenRefreshInterval}
                />
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <ConfigField
                  label="Offline Timeout"
                  description="Delay before sending offline notification on disconnect"
                  value={formData.offlineTimeout}
                  onChange={handleFieldChange("offlineTimeout")}
                  icon={WifiOff}
                  testId="input-offline-timeout"
                  minValue={MIN_VALUES.offlineTimeout}
                />
              </div>
            </>
          )}
        </CardContent>
        <CardFooter className="flex justify-between border-t pt-6">
          <div className="text-sm text-muted-foreground">
            {config?.updatedAt && (
              <span>
                Last updated: {new Date(config.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={!hasChanges || updateMutation.isPending}
              data-testid="button-reset"
            >
              Reset
            </Button>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || updateMutation.isPending}
              data-testid="button-save"
            >
              {updateMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </div>
        </CardFooter>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Default Values Reference</CardTitle>
          <CardDescription>
            These are the default timing values used when no custom configuration is set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Connection Timeout:</span>
              <span className="ml-2 font-medium">15s</span>
            </div>
            <div>
              <span className="text-muted-foreground">Base Reconnect:</span>
              <span className="ml-2 font-medium">2s</span>
            </div>
            <div>
              <span className="text-muted-foreground">Max Reconnect:</span>
              <span className="ml-2 font-medium">30s</span>
            </div>
            <div>
              <span className="text-muted-foreground">Heartbeat:</span>
              <span className="ml-2 font-medium">30s</span>
            </div>
            <div>
              <span className="text-muted-foreground">Reconnect Interval:</span>
              <span className="ml-2 font-medium">5s</span>
            </div>
            <div>
              <span className="text-muted-foreground">Token Refresh:</span>
              <span className="ml-2 font-medium">1h</span>
            </div>
            <div>
              <span className="text-muted-foreground">Offline Timeout:</span>
              <span className="ml-2 font-medium">1s</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
