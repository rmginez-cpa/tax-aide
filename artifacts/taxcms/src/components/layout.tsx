import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useLogout } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Briefcase, Bell, LogOut, Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useCallback, useState } from "react";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import { CommandPalette, PaletteShortcut } from "@/components/CommandPalette";
import { navItemsFor } from "@/components/navigation";
import { roleLabel as getRoleLabel, roleBadgeClass } from "@/lib/status";
import { unreadBadgeText, useUnreadNotificationCount } from "@/lib/notifications";

/** Red pill with the unread count; renders nothing for 0. */
function UnreadBadge({ count, className = "" }: { count: number; className?: string }) {
  const text = unreadBadgeText(count);
  if (!text) return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold leading-none text-white ${className}`}
    >
      {text}
    </span>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout: clearAuth } = useAuth();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const onPaletteOpenChange = useCallback((open: boolean) => setPaletteOpen(open), []);
  const unreadCount = useUnreadNotificationCount(!!user);
  const unreadLabel = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications";
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

  const allowedNav = navItemsFor(role);

  const roleLabel = getRoleLabel(role);
  const roleBadgeStyle = roleBadgeClass(role);

  const openPalette = (afterClose?: () => void) => {
    afterClose?.();
    setPaletteOpen(true);
  };

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <>
      <div className="mb-6 px-4">
        <h1 className="text-xl font-bold text-primary flex items-center gap-2">
          <Briefcase className="h-6 w-6" />
          <span>TaxAide</span>
        </h1>
        <p className="text-xs text-muted-foreground mt-1 tracking-wider uppercase font-semibold">
          BIR Compliance
        </p>
      </div>
      <button
        type="button"
        onClick={() => openPalette(onNavigate)}
        aria-label="Search (Ctrl or Command + K)"
        aria-keyshortcuts="Control+K Meta+K"
        className="mb-4 flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-3 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Search...</span>
        <PaletteShortcut />
      </button>
      <nav className="space-y-1" aria-label="Main">
        {allowedNav.map((item) => {
          const isActive = location === item.href || location.startsWith(`${item.href}/`);
          const isNotifications = item.href === "/notifications";
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              aria-label={isNotifications ? unreadLabel : undefined}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary text-primary-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">{item.name}</span>
              {isNotifications && <UnreadBadge count={unreadCount} />}
            </Link>
          );
        })}
      </nav>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openPalette()}
            aria-label="Search (Ctrl or Command + K)"
            aria-keyshortcuts="Control+K Meta+K"
            className="h-9 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <PaletteShortcut />
          </Button>
          <Button asChild variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground">
            <Link href="/notifications" aria-label={unreadLabel} title="Notifications">
              <Bell className="h-4 w-4" aria-hidden="true" />
              <UnreadBadge count={unreadCount} className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[10px]" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Log out" aria-label="Log out" className="text-muted-foreground hover:text-foreground">
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu" title="Menu">
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-4 bg-sidebar border-sidebar-border text-sidebar-foreground flex flex-col overflow-y-auto">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Main menu</SheetDescription>
              <div className="flex-1">
                <NavLinks onNavigate={() => setMobileOpen(false)} />
              </div>
              <div className="pt-4 mt-4 border-t border-sidebar-border">
                <UserInfo />
                <Button variant="ghost" className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" onClick={() => { setMobileOpen(false); handleLogout(); }}>
                  <LogOut className="h-4 w-4 mr-2" aria-hidden="true" />
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
            <LogOut className="h-4 w-4 mr-2" aria-hidden="true" />
            Logout
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 md:ml-64 flex flex-col min-h-0">
        {/* Bottom padding keeps the floating "Ask TaxAide" button from covering the end of the page. */}
        <main className="flex-1 min-w-0 p-4 pb-24 md:p-8 md:pb-24 overflow-y-auto">
          {children}
        </main>
      </div>

      <AssistantPanel />
      <CommandPalette open={paletteOpen} onOpenChange={onPaletteOpenChange} />
    </div>
  );
}
