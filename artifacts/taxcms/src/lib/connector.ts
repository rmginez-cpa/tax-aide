// Shared bits of the Claude connector screens (pages/connect-authorize.tsx, pages/claude-connector.tsx).

import { ConnectorScopeName } from "@workspace/api-client-react";

export const SCOPE_READ = ConnectorScopeName.taxaideread;
export const SCOPE_WRITE = ConnectorScopeName.taxaidewrite;

/** Query-key prefix of GET /api/oauth/grants (with or without ?all=1), for invalidation. */
export const GRANTS_PREFIXES = ["/api/oauth/grants"] as const;

/** Short scope names for badges; the API sends the full titles and descriptions where it lists scopes. */
const SCOPE_BADGE: Record<string, string> = {
  [SCOPE_READ]: "View data",
  [SCOPE_WRITE]: "Limited changes",
};

export function scopeBadgeLabel(scope: string): string {
  return SCOPE_BADGE[scope] ?? scope;
}

/** What a write grant can never do, whatever the role (mirrors the tool list in api-server lib/assistant/tools.ts). */
export const CONNECTOR_NEVER = [
  "Approve, return or submit filing stages",
  "Delete anything",
  "Upload, download or open document files",
  "Create or change user accounts, roles or passwords",
] as const;

const CLAUDE_HOSTS = new Set(["claude.ai", "claude.com"]);

/** True when the redirect host is Claude's own web app (claude.ai / claude.com). */
export function isClaudeHost(host: string): boolean {
  return CLAUDE_HOSTS.has(host.toLowerCase());
}

/** True for a loopback host (a desktop app such as Claude Code), with or without a port. */
export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

/**
 * True when the page is shown inside a frame. The consent screen refuses to show its buttons
 * then, so another site cannot overlay it and trick a click (clickjacking). A cross-origin
 * parent makes window.top inaccessible in some browsers, which also counts as framed.
 */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/**
 * True when `redirectTo` (from the decision endpoint) goes to the request's registered redirect
 * URI: same scheme, host, port and path, with only the query (code/state or error) added. A
 * belt-and-braces check so a bug or tampered response can never send the browser elsewhere.
 */
export function isExpectedRedirect(redirectTo: string, redirectUri: string): boolean {
  try {
    const to = new URL(redirectTo);
    const registered = new URL(redirectUri);
    if (to.protocol !== "https:" && to.protocol !== "http:") return false;
    return to.origin === registered.origin && to.pathname === registered.pathname;
  } catch {
    return false;
  }
}
