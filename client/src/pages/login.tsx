import { useEffect, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { SiGoogle } from "react-icons/si";
import { Loader2, AlertCircle } from "lucide-react";
import jerkyLogo from "@assets/image_1764264961124.png";

export default function Login() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const error = searchParams.get("error");
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [showEmailInput, setShowEmailInput] = useState(false);

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
        oauth_denied: "Sign in was cancelled or wrong account selected. Make sure to choose your @jerky.com account.",
        no_code: "Authentication failed. Please try again.",
        invalid_state: "Authentication failed. Please try again.",
        unauthorized_domain: "Only @jerky.com accounts are allowed to sign in.",
        auth_failed: "Authentication failed. Please try again.",
        wrong_account: "Please sign in with your @jerky.com account, not a personal Gmail.",
      };
      toast({
        title: "Sign In Error",
        description: errorMessages[error] || "An error occurred during sign in.",
        variant: "destructive",
      });
      // Show email input to help user select correct account
      if (error === "oauth_denied" || error === "wrong_account") {
        setShowEmailInput(true);
      }
      window.history.replaceState({}, "", "/login");
    }
  }, [error, toast]);

  const handleGoogleSignIn = () => {
    // If user entered their email, pass it as a login hint
    if (email && email.includes("@")) {
      const emailWithDomain = email.includes("@jerky.com") ? email : `${email.split("@")[0]}@jerky.com`;
      window.location.href = `/api/auth/google?login_hint=${encodeURIComponent(emailWithDomain)}`;
    } else {
      window.location.href = "/api/auth/google";
    }
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
      <Card className="w-full max-w-md overflow-hidden">
        <div className="bg-black dark:bg-black py-6 px-4 flex justify-center">
          <img 
            src={jerkyLogo} 
            alt="Jerky.com" 
            className="h-10 object-contain"
            data-testid="img-login-logo"
          />
        </div>
        <CardHeader className="space-y-1 text-center pt-6">
          <CardTitle className="text-3xl font-serif">ship.jerky.com</CardTitle>
          <CardDescription className="text-base">
            Sign in with your Jerky.com Google account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {showEmailInput && (
            <Alert className="border-amber-500/50 bg-amber-500/10">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              <AlertDescription className="text-sm">
                Having trouble? Enter your @jerky.com email below to help select the right account.
              </AlertDescription>
            </Alert>
          )}
          
          {showEmailInput && (
            <div className="space-y-2">
              <Label htmlFor="email">Your @jerky.com email</Label>
              <Input
                id="email"
                type="email"
                placeholder="yourname@jerky.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="input-email-hint"
              />
            </div>
          )}
          
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
          
          {!showEmailInput && (
            <button
              onClick={() => setShowEmailInput(true)}
              className="text-xs text-muted-foreground hover:text-foreground underline w-full text-center"
              data-testid="link-trouble-signing-in"
            >
              Trouble signing in?
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
