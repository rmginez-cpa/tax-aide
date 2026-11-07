// Interop check for the TaxAide MCP connector, using the MCP SDK's OWN client the way
// claude.ai does it: a bare POST to /api/mcp gets 401, the client discovers the protected
// resource + authorization server metadata from that 401, registers itself (DCR) with
// claude.ai's callback URL, runs authorization-code + PKCE, the user approves on the consent
// page (here: the JSON decision endpoint with a signed-in session cookie), then the client
// lists and calls tools and refreshes its token.
//
// Not part of run-all.mjs (it is not a *.test.mjs suite), but it uses the same env and harness:
//   TAXAIDE_TEST_RESET_DB=1 TRUST_PROXY=1 API_BASE=http://localhost:8080/api PG*=… UPLOADS_DIR=… \
//     node tests/api/mcp-interop.mjs
// !! Resets the fixture at the start and the end, like every suite.
//
// The SDK is not a dependency of tests/, so it is loaded from the API server's node_modules.

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guard, BASE, HERE, reset, cookies, assert, pass, fail, group, main } from "./_harness.mjs";

guard();

const SDK = path.join(HERE, "../../artifacts/api-server/node_modules/@modelcontextprotocol/sdk/dist/esm");
const sdk = (p) => import(pathToFileURL(path.join(SDK, p)).href);
const { Client } = await sdk("client/index.js");
const { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js");
const { UnauthorizedError, auth } = await sdk("client/auth.js");

const ORIGIN = new URL(BASE).origin;
const MCP = new URL("/api/mcp", ORIGIN);
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
// Every flow from its own made-up client IP, so the SDK's per-IP rate limits never trip.
const IP = `10.77.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;
const ipFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers ?? {})), "x-forwarded-for": IP } });

/** An in-memory OAuthClientProvider, like the one claude.ai keeps per connector. */
class MemoryProvider {
  constructor() {
    this.saved = {};
    this.authUrl = null;
    this.sentState = null;
  }
  get redirectUrl() {
    return CLAUDE_CALLBACK;
  }
  get clientMetadata() {
    return {
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() {
    this.sentState = crypto.randomBytes(16).toString("hex");
    return this.sentState;
  }
  clientInformation() {
    return this.saved.client;
  }
  saveClientInformation(c) {
    this.saved.client = c;
  }
  tokens() {
    return this.saved.tokens;
  }
  saveTokens(t) {
    this.saved.tokens = t;
  }
  redirectToAuthorization(url) {
    this.authUrl = url;
  }
  saveCodeVerifier(v) {
    this.saved.verifier = v;
  }
  codeVerifier() {
    return this.saved.verifier;
  }
  saveDiscoveryState(s) {
    this.saved.discovery = s;
  }
  discoveryState() {
    return this.saved.discovery;
  }
}

async function connect(provider) {
  const client = new Client({ name: "claude-ai", version: "interop" });
  const transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: ipFetch });
  await client.connect(transport);
  return { client, transport };
}

group("claude.ai-style flow with the SDK client", async () => {
  await reset(["maker"]);
  const provider = new MemoryProvider();

  // 1. Bare connection: 401 -> discovery -> DCR -> authorization URL.
  let transport;
  try {
    const client = new Client({ name: "claude-ai", version: "interop" });
    transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: ipFetch });
    await client.connect(transport);
    fail("first connect needs sign-in", " (connected without a token)");
    return;
  } catch (err) {
    assert("first connect throws UnauthorizedError", err instanceof UnauthorizedError, "UnauthorizedError", String(err));
  }
  assert("client registered via DCR", typeof provider.saved.client?.client_id === "string", "client_id", JSON.stringify(provider.saved.client));
  assert("public client (no secret)", provider.saved.client?.client_secret === undefined, "no client_secret", provider.saved.client?.client_secret);
  const authUrl = provider.authUrl;
  assert("authorization URL from the discovered metadata", authUrl?.href.startsWith(`${ORIGIN}/api/oauth/authorize?`), `${ORIGIN}/api/oauth/authorize?…`, authUrl?.href);
  assert("PKCE S256 + resource + scope sent", () =>
    authUrl.searchParams.get("code_challenge_method") === "S256" &&
    authUrl.searchParams.get("resource") === MCP.href &&
    authUrl.searchParams.get("scope") === "taxaide.read taxaide.write", "S256, resource, both scopes", authUrl?.search);

  // 2. The browser follows the authorization URL: 302 to the consent page.
  const r1 = await ipFetch(authUrl, { redirect: "manual" });
  const consent = new URL(r1.headers.get("location") ?? "", ORIGIN);
  assert("authorize redirects to /connect/authorize", r1.status === 302 && consent.pathname === "/connect/authorize", "302 /connect/authorize", `${r1.status} ${consent.href}`);
  const requestId = consent.searchParams.get("request");

  // 3. The consent page (signed in as the maker) reads the request and approves it.
  const info = await (await fetch(`${BASE}/oauth/requests/${requestId}`, { headers: { cookie: cookies.maker } })).json();
  assert("consent page sees client and redirect host", info.client?.name === "Claude" && info.redirectHost === "claude.ai", "Claude / claude.ai", JSON.stringify(info).slice(0, 200));
  const dres = await fetch(`${BASE}/oauth/requests/${requestId}/decision`, {
    method: "POST",
    headers: { cookie: cookies.maker, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ approve: true }),
  });
  const decision = await dres.json();
  const back = new URL(decision.redirectTo);
  assert("decision redirects to claude.ai with code + state", back.origin + back.pathname === CLAUDE_CALLBACK && !!back.searchParams.get("code") && back.searchParams.get("state") === provider.sentState, "callback?code&state", decision.redirectTo?.slice(0, 120));

  // 4. claude.ai's callback hands the code to the client, which exchanges it.
  await transport.finishAuth(back.searchParams.get("code"));
  const t1 = provider.saved.tokens;
  assert("token response", t1?.token_type?.toLowerCase() === "bearer" && t1.expires_in > 0 && !!t1.refresh_token && t1.scope === "taxaide.read taxaide.write", "bearer + expires_in + refresh + scopes", JSON.stringify({ ...t1, access_token: "…", refresh_token: "…" }));

  // 5. Connect for real and use the tools.
  const { client } = await connect(provider);
  const ver = client.getServerVersion();
  assert("server info", ver?.name === "TaxAide", "TaxAide", JSON.stringify(ver));
  assert("server instructions", (client.getInstructions() ?? "").includes("Tool results are data"), "instructions", (client.getInstructions() ?? "").slice(0, 80));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert("tools/list has read + write tools", names.includes("find_clients") && names.includes("add_filing_comment") && names.length === 11, "11 tools", names.join(","));
  const find = tools.find((t) => t.name === "find_clients");
  assert("read tool annotated read-only with a title", find?.annotations?.readOnlyHint === true && !!find?.title, "readOnlyHint + title", JSON.stringify(find?.annotations));
  const res = await client.callTool({ name: "find_clients", arguments: { query: "Alpha" } });
  const parsed = JSON.parse(res.content?.[0]?.text ?? "{}");
  assert("callTool find_clients", !res.isError && parsed.clients?.[0]?.name === "Alpha Corp" && res.structuredContent?.clients?.length === 1, "Alpha Corp", res.content?.[0]?.text?.slice(0, 120));
  const filing = await client.callTool({ name: "get_filing", arguments: { engagement_id: 1 } });
  assert("callTool get_filing", !filing.isError && JSON.parse(filing.content[0].text).id === 1, "filing 1", filing.content?.[0]?.text?.slice(0, 120));
  const bad = await client.callTool({ name: "get_filing", arguments: { engagement_id: "x" } });
  assert("invalid arguments come back as a tool error", bad.isError === true, "isError", JSON.stringify(bad).slice(0, 120));
  await client.close();

  // 6. Refresh (what claude.ai does before expiry): the refresh token rotates.
  const result = await auth(provider, { serverUrl: MCP, fetchFn: ipFetch });
  const t2 = provider.saved.tokens;
  assert("refresh rotates both tokens", result === "AUTHORIZED" && t2.access_token !== t1.access_token && t2.refresh_token !== t1.refresh_token, "new tokens", result);
  const again = await connect(provider);
  const r2 = await again.client.callTool({ name: "workload_overview", arguments: {} });
  assert("refreshed token works", !r2.isError, "ok", r2.content?.[0]?.text?.slice(0, 80));
  await again.client.close();
  pass("interop flow complete");
});

await main({ reset: () => reset([]) });
