// TaxAide BIR deadline-rule integration tests: the due dates POST /clients/:id/generate-deadlines
// writes, per form, for clients with different registrations (calendar/fiscal corporate,
// individual with a fiscal-year setting, odd/even/missing TIN), including the RMC 65-2016
// weekend/holiday roll-forward (Easter week, National Heroes Day, Bonifacio Day, weekends).
// Dependency-free Node 22+ ES module, shared harness (_harness.mjs) and env vars.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md (swap the file name)
// Env:  API_BASE, FIXTURE, UPLOADS_DIR, PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>

import { guard, sql, q, reset as resetAll, call as request, record, group, main } from "./_harness.mjs";

guard();

// Every request in this suite is made as the manager.
const reset = () => resetAll(["manager"]);
const call = (method, urlPath, body) => request("manager", method, urlPath, body);

const BASE_CLIENT = {
  businessType: "corporation",
  status: "active",
  vatRegistered: false,
  percentageTaxRegistered: false,
  withholdsCompensation: false,
  withholdsEwt: false,
  subjectToDst: false,
  withholdsFinal: false,
  hasInventory: false,
  isLessor: false,
  isEsalesRequired: false,
};

async function createClient(fields) {
  const r = await call("POST", "/clients", { ...BASE_CLIENT, ...fields });
  if (r.status !== 201 || !r.json?.id) throw new Error(`create client ${fields.name}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.id;
}

/** Generates `year` for client `id` and returns Map(title -> deadline row from GET /deadlines). */
async function generate(id, year, overwrite = false) {
  const g = await call("POST", `/clients/${id}/generate-deadlines`, { year, overwrite });
  record(`generate client ${id} tax year ${year}${overwrite ? " (overwrite)" : ""}`, g.status === 200, 200, `${g.status} ${g.text.slice(0, 160)}`);
  const r = await call("GET", `/deadlines?clientId=${id}`);
  const rows = Array.isArray(r.json) ? r.json : [];
  return new Map(rows.map((d) => [d.title, d]));
}

/** Asserts title -> due date for each [title, due] pair. */
function expectDue(label, byTitle, pairs) {
  for (const [title, due] of pairs) {
    const got = byTitle.get(title)?.dueDate ?? "MISSING";
    record(`${label}: ${title} due ${due}`, got === due, due, got);
  }
}
function expectAbsent(label, byTitle, pattern) {
  const hits = [...byTitle.keys()].filter((t) => pattern.test(t));
  record(`${label}: no ${pattern}`, hits.length === 0, "none", hits.slice(0, 3).join(" | "));
}
function expectDescription(label, byTitle, title, needle) {
  const desc = byTitle.get(title)?.description ?? "MISSING";
  record(`${label}: ${title} description mentions "${needle}"`, desc.includes(needle), needle, desc.slice(0, 240));
}

// Independent working-day check for the asserted years (2025-2028): weekends plus the
// regular holidays, Holy Week and National Heroes Day spelled out by hand.
const KNOWN_HOLIDAYS = new Set([
  ...[2025, 2026, 2027, 2028].flatMap((y) => ["01-01", "04-09", "05-01", "06-12", "11-30", "12-25", "12-30"].map((md) => `${y}-${md}`)),
  "2025-04-17", "2025-04-18", "2025-08-25",
  "2026-04-02", "2026-04-03", "2026-08-31",
  "2027-03-25", "2027-03-26", "2027-08-30",
  "2028-04-13", "2028-04-14", "2028-08-28",
]);
function isNonWorking(iso) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 || KNOWN_HOLIDAYS.has(iso);
}
function expectAllWorkingDays(label, byTitle) {
  const bad = [...byTitle.values()].filter((d) => isNonWorking(d.dueDate)).map((d) => `${d.title}@${d.dueDate}`);
  record(`${label}: every due date is a working day (${byTitle.size} rows)`, byTitle.size > 0 && bad.length === 0, "none", bad.slice(0, 4).join(" | "));
}

// ═════════════════════════════════════════════════════════════════════════════
group("1 calendar-year corporation, every registration (tax year 2026)", async () => {
  await reset();
  // 9-digit TIN 123-456-788 (branch 000): last digit 8 is even -> eSales by the 8th.
  const id = await createClient({
    name: "Rules Corp (calendar)", tin: "123-456-788-000", incomeTaxType: "corporate",
    fiscalYearStart: "January", fiscalYearEnd: "December",
    vatRegistered: true, withholdsCompensation: true, withholdsEwt: true, withholdsFinal: true,
    subjectToDst: true, hasInventory: true, isLessor: true, isEsalesRequired: true,
  });
  const d = await generate(id, 2026);
  const L = "calendar corp 2026";

  // 1601C: 10th of the next month; December on January 15 (RR 11-2018). May 10 is a Sunday,
  // Oct 10 a Saturday.
  expectDue(L, d, [
    ["BIR Form 1601C — January 2026", "2026-02-10"],
    ["BIR Form 1601C — March 2026", "2026-04-10"],
    ["BIR Form 1601C — April 2026", "2026-05-11"],
    ["BIR Form 1601C — September 2026", "2026-10-12"],
    ["BIR Form 1601C — November 2026", "2026-12-10"],
    ["BIR Form 1601C — December 2026", "2027-01-15"],
  ]);
  // 2000 DST: 5th of the next month; the March return falls on Easter Sunday (Apr 5, 2026).
  expectDue(L, d, [
    ["BIR Form 2000 — January 2026", "2026-02-05"],
    ["BIR Form 2000 — March 2026", "2026-04-06"],
    ["BIR Form 2000 — June 2026", "2026-07-06"],
    ["BIR Form 2000 — December 2026", "2027-01-05"],
  ]);
  expectDescription(L, d, "BIR Form 2000 — March 2026", "Statutory due date Sun, Apr 5 2026 falls on a non-working day");
  // 0619E / 0619F: first two months of each quarter only, 10th of the next month.
  expectDue(L, d, [
    ["BIR Form 0619E — January 2026", "2026-02-10"],
    ["BIR Form 0619E — April 2026", "2026-05-11"],
    ["BIR Form 0619E — November 2026", "2026-12-10"],
    ["BIR Form 0619F — February 2026", "2026-03-10"],
    ["BIR Form 0619F — August 2026", "2026-09-10"],
  ]);
  expectAbsent(L, d, /^BIR Form 0619[EF] — (March|June|September|December) 2026$/);
  // 1601EQ / 1601FQ / QAPs: last day of the month after the quarter. Oct 31, 2026 is a
  // Saturday (-> Mon Nov 2); Jan 31, 2027 a Sunday (-> Mon Feb 1).
  for (const t of ["BIR Form 1601EQ", "BIR Form 1601FQ", "Quarterly Alphalist of Payees (QAP)", "Quarterly Alphalist of Payees (QAP, Final Withholding)"]) {
    expectDue(L, d, [
      [`${t} — Q1 2026`, "2026-04-30"],
      [`${t} — Q2 2026`, "2026-07-31"],
      [`${t} — Q3 2026`, "2026-11-02"],
      [`${t} — Q4 2026`, "2027-02-01"],
    ]);
  }
  // 2550Q / SLS / SLP: 25th of the month after the quarter (Apr 25 and Jul 25 are
  // Saturdays, Oct 25 a Sunday).
  for (const t of ["BIR Form 2550Q", "Summary List of Sales (SLS)", "Summary List of Purchases (SLP)"]) {
    expectDue(L, d, [
      [`${t} — Q1 2026`, "2026-04-27"],
      [`${t} — Q2 2026`, "2026-07-27"],
      [`${t} — Q3 2026`, "2026-10-26"],
      [`${t} — Q4 2026`, "2027-01-25"],
    ]);
  }
  expectAbsent(L, d, /2550M/);
  // 1702Q: quarter end + 60 days. Q1 May 30 (Sat) -> Jun 1; Q2 Aug 29 (Sat) -> Aug 31 is
  // National Heroes Day -> Sep 1; Q3 Nov 29 (Sun) -> Nov 30 is Bonifacio Day -> Dec 1.
  expectDue(L, d, [
    ["BIR Form 1702Q — Q1 2026", "2026-06-01"],
    ["BIR Form 1702Q — Q2 2026", "2026-09-01"],
    ["BIR Form 1702Q — Q3 2026", "2026-12-01"],
    ["BIR Form 1702 (Annual Corporate ITR) — FY 2026", "2027-04-15"],
    ["Audited Financial Statements — FY 2026", "2027-04-15"],
  ]);
  expectAbsent(L, d, /1702Q — Q4/);
  expectDescription(L, d, "BIR Form 1702Q — Q2 2026", "Statutory due date Sat, Aug 29 2026 falls on a non-working day (Saturday); due the next working day, Tue, Sep 1 2026");
  // Annual withholding returns and attachments: 1604C/1604F/2316 issue/Annex C on
  // January 31 (Sun -> Feb 1, 2027), 1604E on March 1, 2316 duplicates + Annex F on
  // February 28 (Sun -> Mar 1, 2027).
  expectDue(L, d, [
    ["BIR Form 1604C — Annual 2026", "2027-02-01"],
    ["Alphalist of Employees (1604C Attachment) — 2026", "2027-02-01"],
    ["BIR Form 1604F — Annual 2026", "2027-02-01"],
    ["BIR Form 2316 (Issue to Employees) — 2026", "2027-02-01"],
    ["Annex C (Substituted Filing Employees) — 2026", "2027-02-01"],
    ["BIR Form 1604E — Annual 2026", "2027-03-01"],
    ["Annual Alphalist of Payees (1604E Attachment) — 2026", "2027-03-01"],
    ["BIR Form 2316 (Substituted Filing) — 2026", "2027-03-01"],
    ["Annex F (Annual Alphalist of Employees) — 2026", "2027-03-01"],
  ]);
  expectDescription(L, d, "Annex F (Annual Alphalist of Employees) — 2026", "Qualified for Substituted Filing");
  // eSales, even 9th TIN digit -> 8th (Feb 8 and Mar 8, 2026 are Sundays).
  expectDue(L, d, [
    ["eSales Report — January 2026", "2026-02-09"],
    ["eSales Report — February 2026", "2026-03-09"],
    ["eSales Report — March 2026", "2026-04-08"],
    ["eSales Report — December 2026", "2027-01-08"],
  ]);
  // Inventory list: 30 days after Dec 31 = Jan 30, 2027 (Sat) -> Feb 1.
  // Lessee statement: July 31 and January 31 (Sun -> Feb 1, 2027).
  expectDue(L, d, [
    ["Annual Inventory List — FY 2026", "2027-02-01"],
    ["Lessee Information Statement — 1st Semester 2026", "2026-07-31"],
    ["Lessee Information Statement — 2026", "2027-02-01"],
  ]);
  expectAllWorkingDays(L, d);

  // Tax year 2025: Jan 31, 2026 and Feb 28, 2026 are Saturdays.
  const d25 = await generate(id, 2025);
  expectDue("calendar corp 2025", d25, [
    ["BIR Form 1601C — December 2025", "2026-01-15"],
    ["BIR Form 1604C — Annual 2025", "2026-02-02"],
    ["BIR Form 2316 (Substituted Filing) — 2025", "2026-03-02"],
    ["BIR Form 1702 (Annual Corporate ITR) — FY 2025", "2026-04-15"],
  ]);
  expectDescription("calendar corp 2025", d25, "BIR Form 2316 (Substituted Filing) — 2025",
    "Statutory due date Sat, Feb 28 2026 falls on a non-working day (Saturday); due the next working day, Mon, Mar 2 2026");
  // Tax year 2027: the 2316 duplicates stay due February 28 in the 2028 leap year.
  const d27 = await generate(id, 2027);
  expectDue("calendar corp 2027", d27, [["BIR Form 2316 (Substituted Filing) — 2027", "2028-02-28"]]);
});

// ═════════════════════════════════════════════════════════════════════════════
group("2 individual with a fiscal-year setting (calendar year applies)", async () => {
  await reset();
  // 9-digit TIN 123-456-789 + 5-digit branch: 9th digit 9 is odd -> eSales by the 10th.
  const id = await createClient({
    name: "Rules Individual", tin: "123-456-789-00000", businessType: "sole_proprietorship", incomeTaxType: "individual",
    fiscalYearStart: "July", fiscalYearEnd: "June",
    percentageTaxRegistered: true, withholdsCompensation: true, isEsalesRequired: true,
  });
  const d = await generate(id, 2026);
  const L = "individual 2026";
  // 1701Q on fixed dates (May 15, Aug 15 Sat -> Aug 17, Nov 15 Sun -> Nov 16); 1701 April 15.
  expectDue(L, d, [
    ["BIR Form 1701Q — Q1 2026", "2026-05-15"],
    ["BIR Form 1701Q — Q2 2026", "2026-08-17"],
    ["BIR Form 1701Q — Q3 2026", "2026-11-16"],
    ["BIR Form 1701 (Annual Individual ITR) — FY 2026", "2027-04-15"],
  ]);
  expectAbsent(L, d, /1701Q — Q4|1702/);
  expectDescription(L, d, "BIR Form 1701Q — Q2 2026", "Statutory due date Sat, Aug 15 2026 falls on a non-working day");
  expectDescription(L, d, "BIR Form 1701 (Annual Individual ITR) — FY 2026", "calendar year 2026");
  // 2551Q follows the calendar quarters too: an individual's taxable year is the calendar
  // year, so the July fiscal-year setting is ignored (Apr 25 Sat -> Apr 27, Jul 25 Sat -> Jul 27,
  // Oct 25 Sun -> Oct 26, Jan 25 2027).
  expectDue(L, d, [
    ["BIR Form 2551Q — Q1 2026", "2026-04-27"],
    ["BIR Form 2551Q — Q2 2026", "2026-07-27"],
    ["BIR Form 2551Q — Q3 2026", "2026-10-26"],
    ["BIR Form 2551Q — Q4 2026", "2027-01-25"],
  ]);
  expectDescription(L, d, "BIR Form 2551Q — Q1 2026", "(January–March 2026)");
  // eSales on the 10th (May 10 Sun -> May 11; Oct 10 Sat -> Oct 12).
  expectDue(L, d, [
    ["eSales Report — January 2026", "2026-02-10"],
    ["eSales Report — April 2026", "2026-05-11"],
    ["eSales Report — September 2026", "2026-10-12"],
  ]);
  // Compensation only (no EWT): Annex F and the 2316 items, but no Annex C or QAP.
  expectDue(L, d, [
    ["BIR Form 2316 (Issue to Employees) — 2026", "2027-02-01"],
    ["Annex F (Annual Alphalist of Employees) — 2026", "2027-03-01"],
  ]);
  expectAbsent(L, d, /Annex C|Alphalist of Payees/);
  expectAllWorkingDays(L, d);

  // The compliance checklist shows the same dates.
  const c = await call("GET", `/clients/${id}/compliance?year=2026`);
  const item = (c.json?.items ?? []).find((i) => i.formNumber === "1701Q" && String(i.description).includes("(Q2 2026"));
  record("individual 2026: compliance 1701Q Q2 due 2026-08-17", item?.dueDate === "2026-08-17", "2026-08-17", item?.dueDate ?? "MISSING");
});

// ═════════════════════════════════════════════════════════════════════════════
group("3 fiscal-year corporations (July-June; March-February Easter roll)", async () => {
  await reset();
  // No usable TIN -> eSales uses the earlier 8th. The API only accepts well-formed TINs,
  // so the legacy value is written straight to the row.
  const jul = await createClient({
    name: "Rules Corp (Jul-Jun)", tin: "000-000-000-000", incomeTaxType: "corporate",
    fiscalYearStart: "July", fiscalYearEnd: "June",
    vatRegistered: true, withholdsEwt: true, hasInventory: true, isEsalesRequired: true,
  });
  sql(`update clients set tin='N/A' where id=${Number(jul)}`);
  const d = await generate(jul, 2026);
  const L = "Jul-Jun corp 2026";
  expectDue(L, d, [
    ["BIR Form 2550Q — Q1 2026", "2026-10-26"],
    ["BIR Form 2550Q — Q2 2026", "2027-01-25"],
    ["BIR Form 2550Q — Q3 2026", "2027-04-26"],
    ["BIR Form 2550Q — Q4 2026", "2027-07-26"],
    // Sep 30 + 60 = Sun Nov 29 -> Bonifacio Day -> Dec 1; Dec 31 + 60 = Mar 1, 2027;
    // Mar 31 + 60 = Sun May 30, 2027 -> May 31.
    ["BIR Form 1702Q — Q1 2026", "2026-12-01"],
    ["BIR Form 1702Q — Q2 2026", "2027-03-01"],
    ["BIR Form 1702Q — Q3 2026", "2027-05-31"],
    ["BIR Form 1702 (Annual Corporate ITR) — FY 2026", "2027-10-15"],
    ["Audited Financial Statements — FY 2026", "2027-10-15"],
    ["Annual Inventory List — FY 2026", "2027-07-30"],
    // Withholding stays on calendar quarters.
    ["BIR Form 1601EQ — Q1 2026", "2026-04-30"],
    ["Quarterly Alphalist of Payees (QAP) — Q1 2026", "2026-04-30"],
    ["Annex C (Substituted Filing Employees) — 2026", "2027-02-01"],
    ["eSales Report — January 2026", "2026-02-09"],
  ]);
  expectDescription(L, d, "eSales Report — January 2026", "no 9-digit TIN on file");
  expectAllWorkingDays(L, d);

  // March-February fiscal year: the Q4 2026 VAT return (Dec 2026 - Feb 2027) is due
  // Thu Mar 25, 2027 = Maundy Thursday -> Good Friday -> Sat -> Easter Sunday -> Mon Mar 29.
  const mar = await createClient({
    name: "Rules Corp (Mar-Feb)", tin: "987-654-321-000", incomeTaxType: "corporate",
    fiscalYearStart: "March", fiscalYearEnd: "February", vatRegistered: true,
  });
  const m = await generate(mar, 2026);
  expectDue("Mar-Feb corp 2026", m, [
    ["BIR Form 2550Q — Q1 2026", "2026-06-25"],
    ["BIR Form 2550Q — Q4 2026", "2027-03-29"],
    ["Summary List of Sales (SLS) — Q4 2026", "2027-03-29"],
    ["BIR Form 1702Q — Q1 2026", "2026-07-30"],
  ]);
  expectDescription("Mar-Feb corp 2026", m, "BIR Form 2550Q — Q4 2026", "Statutory due date Thu, Mar 25 2027 falls on a non-working day (Maundy Thursday)");
  expectAllWorkingDays("Mar-Feb corp 2026", m);
});

// ═════════════════════════════════════════════════════════════════════════════
group("4 overwrite corrects rows saved with the old dates", async () => {
  await reset();
  const id = await createClient({
    name: "Rules Legacy", tin: "111-222-333-000", incomeTaxType: "corporate", withholdsCompensation: true,
  });
  // Rows as the old generator wrote them (1604C on March 1, December 1601C on January 10).
  sql(`insert into deadlines (client_id, title, due_date, status, priority, tax_year) values
    (${id}, ${q("BIR Form 1604C — Annual 2026")}, '2027-03-01', 'pending', 'medium', 2026),
    (${id}, ${q("BIR Form 1601C — December 2026")}, '2027-01-10', 'pending', 'high', 2026)`);
  const kept = await generate(id, 2026);
  expectDue("no overwrite keeps saved dates", kept, [
    ["BIR Form 1604C — Annual 2026", "2027-03-01"],
    ["BIR Form 1601C — December 2026", "2027-01-10"],
  ]);
  const fixed = await generate(id, 2026, true);
  expectDue("overwrite refreshes the dates", fixed, [
    ["BIR Form 1604C — Annual 2026", "2027-02-01"],
    ["BIR Form 1601C — December 2026", "2027-01-15"],
  ]);
  const n = Number(sql(`select count(*) from deadlines where client_id=${id} and title in (${q("BIR Form 1604C — Annual 2026")}, ${q("BIR Form 1601C — December 2026")})`));
  record("overwrite updated in place (one row per title)", n === 2, 2, n);
});

// ── Main ─────────────────────────────────────────────────────────────────────
await main({ reset });
