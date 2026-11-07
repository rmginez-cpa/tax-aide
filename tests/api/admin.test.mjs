// TaxAide audit-trail integration tests: GET /api/audit-logs pagination + filters,
// GET /api/audit-logs/filters and GET /api/audit-logs/export.csv (CSV escaping, row cap,
// role gates). Dependency-free Node 22+ ES module, same env and guard as authz.test.mjs.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table (and this suite rewrites
// !! audit_logs). Point it only at a throwaway database. Refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md (replace authz.test.mjs with admin.test.mjs)
// Env:  API_BASE, FIXTURE, UPLOADS_DIR, PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.env.TAXAIDE_TEST_RESET_DB !== "1") {
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
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(HERE, "uploads");
const ONLY = process.env.ONLY ?? "";

const USERS = {
  admin: ["admin@firm.ph", "admin123"],
  manager: ["manager@firm.ph", "manager123"],
  maker: ["accountant@firm.ph", "accountant123"],
  client: ["client@example.com", "client123"], // -> Alpha (1)
  clientb: ["clientb@example.com", "client123"], // -> Bravo (2)
  orphan: ["orphan@example.com", "client123"], // unlinked client
  viewer: ["viewer@example.com", "client123"], // legacy viewer -> Alpha (1)
};
const MANAGERS = ["manager", "admin"];
const DENIED_ROLES = ["maker", "client", "clientb", "orphan", "viewer"];

// ── DB helpers ───────────────────────────────────────────────────────────────
function sql(query) {
  return execSync("psql -q -tA -v ON_ERROR_STOP=1", { input: query, env: PG_ENV, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .trim();
}
function sqlNum(query) {
  const n = Number(sql(query).split("\n")[0]);
  if (Number.isNaN(n)) throw new Error(`non-numeric SQL result for ${query}`);
  return n;
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
  if (res.status !== 200 || !sid) throw new Error(`login failed for ${role}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  cookies[role] = sid;
}

async function reset() {
  execSync(`psql -q -v ON_ERROR_STOP=1 -f ${JSON.stringify(FIXTURE)}`, { env: PG_ENV, stdio: ["ignore", "ignore", "pipe"] });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, "a.txt"), "alpha");
  fs.writeFileSync(path.join(UPLOADS_DIR, "b.txt"), "bravo");
  sql(`
    update users set role='super_admin', client_id=null where id=1;
    update users set role='manager', client_id=null where id=2;
    update users set role='maker', client_id=null where id=3;
    update users set role='client', client_id=1 where id=4;
  `);
  for (const role of Object.keys(USERS)) await login(role);
}

async function call(role, method, urlPath) {
  const headers = {};
  if (role && cookies[role]) headers.Cookie = cookies[role];
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, redirect: "manual" });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

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
function assert(name, cond, expected, got) {
  let ok;
  let actual = got;
  try {
    ok = typeof cond === "function" ? cond() : cond;
  } catch (err) {
    ok = false;
    actual = `exception ${err?.message ?? err}`;
  }
  if (typeof actual === "function") {
    try {
      actual = actual();
    } catch (err) {
      actual = `exception ${err?.message ?? err}`;
    }
  }
  record(name, ok === true, expected, actual);
}
async function status(name, role, urlPath, expected) {
  const r = await call(role, "GET", urlPath);
  const codes = Array.isArray(expected) ? expected : [expected];
  record(`[${role ?? "anon"}] ${name}`, codes.includes(r.status), codes.join("|"), `${r.status} ${r.text.slice(0, 160)}`);
  return r;
}
const groups = [];
function group(name, fn) {
  groups.push({ name, fn });
}

const total = (r) => Number(r.headers.get("x-total-count"));
const ids = (r) => (Array.isArray(r.json) ? r.json.map((l) => l.id) : []);

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF/LF inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Seeds a known audit trail (ids are deterministic after RESTART IDENTITY):
//  - 120 bulk rows (ids 1-120), user 3, action 'update', entity 'deadline', one per minute
//    ending 2026-01-31, descriptions "Bulk row N"
//  - id 121: 2026-03-01 23:59:59 Manila (15:59:59Z), user 2, 'approve', 'engagement' #1
//  - id 122: 2026-03-02 00:00:00 Manila (16:00:00Z), user 2, 'approve', 'engagement' #2
//  - id 123: tricky CSV text (comma, quotes, newline), user 1, 'delete', 'client' #1
//  - id 124: literal % and _ ("100%_off"), user 1, 'create', 'document'
//  - id 125: spreadsheet formula "=HYPERLINK(...)", no user, 'comment', 'comment'
//  - id 126: 2026-03-03, user 3, 'create', 'client' #2 ("Created client Bravo Inc")
const TRICKY = 'Renamed client "Alpha, Corp"\nline two, with "quotes"';
function seedAudit() {
  sql(`
    TRUNCATE audit_logs RESTART IDENTITY;
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, created_at)
      SELECT 3, 'update', 'deadline', g, 'Bulk row ' || g, timestamptz '2026-01-31 00:00:00+00' - make_interval(mins => 121 - g)
      FROM generate_series(1, 120) g;
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, description, created_at) VALUES
      (2, 'approve', 'engagement', 1, 'Approved stage late on March 1', '2026-03-01T15:59:59Z'),
      (2, 'approve', 'engagement', 2, 'Approved stage at Manila midnight', '2026-03-01T16:00:00Z'),
      (1, 'delete', 'client', 1, ${"'" + TRICKY.replace(/'/g, "''") + "'"}, '2026-03-02T05:00:00Z'),
      (1, 'create', 'document', 9, 'Uploaded 100%_off promo.pdf', '2026-03-02T06:00:00Z'),
      (NULL, 'comment', 'comment', 3, '=HYPERLINK("http://evil")', '2026-03-02T07:00:00Z'),
      (3, 'create', 'client', 2, 'Created client Bravo Inc', '2026-03-03T01:00:00Z');
  `);
}

// ── 1. Role gates ────────────────────────────────────────────────────────────
group("1 role gates", async () => {
  await reset();
  seedAudit();
  const paths = ["/audit-logs", "/audit-logs?limit=5&offset=0", "/audit-logs/export.csv", "/audit-logs/filters", "/audit-logs/export.csv?clientId=1", "/audit-logs?clientId=1"];
  for (const p of paths) {
    await status(`GET ${p} unauthenticated`, null, p, 401);
    for (const role of DENIED_ROLES) await status(`GET ${p} denied`, role, p, 403);
    for (const role of MANAGERS) await status(`GET ${p} allowed`, role, p, 200);
  }
  // Denied exports leave no trace and produce no CSV.
  const r = await call("maker", "GET", "/audit-logs/export.csv");
  assert("[maker] denied export returns no CSV", () => !r.text.includes("Bulk row"), "no data", r.text.slice(0, 80));
  assert("denied exports are not audited", () => sqlNum("select count(*) from audit_logs where action='export' and user_id <> 1 and user_id <> 2") === 0, "0", () => sql("select count(*) from audit_logs where action='export'"));
});

// ── 2. Pagination ────────────────────────────────────────────────────────────
group("2 pagination", async () => {
  await reset();
  seedAudit();
  const all = 126;
  const def = await status("GET /audit-logs default page", "manager", "/audit-logs", 200);
  assert("default limit is 50", () => def.json.length === 50, 50, () => def.json?.length);
  assert("X-Total-Count is the full match count", () => total(def) === all, all, () => def.headers.get("x-total-count"));
  assert("newest first", () => def.json[0].id === 126 && def.json[1].id === 125, "126,125", () => ids(def).slice(0, 3).join());
  assert("rows carry userName", () => def.json.find((l) => l.id === 126)?.userName === sql("select name from users where id=3"), "maker's name", () => JSON.stringify(def.json.find((l) => l.id === 126)));
  assert("row without user has userName null", () => def.json.find((l) => l.id === 125)?.userName === null && def.json.find((l) => l.id === 125)?.userId === null, "null", () => JSON.stringify(def.json.find((l) => l.id === 125)));

  const p1 = await status("limit=10 offset=0", "manager", "/audit-logs?limit=10&offset=0", 200);
  const p2 = await status("limit=10 offset=10", "manager", "/audit-logs?limit=10&offset=10", 200);
  assert("page 1 has 10 rows", () => p1.json.length === 10, 10, () => p1.json.length);
  assert("pages do not overlap and are contiguous", () => ids(p1).at(-1) - 1 === ids(p2)[0] && !ids(p2).some((id) => ids(p1).includes(id)), "contiguous", () => `${ids(p1)} | ${ids(p2)}`);
  assert("X-Total-Count is the same on every page", () => total(p1) === all && total(p2) === all, all, () => `${total(p1)} ${total(p2)}`);

  const last = await status("last partial page", "manager", "/audit-logs?limit=50&offset=100", 200);
  assert("last page has the remainder", () => last.json.length === 26 && ids(last).at(-1) === 1, "26 rows ending at id 1", () => `${last.json.length} ${ids(last).at(-1)}`);
  const past = await status("offset past the end", "manager", "/audit-logs?offset=5000", 200);
  assert("offset past the end is an empty page with the total", () => past.json.length === 0 && total(past) === all, `[] + ${all}`, () => `${past.json.length} ${total(past)}`);

  // Max 500.
  sql(`INSERT INTO audit_logs (user_id, action, entity_type, description, created_at)
       SELECT 3, 'update', 'deadline', 'Filler ' || g, timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => g) FROM generate_series(1, 600) g;`);
  const big = await status("limit=1000 is capped", "manager", "/audit-logs?limit=1000", 200);
  assert("limit is capped at 500", () => big.json.length === 500, 500, () => big.json.length);
  assert("total counts beyond the cap", () => total(big) === all + 600, all + 600, () => total(big));
  const exact = await status("limit=500", "manager", "/audit-logs?limit=500", 200);
  assert("limit=500 returns 500", () => exact.json.length === 500, 500, () => exact.json.length);
  for (const bad of ["limit=0", "limit=abc", "limit=-5", "offset=abc", "offset=-3"]) {
    const r = await status(`lenient ${bad}`, "manager", `/audit-logs?${bad}`, 200);
    assert(`${bad} falls back to the first 50 rows`, () => r.json.length === 50 && r.json[0].id === 126, "50 rows from the top", () => `${r.json?.length} ${r.json?.[0]?.id}`);
  }
});

// ── 3. Filters ───────────────────────────────────────────────────────────────
group("3 filters", async () => {
  await reset();
  seedAudit();
  const f = async (qs, expectIds, label = qs) => {
    const r = await status(`GET /audit-logs?${label}`, "manager", `/audit-logs?${qs}&limit=500`, 200);
    const got = ids(r);
    if (typeof expectIds === "number") {
      assert(`${label}: ${expectIds} rows`, () => got.length === expectIds && total(r) === expectIds, expectIds, () => `${got.length} total=${total(r)}`);
    } else {
      assert(`${label}: ids ${expectIds.join(",")}`, () => got.join() === expectIds.join() && total(r) === expectIds.length, expectIds.join(), () => `${got.join()} total=${total(r)}`);
    }
    return r;
  };
  await f("userId=2", [122, 121]);
  await f("userId=1", [124, 123]);
  await f("userId=3", 121);
  await f("userId=99", []);
  await f("action=approve", [122, 121]);
  await f("action=APPROVE", [], "action is exact (case-sensitive)");
  await f("entityType=client", [126, 123]);
  await f("entityType=deadline", 120);
  await f("action=create&entityType=client", [126]);
  await f("userId=3&action=update", 120);

  // Manila dates: 15:59:59Z is still March 1 in Manila, 16:00:00Z is March 2.
  await f("from=2026-03-02", [126, 125, 124, 123, 122]);
  await f("to=2026-03-01", [121, ...Array.from({ length: 120 }, (_, i) => 120 - i)].slice(0, 121), "to=2026-03-01 (inclusive, Manila)");
  await f("from=2026-03-01&to=2026-03-01", [121]);
  await f("from=2026-03-02&to=2026-03-02", [125, 124, 123, 122]);
  await f("from=2026-03-03&to=2026-03-03", [126]);
  await f("from=2026-03-04", []);
  await f("from=2026-03-02&to=2026-03-01", [], "from after to");
  await f("from=2026-01-30&to=2026-01-30", 0, "UTC date Jan 30 is Jan 31 in Manila, so Jan 30 is empty");
  // The 120 bulk rows run 2026-01-30T22:00Z .. 23:59Z = Jan 31 06:00..07:59 Manila.
  await f("from=2026-01-31&to=2026-01-31&entityType=deadline", 120, "bulk rows are Jan 31 in Manila");

  // q: case-insensitive substring of the description, wildcards literal.
  await f("q=bravo", [126]);
  await f("q=BULK%20ROW%2011", [119, 118, 117, 116, 115, 114, 113, 112, 111, 110, 11], "q=BULK ROW 11");
  await f("q=%25", [124], "q=% is literal");
  await f("q=_", [124], "q=_ is literal");
  await f("q=100%25_off", [124]);
  await f("q=%22Alpha%2C%20Corp%22", [123], 'q="Alpha, Corp"');
  await f("q=%5C", [], "q=\\ is literal");
  await f("q=%20%20", 126, "blank q is ignored");
  await f("q=approved&userId=2&from=2026-03-02", [122]);

  // Existing params still work.
  await f("engagementId=1", [121]);
  await f("clientId=2", [126]);
  await f("clientId=1", [123]);

  for (const bad of ["userId=abc", "userId=-1", "userId=1.5", "from=2026-02-30", "from=20260301", "to=yesterday", "engagementId=abc", "clientId=0", `q=${"x".repeat(201)}`, `action=${"a".repeat(65)}`]) {
    const r = await status(`invalid ${bad.slice(0, 40)} -> 400`, "manager", `/audit-logs?${bad}`, 400);
    assert(`invalid ${bad.slice(0, 40)} explains itself`, () => typeof r.json?.error === "string" && r.json.error.length > 0, "{ error }", r.text.slice(0, 80));
    await status(`invalid ${bad.slice(0, 40)} -> 400 on export`, "manager", `/audit-logs/export.csv?${bad}`, 400);
  }
  // Filters also apply for super admins.
  const a = await status("admin filters", "admin", "/audit-logs?action=delete", 200);
  assert("admin sees filtered rows", () => ids(a).join() === "123", "123", () => ids(a).join());
});

// ── 4. Filter options ───────────────────────────────────────────────────────
group("4 filter options", async () => {
  await reset();
  seedAudit();
  const r = await status("GET /audit-logs/filters", "manager", "/audit-logs/filters", 200);
  const j = r.json ?? {};
  assert("actions are the distinct actions, sorted", () => JSON.stringify(j.actions) === JSON.stringify(["approve", "comment", "create", "delete", "update"]), "approve,comment,create,delete,update", () => JSON.stringify(j.actions));
  assert("entity types are distinct, sorted", () => JSON.stringify(j.entityTypes) === JSON.stringify(["client", "comment", "deadline", "document", "engagement"]), "5 types", () => JSON.stringify(j.entityTypes));
  assert("users are the users who appear in the log", () => Array.isArray(j.users) && j.users.map((u) => u.id).sort().join() === "1,2,3", "1,2,3", () => JSON.stringify(j.users));
  assert("users carry names", () => j.users.every((u) => typeof u.name === "string" && u.name.length > 0), "names", () => JSON.stringify(j.users));
  assert("client accounts that never acted are not listed", () => !j.users.some((u) => u.id === 4), "no user 4", () => JSON.stringify(j.users));
});

// ── 5. CSV export ───────────────────────────────────────────────────────────
group("5 csv export", async () => {
  await reset();
  seedAudit();
  const r = await status("GET /audit-logs/export.csv", "manager", "/audit-logs/export.csv", 200);
  assert("Content-Type is text/csv", () => /^text\/csv/.test(r.headers.get("content-type") ?? ""), "text/csv", r.headers.get("content-type"));
  assert("Content-Disposition is an attachment with a .csv name", () => /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/.test(r.headers.get("content-disposition") ?? ""), "attachment", r.headers.get("content-disposition"));
  assert("X-Total-Count on export", () => total(r) === 126, 126, r.headers.get("x-total-count"));
  assert("not truncated", () => r.headers.get("x-export-truncated") === "false", "false", r.headers.get("x-export-truncated"));
  // fetch's text() strips a BOM, so look at the raw bytes.
  const raw = new Uint8Array(await (await fetch(`${BASE}/audit-logs/export.csv?userId=99`, { headers: { Cookie: cookies.manager } })).arrayBuffer());
  assert("starts with a UTF-8 BOM (for Excel)", () => raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, "EF BB BF", () => [...raw.slice(0, 3)].join(" "));
  const rows = parseCsv(r.text.replace(/^﻿/, ""));
  const header = rows[0];
  assert("header row", () => header.join("|") === "ID|Timestamp (Asia/Manila)|Timestamp (UTC)|User ID|User|Action|Entity Type|Entity ID|Description|Metadata", "10 columns", () => header.join("|"));
  const data = rows.slice(1);
  assert("one CSV row per log entry (multi-line fields stay one row)", () => data.length === 126, 126, () => data.length);
  assert("every row has 10 fields", () => data.every((row) => row.length === 10), "10", () => data.find((row) => row.length !== 10)?.join("|"));
  const byId = new Map(data.map((row) => [Number(row[0]), row]));
  assert("newest first", () => data[0][0] === "126" && data.at(-1)[0] === "1", "126..1", () => `${data[0][0]}..${data.at(-1)[0]}`);
  assert("comma, quotes and newline round-trip", () => byId.get(123)?.[8] === TRICKY, JSON.stringify(TRICKY), () => JSON.stringify(byId.get(123)?.[8]));
  assert("tricky field is quoted with doubled quotes in the raw CSV", () => r.text.includes('"Renamed client ""Alpha, Corp""\nline two, with ""quotes"""'), "quoted", () => r.text.slice(r.text.indexOf("Renamed") - 2, r.text.indexOf("Renamed") + 60));
  assert("plain fields are not quoted", () => r.text.includes(",Bulk row 7,"), "unquoted", "");
  assert("% and _ kept", () => byId.get(124)?.[8] === "Uploaded 100%_off promo.pdf", "100%_off", () => byId.get(124)?.[8]);
  assert("formula cells are neutralised with an apostrophe", () => byId.get(125)?.[8] === `'=HYPERLINK("http://evil")`, `'=HYPERLINK(...)`, () => byId.get(125)?.[8]);
  assert("Manila timestamp column (UTC+8)", () => byId.get(122)?.[1] === "2026-03-02 00:00:00" && byId.get(121)?.[1] === "2026-03-01 23:59:59", "2026-03-02 00:00:00", () => `${byId.get(122)?.[1]} / ${byId.get(121)?.[1]}`);
  assert("UTC timestamp column", () => byId.get(122)?.[2] === "2026-03-01T16:00:00.000Z", "ISO", () => byId.get(122)?.[2]);
  assert("user columns", () => byId.get(126)?.[3] === "3" && byId.get(126)?.[4] === sql("select name from users where id=3"), "3 + name", () => byId.get(126)?.slice(3, 5).join("|"));
  assert("no-user row has empty user columns", () => byId.get(125)?.[3] === "" && byId.get(125)?.[4] === "", "empty", () => byId.get(125)?.slice(3, 5).join("|"));
  assert("export is audited", () => sqlNum("select count(*) from audit_logs where action='export' and entity_type='audit_log' and user_id=2 and (metadata::jsonb->>'rows')::int = 126 and description = 'Exported 126 audit log entries to CSV'") === 1, 1, () => sql("select count(*) from audit_logs where action='export'"));

  // Same filters as the list.
  const filtered = await status("export with filters", "manager", "/audit-logs/export.csv?action=approve&from=2026-03-02", 200);
  const fRows = parseCsv(filtered.text.replace(/^﻿/, "")).slice(1);
  assert("filtered export has only matching rows", () => fRows.map((row) => row[0]).join() === "122", "122", () => fRows.map((row) => row[0]).join());
  assert("filtered export total", () => total(filtered) === 1, 1, filtered.headers.get("x-total-count"));
  const qExport = await status("export with q", "admin", "/audit-logs/export.csv?q=%22alpha%2C", 200);
  const qRows = parseCsv(qExport.text.replace(/^﻿/, "")).slice(1);
  assert("q filter applies to the export", () => qRows.length === 1 && qRows[0][0] === "123", "123", () => qRows.map((row) => row[0]).join());
  const none = await status("export with no matches", "manager", "/audit-logs/export.csv?userId=99", 200);
  const nRows = parseCsv(none.text.replace(/^﻿/, ""));
  assert("no matches = header only", () => nRows.length === 1 && total(none) === 0, "header only", () => nRows.length);
  // Pagination params do not limit the export.
  const paged = await status("export ignores limit/offset", "manager", "/audit-logs/export.csv?limit=5&offset=10&entityType=deadline", 200);
  assert("export ignores limit/offset", () => parseCsv(paged.text.replace(/^﻿/, "")).length - 1 === 120, 120, () => parseCsv(paged.text.replace(/^﻿/, "")).length - 1);

  // At most 10,000 rows.
  sql(`INSERT INTO audit_logs (user_id, action, entity_type, description, created_at)
       SELECT 3, 'update', 'deadline', 'Mass ' || g, timestamptz '2024-01-01 00:00:00+00' + make_interval(secs => g) FROM generate_series(1, 10100) g;`);
  const matching = sqlNum("select count(*) from audit_logs");
  const newest = sqlNum("select id from audit_logs order by created_at desc, id desc limit 1");
  const tenThousandth = sqlNum("select id from audit_logs order by created_at desc, id desc offset 9999 limit 1");
  const capped = await status("export with more than 10,000 matches", "manager", "/audit-logs/export.csv", 200);
  const cRows = parseCsv(capped.text.replace(/^﻿/, "")).slice(1);
  assert("export is capped at 10,000 rows", () => cRows.length === 10000, 10000, () => cRows.length);
  assert("X-Export-Truncated: true", () => capped.headers.get("x-export-truncated") === "true", "true", capped.headers.get("x-export-truncated"));
  assert("X-Total-Count has the full count", () => total(capped) === matching, matching, capped.headers.get("x-total-count"));
  assert("capped export keeps the newest 10,000 rows", () => Number(cRows[0][0]) === newest && Number(cRows.at(-1)[0]) === tenThousandth, `${newest}..${tenThousandth}`, () => `${cRows[0][0]}..${cRows.at(-1)[0]}`);
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
