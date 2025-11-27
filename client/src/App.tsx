import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { PrintQueueBar } from "@/components/print-queue-bar";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import VerifyMagicLink from "@/pages/verify-magic-link";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";
import Shipments from "@/pages/shipments";
import ShipmentDetails from "@/pages/shipment-details";
import Products from "@/pages/products";
import Packing from "@/pages/packing";
import Backfill from "@/pages/backfill";
import PrintQueue from "@/pages/print-queue";
import Profile from "@/pages/profile";
import Reports from "@/pages/reports";
import Sessions from "@/pages/sessions";
import Operations from "@/pages/operations";
import PORecommendations from "@/pages/po-recommendations";
import SessionOrders from "@/pages/session-orders";
import CustomerService from "@/pages/customer-service";
import type { User } from "@shared/schema";

function AppContent() {
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

  if (isLoading && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated && !isPublicRoute) {
    return <Redirect to="/login" />;
  }

  if (isAuthenticated && location === "/login") {
    return <Redirect to="/orders" />;
  }

  const router = (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/auth/verify" component={VerifyMagicLink} />
      <Route path="/">
        <Redirect to="/orders" />
      </Route>
      <Route path="/orders" component={Orders} />
      <Route path="/orders/:id" component={OrderDetail} />
      <Route path="/shipments/:id" component={ShipmentDetails} />
      <Route path="/shipments" component={Shipments} />
      <Route path="/packing" component={Packing} />
      <Route path="/products" component={Products} />
      <Route path="/sessions" component={Sessions} />
      <Route path="/backfill" component={Backfill} />
      <Route path="/operations" component={Operations} />
      <Route path="/print-queue" component={PrintQueue} />
      <Route path="/reports" component={Reports} />
      <Route path="/po-recommendations" component={PORecommendations} />
      <Route path="/session-orders" component={SessionOrders} />
      <Route path="/customer-service" component={CustomerService} />
      <Route path="/profile" component={Profile} />
      <Route component={NotFound} />
    </Switch>
  );

  if (isPublicRoute) {
    return router;
  }

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden relative">
          <header className="flex items-center justify-between p-4 border-b bg-card">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
          </header>
          <main className="flex-1 overflow-y-auto pb-20">
            {router}
          </main>
          <PrintQueueBar />
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppContent />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
