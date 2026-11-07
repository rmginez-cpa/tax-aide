import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// TaxAide's own OAuth 2.1 authorization server, used by the remote MCP connector
// (claude.ai and other MCP clients). Codes and tokens are stored only as SHA-256
// hashes; a client secret is never stored (it is derived from the client id, see
// artifacts/api-server/src/lib/mcp/oauthProvider.ts).

/** Clients registered through Dynamic Client Registration (RFC 7591). */
export const oauthClientsTable = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  /** "none" (public client, PKCE only) or "client_secret_post". */
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  /** The registered metadata as returned to the client (no secret). */
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/**
 * A validated GET /authorize waiting for the user's decision on the consent page.
 * Single use; not bound to any session or user until someone signs in and decides.
 */
export const oauthAuthorizationRequestsTable = pgTable(
  "oauth_authorization_requests",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => oauthClientsTable.clientId, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("oauth_authorization_requests_expires_idx").on(t.expiresAt)],
);

/** One user's authorization of one client: the family every token of that connection belongs to. */
export const oauthGrantsTable = pgTable(
  "oauth_grants",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull().references(() => oauthClientsTable.clientId, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    /** The redirect URI the user approved (shown on the connected-apps page). */
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** When the newest refresh token expires: the grant is dead after this unless refreshed. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [index("oauth_grants_user_idx").on(t.userId), index("oauth_grants_client_idx").on(t.clientId)],
);

/** Authorization codes (single use, short-lived), bound to client, redirect URI, PKCE challenge, resource and user. */
export const oauthCodesTable = pgTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull().references(() => oauthClientsTable.clientId, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** The grant the code was exchanged for; revoked if the code is presented again. */
    grantId: integer("grant_id").references(() => oauthGrantsTable.id, { onDelete: "set null" }),
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)],
);

/** Access and refresh tokens. A used refresh token is kept until it expires so reuse can be detected. */
export const oauthTokensTable = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    grantId: integer("grant_id").notNull().references(() => oauthGrantsTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Refresh tokens: when it was exchanged (rotated). */
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("oauth_tokens_grant_idx").on(t.grantId), index("oauth_tokens_expires_idx").on(t.expiresAt)],
);

export type OAuthClientRow = typeof oauthClientsTable.$inferSelect;
export type OAuthGrantRow = typeof oauthGrantsTable.$inferSelect;
