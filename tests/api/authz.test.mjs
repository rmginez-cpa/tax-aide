// TaxAide authorization / deadline integration tests (server-side permission policy).
// Dependency-free Node 22+ ES module. Tests a running API (default http://localhost:8080/api)
// and resets a Postgres fixture (fixture.sql) between groups.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md
// Env:  API_BASE, FIXTURE, UPLOADS_DIR (must equal the server's UPLOADS_DIR),
//       PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>, DRY_RUN=1

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.env.TAXAIDE_TEST_RESET_DB !== "1" && process.env.DRY_RUN !== "1") {
  console.error("Refusing to run: this suite wipes the database. Set TAXAIDE_TEST_RESET_DB=1 and point PG*/API_BASE at a throwaway database.");
  process.exit(2);
}
const BASE = process.env.API_BASE ?? "http://localhost:8080/api";
const FIXTURE = process.env.FIXTURE ?? path.join(HERE, "fixture.sql");
const PG_ENV = {
  ...process.env,
  PGPASSWORD: process.env.PGPASSWORD ?? "taxaide",
  PGHOST: process.env.PGHOST ?? "localhost",
  PGUSER: process.env.PGUSER ?? "taxaide",
  PGDATABASE: process.env.PGDATABASE ?? "taxaide",
};
// Must match the API's UPLOADS_DIR (restart-api.sh). The fixture's document rows point at
// a.txt / b.txt, so reset() writes those files (5 bytes each, matching file_size).
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(HERE, "uploads");
const ONLY = process.env.ONLY ?? "";
// DRY_RUN=1: touch neither the API nor the DB (stubs both) — only for counting cases / harness smoke checks.
const DRY_RUN = process.env.DRY_RUN === "1";
if (DRY_RUN) {
  globalThis.fetch = async () =>
    new Response("[]", { status: 200, headers: { "set-cookie": "connect.sid=dry; Path=/", "content-type": "application/json" } });
}

const USERS = {
  admin: ["admin@firm.ph", "admin123"],
  manager: ["manager@firm.ph", "manager123"],
  maker: ["accountant@firm.ph", "accountant123"],
  client: ["client@example.com", "client123"], // -> Alpha (1)
  clientb: ["clientb@example.com", "client123"], // -> Bravo (2)
  orphan: ["orphan@example.com", "client123"], // unlinked client
  viewer: ["viewer@example.com", "client123"], // legacy viewer -> Alpha (1)
};
const STAFF = ["maker", "manager", "admin"];
const CLIENTS = ["client", "viewer"]; // both scoped to Alpha

// ── DB helpers ───────────────────────────────────────────────────────────────
function sql(query) {
  if (DRY_RUN) return "0";
  return execSync("psql -q -tA -v ON_ERROR_STOP=1", { input: query, env: PG_ENV, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}
function sqlNum(query) {
  const out = sql(query);
  const n = Number(out.split("\n")[0]);
  if (Number.isNaN(n)) throw new Error(`non-numeric SQL result for ${query}: ${out}`);
  return n;
}
function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const cookies = {};

async function login(role) {
  const [email, password] = USERS[role];
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  const sid = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("connect.sid="));
  if (res.status !== 200 || !sid) {
    throw new Error(`login failed for ${role}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  cookies[role] = sid;
}

async function loginAll() {
  for (const role of Object.keys(USERS)) await login(role);
}

// Users 1-4 survive the fixture, so pin their role/link/name back after every reset
// (a test that demotes the maker, or a server bug that lets a client promote itself,
// must not leak into later groups or later runs).
let restoreUsersSql = null;
async function reset() {
  if (restoreUsersSql === null) {
    const rows = sql("select id||chr(9)||name from users where id between 1 and 4 order by id").split("\n").filter(Boolean);
    restoreUsersSql = rows
      .map((row) => {
        const [id, name] = row.split("\t");
        return `update users set name=${q(name)} where id=${Number(id)};`;
      })
      .join("\n");
  }
  if (!DRY_RUN) {
    execSync(`psql -q -v ON_ERROR_STOP=1 -f ${JSON.stringify(FIXTURE)}`, { env: PG_ENV, stdio: ["ignore", "ignore", "pipe"] });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, "a.txt"), "alpha");
    fs.writeFileSync(path.join(UPLOADS_DIR, "b.txt"), "bravo");
  }
  sql(`
    update users set role='super_admin', client_id=null where id=1;
    update users set role='manager', client_id=null where id=2;
    update users set role='maker', client_id=null where id=3;
    update users set role='client', client_id=1 where id=4;
    ${restoreUsersSql}
  `);
  // The fixture wipes user_sessions, so everybody must sign in again.
  await loginAll();
}

async function call(role, method, urlPath, body) {
  const headers = {};
  if (role && cookies[role]) headers.Cookie = cookies[role];
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function upload(fields, content = "hello from the authz test", name = "authz-test.txt") {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "text/plain" }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

// ── Expectations ─────────────────────────────────────────────────────────────
// An expectation is { desc, test(res) -> true | false | string(reason) }.
function is(...codes) {
  return { desc: codes.join("|"), test: (r) => codes.includes(r.status) };
}
const DENIED = { desc: "403|404 (never 2xx)", test: (r) => r.status === 403 || r.status === 404 };
const NOT_2XX = { desc: "non-2xx", test: (r) => r.status < 200 || r.status >= 300 };
const CLIENT_ERR = { desc: "4xx", test: (r) => r.status >= 400 && r.status < 500 };
const BAD_REF = { desc: "400|404", test: (r) => r.status === 400 || r.status === 404 };
const DELETED = is(204, 200);
const CREATED = is(201, 200);
function pred(desc, fn, status = 200) {
  return {
    desc: status == null ? desc : `${status} + ${desc}`,
    test: (r) => {
      if (status != null && r.status !== status) return false;
      return fn(r.json, r);
    },
  };
}
const arr = (desc, fn) => pred(desc, (j) => Array.isArray(j) && fn(j));
const EMPTY = arr("[]", (a) => a.length === 0);

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function record(name, ok, expected, got) {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} expected ${expected} got ${got}`);
  }
}

function short(r) {
  const t = (r.text ?? "").replace(/\s+/g, " ");
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

async function check(name, role, method, urlPath, body, expect) {
  const exp = typeof expect === "number" ? is(expect) : expect;
  let r;
  try {
    r = await call(role, method, urlPath, typeof body === "function" ? body() : body);
  } catch (err) {
    record(`[${role}] ${name}`, false, exp.desc, `exception ${err?.message ?? err}`);
    return { status: 0, json: undefined, text: "", headers: new Headers() };
  }
  let verdict;
  try {
    verdict = exp.test(r);
  } catch (err) {
    verdict = `predicate threw ${err?.message ?? err}`;
  }
  const ok = verdict === true;
  const why = typeof verdict === "string" ? ` (${verdict})` : "";
  record(`[${role}] ${name}`, ok, exp.desc, `${r.status}${why} ${short(r)}`);
  return r;
}

function assert(name, cond, expected, got) {
  let ok;
  let actual = got;
  try {
    ok = typeof cond === "function" ? cond() : cond;
  } catch (err) {
    ok = false;
    actual = `exception ${err?.message ?? err}`;
  }
  record(name, ok === true, expected, typeof actual === "function" ? safe(actual) : actual);
}
function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return `exception ${err?.message ?? err}`;
  }
}

const groups = [];
function group(name, fn) {
  groups.push({ name, fn });
}

// ── Snapshot of the mutable app data (for "nothing changed" checks) ─────────
function snapshot() {
  return sql(`
    select 'C', id, name, status, coalesce(contact_phone,''), coalesce(contact_email,'') from clients order by id;
    select 'E', id, client_id, title, status, source_collection_status, draft_return_status, confirmation_status, payment_status, coalesce(notes,''), coalesce(assigned_to,0) from engagements order by id;
    select 'D', id, coalesce(client_id,0), coalesce(engagement_id,0), title, status, due_date, priority from deadlines order by id;
    select 'F', id, coalesce(client_id,0), coalesce(engagement_id,0), coalesce(description,''), coalesce(stage,'') from documents order by id;
    select 'M', id, engagement_id, content, is_approval from comments order by id;
    select 'K', id, engagement_id, label, status from checklist_items order by id;
    select 'U', id, role, coalesce(client_id,0) from users order by id;
  `);
}

function diffSnap(a, b) {
  const la = new Set(a.split("\n"));
  const lb = new Set(b.split("\n"));
  const gone = [...la].filter((l) => !lb.has(l));
  const added = [...lb].filter((l) => !la.has(l));
  return `removed/changed: ${JSON.stringify(gone).slice(0, 300)} added/now: ${JSON.stringify(added).slice(0, 300)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) Client scoping — reads
// ═════════════════════════════════════════════════════════════════════════════
group("1 client-scoped reads", async () => {
  await reset();

  for (const role of CLIENTS) {
    await check("GET /clients only Alpha", role, "GET", "/clients", null,
      arr("exactly [Alpha]", (a) => a.length === 1 && a[0].id === 1));
    await check("GET /clients/1 own", role, "GET", "/clients/1", null, 200);
    await check("GET /clients/1/compliance own", role, "GET", "/clients/1/compliance", null, 200);
    await check("GET /engagements/1 own", role, "GET", "/engagements/1", null, 200);
    await check("GET /engagements/1/amendments own", role, "GET", "/engagements/1/amendments", null,
      arr("all Alpha", (a) => a.length >= 1 && a.every((e) => e.clientId === 1)));
    await check("GET /deadlines/1 own", role, "GET", "/deadlines/1", null, 200);
    await check("GET /documents/1 own", role, "GET", "/documents/1", null, 200);
    await check("GET /documents/1/content own", role, "GET", "/documents/1/content", null, 200);

    for (const p of ["/clients/2", "/clients/2/compliance", "/clients/2/compliance?year=2026", "/engagements/2",
      "/engagements/2/amendments", "/deadlines/2", "/deadlines/3", "/documents/2", "/documents/2/content"]) {
      await check(`GET ${p} out of scope`, role, "GET", p, null, 404);
    }
    await check("GET /clients/999 missing", role, "GET", "/clients/999", null, 404);

    await check("GET /engagements only Alpha", role, "GET", "/engagements", null,
      arr("non-empty, all clientId 1", (a) => a.length >= 1 && a.every((e) => e.clientId === 1)));
    await check("GET /engagements?clientId=2", role, "GET", "/engagements?clientId=2", null, EMPTY);
    await check("GET /deadlines only Alpha", role, "GET", "/deadlines", null,
      arr("non-empty, all clientId 1", (a) => a.length >= 1 && a.every((d) => d.clientId === 1)));
    await check("GET /deadlines?clientId=2", role, "GET", "/deadlines?clientId=2", null, EMPTY);
    await check("GET /deadlines?engagementId=2", role, "GET", "/deadlines?engagementId=2", null, EMPTY);
    await check("GET /documents only Alpha", role, "GET", "/documents", null,
      arr("non-empty, no Bravo doc", (a) => a.length >= 1 && a.every((d) => d.clientId === 1 && d.id !== 2)));
    await check("GET /documents?clientId=2", role, "GET", "/documents?clientId=2", null, EMPTY);
    await check("GET /documents?engagementId=2", role, "GET", "/documents?engagementId=2", null, EMPTY);
    await check("GET /comments only Alpha engagements", role, "GET", "/comments", null,
      arr("has comment 1, none on eng 2", (a) => a.some((c) => c.id === 1) && a.every((c) => c.engagementId !== 2)));
    await check("GET /comments?engagementId=2", role, "GET", "/comments?engagementId=2", null, EMPTY);
    await check("GET /checklist-items only Alpha engagements", role, "GET", "/checklist-items", null,
      arr("has item 1, none on eng 2", (a) => a.some((c) => c.id === 1) && a.every((c) => c.engagementId !== 2)));
    await check("GET /checklist-items?engagementId=2", role, "GET", "/checklist-items?engagementId=2", null, EMPTY);

    await check("GET /dashboard/summary Alpha only", role, "GET", "/dashboard/summary", null,
      pred("totalClients 1, activeEngagements 1, pendingApprovals 1, overdue<=1, upcoming<=1", (j) =>
        j && j.totalClients === 1 && j.activeEngagements === 1 && j.pendingApprovals === 1 &&
        j.overdueItems <= 1 && j.upcomingDeadlines <= 1));
    await check("GET /dashboard/upcoming-deadlines Alpha only", role, "GET", "/dashboard/upcoming-deadlines", null,
      arr("no Bravo rows", (a) => a.every((d) => d.clientName === "Alpha Corp" && d.id !== 2 && d.id !== 3)));
    await check("GET /dashboard/overdue Alpha only", role, "GET", "/dashboard/overdue", null,
      pred("all rows clientId 1", (j) => j && Array.isArray(j.overdueDeadlines) && Array.isArray(j.overdueEngagements) &&
        j.overdueDeadlines.every((d) => d.clientId === 1) && j.overdueEngagements.every((e) => e.clientId === 1)));
    await check("GET /dashboard/engagement-status Alpha only", role, "GET", "/dashboard/engagement-status", null,
      arr("counts sum to 1", (a) => a.reduce((s, x) => s + Number(x.count), 0) === 1));
    await check("GET /dashboard/recent-activity empty", role, "GET", "/dashboard/recent-activity", null, EMPTY);
    await check("GET /audit-logs denied", role, "GET", "/audit-logs", null, 403);
    await check("GET /notifications own", role, "GET", "/notifications", null, arr("array", () => true));
  }

  await check("GET /users/4 own profile", "client", "GET", "/users/4", null, pred("id 4", (j) => j && j.id === 4));
  await check("GET /users/5 other client's profile", "client", "GET", "/users/5", null, DENIED);

  // Bravo's client sees only Bravo
  await check("GET /clients only Bravo", "clientb", "GET", "/clients", null,
    arr("exactly [Bravo]", (a) => a.length === 1 && a[0].id === 2));
  await check("GET /engagements/1 out of scope", "clientb", "GET", "/engagements/1", null, 404);
  await check("GET /documents/1/content out of scope", "clientb", "GET", "/documents/1/content", null, 404);
  await check("GET /comments none of Alpha", "clientb", "GET", "/comments", null,
    arr("no eng 1 comments", (a) => a.every((c) => c.engagementId !== 1)));

  // Unlinked client account: sees nothing
  for (const p of ["/clients", "/engagements", "/deadlines", "/documents", "/comments", "/checklist-items",
    "/engagements?clientId=1", "/deadlines?clientId=1", "/documents?clientId=1", "/comments?engagementId=1",
    "/checklist-items?engagementId=1", "/dashboard/upcoming-deadlines", "/dashboard/engagement-status",
    "/dashboard/recent-activity"]) {
    await check(`GET ${p} empty`, "orphan", "GET", p, null, EMPTY);
  }
  await check("GET /dashboard/summary all zero", "orphan", "GET", "/dashboard/summary", null,
    pred("all counts 0", (j) => j && j.totalClients === 0 && j.activeEngagements === 0 && j.upcomingDeadlines === 0 &&
      j.overdueItems === 0 && j.pendingApprovals === 0 && j.completedThisMonth === 0));
  await check("GET /dashboard/overdue empty", "orphan", "GET", "/dashboard/overdue", null,
    pred("both empty", (j) => j && j.overdueDeadlines?.length === 0 && j.overdueEngagements?.length === 0));
  for (const p of ["/clients/1", "/clients/1/compliance", "/engagements/1", "/engagements/1/amendments", "/deadlines/1",
    "/documents/1", "/documents/1/content", "/clients/2", "/engagements/2", "/deadlines/3", "/documents/2"]) {
    await check(`GET ${p} 404`, "orphan", "GET", p, null, 404);
  }
  await check("GET /audit-logs denied", "orphan", "GET", "/audit-logs", null, 403);

  // Staff see everything; audit log is manager+
  for (const role of STAFF) {
    await check("GET /clients all", role, "GET", "/clients", null, arr("both clients", (a) => a.length === 2));
    await check("GET /engagements/2", role, "GET", "/engagements/2", null, 200);
    await check("GET /documents/2", role, "GET", "/documents/2", null, 200);
  }
  // Recent activity is the audit trail: manager+ only (policy 4), makers get [].
  await check("GET /dashboard/recent-activity empty", "maker", "GET", "/dashboard/recent-activity", null, EMPTY);
  for (const role of ["manager", "admin"]) {
    await check("GET /dashboard/recent-activity non-empty", role, "GET", "/dashboard/recent-activity", null,
      arr("non-empty", (a) => a.length >= 1));
  }
  await check("GET /audit-logs denied", "maker", "GET", "/audit-logs", null, 403);
  await check("GET /audit-logs allowed", "manager", "GET", "/audit-logs", null, 200);
  await check("GET /audit-logs allowed", "admin", "GET", "/audit-logs", null, 200);
  await check("GET /clients unauthenticated", null, "GET", "/clients", null, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) Client writes — all rejected, nothing changes
// ═════════════════════════════════════════════════════════════════════════════
group("2 client writes rejected", async () => {
  await reset();
  const before = snapshot();
  const docsBefore = sqlNum("select count(*) from documents");

  const attempts = (role) => [
    ["POST /clients", "POST", "/clients", { name: "Hack Co", tin: "999-999-999-000", businessType: "corporation" }],
    ["PATCH /clients/1", "PATCH", "/clients/1", { name: "Hacked Alpha" }],
    ["PATCH /clients/2", "PATCH", "/clients/2", { name: "Hacked Bravo" }],
    ["DELETE /clients/1", "DELETE", "/clients/1"],
    ["DELETE /clients/2", "DELETE", "/clients/2"],
    ["POST /engagements", "POST", "/engagements", { clientId: 1, title: "Hack", taxType: "1601C", period: "March 2026" }],
    ["PATCH /engagements/1 notes", "PATCH", "/engagements/1", { notes: "hacked" }],
    ["PATCH /engagements/1 status", "PATCH", "/engagements/1", { status: "completed" }],
    ["PATCH /engagements/2 status", "PATCH", "/engagements/2", { status: "pending" }],
    ["DELETE /engagements/1", "DELETE", "/engagements/1"],
    ["DELETE /engagements/2", "DELETE", "/engagements/2"],
    ["POST /deadlines", "POST", "/deadlines", { clientId: 1, title: "Hack deadline", dueDate: "2026-12-31" }],
    ["PATCH /deadlines/1", "PATCH", "/deadlines/1", { status: "completed" }],
    ["PATCH /deadlines/3", "PATCH", "/deadlines/3", { status: "completed" }],
    ["DELETE /deadlines/1", "DELETE", "/deadlines/1"],
    ["DELETE /deadlines/3", "DELETE", "/deadlines/3"],
    ["POST /checklist-items", "POST", "/checklist-items", { engagementId: 1, label: "Hack item" }],
    ["PATCH /checklist-items/1", "PATCH", "/checklist-items/1", { status: "received" }],
    ["PATCH /checklist-items/2", "PATCH", "/checklist-items/2", { label: "hacked" }],
    ["DELETE /checklist-items/1", "DELETE", "/checklist-items/1"],
    ["DELETE /checklist-items/2", "DELETE", "/checklist-items/2"],
    ["POST /comments", "POST", "/comments", { engagementId: 1, content: "client comment" }],
    ["POST /comments approval", "POST", "/comments", { engagementId: 1, content: "fake approval", isApproval: true }],
    ["PATCH /comments/1", "PATCH", "/comments/1", { content: "hacked" }],
    ["PATCH /comments/2", "PATCH", "/comments/2", { content: "hacked" }],
    ["DELETE /comments/1", "DELETE", "/comments/1"],
    ["DELETE /comments/2", "DELETE", "/comments/2"],
    ["POST /documents metadata", "POST", "/documents",
      { engagementId: 1, filename: "x.txt", originalName: "x.txt", mimeType: "text/plain", fileSize: 1, fileUrl: "x" }],
    ["PATCH /documents/1", "PATCH", "/documents/1", { description: "hacked" }],
    ["PATCH /documents/2", "PATCH", "/documents/2", { description: "hacked" }],
    ["DELETE /documents/1", "DELETE", "/documents/1"],
    ["DELETE /documents/2", "DELETE", "/documents/2"],
    ["POST /documents/upload eng 1", "POST", "/documents/upload", () => upload({ engagementId: 1, stage: "confirmation" })],
    ["POST /documents/upload client 1", "POST", "/documents/upload", () => upload({ clientId: 1 })],
    ["POST /documents/upload eng 2", "POST", "/documents/upload", () => upload({ engagementId: 2, stage: "draft_return" })],
    ["POST /documents/seed-samples", "POST", "/documents/seed-samples", {}],
    ["POST /clients/1/generate-deadlines", "POST", "/clients/1/generate-deadlines", { year: 2026 }],
    ["POST /clients/2/generate-deadlines", "POST", "/clients/2/generate-deadlines", { year: 2026, overwrite: true }],
    ["POST /deadlines/1/start-workflow", "POST", "/deadlines/1/start-workflow", {}],
    ["POST /deadlines/3/start-workflow", "POST", "/deadlines/3/start-workflow", {}],
    ["POST /engagements/1/submit-stage", "POST", "/engagements/1/submit-stage", { stage: "confirmation" }],
    ["POST /engagements/2/submit-stage", "POST", "/engagements/2/submit-stage", { stage: "source_collection" }],
    ["POST /engagements/1/recall-stage", "POST", "/engagements/1/recall-stage", { stage: "draft_return" }],
    ["POST /engagements/1/amend", "POST", "/engagements/1/amend", {}],
    ["POST /engagements/1/approve", "POST", "/engagements/1/approve", {}],
    ["POST /engagements/1/approve-stage", "POST", "/engagements/1/approve-stage", { stage: "draft_return" }],
    ["POST /engagements/1/reject-stage", "POST", "/engagements/1/reject-stage", { stage: "draft_return", notes: "no" }],
    ["POST /engagements/1/void-stage", "POST", "/engagements/1/void-stage", { stage: "source_collection" }],
    ["POST /users", "POST", "/users", { email: `hack-${role}@example.com`, name: "Hack", password: "secret123", role: "super_admin" }],
    ["PATCH /users/2", "PATCH", "/users/2", { name: "Hacked Manager" }],
    ["DELETE /users/3", "DELETE", "/users/3"],
  ];

  for (const role of ["client", "viewer", "orphan", "clientb"]) {
    for (const [name, method, p, body] of attempts(role)) {
      await check(`${name} rejected`, role, method, p, body, DENIED);
    }
  }

  // A client cannot promote itself or re-link itself to another client.
  await check("PATCH /users/4 role+clientId (self)", "client", "PATCH", "/users/4", { role: "super_admin", clientId: 2 }, NOT_2XX);
  await check("PATCH /users/7 role (self)", "viewer", "PATCH", "/users/7", { role: "manager" }, NOT_2XX);

  const after = snapshot();
  assert("DB unchanged after rejected client writes", after === before, "identical snapshot", () => diffSnap(before, after));
  assert("no documents added by client uploads", () => sqlNum("select count(*) from documents") === docsBefore,
    docsBefore, () => sqlNum("select count(*) from documents"));
  await check("engagement 2 stages unchanged (staff view)", "manager", "GET", "/engagements/2", null,
    pred("in_progress, source not_started, draft in_progress", (j) => j && j.status === "in_progress" &&
      (j.sourceCollectionStatus ?? "not_started") === "not_started" && (j.draftReturnStatus ?? "in_progress") === "in_progress"));
  assert("user 4 still client of Alpha", () => sql("select role||':'||coalesce(client_id,0) from users where id=4") === "client:1",
    "client:1", () => sql("select role||':'||coalesce(client_id,0) from users where id=4"));

  // What clients ARE allowed to change: their own name/password and their own notifications.
  const own = sqlNum("insert into notifications (user_id,title,message,type) values (4,'t','m','info') returning id");
  const other = sqlNum("insert into notifications (user_id,title,message,type) values (5,'t','m','info') returning id");
  await check("POST own notification read", "client", "POST", `/notifications/${own}/read`, {}, 200);
  await check("POST other user's notification read", "client", "POST", `/notifications/${other}/read`, {}, DENIED);
  assert("other user's notification still unread", () => sql(`select is_read from notifications where id=${other}`) === "f",
    "f", () => sql(`select is_read from notifications where id=${other}`));
  await check("POST /notifications/read-all", "client", "POST", "/notifications/read-all", {}, 200);
  assert("read-all touched only own notifications", () => sql(`select is_read from notifications where id=${other}`) === "f",
    "f", () => sql(`select is_read from notifications where id=${other}`));
  const origName = sql("select name from users where id=4") || "Alpha Client";
  await check("PATCH /users/4 own name", "client", "PATCH", "/users/4", { name: "Alpha Client Renamed" }, 200);
  await check("PATCH /users/4 own name back", "client", "PATCH", "/users/4", { name: origName }, 200);
  await check("PATCH /users/5 someone else's name", "client", "PATCH", "/users/5", { name: "Hacked" }, DENIED);
  await check("PATCH /users/7 own password", "viewer", "PATCH", "/users/7", { password: "newpass123" }, 200);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) Maker: allowed and denied
// ═════════════════════════════════════════════════════════════════════════════
group("3 maker permissions", async () => {
  await reset();
  const M = "maker";

  const newClient = await check("POST /clients", M, "POST", "/clients",
    { name: "Maker Client", tin: "333-333-333-000", businessType: "corporation" }, 201);
  await check("PATCH /clients/2", M, "PATCH", "/clients/2", { contactPhone: "0917-000-0000" },
    pred("contactPhone updated", (j) => j && j.contactPhone === "0917-000-0000"));
  const newEng = await check("POST /engagements", M, "POST", "/engagements",
    { clientId: 2, title: "BIR Form 1701Q — Q2 2026", taxType: "1701Q", period: "Q2 2026" }, 201);
  await check("POST /engagements unknown client", M, "POST", "/engagements",
    { clientId: 999, title: "x", taxType: "1701Q", period: "Q2 2026" }, BAD_REF);
  await check("PATCH /engagements/2 notes", M, "PATCH", "/engagements/2", { notes: "maker note" }, 200);

  await check("POST /engagements/2/submit-stage source_collection", M, "POST", "/engagements/2/submit-stage",
    { stage: "source_collection" }, 200);
  assert("engagement 2 source_collection is for_review",
    () => sql("select source_collection_status from engagements where id=2") === "for_review",
    "for_review", () => sql("select source_collection_status from engagements where id=2"));
  await check("POST /engagements/2/recall-stage source_collection", M, "POST", "/engagements/2/recall-stage",
    { stage: "source_collection" }, 200);

  const up = await check("POST /documents/upload eng 2 draft_return", M, "POST", "/documents/upload",
    () => upload({ engagementId: 2, stage: "draft_return" }), pred("clientId derived = 2", (j) => j && j.clientId === 2, 201));
  await check("POST /documents/upload eng 2 with wrong clientId", M, "POST", "/documents/upload",
    () => upload({ engagementId: 2, clientId: 1, stage: "draft_return" }), 400);
  await check("POST /documents/upload unknown engagement", M, "POST", "/documents/upload",
    () => upload({ engagementId: 999, stage: "draft_return" }), BAD_REF);
  await check("POST /documents/upload unknown client", M, "POST", "/documents/upload",
    () => upload({ clientId: 999 }), BAD_REF);
  await check("POST /documents metadata derives clientId", M, "POST", "/documents",
    { engagementId: 2, filename: "m.txt", originalName: "m.txt", mimeType: "text/plain", fileSize: 1, fileUrl: "pending" },
    pred("clientId 2", (j) => j && j.clientId === 2, 201));
  await check("POST /documents metadata wrong clientId", M, "POST", "/documents",
    { engagementId: 2, clientId: 1, filename: "m.txt", originalName: "m.txt", mimeType: "text/plain", fileSize: 1, fileUrl: "x" }, 400);
  await check("POST /documents metadata unknown engagement", M, "POST", "/documents",
    { engagementId: 999, filename: "m.txt", originalName: "m.txt", mimeType: "text/plain", fileSize: 1, fileUrl: "x" }, BAD_REF);
  await check("PATCH /documents/1 description", M, "PATCH", "/documents/1", { description: "payroll register" }, 200);
  if (up.json?.id) {
    await check("DELETE own upload on unlocked stage", M, "DELETE", `/documents/${up.json.id}`, null, DELETED);
  }
  await check("DELETE /documents/1 on approved (locked) stage", M, "DELETE", "/documents/1", null, 403);

  const cmt = await check("POST /comments", M, "POST", "/comments", { engagementId: 2, content: "maker comment" }, 201);
  await check("POST /comments unknown engagement", M, "POST", "/comments", { engagementId: 999, content: "x" }, BAD_REF);
  if (cmt.json?.id) await check("PATCH own new comment", M, "PATCH", `/comments/${cmt.json.id}`, { content: "edited" }, 200);

  const item = await check("POST /checklist-items", M, "POST", "/checklist-items", { engagementId: 2, label: "Bank statements" }, 201);
  await check("POST /checklist-items unknown engagement", M, "POST", "/checklist-items", { engagementId: 999, label: "x" }, BAD_REF);
  if (item.json?.id) {
    await check("PATCH new checklist item", M, "PATCH", `/checklist-items/${item.json.id}`, { status: "received" }, 200);
    await check("DELETE new checklist item", M, "DELETE", `/checklist-items/${item.json.id}`, null, DELETED);
  }

  const engCountBefore = sqlNum("select count(*) from engagements");
  const sw1 = await check("POST /deadlines/3/start-workflow (1st)", M, "POST", "/deadlines/3/start-workflow", {},
    pred("engagement id", (j) => j && Number.isInteger(j.id), null));
  assert("start-workflow (1st) status 200|201", sw1.status === 201 || sw1.status === 200, "200|201", sw1.status);
  const sw2 = await check("POST /deadlines/3/start-workflow (2nd)", M, "POST", "/deadlines/3/start-workflow", {},
    pred("same engagement id", (j) => j && sw1.json && j.id === sw1.json.id, null));
  assert("start-workflow (2nd) status 200|201", sw2.status === 201 || sw2.status === 200, "200|201", sw2.status);
  assert("deadline 3 linked to the started engagement",
    () => sw1.json && sqlNum("select coalesce(engagement_id,0) from deadlines where id=3") === sw1.json.id,
    sw1.json?.id, () => sql("select engagement_id from deadlines where id=3"));
  assert("two start-workflow calls created exactly one engagement",
    () => sqlNum("select count(*) from engagements") === engCountBefore + 1,
    engCountBefore + 1, () => sql("select count(*) from engagements"));
  if (sw1.json?.id) {
    assert("started engagement belongs to deadline 3's client",
      () => sqlNum(`select client_id from engagements where id=${Number(sw1.json.id)}`) === 2,
      2, () => sql(`select client_id from engagements where id=${Number(sw1.json.id)}`));
  }

  await check("POST /clients/1/generate-deadlines 2026", M, "POST", "/clients/1/generate-deadlines", { year: 2026 },
    pred("created is a number", (j) => j && typeof j.created === "number"));
  await check("POST /clients/999/generate-deadlines", M, "POST", "/clients/999/generate-deadlines", { year: 2026 }, 404);
  const dl = await check("POST /deadlines", M, "POST", "/deadlines", { clientId: 2, title: "Maker manual deadline", dueDate: "2026-12-20" }, 201);
  await check("POST /deadlines unknown client", M, "POST", "/deadlines", { clientId: 999, title: "x", dueDate: "2026-12-20" }, BAD_REF);
  await check("POST /deadlines unknown engagement", M, "POST", "/deadlines", { engagementId: 999, title: "x", dueDate: "2026-12-20" }, BAD_REF);
  if (dl.json?.id) await check("PATCH new deadline title", M, "PATCH", `/deadlines/${dl.json.id}`, { title: "Maker deadline renamed" }, 200);

  // Denied for makers
  await check("DELETE /clients/2", M, "DELETE", "/clients/2", null, 403);
  if (newClient.json?.id) await check("DELETE new empty client", M, "DELETE", `/clients/${newClient.json.id}`, null, 403);
  await check("DELETE /engagements/2", M, "DELETE", "/engagements/2", null, 403);
  await check("DELETE /deadlines/3", M, "DELETE", "/deadlines/3", null, 403);
  if (dl.json?.id) await check("DELETE new deadline", M, "DELETE", `/deadlines/${dl.json.id}`, null, 403);
  await check("POST /engagements/1/approve-stage", M, "POST", "/engagements/1/approve-stage", { stage: "draft_return" }, 403);
  await check("POST /engagements/1/reject-stage", M, "POST", "/engagements/1/reject-stage", { stage: "draft_return", notes: "x" }, 403);
  await check("POST /engagements/1/void-stage", M, "POST", "/engagements/1/void-stage", { stage: "source_collection" }, 403);
  await check("POST /engagements/1/approve (legacy)", M, "POST", "/engagements/1/approve", {}, 403);
  await check("GET /audit-logs", M, "GET", "/audit-logs", null, 403);
  await check("POST /documents/seed-samples", M, "POST", "/documents/seed-samples", {}, 403);
  if (newEng.json?.id) {
    await check("PATCH new engagement status in_progress", M, "PATCH", `/engagements/${newEng.json.id}`, { status: "in_progress" }, 403);
  }
  await check("PATCH /engagements/2 status pending", M, "PATCH", "/engagements/2", { status: "pending" }, 403);
  await check("PATCH /engagements/1 status in_progress->for_review", M, "PATCH", "/engagements/1", { status: "for_review" }, 403);
  await check("POST /users", M, "POST", "/users", { email: "m2@firm.ph", name: "x", password: "secret123", role: "maker" }, 403);
  await check("PATCH /users/2 (someone else)", M, "PATCH", "/users/2", { name: "x" }, 403);
  await check("DELETE /users/4", M, "DELETE", "/users/4", null, 403);

  assert("client 2, engagement 2 and deadline 3 still exist after denied deletes",
    () => sql("select (select count(*) from clients where id=2)||','||(select count(*) from engagements where id=2)||','||(select count(*) from deadlines where id=3)") === "1,1,1",
    "1,1,1", () => sql("select (select count(*) from clients where id=2)||','||(select count(*) from engagements where id=2)||','||(select count(*) from deadlines where id=3)"));
  assert("engagement 1 draft_return still for_review",
    () => sql("select draft_return_status from engagements where id=1") === "for_review",
    "for_review", () => sql("select draft_return_status from engagements where id=1"));
  if (newEng.json?.id) {
    assert("new engagement status unchanged by maker",
      () => sql(`select status from engagements where id=${newEng.json.id}`) === (newEng.json.status ?? "pending"),
      newEng.json.status ?? "pending", () => sql(`select status from engagements where id=${newEng.json.id}`));
  }

  // Amend a completed filing: makers may, clients may not.
  sql("update engagements set status='completed', source_collection_status='approved', draft_return_status='approved', confirmation_status='approved', payment_status='approved' where id=1");
  await check("POST /engagements/1/amend (completed)", "client", "POST", "/engagements/1/amend", {}, DENIED);
  await check("POST /engagements/1/amend (completed)", "viewer", "POST", "/engagements/1/amend", {}, DENIED);
  await check("POST /engagements/1/amend (completed)", M, "POST", "/engagements/1/amend", {},
    pred("amendment of 1 for client 1", (j) => j && j.clientId === 1 && j.id !== 1, 201));
  assert("exactly one amendment created", () => sqlNum("select count(*) from engagements where amended_engagement_id=1") === 1,
    1, () => sql("select count(*) from engagements where amended_engagement_id=1"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) Engagement status is owned by the workflow
// ═════════════════════════════════════════════════════════════════════════════
group("4 engagement status", async () => {
  await reset();
  for (const role of STAFF) {
    await check("PATCH /engagements/1 status completed", role, "PATCH", "/engagements/1", { status: "completed" }, 400);
    await check("PATCH /engagements/2 status completed", role, "PATCH", "/engagements/2", { status: "completed" }, 400);
  }
  assert("engagement 1 not completed", () => sql("select status from engagements where id=1") === "in_progress",
    "in_progress", () => sql("select status from engagements where id=1"));
  await check("PATCH /engagements/2 status pending", "manager", "PATCH", "/engagements/2", { status: "pending" }, 200);
  assert("engagement 2 now pending", () => sql("select status from engagements where id=2") === "pending",
    "pending", () => sql("select status from engagements where id=2"));
  await check("PATCH /engagements/2 status in_progress", "admin", "PATCH", "/engagements/2", { status: "in_progress" }, 200);
  await check("PATCH /engagements/2 status in_progress->pending", "maker", "PATCH", "/engagements/2", { status: "pending" }, 403);
  assert("engagement 2 still in_progress after maker attempt", () => sql("select status from engagements where id=2") === "in_progress",
    "in_progress", () => sql("select status from engagements where id=2"));
  await check("POST /engagements/1/approve (legacy)", "manager", "POST", "/engagements/1/approve", {}, 400);
  await check("POST /engagements/1/approve (legacy)", "admin", "POST", "/engagements/1/approve", {}, 400);
  assert("legacy approve changed nothing", () => sql("select status||','||draft_return_status from engagements where id=1") === "in_progress,for_review",
    "in_progress,for_review", () => sql("select status||','||draft_return_status from engagements where id=1"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) Deadline status: linked deadlines follow the workflow
// ═════════════════════════════════════════════════════════════════════════════
group("5 deadline status", async () => {
  await reset();
  for (const role of STAFF) {
    await check("PATCH /deadlines/1 status completed (linked)", role, "PATCH", "/deadlines/1", { status: "completed" }, 400);
    await check("PATCH /deadlines/2 status overdue (linked)", role, "PATCH", "/deadlines/2", { status: "overdue" }, 400);
  }
  assert("deadline 1 still pending", () => sql("select status from deadlines where id=1") === "pending",
    "pending", () => sql("select status from deadlines where id=1"));
  await check("PATCH /deadlines/3 status completed (unlinked)", "maker", "PATCH", "/deadlines/3", { status: "completed" },
    pred("status completed", (j) => j && j.status === "completed"));
  assert("deadline 3 completed in DB", () => sql("select status from deadlines where id=3") === "completed",
    "completed", () => sql("select status from deadlines where id=3"));
  await check("PATCH /deadlines/3 status pending (unlinked)", "manager", "PATCH", "/deadlines/3", { status: "pending" }, 200);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6) Comments
// ═════════════════════════════════════════════════════════════════════════════
group("6 comments", async () => {
  await reset();
  // Approval comment 1 (by manager) is immutable for everyone.
  for (const role of ["maker", "manager", "admin"]) {
    await check("PATCH approval comment 1", role, "PATCH", "/comments/1", { content: "rewritten" }, 403);
    await check("DELETE approval comment 1", role, "DELETE", "/comments/1", null, 403);
  }
  assert("approval comment 1 intact",
    () => sql("select content||'|'||is_approval from comments where id=1") === "Approved Source Documents.|true",
    "Approved Source Documents.|true", () => sql("select content||'|'||is_approval from comments where id=1"));

  await check("PATCH own comment 2", "maker", "PATCH", "/comments/2", { content: "Bravo note (edited)" },
    pred("content updated", (j) => j && j.content === "Bravo note (edited)"));
  await check("PATCH maker's comment 2", "manager", "PATCH", "/comments/2", { content: "manager rewrite" }, 403);
  await check("DELETE maker's comment 2", "manager", "DELETE", "/comments/2", null, 403);
  assert("comment 2 keeps maker's edit", () => sql("select content from comments where id=2") === "Bravo note (edited)",
    "Bravo note (edited)", () => sql("select content from comments where id=2"));
  await check("PATCH comment 2 (super_admin)", "admin", "PATCH", "/comments/2", { content: "admin moderated" }, 200);
  await check("DELETE comment 2 (super_admin)", "admin", "DELETE", "/comments/2", null, DELETED);
  assert("comment 2 gone", () => sqlNum("select count(*) from comments where id=2") === 0,
    0, () => sql("select count(*) from comments where id=2"));

  // A manager's own non-approval comment is editable by that manager only.
  const mc = await check("POST manager comment", "manager", "POST", "/comments", { engagementId: 1, content: "manager note" }, 201);
  if (mc.json?.id) {
    await check("PATCH manager's comment", "maker", "PATCH", `/comments/${mc.json.id}`, { content: "x" }, 403);
    await check("DELETE manager's comment", "maker", "DELETE", `/comments/${mc.json.id}`, null, 403);
    await check("PATCH own comment", "manager", "PATCH", `/comments/${mc.json.id}`, { content: "manager note 2" }, 200);
    await check("DELETE own comment", "manager", "DELETE", `/comments/${mc.json.id}`, null, DELETED);
  }
  // An approval comment created later (via posting with isApproval) is immutable too.
  const ac = sqlNum("insert into comments (engagement_id, content, is_approval, author_id) values (1, 'Approved Draft Return.', true, 3) returning id");
  await check("PATCH own approval comment", "maker", "PATCH", `/comments/${ac}`, { content: "x" }, 403);
  await check("DELETE own approval comment", "maker", "DELETE", `/comments/${ac}`, null, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7) Documents: stage lock on upload, safe content headers
// ═════════════════════════════════════════════════════════════════════════════
group("7 documents", async () => {
  await reset();
  const before = sqlNum("select count(*) from documents");
  await check("POST /documents/upload eng 1 draft_return (for_review)", "maker", "POST", "/documents/upload",
    () => upload({ engagementId: 1, stage: "draft_return" }), 403);
  await check("POST /documents/upload eng 1 source_collection (approved)", "maker", "POST", "/documents/upload",
    () => upload({ engagementId: 1, stage: "source_collection" }), 403);
  assert("no document added by locked uploads", () => sqlNum("select count(*) from documents") === before,
    before, () => sql("select count(*) from documents"));
  await check("POST /documents/upload eng 1 confirmation (not_started)", "maker", "POST", "/documents/upload",
    () => upload({ engagementId: 1, stage: "confirmation" }), pred("clientId 1", (j) => j && j.clientId === 1, 201));

  for (const role of ["maker", "manager", "client"]) {
    await check("GET /documents/1/content headers", role, "GET", "/documents/1/content", null,
      pred("nosniff + filename*= disposition", (_j, r) => {
        const nosniff = (r.headers.get("x-content-type-options") ?? "").toLowerCase() === "nosniff";
        const cd = r.headers.get("content-disposition") ?? "";
        if (!nosniff) return `x-content-type-options=${r.headers.get("x-content-type-options")}`;
        if (!cd.includes("filename*=")) return `content-disposition=${cd}`;
        return true;
      }));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8) Manager actions
// ═════════════════════════════════════════════════════════════════════════════
group("8 manager actions", async () => {
  await reset();
  const G = "manager";
  await check("POST /engagements/1/approve-stage draft_return", G, "POST", "/engagements/1/approve-stage", { stage: "draft_return" }, 200);
  assert("draft_return approved", () => sql("select draft_return_status from engagements where id=1") === "approved",
    "approved", () => sql("select draft_return_status from engagements where id=1"));
  await check("POST /engagements/1/approve-stage draft_return again", G, "POST", "/engagements/1/approve-stage", { stage: "draft_return" }, CLIENT_ERR);
  await check("POST /engagements/1/approve-stage confirmation (not submitted)", G, "POST", "/engagements/1/approve-stage", { stage: "confirmation" }, CLIENT_ERR);
  assert("repeated approve-stage added at most one approval comment",
    () => sqlNum("select count(*) from comments where engagement_id=1 and is_approval") <= 2,
    "<=2 approval comments", () => sql("select count(*) from comments where engagement_id=1 and is_approval"));

  await check("DELETE /engagements/2", G, "DELETE", "/engagements/2", null, DELETED);
  await check("GET /engagements/2 after delete", G, "GET", "/engagements/2", null, 404);
  await check("GET /deadlines/2 unlinked after engagement delete", G, "GET", "/deadlines/2", null,
    pred("engagementId null", (j) => j && j.id === 2 && (j.engagementId === null || j.engagementId === undefined)));
  assert("DB deadline 2 engagement_id is NULL", () => sql("select coalesce(engagement_id::text,'NULL') from deadlines where id=2") === "NULL",
    "NULL", () => sql("select coalesce(engagement_id::text,'NULL') from deadlines where id=2"));
  await check("DELETE /engagements/999", G, "DELETE", "/engagements/999", null, 404);

  await check("DELETE /clients/1 (has filings and documents)", G, "DELETE", "/clients/1", null,
    pred("409 mentions inactive", (j, r) => /inactive/i.test(r.text), 409));
  assert("client 1 still exists", () => sqlNum("select count(*) from clients where id=1") === 1, 1,
    () => sql("select count(*) from clients where id=1"));
  // Bravo: engagement 2 was deleted above; if its document 2 was kept, Bravo is still in use.
  if (sqlNum("select count(*) from documents where client_id=2") > 0) {
    await check("DELETE /clients/2 (still has a document)", G, "DELETE", "/clients/2", null, 409);
    assert("client 2 still exists", () => sqlNum("select count(*) from clients where id=2") === 1, 1,
      () => sql("select count(*) from clients where id=2"));
  }

  const fresh = await check("POST fresh client", G, "POST", "/clients", { name: "Charlie Empty", tin: "444-444-444-000", businessType: "sole_proprietor" }, 201);
  if (fresh.json?.id) {
    const id = fresh.json.id;
    await check("POST deadline for fresh client", G, "POST", "/deadlines", { clientId: id, title: "Charlie manual", dueDate: "2026-12-15" }, 201);
    await check("DELETE fresh client (no filings)", G, "DELETE", `/clients/${id}`, null, DELETED);
    assert("fresh client and its deadlines removed",
      () => sql(`select (select count(*) from clients where id=${id})||','||(select count(*) from deadlines where client_id=${id})`) === "0,0",
      "0,0", () => sql(`select (select count(*) from clients where id=${id})||','||(select count(*) from deadlines where client_id=${id})`));
  }
  await check("DELETE /clients/999", G, "DELETE", "/clients/999", null, 404);
  await check("DELETE /deadlines/3", G, "DELETE", "/deadlines/3", null, DELETED);
  await check("POST /documents/seed-samples", G, "POST", "/documents/seed-samples", {}, is(200, 201));
  await check("GET /audit-logs", G, "GET", "/audit-logs", null, 200);
  await check("POST /users (manager cannot manage accounts)", G, "POST", "/users", { email: "x@firm.ph", name: "x", password: "secret123", role: "maker" }, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9) Deadline tax-year bug
// ═════════════════════════════════════════════════════════════════════════════
group("9 deadline tax year", async () => {
  await reset();
  const G = "manager";
  const countAlpha = () => sqlNum("select count(*) from deadlines where client_id=1");
  const dupTitles = () => sqlNum("select count(*) from (select title from deadlines where client_id=1 group by title having count(*)>1) x");
  const ITR_LIKE = `title like ${q("BIR Form 1702 (Annual Corporate ITR) — FY 2025%")}`;

  await check("PATCH /clients/1 corporate+VAT+comp+EWT", G, "PATCH", "/clients/1",
    { incomeTaxType: "corporate", vatRegistered: true, withholdsCompensation: true, withholdsEwt: true }, 200);

  const g1 = await check("generate 2025", G, "POST", "/clients/1/generate-deadlines", { year: 2025 },
    pred("created > 0", (j) => j && j.created > 0));
  const afterFirst = countAlpha();
  assert("generate 2025 inserted rows", afterFirst > 1, ">1 rows", afterFirst);
  await check("generate 2025 again (no overwrite)", G, "POST", "/clients/1/generate-deadlines", { year: 2025 },
    pred("created 0", (j) => j && j.created === 0));
  assert("row count unchanged after 2nd 2025 generate", () => countAlpha() === afterFirst, afterFirst, countAlpha);
  assert("no duplicate titles after 2nd 2025 generate", () => dupTitles() === 0, 0, dupTitles);
  if (g1.json && typeof g1.json.created === "number") {
    assert("created count matches inserted rows", afterFirst - 1 === g1.json.created, afterFirst - 1, g1.json.created);
  }

  const itrRows = sql(`select id||'|'||due_date from deadlines where client_id=1 and ${ITR_LIKE}`).split("\n").filter(Boolean);
  assert("exactly one 2025 annual corporate ITR row", itrRows.length === 1, 1, JSON.stringify(itrRows));
  const [itrId, itrDue] = (itrRows[0] ?? "0|").split("|");
  assert("2025 ITR due 2026-04-15", itrDue === "2026-04-15", "2026-04-15", itrDue);
  sql(`update deadlines set status='completed' where id=${Number(itrId)}`);

  await check("compliance 2025: 1702 filed + linked", G, "GET", "/clients/1/compliance?year=2025", null,
    pred("1702 FY2025 item filed with deadlineId", (j) => {
      const items = (j?.items ?? []).filter((i) => i.formNumber === "1702" && String(i.period).includes("2025"));
      if (items.length === 0) return "no 1702 item";
      const it = items.find((i) => i.dueDate === "2026-04-15") ?? items[0];
      if (it.status !== "filed") return `status=${it.status}`;
      if (it.deadlineId == null) return "deadlineId null";
      if (it.deadlineId !== Number(itrId)) return `deadlineId=${it.deadlineId} want ${itrId}`;
      return true;
    }));
  // December 1601C is due January 15 (RR 11-2018); Jan 15, 2026 is a Thursday.
  await check("compliance 2025: Dec 1601C (due 2026-01-15) linked", G, "GET", "/clients/1/compliance?year=2025", null,
    pred("1601C 2026-01-15 deadlineId non-null", (j) => {
      const it = (j?.items ?? []).find((i) => i.formNumber === "1601C" && i.dueDate === "2026-01-15");
      if (!it) return "no Dec 2025 1601C item";
      return it.deadlineId != null ? true : "deadlineId null";
    }));
  await check("compliance 2025: every item linked after generate", G, "GET", "/clients/1/compliance?year=2025", null,
    pred("all items have deadlineId", (j) => {
      const items = j?.items ?? [];
      const missing = items.filter((i) => i.deadlineId == null).map((i) => `${i.formNumber}@${i.dueDate}`);
      return items.length > 0 && missing.length === 0 ? true : `unlinked: ${missing.slice(0, 5).join(",")}`;
    }));
  await check("compliance 2025 visible to Alpha's client", "client", "GET", "/clients/1/compliance?year=2025", null,
    pred("year 2025, has items", (j) => j && j.year === 2025 && Array.isArray(j.items) && j.items.length > 0));

  await check("generate 2026 overwrite", G, "POST", "/clients/1/generate-deadlines", { year: 2026, overwrite: true }, 200);
  assert("2025 ITR row survives 2026 overwrite and stays completed",
    () => sql(`select status from deadlines where id=${Number(itrId)}`) === "completed",
    "completed", () => sql(`select coalesce((select status from deadlines where id=${Number(itrId)}),'MISSING')`));
  assert("2025 rows survive 2026 overwrite",
    () => sqlNum(`select count(*) from deadlines where client_id=1 and (title like '%2025%')`) >= afterFirst - 1,
    `>= ${afterFirst - 1}`, () => sql("select count(*) from deadlines where client_id=1 and title like '%2025%'"));
  assert("no duplicate titles after 2026 overwrite", () => dupTitles() === 0, 0, dupTitles);
  assert("fixture deadline 1 (linked, Jan 2026) survives 2026 overwrite",
    () => sql("select coalesce(engagement_id,0)||','||status from deadlines where id=1") === "1,pending",
    "1,pending", () => sql("select coalesce((select coalesce(engagement_id,0)||','||status from deadlines where id=1),'MISSING')"));
  const after2026 = countAlpha();

  await check("generate 2025 overwrite", G, "POST", "/clients/1/generate-deadlines", { year: 2025, overwrite: true }, 200);
  assert("2025 ITR still completed after 2025 overwrite",
    () => sql(`select status from deadlines where id=${Number(itrId)}`) === "completed",
    "completed", () => sql(`select coalesce((select status from deadlines where id=${Number(itrId)}),'MISSING')`));
  assert("one 2025 ITR row after 2025 overwrite", () => sqlNum(`select count(*) from deadlines where client_id=1 and ${ITR_LIKE}`) === 1,
    1, () => sql(`select count(*) from deadlines where client_id=1 and ${ITR_LIKE}`));
  assert("row count unchanged by 2025 overwrite", () => countAlpha() === after2026, after2026, countAlpha);
  assert("no duplicate titles after 2025 overwrite", () => dupTitles() === 0, 0, dupTitles);
  await check("compliance 2025 still filed after overwrites", G, "GET", "/clients/1/compliance?year=2025", null,
    pred("1702 filed", (j) => (j?.items ?? []).some((i) => i.formNumber === "1702" && i.status === "filed" && i.deadlineId === Number(itrId))));
});

// ═════════════════════════════════════════════════════════════════════════════
// 10) Role refresh: a role change applies to existing sessions immediately
// ═════════════════════════════════════════════════════════════════════════════
group("10 role refresh", async () => {
  await reset();
  await check("GET /clients as maker (before)", "maker", "GET", "/clients", null, arr("both clients", (a) => a.length === 2));
  sql("update users set role='client', client_id=2 where id=3");
  try {
    await check("GET /clients after demotion to Bravo client", "maker", "GET", "/clients", null,
      arr("exactly [Bravo]", (a) => a.length === 1 && a[0].id === 2));
    await check("POST /clients after demotion", "maker", "POST", "/clients",
      { name: "Should Fail", tin: "555-555-555-000", businessType: "corporation" }, 403);
    await check("GET /engagements/1 after demotion", "maker", "GET", "/engagements/1", null, 404);
    await check("POST /engagements/2/submit-stage after demotion", "maker", "POST", "/engagements/2/submit-stage", { stage: "source_collection" }, DENIED);
    await check("GET /audit-logs after demotion", "maker", "GET", "/audit-logs", null, 403);
    // Re-link to Alpha
    sql("update users set client_id=1 where id=3");
    await check("GET /clients after re-link to Alpha", "maker", "GET", "/clients", null,
      arr("exactly [Alpha]", (a) => a.length === 1 && a[0].id === 1));
    // Promote the Alpha client to manager: gains access in the same session.
    sql("update users set role='manager', client_id=null where id=4");
    await check("GET /audit-logs after promotion", "client", "GET", "/audit-logs", null, 200);
    await check("GET /clients after promotion", "client", "GET", "/clients", null, arr("both clients", (a) => a.length === 2));
  } finally {
    sql("update users set role='maker', client_id=null where id=3; update users set role='client', client_id=1 where id=4");
  }
  await check("GET /clients as maker (restored)", "maker", "GET", "/clients", null, arr("both clients", (a) => a.length === 2));
  await check("POST /clients as maker (restored)", "maker", "POST", "/clients",
    { name: "Restored Maker Client", tin: "666-666-666-000", businessType: "corporation" }, 201);
  // A deleted user's session stops working.
  sql("delete from users where id=6");
  await check("GET /clients after account deleted", "orphan", "GET", "/clients", null, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// 11) Overdue = due strictly before today in Asia/Manila
// ═════════════════════════════════════════════════════════════════════════════
group("11 overdue today semantics", async () => {
  await reset();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" });
  const today = fmt.format(new Date());
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);

  const alphaOverdue = async (label) => {
    const r = await check(`GET /clients workflowCounts (${label})`, "manager", "GET", "/clients", null,
      arr("Alpha has workflowCounts.overdue", (a) => typeof a.find((c) => c.id === 1)?.workflowCounts?.overdue === "number"));
    return r.json?.find?.((c) => c.id === 1)?.workflowCounts?.overdue;
  };
  const summaryOverdue = async (label) => {
    const r = await check(`GET /dashboard/summary (${label})`, "client", "GET", "/dashboard/summary", null,
      pred("overdueItems number", (j) => j && typeof j.overdueItems === "number"));
    return r.json?.overdueItems;
  };

  const base = await alphaOverdue("baseline");
  const baseSummary = await summaryOverdue("baseline");

  const todayId = sqlNum(`insert into deadlines (client_id, title, due_date, status, priority) values (1, 'Due today (Manila)', ${q(today)}, 'pending', 'medium') returning id`);
  const afterToday = await alphaOverdue("due today inserted");
  assert(`deadline due today (${today}) is not overdue in /clients`, afterToday === base, base, afterToday);
  const afterTodaySummary = await summaryOverdue("due today inserted");
  assert("deadline due today is not overdue in dashboard summary", afterTodaySummary === baseSummary, baseSummary, afterTodaySummary);
  await check("due-today deadline not in /dashboard/overdue", "manager", "GET", "/dashboard/overdue", null,
    pred("today's id absent", (j) => j && Array.isArray(j.overdueDeadlines) && !j.overdueDeadlines.some((d) => d.id === todayId)));
  await check("due-today deadline in /dashboard/upcoming-deadlines", "manager", "GET", "/dashboard/upcoming-deadlines", null,
    arr("today's id present", (a) => a.some((d) => d.id === todayId)));

  const yId = sqlNum(`insert into deadlines (client_id, title, due_date, status, priority) values (1, 'Due yesterday (Manila)', ${q(yesterday)}, 'pending', 'medium') returning id`);
  const afterY = await alphaOverdue("due yesterday inserted");
  assert(`deadline due yesterday (${yesterday}) is overdue in /clients`, typeof base === "number" && afterY === base + 1,
    typeof base === "number" ? base + 1 : "number", afterY);
  const afterYSummary = await summaryOverdue("due yesterday inserted");
  assert("deadline due yesterday is overdue in dashboard summary",
    typeof baseSummary === "number" && afterYSummary === baseSummary + 1, typeof baseSummary === "number" ? baseSummary + 1 : "number", afterYSummary);
  await check("due-yesterday deadline in /dashboard/overdue", "client", "GET", "/dashboard/overdue", null,
    pred("yesterday's id present", (j) => j && Array.isArray(j.overdueDeadlines) && j.overdueDeadlines.some((d) => d.id === yId)));
  await check("due-today deadline visible on the deadlines page", "client", "GET", "/deadlines", null,
    arr("contains both inserted", (a) => a.some((d) => d.id === todayId) && a.some((d) => d.id === yId)));
});


// ═════════════════════════════════════════════════════════════════════════════
// 12) Review findings (regressions)
// ═════════════════════════════════════════════════════════════════════════════
group("12a document filename + lock", async () => {
  await reset();
  const M = "maker";
  const canary = path.join(UPLOADS_DIR, "..", "authz-canary.txt");
  if (!DRY_RUN) fs.writeFileSync(canary, "CANARY-SECRET");
  const base = { originalName: "x.txt", mimeType: "text/plain", fileSize: 5, fileUrl: "/files/x" };

  const r = await check("POST /documents traversal filename", M, "POST", "/documents",
    { ...base, clientId: 1, filename: "../authz-canary.txt" }, is(201, 400));
  if (r.status === 201 && r.json?.id) {
    const id = r.json.id;
    assert("stored filename is server-generated (no '..' or '/')",
      () => !/[\\/]|\.\./.test(sql(`select filename from documents where id=${id}`)),
      "flat generated name", () => sql(`select filename from documents where id=${id}`));
    for (const role of [M, "client"]) {
      await check(`GET /documents/${id}/content does not serve the canary`, role, "GET", `/documents/${id}/content`, null,
        { desc: "not CANARY-SECRET", test: (res) => !res.text.includes("CANARY-SECRET") });
    }
    await check(`DELETE /documents/${id}`, M, "DELETE", `/documents/${id}`, null, DELETED);
  }
  assert("file outside UPLOADS_DIR survives", () => DRY_RUN || fs.existsSync(canary), "exists", "deleted");

  // Pointing at another document's stored file must not let a delete remove it.
  const r2 = await check("POST /documents filename = doc 1's file", M, "POST", "/documents",
    { ...base, clientId: 1, filename: "a.txt" }, is(201, 400));
  if (r2.status === 201 && r2.json?.id) {
    await check("DELETE the new record", M, "DELETE", `/documents/${r2.json.id}`, null, DELETED);
  }
  assert("doc 1's file a.txt still on disk", () => DRY_RUN || fs.existsSync(path.join(UPLOADS_DIR, "a.txt")), "exists", "deleted");
  await check("GET /documents/1/content still served", "client", "GET", "/documents/1/content", null,
    { desc: "200 alpha", test: (res) => res.status === 200 && res.text === "alpha" });

  // Completed filing: POST /documents follows the same lock as /documents/upload.
  sql("update engagements set status='completed' where id=2");
  const before = sqlNum("select count(*) from documents");
  await check("POST /documents to a completed filing", M, "POST", "/documents",
    { ...base, engagementId: 2, filename: "y.txt" }, 403);
  assert("no document added to the completed filing", () => sqlNum("select count(*) from documents") === before,
    before, () => sql("select count(*) from documents"));
  await check("POST /documents to an open filing", M, "POST", "/documents",
    { ...base, engagementId: 1, filename: "z.txt" }, pred("clientId 1", (j) => j && j.clientId === 1, 201));
  if (!DRY_RUN) fs.rmSync(canary, { force: true });
});

group("12b users + recall", async () => {
  await reset();
  const A = "admin";
  await check("GET /users as client = own record only", "client", "GET", "/users", null,
    arr("only id 4", (a) => a.length === 1 && a[0].id === 4));
  await check("GET /users as unlinked client = own record only", "orphan", "GET", "/users", null,
    arr("only id 6", (a) => a.length === 1 && a[0].id === 6));
  await check("GET /users as maker still lists staff", "maker", "GET", "/users", null,
    arr("contains manager", (a) => a.some((u) => u.id === 2)));

  const mk = (email, clientId) => ({ email, name: "New Client", password: "secret123", role: "client", clientId });
  await check("POST /users clientId of a missing client", A, "POST", "/users", mk("nc1@example.com", 9999), 400);
  await check("POST /users non-numeric clientId", A, "POST", "/users", mk("nc2@example.com", "abc"), 400);
  await check("POST /users clientId '1abc'", A, "POST", "/users", mk("nc3@example.com", "1abc"), 400);
  assert("no user created with a bad clientId", () => sqlNum("select count(*) from users where email like 'nc_@example.com'") === 0,
    0, () => sql("select count(*) from users where email like 'nc_@example.com'"));
  await check("POST /users valid clientId", A, "POST", "/users", mk("nc4@example.com", 2), pred("clientId 2", (j) => j && j.clientId === 2, 201));
  await check("PATCH /users/6 clientId of a missing client", A, "PATCH", "/users/6", { clientId: 9999 }, 400);
  await check("PATCH /users/6 clientId '2abc'", A, "PATCH", "/users/6", { clientId: "2abc" }, 400);
  assert("orphan still unlinked", () => sql("select coalesce(client_id::text,'NULL') from users where id=6") === "NULL",
    "NULL", () => sql("select coalesce(client_id::text,'NULL') from users where id=6"));

  // Policy 3: makers and above recall stages (engagement 1 draft_return is for_review).
  await check("manager POST /engagements/1/recall-stage draft_return", "manager", "POST", "/engagements/1/recall-stage",
    { stage: "draft_return" }, 200);
  sql("update engagements set draft_return_status='for_review' where id=1");
  await check("admin POST /engagements/1/recall-stage draft_return", A, "POST", "/engagements/1/recall-stage",
    { stage: "draft_return" }, 200);
});

group("12c demoted staff keep no other-scope data", async () => {
  await reset();
  // A former maker (user 3, assigned to both filings) is turned into Alpha's client account.
  sql(`insert into assistant_conversations (user_id, title, messages) values (3, 'firm-wide', '[]'::jsonb)`);
  sql(`insert into notifications (user_id, title, message, type, related_id, related_type)
       values (3, 'Stage Approved', 'Bravo filing', 'engagement_approved', 2, 'engagement')`);
  await check("admin PATCH /users/3 -> client of Alpha", "admin", "PATCH", "/users/3", { role: "client", clientId: 1 }, 200);
  assert("assistant conversations removed on scope change",
    () => sqlNum("select count(*) from assistant_conversations where user_id=3") === 0, 0,
    () => sql("select count(*) from assistant_conversations where user_id=3"));
  await check("former maker GET /assistant/conversations empty", "maker", "GET", "/assistant/conversations", null,
    pred("no conversations", (j) => Array.isArray(j) ? j.length === 0 : Array.isArray(j?.conversations) && j.conversations.length === 0));
  await check("former maker GET /notifications empty", "maker", "GET", "/notifications", null, EMPTY);
  assert("former maker no longer assigned to filings",
    () => sqlNum("select count(*) from engagements where assigned_to=3") === 0, 0,
    () => sql("select count(*) from engagements where assigned_to=3"));

  // Role changed outside PATCH /users (e.g. directly in the DB): still no notices.
  await reset();
  sql("update users set role='client', client_id=1 where id=3");
  await check("manager reject-stage eng 1 draft_return", "manager", "POST", "/engagements/1/reject-stage",
    { stage: "draft_return", notes: "fix the totals" }, 200);
  sql("update engagements set source_collection_status='for_review' where id=2");
  await check("manager approve-stage eng 2 source_collection", "manager", "POST", "/engagements/2/approve-stage",
    { stage: "source_collection" }, 200);
  assert("client-role assignee got no workflow notifications",
    () => sqlNum("select count(*) from notifications where user_id=3") === 0, 0,
    () => sql("select count(*) from notifications where user_id=3"));
  sql("update engagements set status='completed' where id=2");
  const am = await check("POST /engagements/2/amend", "manager", "POST", "/engagements/2/amend", {}, 201);
  if (am.json?.id) {
    assert("amendment does not carry a non-staff assignee",
      () => sql(`select coalesce(assigned_to::text,'NULL') from engagements where id=${am.json.id}`) === "NULL",
      "NULL", () => sql(`select coalesce(assigned_to::text,'NULL') from engagements where id=${am.json.id}`));
  }
});

group("12d deadline duplicates, legacy rows, overdue status", async () => {
  await reset();
  const G = "manager";
  const dupTitles = (c) => sqlNum(`select count(*) from (select title from deadlines where client_id=${c} group by title having count(*)>1) x`);
  const alpha = async (label) => {
    const r = await check(`GET /clients (${label})`, G, "GET", "/clients", null, arr("has Alpha", (a) => a.some((c) => c.id === 1)));
    return r.json?.find?.((c) => c.id === 1)?.workflowCounts;
  };
  const summary = async (label) => (await check(`GET /dashboard/summary (${label})`, G, "GET", "/dashboard/summary", null, 200)).json;

  // Concurrent generate runs must not insert duplicates.
  await Promise.all([1, 2, 3, 4].map(() => call(G, "POST", "/clients/2/generate-deadlines", { year: 2025 })));
  assert("4 parallel generate runs leave no duplicate titles", () => dupTitles(2) === 0, 0, () => dupTitles(2));

  // A legacy duplicate of a filed filing is not overdue anywhere.
  await reset();
  const base = await alpha("baseline");
  const baseSum = await summary("baseline");
  const dupId = sqlNum(`insert into deadlines (client_id, title, due_date, status, priority) values (1, 'BIR Form 1601C — January 2026', '2026-02-10', 'pending', 'high') returning id`);
  sql("update deadlines set status='completed' where id=1");
  const afterFiled = await alpha("filed + stale duplicate");
  assert("stale duplicate of a filed filing not overdue in /clients",
    () => afterFiled.overdue === base.overdue - 1, base?.overdue - 1, afterFiled?.overdue);
  const sumFiled = await summary("filed + stale duplicate");
  assert("stale duplicate not overdue in dashboard summary", () => sumFiled.overdueItems === baseSum.overdueItems - 1,
    baseSum?.overdueItems - 1, sumFiled?.overdueItems);
  await check("stale duplicate not in /dashboard/overdue", G, "GET", "/dashboard/overdue", null,
    pred("dup id absent", (j) => !(j?.overdueDeadlines ?? []).some((d) => d.id === dupId || d.id === 1)));

  // Two open copies of one filing count once; generate merges them.
  await reset();
  sql(`insert into deadlines (client_id, title, due_date, status, priority) values (1, 'BIR Form 1601C — February 2026', '2026-03-10', 'pending', 'high'), (1, 'BIR Form 1601C — February 2026', '2026-03-10', 'pending', 'high')`);
  const two = await alpha("two copies");
  assert("two open copies count as one overdue filing", () => two.overdue === base.overdue + 1, base?.overdue + 1, two?.overdue);
  await check("generate 2026 (no overwrite) merges duplicates", G, "POST", "/clients/1/generate-deadlines", { year: 2026 }, 200);
  assert("no duplicate titles after generate", () => dupTitles(1) === 0, 0, () => dupTitles(1));
  assert("linked deadline 1 kept by the merge", () => sql("select coalesce(engagement_id,0)||','||status from deadlines where id=1") === "1,pending",
    "1,pending", () => sql("select coalesce((select coalesce(engagement_id,0)||','||status from deadlines where id=1),'MISSING')"));

  // Legacy (tax_year NULL) generated rows that no longer apply are removed by overwrite.
  await reset();
  const staleId = sqlNum(`insert into deadlines (client_id, title, due_date, status, priority) values (2, 'Summary List of Sales (SLS) — Q1 2026', '2026-04-25', 'pending', 'medium') returning id`);
  const keepId = sqlNum(`insert into deadlines (client_id, title, due_date, status, priority) values (2, 'BIR Form 1701Q — Q2 2026', '2026-08-14', 'pending', 'high') returning id`);
  await check("generate 2026 overwrite for Bravo (non-VAT)", G, "POST", "/clients/2/generate-deadlines", { year: 2026, overwrite: true }, 200);
  assert("stale legacy VAT row removed", () => sqlNum(`select count(*) from deadlines where id=${staleId}`) === 0, 0,
    () => sql(`select count(*) from deadlines where id=${staleId}`));
  assert("legacy row of a current filing kept and tagged 2026",
    () => sql(`select coalesce(tax_year::text,'NULL') from deadlines where id=${keepId}`) === "2026", "2026",
    () => sql(`select coalesce((select coalesce(tax_year::text,'NULL') from deadlines where id=${keepId}),'MISSING')`));
  assert("manual deadline 3 kept", () => sqlNum("select count(*) from deadlines where id=3") === 1, 1,
    () => sql("select count(*) from deadlines where id=3"));
  assert("linked deadline 2 kept", () => sqlNum("select count(*) from deadlines where id=2") === 1, 1,
    () => sql("select count(*) from deadlines where id=2"));

  // status 'overdue' is still an open deadline on the dashboard.
  await reset();
  const sumBefore = await summary("before overdue status");
  await check("PATCH /deadlines/3 status overdue, past due", "maker", "PATCH", "/deadlines/3", { status: "overdue", dueDate: "2026-10-01" }, 200);
  const sumAfter = await summary("after overdue status");
  assert("deadline with status 'overdue' counted in dashboard summary",
    () => sumAfter.overdueItems === sumBefore.overdueItems + 1, sumBefore?.overdueItems + 1, sumAfter?.overdueItems);
  await check("deadline with status 'overdue' listed in /dashboard/overdue", G, "GET", "/dashboard/overdue", null,
    pred("id 3 present", (j) => (j?.overdueDeadlines ?? []).some((d) => d.id === 3)));
});

group("12e fiscal-year tax year", async () => {
  await reset();
  const G = "manager";
  const due = (c, title) => sql(`select coalesce((select string_agg(due_date::text, ',') from deadlines where client_id=${c} and title=${q(title)}),'MISSING')`);

  // Calendar-year individual (Bravo): the FY 2025 annual return is due April 15, 2026.
  await check("generate Bravo 2025", G, "POST", "/clients/2/generate-deadlines", { year: 2025 }, 200);
  assert("1701 FY 2025 due 2026-04-15", () => due(2, "BIR Form 1701 (Annual Individual ITR) — FY 2025") === "2026-04-15",
    "2026-04-15", () => due(2, "BIR Form 1701 (Annual Individual ITR) — FY 2025"));

  // July–June corporate: tax year 2025 = FY July 2025 – June 2026.
  await check("PATCH /clients/1 FY July-June corporate", G, "PATCH", "/clients/1",
    { fiscalYearStart: "July", fiscalYearEnd: "June", incomeTaxType: "corporate", vatRegistered: true, withholdsEwt: true, withholdsCompensation: true }, 200);
  await check("generate Alpha 2025", G, "POST", "/clients/1/generate-deadlines", { year: 2025 }, 200);
  const itr = "BIR Form 1702 (Annual Corporate ITR) — FY 2025";
  assert("1702 FY 2025 (Jul 2025-Jun 2026) due 2026-10-15", () => due(1, itr) === "2026-10-15", "2026-10-15", () => due(1, itr));
  assert("AFS FY 2025 due 2026-10-15", () => due(1, "Audited Financial Statements — FY 2025") === "2026-10-15",
    "2026-10-15", () => due(1, "Audited Financial Statements — FY 2025"));
  // Statutory date Sat Nov 29, 2025; Nov 30 is a Sunday and Bonifacio Day, so it rolls to Mon Dec 1 (RMC 65-2016).
  assert("1702Q Q1 2025 (Jul-Sep 2025) due 2025-12-01", () => due(1, "BIR Form 1702Q — Q1 2025") === "2025-12-01",
    "2025-12-01", () => due(1, "BIR Form 1702Q — Q1 2025"));
  assert("1601EQ Q1 2025 follows the calendar quarter (due 2025-04-30)", () => due(1, "BIR Form 1601EQ — Q1 2025") === "2025-04-30",
    "2025-04-30", () => due(1, "BIR Form 1601EQ — Q1 2025"));
  assert("0619E January 2025 generated for tax year 2025", () => due(1, "BIR Form 0619E — January 2025") === "2025-02-10",
    "2025-02-10", () => due(1, "BIR Form 0619E — January 2025"));
  assert("every tax-year-2025 title is labelled 2025",
    () => sqlNum("select count(*) from deadlines where client_id=1 and tax_year=2025 and title not like '%2025'") === 0, 0,
    () => sql("select string_agg(title, ' | ') from deadlines where client_id=1 and tax_year=2025 and title not like '%2025'"));
  const n2025 = sqlNum("select count(*) from deadlines where client_id=1 and tax_year=2025");
  await check("generate Alpha 2026", G, "POST", "/clients/1/generate-deadlines", { year: 2026, overwrite: true }, 200);
  assert("2026 generate leaves the 2025 rows alone", () => sqlNum("select count(*) from deadlines where client_id=1 and tax_year=2025") === n2025,
    n2025, () => sql("select count(*) from deadlines where client_id=1 and tax_year=2025"));
  assert("every tax-year-2026 title is labelled 2026",
    () => sqlNum("select count(*) from deadlines where client_id=1 and tax_year=2026 and title not like '%2026'") === 0, 0,
    () => sql("select string_agg(title, ' | ') from deadlines where client_id=1 and tax_year=2026 and title not like '%2026'"));
});

group("12f client-list workflow badges match the client page", async () => {
  await reset();
  const G = "manager";
  const counts = async (label) => {
    const r = await check(`GET /clients (${label})`, G, "GET", "/clients", null, arr("has Alpha", (a) => a.some((c) => c.id === 1)));
    return r.json?.find?.((c) => c.id === 1)?.workflowCounts;
  };
  const page = async (label) => {
    const r = await check(`GET /clients/1/compliance (${label})`, G, "GET", "/clients/1/compliance", null, 200);
    const items = r.json?.items ?? [];
    return {
      inProgress: items.filter((i) => i.workflowStatus === "in_progress").length,
      forReview: items.filter((i) => Object.values(i.stageStatuses ?? {}).includes("for_review")).length,
    };
  };
  const c1 = await counts("fixture");
  const p1 = await page("fixture");
  assert("for-review badge = items the ?wf=for_review filter shows", () => c1.forReview === p1.forReview && p1.forReview === 1,
    `${p1?.forReview} (=1)`, c1?.forReview);
  assert("in-progress badge = items the ?wf=in_progress filter shows", () => c1.inProgress === p1.inProgress,
    p1?.inProgress, c1?.inProgress);
  sql(`insert into engagements (client_id, title, tax_type, period, status, draft_return_status) values (1, 'Unlinked filing', '1601C', 'March 2020', 'in_progress', 'for_review')`);
  const c2 = await counts("unlinked in-progress engagement added");
  assert("an engagement with no deadline this year does not change the badges",
    () => c2.inProgress === c1.inProgress && c2.forReview === c1.forReview, JSON.stringify(c1), JSON.stringify(c2));
});

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const h = await fetch(`${BASE}/healthz`);
    if (!h.ok) throw new Error(`healthz ${h.status}`);
  } catch (err) {
    console.error(`API not reachable at ${BASE}: ${err?.message ?? err}`);
    process.exit(2);
  }

  for (const g of groups) {
    if (ONLY && !g.name.includes(ONLY)) continue;
    console.log(`\n=== ${g.name} ===`);
    try {
      await g.fn();
    } catch (err) {
      record(`group "${g.name}" crashed`, false, "no exception", String(err?.stack ?? err).slice(0, 400));
    }
  }

  // Leave the DB in the fixture state for whoever runs next.
  try {
    await reset();
  } catch (err) {
    console.log(`(final fixture reset failed: ${err?.message ?? err})`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed, ${passed + failures.length} total`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

await main();
