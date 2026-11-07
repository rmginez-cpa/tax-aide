// TaxAide home-track integration tests: GET /dashboard/my-work ("Needs my action" card) and
// the notifications endpoints (unread count, newest-first ordering, own-user scoping).
// Same harness, environment and guard as authz.test.mjs (copied so each suite runs on its own).
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

// ── Helpers for this suite ───────────────────────────────────────────────────
// "today" in Manila as SQL (the API uses lib/dates manilaToday()).
const TODAY_SQL = "((now() at time zone 'Asia/Manila')::date)";
const dayExpr = (n) => `to_char(${TODAY_SQL} + ${n}, 'YYYY-MM-DD')`;
const ids = (list) => (list ?? []).map((x) => x.id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const myWork = (desc, fn) => pred(desc, (j) => j && Array.isArray(j.filings) && Array.isArray(j.deadlines) && fn(j));

// ── 1 my-work: authentication ────────────────────────────────────────────────
group("1 my-work auth", async () => {
  await reset();
  await check("GET /dashboard/my-work unauthenticated", null, "GET", "/dashboard/my-work", null, 401);
});

// ── 2 my-work: managers see stages awaiting review, oldest first ────────────
group("2 my-work review", async () => {
  await reset();
  sql(`
    update engagements set updated_at = now() - interval '1 day' where id = 1;
    insert into engagements (id, client_id, title, tax_type, period, status, assigned_to, due_date, confirmation_status, payment_status, updated_at)
    values (3, 2, 'Bravo older review', '2551Q', 'Q2 2026', 'in_progress', 3, '2026-07-25', 'for_review', 'for_review', now() - interval '3 days');
    insert into engagements (id, client_id, title, tax_type, period, status, assigned_to, payment_status, tax_payable)
    values (4, 1, 'Alpha zero-tax payment', '0619E', 'May 2026', 'in_progress', 3, 'for_review', 0);
    insert into engagements (id, client_id, title, tax_type, period, status, assigned_to, draft_return_status)
    values (5, 1, 'Alpha nothing for review', '1601C', 'June 2026', 'in_progress', 3, 'in_progress');
    select setval('engagements_id_seq', 5);
  `);
  for (const role of ["manager", "admin"]) {
    const r = await check("GET /dashboard/my-work kind=review", role, "GET", "/dashboard/my-work", null,
      myWork("kind review", (j) => j.kind === "review" && j.deadlines.length === 0));
    const f = r.json?.filings ?? [];
    assert(`[${role}] review list = for_review filings, oldest first`, () => same(ids(f), [3, 1]), "[3,1]", JSON.stringify(ids(f)));
    assert(`[${role}] stagesForReview lists the stage keys`,
      () => same(f.find((x) => x.id === 3)?.stagesForReview, ["confirmation", "payment"]) && same(f.find((x) => x.id === 1)?.stagesForReview, ["draft_return"]),
      "e3 [confirmation,payment], e1 [draft_return]", JSON.stringify(f.map((x) => [x.id, x.stagesForReview])));
    assert(`[${role}] review rows carry client name and due date`,
      () => f.find((x) => x.id === 1)?.clientName === "Alpha Corp" && f.find((x) => x.id === 1)?.dueDate === "2026-02-10",
      "Alpha Corp / 2026-02-10", JSON.stringify(f.find((x) => x.id === 1)));
    assert(`[${role}] zero-tax payment stage is not awaiting review`, () => !ids(f).includes(4), "no 4", JSON.stringify(ids(f)));
    assert(`[${role}] totals.filings matches`, () => r.json?.totals?.filings === 2, 2, r.json?.totals?.filings);
  }
});

// ── 3 my-work: makers see their open filings and deadlines in 14 days ───────
group("3 my-work maker", async () => {
  await reset();
  sql(`
    insert into engagements (id, client_id, title, tax_type, period, status, assigned_to, due_date)
    values (3, 1, 'Alpha done', '1601C', 'March 2026', 'completed', 3, '2026-04-10'),
           (4, 2, 'Bravo assigned to manager', '2551Q', 'Q3 2026', 'in_progress', 2, ${dayExpr(3)}),
           (5, 1, 'Alpha no due date', '1702', '2026', 'pending', 3, null);
    select setval('engagements_id_seq', 5);
    insert into deadlines (id, client_id, engagement_id, title, due_date, status, priority)
    values (10, 2, 2, 'Bravo soon', ${dayExpr(5)}, 'pending', 'high'),
           (11, 2, 2, 'Bravo later', ${dayExpr(20)}, 'pending', 'low'),
           (12, 2, 4, 'Not mine soon', ${dayExpr(3)}, 'pending', 'high'),
           (13, 1, 1, 'Alpha soon but done', ${dayExpr(2)}, 'completed', 'medium'),
           (14, 1, 1, 'Alpha today', ${dayExpr(0)}, 'pending', 'medium');
    select setval('deadlines_id_seq', 14);
  `);
  const r = await check("GET /dashboard/my-work kind=maker", "maker", "GET", "/dashboard/my-work", null,
    myWork("kind maker", (j) => j.kind === "maker" && j.windowDays === 14));
  const f = r.json?.filings ?? [];
  const d = r.json?.deadlines ?? [];
  assert("maker: assigned open filings by due date (no due date last)", () => same(ids(f), [1, 2, 5]), "[1,2,5]", JSON.stringify(ids(f)));
  assert("maker: past-due filings flagged overdue", () => f.find((x) => x.id === 1)?.overdue === true && f.find((x) => x.id === 5)?.overdue === false,
    "e1 overdue, e5 not", JSON.stringify(f.map((x) => [x.id, x.overdue])));
  assert("maker: deadlines of my filings due in the next 14 days, by due date", () => same(ids(d), [14, 10]), "[14,10]", JSON.stringify(ids(d)));
  assert("maker: deadline rows carry daysUntilDue", () => d.find((x) => x.id === 10)?.daysUntilDue === 5 && d.find((x) => x.id === 14)?.daysUntilDue === 0,
    "10->5, 14->0", JSON.stringify(d.map((x) => [x.id, x.daysUntilDue])));

  // A maker with nothing assigned gets empty lists.
  sql("update engagements set assigned_to = 2 where assigned_to = 3");
  await check("GET /dashboard/my-work nothing assigned", "maker", "GET", "/dashboard/my-work", null,
    myWork("empty lists", (j) => j.kind === "maker" && j.filings.length === 0 && j.deadlines.length === 0 && j.totals.filings === 0));
});

// ── 4 my-work: clients see only their own client's open work ────────────────
group("4 my-work client scope", async () => {
  await reset();
  sql(`
    insert into engagements (id, client_id, title, tax_type, period, status, due_date)
    values (3, 1, 'Alpha not started', '1601C', 'April 2026', 'pending', '2026-05-10'),
           (4, 1, 'Alpha completed', '1601C', 'May 2026', 'completed', '2026-06-10');
    select setval('engagements_id_seq', 4);
    insert into deadlines (id, client_id, engagement_id, title, due_date, status, priority)
    values (10, 1, null, 'Alpha filed already', '2026-03-01', 'completed', 'low');
    select setval('deadlines_id_seq', 10);
  `);
  for (const role of CLIENTS) {
    const r = await check("GET /dashboard/my-work kind=client", role, "GET", "/dashboard/my-work", null,
      myWork("kind client", (j) => j.kind === "client"));
    const j = r.json ?? {};
    assert(`[${role}] filings in progress: only Alpha's in-progress filing`, () => same(ids(j.filings), [1]), "[1]", JSON.stringify(ids(j.filings)));
    assert(`[${role}] open deadlines: only Alpha's open deadline`, () => same(ids(j.deadlines), [1]), "[1]", JSON.stringify(ids(j.deadlines)));
    assert(`[${role}] nothing of Bravo leaks`,
      () => [...(j.filings ?? []), ...(j.deadlines ?? [])].every((x) => x.clientId === 1), "clientId 1 only",
      JSON.stringify([...(j.filings ?? []), ...(j.deadlines ?? [])].map((x) => x.clientId)));
  }
  const b = await check("GET /dashboard/my-work (Bravo client)", "clientb", "GET", "/dashboard/my-work", null,
    myWork("Bravo only", (j) => j.kind === "client"));
  assert("[clientb] Bravo filings and deadlines", () => same(ids(b.json?.filings), [2]) && same(ids(b.json?.deadlines), [2, 3]),
    "filings [2], deadlines [2,3]", JSON.stringify([ids(b.json?.filings), ids(b.json?.deadlines)]));
  await check("GET /dashboard/my-work (unlinked client)", "orphan", "GET", "/dashboard/my-work", null,
    myWork("empty", (j) => j.kind === "client" && j.filings.length === 0 && j.deadlines.length === 0 && j.totals.filings === 0 && j.totals.deadlines === 0));
});

// ── 5 notifications: unread count, ordering, own-user scope ─────────────────
group("5 notifications", async () => {
  await reset();
  for (const role of ["client", "maker"]) {
    await check("GET /notifications/unread-count unauthenticated", null, "GET", "/notifications/unread-count", null, 401);
    await check("GET /notifications/unread-count (none yet)", role, "GET", "/notifications/unread-count", null,
      pred("count 0", (j) => j?.count === 0));
  }
  sql(`
    insert into notifications (id, user_id, title, message, type, related_id, related_type, is_read, created_at) values
      (1, 3, 'Oldest', 'm', 'engagement_status_change', 1, 'engagement', false, now() - interval '3 hours'),
      (2, 3, 'Newest', 'm', 'engagement_approved', 1, 'engagement', false, now() - interval '1 hour'),
      (3, 3, 'Middle (read)', 'm', 'comment_added', 1, 'engagement', true, now() - interval '2 hours'),
      (4, 2, 'Manager one', 'm', 'engagement_status_change', 1, 'engagement', false, now()),
      (5, 2, 'Manager two', 'm', 'engagement_status_change', 2, 'engagement', false, now()),
      (6, 4, 'Client one', 'm', 'engagement_status_change', 1, 'engagement', false, now());
    select setval('notifications_id_seq', 6);
  `);
  await check("GET /notifications/unread-count (own unread only)", "maker", "GET", "/notifications/unread-count", null, pred("count 2", (j) => j?.count === 2));
  await check("GET /notifications/unread-count", "manager", "GET", "/notifications/unread-count", null, pred("count 2", (j) => j?.count === 2));
  await check("GET /notifications/unread-count", "client", "GET", "/notifications/unread-count", null, pred("count 1", (j) => j?.count === 1));
  await check("GET /notifications/unread-count (Bravo client has none)", "clientb", "GET", "/notifications/unread-count", null, pred("count 0", (j) => j?.count === 0));
  await check("GET /notifications/unread-count (viewer is not user 4)", "viewer", "GET", "/notifications/unread-count", null, pred("count 0", (j) => j?.count === 0));
  await check("GET /notifications newest first", "maker", "GET", "/notifications", null,
    arr("[2,3,1]", (a) => same(ids(a), [2, 3, 1])));
  await check("GET /notifications ties broken by id desc", "manager", "GET", "/notifications", null,
    arr("[5,4]", (a) => same(ids(a), [5, 4])));
  await check("GET /notifications only own", "client", "GET", "/notifications", null, arr("[6]", (a) => same(ids(a), [6])));

  // Cannot mark somebody else's notification; marking own decrements the count.
  await check("POST /notifications/2/read (maker's) as client", "client", "POST", "/notifications/2/read", null, 404);
  await check("unread-count unchanged for maker", "maker", "GET", "/notifications/unread-count", null, pred("count 2", (j) => j?.count === 2));
  await check("POST /notifications/2/read own", "maker", "POST", "/notifications/2/read", null, pred("isRead", (j) => j?.isRead === true));
  await check("unread-count after mark read", "maker", "GET", "/notifications/unread-count", null, pred("count 1", (j) => j?.count === 1));
  await check("POST /notifications/read-all", "maker", "POST", "/notifications/read-all", null, 200);
  await check("unread-count after read-all", "maker", "GET", "/notifications/unread-count", null, pred("count 0", (j) => j?.count === 0));
  await check("read-all touched only the caller", "manager", "GET", "/notifications/unread-count", null, pred("count 2", (j) => j?.count === 2));
  await check("read-all touched only the caller", "client", "GET", "/notifications/unread-count", null, pred("count 1", (j) => j?.count === 1));
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
