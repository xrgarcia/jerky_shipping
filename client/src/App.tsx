import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useInactivityTimeout } from "@/hooks/use-inactivity-timeout";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Orders from "@/pages/orders";
import OrderDetail from "@/pages/order-detail";
import Shipments from "@/pages/shipments";
import ShipmentDetails from "@/pages/shipment-details";
import Products from "@/pages/products";
import Packing from "@/pages/packing";
import Bagging from "@/pages/bagging";
import PackingReady from "@/pages/packing-ready";
import Backfill from "@/pages/tools/backfill";
import PrintQueue from "@/pages/print-queue";
import Profile from "@/pages/profile";
import ShopifySalesReport from "@/pages/reports/shopify-sales";
import BrokenShipmentsReport from "@/pages/reports/broken-shipments";
import PackedShipmentsReport from "@/pages/reports/packed-shipments";
import ShipmentEventsReport from "@/pages/reports/shipment-events";
import PackingLogsReport from "@/pages/reports/packing-logs";
import Sessions from "@/pages/sessions";
import Operations from "@/pages/tools/operations";
import PORecommendations from "@/pages/po-recommendations";
import SessionOrders from "@/pages/session-orders";
import CustomerService from "@/pages/customer-service";
import Downloads from "@/pages/downloads";
import Stations from "@/pages/stations";
import DesktopConfig from "@/pages/desktop-config";
import Collections from "@/pages/collections";
import PackagingTypes from "@/pages/packaging-types";
import FulfillmentPrep from "@/pages/fingerprints";
import SkuvaultProducts from "@/pages/skuvault-products";
import type { User } from "@shared/schema";

function AppContent() {
  const { data: userData, isLoading } = useQuery<{ user: User }>({
    queryKey: ["/api/auth/me"],
    retry: false,
  });

  const [location] = useLocation();
  const isPublicRoute = location === "/login";
  const isAuthenticated = !!userData?.user;

  // Inactivity timeout - only active for authenticated users
  const { WarningDialog } = useInactivityTimeout({
    onLogout: () => {
      queryClient.clear();
    },
    enabled: isAuthenticated,
  });

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
    return <Redirect to="/shipments" />;
  }

  const router = (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        <Redirect to="/shipments" />
      </Route>
      <Route path="/orders" component={Orders} />
      <Route path="/orders/:id" component={OrderDetail} />
      <Route path="/shipments/:id" component={ShipmentDetails} />
      <Route path="/shipments" component={Shipments} />
      <Route path="/packing" component={Packing} />
      <Route path="/bagging" component={Bagging} />
      <Route path="/packing-ready" component={PackingReady} />
      <Route path="/products" component={Products} />
      <Route path="/sessions" component={Sessions} />
      <Route path="/tools/backfill" component={Backfill} />
      <Route path="/tools/operations" component={Operations} />
      <Route path="/print-queue" component={PrintQueue} />
      <Route path="/reports/shopify-sales" component={ShopifySalesReport} />
      <Route path="/reports/broken-shipments" component={BrokenShipmentsReport} />
      <Route path="/reports/packed-shipments" component={PackedShipmentsReport} />
      <Route path="/reports/shipment-events" component={ShipmentEventsReport} />
      <Route path="/reports/packing-logs" component={PackingLogsReport} />
      <Route path="/reports">
        <Redirect to="/reports/shopify-sales" />
      </Route>
      <Route path="/po-recommendations" component={PORecommendations} />
      <Route path="/session-orders" component={SessionOrders} />
      <Route path="/customer-service" component={CustomerService} />
      <Route path="/downloads" component={Downloads} />
      <Route path="/stations" component={Stations} />
      <Route path="/desktop-config" component={DesktopConfig} />
      <Route path="/collections" component={Collections} />
      <Route path="/packaging-types" component={PackagingTypes} />
      <Route path="/fulfillment-prep" component={FulfillmentPrep} />
      <Route path="/skuvault-products" component={SkuvaultProducts} />
      <Route path="/profile" component={Profile} />
      <Route component={NotFound} />
    </Switch>
  );

  if (isPublicRoute) {
    return router;
  }

  return (
    <>
      <SidebarProvider style={sidebarStyle as React.CSSProperties}>
        <div className="flex h-screen w-full">
          <AppSidebar />
          <div className="flex flex-col flex-1 overflow-hidden relative">
            <header 
              className="flex items-center justify-between px-4 border-b border-sidebar-border h-[72px]"
              style={{ background: '#1a1a1a' }}
            >
              <SidebarTrigger data-testid="button-sidebar-toggle" className="text-white hover:bg-white/10" />
            </header>
            <main className="flex-1 overflow-y-auto">
              {router}
            </main>
          </div>
        </div>
      </SidebarProvider>
      {WarningDialog}
    </>
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
