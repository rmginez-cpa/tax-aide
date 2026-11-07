import express, { Router, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { BaseUrlError, MCP_PATH, canonicalResource, SCOPE_READ, SCOPE_WRITE, SUPPORTED_SCOPES, hostAllowed, mcpUrl, publicOrigin } from "../lib/mcp/config";
import { clientsStore, oauthProvider } from "../lib/mcp/oauthProvider";
import { buildMcpServer } from "../lib/mcp/server";
import { WRITE_TOOL_NAMES, canUseWriteTools, type AssistantUser } from "../lib/assistant/tools";

// The MCP connector's protocol endpoints: OAuth discovery documents, the OAuth 2.1
// authorization server (authorize / token / register / revoke) and the MCP endpoint.
// Mounted in app.ts BEFORE the cookie session, the global body parsers and nothing
// here reads or creates a session: MCP clients authenticate with bearer tokens only.
// The consent page's JSON endpoints, which do need the session, are in routes/oauth.ts.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireMcpToken: the verified access token. */
      auth?: AuthInfo;
    }
  }
}

interface TokenExtra {
  grantId: number;
  clientName: string | null;
  user: AssistantUser;
}

function originOf(res: Response): string {
  return res.locals.publicOrigin as string;
}

/** Host check (with PUBLIC_BASE_URL) and the public origin every URL below is built from. */
function connectorContext(req: Request, res: Response, next: NextFunction): void {
  if (!hostAllowed(req)) {
    res.status(403).json({ error: "invalid_request", error_description: "Host not allowed" });
    return;
  }
  try {
    res.locals.publicOrigin = publicOrigin(req);
  } catch (err) {
    if (err instanceof BaseUrlError) {
      res.status(400).json({ error: "invalid_request", error_description: err.message });
      return;
    }
    throw err;
  }
  next();
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "TaxAide",
    resource_documentation: `${origin}/`,
  };
}

/** RFC 8414 metadata. The issuer is the origin itself (no path), the form claude.ai handles best. */
function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [...SUPPORTED_SCOPES],
    service_documentation: `${origin}/`,
  };
}

function quoteParam(s: string): string {
  return s.replace(/["\\\r\n]/g, " ");
}

/** RFC 6750 / RFC 9728 challenge. Lists every scope, so clients ask for all and the user picks on the consent page. */
function bearerChallenge(origin: string, error?: { code: string; description: string }): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`, `scope="${SUPPORTED_SCOPES.join(" ")}"`];
  if (error) parts.unshift(`error="${error.code}"`, `error_description="${quoteParam(error.description)}"`);
  return `Bearer ${parts.join(", ")}`;
}

/**
 * Bearer-token check for /api/mcp. A missing or bad token gets a real HTTP 401 with the
 * resource_metadata pointer (the only thing that starts sign-in in claude.ai).
 */
async function requireMcpToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const origin = originOf(res);
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header) : null;
  if (!header) {
    res.set("WWW-Authenticate", bearerChallenge(origin));
    res.status(401).json({ error: "invalid_token", error_description: "Missing Authorization header" });
    return;
  }
  try {
    if (!match) throw new InvalidTokenError("Expected 'Authorization: Bearer <token>'");
    const info = await oauthProvider.verifyAccessToken(match[1]);
    if (!info.resource || canonicalResource(info.resource) !== canonicalResource(mcpUrl(origin))) throw new InvalidTokenError("The access token was not issued for this server");
    if (!info.scopes.includes(SCOPE_READ)) {
      res.set("WWW-Authenticate", bearerChallenge(origin, { code: "insufficient_scope", description: "This token cannot read TaxAide data" }));
      res.status(403).json({ error: "insufficient_scope", error_description: "This token cannot read TaxAide data" });
      return;
    }
    req.auth = info;
    next();
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      res.set("WWW-Authenticate", bearerChallenge(origin, { code: "invalid_token", description: err.message }));
      res.status(401).json({ error: "invalid_token", error_description: err.message });
      return;
    }
    next(err);
  }
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/** JSON-RPC messages in a POST body (a single message or, from older clients, a batch). */
function messagesOf(body: unknown): Array<{ method?: unknown; params?: { name?: unknown } }> {
  const list = Array.isArray(body) ? body : [body];
  return list.filter((m): m is { method?: unknown; params?: { name?: unknown } } => !!m && typeof m === "object");
}

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const auth = req.auth!;
  const extra = auth.extra as unknown as TokenExtra;
  const user = extra.user;
  const allowWrite = auth.scopes.includes(SCOPE_WRITE);

  // A staff user's write tool called on a read-only grant: ask the client to step up
  // (re-authorize with the write scope) instead of failing the call.
  if (!allowWrite && canUseWriteTools(user)) {
    const wantsWrite = messagesOf(req.body).some((m) => m.method === "tools/call" && WRITE_TOOL_NAMES.has(String(m.params?.name)));
    if (wantsWrite) {
      const description = "This tool needs the taxaide.write scope; reconnect and allow changes";
      res.set("WWW-Authenticate", bearerChallenge(originOf(res), { code: "insufficient_scope", description }));
      res.status(403).json({ error: "insufficient_scope", error_description: description });
      return;
    }
  }

  const server = buildMcpServer(user, {
    allowWrite,
    origin: originOf(res),
    via: { kind: "claude_connector", oauthClientId: auth.clientId, oauthClientName: extra.clientName, grantId: extra.grantId },
  });
  // Stateless: one server and one transport per request (MCP sessions are not used).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    req.log.error({ err }, "MCP request failed");
    if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
  }
}

/**
 * The SDK's authorize handler drops `state` (and dumps a raw zod error into error_description)
 * when the request itself fails validation. RFC 6749 §4.1.2.1 requires state on error
 * redirects too, so put it back and keep the description readable.
 */
function authorizeErrorRedirects(req: Request, res: Response, next: NextFunction): void {
  const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
  (res as { redirect: unknown }).redirect = (status: number, url: string) => {
    try {
      const u = new URL(url);
      if (u.searchParams.has("error")) {
        const params = (req.method === "POST" ? req.body : req.query) as Record<string, unknown> | undefined;
        const state = params?.state;
        if (typeof state === "string" && state && !u.searchParams.has("state")) u.searchParams.set("state", state);
        if (u.searchParams.get("error_description")?.trimStart().startsWith("[")) {
          u.searchParams.set("error_description", "Invalid authorization request: response_type=code, code_challenge and code_challenge_method=S256 are required");
        }
        url = u.href;
      }
    } catch {
      // not an absolute URL: leave it alone
    }
    redirect(status, url);
  };
  next();
}

// Rate limits per client IP (express-rate-limit, inside the SDK handlers). claude.ai
// reaches the server from a few shared Anthropic addresses for every user, so the
// limits are well above the SDK defaults; codes and tokens are 256-bit random anyway.
const FIFTEEN_MIN = 15 * 60 * 1000;
const authorizeEndpoint = authorizationHandler({ provider: oauthProvider, rateLimit: { windowMs: FIFTEEN_MIN, max: 300 } });
const tokenEndpoint = tokenHandler({ provider: oauthProvider, rateLimit: { windowMs: FIFTEEN_MIN, max: 1000 } });
const registerEndpoint = clientRegistrationHandler({
  clientsStore,
  // A secret that expired would silently break a connector that has no way to renew it.
  clientSecretExpirySeconds: 0,
  rateLimit: { windowMs: 60 * 60 * 1000, max: 200 },
});
const revokeEndpoint = revocationHandler({ provider: oauthProvider, rateLimit: { windowMs: FIFTEEN_MIN, max: 300 } });

/** The protocol router. app.ts mounts it only when MCP_ENABLED is on (otherwise every path is a 404). */
export function createMcpProtocolRouter(): Router {
  const router = Router();
  const metadataCors = cors({ origin: "*", methods: ["GET", "OPTIONS"] });

  const prm = (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata(originOf(res)));
  };
  const asm = (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(authorizationServerMetadata(originOf(res)));
  };
  // RFC 9728 path-inserted form first, then the root form claude.ai also probes, and one
  // under /api for hosts that route only /api to this server.
  for (const path of [`/.well-known/oauth-protected-resource${MCP_PATH}`, "/.well-known/oauth-protected-resource", "/api/.well-known/oauth-protected-resource"]) {
    router.options(path, metadataCors);
    router.get(path, metadataCors, connectorContext, prm);
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    router.options(path, metadataCors);
    router.get(path, metadataCors, connectorContext, asm);
  }

  // OAuth endpoints. The origin-root aliases cover a claude.ai fallback that ignores the
  // metadata and uses <origin>/authorize, /token and /register (anthropics/claude-ai-mcp#341).
  router.use(["/api/oauth/authorize", "/authorize"], connectorContext, authorizeErrorRedirects, authorizeEndpoint);
  router.use(["/api/oauth/token", "/token"], connectorContext, tokenEndpoint);
  router.use(["/api/oauth/register", "/register"], connectorContext, registerEndpoint);
  router.use("/api/oauth/revoke", connectorContext, revokeEndpoint);

  // The MCP endpoint (Streamable HTTP, stateless, JSON responses).
  const mcpCors = cors({
    origin: "*",
    methods: ["POST", "GET", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
    exposedHeaders: ["WWW-Authenticate", "Mcp-Protocol-Version", "Mcp-Session-Id"],
  });
  router.options(MCP_PATH, mcpCors);
  router.post(MCP_PATH, mcpCors, connectorContext, requireMcpToken, express.json({ limit: "128kb" }), handleMcpPost);
  // No server-initiated stream and no session to delete in a stateless server.
  router.all(MCP_PATH, mcpCors, (_req: Request, res: Response) => {
    res.set("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed.");
  });
  router.use(MCP_PATH, (err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") return jsonRpcError(res, 400, -32700, "Parse error");
    if (e?.status === 413) return jsonRpcError(res, 413, -32600, "Request body is too large");
    req.log.error({ err }, "MCP request failed");
    jsonRpcError(res, 500, -32603, "Internal server error");
  });
  return router;
}
