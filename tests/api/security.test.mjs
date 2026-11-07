// TaxAide session / login hardening integration tests.
// Dependency-free Node 22+ ES module. Tests a running API (default http://localhost:8080/api)
// and resets the Postgres fixture (fixture.sql) at the start and the end.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md. Recommended server env (the same variables are read here):
//   TRUST_PROXY=1   the server takes the client IP from X-Forwarded-For, so every
//                   rate-limit scenario uses its own made-up IP and never locks out
//                   localhost (which would break authz.test.mjs for 15 minutes).
//                   Without it the per-IP scenarios are skipped.
//   LOGIN_MAX_FAILURES_PER_EMAIL / LOGIN_MAX_FAILURES_PER_IP  if the server was started
//                   with non-default limits (defaults 5 / 50), pass the same values here.
//   ALLOWED_ORIGINS if set on the server, also set it here so the allowed-origin case runs.
// Env:  API_BASE, FIXTURE, UPLOADS_DIR (must equal the server's UPLOADS_DIR),
//       PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>

import crypto from "node:crypto";
import {
  guard, BASE, sql, resetDb as reset, sidOf, setCookies, parseJson, pass, fail, skip, group, main,
} from "./_harness.mjs";

guard();

const PROXY = !!process.env.TRUST_PROXY && !["false", "0", "no", "off"].includes(process.env.TRUST_PROXY.toLowerCase());
const MAX_PER_EMAIL = Number(process.env.LOGIN_MAX_FAILURES_PER_EMAIL || 5);
const MAX_PER_IP = Number(process.env.LOGIN_MAX_FAILURES_PER_IP || 50);
const MAX_PER_ACCOUNT = Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT || 20);
const WINDOW_SECONDS = Number(process.env.LOGIN_FAILURE_WINDOW_MINUTES || 15) * 60;
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const ADMIN = ["admin@firm.ph", "admin123"];
const MANAGER = ["manager@firm.ph", "manager123"];

// ── HTTP ─────────────────────────────────────────────────────────────────────
// This suite sends its own requests (made-up client IPs, raw bodies, timings) instead of
// the harness's role-based call(). reset() is the harness's resetDb(): no sign-ins.
/** A made-up client IP (only honoured by a server running with TRUST_PROXY). */
function fakeIp() {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2] || 1}`;
}
function setCookieLine(res) {
  return setCookies(res).find((c) => c.startsWith("connect.sid=")) ?? "";
}

async function call(method, urlPath, { body, cookie, ip, headers: extra = {}, raw } = {}) {
  const headers = { ...extra };
  if (cookie) headers.Cookie = cookie;
  if (ip) headers["X-Forwarded-For"] = ip;
  let payload;
  if (raw !== undefined) {
    headers["Content-Type"] ??= "application/json";
    payload = raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const started = performance.now();
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  const ms = performance.now() - started;
  return { status: res.status, headers: res.headers, text, json: parseJson(text), ms, res };
}

function login(email, password, opts = {}) {
  return call("POST", "/auth/login", { ...opts, body: { email, password } });
}

async function loginOk(email, password, opts = {}) {
  const r = await login(email, password, opts);
  const sid = sidOf(r.res);
  if (r.status !== 200 || !sid) throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return sid;
}

// ── Runner ───────────────────────────────────────────────────────────────────
function assert(name, ok, got) {
  if (ok) pass(name);
  else fail(name, got !== undefined ? ` (got ${typeof got === "string" ? got : JSON.stringify(got)})` : "");
}
function short(r) {
  return `${r.status} ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
group("1 auth config", async () => {
  const r = await call("GET", "/auth/config");
  assert("GET /auth/config needs no session (200)", r.status === 200, short(r));
  assert("GET /auth/config is exactly { demoAccounts: boolean }",
    r.json && typeof r.json.demoAccounts === "boolean" && Object.keys(r.json).length === 1, r.json);
  // This suite signs in with the demo accounts, so the server must have them enabled.
  assert("demoAccounts is true on a server that seeded the demo users", r.json?.demoAccounts === true, r.json);
});

group("2 session cookie and fixation", async () => {
  const ip = fakeIp();
  const r1 = await login(...ADMIN, { ip });
  const sid1 = sidOf(r1.res);
  assert("admin login 200 with a connect.sid cookie", r1.status === 200 && !!sid1, short(r1));
  const line = setCookieLine(r1.res);
  assert("session cookie is HttpOnly", /;\s*HttpOnly/i.test(line), line);
  assert("session cookie is SameSite=Lax", /;\s*SameSite=Lax/i.test(line), line);
  assert("session cookie Path=/", /;\s*Path=\//i.test(line), line);

  // Sign in as someone else while presenting the old cookie: a new id must be issued
  // and the old session must be gone (session fixation).
  const r2 = await login(...MANAGER, { ip, cookie: sid1 });
  const sid2 = sidOf(r2.res);
  assert("second login (with old cookie) 200 + cookie", r2.status === 200 && !!sid2, short(r2));
  assert("session id changes on login", sid2 && sid2 !== sid1, `${sid1} -> ${sid2}`);
  const me1 = await call("GET", "/auth/me", { cookie: sid1 });
  assert("pre-login session id no longer valid", me1.status === 401, short(me1));
  const me2 = await call("GET", "/auth/me", { cookie: sid2 });
  assert("new session belongs to the new user", me2.status === 200 && me2.json?.email === MANAGER[0], short(me2));

  // Logout destroys the session and clears the cookie.
  const out = await call("POST", "/auth/logout", { cookie: sid2 });
  assert("logout 200", out.status === 200, short(out));
  const cleared = setCookieLine(out.res);
  assert("logout clears connect.sid", /^connect\.sid=;/.test(cleared) && /Expires=Thu, 01 Jan 1970/i.test(cleared), cleared);
  const me3 = await call("GET", "/auth/me", { cookie: sid2 });
  assert("old session cookie invalid after logout", me3.status === 401, short(me3));
  const rows = sql(`select count(*) from user_sessions where sid = '${decodeURIComponent(sid2.slice("connect.sid=".length)).replace(/^s:/, "").split(".")[0].replace(/'/g, "")}'`);
  assert("logged-out session row deleted from user_sessions", rows === "0", rows);
});

group("3 email normalisation", async () => {
  const ip = fakeIp();
  const r = await login("  ADMIN@Firm.PH  ", ADMIN[1], { ip });
  assert("login with upper-case email + spaces succeeds", r.status === 200 && r.json?.user?.email === ADMIN[0], short(r));
  const bad = await login("ADMIN@FIRM.PH", "wrong-password", { ip });
  assert("wrong password still 401 with the same generic error", bad.status === 401 && bad.json?.error === "Invalid credentials", short(bad));
  const none = await login(`nobody-${Date.now()}@example.com`, "whatever1", { ip });
  assert("unknown email gives the same 401 body", none.status === 401 && none.json?.error === "Invalid credentials", short(none));
  // Clear that one failure for the admin email on this IP.
  await loginOk(...ADMIN, { ip });
});

group("4 timing does not reveal accounts", async () => {
  const ip = fakeIp();
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const known = [];
  const unknown = [];
  for (let i = 0; i < 3; i++) {
    known.push((await login(ADMIN[0], `wrong-${i}-xyz`, { ip })).ms);
    unknown.push((await login(`ghost-${Date.now()}-${i}@example.com`, "wrong-xyz", { ip })).ms);
  }
  await loginOk(...ADMIN, { ip }); // clear the admin counter for this IP
  const k = median(known);
  const u = median(unknown);
  // Without a dummy bcrypt compare an unknown email answers in ~1-2 ms vs ~50+ ms.
  assert(`unknown-email login takes comparable time (known ${k.toFixed(0)} ms, unknown ${u.toFixed(0)} ms)`, u > k * 0.4, { k, u });
});

group("5 failed-login rate limiting", async () => {
  if (!PROXY) {
    console.log("(TRUST_PROXY not set: failures below count against this machine's real IP)");
  }
  const ip = PROXY ? fakeIp() : undefined;
  const victim = `ratelimit-${Date.now()}@example.com`;
  const statuses = [];
  let last;
  for (let i = 0; i < MAX_PER_EMAIL + 1; i++) {
    last = await login(victim, `bad-password-${i}`, { ip });
    statuses.push(last.status);
  }
  assert(`first ${MAX_PER_EMAIL} bad passwords -> 401`, statuses.slice(0, MAX_PER_EMAIL).every((s) => s === 401), statuses);
  assert(`attempt ${MAX_PER_EMAIL + 1} -> 429`, last.status === 429, short(last));
  const ra = Number(last.headers.get("retry-after"));
  assert("429 has a Retry-After in seconds within the window", Number.isInteger(ra) && ra > 0 && ra <= WINDOW_SECONDS, last.headers.get("retry-after"));
  assert("429 has a friendly JSON message", typeof last.json?.error === "string" && /too many/i.test(last.json.error), last.json);
  const again = await login(victim, "bad-password-again", { ip });
  assert("still 429 while locked", again.status === 429, short(again));

  const other = await login(...ADMIN, { ip });
  assert("good login for a different email from the same IP still works", other.status === 200, short(other));

  if (PROXY) {
    const elsewhere = await login(victim, "bad-password-x", { ip: fakeIp() });
    assert("same email from another IP is not locked (limit is per IP + email)", elsewhere.status === 401, short(elsewhere));
  } else {
    skip("same email from another IP is not locked", "needs TRUST_PROXY=1");
  }

  // A successful login clears that (IP, email) counter.
  if (PROXY) {
    const ip2 = fakeIp();
    for (let i = 0; i < MAX_PER_EMAIL - 1; i++) await login(...[MANAGER[0], `nope-${i}`], { ip: ip2 });
    const ok1 = await login(...MANAGER, { ip: ip2 });
    for (let i = 0; i < MAX_PER_EMAIL - 1; i++) await login(...[MANAGER[0], `nope2-${i}`], { ip: ip2 });
    const ok2 = await login(...MANAGER, { ip: ip2 });
    assert("success resets the (IP, email) counter", ok1.status === 200 && ok2.status === 200, `${ok1.status} ${ok2.status}`);
  } else {
    skip("success resets the (IP, email) counter", "needs TRUST_PROXY=1");
  }
});

group("6 per-IP rate limiting", async () => {
  if (!PROXY) {
    skip("per-IP limit", "needs TRUST_PROXY=1 (would lock out this machine)");
    return;
  }
  const ip = fakeIp();
  const stamp = Date.now();
  // Spread failures over many emails so no (IP, email) pair reaches its own limit.
  const perEmail = Math.max(1, MAX_PER_EMAIL - 1);
  let n = 0;
  const batch = [];
  while (n < MAX_PER_IP) {
    const email = `spray-${stamp}-${Math.floor(n / perEmail)}@example.com`;
    batch.push(login(email, `bad-${n}`, { ip }));
    n++;
    if (batch.length === 10) await Promise.all(batch.splice(0));
  }
  const settled = await Promise.all(batch);
  void settled;
  const blocked = await login(...ADMIN, { ip });
  assert(`after ${MAX_PER_IP} failures from one IP, even a correct password -> 429`, blocked.status === 429 && !!blocked.headers.get("retry-after"), short(blocked));
  const fine = await login(...ADMIN, { ip: fakeIp() });
  assert("another IP is unaffected", fine.status === 200, short(fine));
});

group("6b IPv6 /64 grouping and the per-account limit", async () => {
  if (!PROXY) {
    skip("IPv6 grouping / per-account limit", "needs TRUST_PROXY=1 (would lock out this machine)");
    return;
  }
  // One /64: every address in it counts as the same client.
  const b = crypto.randomBytes(4).toString("hex");
  const net = `2001:db8:${b.slice(0, 4)}:${b.slice(4)}`;
  const victim = `v6-${Date.now()}@example.com`;
  const statuses = [];
  for (let i = 0; i < MAX_PER_EMAIL + 1; i++) {
    statuses.push((await login(victim, `bad-${i}`, { ip: `${net}::${(0x101 + i).toString(16)}` })).status);
  }
  assert(`${MAX_PER_EMAIL + 1} bad passwords from different addresses in one IPv6 /64 -> 401 x${MAX_PER_EMAIL} then 429`,
    statuses.slice(0, MAX_PER_EMAIL).every((s) => s === 401) && statuses[MAX_PER_EMAIL] === 429, statuses);
  const longForm = await login(victim, "bad-long", { ip: `${net}:0:0:0:ffff` });
  assert("…an uncompressed address in that /64 is blocked too", longForm.status === 429, short(longForm));

  // IPv4-mapped IPv6 and plain IPv4 are the same client.
  const v4 = fakeIp();
  const mapped = `mapped-${Date.now()}@example.com`;
  for (let i = 0; i < MAX_PER_EMAIL; i++) await login(mapped, `bad-${i}`, { ip: i % 2 ? v4 : `::ffff:${v4}` });
  const m = await login(mapped, "bad-x", { ip: v4 });
  assert("IPv4 and its IPv4-mapped IPv6 form share one counter (429)", m.status === 429, short(m));

  // Per account, whatever the address: a fresh IP for every guess still runs out.
  const acct = `acct-${Date.now()}@example.com`;
  const acctStatuses = [];
  for (let i = 0; i < MAX_PER_ACCOUNT + 1; i++) acctStatuses.push((await login(acct, `bad-${i}`, { ip: fakeIp() })).status);
  assert(`${MAX_PER_ACCOUNT} bad passwords for one account from ${MAX_PER_ACCOUNT} IPs -> 401, the next -> 429`,
    acctStatuses.slice(0, MAX_PER_ACCOUNT).every((s) => s === 401) && acctStatuses[MAX_PER_ACCOUNT] === 429, acctStatuses);
  const otherAcct = await login(`other-${Date.now()}@example.com`, "bad", { ip: fakeIp() });
  assert("…other accounts are unaffected (401)", otherAcct.status === 401, short(otherAcct));
});

group("7 password policy", async () => {
  reset();
  const ip = fakeIp();
  const admin = await loginOk(...ADMIN, { ip });
  const email = `policy-${Date.now()}@example.com`;
  const short7 = await call("POST", "/users", { cookie: admin, body: { email, name: "Policy", role: "maker", password: "abc1234" } });
  assert("POST /users with a 7-character password -> 400", short7.status === 400 && /at least 8 characters/.test(short7.json?.error ?? ""), short(short7));
  const ok8 = await call("POST", "/users", { cookie: admin, body: { email, name: "Policy", role: "maker", password: "abcd1234" } });
  assert("POST /users with an 8-character password -> 201", ok8.status === 201, short(ok8));
  if (ok8.json?.id) {
    const p = await call("PATCH", `/users/${ok8.json.id}`, { cookie: admin, body: { password: "short" } });
    assert("PATCH /users/:id with a short password -> 400", p.status === 400 && /at least 8 characters/.test(p.json?.error ?? ""), short(p));
    const self = await loginOk(email, "abcd1234", { ip });
    const ps = await call("PATCH", `/users/${ok8.json.id}`, { cookie: self, body: { password: "1234567" } });
    assert("PATCH own password with 7 characters -> 400", ps.status === 400, short(ps));
    const unchanged = await login(email, "abcd1234", { ip });
    assert("password unchanged after rejected PATCH", unchanged.status === 200, short(unchanged));

    // Self-service change: the current password is required, and other sessions end.
    const other = await loginOk(email, "abcd1234", { ip });
    const noCur = await call("PATCH", `/users/${ok8.json.id}`, { cookie: self, body: { password: "newpass123" } });
    assert("PATCH own password without currentPassword -> 400", noCur.status === 400, short(noCur));
    const badCur = await call("PATCH", `/users/${ok8.json.id}`, { cookie: self, body: { password: "newpass123", currentPassword: "wrongpass1" } });
    assert("PATCH own password with a wrong currentPassword -> 403", badCur.status === 403, short(badCur));
    const still = await login(email, "abcd1234", { ip });
    assert("password unchanged after missing / wrong currentPassword", still.status === 200, short(still));
    const okCur = await call("PATCH", `/users/${ok8.json.id}`, { cookie: self, body: { password: "newpass123", currentPassword: "abcd1234" } });
    assert("PATCH own password with the right currentPassword -> 200", okCur.status === 200, short(okCur));
    const meSelf = await call("GET", "/auth/me", { cookie: self });
    assert("…the session that changed it stays signed in", meSelf.status === 200, short(meSelf));
    const meOther = await call("GET", "/auth/me", { cookie: other });
    assert("…the account's other sessions are ended (401)", meOther.status === 401, short(meOther));
    const reset8 = await call("PATCH", `/users/${ok8.json.id}`, { cookie: admin, body: { password: "adminset1" } });
    assert("super_admin resets another account's password without currentPassword -> 200", reset8.status === 200, short(reset8));
    const meAfterReset = await call("GET", "/auth/me", { cookie: self });
    assert("…and that account's sessions are ended (401)", meAfterReset.status === 401, short(meAfterReset));
    const meAdmin = await call("GET", "/auth/me", { cookie: admin });
    assert("…while the admin stays signed in", meAdmin.status === 200, short(meAdmin));
    const del = await call("DELETE", `/users/${ok8.json.id}`, { cookie: admin });
    assert("cleanup: DELETE test user", del.status === 204 || del.status === 200, short(del));
  }
});

group("8 security headers and body limit", async () => {
  const h = await call("GET", "/healthz");
  assert("nosniff", h.headers.get("x-content-type-options") === "nosniff", h.headers.get("x-content-type-options"));
  assert("X-Frame-Options DENY", h.headers.get("x-frame-options") === "DENY", h.headers.get("x-frame-options"));
  assert("Referrer-Policy no-referrer", h.headers.get("referrer-policy") === "no-referrer", h.headers.get("referrer-policy"));
  assert("CSP default-src 'none' on JSON", h.headers.get("content-security-policy") === "default-src 'none'; frame-ancestors 'none'", h.headers.get("content-security-policy"));
  assert("no X-Powered-By", h.headers.get("x-powered-by") === null, h.headers.get("x-powered-by"));

  const e = await call("GET", "/definitely-not-a-route");
  assert("headers on 404 too", e.headers.get("x-content-type-options") === "nosniff" && !!e.headers.get("content-security-policy"), short(e));

  reset();
  const ip = fakeIp();
  const admin = await loginOk(...ADMIN, { ip });
  const c = await call("GET", "/documents/1/content", { cookie: admin });
  assert("document content still served (200)", c.status === 200 && c.text === "alpha", short(c));
  assert("document content keeps nosniff", c.headers.get("x-content-type-options") === "nosniff", c.headers.get("x-content-type-options"));
  assert("document content has no CSP default-src 'none' (viewer must render it)", !/default-src 'none'/.test(c.headers.get("content-security-policy") ?? ""), c.headers.get("content-security-policy"));
  assert("document content keeps its own Cache-Control", /private/.test(c.headers.get("cache-control") ?? ""), c.headers.get("cache-control"));
  assert("document content is never cached (no-store, no max-age)", /no-store/.test(c.headers.get("cache-control") ?? "") && !/max-age/.test(c.headers.get("cache-control") ?? ""), c.headers.get("cache-control"));
  const out = await call("POST", "/auth/logout", { cookie: admin });
  assert("logout clears the browser cache (Clear-Site-Data: \"cache\")", out.status === 200 && /"cache"/.test(out.headers.get("clear-site-data") ?? ""), `${out.status} ${out.headers.get("clear-site-data")}`);

  const big = await call("POST", "/auth/login", { ip, raw: JSON.stringify({ email: "x@example.com", password: "a".repeat(1_100_000) }) });
  assert("JSON body over 1mb -> 413 JSON", big.status === 413 && typeof big.json?.error === "string", short(big));
  const bad = await call("POST", "/auth/login", { ip, raw: "{not json" });
  assert("malformed JSON -> 400 JSON (no HTML stack trace)", bad.status === 400 && typeof bad.json?.error === "string" && !/<html|<pre>|\n\s+at /i.test(bad.text), short(bad));
});

group("9 CORS", async () => {
  const evil = "https://evil.example.com";
  const g = await call("GET", "/auth/config", { headers: { Origin: evil } });
  assert("cross-site Origin gets no Access-Control-Allow-Origin", g.headers.get("access-control-allow-origin") === null, g.headers.get("access-control-allow-origin"));
  assert("…and no Allow-Credentials", g.headers.get("access-control-allow-credentials") === null, g.headers.get("access-control-allow-credentials"));
  const pre = await call("OPTIONS", "/auth/login", {
    headers: { Origin: evil, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  assert("preflight from cross-site Origin is not allowed", pre.headers.get("access-control-allow-origin") === null, `${pre.status} ${pre.headers.get("access-control-allow-origin")}`);
  if (ALLOWED.length) {
    const ok = await call("GET", "/auth/config", { headers: { Origin: ALLOWED[0] } });
    assert("allowed Origin is answered with credentials", ok.headers.get("access-control-allow-origin") === ALLOWED[0] && ok.headers.get("access-control-allow-credentials") === "true",
      `${ok.headers.get("access-control-allow-origin")} ${ok.headers.get("access-control-allow-credentials")}`);
  } else {
    skip("allowed Origin is answered", "ALLOWED_ORIGINS not set");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// The API only has to be reachable (no /healthz status check); the fixture is loaded first.
await main({ reset, resetFirst: true, healthStrict: false });
