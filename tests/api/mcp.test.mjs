// TaxAide remote MCP connector + OAuth 2.1 authorization server integration tests.
// Dependency-free Node 22+ ES module on the shared harness. Tests a running API with
// MCP enabled (the default) and resets the Postgres fixture at the start and the end.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. TAXAIDE_TEST_RESET_DB=1 required.
//
// Server env: TRUST_PROXY=1 (every OAuth request here comes from its own made-up
// X-Forwarded-For address, so the per-IP rate limits of /register, /token and /authorize
// never trip), and no PUBLIC_BASE_URL (URLs are derived from API_BASE's host).
// Not covered: MCP_ENABLED=0 (needs a server restart).

import crypto from "node:crypto";
import {
  guard, BASE, reset, cookies, call, sql, sqlNum, q, assert, pass, fail, group, main, login, parseJson, setCookies,
} from "./_harness.mjs";

guard();

const ORIGIN = new URL(BASE).origin;
const MCP = `${ORIGIN}/api/mcp`;
const PRM_URL = `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`;
const CB = "https://claude.ai/api/mcp/auth_callback";
const READ = "taxaide.read";
const WRITE = "taxaide.write";
const READ_TOOLS = ["find_clients", "get_client", "get_client_compliance", "get_filing", "list_deadlines", "list_documents", "list_filings", "workload_overview"];
const WRITE_TOOLS = ["add_filing_comment", "set_deadline_notes", "update_checklist_item"];

// ── Raw HTTP ─────────────────────────────────────────────────────────────────
function fakeIp() {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2] || 1}`;
}
async function http(method, url, { json, form, headers = {}, ip = fakeIp() } = {}) {
  const h = { "x-forwarded-for": ip, ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    h["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined)).toString();
  }
  const res = await fetch(url.startsWith("http") ? url : `${ORIGIN}${url}`, { method, headers: h, body, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: parseJson(text) };
}
const brief = (r) => `${r.status} ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 200)}`;
function expect(name, r, ok, expected) {
  assert(name, ok, expected, brief(r));
}

// ── OAuth helpers ────────────────────────────────────────────────────────────
function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
async function register(meta = {}) {
  return http("POST", "/api/oauth/register", {
    json: { client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...meta },
  });
}
async function newClient(meta) {
  const r = await register(meta);
  if (r.status !== 201) throw new Error(`register failed: ${brief(r)}`);
  return r.json;
}
function authorizeUrl(client, p = {}) {
  const u = new URL(`${ORIGIN}/api/oauth/authorize`);
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CB,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    scope: `${READ} ${WRITE}`,
    state: "st-123",
    resource: MCP,
    ...p.params,
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.href;
}
/** GET /authorize -> the consent request id (throws unless redirected to the consent page). */
async function startAuthorize(client, p) {
  const r = await http("GET", authorizeUrl(client, p));
  const loc = r.headers.get("location");
  const u = loc ? new URL(loc, ORIGIN) : null;
  if (r.status !== 302 || u?.pathname !== "/connect/authorize") throw new Error(`authorize did not reach consent: ${brief(r)} ${loc}`);
  return u.searchParams.get("request");
}
function decide(role, requestId, body, headers = { origin: ORIGIN }) {
  return http("POST", `${BASE}/oauth/requests/${requestId}/decision`, { json: body, headers: { cookie: cookies[role] ?? "", ...headers } });
}
async function approvedCode(role, client, { scopes, challenge, params } = {}) {
  const requestId = await startAuthorize(client, { challenge, params });
  const d = await decide(role, requestId, scopes ? { approve: true, scopes } : { approve: true });
  if (d.status !== 200) throw new Error(`decision failed: ${brief(d)}`);
  return new URL(d.json.redirectTo).searchParams.get("code");
}
function exchange(client, code, verifier, extra = {}) {
  return http("POST", "/api/oauth/token", {
    form: { grant_type: "authorization_code", client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: verifier, redirect_uri: CB, resource: MCP, ...extra },
  });
}
function refresh(client, refreshToken, extra = {}) {
  return http("POST", "/api/oauth/token", {
    form: { grant_type: "refresh_token", client_id: client.client_id, client_secret: client.client_secret, refresh_token: refreshToken, ...extra },
  });
}
/** Full flow for `role`: register, authorize, approve, exchange. Returns { client, tokens }. */
async function connect(role, { scopes, meta } = {}) {
  const client = await newClient(meta);
  const { verifier, challenge } = pkce();
  const code = await approvedCode(role, client, { scopes, challenge });
  const t = await exchange(client, code, verifier);
  if (t.status !== 200) throw new Error(`token exchange failed: ${brief(t)}`);
  return { client, tokens: t.json };
}

// ── MCP helpers ──────────────────────────────────────────────────────────────
let rpcId = 1;
async function mcp(token, message, headers = {}) {
  return http("POST", MCP, {
    json: message,
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}
function rpc(token, method, params = {}) {
  return mcp(token, { jsonrpc: "2.0", id: rpcId++, method, params });
}
async function tools(token) {
  const r = await rpc(token, "tools/list");
  return (r.json?.result?.tools ?? []).map((t) => t.name).sort();
}
/** tools/call -> { isError, text, data } (data = parsed JSON text when it parses). */
async function callTool(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const res = r.json?.result;
  const text = res?.content?.[0]?.text ?? "";
  return { status: r.status, isError: res?.isError === true, text, data: parseJson(text), structured: res?.structuredContent, raw: r };
}

// ── Groups ───────────────────────────────────────────────────────────────────

group("1 discovery documents", async () => {
  await reset([]);
  const prmPaths = ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource", "/api/.well-known/oauth-protected-resource"];
  for (const p of prmPaths) {
    const r = await http("GET", p);
    expect(`PRM at ${p}`, r, r.status === 200 && r.json?.resource === MCP && r.json?.authorization_servers?.[0] === ORIGIN &&
      r.json?.scopes_supported?.join(" ") === `${READ} ${WRITE}` && r.headers.get("access-control-allow-origin") === "*", "PRM for /api/mcp");
  }
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const r = await http("GET", p);
    const m = r.json ?? {};
    expect(`AS metadata at ${p}`, r, r.status === 200 && m.issuer === ORIGIN &&
      m.authorization_endpoint === `${ORIGIN}/api/oauth/authorize` && m.token_endpoint === `${ORIGIN}/api/oauth/token` &&
      m.registration_endpoint === `${ORIGIN}/api/oauth/register` && m.revocation_endpoint === `${ORIGIN}/api/oauth/revoke` &&
      m.code_challenge_methods_supported?.join() === "S256" && m.token_endpoint_auth_methods_supported?.includes("none") &&
      m.response_types_supported?.join() === "code" && !("client_id_metadata_document_supported" in m), "RFC 8414 metadata");
  }
  const x = await http("GET", "/.well-known/oauth-protected-resource", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "taxaide.example.com" } });
  expect("URLs follow X-Forwarded-Proto/Host (TRUST_PROXY)", x, x.json?.resource === "https://taxaide.example.com/api/mcp", "https://taxaide.example.com/api/mcp");
  const opt = await http("OPTIONS", "/.well-known/oauth-authorization-server", { headers: { origin: "https://claude.ai", "access-control-request-method": "GET" } });
  expect("metadata CORS preflight", opt, opt.status === 204 && opt.headers.get("access-control-allow-origin") === "*", "204 *");
});

group("2 MCP endpoint: 401 / 405 / no session", async () => {
  await reset([]);
  const r = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const www = r.headers.get("www-authenticate") ?? "";
  expect("no token -> 401", r, r.status === 401, "401");
  assert("401 WWW-Authenticate has resource_metadata + scope, no error code", www.startsWith("Bearer ") && www.includes(`resource_metadata="${PRM_URL}"`) &&
    www.includes(`scope="${READ} ${WRITE}"`) && !www.includes("error="), "Bearer resource_metadata=… scope=…", www);
  assert("no Set-Cookie on /api/mcp", setCookies({ headers: r.headers }).filter(Boolean).length === 0, "no cookie", setCookies({ headers: r.headers }).join());
  const bad = await mcp("taxaide_at_nope", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const www2 = bad.headers.get("www-authenticate") ?? "";
  expect("bad token -> 401 invalid_token", bad, bad.status === 401 && www2.includes('error="invalid_token"') && www2.includes("resource_metadata="), "401 invalid_token");
  const basic = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Basic YTpi" });
  expect("non-bearer auth -> 401", basic, basic.status === 401 && (basic.headers.get("www-authenticate") ?? "").includes("invalid_token"), "401");
  for (const m of ["GET", "DELETE"]) {
    const g = await http(m, MCP, { headers: { accept: "text/event-stream" } });
    expect(`${m} /api/mcp -> 405 Allow: POST`, g, g.status === 405 && g.headers.get("allow") === "POST", "405");
  }
  const sessions = sqlNum("select count(*) from user_sessions");
  assert("MCP / OAuth requests create no sessions", sessions === 0, 0, sessions);
});

group("3 dynamic client registration", async () => {
  await reset([]);
  const ok = await register();
  expect("claude.ai callback accepted", ok, ok.status === 201 && typeof ok.json?.client_id === "string" && ok.json.client_secret === undefined &&
    ok.json.token_endpoint_auth_method === "none" && ok.json.redirect_uris?.[0] === CB, "201 public client");
  const com = await register({ redirect_uris: ["https://claude.com/api/mcp/auth_callback"] });
  expect("claude.com callback accepted", com, com.status === 201, "201");
  const loop = await register({ redirect_uris: ["http://localhost:53682/callback", "http://127.0.0.1:3118/callback"], client_name: "Claude Code" });
  expect("loopback (any port) accepted", loop, loop.status === 201, "201");
  for (const uri of ["https://evil.example/callback", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/x", "http://10.0.0.1/callback", "javascript:alert(1)"]) {
    const r = await register({ redirect_uris: [uri] });
    expect(`refused redirect ${uri}`, r, r.status === 400 && r.json?.error === "invalid_client_metadata", "400 invalid_client_metadata");
  }
  const grant = await register({ grant_types: ["client_credentials"] });
  expect("client_credentials refused", grant, grant.status === 400, "400");
  // Claude's published client metadata lists jwt-bearer too; the extra grant is dropped, not refused.
  const jwt = await register({ grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code", "token"] });
  expect("unsupported extra grant / response types are dropped", jwt, jwt.status === 201 &&
    jwt.json.grant_types?.join() === "authorization_code,refresh_token" && jwt.json.response_types?.join() === "code", "201 with the supported types");
  const noCode = await register({ response_types: ["token"] });
  expect("response_types without code refused", noCode, noCode.status === 400 && noCode.json?.error === "invalid_client_metadata", "400");
  const huge = await register({ redirect_uris: [`http://localhost/${"a".repeat(72000)}`] });
  expect("over-long redirect_uri refused", huge, huge.status === 400 && huge.json?.error === "invalid_client_metadata" && huge.text.length < 500, "400, short error");
  const longest = await register({ redirect_uris: [`http://localhost/${"b".repeat(512 - 17)}`] });
  expect("512-character loopback redirect_uri accepted", longest, longest.status === 201, "201");
  const many = await register({ redirect_uris: Array.from({ length: 10 }, (_, i) => `http://localhost:${4000 + i}/${"c".repeat(480)}`) });
  const bytes = many.status === 201 ? sqlNum(`select pg_column_size(redirect_uris) + pg_column_size(metadata) from oauth_clients where client_id = ${q(many.json.client_id)}`) : -1;
  assert("largest registration stays small (redirect URIs stored once)", many.status === 201 && bytes > 0 && bytes < 8000, "< 8000 bytes", `${many.status} ${bytes}`);
  const conf = await register({ token_endpoint_auth_method: "client_secret_basic" });
  expect("confidential client gets client_secret_post + a non-expiring secret", conf, conf.status === 201 &&
    conf.json.token_endpoint_auth_method === "client_secret_post" && typeof conf.json.client_secret === "string" && conf.json.client_secret_expires_at === 0, "201 secret");
  const stored = sql(`select count(*) from oauth_clients where metadata::text like ${q(`%${conf.json?.client_secret}%`)}`);
  assert("client secret is not stored", stored === "0", "0", stored);
  const name = await register({ client_name: "A\u0000B".padEnd(300, "x") });
  expect("client_name cleaned and capped", name, name.status === 201 && name.json.client_name.length <= 100 && !name.json.client_name.includes("\u0000"), "<=100 chars");
  const nobody = await http("POST", "/api/oauth/register", { json: { client_name: "x" } });
  expect("missing redirect_uris -> 400", nobody, nobody.status === 400, "400");
  const getReg = await http("GET", "/api/oauth/register");
  expect("GET /register -> 405", getReg, getReg.status === 405, "405");
  const rootAlias = await http("POST", "/register", { json: { client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none" } });
  expect("origin-root /register alias", rootAlias, rootAlias.status === 201, "201");
});

group("4 authorize endpoint", async () => {
  await reset([]);
  const client = await newClient();
  const { challenge } = pkce();
  const noRedirect = (r) => !r.headers.get("location");

  const unknown = await http("GET", authorizeUrl({ client_id: "no-such-client" }, { challenge }));
  expect("unknown client_id -> 400, never redirects", unknown, unknown.status === 400 && noRedirect(unknown) && unknown.json?.error === "invalid_client", "400 invalid_client");
  const badRedirect = await http("GET", authorizeUrl(client, { challenge, params: { redirect_uri: "https://evil.example/cb" } }));
  expect("unregistered redirect_uri -> 400, never redirects", badRedirect, badRedirect.status === 400 && noRedirect(badRedirect), "400");

  const errorRedirect = async (name, params, code) => {
    const r = await http("GET", authorizeUrl(client, { challenge, params }));
    const u = r.headers.get("location") ? new URL(r.headers.get("location")) : null;
    expect(name, r, r.status === 302 && u?.origin + u?.pathname === CB && u.searchParams.get("error") === code && u.searchParams.get("state") === "st-123", `302 ${CB}?error=${code}`);
  };
  await errorRedirect("missing code_challenge -> invalid_request", { code_challenge: null }, "invalid_request");
  await errorRedirect("plain PKCE method -> invalid_request", { code_challenge_method: "plain" }, "invalid_request");
  await errorRedirect("no PKCE method -> invalid_request", { code_challenge_method: null }, "invalid_request");
  await errorRedirect("short code_challenge -> invalid_request", { code_challenge: "abc" }, "invalid_request");
  await errorRedirect("response_type=token -> invalid_request", { response_type: "token" }, "invalid_request");
  await errorRedirect("other resource -> invalid_target", { resource: "https://other.example/api/mcp" }, "invalid_target");
  await errorRedirect("unknown scope -> invalid_scope", { scope: "taxaide.admin" }, "invalid_scope");

  const r = await http("GET", authorizeUrl(client, { challenge }));
  const loc = new URL(r.headers.get("location") ?? "x:", ORIGIN);
  expect("valid request -> 302 to the consent page", r, r.status === 302 && loc.href.startsWith(`${ORIGIN}/connect/authorize?request=`), "302 /connect/authorize?request=");
  const id = loc.searchParams.get("request");
  const row = sql(`select client_id||'|'||redirect_uri||'|'||array_to_string(scopes,' ')||'|'||state||'|'||resource from oauth_authorization_requests where id=${q(id)}`);
  assert("pending request stored with its parameters", row === `${client.client_id}|${CB}|${READ} ${WRITE}|st-123|${MCP}`, "stored", row);
  const ttl = sqlNum(`select extract(epoch from expires_at - created_at) from oauth_authorization_requests where id=${q(id)}`);
  assert("pending request lives 10 minutes", ttl > 590 && ttl <= 600, "600 s", ttl);

  const defaults = await startAuthorize(client, { challenge, params: { scope: null, resource: null } });
  const ds = sql(`select array_to_string(scopes,' ')||'|'||resource from oauth_authorization_requests where id=${q(defaults)}`);
  assert("no scope / resource -> read scope, this MCP URL", ds === `${READ}|${MCP}`, `${READ}|${MCP}`, ds);
  const offline = await startAuthorize(client, { challenge, params: { scope: `${READ} offline_access` } });
  const os = sql(`select array_to_string(scopes,' ') from oauth_authorization_requests where id=${q(offline)}`);
  assert("offline_access accepted and ignored", os === READ, READ, os);
  const loopClient = await newClient({ redirect_uris: ["http://127.0.0.1/callback"] });
  const lr = await http("GET", authorizeUrl(loopClient, { challenge, params: { redirect_uri: "http://127.0.0.1:49152/callback" } }));
  expect("loopback redirect matches any port", lr, lr.status === 302 && (lr.headers.get("location") ?? "").includes("/connect/authorize"), "302 consent");
  const alias = await http("GET", authorizeUrl(client, { challenge }).replace("/api/oauth/authorize", "/authorize"));
  expect("origin-root /authorize alias", alias, alias.status === 302 && (alias.headers.get("location") ?? "").includes("/connect/authorize"), "302 consent");
});

group("5 consent endpoints", async () => {
  await reset(["maker", "client", "manager"]);
  const client = await newClient();
  const { challenge } = pkce();
  const id = await startAuthorize(client, { challenge });

  const anon = await http("GET", `${BASE}/oauth/requests/${id}`);
  expect("GET request needs a session", anon, anon.status === 401, "401");
  const g = await http("GET", `${BASE}/oauth/requests/${id}`, { headers: { cookie: cookies.maker } });
  const j = g.json ?? {};
  expect("GET request (maker)", g, g.status === 200 && j.id === id && j.client?.name === "Claude" && j.client?.id === client.client_id &&
    j.redirectHost === "claude.ai" && j.redirectUri === CB && j.user?.email === "accountant@firm.ph" && j.user?.role === "maker" &&
    j.scopes?.length === 2 && j.scopes.every((s) => s.available === true && s.title && s.description) && !!Date.parse(j.expiresAt), "request details");
  const gc = await http("GET", `${BASE}/oauth/requests/${id}`, { headers: { cookie: cookies.client } });
  expect("client role: write scope not available", gc, gc.status === 200 && gc.json.scopes.find((s) => s.name === WRITE)?.available === false &&
    gc.json.scopes.find((s) => s.name === READ)?.available === true, "write unavailable");
  const missing = await http("GET", `${BASE}/oauth/requests/nope`, { headers: { cookie: cookies.maker } });
  expect("unknown request -> 404", missing, missing.status === 404, "404");

  const noOrigin = await decide("maker", id, { approve: true }, {});
  expect("decision without Origin -> 403", noOrigin, noOrigin.status === 403, "403");
  const evil = await decide("maker", id, { approve: true }, { origin: "https://evil.example" });
  expect("decision from another origin -> 403", evil, evil.status === 403, "403");
  const form = await http("POST", `${BASE}/oauth/requests/${id}/decision`, { form: { approve: "true" }, headers: { cookie: cookies.maker, origin: ORIGIN } });
  expect("form-encoded decision -> 415", form, form.status === 415, "415");
  const anonD = await decide(null, id, { approve: true });
  expect("decision needs a session", anonD, anonD.status === 401, "401");
  const badBody = await decide("maker", id, { approve: "yes" });
  expect("approve must be boolean", badBody, badBody.status === 400, "400");
  const notReq = await decide("maker", id, { approve: true, scopes: [READ, "taxaide.admin"] });
  expect("scope not requested -> 400", notReq, notReq.status === 400, "400");
  const noRead = await decide("maker", id, { approve: true, scopes: [WRITE] });
  expect("read scope required -> 400", noRead, noRead.status === 400, "400");
  assert("failed decisions did not use the request", sqlNum(`select count(*) from oauth_authorization_requests where id=${q(id)} and consumed_at is null`) === 1, 1, "consumed");

  const deny = await decide("maker", id, { approve: false });
  const du = deny.json?.redirectTo ? new URL(deny.json.redirectTo) : null;
  expect("deny -> redirect with access_denied + state", deny, deny.status === 200 && du?.origin + du?.pathname === CB && du.searchParams.get("error") === "access_denied" &&
    du.searchParams.get("state") === "st-123" && !du.searchParams.get("code"), "access_denied");
  const again = await decide("maker", id, { approve: true });
  expect("request is single-use", again, again.status === 404, "404");
  assert("deny is audit-logged", sqlNum("select count(*) from audit_logs where action='connector_deny' and user_id=3") === 1, 1, "audit");

  const id2 = await startAuthorize(client, { challenge });
  const ok = await decide("maker", id2, { approve: true, scopes: [READ] });
  const ou = new URL(ok.json?.redirectTo ?? "x:");
  expect("approve read only", ok, ok.status === 200 && !!ou.searchParams.get("code") && ou.searchParams.get("state") === "st-123" && ok.json.scopes?.join() === READ, "code, [read]");
  const codeRow = sql(`select user_id||'|'||array_to_string(scopes,' ')||'|'||extract(epoch from expires_at-created_at)::int from oauth_codes`);
  assert("code bound to the user, approved scopes, short-lived", codeRow === `3|${READ}|300`, `3|${READ}|300`, codeRow);
  assert("code stored only as a hash", sqlNum(`select count(*) from oauth_codes where code_hash=${q(ou.searchParams.get("code"))}`) === 0, 0, "plain code found");
  assert("approval is audit-logged", sqlNum("select count(*) from audit_logs where action='connector_approve' and user_id=3") === 1, 1, "audit");

  const id3 = await startAuthorize(client, { challenge });
  const cl = await decide("client", id3, { approve: true });
  expect("client role asking for write gets read only", cl, cl.status === 200 && cl.json.scopes?.join() === READ, "[read]");

  sql(`update oauth_authorization_requests set expires_at = now() - interval '1 second' where consumed_at is null`);
  const id4 = await startAuthorize(client, { challenge });
  sql(`update oauth_authorization_requests set expires_at = now() - interval '1 second' where id=${q(id4)}`);
  const expired = await decide("manager", id4, { approve: true });
  expect("expired request -> 404", expired, expired.status === 404, "404");
});

group("6 token endpoint: code exchange", async () => {
  await reset(["maker"]);
  const client = await newClient();
  const other = await newClient();

  let { verifier, challenge } = pkce();
  let code = await approvedCode("maker", client, { challenge });
  const wrong = await exchange(client, code, pkce().verifier);
  expect("PKCE verifier mismatch -> invalid_grant", wrong, wrong.status === 400 && wrong.json?.error === "invalid_grant", "invalid_grant");
  const noVerifier = await exchange(client, code, undefined);
  expect("missing code_verifier -> invalid_request", noVerifier, noVerifier.status === 400 && noVerifier.json?.error === "invalid_request", "invalid_request");
  const otherClient = await exchange(other, code, verifier);
  expect("another client's code -> invalid_grant", otherClient, otherClient.status === 400 && otherClient.json?.error === "invalid_grant", "invalid_grant");
  const badRedirect = await exchange(client, code, verifier, { redirect_uri: "https://claude.com/api/mcp/auth_callback" });
  expect("redirect_uri mismatch -> invalid_grant", badRedirect, badRedirect.status === 400 && badRedirect.json?.error === "invalid_grant", "invalid_grant");
  const badResource = await exchange(client, code, verifier, { resource: "https://other.example/api/mcp" });
  expect("resource mismatch -> invalid_target", badResource, badResource.status === 400 && badResource.json?.error === "invalid_target", "invalid_target");
  const ok = await exchange(client, code, verifier);
  const t = ok.json ?? {};
  expect("valid exchange (after failed attempts)", ok, ok.status === 200 && t.token_type === "Bearer" && t.expires_in === 3600 &&
    t.access_token?.startsWith("taxaide_at_") && t.refresh_token?.startsWith("taxaide_rt_") && t.scope === `${READ} ${WRITE}` &&
    ok.headers.get("cache-control") === "no-store", "tokens");
  assert("no Set-Cookie on /token", setCookies({ headers: ok.headers }).filter(Boolean).length === 0, "none", setCookies({ headers: ok.headers }).join());
  assert("tokens stored only as hashes", sqlNum(`select count(*) from oauth_tokens where token_hash in (${q(t.access_token)}, ${q(t.refresh_token)})`) === 0, 0, "plain");
  const works = await tools(t.access_token);
  assert("access token works", works.length === 11, 11, works.length);

  const reuse = await exchange(client, code, verifier);
  expect("code reuse -> invalid_grant", reuse, reuse.status === 400 && reuse.json?.error === "invalid_grant", "invalid_grant");
  const after = await rpc(t.access_token, "tools/list");
  expect("code reuse revokes the tokens issued for it", after, after.status === 401, "401");
  assert("reuse audit-logged", sqlNum("select count(*) from audit_logs where action='connector_revoke' and description like '%authorization code%'") === 1, 1, "audit");

  ({ verifier, challenge } = pkce());
  code = await approvedCode("maker", client, { challenge });
  sql("update oauth_codes set expires_at = now() - interval '1 second' where used_at is null");
  const expired = await exchange(client, code, verifier);
  expect("expired code -> invalid_grant", expired, expired.status === 400 && expired.json?.error === "invalid_grant", "invalid_grant");

  ({ verifier, challenge } = pkce());
  code = await approvedCode("maker", client, { challenge });
  const noRes = await exchange(client, code, verifier, { resource: undefined, redirect_uri: undefined });
  expect("exchange without resource / redirect_uri (OAuth 2.1 + PKCE)", noRes, noRes.status === 200 && !!noRes.json?.access_token, "200");

  const conf = await newClient({ token_endpoint_auth_method: "client_secret_post" });
  ({ verifier, challenge } = pkce());
  code = await approvedCode("maker", conf, { challenge });
  const noSecret = await exchange({ ...conf, client_secret: undefined }, code, verifier);
  expect("confidential client without secret -> invalid_client", noSecret, noSecret.status === 400 && noSecret.json?.error === "invalid_client", "invalid_client");
  const badSecret = await exchange({ ...conf, client_secret: "x" }, code, verifier);
  expect("confidential client with a wrong secret -> invalid_client", badSecret, badSecret.status === 400 && badSecret.json?.error === "invalid_client", "invalid_client");
  const goodSecret = await exchange(conf, code, verifier);
  expect("confidential client with its secret", goodSecret, goodSecret.status === 200, "200");
  const alias = await http("POST", "/token", { form: { grant_type: "refresh_token", client_id: conf.client_id, client_secret: conf.client_secret, refresh_token: goodSecret.json?.refresh_token } });
  expect("origin-root /token alias", alias, alias.status === 200 && !!alias.json?.access_token, "200");
  const cc = await http("POST", "/api/oauth/token", { form: { grant_type: "client_credentials", client_id: client.client_id } });
  expect("client_credentials -> unsupported_grant_type", cc, cc.status === 400 && cc.json?.error === "unsupported_grant_type", "unsupported_grant_type");
});

group("7 refresh rotation, reuse detection, revocation", async () => {
  await reset(["maker"]);
  const { client, tokens: t1 } = await connect("maker");
  const r1 = await refresh(client, t1.refresh_token);
  const t2 = r1.json ?? {};
  expect("refresh -> new access + refresh token", r1, r1.status === 200 && t2.access_token !== t1.access_token && t2.refresh_token !== t1.refresh_token &&
    t2.expires_in === 3600 && t2.scope === `${READ} ${WRITE}`, "rotated");
  assert("new access token works", (await tools(t2.access_token)).length === 11, 11, "tools");
  const narrow = await refresh(client, t2.refresh_token, { scope: READ });
  expect("refresh with a narrower scope", narrow, narrow.status === 200 && narrow.json.scope === READ, READ);
  const t3 = narrow.json;
  assert("narrowed token has read tools only", (await tools(t3.access_token)).join() === READ_TOOLS.join(), "8 read tools", (await tools(t3.access_token)).join());
  const widen = await refresh(client, t3.refresh_token, { scope: `${READ} ${WRITE}` });
  expect("refresh cannot widen scope -> invalid_scope", widen, widen.status === 400 && widen.json?.error === "invalid_scope", "invalid_scope");
  const badRes = await refresh(client, t3.refresh_token, { resource: "https://other.example/api/mcp" });
  expect("refresh for another resource -> invalid_target", badRes, badRes.status === 400 && badRes.json?.error === "invalid_target", "invalid_target");
  const other = await newClient();
  const stolen = await refresh(other, t3.refresh_token);
  expect("another client's refresh token -> invalid_grant", stolen, stolen.status === 400 && stolen.json?.error === "invalid_grant", "invalid_grant");

  // t1's refresh token was rotated away: presenting it again ends the whole family.
  const reuse = await refresh(client, t1.refresh_token);
  expect("rotated refresh token reused -> invalid_grant", reuse, reuse.status === 400 && reuse.json?.error === "invalid_grant", "invalid_grant");
  const dead = await rpc(t3.access_token, "tools/list");
  expect("reuse revokes the family's access token", dead, dead.status === 401, "401");
  const deadRefresh = await refresh(client, t3.refresh_token);
  expect("... and its current refresh token", deadRefresh, deadRefresh.status === 400 && deadRefresh.json?.error === "invalid_grant", "invalid_grant");
  const reason = sql("select revoked_reason from oauth_grants where revoked_at is not null limit 1");
  assert("grant revoked for reuse", reason === "refresh_token_reuse", "refresh_token_reuse", reason);

  // A retry (lost response) or two refreshes at once must not end the connection.
  const p = await connect("maker");
  const [pa, pb] = await Promise.all([refresh(p.client, p.tokens.refresh_token), refresh(p.client, p.tokens.refresh_token)]);
  expect("two parallel refreshes both succeed", pb, pa.status === 200 && pb.status === 200 && pa.json.refresh_token !== pb.json.refresh_token, "200 + 200");
  assert("... and both new access tokens work", (await tools(pa.json.access_token)).length === 11 && (await tools(pb.json.access_token)).length === 11, "11 tools each", "dead");
  const pGrant = sqlNum(`select grant_id from oauth_tokens where token_hash = ${q(crypto.createHash("sha256").update(pa.json.access_token).digest("hex"))}`);
  assert("the grant is not revoked", sql(`select coalesce(revoked_reason, 'live') from oauth_grants where id = ${pGrant}`) === "live", "live", sql(`select revoked_reason from oauth_grants where id = ${pGrant}`));
  const pa2 = await refresh(p.client, pa.json.refresh_token);
  expect("one sibling refreshes on", pa2, pa2.status === 200, "200");
  const pb2 = await refresh(p.client, pb.json.refresh_token);
  expect("... which drops the other sibling (invalid_grant, no revocation)", pb2, pb2.status === 400 && pb2.json?.error === "invalid_grant" &&
    (await tools(pa2.json.access_token)).length === 11, "invalid_grant, survivor still works");
  const late = await refresh(p.client, p.tokens.refresh_token);
  expect("the original token after its successor was used -> reuse, grant revoked", late, late.status === 400 &&
    (await rpc(pa2.json.access_token, "tools/list")).status === 401, "revoked");
  const lost = await connect("maker");
  const first = await refresh(lost.client, lost.tokens.refresh_token);
  const retry = await refresh(lost.client, lost.tokens.refresh_token);
  expect("a retry right after a lost response gets a new pair", retry, first.status === 200 && retry.status === 200 && (await tools(retry.json.access_token)).length === 11, "200");
  const old = await connect("maker");
  const once = await refresh(old.client, old.tokens.refresh_token);
  sql(`update oauth_tokens set used_at = now() - interval '2 minutes' where used_at is not null and token_hash = ${q(crypto.createHash("sha256").update(old.tokens.refresh_token).digest("hex"))}`);
  const stale = await refresh(old.client, old.tokens.refresh_token);
  expect("reuse after the grace window still revokes the grant", stale, once.status === 200 && stale.status === 400 && (await rpc(once.json.access_token, "tools/list")).status === 401, "revoked");

  // RFC 7009 revocation.
  const a = await connect("maker");
  const revA = await http("POST", "/api/oauth/revoke", { form: { client_id: a.client.client_id, token: a.tokens.access_token } });
  expect("revoke access token -> 200", revA, revA.status === 200, "200");
  expect("revoked access token -> 401", await rpc(a.tokens.access_token, "tools/list"), (await rpc(a.tokens.access_token, "tools/list")).status === 401, "401");
  const r2 = await refresh(a.client, a.tokens.refresh_token);
  expect("refresh still works after revoking only the access token", r2, r2.status === 200, "200");
  const revR = await http("POST", "/api/oauth/revoke", { form: { client_id: a.client.client_id, token: r2.json.refresh_token, token_type_hint: "refresh_token" } });
  expect("revoke refresh token -> 200", revR, revR.status === 200, "200");
  const gone = await rpc(r2.json.access_token, "tools/list");
  expect("revoking the refresh token ends the grant", gone, gone.status === 401, "401");
  const unknown = await http("POST", "/api/oauth/revoke", { form: { client_id: a.client.client_id, token: "whatever" } });
  expect("unknown token revocation -> 200 (RFC 7009)", unknown, unknown.status === 200, "200");

  const e = await connect("maker");
  sql(`update oauth_tokens set expires_at = now() - interval '1 second' where kind='access'`);
  const exp = await rpc(e.tokens.access_token, "tools/list");
  expect("expired access token -> 401 invalid_token", exp, exp.status === 401 && (exp.headers.get("www-authenticate") ?? "").includes("invalid_token"), "401");
  const after = await refresh(e.client, e.tokens.refresh_token);
  expect("refresh after access expiry", after, after.status === 200 && (await tools(after.json.access_token)).length === 11, "200");
  sql(`update oauth_grants set resource = 'https://other.example/api/mcp' where id = (select grant_id from oauth_tokens where kind='access' order by id desc limit 1)`);
  const wrongRes = await rpc(after.json.access_token, "tools/list");
  expect("token for another resource -> 401", wrongRes, wrongRes.status === 401, "401");
});

group("8 grants API", async () => {
  await reset(["maker", "manager", "admin", "client"]);
  const m1 = await connect("maker");
  const m2 = await connect("maker", { scopes: [READ] });
  const mg = await connect("manager");
  const list = await call("maker", "GET", "/oauth/grants");
  const g = list.json ?? [];
  assert("maker sees own 2 grants", list.status === 200 && g.length === 2 && g.every((x) => x.user?.id === 3 && x.clientName === "Claude" && x.redirectHost === "claude.ai" &&
    !!Date.parse(x.createdAt) && !!Date.parse(x.expiresAt) && x.clientId), "2 own grants", JSON.stringify(g).slice(0, 300));
  assert("grant scopes listed", g.some((x) => x.scopes.join(" ") === READ) && g.some((x) => x.scopes.join(" ") === `${READ} ${WRITE}`), "both", JSON.stringify(g.map((x) => x.scopes)));
  await tools(m1.tokens.access_token);
  const used = (await call("maker", "GET", "/oauth/grants")).json.find((x) => x.lastUsedAt);
  assert("lastUsedAt recorded", !!used, "lastUsedAt", "none");
  const allDenied = await call("maker", "GET", "/oauth/grants?all=1");
  assert("all=1 is super_admin only", allDenied.status === 403, 403, allDenied.status);
  const all = await call("admin", "GET", "/oauth/grants?all=1");
  assert("super_admin all=1 sees everyone's", all.status === 200 && all.json.length === 3 && all.json.some((x) => x.user.id === 2), "3 grants", all.json?.length);
  const mine = await call("client", "GET", "/oauth/grants");
  assert("client sees no grants of others", mine.status === 200 && mine.json.length === 0, "[]", mine.text.slice(0, 100));

  const mgId = all.json.find((x) => x.user.id === 2).id;
  const notMine = await http("DELETE", `${BASE}/oauth/grants/${mgId}`, { headers: { cookie: cookies.maker, origin: ORIGIN } });
  expect("someone else's grant -> 404", notMine, notMine.status === 404, "404");
  const noOrigin = await http("DELETE", `${BASE}/oauth/grants/${g[0].id}`, { headers: { cookie: cookies.maker } });
  expect("DELETE without Origin -> 403", noOrigin, noOrigin.status === 403, "403");
  const m2Id = g.find((x) => x.scopes.join(" ") === READ).id;
  const del = await http("DELETE", `${BASE}/oauth/grants/${m2Id}`, { headers: { cookie: cookies.maker, origin: ORIGIN } });
  expect("revoke own grant -> 204", del, del.status === 204, "204");
  expect("its access token stops working", await rpc(m2.tokens.access_token, "tools/list"), (await rpc(m2.tokens.access_token, "tools/list")).status === 401, "401");
  const rr = await refresh(m2.client, m2.tokens.refresh_token);
  expect("its refresh token stops working", rr, rr.status === 400 && rr.json?.error === "invalid_grant", "invalid_grant");
  assert("other grant unaffected", (await tools(m1.tokens.access_token)).length === 11, 11, "tools");
  const twice = await http("DELETE", `${BASE}/oauth/grants/${m2Id}`, { headers: { cookie: cookies.maker, origin: ORIGIN } });
  expect("revoked grant -> 404", twice, twice.status === 404, "404");
  const adminDel = await http("DELETE", `${BASE}/oauth/grants/${mgId}`, { headers: { cookie: cookies.admin, origin: ORIGIN } });
  expect("super_admin revokes anyone's grant", adminDel, adminDel.status === 204 && (await rpc(mg.tokens.access_token, "tools/list")).status === 401, "204");
  assert("revocations audit-logged", sqlNum("select count(*) from audit_logs where action='connector_revoke'") === 2, 2, sqlNum("select count(*) from audit_logs where action='connector_revoke'"));
  const info = await call("maker", "GET", "/oauth/connector");
  assert("GET /oauth/connector", info.status === 200 && info.json.enabled === true && info.json.mcpUrl === MCP && info.json.issuer === ORIGIN && info.json.problem === null &&
    info.json.scopes.length === 2 && info.json.scopes.every((s) => s.available), "enabled + mcpUrl", info.text.slice(0, 200));
  const cinfo = await call("client", "GET", "/oauth/connector");
  assert("connector info: client role cannot use write", cinfo.json?.scopes?.find((s) => s.name === WRITE)?.available === false, "write unavailable", cinfo.text.slice(0, 200));
  assert("connector info needs a session", (await call(null, "GET", "/oauth/connector")).status === 401, 401, "status");
  const plain = await http("GET", `${BASE}/oauth/connector`, { headers: { cookie: cookies.maker, "x-forwarded-host": "taxaide.lan.example", "x-forwarded-proto": "http" } });
  expect("connector page never shows a non-loopback http:// URL", plain, plain.status === 200 && plain.json?.mcpUrl === null && /https/i.test(plain.json?.problem ?? ""), "mcpUrl null + problem");
  const tls = await http("GET", `${BASE}/oauth/connector`, { headers: { cookie: cookies.maker, "x-forwarded-host": "taxaide.example.com", "x-forwarded-proto": "https" } });
  expect("... and an https one behind a trusted proxy", tls, tls.status === 200 && tls.json?.mcpUrl === "https://taxaide.example.com/api/mcp" && tls.json.problem === null, "https URL");
});

group("9 account changes revoke grants", async () => {
  await reset(["maker", "admin", "manager"]);
  const live = (t) => rpc(t, "tools/list").then((r) => r.status === 200);

  const name = await connect("maker");
  await call("maker", "PATCH", "/users/3", { name: "Juan Dela Cruz" });
  assert("name change keeps the grant", await live(name.tokens.access_token), true, false);

  const own = await connect("maker");
  const pw = await call("maker", "PATCH", "/users/3", { password: "Newpass12345!", currentPassword: "accountant123" });
  assert("own password change", pw.status === 200, 200, pw.status);
  assert("... revokes the user's grants", !(await live(own.tokens.access_token)) && !(await live(name.tokens.access_token)), "401", "still live");
  const reason = sql("select distinct revoked_reason from oauth_grants where user_id=3");
  assert("revoked as password_changed", reason === "password_changed", "password_changed", reason);
  await call("admin", "PATCH", "/users/3", { password: "accountant123" });
  await login("maker");

  const adminPw = await connect("maker");
  await call("admin", "PATCH", "/users/3", { password: "Another12345!" });
  assert("admin password reset revokes", !(await live(adminPw.tokens.access_token)), "401", "still live");
  await call("admin", "PATCH", "/users/3", { password: "accountant123" });
  await login("maker");

  const role = await connect("maker");
  await call("admin", "PATCH", "/users/3", { role: "manager" });
  assert("role change revokes", !(await live(role.tokens.access_token)), "401", "still live");
  await call("admin", "PATCH", "/users/3", { role: "maker" });

  await login("client");
  const link = await connect("client");
  await call("admin", "PATCH", "/users/4", { clientId: 2 });
  assert("client re-link revokes", !(await live(link.tokens.access_token)), "401", "still live");
  await call("admin", "PATCH", "/users/4", { clientId: 1 });

  await login("orphan");
  const del = await connect("orphan");
  assert("orphan grant works before delete", await live(del.tokens.access_token), true, false);
  const d = await call("admin", "DELETE", "/users/6");
  assert("delete user", d.status === 204, 204, d.status);
  assert("deleted user's token -> 401", !(await live(del.tokens.access_token)), "401", "still live");
  assert("deleted user's grants are gone", sqlNum("select count(*) from oauth_grants where user_id=6") === 0, 0, "rows");
  const rr = await refresh(del.client, del.tokens.refresh_token);
  expect("deleted user's refresh token -> invalid_grant", rr, rr.status === 400 && rr.json?.error === "invalid_grant", "invalid_grant");

  // A code approved before the change but not yet exchanged must not mint a new grant afterwards.
  const pending = async (role) => {
    const client = await newClient();
    const { verifier, challenge } = pkce();
    return { client, verifier, code: await approvedCode(role, client, { challenge }) };
  };
  const reset1 = await pending("maker");
  await call("admin", "PATCH", "/users/3", { password: "Another12345!" });
  const late1 = await exchange(reset1.client, reset1.code, reset1.verifier);
  expect("code approved before a password reset -> invalid_grant", late1, late1.status === 400 && late1.json?.error === "invalid_grant", "invalid_grant");
  assert("... and no grant was created", sqlNum("select count(*) from oauth_grants where user_id=3 and revoked_at is null") === 0, 0, sqlNum("select count(*) from oauth_grants where user_id=3 and revoked_at is null"));
  await call("admin", "PATCH", "/users/3", { password: "accountant123" });
  await login("maker");
  const role1 = await pending("maker");
  await call("admin", "PATCH", "/users/3", { role: "manager" });
  const late2 = await exchange(role1.client, role1.code, role1.verifier);
  expect("code approved before a role change -> invalid_grant", late2, late2.status === 400 && late2.json?.error === "invalid_grant", "invalid_grant");
  await call("admin", "PATCH", "/users/3", { role: "maker" });
  const conn = await connect("maker");
  const { verifier: v3, challenge: c3 } = pkce();
  const code3 = await approvedCode("maker", conn.client, { challenge: c3 });
  const gid = sqlNum(`select grant_id from oauth_tokens where token_hash = ${q(crypto.createHash("sha256").update(conn.tokens.access_token).digest("hex"))}`);
  const disc = await http("DELETE", `${BASE}/oauth/grants/${gid}`, { headers: { cookie: cookies.maker, origin: ORIGIN } });
  const late3 = await exchange(conn.client, code3, v3);
  expect("disconnecting ends codes of the same app not yet exchanged", late3, disc.status === 204 && late3.status === 400 && late3.json?.error === "invalid_grant", "204 then invalid_grant");
  const other = await pending("maker");
  const otherGrant = (await connect("maker")).tokens.access_token;
  const og = sqlNum(`select grant_id from oauth_tokens where token_hash = ${q(crypto.createHash("sha256").update(otherGrant).digest("hex"))}`);
  await http("DELETE", `${BASE}/oauth/grants/${og}`, { headers: { cookie: cookies.maker, origin: ORIGIN } });
  const otherEx = await exchange(other.client, other.code, other.verifier);
  expect("... but not another app's pending code", otherEx, otherEx.status === 200, "200");

  const keep = await connect("manager");
  await call("admin", "PATCH", "/users/3", { role: "manager" });
  assert("another user's change leaves this grant alone", await live(keep.tokens.access_token), true, false);
  await call("admin", "PATCH", "/users/3", { role: "maker" });
});

group("10 MCP protocol + tools per role", async () => {
  await reset(Object.keys({ admin: 1, manager: 1, maker: 1, client: 1, clientb: 1, orphan: 1, viewer: 1 }));
  const tok = {};
  for (const role of ["admin", "manager", "maker", "client", "clientb", "orphan", "viewer"]) tok[role] = (await connect(role)).tokens.access_token;
  tok.makerRead = (await connect("maker", { scopes: [READ] })).tokens.access_token;

  const init = await rpc(tok.maker, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0" } });
  const ir = init.json?.result ?? {};
  expect("initialize", init, init.status === 200 && ir.serverInfo?.name === "TaxAide" && ir.protocolVersion === "2025-06-18" && !!ir.capabilities?.tools &&
    ir.instructions?.includes("Juan Dela Cruz") && ir.instructions.includes("Write tools are enabled") && !init.headers.get("mcp-session-id"), "TaxAide, stateless");
  const initRead = await rpc(tok.makerRead, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  assert("read-only grant: instructions say read-only", initRead.json?.result?.instructions?.includes("read-only"), "read-only", initRead.text.slice(0, 100));
  const initClient = await rpc(tok.client, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  assert("client: instructions say own company only", initClient.json?.result?.instructions?.includes("client account"), "client account", initClient.text.slice(0, 100));
  const badVer = await mcp(tok.maker, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "1999-01-01" });
  expect("unsupported MCP-Protocol-Version -> 400", badVer, badVer.status === 400, "400");
  const badAccept = await mcp(tok.maker, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json" });
  expect("Accept without text/event-stream -> 406", badAccept, badAccept.status === 406, "406");
  const parse = await http("POST", MCP, { headers: { authorization: `Bearer ${tok.maker}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  expect("empty / invalid JSON body -> JSON-RPC error", parse, parse.status >= 400 && parse.status < 500, "4xx");
  const note = await mcp(tok.maker, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect("notification -> 202", note, note.status === 202, "202");

  const all = [...READ_TOOLS, ...WRITE_TOOLS].sort().join();
  for (const role of ["admin", "manager", "maker"]) {
    const t = await tools(tok[role]);
    assert(`${role} with write scope: 11 tools`, t.join() === all, all, t.join());
  }
  for (const role of ["makerRead", "client", "clientb", "orphan", "viewer"]) {
    const t = await tools(tok[role]);
    assert(`${role}: read tools only`, t.join() === READ_TOOLS.join(), READ_TOOLS.join(), t.join());
  }
  const list = (await rpc(tok.maker, "tools/list")).json.result.tools;
  assert("every tool has a title and annotations", list.every((t) => t.title && t.annotations?.title && typeof t.annotations.readOnlyHint === "boolean" && t.annotations.openWorldHint === false && t.inputSchema?.type === "object"), "titles + hints", JSON.stringify(list.map((t) => [t.name, t.annotations])));
  assert("read tools readOnlyHint", list.filter((t) => READ_TOOLS.includes(t.name)).every((t) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false), "readOnly", "");
  const ann = Object.fromEntries(list.map((t) => [t.name, t.annotations]));
  assert("write tool hints", ann.add_filing_comment.readOnlyHint === false && ann.add_filing_comment.destructiveHint === false && ann.add_filing_comment.idempotentHint === false &&
    ann.set_deadline_notes.destructiveHint === true && ann.set_deadline_notes.idempotentHint === true && ann.update_checklist_item.destructiveHint === true, "hints", JSON.stringify(ann));

  const names = async (role) => (await callTool(tok[role], "find_clients")).data?.clients?.map((c) => c.name).sort().join() ?? "";
  assert("staff find_clients sees all", (await names("maker")) === "Alpha Corp,Bravo Inc", "Alpha Corp,Bravo Inc", await names("maker"));
  assert("client find_clients sees Alpha only", (await names("client")) === "Alpha Corp", "Alpha Corp", await names("client"));
  assert("viewer find_clients sees Alpha only", (await names("viewer")) === "Alpha Corp", "Alpha Corp", await names("viewer"));
  assert("clientb find_clients sees Bravo only", (await names("clientb")) === "Bravo Inc", "Bravo Inc", await names("clientb"));
  const orphan = await callTool(tok.orphan, "find_clients");
  assert("unlinked client sees nothing", orphan.isError && orphan.text.includes("not linked"), "not linked", orphan.text);
  const orphanFiling = await callTool(tok.orphan, "get_filing", { engagement_id: 1 });
  assert("unlinked client get_filing -> not found", orphanFiling.isError && /not found/i.test(orphanFiling.text), "not found", orphanFiling.text);

  const f2 = await callTool(tok.client, "get_filing", { engagement_id: 2 });
  assert("client: Bravo's filing looks not found", f2.isError && /not found/i.test(f2.text), "not found", f2.text);
  const f99 = await callTool(tok.client, "get_filing", { engagement_id: 99 });
  assert("... same message as a missing filing", f99.isError && f99.text === f2.text, f2.text, f99.text);
  const c2 = await callTool(tok.client, "get_client", { client_id: 2 });
  assert("client: other client's profile -> not found", c2.isError && /not found/i.test(c2.text), "not found", c2.text);
  const comp = await callTool(tok.client, "get_client_compliance", { client_id: 2 });
  assert("client: other client's compliance -> not found", comp.isError, "error", comp.text);
  const d = await callTool(tok.client, "list_deadlines");
  assert("client list_deadlines: own only", !d.isError && d.data.deadlines.length > 0 && d.data.deadlines.every((x) => x.client?.id === 1), "Alpha deadlines", d.text.slice(0, 200));
  const docs = await callTool(tok.client, "list_documents", { client_id: 2 });
  assert("client list_documents other client -> not found", docs.isError, "error", docs.text);
  const docsOwn = await callTool(tok.client, "list_documents", { engagement_id: 2 });
  assert("client list_documents of Bravo's filing -> nothing", !docsOwn.isError && docsOwn.data.documents.length === 0, "[]", docsOwn.text.slice(0, 200));
  const fl = await callTool(tok.clientb, "list_filings");
  assert("clientb list_filings: Bravo only", !fl.isError && fl.data.filings.length === 1 && fl.data.filings[0].client.id === 2, "1 filing", fl.text.slice(0, 200));
  const staffFiling = await callTool(tok.manager, "get_filing", { engagement_id: 2 });
  assert("staff get_filing", !staffFiling.isError && staffFiling.data.id === 2 && staffFiling.structured?.id === 2, "filing 2", staffFiling.text.slice(0, 120));
  assert("get_filing checklist items carry their ids", staffFiling.data.checklist?.length === 1 && staffFiling.data.checklist[0].id === 2 &&
    staffFiling.data.checklist[0].label === "Bravo sales book", "[{id:2,…}]", JSON.stringify(staffFiling.data.checklist));
  sql("update deadlines set description = 'Client promised docs by Friday' where id = 3");
  const dl = await callTool(tok.manager, "list_deadlines");
  assert("list_deadlines returns each deadline's notes", dl.data?.deadlines?.find((x) => x.id === 3)?.notes === "Client promised docs by Friday" &&
    dl.data.deadlines.every((x) => "notes" in x), "notes", JSON.stringify(dl.data?.deadlines?.find((x) => x.id === 3)));
  sql("update deadlines set description = null where id = 3");
  const secrets = JSON.stringify(staffFiling.raw.json) + (await callTool(tok.admin, "list_documents")).text + (await callTool(tok.admin, "get_client", { client_id: 1 })).text;
  assert("no hashes / storage paths / tokens in results", !/password|hash|filename|file_url|fileUrl|storage|taxaide_(at|rt)_/i.test(secrets), "clean", secrets.match(/password|hash|filename|file_url|fileUrl|storage|taxaide_(at|rt)_/i)?.[0]);
  const wl = await callTool(tok.viewer, "workload_overview");
  assert("viewer workload_overview", !wl.isError && wl.data.myOpenFilings === undefined, "client numbers", wl.text.slice(0, 120));
  const invalid = await callTool(tok.maker, "list_deadlines", { limit: 999 });
  assert("invalid tool input -> isError", invalid.isError && /invalid|validation/i.test(invalid.text), "validation error", invalid.text.slice(0, 120));
  const unknown = await callTool(tok.maker, "delete_everything");
  assert("unknown tool -> error", unknown.isError || !!unknown.raw.json?.error, "error", unknown.raw.text.slice(0, 120));
});

group("11 write tools", async () => {
  await reset(["maker", "client", "manager"]);
  const maker = (await connect("maker")).tokens.access_token;
  const makerRead = (await connect("maker", { scopes: [READ] })).tokens.access_token;
  const client = (await connect("client")).tokens.access_token;
  const manager = (await connect("manager")).tokens.access_token;
  const grantId = sqlNum("select g.id from oauth_grants g where user_id=3 and 'taxaide.write' = any(scopes)");

  const c = await callTool(maker, "add_filing_comment", { engagement_id: 2, content: "Asked the client for the Q1 sales book." });
  assert("add_filing_comment", !c.isError && c.data.comment?.engagementId === 2 && c.data.comment.author === "Juan Dela Cruz", "comment", c.text.slice(0, 200));
  const row = sql("select author_id||'|'||is_approval||'|'||content from comments where id = (select max(id) from comments)");
  assert("comment stored as the maker, not an approval", row === "3|false|Asked the client for the Q1 sales book.", "3|false|…", row);
  const audit = sql("select description||'|'||metadata from audit_logs where action='comment' order by id desc limit 1");
  const meta = parseJson(audit.split("|").slice(1).join("|")) ?? {};
  assert("audit log says it came through the connector", audit.startsWith("Added comment on engagement (via Claude connector)") && meta.via === "claude_connector" &&
    meta.grantId === grantId && meta.oauthClientName === "Claude" && typeof meta.oauthClientId === "string", "via claude_connector", audit);
  const httpComment = await call("maker", "POST", "/comments", { engagementId: 1, content: "web" });
  const webAudit = sql("select description||'|'||coalesce(metadata,'') from audit_logs where action='comment' order by id desc limit 1");
  assert("HTTP route still works and is not marked as connector", httpComment.status === 201 && webAudit === "Added comment on engagement|", "Added comment on engagement|", webAudit);
  const empty = await callTool(maker, "add_filing_comment", { engagement_id: 2, content: "   " });
  assert("empty comment -> same rule as the route", empty.isError && empty.text === "Comment cannot be empty", "Comment cannot be empty", empty.text);
  const missing = await callTool(maker, "add_filing_comment", { engagement_id: 99, content: "x" });
  assert("missing filing -> Engagement not found", missing.isError && missing.text === "Engagement not found", "Engagement not found", missing.text);

  sql("update deadlines set description = 'Old staff note' where id = 3");
  const n = await callTool(maker, "set_deadline_notes", { deadline_id: 3, notes: "BIR extension requested" });
  assert("set_deadline_notes", !n.isError && n.data.deadline?.notes === "BIR extension requested" && n.data.previousNotes === "Old staff note", "notes + previousNotes", n.text.slice(0, 200));
  assert("deadline description updated", sql("select description from deadlines where id=3") === "BIR extension requested", "updated", sql("select description from deadlines where id=3"));
  assert("deadline audit via connector", sql("select description from audit_logs where entity_type='deadline' order by id desc limit 1") === 'Updated deadline "Bravo manual deadline" (via Claude connector)', "audit", sql("select description from audit_logs where entity_type='deadline' order by id desc limit 1"));
  const cleared = await callTool(manager, "set_deadline_notes", { deadline_id: 3, notes: null });
  assert("manager clears notes", !cleared.isError && cleared.data.deadline.notes === null, "null", cleared.text.slice(0, 120));
  const nd = await callTool(maker, "set_deadline_notes", { deadline_id: 99, notes: "x" });
  assert("missing deadline -> not found", nd.isError && nd.text === "Deadline not found", "Deadline not found", nd.text);

  // The model takes the ids from get_filing, as the tool description says.
  const filing2 = await callTool(maker, "get_filing", { engagement_id: 2 });
  const itemId = filing2.data?.checklist?.[0]?.id;
  const i = await callTool(maker, "update_checklist_item", { engagement_id: 2, item_id: itemId, status: "received", notes: "Got it" });
  assert("update_checklist_item with the ids from get_filing", !i.isError && i.data.checklistItem?.id === itemId && i.data.checklistItem.status === "received" &&
    i.data.checklistItem.notes === "Got it", "received", i.text.slice(0, 200));
  assert("checklist completed_by = maker", sql("select status||'|'||completed_by from checklist_items where id=2") === "received|3", "received|3", sql("select status||'|'||completed_by from checklist_items where id=2"));
  const wrongFiling = await callTool(maker, "update_checklist_item", { engagement_id: 2, item_id: 1, status: "received" });
  assert("an item of another filing is refused", wrongFiling.isError && /not found on this filing/i.test(wrongFiling.text) &&
    sql("select status||'|'||coalesce(completed_by::text,'') from checklist_items where id=1") === "pending|", "refused, Alpha's item unchanged", wrongFiling.text);
  const noFiling = await callTool(maker, "update_checklist_item", { item_id: 2, status: "filed" });
  assert("update_checklist_item requires engagement_id", noFiling.isError && sql("select status from checklist_items where id=2") === "received", "validation error", noFiling.text);
  const missingItem = await callTool(maker, "update_checklist_item", { engagement_id: 2, item_id: 999, status: "filed" });
  assert("missing item -> not found on this filing", missingItem.isError && /not found on this filing/i.test(missingItem.text), "not found", missingItem.text);
  const noop = await callTool(maker, "update_checklist_item", { engagement_id: 2, item_id: 2 });
  assert("update_checklist_item needs status or notes", noop.isError, "error", noop.text);
  const badStatus = await callTool(maker, "update_checklist_item", { engagement_id: 2, item_id: 2, status: "approved" });
  assert("invalid checklist status rejected", badStatus.isError, "error", badStatus.text);

  const stepUp = await rpc(makerRead, "tools/call", { name: "add_filing_comment", arguments: { engagement_id: 2, content: "x" } });
  const www = stepUp.headers.get("www-authenticate") ?? "";
  expect("read-only grant calling a write tool -> 403 insufficient_scope", stepUp, stepUp.status === 403 && www.includes('error="insufficient_scope"') &&
    www.includes(`scope="${READ} ${WRITE}"`) && www.includes("resource_metadata="), "403 step-up");
  const viaClient = await callTool(client, "add_filing_comment", { engagement_id: 1, content: "client note" });
  assert("client account cannot write (tool not available)", viaClient.status === 200 && viaClient.isError && /unknown tool|not found/i.test(viaClient.text), "unknown tool", viaClient.text);
  const before = sqlNum("select count(*) from comments");
  await callTool(client, "set_deadline_notes", { deadline_id: 1, notes: "x" });
  assert("nothing written by the client", sqlNum("select count(*) from comments") === before && sql("select coalesce(description,'') from deadlines where id=1") === "", "unchanged", "changed");

  // A role downgrade revokes the grant (group 9); a stale write-scoped token cannot outlive it.
  sql("update users set role='client', client_id=1 where id=3");
  const demoted = await callTool(maker, "add_filing_comment", { engagement_id: 1, content: "after demotion" });
  assert("role change applies immediately to tools", demoted.isError && sqlNum("select count(*) from comments where content='after demotion'") === 0, "refused", demoted.text);
  sql("update users set role='maker', client_id=null where id=3");
});

await main({ reset: () => reset([]) });
