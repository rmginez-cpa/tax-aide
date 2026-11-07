import { Switch, Route, Router as WouterRouter, Redirect, useLocation, useSearch } from "wouter";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import NotFound from "@/pages/not-found";
import { AuthProvider, useAuth, getCachedUser, clearCachedUser } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { AssistantProvider } from "@/lib/assistant";
import { roleMatches } from "@/lib/permissions";
import { BASE_PATH, errorStatus, setUnauthorizedHandler } from "@/lib/api";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { loginHref } from "@/lib/return-to";

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
import ConnectAuthorize from "@/pages/connect-authorize";
import ClaudeConnector from "@/pages/claude-connector";

/**
 * Any 401 from the API while we believe a user is signed in means the session expired:
 * forget the cached user (routing then sends them to /login) and say so once. When no user
 * is cached (first load, the login form itself) a 401 is expected and ignored, so the login
 * page never loops.
 */
function handleUnauthorized(error: unknown) {
  if (errorStatus(error) !== 401) return;
  if (!getCachedUser(queryClient)) return;
  clearCachedUser(queryClient);
  toast({
    title: "Your session expired - please sign in again",
    variant: "destructive",
  });
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    }
  }
});

// apiFetch() calls made outside react-query (downloads, uploads) report 401s here too.
setUnauthorizedHandler(handleUnauthorized);

function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center text-muted-foreground">{children}</div>;
}

/** /login?next=<the current page>, so signing in (or back in after the session expired) returns here. */
function useLoginRedirect(): string {
  const [location] = useLocation();
  const search = useSearch();
  return loginHref(search ? `${location}?${search}` : location);
}

function ProtectedRoute({ component: Component, roles }: { component: React.ComponentType; roles?: string[] }) {
  const { user, isLoading } = useAuth();
  const loginTo = useLoginRedirect();

  if (isLoading) return <FullScreenMessage>Loading...</FullScreenMessage>;
  if (!user) return <Redirect to={loginTo} />;
  if (roles && !roleMatches(user.role, roles)) return <Redirect to="/dashboard" />;

  return <Component />;
}

const STAFF = ["accountant", "maker", "manager"];
const MANAGERS = ["manager", "super_admin"];

/** Every signed-in page. Rendered inside one <Layout>, so the shell (sidebar, assistant panel) survives navigation. */
function ProtectedRoutes() {
  const { user } = useAuth();
  return (
    <Switch>
      <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
      <Route path="/clients"><ProtectedRoute component={Clients} roles={STAFF} /></Route>
      <Route path="/clients/:id"><ProtectedRoute component={ClientDetail} roles={STAFF} /></Route>
      <Route path="/engagements"><ProtectedRoute component={Engagements} /></Route>
      <Route path="/engagements/:id"><ProtectedRoute component={EngagementDetail} /></Route>
      <Route path="/deadlines"><ProtectedRoute component={Deadlines} roles={STAFF} /></Route>
      <Route path="/calendar"><ProtectedRoute component={CalendarPage} roles={STAFF} /></Route>
      <Route path="/documents"><ProtectedRoute component={Documents} /></Route>
      <Route path="/users"><ProtectedRoute component={Users} roles={MANAGERS} /></Route>
      <Route path="/account-management"><ProtectedRoute component={AccountManagement} roles={["super_admin"]} /></Route>
      <Route path="/notifications"><ProtectedRoute component={Notifications} /></Route>
      <Route path="/audit-log"><ProtectedRoute component={AuditLog} roles={MANAGERS} /></Route>
      <Route path="/settings/claude"><ProtectedRoute component={ClaudeConnector} /></Route>
      {/* Unknown paths: in-app 404 for signed-in users, standalone 404 otherwise (Layout renders no shell without a user). */}
      <Route><NotFound signedIn={!!user} /></Route>
    </Switch>
  );
}

function AppRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <FullScreenMessage>Loading application...</FullScreenMessage>;
  }

  return (
    <Switch>
      <Route path="/">
        {user ? <Redirect to="/dashboard" /> : <Redirect to="/login" />}
      </Route>
      <Route path="/login" component={Login} />
      {/* The Claude connector's OAuth consent screen: standalone (no app shell), handles signed-out itself. */}
      <Route path="/connect/authorize" component={ConnectAuthorize} />
      <Route>
        <Layout>
          <ProtectedRoutes />
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ConfirmProvider>
          <AuthProvider>
            <WouterRouter base={BASE_PATH}>
              <AssistantProvider>
                <AppRoutes />
              </AssistantProvider>
            </WouterRouter>
          </AuthProvider>
        </ConfirmProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
