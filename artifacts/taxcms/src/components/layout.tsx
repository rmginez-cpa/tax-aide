import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useLogout } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { 
  LayoutDashboard, 
  Users, 
  Briefcase, 
  Calendar, 
  CalendarDays,
  FileText, 
  UserCog, 
  Bell, 
  Activity, 
  LogOut,
  Menu,
  ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  manager: "Manager",
  maker: "Maker",
  accountant: "Maker",
  client: "Client",
  viewer: "Viewer",
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  super_admin: "bg-violet-100 text-violet-800 border-violet-200",
  manager: "bg-blue-100 text-blue-800 border-blue-200",
  maker: "bg-emerald-100 text-emerald-800 border-emerald-200",
  accountant: "bg-emerald-100 text-emerald-800 border-emerald-200",
  client: "bg-amber-100 text-amber-800 border-amber-200",
  viewer: "bg-gray-100 text-gray-700 border-gray-200",
};

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout: clearAuth } = useAuth();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { toast } = useToast();
  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearAuth();
        toast({ title: "Logged out successfully" });
      }
    });
  };

  if (!user) return <>{children}</>;

  const role = user.role;

  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ["super_admin", "manager", "maker", "accountant", "client", "viewer"] },
    { name: "Clients", href: "/clients", icon: Users, roles: ["super_admin", "manager", "maker", "accountant"] },
    { name: "Engagements", href: "/engagements", icon: Briefcase, roles: ["super_admin", "manager", "maker", "accountant", "client", "viewer"] },
    { name: "Deadlines", href: "/deadlines", icon: Calendar, roles: ["super_admin", "manager", "maker", "accountant"] },
    { name: "Calendar", href: "/calendar", icon: CalendarDays, roles: ["super_admin", "manager", "maker", "accountant"] },
    { name: "Documents", href: "/documents", icon: FileText, roles: ["super_admin", "manager", "maker", "accountant", "client", "viewer"] },
    { name: "Users", href: "/users", icon: UserCog, roles: ["super_admin", "manager"] },
    { name: "Account Management", href: "/account-management", icon: ShieldCheck, roles: ["super_admin"] },
    { name: "Notifications", href: "/notifications", icon: Bell, roles: ["super_admin", "manager", "maker", "accountant", "client", "viewer"] },
    { name: "Audit Log", href: "/audit-log", icon: Activity, roles: ["super_admin", "manager"] },
  ];

  const allowedNav = navigation.filter(item => item.roles.includes(role));

  const roleLabel = ROLE_LABELS[role] ?? role;
  const roleBadgeStyle = ROLE_BADGE_STYLES[role] ?? "bg-gray-100 text-gray-700";

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <>
      <div className="mb-8 px-4">
        <h1 className="text-xl font-bold text-primary flex items-center gap-2">
          <Briefcase className="h-6 w-6" />
          <span>TaxAide</span>
        </h1>
        <p className="text-xs text-muted-foreground mt-1 tracking-wider uppercase font-semibold">
          BIR Compliance
        </p>
      </div>
      <div className="space-y-1">
        {allowedNav.map((item) => {
          const isActive = location === item.href || location.startsWith(`${item.href}/`);
          return (
            <Link key={item.name} href={item.href} onClick={onNavigate} className={`flex items-center gap-3 px-4 py-2.5 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary text-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </div>
    </>
  );

  const UserInfo = () => (
    <div className="flex items-center gap-3 mb-3 px-2">
      <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">
        {user.name.charAt(0)}
      </div>
      <div className="overflow-hidden flex-1">
        <p className="text-sm font-medium truncate text-sidebar-foreground">{user.name}</p>
        <Badge variant="outline" className={`text-xs px-1.5 py-0 h-4 ${roleBadgeStyle}`}>{roleLabel}</Badge>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Mobile Nav */}
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-primary" />
          <span className="font-bold">TaxAide</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Log out" className="text-muted-foreground hover:text-foreground">
            <LogOut className="h-4 w-4" />
          </Button>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-4 bg-sidebar border-sidebar-border text-sidebar-foreground flex flex-col">
              <div className="flex-1">
                <NavLinks onNavigate={() => setMobileOpen(false)} />
              </div>
              <div className="pt-4 mt-4 border-t border-sidebar-border">
                <UserInfo />
                <Button variant="ghost" className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={() => { setMobileOpen(false); handleLogout(); }}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Log out
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:flex w-64 flex-col fixed inset-y-0 border-r bg-sidebar border-sidebar-border z-10">
        <ScrollArea className="flex-1 py-6 px-3">
          <NavLinks />
        </ScrollArea>
        <div className="p-4 border-t border-sidebar-border">
          <UserInfo />
          <Button variant="ghost" className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Logout
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 md:ml-64 flex flex-col min-h-0">
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          {children}
        </main>
      </div>

      <AssistantPanel />
    </div>
  );
}
