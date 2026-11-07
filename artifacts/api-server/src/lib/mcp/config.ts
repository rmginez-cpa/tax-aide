import type { Request } from "express";
import { ConfigError, isProduction } from "../security";

/**
 * Configuration of the remote MCP connector (claude.ai custom connector) and of the
 * OAuth 2.1 authorization server that protects it. See replit.md,
 * "Connecting Claude (claude.ai custom connector)".
 *
 *   MCP_ENABLED                 default on; "false"/"0" turns /api/mcp, /api/oauth/* and the
 *                               /.well-known OAuth documents off (they answer 404)
 *   PUBLIC_BASE_URL             e.g. https://taxaide.example.com. When unset the base URL is
 *                               derived from each request (Host / X-Forwarded-* per TRUST_PROXY)
 *   MCP_ALLOWED_REDIRECT_URIS   comma-separated OAuth redirect URIs clients may register
 *   MCP_ALLOW_INSECURE_HTTP     "true" allows an http:// base URL in production (never do this
 *                               on the public internet)
 */

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return undefined;
}

export function mcpEnabled(): boolean {
  return envFlag("MCP_ENABLED") ?? true;
}

function insecureHttpAllowed(): boolean {
  return envFlag("MCP_ALLOW_INSECURE_HTTP") ?? false;
}

// ── Scopes ───────────────────────────────────────────────────────────────────
export const SCOPE_READ = "taxaide.read";
export const SCOPE_WRITE = "taxaide.write";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

export const SCOPE_INFO: Record<string, { title: string; description: string }> = {
  [SCOPE_READ]: {
    title: "View your TaxAide data",
    description:
      "Look up clients, compliance checklists, deadlines, filings, checklists, comments and document names that your account can see.",
  },
  [SCOPE_WRITE]: {
    title: "Make limited changes",
    description:
      "Add comments to filings, update deadline notes and update checklist items, as you. It cannot approve or return stages, delete anything, handle files or change accounts. Staff accounts only.",
  },
};

// ── Lifetimes ────────────────────────────────────────────────────────────────
export const AUTH_REQUEST_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

/** The SPA page that shows the consent screen (built by the frontend). */
export const CONSENT_PAGE_PATH = "/connect/authorize";
export const MCP_PATH = "/api/mcp";

// ── Public base URL ──────────────────────────────────────────────────────────

function parseConfiguredBase(): URL | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("PUBLIC_BASE_URL must be an https:// URL");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError("PUBLIC_BASE_URL must be an origin only, e.g. https://taxaide.example.com (no path, query or credentials)");
  }
  if (url.protocol === "http:" && isProduction() && !insecureHttpAllowed()) {
    throw new ConfigError("PUBLIC_BASE_URL must use https:// in production (or set MCP_ALLOW_INSECURE_HTTP=true)");
  }
  return url;
}

let configuredBase: URL | null | undefined;

/** Reads and checks PUBLIC_BASE_URL once. Throws ConfigError on a bad value. */
export function configuredBaseUrl(): URL | null {
  if (configuredBase === undefined) configuredBase = parseConfiguredBase();
  return configuredBase;
}

export class BaseUrlError extends Error {}

/**
 * The public origin (scheme://host[:port], no trailing slash) the MCP client and the
 * user's browser see: PUBLIC_BASE_URL, or the request's own origin (req.protocol / req.host
 * honour X-Forwarded-Proto / X-Forwarded-Host only when trust proxy is on).
 */
export function publicOrigin(req: Request): string {
  const configured = configuredBaseUrl();
  if (configured) return configured.origin;
  const host = req.host;
  if (!host || !/^[a-z0-9.\-[\]:]+$/i.test(host)) throw new BaseUrlError("Missing or invalid Host header");
  const origin = `${req.protocol}://${host}`.toLowerCase();
  if (req.protocol !== "https" && isProduction() && !insecureHttpAllowed()) {
    throw new BaseUrlError(
      "The connector needs HTTPS. Serve TaxAide over https (with TRUST_PROXY behind a TLS proxy) or set PUBLIC_BASE_URL.",
    );
  }
  return origin;
}

/**
 * With PUBLIC_BASE_URL set, requests for the connector must name that host (DNS-rebinding /
 * Host-header protection). Without it every host is accepted and URLs are derived from it.
 */
export function hostAllowed(req: Request): boolean {
  const configured = configuredBaseUrl();
  if (!configured) return true;
  return (req.host ?? "").toLowerCase() === configured.host.toLowerCase();
}

export function mcpUrl(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

/** RFC 8707 resource comparison form: lower-case scheme and host, no default port, fragment or trailing slash. */
export function canonicalResource(value: string | URL): string | null {
  let u: URL;
  try {
    u = new URL(String(value));
  } catch {
    return null;
  }
  // URL already lower-cases scheme and host and drops a default port.
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

// ── Redirect URI allow-list ──────────────────────────────────────────────────

const DEFAULT_REDIRECT_URIS = [
  // claude.ai, Claude Desktop, Claude mobile and Cowork (brokered through claude.ai).
  "https://claude.ai/api/mcp/auth_callback",
  // Announced as a possible future callback host; harmless to allow.
  "https://claude.com/api/mcp/auth_callback",
  // Native / CLI clients (Claude Code, MCP Inspector): loopback, any port, any path.
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface RedirectRule {
  raw: string;
  url: URL;
  loopback: boolean;
  anyPath: boolean;
}

function parseRules(): RedirectRule[] {
  const raw = process.env.MCP_ALLOWED_REDIRECT_URIS?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_REDIRECT_URIS;
  const rules: RedirectRule[] = [];
  for (const entry of list) {
    const anyPath = entry.endsWith("/*");
    let url: URL;
    try {
      url = new URL(anyPath ? entry.slice(0, -1) : entry);
    } catch {
      throw new ConfigError(`MCP_ALLOWED_REDIRECT_URIS has an invalid URL: "${entry}"`);
    }
    const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
      throw new ConfigError(`MCP_ALLOWED_REDIRECT_URIS entries must be https:// or http:// loopback: "${entry}"`);
    }
    if (url.hash) throw new ConfigError(`MCP_ALLOWED_REDIRECT_URIS entries must not have a fragment: "${entry}"`);
    if (anyPath && !loopback) throw new ConfigError(`Only loopback entries may end in /*: "${entry}"`);
    rules.push({ raw: entry, url, loopback, anyPath });
  }
  return rules;
}

let rules: RedirectRule[] | undefined;
export function redirectRules(): RedirectRule[] {
  rules ??= parseRules();
  return rules;
}

/**
 * Whether a client may use `uri` as a redirect URI: exact match for https entries;
 * loopback entries match any port (RFC 8252 §7.3) and, with a trailing "/*", any path.
 */
export function redirectUriAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  return redirectRules().some((r) => {
    if (!r.loopback) return uri === r.raw;
    if (u.protocol !== "http:" || u.hostname !== r.url.hostname) return false;
    return r.anyPath ? true : u.pathname === r.url.pathname && u.search === r.url.search;
  });
}
