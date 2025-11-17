import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import VerifyMagicLink from "@/pages/verify-magic-link";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";
import Profile from "@/pages/profile";
import type { User } from "@shared/schema";

function AuthenticatedApp() {
  const { data: userData, isLoading } = useQuery<{ user: User }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });

  const [location] = useLocation();
  const isPublicRoute = location === "/login" || location.startsWith("/auth/verify");

  if (isLoading && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const isAuthenticated = !!userData?.user;

  if (!isAuthenticated && !isPublicRoute) {
    return <Redirect to="/login" />;
  }

  if (isAuthenticated && location === "/login") {
    return <Redirect to="/orders" />;
  }

  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/auth/verify" component={VerifyMagicLink} />
      <Route path="/">
        <Redirect to="/orders" />
      </Route>
      <Route path="/orders" component={Orders} />
      <Route path="/orders/:id" component={OrderDetail} />
      <Route path="/profile" component={Profile} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppLayout() {
  const { data: userData, isLoading } = useQuery<{ user: User }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });

  const [location] = useLocation();
  const isPublicRoute = location === "/login" || location.startsWith("/auth/verify");
  const isAuthenticated = !!userData?.user;

  const sidebarStyle = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  if (isPublicRoute || (!isLoading && !isAuthenticated)) {
    return <AuthenticatedApp />;
  }

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between p-4 border-b bg-card">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
          </header>
          <main className="flex-1 overflow-y-auto">
            <AuthenticatedApp />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppLayout />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
