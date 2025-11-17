import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

export default function VerifyMagicLink() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const token = searchParams.get("token");
  const [verificationState, setVerificationState] = useState<"verifying" | "success" | "error">("verifying");

  const verifyMutation = useMutation({
    mutationFn: async (token: string) => {
      const res = await apiRequest("POST", "/api/auth/verify-magic-link", { token });
      return res.json();
    },
    onSuccess: () => {
      setVerificationState("success");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setTimeout(() => {
        setLocation("/orders");
      }, 1500);
    },
    onError: () => {
      setVerificationState("error");
    },
  });

  useEffect(() => {
    if (token) {
      verifyMutation.mutate(token);
    } else {
      setVerificationState("error");
    }
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            {verificationState === "verifying" && (
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
            )}
            {verificationState === "success" && (
              <CheckCircle className="h-12 w-12 text-green-600" />
            )}
            {verificationState === "error" && (
              <XCircle className="h-12 w-12 text-destructive" />
            )}
          </div>
          <CardTitle className="text-2xl font-serif">
            {verificationState === "verifying" && "Verifying your link..."}
            {verificationState === "success" && "Welcome back!"}
            {verificationState === "error" && "Verification failed"}
          </CardTitle>
          <CardDescription>
            {verificationState === "verifying" && "Please wait while we sign you in"}
            {verificationState === "success" && "Redirecting to your dashboard..."}
            {verificationState === "error" && "This link is invalid or has expired"}
          </CardDescription>
        </CardHeader>
        {verificationState === "error" && (
          <CardContent className="flex justify-center">
            <Button
              data-testid="button-back-to-login"
              onClick={() => setLocation("/login")}
              className="w-full"
            >
              Back to Login
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
