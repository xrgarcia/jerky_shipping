import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { SiGoogle } from "react-icons/si";
import { Loader2 } from "lucide-react";

export default function Login() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const error = searchParams.get("error");
  const { toast } = useToast();

  const { data: authData, isLoading } = useQuery<{ user: any }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });

  useEffect(() => {
    if (authData?.user) {
      setLocation("/orders");
    }
  }, [authData, setLocation]);

  useEffect(() => {
    if (error) {
      const errorMessages: Record<string, string> = {
        oauth_denied: "Sign in was cancelled. Please try again.",
        no_code: "Authentication failed. Please try again.",
        invalid_state: "Authentication failed. Please try again.",
        unauthorized_domain: "Only @jerky.com accounts are allowed to sign in.",
        auth_failed: "Authentication failed. Please try again.",
      };
      toast({
        title: "Sign In Error",
        description: errorMessages[error] || "An error occurred during sign in.",
        variant: "destructive",
      });
      window.history.replaceState({}, "", "/login");
    }
  }, [error, toast]);

  const handleGoogleSignIn = () => {
    window.location.href = "/api/auth/google";
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-primary text-primary-foreground p-3 rounded-full">
              <SiGoogle className="h-8 w-8" />
            </div>
          </div>
          <CardTitle className="text-3xl font-serif">ship.jerky.com</CardTitle>
          <CardDescription className="text-base">
            Sign in with your Jerky.com Google account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={handleGoogleSignIn}
            data-testid="button-google-signin"
            className="w-full h-12 text-base font-semibold gap-2"
          >
            <SiGoogle className="h-5 w-5" />
            Sign in with Google
          </Button>
          <p className="text-sm text-muted-foreground text-center">
            Only @jerky.com accounts can access this application
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
