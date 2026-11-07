import crypto from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql, inArray, type SQL } from "drizzle-orm";
import {
  db,
  usersTable,
  oauthClientsTable,
  oauthAuthorizationRequestsTable,
  oauthCodesTable,
  oauthGrantsTable,
  oauthTokensTable,
} from "@workspace/db";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { logAudit } from "../audit";
import { logger } from "../logger";
import { resolveSessionSecret } from "../security";
import {
  ACCESS_TOKEN_TTL_S,
  AUTH_REQUEST_TTL_MS,
  CODE_TTL_MS,
  CONSENT_PAGE_PATH,
  REFRESH_TOKEN_TTL_S,
  SCOPE_READ,
  SUPPORTED_SCOPES,
  canonicalResource,
  mcpUrl,
  publicOrigin,
  redirectUriAllowed,
} from "./config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

// ── Client secrets ───────────────────────────────────────────────────────────
// The SDK's client authentication compares the presented secret with
// getClient().client_secret, so it needs the plain secret. Instead of storing it,
// a confidential client's secret is an HMAC of its id under a key derived from
// SESSION_SECRET: nothing secret is in the database, and rotating SESSION_SECRET
// invalidates every client secret (such clients then register again).
let secretKey: Buffer | undefined;
function clientSecretFor(clientId: string): string {
  secretKey ??= crypto.createHmac("sha256", resolveSessionSecret().secret).update("taxaide-oauth-client-secret-v1").digest();
  return crypto.createHmac("sha256", secretKey).update(clientId).digest("base64url");
}

const MAX_CLIENT_NAME = 100;
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return s || undefined;
}
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The client as the SDK handlers see it. Redirect URIs no longer on the allow-list are dropped. */
function toClientInfo(row: typeof oauthClientsTable.$inferSelect): OAuthClientInformationFull {
  const confidential = row.tokenEndpointAuthMethod !== "none";
  return {
    ...(row.metadata as Partial<OAuthClientInformationFull>),
    redirect_uris: row.redirectUris.filter(redirectUriAllowed),
    client_id: row.clientId,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    client_secret: confidential ? clientSecretFor(row.clientId) : undefined,
    client_secret_expires_at: confidential ? 0 : undefined,
  } as OAuthClientInformationFull;
}

export const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    if (!clientId || clientId.length > 100) return undefined;
    const [row] = await db.select().from(oauthClientsTable).where(eq(oauthClientsTable.clientId, clientId));
    return row ? toClientInfo(row) : undefined;
  },

  async registerClient(client) {
    const full = client as OAuthClientInformationFull; // the handler has already set client_id / client_id_issued_at
    const redirectUris = [...new Set(full.redirect_uris.map(String))];
    if (redirectUris.length === 0 || redirectUris.length > 10) {
      throw new InvalidClientMetadataError("Register between 1 and 10 redirect_uris");
    }
    const refused = redirectUris.filter((u) => !redirectUriAllowed(u));
    if (refused.length) {
      throw new InvalidClientMetadataError(
        `redirect_uri not allowed by this server: ${refused.join(", ")} (ask the TaxAide administrator to add it to MCP_ALLOWED_REDIRECT_URIS)`,
      );
    }
    for (const g of full.grant_types ?? []) {
      if (g !== "authorization_code" && g !== "refresh_token") throw new InvalidClientMetadataError(`Unsupported grant_type "${g}"`);
    }
    for (const r of full.response_types ?? []) {
      if (r !== "code") throw new InvalidClientMetadataError(`Unsupported response_type "${r}"`);
    }
    // RFC 7591 lets the server replace requested values: anything but a public client
    // authenticates with client_secret_post, the one secret method this server supports.
    const authMethod = full.token_endpoint_auth_method === "none" ? "none" : "client_secret_post";
    const metadata: Record<string, unknown> = {
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: cleanText(full.client_name, MAX_CLIENT_NAME),
      client_uri: httpsUrl(full.client_uri),
      logo_uri: httpsUrl(full.logo_uri),
      software_id: cleanText(full.software_id, 200),
      software_version: cleanText(full.software_version, 100),
    };
    for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];

    const [row] = await db
      .insert(oauthClientsTable)
      .values({
        clientId: full.client_id,
        clientName: (metadata.client_name as string | undefined) ?? null,
        redirectUris,
        tokenEndpointAuthMethod: authMethod,
        metadata,
      })
      .returning();
    return toClientInfo(row);
  },
};

// ── Scopes / resource ────────────────────────────────────────────────────────

/** Requested scopes → what this server grants at most. Read is always included. */
export function normalizeScopes(requested: string[] | undefined): string[] {
  const wanted = new Set((requested ?? []).map((s) => s.trim()).filter(Boolean));
  // Refresh tokens are always issued; a client asking for offline_access gets the same.
  wanted.delete("offline_access");
  for (const s of wanted) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(s)) throw new InvalidScopeError(`Unknown scope "${s}"`);
  }
  wanted.add(SCOPE_READ);
  return SUPPORTED_SCOPES.filter((s) => wanted.has(s));
}

function sameResource(a: string | URL | undefined, expected: string): boolean {
  return a !== undefined && canonicalResource(a) === canonicalResource(expected);
}

// ── Grants and tokens ────────────────────────────────────────────────────────

async function issueTokens(tx: Executor, grantId: number, scopes: string[]): Promise<OAuthTokens> {
  const access = randomToken("taxaide_at_");
  const refresh = randomToken("taxaide_rt_");
  const now = Date.now();
  const refreshExpires = new Date(now + REFRESH_TOKEN_TTL_S * 1000);
  await tx.insert(oauthTokensTable).values([
    { grantId, kind: "access", tokenHash: sha256(access), scopes, expiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000) },
    { grantId, kind: "refresh", tokenHash: sha256(refresh), scopes, expiresAt: refreshExpires },
  ]);
  await tx.update(oauthGrantsTable).set({ expiresAt: refreshExpires, lastUsedAt: new Date(now) }).where(eq(oauthGrantsTable.id, grantId));
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
}

/**
 * Revokes the grants matching `where` (only those not yet revoked) and deletes their tokens.
 * Returns the revoked grants.
 */
async function revokeGrantsWhere(ex: Executor, where: SQL, reason: string) {
  const revoked = await ex
    .update(oauthGrantsTable)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(where, isNull(oauthGrantsTable.revokedAt)))
    .returning({ id: oauthGrantsTable.id, userId: oauthGrantsTable.userId, clientId: oauthGrantsTable.clientId });
  if (revoked.length) {
    await ex.delete(oauthTokensTable).where(inArray(oauthTokensTable.grantId, revoked.map((g) => g.id)));
  }
  return revoked;
}

export function revokeGrant(ex: Executor, grantId: number, reason: string) {
  return revokeGrantsWhere(ex, eq(oauthGrantsTable.id, grantId), reason);
}

/** Ends every connector grant of a user (password, role or client change). Safe inside a transaction. */
export function revokeUserGrants(ex: Executor, userId: number, reason: string) {
  return revokeGrantsWhere(ex, eq(oauthGrantsTable.userId, userId), reason);
}

async function reportReuse(kind: "authorization code" | "refresh token", grantId: number | null | undefined) {
  if (grantId == null) return;
  const revoked = await revokeGrant(db, grantId, `${kind.replace(" ", "_")}_reuse`);
  for (const g of revoked) {
    logger.warn({ grantId: g.id, clientId: g.clientId }, `OAuth ${kind} reused; connector grant revoked`);
    await logAudit({
      userId: g.userId,
      action: "connector_revoke",
      entityType: "oauth_grant",
      entityId: g.id,
      description: `Connector access revoked automatically: a used ${kind} was presented again`,
      metadata: { reason: "reuse", clientId: g.clientId },
    });
  }
}

// ── The provider ─────────────────────────────────────────────────────────────

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  // Called by the SDK's authorize handler once client_id and redirect_uri are known to be valid
  // (errors thrown here are sent back to the redirect_uri, as the spec requires).
  async authorize(client, params: AuthorizationParams, res) {
    const origin = publicOrigin(res.req);
    const resource = mcpUrl(origin);
    if (params.resource && !sameResource(params.resource, resource)) {
      throw new InvalidTargetError(`This server only issues tokens for ${resource}`);
    }
    const scopes = normalizeScopes(params.scopes);
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(params.codeChallenge)) {
      throw new InvalidRequestError("code_challenge must be a base64url S256 challenge");
    }
    if (params.state !== undefined && params.state.length > 2000) throw new InvalidRequestError("state is too long");

    const id = crypto.randomBytes(24).toString("base64url");
    await db.insert(oauthAuthorizationRequestsTable).values({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes,
      state: params.state ?? null,
      codeChallenge: params.codeChallenge,
      resource,
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    });
    res.redirect(302, `${origin}${CONSENT_PAGE_PATH}?request=${encodeURIComponent(id)}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const [row] = await db.select().from(oauthCodesTable).where(eq(oauthCodesTable.codeHash, sha256(code)));
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (row.usedAt) {
      // OAuth 2.1 §4.1.3: a replayed code revokes what was issued for it.
      await reportReuse("authorization code", row.grantId);
      throw new InvalidGrantError("Authorization code has already been used");
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new InvalidGrantError("Authorization code has expired");
    return row.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(oauthCodesTable).where(eq(oauthCodesTable.codeHash, sha256(code))).for("update");
      if (!row || row.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
      if (row.usedAt) return { reuse: row.grantId } as const;
      if (row.expiresAt.getTime() <= Date.now()) throw new InvalidGrantError("Authorization code has expired");
      if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
      if (resource !== undefined && !sameResource(resource, row.resource)) throw new InvalidTargetError("resource does not match the authorization request");

      const [grant] = await tx
        .insert(oauthGrantsTable)
        .values({ userId: row.userId, clientId: row.clientId, scopes: row.scopes, resource: row.resource, redirectUri: row.redirectUri, expiresAt: new Date() })
        .returning();
      await tx.update(oauthCodesTable).set({ usedAt: new Date(), grantId: grant.id }).where(eq(oauthCodesTable.codeHash, row.codeHash));
      await tx.update(oauthClientsTable).set({ lastUsedAt: new Date() }).where(eq(oauthClientsTable.clientId, row.clientId));
      return { tokens: await issueTokens(tx, grant.id, row.scopes) } as const;
    });
    if ("reuse" in outcome) {
      await reportReuse("authorization code", outcome.reuse);
      throw new InvalidGrantError("Authorization code has already been used");
    }
    return outcome.tokens;
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ token: oauthTokensTable, grant: oauthGrantsTable })
        .from(oauthTokensTable)
        .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
        .where(and(eq(oauthTokensTable.tokenHash, sha256(refreshToken)), eq(oauthTokensTable.kind, "refresh")))
        .for("update");
      if (!row || row.grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
      if (row.token.usedAt) return { reuse: row.grant.id } as const;
      if (row.grant.revokedAt || row.token.expiresAt.getTime() <= Date.now()) throw new InvalidGrantError("Refresh token has expired or was revoked");
      if (resource !== undefined && !sameResource(resource, row.grant.resource)) throw new InvalidTargetError("resource does not match the grant");
      let granted = row.token.scopes;
      if (scopes?.length) {
        const asked = scopes.filter((s) => s && s !== "offline_access");
        const extra = asked.filter((s) => !row.token.scopes.includes(s));
        if (extra.length) throw new InvalidScopeError(`Scope not granted: ${extra.join(" ")}`);
        granted = normalizeScopes(asked);
      }
      await tx.update(oauthTokensTable).set({ usedAt: new Date() }).where(eq(oauthTokensTable.id, row.token.id));
      return { tokens: await issueTokens(tx, row.grant.id, granted) } as const;
    });
    if ("reuse" in outcome) {
      // Refresh tokens rotate: a used one coming back means it leaked. End the whole family.
      await reportReuse("refresh token", outcome.reuse);
      throw new InvalidGrantError("Refresh token has already been used");
    }
    return outcome.tokens;
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    if (!token.startsWith("taxaide_at_") || token.length > 200) throw new InvalidTokenError("Invalid access token");
    const [row] = await db
      .select({
        token: oauthTokensTable,
        grant: oauthGrantsTable,
        user: { id: usersTable.id, name: usersTable.name, role: usersTable.role, clientId: usersTable.clientId },
        clientName: oauthClientsTable.clientName,
      })
      .from(oauthTokensTable)
      .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
      .innerJoin(usersTable, eq(usersTable.id, oauthGrantsTable.userId))
      .innerJoin(oauthClientsTable, eq(oauthClientsTable.clientId, oauthGrantsTable.clientId))
      .where(
        and(
          eq(oauthTokensTable.tokenHash, sha256(token)),
          eq(oauthTokensTable.kind, "access"),
          gt(oauthTokensTable.expiresAt, new Date()),
          isNull(oauthGrantsTable.revokedAt),
        ),
      );
    if (!row) throw new InvalidTokenError("The access token is invalid, expired or revoked");

    // Shown on the connected-apps page; at most one write a minute per grant.
    db.update(oauthGrantsTable)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(oauthGrantsTable.id, row.grant.id),
          or(isNull(oauthGrantsTable.lastUsedAt), lt(oauthGrantsTable.lastUsedAt, new Date(Date.now() - 60_000))),
        ),
      )
      .catch((err: unknown) => logger.warn({ err }, "Could not record connector use"));

    return {
      token,
      clientId: row.grant.clientId,
      scopes: row.token.scopes,
      expiresAt: Math.floor(row.token.expiresAt.getTime() / 1000),
      resource: new URL(row.grant.resource),
      extra: {
        grantId: row.grant.id,
        clientName: row.clientName,
        // Read fresh on every request, so a role or client change applies at once.
        user: { id: row.user.id, name: row.user.name, role: row.user.role, clientId: row.user.clientId ?? null },
      },
    };
  },

  async revokeToken(client, request: OAuthTokenRevocationRequest) {
    const [row] = await db
      .select({ token: oauthTokensTable, grant: oauthGrantsTable })
      .from(oauthTokensTable)
      .innerJoin(oauthGrantsTable, eq(oauthGrantsTable.id, oauthTokensTable.grantId))
      .where(eq(oauthTokensTable.tokenHash, sha256(request.token)));
    // RFC 7009 §2.2: an unknown token (or another client's) is not an error.
    if (!row || row.grant.clientId !== client.client_id) return;
    if (row.token.kind === "refresh") {
      await revokeGrant(db, row.grant.id, "revoked_by_client");
    } else {
      await db.delete(oauthTokensTable).where(eq(oauthTokensTable.id, row.token.id));
    }
  },
};

// ── Consent (used by routes/oauth.ts) ────────────────────────────────────────

export async function loadPendingRequest(id: string) {
  if (!id || id.length > 64) return null;
  const [row] = await db
    .select({ request: oauthAuthorizationRequestsTable, client: oauthClientsTable })
    .from(oauthAuthorizationRequestsTable)
    .innerJoin(oauthClientsTable, eq(oauthClientsTable.clientId, oauthAuthorizationRequestsTable.clientId))
    .where(
      and(
        eq(oauthAuthorizationRequestsTable.id, id),
        isNull(oauthAuthorizationRequestsTable.consumedAt),
        gt(oauthAuthorizationRequestsTable.expiresAt, new Date()),
      ),
    );
  return row ?? null;
}

/**
 * Records the signed-in user's decision on a pending request (single use) and returns
 * where to send the browser: the client's redirect_uri with a code, or with
 * error=access_denied. Returns null when the request is unknown, expired or already decided.
 */
export async function decideRequest(
  id: string,
  userId: number,
  decision: { approve: false } | { approve: true; scopes: string[] },
): Promise<{ redirectTo: string; scopes: string[] } | null> {
  const [request] = await db
    .update(oauthAuthorizationRequestsTable)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationRequestsTable.id, id),
        isNull(oauthAuthorizationRequestsTable.consumedAt),
        gt(oauthAuthorizationRequestsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!request) return null;

  const target = new URL(request.redirectUri);
  let scopes: string[] = [];
  if (decision.approve) {
    scopes = decision.scopes;
    const code = randomToken("taxaide_ac_");
    await db.insert(oauthCodesTable).values({
      codeHash: sha256(code),
      clientId: request.clientId,
      userId,
      redirectUri: request.redirectUri,
      scopes,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    target.searchParams.set("code", code);
  } else {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user declined access");
  }
  if (request.state != null) target.searchParams.set("state", request.state);
  return { redirectTo: target.href, scopes };
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

/** Deletes expired requests, codes, tokens, long-dead grants and abandoned client registrations. */
export async function cleanupOAuthRows(): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  await db.delete(oauthAuthorizationRequestsTable).where(lt(oauthAuthorizationRequestsTable.expiresAt, new Date(now - day)));
  await db.delete(oauthCodesTable).where(lt(oauthCodesTable.expiresAt, new Date(now - day)));
  await db.delete(oauthTokensTable).where(lt(oauthTokensTable.expiresAt, new Date(now)));
  await db
    .delete(oauthGrantsTable)
    .where(or(lt(oauthGrantsTable.revokedAt, new Date(now - 30 * day)), lt(oauthGrantsTable.expiresAt, new Date(now - 30 * day))));
  // A client is kept while it has a live grant. Registrations that were never used go
  // after a week (every claude.ai connection attempt registers one), others after 90 days idle.
  await db.execute(sql`
    DELETE FROM oauth_clients c
    WHERE ((c.last_used_at IS NULL AND c.created_at < ${new Date(now - 7 * day)})
        OR c.last_used_at < ${new Date(now - 90 * day)})
      AND NOT EXISTS (
        SELECT 1 FROM oauth_grants g
        WHERE g.client_id = c.client_id AND g.revoked_at IS NULL AND g.expires_at > now()
      )
  `);
}

let cleanupTimer: NodeJS.Timeout | undefined;
export function startOAuthCleanup(): void {
  if (cleanupTimer) return;
  const run = () => cleanupOAuthRows().catch((err: unknown) => logger.warn({ err }, "OAuth cleanup failed"));
  setTimeout(run, 30_000).unref();
  cleanupTimer = setInterval(run, 60 * 60 * 1000);
  cleanupTimer.unref();
}
