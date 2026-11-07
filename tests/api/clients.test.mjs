// TaxAide clients-track integration tests: the client form round-trip (every BIR 2303
// flag is stored on create and update), the compliance checklist's formNumber /
// period / frequency mapping for every title generateBIRDeadlines produces, and the
// role / client-scope rules of the client routes the pages use (delete 409 message,
// compliance scoping, generate-deadlines roles).
// Dependency-free Node 22+ ES module, same harness and env vars as authz.test.mjs.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md (swap the file name)
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
  manager: ["manager@firm.ph", "manager123"],
  maker: ["accountant@firm.ph", "accountant123"],
  client: ["client@example.com", "client123"], // linked to client 1 (Alpha Corp)
};

// ── DB / HTTP helpers ────────────────────────────────────────────────────────
function sql(query) {
  return execSync("psql -q -tA -v ON_ERROR_STOP=1", { input: query, env: PG_ENV, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

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
  for (const role of Object.keys(USERS)) await login(role); // the fixture wipes user_sessions
}

async function call(role, method, urlPath, body) {
  const headers = {};
  if (role && cookies[role]) headers.Cookie = cookies[role];
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
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
const groups = [];
function group(name, fn) {
  groups.push({ name, fn });
}

const FLAGS = [
  "vatRegistered", "percentageTaxRegistered", "withholdsCompensation", "withholdsEwt",
  "subjectToDst", "withholdsFinal", "hasInventory", "isLessor", "isEsalesRequired",
];
const allFlags = (value) => Object.fromEntries(FLAGS.map((f) => [f, value]));

/** The body ClientForm (toClientPayload) sends: every field, empty values as null. */
function formPayload(fields) {
  return {
    name: "Form Corp", tin: "123-456-788-000", businessType: "Corporation",
    contactEmail: null, contactPhone: null, address: null,
    fiscalYearStart: null, fiscalYearEnd: null, status: "active",
    tradeName: null, rdoCode: null, registrationDate: null, lineOfBusiness: null,
    incomeTaxType: null,
    ...allFlags(false),
    ...fields,
  };
}

const PERIOD_RE = /^(Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|FY|Annual|1st Semester|2nd Semester) \d{4}$/;
const EXPECTED_FREQUENCY = {
  "1601C": "monthly", "2000": "monthly", "0619E": "monthly", "0619F": "monthly", eSales: "monthly",
  "1601EQ": "quarterly", "1601FQ": "quarterly", "2550Q": "quarterly", "2551Q": "quarterly", "1702Q": "quarterly",
  "1701Q": "quarterly", QAP: "quarterly", "QAP-Final": "quarterly", SLS: "quarterly", SLP: "quarterly",
  "1702": "annual", AFS: "annual", "1701": "annual", "1604C": "annual", "1604E": "annual", "1604F": "annual",
  "Alphalist-1604C": "annual", "Alphalist-1604E": "annual", "2316": "annual", "2316-Issue": "annual",
  AnnexC: "annual", AnnexF: "annual", Inventory: "annual", LesseeInfo: "annual",
};

/** Checks every compliance item of `items`: known formNumber, sensible period, right frequency, unique form+period. */
function checkItems(label, items) {
  const seen = new Map();
  for (const i of items) {
    record(`${label}: ${i.formNumber} ${i.period} has a known formNumber`, i.formNumber in EXPECTED_FREQUENCY, "a known code", i.formNumber);
    record(`${label}: ${i.formNumber} period "${i.period}" is a period label`, PERIOD_RE.test(i.period), "Qn/Month/FY/Annual/Semester YYYY", i.period);
    if (i.formNumber in EXPECTED_FREQUENCY) {
      record(`${label}: ${i.formNumber} is ${EXPECTED_FREQUENCY[i.formNumber]}`, i.frequency === EXPECTED_FREQUENCY[i.formNumber], EXPECTED_FREQUENCY[i.formNumber], i.frequency);
    }
    const key = `${i.formNumber}|${i.period}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  record(`${label}: formNumber + period is unique (${items.length} items)`, dupes.length === 0, "no duplicates", dupes.join(", "));
}

const find = (items, formNumber, period) => items.find((i) => i.formNumber === formNumber && i.period === period);

// ═════════════════════════════════════════════════════════════════════════════
group("1 client form round-trip keeps every BIR 2303 flag", async () => {
  await reset();
  const c = await call("maker", "POST", "/clients", formPayload({ name: "Form Corp", ...allFlags(true), incomeTaxType: "corporate" }));
  record("[maker] POST /clients with the full form body", c.status === 201, 201, `${c.status} ${c.text.slice(0, 160)}`);
  const id = c.json?.id;
  const g = await call("manager", "GET", `/clients/${id}`);
  for (const f of FLAGS) record(`create stores ${f}=true`, g.json?.[f] === true, true, g.json?.[f]);

  const u = await call("maker", "PATCH", `/clients/${id}`, formPayload({
    name: "Form Corp (edited)", ...allFlags(false), withholdsFinal: true, isEsalesRequired: true,
    contactEmail: "books@formcorp.ph", fiscalYearStart: "July", fiscalYearEnd: "June", status: "inactive",
  }));
  record("[maker] PATCH /clients/:id with the full form body", u.status === 200, 200, `${u.status} ${u.text.slice(0, 160)}`);
  const g2 = await call("manager", "GET", `/clients/${id}`);
  for (const f of FLAGS) {
    const want = f === "withholdsFinal" || f === "isEsalesRequired";
    record(`update stores ${f}=${want}`, g2.json?.[f] === want, want, g2.json?.[f]);
  }
  record("update stores status/email/fiscal year", g2.json?.status === "inactive" && g2.json?.contactEmail === "books@formcorp.ph" && g2.json?.fiscalYearStart === "July",
    "inactive, books@formcorp.ph, July", `${g2.json?.status}, ${g2.json?.contactEmail}, ${g2.json?.fiscalYearStart}`);

  const cc = await call("client", "POST", "/clients", formPayload({ name: "Client Made" }));
  record("[client] POST /clients is refused", cc.status === 403, 403, cc.status);
  const cu = await call("client", "PATCH", "/clients/1", formPayload({ name: "Hijacked" }));
  record("[client] PATCH own client is refused", cu.status === 403, 403, cu.status);
});

// ═════════════════════════════════════════════════════════════════════════════
group("2 compliance checklist: formNumber / period / frequency for every generated title", async () => {
  await reset();
  // Calendar-year corporation with every registration.
  const c = await call("manager", "POST", "/clients", formPayload({ name: "All Flags Corp", tin: "111-222-334-000", incomeTaxType: "corporate", ...allFlags(true) }));
  const corpId = c.json?.id;
  const r = await call("manager", "GET", `/clients/${corpId}/compliance?year=2026`);
  record("[manager] GET compliance (all flags, corporate)", r.status === 200, 200, r.status);
  const items = r.json?.items ?? [];
  checkItems("corporate 2026", items);
  const expect = [
    ["2316-Issue", "Annual 2026", "2027-02-01"],
    ["2316", "Annual 2026", "2027-03-01"],
    ["AnnexF", "Annual 2026", "2027-03-01"],
    ["AnnexC", "Annual 2026", "2027-02-01"],
    ["Alphalist-1604C", "Annual 2026", "2027-02-01"],
    ["Alphalist-1604E", "Annual 2026", "2027-03-01"],
    ["1604C", "Annual 2026", "2027-02-01"],
    ["1604F", "Annual 2026", "2027-02-01"],
    ["1604E", "Annual 2026", "2027-03-01"],
    ["QAP", "Q1 2026", "2026-04-30"],
    ["QAP-Final", "Q1 2026", "2026-04-30"],
    ["1601EQ", "Q2 2026", "2026-07-31"],
    ["1702Q", "Q2 2026", null],
    ["2550Q", "Q4 2026", null],
    ["SLS", "Q3 2026", null],
    ["1601C", "December 2026", "2027-01-15"],
    ["eSales", "March 2026", null],
    ["1702", "FY 2026", null],
    ["AFS", "FY 2026", null],
    ["Inventory", "FY 2026", null],
    ["LesseeInfo", "1st Semester 2026", "2026-07-31"],
    ["LesseeInfo", "2nd Semester 2026", "2027-02-01"],
  ];
  for (const [form, period, due] of expect) {
    const it = find(items, form, period);
    record(`corporate 2026 has ${form} ${period}`, !!it, "present", it ? "present" : "MISSING");
    if (it && due) record(`corporate 2026 ${form} ${period} due ${due}`, it.dueDate === due, due, it.dueDate);
  }
  const issue = find(items, "2316-Issue", "Annual 2026");
  record("2316-Issue is the issue-to-employees item", /Furnish each employee/.test(issue?.description ?? ""), "Furnish each employee…", (issue?.description ?? "").slice(0, 60));

  // Individual (calendar-year forms) with the fixture's quarterly title format.
  const i = await call("manager", "POST", "/clients", formPayload({ name: "Indiv Client", tin: "123-456-789-00000", incomeTaxType: "individual", percentageTaxRegistered: true }));
  const ri = await call("manager", "GET", `/clients/${i.json?.id}/compliance?year=2026`);
  const iItems = ri.json?.items ?? [];
  checkItems("individual 2026", iItems);
  for (const p of ["Q1 2026", "Q2 2026", "Q3 2026"]) {
    record(`individual 1701Q period ${p}`, !!find(iItems, "1701Q", p), "present", "MISSING");
  }
  record("individual 1701 period FY 2026", !!find(iItems, "1701", "FY 2026"), "present", "MISSING");

  // The fixture's engagement-linked 1701Q Q1 row is matched (Bravo, client 2).
  const rb = await call("manager", "GET", "/clients/2/compliance?year=2026");
  const q1 = find(rb.json?.items ?? [], "1701Q", "Q1 2026");
  record("Bravo 1701Q Q1 2026 links deadline 2 / engagement 2", q1?.deadlineId === 2 && q1?.engagementId === 2, "2 / 2", `${q1?.deadlineId} / ${q1?.engagementId}`);
});

// ═════════════════════════════════════════════════════════════════════════════
group("3 client routes: roles and client scope", async () => {
  await reset();
  // Client account (linked to client 1): own compliance yes, another client's no (404).
  const own = await call("client", "GET", "/clients/1/compliance?year=2026");
  record("[client] GET own compliance", own.status === 200, 200, own.status);
  const other = await call("client", "GET", "/clients/2/compliance?year=2026");
  record("[client] GET other client's compliance is 404", other.status === 404, 404, other.status);
  const otherClient = await call("client", "GET", "/clients/2");
  record("[client] GET other client is 404", otherClient.status === 404, 404, otherClient.status);
  const list = await call("client", "GET", "/clients");
  record("[client] GET /clients lists only client 1", Array.isArray(list.json) && list.json.length === 1 && list.json[0].id === 1, "[1]", JSON.stringify((list.json ?? []).map((c) => c.id)));

  // Generate deadlines: staff only.
  const gc = await call("client", "POST", "/clients/1/generate-deadlines", { year: 2026 });
  record("[client] generate-deadlines is refused", gc.status === 403, 403, gc.status);
  const gm = await call("maker", "POST", "/clients/1/generate-deadlines", { year: 2026, overwrite: true });
  record("[maker] generate-deadlines with overwrite", gm.status === 200 && /tax year 2026/.test(gm.json?.message ?? ""), 200, `${gm.status} ${gm.text.slice(0, 120)}`);

  // Delete: managers only; a client with filings/documents gets the 409 "inactive" message.
  const dm = await call("maker", "DELETE", "/clients/2");
  record("[maker] DELETE client is refused", dm.status === 403, 403, dm.status);
  const dc = await call("client", "DELETE", "/clients/1");
  record("[client] DELETE own client is refused", dc.status === 403, 403, dc.status);
  const d409 = await call("manager", "DELETE", "/clients/1");
  record("[manager] DELETE client with filings is 409", d409.status === 409, 409, d409.status);
  record("409 message tells to set the client inactive", /set the client to inactive instead/i.test(d409.json?.error ?? ""), "…Set the client to inactive instead.", d409.json?.error);
  const still = await call("manager", "GET", "/clients/1");
  record("client 1 still exists after the 409", still.status === 200, 200, still.status);

  const n = await call("manager", "POST", "/clients", formPayload({ name: "Disposable", withholdsEwt: true }));
  await call("manager", "POST", `/clients/${n.json?.id}/generate-deadlines`, { year: 2026 });
  const d204 = await call("manager", "DELETE", `/clients/${n.json?.id}`);
  record("[manager] DELETE unused client is 204", d204.status === 204, 204, d204.status);
  const left = Number(sql(`select count(*) from deadlines where client_id=${Number(n.json?.id)}`));
  record("its generated deadlines are removed with it", left === 0, 0, left);
});

// ═════════════════════════════════════════════════════════════════════════════
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
