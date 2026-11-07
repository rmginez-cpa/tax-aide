import { Router, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, usersTable, oauthClientsTable, oauthGrantsTable } from "@workspace/db";
import { requireAuth, isStaffRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { allowedOrigins } from "../lib/security";
import {
  BaseUrlError,
  SCOPE_INFO,
  SCOPE_READ,
  SCOPE_WRITE,
  SUPPORTED_SCOPES,
  configuredBaseUrl,
  connectorOriginProblem,
  mcpEnabled,
  mcpUrl,
  publicOrigin,
} from "../lib/mcp/config";
import { decideRequest, loadPendingRequest, revokeGrant } from "../lib/mcp/oauthProvider";

// Session-authenticated JSON endpoints for the connector pages of the web app:
// the consent screen (/connect/authorize) and the connected-apps list.
// CONTRACT: the shapes below are what the frontend codes against (see openapi.yaml, tag "connector").

const router = Router();

/** Scopes the user's role can use: client accounts read only (every write tool wraps a staff-only route). */
function usableScopes(role: string): string[] {
  return isStaffRole(role) ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
}

function scopeList(names: readonly string[], role: string) {
  const usable = usableScopes(role);
  return names.map((name) => ({ name, ...SCOPE_INFO[name], available: usable.includes(name) }));
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function originOrNull(req: Request): { origin: string | null; problem: string | null } {
  try {
    const origin = publicOrigin(req);
    const problem = connectorOriginProblem(req, origin);
    return problem ? { origin: null, problem } : { origin, problem: null };
  } catch (err) {
    if (err instanceof BaseUrlError) return { origin: null, problem: err.message };
    throw err;
  }
}

/**
 * CSRF guard for the state-changing endpoints: the browser's Origin must be this site's
 * (or one listed in ALLOWED_ORIGINS). Together with the SameSite=Lax session cookie and,
 * for POST, a required JSON body (which a cross-site form cannot send), a third-party
 * page cannot approve a connector or revoke one on the user's behalf.
 */
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin")?.trim().replace(/\/+$/, "").toLowerCase();
  // The same origin the connector advertises, so the guard and the consent URLs never disagree.
  const allowed = new Set([`${req.protocol}://${req.host}`.toLowerCase(), ...allowedOrigins()]);
  try {
    allowed.add(publicOrigin(req));
  } catch (err) {
    if (!(err instanceof BaseUrlError)) throw err;
  }
  const configured = configuredBaseUrl();
  if (configured) allowed.add(configured.origin);
  if (!origin || !allowed.has(origin)) {
    res.status(403).json({ error: "This request must come from the TaxAide web app" });
    return;
  }
  next();
}

function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "Send the request as application/json" });
    return;
  }
  next();
}

function requireMcpEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!mcpEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

async function currentUser(req: Request) {
  const [user] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));
  return user ?? null;
}

// ── GET /api/oauth/connector ─────────────────────────────────────────────────
// { enabled, mcpUrl, issuer, problem, scopes[] }: what the connected-apps page shows
// ("add this URL in claude.ai"). mcpUrl is null when disabled or misconfigured (problem says why).
router.get("/oauth/connector", requireAuth, (req, res): void => {
  const role = req.session.userRole ?? "";
  if (!mcpEnabled()) {
    res.json({ enabled: false, mcpUrl: null, issuer: null, problem: null, scopes: scopeList(SUPPORTED_SCOPES, role) });
    return;
  }
  const { origin, problem } = originOrNull(req);
  res.json({ enabled: true, mcpUrl: origin ? mcpUrl(origin) : null, issuer: origin, problem, scopes: scopeList(SUPPORTED_SCOPES, role) });
});

// ── GET /api/oauth/requests/:id ──────────────────────────────────────────────
router.get("/oauth/requests/:id", requireMcpEnabled, requireAuth, async (req, res): Promise<void> => {
  const row = await loadPendingRequest(String(req.params.id));
  const user = await currentUser(req);
  if (!row || !user) {
    res.status(404).json({ error: "This sign-in request has expired or was already used. Start connecting again from the app you were using." });
    return;
  }
  const meta = row.client.metadata as { client_uri?: string; logo_uri?: string };
  res.json({
    id: row.request.id,
    expiresAt: row.request.expiresAt.toISOString(),
    client: {
      id: row.client.clientId,
      // Chosen by whoever registered the client: show redirectHost as the trustworthy part.
      name: row.client.clientName ?? null,
      uri: meta.client_uri ?? null,
      logoUri: meta.logo_uri ?? null,
    },
    redirectUri: row.request.redirectUri,
    redirectHost: hostOf(row.request.redirectUri),
    scopes: scopeList(row.request.scopes, user.role),
    user,
  });
});

// ── POST /api/oauth/requests/:id/decision ────────────────────────────────────
// Body { approve: boolean, scopes?: string[] } -> { redirectTo, scopes }. The page then
// navigates to redirectTo (the client's redirect URI with ?code=… or ?error=access_denied).
router.post(
  "/oauth/requests/:id/decision",
  requireMcpEnabled,
  requireSameOrigin,
  requireJsonBody,
  requireAuth,
  async (req, res): Promise<void> => {
    const body = req.body ?? {};
    if (typeof body.approve !== "boolean") {
      res.status(400).json({ error: "approve must be true or false" });
      return;
    }
    if (body.scopes !== undefined && (!Array.isArray(body.scopes) || body.scopes.some((s: unknown) => typeof s !== "string"))) {
      res.status(400).json({ error: "scopes must be an array of strings" });
      return;
    }
    const id = String(req.params.id);
    const pending = await loadPendingRequest(id);
    const user = await currentUser(req);
    if (!pending || !user) {
      res.status(404).json({ error: "This sign-in request has expired or was already used. Start connecting again from the app you were using." });
      return;
    }

    let scopes: string[] = [];
    if (body.approve) {
      const chosen: string[] = body.scopes ?? pending.request.scopes;
      const notRequested = chosen.filter((s) => !pending.request.scopes.includes(s));
      if (notRequested.length) {
        res.status(400).json({ error: `Not requested by the app: ${notRequested.join(", ")}` });
        return;
      }
      if (!chosen.includes(SCOPE_READ)) {
        res.status(400).json({ error: `${SCOPE_READ} is required` });
        return;
      }
      // A scope the role cannot use is dropped rather than refused: the token says what was granted.
      const usable = usableScopes(user.role);
      scopes = SUPPORTED_SCOPES.filter((s) => chosen.includes(s) && usable.includes(s));
    }

    const decided = await decideRequest(id, user.id, body.approve ? { approve: true, scopes } : { approve: false });
    if (!decided) {
      res.status(404).json({ error: "This sign-in request has expired or was already used. Start connecting again from the app you were using." });
      return;
    }

    const clientLabel = pending.client.clientName ?? "an MCP client";
    const redirectHost = hostOf(pending.request.redirectUri);
    await logAudit({
      userId: user.id,
      action: body.approve ? "connector_approve" : "connector_deny",
      entityType: "user",
      entityId: user.id,
      description: body.approve
        ? `Allowed ${clientLabel} (${redirectHost}) to access TaxAide as ${user.name} (${scopes.join(", ")})`
        : `Declined access for ${clientLabel} (${redirectHost})`,
      metadata: { clientId: pending.client.clientId, redirectHost, scopes },
    });
    res.json({ redirectTo: decided.redirectTo, scopes: decided.scopes });
  },
);

// ── GET /api/oauth/grants[?all=1] ────────────────────────────────────────────
// The caller's active connector grants; all=1 (super_admin only) lists everyone's.
router.get("/oauth/grants", requireAuth, async (req, res): Promise<void> => {
  const all = req.query.all === "1" || req.query.all === "true";
  if (all && req.session.userRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const active = and(isNull(oauthGrantsTable.revokedAt), gt(oauthGrantsTable.expiresAt, new Date()));
  const rows = await db
    .select({
      grant: oauthGrantsTable,
      clientName: oauthClientsTable.clientName,
      user: { id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role },
    })
    .from(oauthGrantsTable)
    .innerJoin(oauthClientsTable, eq(oauthClientsTable.clientId, oauthGrantsTable.clientId))
    .innerJoin(usersTable, eq(usersTable.id, oauthGrantsTable.userId))
    .where(all ? active : and(active, eq(oauthGrantsTable.userId, req.session.userId!)))
    .orderBy(desc(oauthGrantsTable.createdAt))
    .limit(500);
  res.json(
    rows.map((r) => ({
      id: r.grant.id,
      clientId: r.grant.clientId,
      clientName: r.clientName ?? null,
      redirectHost: hostOf(r.grant.redirectUri),
      scopes: r.grant.scopes,
      createdAt: r.grant.createdAt.toISOString(),
      lastUsedAt: r.grant.lastUsedAt?.toISOString() ?? null,
      expiresAt: r.grant.expiresAt.toISOString(),
      user: r.user,
    })),
  );
});

// ── DELETE /api/oauth/grants/:id ─────────────────────────────────────────────
// Ends the connection: every access and refresh token of the grant stops working at once.
router.delete("/oauth/grants/:id", requireSameOrigin, requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  const [row] = await db
    .select({ grant: oauthGrantsTable, clientName: oauthClientsTable.clientName })
    .from(oauthGrantsTable)
    .innerJoin(oauthClientsTable, eq(oauthClientsTable.clientId, oauthGrantsTable.clientId))
    .where(and(eq(oauthGrantsTable.id, id), isNull(oauthGrantsTable.revokedAt)));
  // Someone else's grant reads as not found unless the caller is a super admin.
  if (!row || (row.grant.userId !== req.session.userId && req.session.userRole !== "super_admin")) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }
  const revoked = await revokeGrant(db, id, row.grant.userId === req.session.userId ? "revoked_by_user" : "revoked_by_admin");
  if (revoked.length) {
    await logAudit({
      userId: req.session.userId,
      action: "connector_revoke",
      entityType: "oauth_grant",
      entityId: id,
      description: `Disconnected ${row.clientName ?? "an MCP client"} (${hostOf(row.grant.redirectUri)})` +
        (row.grant.userId === req.session.userId ? "" : ` for user #${row.grant.userId}`),
      metadata: { clientId: row.grant.clientId, ownerId: row.grant.userId },
    });
  }
  res.sendStatus(204);
});

export default router;
