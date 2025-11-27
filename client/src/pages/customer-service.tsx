import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Copy, RefreshCw, CheckCircle2, AlertCircle, Sparkles } from "lucide-react";

interface GenerateResponse {
  success: boolean;
  orderNumber?: string;
  attempts?: number;
  error?: string;
}

export default function CustomerService() {
  const { toast } = useToast();
  const [initials, setInitials] = useState("");
  const [generatedOrder, setGeneratedOrder] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST", 
        "/api/manual-orders/generate", 
        { initials: initials.trim() || undefined }
      );
      return response.json() as Promise<GenerateResponse>;
    },
    onSuccess: (data) => {
      if (data.success && data.orderNumber) {
        setGeneratedOrder(data.orderNumber);
        setCopied(false);
        toast({
          title: "Order Number Generated",
          description: `New order number: ${data.orderNumber}`,
        });
      } else {
        toast({
          title: "Generation Failed",
          description: data.error || "Failed to generate order number",
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to generate order number",
        variant: "destructive",
      });
    },
  });

  const handleCopy = async () => {
    if (!generatedOrder) return;
    
    try {
      await navigator.clipboard.writeText(generatedOrder);
      setCopied(true);
      toast({
        title: "Copied!",
        description: "Order number copied to clipboard",
      });
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      toast({
        title: "Copy Failed",
        description: "Please select and copy manually",
        variant: "destructive",
      });
    }
  };

  const handleInitialsChange = (value: string) => {
    const cleaned = value.toUpperCase().replace(/[^A-Z]/g, "");
    if (cleaned.length <= 3) {
      setInitials(cleaned);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold" data-testid="heading-customer-service">
          Customer Service
        </h1>
        <p className="text-muted-foreground mt-2">
          Generate valid order numbers for manual/phone orders
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Manual Order Number Generator
          </CardTitle>
          <CardDescription>
            Generate a unique order number for manual orders in Shopify. The order number will be 
            verified against our system to ensure it doesn't already exist and follows the correct format.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="initials">Your Initials (2-3 letters)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="initials"
                placeholder="e.g., JB, SP, RW"
                value={initials}
                onChange={(e) => handleInitialsChange(e.target.value)}
                className="max-w-[120px] font-mono uppercase text-center text-lg"
                maxLength={3}
                data-testid="input-initials"
              />
              <span className="text-sm text-muted-foreground">
                Letters only, no numbers
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Your initials help identify who created the order
            </p>
          </div>

          <Button
            size="lg"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="w-full sm:w-auto text-lg px-8 py-6"
            data-testid="button-generate"
          >
            {generateMutation.isPending ? (
              <>
                <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-5 w-5 mr-2" />
                Generate Order Number
              </>
            )}
          </Button>

          {generatedOrder && (
            <div className="mt-6 p-6 bg-muted/50 rounded-lg border-2 border-primary/20">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <span className="font-semibold text-green-700 dark:text-green-400">
                  Order Number Generated
                </span>
                <Badge variant="secondary" className="ml-auto">
                  Verified Unique
                </Badge>
              </div>
              
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div 
                  className="text-3xl font-mono font-bold tracking-wider select-all bg-background px-4 py-3 rounded-md border flex-1 text-center sm:text-left"
                  data-testid="text-generated-order"
                >
                  {generatedOrder}
                </div>
                
                <Button
                  variant={copied ? "secondary" : "default"}
                  size="lg"
                  onClick={handleCopy}
                  className="w-full sm:w-auto"
                  data-testid="button-copy"
                >
                  {copied ? (
                    <>
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-5 w-5 mr-2" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {generateMutation.isError && (
            <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-destructive">Generation Failed</p>
                <p className="text-sm text-destructive/80">
                  {(generateMutation.error as Error)?.message || "Please try again"}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
            <li>Enter your initials (2-3 letters, like JB or RW)</li>
            <li>Click "Generate Order Number" to create a new unique order number</li>
            <li>The system verifies the order number doesn't already exist</li>
            <li>Copy the order number and use it when creating the manual order in Shopify</li>
          </ol>
          
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <p className="text-sm font-medium mb-1">Order Number Format:</p>
            <code className="text-sm font-mono">JK####-######-XX</code>
            <p className="text-xs text-muted-foreground mt-1">
              Example: JK3825-112525-JB
            </p>
          </div>

          <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-1">
              Important: No numbers in initials
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Initials must be letters only (like JB, not JB1). Numbers at the end can cause 
              parsing issues with the automation system.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
