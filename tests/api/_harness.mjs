// Shared harness for the TaxAide API integration suites (tests/api/*.test.mjs).
// Dependency-free Node 22+ ES module. Each suite imports what it needs from here, calls
// guard() first, registers its groups with group(), and ends with `await main({ reset })`.
//
// !! DESTRUCTIVE: resetDb() runs fixture.sql, which TRUNCATEs every application table.
// !! guard() refuses to run unless TAXAIDE_TEST_RESET_DB=1 (or DRY_RUN=1 where allowed).
//
// Env:  API_BASE, FIXTURE, UPLOADS_DIR (must equal the server's UPLOADS_DIR),
//       PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>, DRY_RUN=1 (some suites)

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.API_BASE ?? "http://localhost:8080/api";
export const FIXTURE = process.env.FIXTURE ?? path.join(HERE, "fixture.sql");
export const PG_ENV = {
  ...process.env,
  PGPASSWORD: process.env.PGPASSWORD ?? "taxaide",
  PGHOST: process.env.PGHOST ?? "localhost",
  PGUSER: process.env.PGUSER ?? "taxaide",
  PGDATABASE: process.env.PGDATABASE ?? "taxaide",
};
// Must match the API's UPLOADS_DIR. The fixture's document rows point at a.txt / b.txt,
// so resetDb() writes those files (5 bytes each, matching file_size).
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(HERE, "uploads");
export const ONLY = process.env.ONLY ?? "";

/** True only in a suite that called guard({ allowDryRun: true }) with DRY_RUN=1. */
export let DRY_RUN = false;

/**
 * Refuses to run without TAXAIDE_TEST_RESET_DB=1. With allowDryRun, DRY_RUN=1 is accepted
 * instead: neither the API nor the DB is touched (fetch and sql() are stubbed), which is only
 * useful for counting cases / harness smoke checks.
 */
export function guard({ allowDryRun = false } = {}) {
  const dry = allowDryRun && process.env.DRY_RUN === "1";
  if (process.env.TAXAIDE_TEST_RESET_DB !== "1" && !dry) {
    console.error("Refusing to run: this suite wipes the database. Set TAXAIDE_TEST_RESET_DB=1 and point PG*/API_BASE at a throwaway database.");
    process.exit(2);
  }
  if (dry) {
    DRY_RUN = true;
    globalThis.fetch = async () =>
      new Response("[]", { status: 200, headers: { "set-cookie": "connect.sid=dry; Path=/", "content-type": "application/json" } });
  }
}

/** The fixture's accounts (users 1-4 are the seeded demo users, 5-7 come from fixture.sql). */
export const USERS = {
  admin: ["admin@firm.ph", "admin123"],
  manager: ["manager@firm.ph", "manager123"],
  maker: ["accountant@firm.ph", "accountant123"],
  client: ["client@example.com", "client123"], // -> Alpha (1)
  clientb: ["clientb@example.com", "client123"], // -> Bravo (2)
  orphan: ["orphan@example.com", "client123"], // unlinked client
  viewer: ["viewer@example.com", "client123"], // legacy viewer -> Alpha (1)
};

// ── DB helpers ───────────────────────────────────────────────────────────────
export function sql(query) {
  if (DRY_RUN) return "0";
  return execSync("psql -q -tA -v ON_ERROR_STOP=1", { input: query, env: PG_ENV, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .trim();
}
export function sqlNum(query) {
  const out = sql(query);
  const n = Number(out.split("\n")[0]);
  if (Number.isNaN(n)) throw new Error(`non-numeric SQL result for ${query}: ${out}`);
  return n;
}
/** SQL string literal. */
export function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// Users 1-4 survive the fixture, so pin their role/link/name back after every reset
// (a test that demotes the maker, or a server bug that lets a client promote itself,
// must not leak into later groups or later runs).
let restoreUsersSql = null;
/** Reloads fixture.sql, rewrites the fixture's upload files and pins users 1-4. Does not sign in. */
export function resetDb() {
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
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
/** role -> "connect.sid=..." cookie of that role's current session. */
export const cookies = {};

/** All Set-Cookie lines of a response. */
export function setCookies(res) {
  return typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
}
/** The "connect.sid=..." pair a response sets, or null. */
export function sidOf(res) {
  return setCookies(res).map((c) => c.split(";")[0]).find((c) => c.startsWith("connect.sid=")) ?? null;
}

/** Signs `role` (a key of USERS) in and stores its session cookie in `cookies`. */
export async function login(role) {
  const [email, password] = USERS[role];
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sid = sidOf(res);
  if (res.status !== 200 || !sid) {
    throw new Error(`login failed for ${role}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  cookies[role] = sid;
}
export async function loginAll(roles = Object.keys(USERS)) {
  for (const role of roles) await login(role);
}

/** resetDb() + sign `roles` in again (the fixture wipes user_sessions). */
export async function reset(roles = Object.keys(USERS)) {
  resetDb();
  await loginAll(roles);
}

/**
 * One API request as `role` (null = anonymous). `body`: FormData is sent as is, any other
 * non-null value as JSON. Returns { status, headers, text, json }.
 */
export async function call(role, method, urlPath, body) {
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
  return { status: res.status, headers: res.headers, text, json: parseJson(text) };
}
export function parseJson(text) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** A multipart body with one text/plain file plus `fields`. */
export function upload(fields, content = "hello from the authz test", name = "authz-test.txt") {
  const fd = new FormData();
  fd.append("file", new Blob([content], { type: "text/plain" }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  return fd;
}

// ── Expectations ─────────────────────────────────────────────────────────────
// An expectation is { desc, test(res) -> true | false | string(reason) }.
export function is(...codes) {
  return { desc: codes.join("|"), test: (r) => codes.includes(r.status) };
}
export const DENIED = { desc: "403|404 (never 2xx)", test: (r) => r.status === 403 || r.status === 404 };
export const NOT_2XX = { desc: "non-2xx", test: (r) => r.status < 200 || r.status >= 300 };
export const CLIENT_ERR = { desc: "4xx", test: (r) => r.status >= 400 && r.status < 500 };
export const BAD_REF = { desc: "400|404", test: (r) => r.status === 400 || r.status === 404 };
export const DELETED = is(204, 200);
export const CREATED = is(201, 200);
export function pred(desc, fn, status = 200) {
  return {
    desc: status == null ? desc : `${status} + ${desc}`,
    test: (r) => {
      if (status != null && r.status !== status) return false;
      return fn(r.json, r);
    },
  };
}
export const arr = (desc, fn) => pred(desc, (j) => Array.isArray(j) && fn(j));
export const EMPTY = arr("[]", (a) => a.length === 0);

// ── Runner ───────────────────────────────────────────────────────────────────
const counts = { passed: 0, skipped: 0 };
const failures = [];

/** Counts a PASS, or a FAIL printed as `FAIL <name><detail>`. */
export function pass(name) {
  counts.passed++;
  console.log(`PASS ${name}`);
}
export function fail(name, detail = "") {
  failures.push(name);
  console.log(`FAIL ${name}${detail}`);
}
export function skip(name, why) {
  counts.skipped++;
  console.log(`SKIP ${name} (${why})`);
}
export function record(name, ok, expected, got) {
  if (ok) pass(name);
  else fail(name, ` expected ${expected} got ${got}`);
}

export function short(r) {
  const t = (r.text ?? "").replace(/\s+/g, " ");
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

/** Sends one request and records whether it met `expect` (a status code or an expectation). */
export async function check(name, role, method, urlPath, body, expect) {
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

/** Records `cond` (a value or a function; exceptions fail). `got` may be a function too. */
export function assert(name, cond, expected, got) {
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
export function safe(fn) {
  try {
    return fn();
  } catch (err) {
    return `exception ${err?.message ?? err}`;
  }
}

const groups = [];
export function group(name, fn) {
  groups.push({ name, fn });
}

/**
 * Runs the registered groups (filtered by ONLY), then `reset()` once more so the DB is left
 * in the fixture state, prints the summary line and exits 1 on any failure.
 * Options: reset (required), resetFirst (also reset before the first group),
 * healthStrict (default true: a non-2xx /healthz aborts too, not only an unreachable API).
 */
export async function main({ reset: doReset, resetFirst = false, healthStrict = true }) {
  try {
    const h = await fetch(`${BASE}/healthz`);
    if (healthStrict && !h.ok) throw new Error(`healthz ${h.status}`);
  } catch (err) {
    console.error(`API not reachable at ${BASE}: ${err?.message ?? err}`);
    process.exit(2);
  }
  if (resetFirst) await doReset();

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
    await doReset();
  } catch (err) {
    console.log(`(final fixture reset failed: ${err?.message ?? err})`);
  }

  // run-all.mjs parses this line.
  const skipped = counts.skipped ? `, ${counts.skipped} skipped` : "";
  console.log(`\n${counts.passed} passed, ${failures.length} failed, ${counts.passed + failures.length} total${skipped}`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}
