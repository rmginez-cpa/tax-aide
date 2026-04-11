import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";

// Pages
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Clients from "@/pages/clients";
import ClientDetail from "@/pages/client-detail";
import Engagements from "@/pages/engagements";
import EngagementDetail from "@/pages/engagement-detail";
import Deadlines from "@/pages/deadlines";
import Documents from "@/pages/documents";
import Users from "@/pages/users";
import Notifications from "@/pages/notifications";
import AuditLog from "@/pages/audit-log";
import CalendarPage from "@/pages/calendar";
import AccountManagement from "@/pages/account-management";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    }
  }
});

// Expand roles to handle equivalent roles
function roleMatches(userRole: string, allowedRoles: string[]): boolean {
  if (!userRole) return false;
  // super_admin bypasses all restrictions
  if (userRole === "super_admin") return true;
  // maker is equivalent to accountant
  const expanded = new Set(allowedRoles);
  if (expanded.has("accountant")) expanded.add("maker");
  if (expanded.has("maker")) expanded.add("accountant");
  // viewer can access anything client can
  if (expanded.has("client")) expanded.add("viewer");
  if (expanded.has("viewer")) expanded.add("client");
  return expanded.has(userRole);
}

function ProtectedRoute({ component: Component, roles }: { component: React.ComponentType; roles?: string[] }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading...</div>;
  if (!user) return <Redirect to="/login" />;
  if (roles && !roleMatches(user.role, roles)) return <Redirect to="/dashboard" />;

  return <Component />;
}

function AppRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading application...</div>;
  }

  return (
    <Switch>
      <Route path="/">
        {user ? <Redirect to="/dashboard" /> : <Redirect to="/login" />}
      </Route>
      <Route path="/login" component={Login} />

      <Route path="/dashboard">
        <Layout><ProtectedRoute component={Dashboard} /></Layout>
      </Route>

      <Route path="/clients">
        <Layout><ProtectedRoute component={Clients} roles={["accountant", "maker", "manager"]} /></Layout>
      </Route>

      <Route path="/clients/:id">
        <Layout><ProtectedRoute component={ClientDetail} roles={["accountant", "maker", "manager"]} /></Layout>
      </Route>

      <Route path="/engagements">
        <Layout><ProtectedRoute component={Engagements} /></Layout>
      </Route>

      <Route path="/engagements/:id">
        <Layout><ProtectedRoute component={EngagementDetail} /></Layout>
      </Route>

      <Route path="/deadlines">
        <Layout><ProtectedRoute component={Deadlines} roles={["accountant", "maker", "manager"]} /></Layout>
      </Route>

      <Route path="/calendar">
        <Layout><ProtectedRoute component={CalendarPage} roles={["accountant", "maker", "manager"]} /></Layout>
      </Route>

      <Route path="/documents">
        <Layout><ProtectedRoute component={Documents} /></Layout>
      </Route>

      <Route path="/users">
        <Layout><ProtectedRoute component={Users} roles={["manager", "super_admin"]} /></Layout>
      </Route>

      <Route path="/account-management">
        <Layout><ProtectedRoute component={AccountManagement} roles={["super_admin"]} /></Layout>
      </Route>

      <Route path="/notifications">
        <Layout><ProtectedRoute component={Notifications} /></Layout>
      </Route>

      <Route path="/audit-log">
        <Layout><ProtectedRoute component={AuditLog} roles={["manager", "super_admin"]} /></Layout>
      </Route>

      <Route>
        {user ? <Layout><NotFound /></Layout> : <NotFound />}
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRoutes />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
