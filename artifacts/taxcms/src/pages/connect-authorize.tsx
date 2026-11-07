// OAuth consent screen for the Claude connector. The API's /api/oauth/authorize redirects the
// browser here with ?request=<id>; the user approves or denies and is sent back to the app's
// registered redirect URI (claude.ai's callback). Standalone like the login page: no app shell.

import { useEffect, useState, type ReactNode } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";
import {
  getGetOAuthRequestQueryKey,
  useDecideOAuthRequest,
  useGetOAuthRequest,
  useLogout,
  type ConnectorScope,
  type OAuthRequest,
  type User,
} from "@workspace/api-client-react";
import { AlertTriangle, Check, Clock, Loader2, Plug, ShieldAlert, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { errorMessage, errorStatus } from "@/lib/api";
import { loginHref } from "@/lib/return-to";
import { roleBadgeClass, roleLabel } from "@/lib/status";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  isClaudeHost,
  isExpectedRedirect,
  isFramed,
  isLoopbackHost,
} from "@/lib/connector";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

/** The server issues base64url ids of about 32 characters; anything else is a mangled link. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

const EXPIRED_TEXT =
  "This sign-in request has expired or was already used. Start connecting again from the app you were using.";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col justify-center px-4 py-10 sm:px-6">
      <main className="mx-auto w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2 text-primary">
          <div className="h-10 w-10 bg-primary rounded-xl flex items-center justify-center shadow-lg shadow-primary/20">
            <Plug className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <span className="text-xl font-bold text-foreground">TaxAide</span>
        </div>
        {children}
      </main>
    </div>
  );
}

/** A terminal state (expired, framed, broken link...) with nothing to decide. */
function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="shadow-xl shadow-slate-200/50 dark:shadow-none">
      <CardHeader className="items-center text-center">
        <div className="mb-2 h-12 w-12 rounded-full bg-muted flex items-center justify-center">{icon}</div>
        <h1 className="font-semibold tracking-tight text-xl">{title}</h1>
      </CardHeader>
      <CardContent className="space-y-3 text-center text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

/** Milliseconds left until `expiresAt`, re-evaluated every few seconds. */
function useRemaining(expiresAt: string | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  return Number.isFinite(end) ? end - now : null;
}

export default function ConnectAuthorize() {
  const [framed] = useState(isFramed);
  const { user, isLoading } = useAuth();
  const [location] = useLocation();
  const search = useSearch();
  const requestId = new URLSearchParams(search).get("request") ?? "";

  if (framed) {
    return (
      <Shell>
        <Notice icon={<ShieldAlert className="h-6 w-6 text-destructive" aria-hidden="true" />} title="Open this page directly">
          <p>
            For your security, TaxAide does not show connection requests inside another website.
            Open it in its own tab to continue.
          </p>
          <Button asChild>
            <a href={window.location.href} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
          </Button>
        </Notice>
      </Shell>
    );
  }

  if (isLoading) {
    return <Shell><p className="text-center text-muted-foreground" role="status">Loading...</p></Shell>;
  }

  // Signed out: log in, then come back to exactly this URL (the request id is in the query).
  if (!user) return <Redirect to={loginHref(search ? `${location}?${search}` : location)} replace />;

  if (!REQUEST_ID_RE.test(requestId)) {
    return (
      <Shell>
        <Notice icon={<AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden="true" />} title="This link is incomplete">
          <p>The connection request is missing or damaged. Start connecting again from the app you were using.</p>
          <Button asChild variant="outline"><Link href="/dashboard">Go to TaxAide</Link></Button>
        </Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Keyed so signing in as someone else starts from a fresh request lookup. */}
      <Consent key={`${user.id}:${requestId}`} requestId={requestId} user={user} />
    </Shell>
  );
}

function Consent({ requestId, user }: { requestId: string; user: User }) {
  const id = encodeURIComponent(requestId);
  const request = useGetOAuthRequest(id, {
    query: {
      queryKey: getGetOAuthRequestQueryKey(id),
      retry: false,
      staleTime: Infinity,
      // Single use: never show a cached copy of a request that may already be decided.
      gcTime: 0,
    },
  });

  if (request.isLoading) {
    return (
      <Card aria-busy="true">
        <CardHeader><Skeleton className="h-6 w-3/4" /><Skeleton className="h-4 w-1/2" /></CardHeader>
        <CardContent className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></CardContent>
        <span className="sr-only" role="status">Loading the connection request...</span>
      </Card>
    );
  }

  if (request.isError || !request.data) {
    const status = errorStatus(request.error);
    // 401 is handled globally: the cached user is cleared and the page redirects to login.
    if (status === 404) return <ExpiredNotice />;
    return (
      <Notice icon={<AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />} title="Could not load this request">
        <p>{errorMessage(request.error)}</p>
        <Button variant="outline" onClick={() => void request.refetch()}>Try again</Button>
      </Notice>
    );
  }

  return <ConsentForm request={request.data} user={user} />;
}

function ExpiredNotice() {
  return (
    <Notice icon={<Clock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />} title="Request expired">
      <p>{EXPIRED_TEXT}</p>
      <Button asChild variant="outline"><Link href="/dashboard">Go to TaxAide</Link></Button>
    </Notice>
  );
}

function ConsentForm({ request, user }: { request: OAuthRequest; user: User }) {
  const { logout: clearAuth } = useAuth();
  const logoutMutation = useLogout();
  const decide = useDecideOAuthRequest();
  const remaining = useRemaining(request.expiresAt);
  const [writeChecked, setWriteChecked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [leaving, setLeaving] = useState<"approve" | "deny" | null>(null);

  const read = request.scopes.find(s => s.name === SCOPE_READ);
  const write = request.scopes.find(s => s.name === SCOPE_WRITE);
  const canWrite = !!write?.available;
  const host = request.redirectHost;
  const toClaude = isClaudeHost(host);
  const local = isLoopbackHost(host);
  const expired = remaining !== null && remaining <= 0;
  const busy = decide.isPending || leaving !== null || logoutMutation.isPending;

  if (gone || expired) return <ExpiredNotice />;

  const submit = (approve: boolean) => {
    setError(null);
    const scopes = [SCOPE_READ, ...(canWrite && writeChecked ? [SCOPE_WRITE] : [])];
    decide.mutate(
      { id: encodeURIComponent(request.id), data: approve ? { approve, scopes } : { approve } },
      {
        onSuccess: (res) => {
          if (!isExpectedRedirect(res.redirectTo, request.redirectUri)) {
            setError("TaxAide received an unexpected return address, so it did not send you there. Start connecting again.");
            return;
          }
          setLeaving(approve ? "approve" : "deny");
          // A full navigation of this (top-level) window: the redirect leaves the SPA.
          window.location.assign(res.redirectTo);
        },
        onError: (err) => {
          if (errorStatus(err) === 404) setGone(true);
          else if (errorStatus(err) !== 401) setError(errorMessage(err));
        },
      },
    );
  };

  const signOut = () => {
    // After sign-out this page sends the user to /login and back here with the same request.
    logoutMutation.mutate(undefined, { onSuccess: () => clearAuth() });
  };

  const clientName = request.client.name?.trim() || "Unnamed app";
  const minutesLeft = remaining === null ? null : Math.max(1, Math.ceil(remaining / 60_000));

  return (
    <Card className="shadow-xl shadow-slate-200/50 dark:shadow-none">
      <CardHeader className="space-y-2">
        <h1 className="font-semibold tracking-tight text-xl leading-snug">
          {toClaude ? "Claude wants to access your TaxAide account" : "An app wants to access your TaxAide account"}
        </h1>
        <CardDescription>
          It will act as you and see only what your account can see.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <dl className="space-y-3 rounded-lg border bg-muted/40 p-3 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">You will be returned to</dt>
            <dd className="mt-0.5 break-all text-base font-semibold" data-testid="redirect-host">{host}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">App name</dt>
            <dd className="mt-0.5 break-words">
              <span data-testid="client-name">{clientName}</span>{" "}
              <span className="text-xs text-muted-foreground">(as the app describes itself; not verified by TaxAide)</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connect as</dt>
            <dd className="mt-0.5 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{user.name}</span>
                <Badge variant="outline" className={`text-xs ${roleBadgeClass(user.role)}`}>{roleLabel(user.role)}</Badge>
              </div>
              <div className="break-all text-muted-foreground">{user.email}</div>
              <button
                type="button"
                onClick={signOut}
                disabled={busy}
                className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm disabled:opacity-50"
              >
                Not you? Sign out
              </button>
            </dd>
          </div>
        </dl>

        {!toClaude && (
          <div role="note" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              {local
                ? "This app runs on your own computer (for example Claude Code). Continue only if you started this connection yourself."
                : "This app does not return to claude.ai. Continue only if you started this connection yourself and trust it."}
            </p>
          </div>
        )}

        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">It is asking to</legend>
          {read && <ReadScope scope={read} />}
          {write && (canWrite
            ? <WriteScope scope={write} checked={writeChecked} onChange={setWriteChecked} disabled={busy} />
            : <UnavailableScope scope={write} role={user.role} />)}
        </fieldset>

        <p className="text-xs text-muted-foreground">
          You can disconnect it at any time under Claude Connector in TaxAide.
          {minutesLeft !== null && <> This request expires in about {minutesLeft} minute{minutesLeft === 1 ? "" : "s"}.</>}
        </p>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {leaving && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Returning you to {host}...
          </p>
        )}
      </CardContent>

      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" className="w-full sm:w-auto" onClick={() => submit(false)} disabled={busy}>
          {decide.isPending && decide.variables?.data.approve === false && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          Deny
        </Button>
        <Button className="w-full sm:w-auto" onClick={() => submit(true)} disabled={busy}>
          {decide.isPending && decide.variables?.data.approve === true && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          Approve
        </Button>
      </CardFooter>
    </Card>
  );
}

function ReadScope({ scope }: { scope: ConnectorScope }) {
  return (
    <div className="flex gap-3 rounded-md border p-3">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{scope.title} <span className="font-normal text-muted-foreground">(required)</span></p>
        <p className="text-sm text-muted-foreground">{scope.description}</p>
      </div>
    </div>
  );
}

function WriteScope({ scope, checked, onChange, disabled }: {
  scope: ConnectorScope; checked: boolean; onChange: (v: boolean) => void; disabled: boolean;
}) {
  return (
    <div className="flex gap-3 rounded-md border p-3">
      <Checkbox
        id="scope-write"
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        aria-describedby="scope-write-desc"
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <label htmlFor="scope-write" className="text-sm font-medium cursor-pointer">
          {scope.title} <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <p id="scope-write-desc" className="text-sm text-muted-foreground">
          {scope.description} Changes are recorded in the audit log as made by you via the Claude connector.
          Leave this unticked for a read-only connection.
        </p>
      </div>
    </div>
  );
}

function UnavailableScope({ scope, role }: { scope: ConnectorScope; role: string }) {
  return (
    <div className="flex gap-3 rounded-md border border-dashed p-3 text-muted-foreground" data-testid="scope-write-unavailable">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{scope.title}: not available</p>
        <p className="text-sm">
          {roleLabel(role)} accounts cannot make changes through the connector, so this will not be granted.
          The connection will be read-only.
        </p>
      </div>
    </div>
  );
}
