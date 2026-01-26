import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Package, Truck, Database, Printer, User as UserIcon, LogOut, ChevronUp, ChevronRight, BarChart3, ListChecks, Activity, PackageCheck, ShoppingCart, Headset, Download, Monitor, Settings, AlertTriangle, Store, ClipboardList, PackageOpen, FileText, Layers, Boxes, FileSearch, DollarSign, Inbox } from "lucide-react";
import jerkyLogo from "@assets/image_1764264961124.png";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";

export function AppSidebar() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  
  // Auto-expand Reports section if on a reports page
  const isReportsPage = location.startsWith('/reports');
  const [reportsOpen, setReportsOpen] = useState(isReportsPage);
  
  // Auto-expand Settings section if on a tools page
  const isSettingsPage = location.startsWith('/tools') || location.startsWith('/settings/') || location === '/stations' || location === '/desktop-config';
  const [settingsOpen, setSettingsOpen] = useState(isSettingsPage);

  const { data: userData } = useQuery<{ user: User }>({
    queryKey: ["/api/auth/me"],
  });

  const user = userData?.user;

  const logoutMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/logout");
      return res.json();
    },
    onSuccess: () => {
      queryClient.clear();
      setLocation("/login");
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to logout.",
        variant: "destructive",
      });
    },
  });

  const menuItems = [
    {
      title: "Shipments",
      url: "/shipments",
      icon: Truck,
    },
    {
      title: "Boxing",
      url: "/packing",
      icon: PackageCheck,
    },
    {
      title: "Bagging",
      url: "/bagging",
      icon: PackageOpen,
    },
    {
      title: "Print Queue",
      url: "/print-queue",
      icon: Printer,
    },
    {
      title: "Skuvault Sessions",
      url: "/sessions",
      icon: ListChecks,
    },
    {
      title: "PO Recommend",
      url: "/po-recommendations",
      icon: ShoppingCart,
    },
    {
      title: "Geometry Collections",
      url: "/collections",
      icon: Layers,
    },
    {
      title: "Packaging Types",
      url: "/packaging-types",
      icon: Boxes,
    },
    {
      title: "Fulfillment Prep",
      url: "/fulfillment-prep",
      icon: Layers,
    },
    {
      title: "Products",
      url: "/skuvault-products",
      icon: Package,
    },
    {
      title: "Smart Sessions",
      url: "/smart-sessions",
      icon: FileSearch,
    },
    {
      title: "Smart Rate Check",
      url: "/smart-rate-check",
      icon: DollarSign,
    },
    {
      title: "Customer Service",
      url: "/customer-service",
      icon: Headset,
    },
    {
      title: "Downloads",
      url: "/downloads",
      icon: Download,
    },
  ];
  
  // Settings submenu items
  const settingsItems = [
    {
      title: "Backfill",
      url: "/tools/backfill",
      icon: Database,
    },
    {
      title: "Operations",
      url: "/tools/operations",
      icon: Activity,
    },
    {
      title: "Stations",
      url: "/stations",
      icon: Monitor,
    },
    {
      title: "Desktop Config",
      url: "/desktop-config",
      icon: Settings,
    },
    {
      title: "Excluded SKUs",
      url: "/settings/excluded-skus",
      icon: AlertTriangle,
    },
  ];
  
  // Reports submenu items
  const reportsItems = [
    {
      title: "Shopify Orders",
      url: "/orders",
      icon: Package,
    },
    {
      title: "Shopify Products",
      url: "/shopify-products",
      icon: Store,
    },
    {
      title: "Shopify Sales",
      url: "/reports/shopify-sales",
      icon: Store,
    },
    {
      title: "Packed Shipments",
      url: "/reports/packed-shipments",
      icon: PackageCheck,
    },
    {
      title: "Shipment Events",
      url: "/reports/shipment-events",
      icon: ClipboardList,
    },
    {
      title: "Packing Logs",
      url: "/reports/packing-logs",
      icon: FileText,
    },
    {
      title: "Broken Shipments",
      url: "/reports/broken-shipments",
      icon: AlertTriangle,
    },
    {
      title: "QC Validation",
      url: "/reports/qc-validation",
      icon: FileSearch,
    },
    {
      title: "Validate Orders",
      url: "/reports/validate-orders",
      icon: FileSearch,
    },
    {
      title: "Fingerprints",
      url: "/reports/fingerprints",
      icon: Layers,
    },
    {
      title: "Shipments DLQ",
      url: "/reports/shipments-dlq",
      icon: Inbox,
    },
    {
      title: "Packing Ready (Debug)",
      url: "/packing-ready",
      icon: Database,
    },
  ];

  return (
    <Sidebar collapsible="icon">
      <div 
        className="flex items-center justify-center border-b border-sidebar-border h-[72px] px-2"
        style={{ background: '#1a1a1a' }}
      >
        <img 
          src={jerkyLogo} 
          alt="Jerky.com" 
          className={`w-auto transition-all duration-200 ${isCollapsed ? 'h-6' : 'h-12'}`}
          data-testid="img-jerky-logo"
        />
      </div>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.slice(0, 11).map((item) => (
                <SidebarMenuItem key={item.title}>
                  <Link 
                    href={item.url}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                      location === item.url 
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                        : 'text-sidebar-foreground'
                    } ${isCollapsed ? 'justify-center' : ''}`}
                    data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                    title={isCollapsed ? item.title : undefined}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!isCollapsed && <span>{item.title}</span>}
                  </Link>
                </SidebarMenuItem>
              ))}
              
              {/* Reports Section - Popover when collapsed, Collapsible when expanded */}
              {isCollapsed ? (
                <SidebarMenuItem>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button 
                        className={`flex items-center justify-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 w-full ${
                          isReportsPage
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                            : 'text-sidebar-foreground'
                        }`}
                        data-testid="link-reports"
                        title="Reports"
                      >
                        <BarChart3 className="h-4 w-4 shrink-0" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="right" align="start" className="w-56 p-2">
                      <div className="text-sm font-semibold mb-2 px-2 text-muted-foreground">Reports</div>
                      {reportsItems.map((item) => (
                        <Link 
                          key={item.title}
                          href={item.url}
                          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                            location === item.url 
                              ? 'bg-accent text-accent-foreground font-semibold' 
                              : 'text-foreground'
                          }`}
                          data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span>{item.title}</span>
                        </Link>
                      ))}
                    </PopoverContent>
                  </Popover>
                </SidebarMenuItem>
              ) : (
                <Collapsible open={reportsOpen} onOpenChange={setReportsOpen}>
                  <SidebarMenuItem>
                    <CollapsibleTrigger 
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 w-full ${
                        isReportsPage
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                          : 'text-sidebar-foreground'
                      }`}
                      data-testid="link-reports"
                    >
                      <BarChart3 className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Reports</span>
                      <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${reportsOpen ? 'rotate-90' : ''}`} />
                    </CollapsibleTrigger>
                  </SidebarMenuItem>
                  <CollapsibleContent>
                    <div className="ml-4 border-l border-sidebar-border pl-2 mt-1">
                      {reportsItems.map((item) => (
                        <SidebarMenuItem key={item.title}>
                          <Link 
                            href={item.url}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                              location === item.url 
                                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                                : 'text-sidebar-foreground'
                            }`}
                            data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            <item.icon className="h-4 w-4 shrink-0" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuItem>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
              
              {/* Remaining items after Reports */}
              {menuItems.slice(11).map((item) => (
                <SidebarMenuItem key={item.title}>
                  <Link 
                    href={item.url}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                      location === item.url 
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                        : 'text-sidebar-foreground'
                    } ${isCollapsed ? 'justify-center' : ''}`}
                    data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                    title={isCollapsed ? item.title : undefined}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!isCollapsed && <span>{item.title}</span>}
                  </Link>
                </SidebarMenuItem>
              ))}
              
              {/* Settings Section - Popover when collapsed, Collapsible when expanded */}
              {isCollapsed ? (
                <SidebarMenuItem>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button 
                        className={`flex items-center justify-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 w-full ${
                          isSettingsPage
                            ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                            : 'text-sidebar-foreground'
                        }`}
                        data-testid="link-settings"
                        title="Settings"
                      >
                        <Settings className="h-4 w-4 shrink-0" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="right" align="start" className="w-56 p-2">
                      <div className="text-sm font-semibold mb-2 px-2 text-muted-foreground">Settings</div>
                      {settingsItems.map((item) => (
                        <Link 
                          key={item.title}
                          href={item.url}
                          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                            location === item.url 
                              ? 'bg-accent text-accent-foreground font-semibold' 
                              : 'text-foreground'
                          }`}
                          data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span>{item.title}</span>
                        </Link>
                      ))}
                    </PopoverContent>
                  </Popover>
                </SidebarMenuItem>
              ) : (
                <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                  <SidebarMenuItem>
                    <CollapsibleTrigger 
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 w-full ${
                        isSettingsPage
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                          : 'text-sidebar-foreground'
                      }`}
                      data-testid="link-settings"
                    >
                      <Settings className="h-4 w-4 shrink-0" />
                      <span className="flex-1 text-left">Settings</span>
                      <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${settingsOpen ? 'rotate-90' : ''}`} />
                    </CollapsibleTrigger>
                  </SidebarMenuItem>
                  <CollapsibleContent>
                    <div className="ml-4 border-l border-sidebar-border pl-2 mt-1">
                      {settingsItems.map((item) => (
                        <SidebarMenuItem key={item.title}>
                          <Link 
                            href={item.url}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover-elevate active-elevate-2 ${
                              location === item.url 
                                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' 
                                : 'text-sidebar-foreground'
                            }`}
                            data-testid={`link-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            <item.icon className="h-4 w-4 shrink-0" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuItem>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all hover-elevate active-elevate-2 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground ${isCollapsed ? 'justify-center' : ''}`}
                style={user?.profileBackgroundColor ? { backgroundColor: user.profileBackgroundColor } : undefined}
                data-testid="button-user-menu"
                title={isCollapsed ? (user?.handle ? `@${user.handle}` : user?.email || 'User') : undefined}
              >
                <Avatar className={`transition-all duration-200 ${isCollapsed ? 'h-6 w-6' : 'h-8 w-8'} ${user?.profileBackgroundColor ? "border border-white/20" : ""}`}>
                  <AvatarImage src={user?.avatarUrl || undefined} />
                  <AvatarFallback className={`${isCollapsed ? 'text-xs' : ''} ${user?.profileBackgroundColor ? "bg-white/20 text-white" : "bg-primary text-primary-foreground"}`}>
                    {user?.email?.[0]?.toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                {!isCollapsed && (
                  <div className={`flex flex-col items-start text-sm flex-1 min-w-0 ${user?.profileBackgroundColor ? "text-white" : ""}`}>
                    <span className="font-semibold truncate max-w-32">
                      {user?.handle ? `@${user.handle}` : user?.email}
                    </span>
                  </div>
                )}
                {!isCollapsed && <ChevronUp className={`h-4 w-4 ${user?.profileBackgroundColor ? "text-white" : ""}`} />}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                className="w-56"
                align="end"
              >
                <DropdownMenuItem
                  onClick={() => setLocation("/profile")}
                  data-testid="menu-item-profile"
                >
                  <UserIcon className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => logoutMutation.mutate()}
                  data-testid="menu-item-logout"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
