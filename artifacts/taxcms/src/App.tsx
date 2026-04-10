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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    }
  }
});

function ProtectedRoute({ component: Component, roles }: { component: React.ComponentType; roles?: string[] }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading...</div>;
  if (!user) return <Redirect to="/login" />;
  if (roles && !roles.includes(user.role)) return <Redirect to="/dashboard" />;

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
        <Layout><ProtectedRoute component={Clients} roles={["accountant", "manager"]} /></Layout>
      </Route>

      <Route path="/clients/:id">
        <Layout><ProtectedRoute component={ClientDetail} roles={["accountant", "manager"]} /></Layout>
      </Route>

      <Route path="/engagements">
        <Layout><ProtectedRoute component={Engagements} /></Layout>
      </Route>

      <Route path="/engagements/:id">
        <Layout><ProtectedRoute component={EngagementDetail} /></Layout>
      </Route>

      <Route path="/deadlines">
        <Layout><ProtectedRoute component={Deadlines} roles={["accountant", "manager"]} /></Layout>
      </Route>

      <Route path="/documents">
        <Layout><ProtectedRoute component={Documents} /></Layout>
      </Route>

      <Route path="/users">
        <Layout><ProtectedRoute component={Users} roles={["manager"]} /></Layout>
      </Route>

      <Route path="/notifications">
        <Layout><ProtectedRoute component={Notifications} /></Layout>
      </Route>

      <Route path="/audit-log">
        <Layout><ProtectedRoute component={AuditLog} roles={["manager"]} /></Layout>
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
