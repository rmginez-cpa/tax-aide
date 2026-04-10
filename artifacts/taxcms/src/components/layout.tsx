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
  Menu
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState } from "react";

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

  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ["accountant", "manager", "viewer"] },
    { name: "Clients", href: "/clients", icon: Users, roles: ["accountant", "manager"] },
    { name: "Engagements", href: "/engagements", icon: Briefcase, roles: ["accountant", "manager", "viewer"] },
    { name: "Deadlines", href: "/deadlines", icon: Calendar, roles: ["accountant", "manager"] },
    { name: "Calendar", href: "/calendar", icon: CalendarDays, roles: ["accountant", "manager"] },
    { name: "Documents", href: "/documents", icon: FileText, roles: ["accountant", "manager", "viewer"] },
    { name: "Users", href: "/users", icon: UserCog, roles: ["manager"] },
    { name: "Notifications", href: "/notifications", icon: Bell, roles: ["accountant", "manager", "viewer"] },
    { name: "Audit Log", href: "/audit-log", icon: Activity, roles: ["manager"] },
  ];

  const allowedNav = navigation.filter(item => item.roles.includes(user.role));

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
                <div className="flex items-center gap-3 mb-3 px-2">
                  <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold shrink-0">
                    {user.name.charAt(0)}
                  </div>
                  <div className="overflow-hidden">
                    <p className="text-sm font-medium truncate text-sidebar-foreground">{user.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
                  </div>
                </div>
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
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
              {user.name.charAt(0)}
            </div>
            <div className="overflow-hidden">
              <p className="text-sm font-medium truncate text-sidebar-foreground">{user.name}</p>
              <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
            </div>
          </div>
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
    </div>
  );
}
