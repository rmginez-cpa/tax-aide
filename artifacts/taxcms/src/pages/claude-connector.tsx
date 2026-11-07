// Claude connector settings: the MCP URL to paste into claude.ai, what Claude may do for this
// role, and the user's connected apps (super admins can also see and revoke everyone's).

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ListOAuthGrantsAll,
  useGetConnectorInfo,
  useListOAuthGrants,
  useRevokeOAuthGrant,
  type ConnectorInfo,
  type OAuthGrant,
} from "@workspace/api-client-react";
import { Ban, Check, Copy, Info, Plug, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { isClientRole, isSuperAdmin } from "@/lib/permissions";
import { roleBadgeClass, roleLabel } from "@/lib/status";
import { formatDate, formatDateTime } from "@/lib/format";
import { invalidatePrefixes } from "@/lib/queries";
import { CONNECTOR_NEVER, GRANTS_PREFIXES, SCOPE_READ, SCOPE_WRITE, scopeBadgeLabel } from "@/lib/connector";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function ClaudeConnector() {
  const { user } = useAuth();
  const info = useGetConnectorInfo();
  const superAdmin = isSuperAdmin(user?.role);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Claude Connector</h2>
        <p className="text-muted-foreground">
          Let Claude look up your TaxAide work for you in claude.ai. It signs in as you and sees only what you can see.
        </p>
      </div>

      {info.isLoading ? (
        <Card><CardContent className="space-y-3 p-6"><Skeleton className="h-5 w-1/3" /><Skeleton className="h-9 w-full" /><Skeleton className="h-24 w-full" /></CardContent></Card>
      ) : info.isError || !info.data ? (
        <ErrorState title="Could not load the connector settings" error={info.error} onRetry={info.refetch} />
      ) : (
        <>
          <SetupCard info={info.data} />
          <CapabilitiesCard info={info.data} role={user?.role ?? ""} />
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Connected apps</CardTitle>
          <CardDescription>
            Apps you have approved. Disconnecting one stops it at once; you can connect again later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {superAdmin ? (
            <Tabs defaultValue="mine">
              <TabsList className="mb-4">
                <TabsTrigger value="mine">My connections</TabsTrigger>
                <TabsTrigger value="all">All users</TabsTrigger>
              </TabsList>
              <TabsContent value="mine"><GrantList all={false} /></TabsContent>
              <TabsContent value="all"><GrantList all /></TabsContent>
            </Tabs>
          ) : (
            <GrantList all={false} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Copy text to the clipboard; falls back to selecting `fallbackInput` so the user can copy by hand. */
function useCopy() {
  const { toast } = useToast();
  return async (text: string, what: string, fallbackInput?: HTMLInputElement | null) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${what} copied` });
    } catch {
      fallbackInput?.focus();
      fallbackInput?.select();
      toast({ title: "Could not copy automatically", description: "The text is selected: press Ctrl+C (or Cmd+C) to copy it." });
    }
  };
}

function CopyField({ id, label, value, what }: { id: string; label: string; value: string; what: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const copy = useCopy();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="flex gap-2">
        <Input
          id={id}
          ref={ref}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs sm:text-sm"
        />
        <Button type="button" variant="outline" onClick={() => void copy(value, what, ref.current)} aria-label={`Copy ${what.toLowerCase()}`}>
          <Copy className="h-4 w-4 sm:mr-2" aria-hidden="true" />
          <span className="hidden sm:inline">Copy</span>
        </Button>
      </div>
    </div>
  );
}

function SetupCard({ info }: { info: ConnectorInfo }) {
  if (!info.enabled) {
    return (
      <Card>
        <CardContent className="flex gap-3 p-6 text-sm">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p>The Claude connector is turned off for this TaxAide site. Ask your administrator if you need it. Existing connections are listed below and can still be disconnected.</p>
        </CardContent>
      </Card>
    );
  }
  if (!info.mcpUrl) {
    return (
      <Card>
        <CardContent className="flex gap-3 p-6 text-sm">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium">The connector is not reachable yet.</p>
            <p className="text-muted-foreground">{info.problem ?? "TaxAide could not work out its public HTTPS address."} Ask your administrator to fix this.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2"><Plug className="h-5 w-5 text-primary" aria-hidden="true" /> Connect Claude</CardTitle>
        <CardDescription>Add TaxAide to claude.ai as a custom connector.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <CopyField id="mcp-url" label="Connector URL" value={info.mcpUrl} what="Connector URL" />
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>In claude.ai, open <strong>Settings</strong> (or <strong>Customize</strong>) &gt; <strong>Connectors</strong>, then choose <strong>Add custom connector</strong>.</li>
          <li>Name it <strong>TaxAide</strong> and paste the connector URL above. Leave the OAuth client ID and secret empty.</li>
          <li>Click <strong>Add</strong>, then <strong>Connect</strong>.</li>
          <li>A TaxAide page opens. Check that it returns you to <strong>claude.ai</strong>, choose what to allow, and click <strong>Approve</strong>.</li>
        </ol>
        <p className="text-sm text-muted-foreground">
          On a Team or Enterprise plan, an Owner adds the connector once under Organization settings &gt; Connectors; each member then clicks Connect and approves it here.
        </p>
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Using Claude Code instead?</summary>
          <div className="mt-3 space-y-2">
            <CopyField id="mcp-cli" label="Run this command, then sign in when asked" value={`claude mcp add --transport http taxaide ${info.mcpUrl}`} what="Command" />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function CapabilitiesCard({ info, role }: { info: ConnectorInfo; role: string }) {
  const read = info.scopes.find(s => s.name === SCOPE_READ);
  const write = info.scopes.find(s => s.name === SCOPE_WRITE);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What Claude can do for you</CardTitle>
        <CardDescription>
          Your role is <Badge variant="outline" className={`align-middle text-xs ${roleBadgeClass(role)}`}>{roleLabel(role)}</Badge>.{" "}
          {isClientRole(role) ? "Claude sees only your own company's records." : "Claude sees the clients and filings your account can see."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Can</h3>
          <ul className="space-y-3 text-sm">
            {read && (
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                <span><span className="font-medium">{read.title}.</span> {read.description}</span>
              </li>
            )}
            {write?.available && (
              <li className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                <span>
                  <span className="font-medium">{write.title}</span> (only if you allow it when connecting). {write.description}
                </span>
              </li>
            )}
          </ul>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Cannot</h3>
          <ul className="space-y-2 text-sm">
            {write && !write.available && (
              <li className="flex gap-2">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                <span>Make any changes: {roleLabel(role)} connections are read-only.</span>
              </li>
            )}
            {CONNECTOR_NEVER.map(item => (
              <li key={item} className="flex gap-2">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function GrantList({ all }: { all: boolean }) {
  const params = all ? { all: ListOAuthGrantsAll.NUMBER_1 } : undefined;
  const grants = useListOAuthGrants(params);
  const revoke = useRevokeOAuthGrant();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();

  if (grants.isLoading) {
    return <div className="space-y-2" aria-busy="true"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  }
  if (grants.isError) {
    return <ErrorState compact title="Could not load connected apps" error={grants.error} onRetry={grants.refetch} />;
  }
  const list = grants.data ?? [];
  if (list.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {all ? "No one has connected an app yet." : "You have not connected any apps yet."}
      </div>
    );
  }

  const disconnect = async (g: OAuthGrant) => {
    const name = g.clientName?.trim() || g.redirectHost;
    const someoneElse = g.user.id !== user?.id;
    const ok = await confirm({
      title: `Disconnect ${name}?`,
      description: someoneElse
        ? `${g.user.name}'s connection stops working at once. They can connect again later.`
        : "It stops working at once. You can connect again later from claude.ai.",
      confirmLabel: "Disconnect",
      destructive: true,
      onConfirm: () => revoke.mutateAsync({ id: g.id }),
    });
    if (!ok) return;
    toast({ title: `${name} disconnected` });
    await invalidatePrefixes(queryClient, GRANTS_PREFIXES);
  };

  return (
    <ul className="divide-y rounded-lg border" aria-label={all ? "All connected apps" : "Your connected apps"}>
      {list.map(g => (
        <GrantRow key={g.id} grant={g} showUser={all} onDisconnect={() => void disconnect(g)} />
      ))}
    </ul>
  );
}

function GrantRow({ grant: g, showUser, onDisconnect }: { grant: OAuthGrant; showUser: boolean; onDisconnect: () => void }) {
  const name = g.clientName?.trim() || "Unnamed app";
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between" data-testid="grant-row">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-words">{name}</span>
          <span className="text-sm text-muted-foreground break-all">{g.redirectHost}</span>
        </div>
        {showUser && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{g.user.name}</span>
            <span className="text-muted-foreground break-all">{g.user.email}</span>
            <Badge variant="outline" className={`text-xs ${roleBadgeClass(g.user.role)}`}>{roleLabel(g.user.role)}</Badge>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {g.scopes.map(s => (
            <Badge key={s} variant="secondary" className="text-xs font-normal">{scopeBadgeLabel(s)}</Badge>
          ))}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <dt>Connected</dt><dd>{formatDate(g.createdAt)}</dd>
          <dt>Last used</dt><dd>{g.lastUsedAt ? formatDateTime(g.lastUsedAt) : "Not yet"}</dd>
          <dt>Lapses</dt><dd>{formatDate(g.expiresAt)} if unused</dd>
        </dl>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onDisconnect}
        className="shrink-0 self-start text-destructive hover:text-destructive"
        aria-label={`Disconnect ${name}${showUser ? ` for ${g.user.name}` : ""}`}
      >
        <Ban className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Disconnect
      </Button>
    </li>
  );
}
