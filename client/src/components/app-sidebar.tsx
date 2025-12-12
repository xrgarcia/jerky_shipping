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
import { Package, Truck, Database, Printer, User as UserIcon, LogOut, ChevronUp, ChevronRight, BarChart3, ListChecks, Activity, PackageCheck, ShoppingCart, Headset, Download, Monitor, Settings, AlertTriangle, Store, ClipboardList, PackageOpen, FileText } from "lucide-react";
import jerkyLogo from "@assets/image_1764264961124.png";
import { useToast } from "@/hooks/use-toast";
import type { User } from "@shared/schema";

export function AppSidebar() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  
  // Auto-expand Reports section if on a reports page
  const isReportsPage = location.startsWith('/reports');
  const [reportsOpen, setReportsOpen] = useState(isReportsPage);
  
  // Auto-expand Settings section if on a tools page
  const isSettingsPage = location.startsWith('/tools') || location === '/stations' || location === '/desktop-config';
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
      title: "Sessions",
      url: "/sessions",
      icon: ListChecks,
    },
    {
      title: "Print Queue",
      url: "/print-queue",
      icon: Printer,
    },
    {
      title: "PO Recommend",
      url: "/po-recommendations",
      icon: ShoppingCart,
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
  ];
  
  // Reports submenu items
  const reportsItems = [
    {
      title: "Shopify Orders",
      url: "/orders",
      icon: Package,
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
      title: "Packing Ready (Debug)",
      url: "/packing-ready",
      icon: Database,
    },
  ];

  return (
    <Sidebar>
      <div 
        className="flex items-center justify-center px-4 border-b border-sidebar-border h-[72px]"
        style={{ background: '#1a1a1a' }}
      >
        <img 
          src={jerkyLogo} 
          alt="Jerky.com" 
          className="h-12 w-auto"
          data-testid="img-jerky-logo"
        />
      </div>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.slice(0, 8).map((item) => (
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
                    <item.icon className="h-4 w-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuItem>
              ))}
              
              {/* Collapsible Reports Section */}
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
                    <BarChart3 className="h-4 w-4" />
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
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuItem>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
              
              {/* Downloads */}
              {menuItems.slice(8).map((item) => (
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
                    <item.icon className="h-4 w-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuItem>
              ))}
              
              {/* Collapsible Settings Section */}
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
                    <Settings className="h-4 w-4" />
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
                          <item.icon className="h-4 w-4" />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuItem>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-all hover-elevate active-elevate-2 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground`}
                style={user?.profileBackgroundColor ? { backgroundColor: user.profileBackgroundColor } : undefined}
                data-testid="button-user-menu"
              >
                <Avatar className={`h-8 w-8 ${user?.profileBackgroundColor ? "border border-white/20" : ""}`}>
                  <AvatarImage src={user?.avatarUrl || undefined} />
                  <AvatarFallback className={user?.profileBackgroundColor ? "bg-white/20 text-white" : "bg-primary text-primary-foreground"}>
                    {user?.email?.[0]?.toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <div className={`flex flex-col items-start text-sm flex-1 min-w-0 ${user?.profileBackgroundColor ? "text-white" : ""}`}>
                  <span className="font-semibold truncate max-w-32">
                    {user?.handle ? `@${user.handle}` : user?.email}
                  </span>
                </div>
                <ChevronUp className={`h-4 w-4 ${user?.profileBackgroundColor ? "text-white" : ""}`} />
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
