import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mail } from "lucide-react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const requestLinkMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await apiRequest("POST", "/api/auth/request-magic-link", { email });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Check your email",
        description: "We've sent you a magic link to sign in.",
      });
      setEmail("");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to send magic link. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      requestLinkMutation.mutate(email);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-primary text-primary-foreground p-3 rounded-full">
              <Mail className="h-8 w-8" />
            </div>
          </div>
          <CardTitle className="text-3xl font-serif">ship.jerky.com</CardTitle>
          <CardDescription className="text-base">
            Enter your email to receive a magic link
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-base">
                Email Address
              </Label>
              <Input
                id="email"
                data-testid="input-email"
                type="email"
                placeholder="warehouse@jerky.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="h-12 text-base"
              />
            </div>
            <Button
              type="submit"
              data-testid="button-request-magic-link"
              className="w-full h-12 text-base font-semibold"
              disabled={requestLinkMutation.isPending}
            >
              {requestLinkMutation.isPending ? "Sending..." : "Send Magic Link"}
            </Button>
          </form>
          <p className="text-sm text-muted-foreground text-center mt-6">
            You'll receive a link that expires in 15 minutes
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
