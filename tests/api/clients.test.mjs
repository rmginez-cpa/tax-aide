// TaxAide clients-track integration tests: the client form round-trip (every BIR 2303
// flag is stored on create and update), the compliance checklist's formNumber /
// period / frequency mapping for every title generateBIRDeadlines produces, and the
// role / client-scope rules of the client routes the pages use (delete 409 message,
// compliance scoping, generate-deadlines roles).
// Dependency-free Node 22+ ES module, shared harness (_harness.mjs) and env vars.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md (swap the file name)
// Env:  API_BASE, FIXTURE, UPLOADS_DIR, PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>

import { guard, sql, reset as resetAll, call, record, group, main } from "./_harness.mjs";

guard();

// The roles this suite signs in (client is linked to client 1, Alpha Corp).
const reset = () => resetAll(["manager", "maker", "client"]);

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
group("4 TIN format (same rule as the client form)", async () => {
  await reset();
  const tinOf = (id) => sql(`select tin from clients where id=${Number(id)}`);
  // Accepted: 9 digits + 3- or 5-digit branch code; surrounding spaces are trimmed.
  let n = 0;
  for (const [tin, stored] of [["123-456-789-000", "123-456-789-000"], ["123-456-789-00000", "123-456-789-00000"], ["  987-654-321-001 ", "987-654-321-001"]]) {
    const r = await call("maker", "POST", "/clients", formPayload({ name: `TIN Ok ${++n}`, tin }));
    record(`[maker] POST /clients tin ${JSON.stringify(tin)} -> 201`, r.status === 201 && r.json?.tin === stored, `201 ${stored}`, `${r.status} ${r.json?.tin ?? r.text.slice(0, 120)}`);
  }
  // Rejected with 400 and nothing stored.
  const before = Number(sql("select count(*) from clients"));
  const BAD = ["N/A", "", "123456789000", "123-456-789", "123-456-789-0000", "123-456-789-000000", "123-456-78a-000", "123 456 789 000", "TIN 123-456-789-000"];
  for (const tin of BAD) {
    const r = await call("maker", "POST", "/clients", formPayload({ name: "TIN Bad", tin }));
    record(`[maker] POST /clients tin ${JSON.stringify(tin)} -> 400`, r.status === 400 && /TIN/.test(r.json?.error ?? ""), "400 TIN message", `${r.status} ${r.text.slice(0, 120)}`);
  }
  const after = Number(sql("select count(*) from clients"));
  record("no client was created with a malformed TIN", after === before, before, after);

  // PATCH: a malformed TIN is refused and the stored one kept; a valid one is saved (trimmed).
  for (const tin of ["N/A", "", "111-111-111", "111-111-111-0000"]) {
    const r = await call("manager", "PATCH", "/clients/1", { tin });
    record(`[manager] PATCH /clients/1 tin ${JSON.stringify(tin)} -> 400`, r.status === 400 && /TIN/.test(r.json?.error ?? ""), "400 TIN message", `${r.status} ${r.text.slice(0, 120)}`);
  }
  record("client 1 keeps its TIN after the refused updates", tinOf(1) === "111-111-111-000", "111-111-111-000", tinOf(1));
  const ok = await call("manager", "PATCH", "/clients/1", { tin: " 111-111-111-00001 " });
  record("[manager] PATCH /clients/1 valid 5-digit branch TIN -> 200", ok.status === 200 && ok.json?.tin === "111-111-111-00001", "200 111-111-111-00001", `${ok.status} ${ok.json?.tin}`);
  const other = await call("manager", "PATCH", "/clients/1", { name: "Alpha Corp" });
  record("[manager] PATCH /clients/1 without tin leaves it alone", other.status === 200 && other.json?.tin === "111-111-111-00001", "200 unchanged", `${other.status} ${other.json?.tin}`);
  // A legacy row with an old-format TIN can still be edited as long as tin is not sent.
  sql("update clients set tin='222222222' where id=2");
  const legacy = await call("manager", "PATCH", "/clients/2", { contactPhone: "0917" });
  record("[manager] PATCH a legacy-TIN client without tin -> 200", legacy.status === 200 && legacy.json?.tin === "222222222", "200", `${legacy.status} ${legacy.text.slice(0, 120)}`);
});

// ═════════════════════════════════════════════════════════════════════════════
group("5 fiscal year months are validated and kept consistent on the server", async () => {
  await reset();
  const fy = (id) => sql(`select coalesce(fiscal_year_start,'NULL')||'/'||coalesce(fiscal_year_end,'NULL') from clients where id=${Number(id)}`);
  let n = 0;
  const create = (fields) => call("maker", "POST", "/clients", formPayload({ name: `FY Corp ${++n}`, tin: `333-444-55${n % 10}-000`, incomeTaxType: "corporate", ...fields }));
  // Accepted spellings are stored as the full month name; a lone month gets its partner.
  for (const [fields, want] of [
    [{ fiscalYearStart: "Jul" }, "July/June"],
    [{ fiscalYearStart: "07" }, "July/June"],
    [{ fiscalYearStart: "july", fiscalYearEnd: "JUNE" }, "July/June"],
    [{ fiscalYearEnd: "Jun" }, "July/June"],
    [{ fiscalYearStart: "January", fiscalYearEnd: "December" }, "January/December"],
    [{ fiscalYearStart: null, fiscalYearEnd: null }, "NULL/NULL"],
  ]) {
    const r = await create(fields);
    record(`[maker] POST /clients ${JSON.stringify(fields)} -> 201 stored ${want}`, r.status === 201 && fy(r.json?.id) === want, `201 ${want}`, `${r.status} ${r.json?.id ? fy(r.json.id) : r.text.slice(0, 120)}`);
  }
  // Refused: not a month, or an end month that is not the month before the start month.
  const before = Number(sql("select count(*) from clients"));
  for (const fields of [{ fiscalYearStart: "Julyish" }, { fiscalYearEnd: "13" }, { fiscalYearStart: "July", fiscalYearEnd: "December" }]) {
    const r = await create(fields);
    record(`[maker] POST /clients ${JSON.stringify(fields)} -> 400`, r.status === 400 && /fiscal|month/i.test(r.json?.error ?? ""), "400", `${r.status} ${r.text.slice(0, 120)}`);
  }
  record("no client created with a bad fiscal year", Number(sql("select count(*) from clients")) === before, before, sql("select count(*) from clients"));

  // PATCH: one month derives the other; an inconsistent pair is refused and nothing changes.
  const p1 = await call("manager", "PATCH", "/clients/1", { fiscalYearStart: "Apr" });
  record("[manager] PATCH fiscalYearStart Apr -> April/March", p1.status === 200 && fy(1) === "April/March", "200 April/March", `${p1.status} ${fy(1)}`);
  const p2 = await call("manager", "PATCH", "/clients/1", { fiscalYearStart: "July", fiscalYearEnd: "December" });
  record("[manager] PATCH July/December -> 400, stored pair unchanged", p2.status === 400 && fy(1) === "April/March", "400 April/March", `${p2.status} ${fy(1)}`);
  const p3 = await call("manager", "PATCH", "/clients/1", { fiscalYearEnd: "June" });
  record("[manager] PATCH fiscalYearEnd June -> July/June", p3.status === 200 && fy(1) === "July/June", "200 July/June", `${p3.status} ${fy(1)}`);
  const p4 = await call("manager", "PATCH", "/clients/1", { fiscalYearStart: null });
  record("[manager] PATCH fiscalYearStart null clears both (calendar year)", p4.status === 200 && fy(1) === "NULL/NULL", "200 NULL/NULL", `${p4.status} ${fy(1)}`);

  // A legacy abbreviated value already in the database is read as that month, not January.
  sql("update clients set fiscal_year_start='Jul', fiscal_year_end=NULL where id=1");
  const r = await call("manager", "GET", "/clients/1/compliance?year=2026");
  const annual = find(r.json?.items ?? [], "1702", "FY 2026");
  record("legacy 'Jul' start: 1702 FY 2026 due 2027-10-15", annual?.dueDate === "2027-10-15", "2027-10-15", annual?.dueDate);
});

// ═════════════════════════════════════════════════════════════════════════════
group("6 individuals use the calendar year for every form", async () => {
  await reset();
  const c = await call("manager", "POST", "/clients", formPayload({
    name: "Indiv FY", tin: "555-666-777-000", incomeTaxType: "individual", fiscalYearStart: "April", ...allFlags(true),
  }));
  const r = await call("manager", "GET", `/clients/${c.json?.id}/compliance?year=2026`);
  const items = r.json?.items ?? [];
  const due = (form, period) => find(items, form, period)?.dueDate;
  record("individual with an April fiscal-year setting: 2550Q Q1 2026 due 2026-04-27 (Jan–Mar quarter)", due("2550Q", "Q1 2026") === "2026-04-27", "2026-04-27", due("2550Q", "Q1 2026"));
  record("…2551Q Q1 2026 due 2026-04-27", due("2551Q", "Q1 2026") === "2026-04-27", "2026-04-27", due("2551Q", "Q1 2026"));
  record("…SLS Q4 2026 due 2027-01-25", due("SLS", "Q4 2026") === "2027-01-25", "2027-01-25", due("SLS", "Q4 2026"));
  record("…Annual Inventory List FY 2026 due 2027-02-01 (Jan 30 2027 is a Saturday)", due("Inventory", "FY 2026") === "2027-02-01", "2027-02-01", due("Inventory", "FY 2026"));
  const inv = find(items, "Inventory", "FY 2026");
  record("…inventory description says calendar year 2026", /calendar year 2026/.test(inv?.description ?? ""), "calendar year 2026", (inv?.description ?? "").slice(0, 120));
  record("…1701Q Q1 2026 still calendar (due 2026-05-15)", due("1701Q", "Q1 2026") === "2026-05-15", "2026-05-15", due("1701Q", "Q1 2026"));
});

// ═════════════════════════════════════════════════════════════════════════════
group("7 fiscal-quarter descriptions name the months they cover", async () => {
  await reset();
  const c = await call("manager", "POST", "/clients", formPayload({
    name: "FY July Corp", tin: "777-888-999-000", incomeTaxType: "corporate", fiscalYearStart: "July", ...allFlags(true),
  }));
  const r = await call("manager", "GET", `/clients/${c.json?.id}/compliance?year=2026`);
  const items = r.json?.items ?? [];
  for (const form of ["2550Q", "2551Q", "1702Q", "SLS", "SLP"]) {
    const it = find(items, form, "Q1 2026");
    record(`July FY: ${form} Q1 2026 description says July–September 2026, fiscal quarter 1`,
      /July–September 2026: fiscal quarter 1 of the fiscal year July 2026 – June 2027/.test(it?.description ?? ""), "July–September 2026 …", (it?.description ?? "MISSING").slice(0, 140));
  }
  const q4 = find(items, "2550Q", "Q4 2026");
  record("July FY: 2550Q Q4 2026 covers April–June 2027", /April–June 2027/.test(q4?.description ?? ""), "April–June 2027", (q4?.description ?? "MISSING").slice(0, 140));
  // Calendar-quarter withholding returns of the same client keep calendar months.
  const eq = find(items, "1601EQ", "Q1 2026");
  record("July FY: 1601EQ Q1 2026 is still the calendar quarter (due 2026-04-30)", eq?.dueDate === "2026-04-30", "2026-04-30", eq?.dueDate);
  // Calendar-year client: months, no fiscal note.
  const a = await call("manager", "GET", "/clients/1/compliance?year=2026");
  const a2550 = find(a.json?.items ?? [], "2550Q", "Q1 2026");
  record("calendar year: 2550Q Q1 2026 says (January–March 2026), no fiscal note",
    /\(January–March 2026\)/.test(a2550?.description ?? "") && !/fiscal quarter/.test(a2550?.description ?? ""), "(January–March 2026)", (a2550?.description ?? "MISSING").slice(0, 120));
});

// ═════════════════════════════════════════════════════════════════════════════
group("8 a hand-edited due date: checklist, linked filing and overwrite", async () => {
  await reset();
  const item = async () => find((await call("manager", "GET", "/clients/1/compliance?year=2026")).json?.items ?? [], "1601C", "January 2026");
  const before = await item();
  record("fixture: 1601C January 2026 (deadline 1, due 2026-02-10) is overdue", before?.deadlineId === 1 && before?.status === "overdue" && before?.dueDate === "2026-02-10",
    "1 overdue 2026-02-10", `${before?.deadlineId} ${before?.status} ${before?.dueDate}`);

  // Extension entered by hand.
  const p = await call("maker", "PATCH", "/deadlines/1", { dueDate: "2099-01-15" });
  record("[maker] PATCH /deadlines/1 dueDate 2099-01-15 -> 200", p.status === 200 && p.json?.dueDate === "2099-01-15", "200", `${p.status} ${p.text.slice(0, 120)}`);
  const after = await item();
  record("checklist shows the saved due date and judges overdue by it", after?.dueDate === "2099-01-15" && after?.status === "pending", "2099-01-15 pending", `${after?.dueDate} ${after?.status}`);
  record("the linked filing (engagement 1) follows the new due date", sql("select due_date from engagements where id=1") === "2099-01-15", "2099-01-15", sql("select due_date from engagements where id=1"));
  record("deadline 1 is flagged as edited by hand", sql("select due_date_manual from deadlines where id=1") === "t", "t", sql("select due_date_manual from deadlines where id=1"));

  // A row whose date merely drifted (not edited by hand) is corrected by overwrite; the hand-edited one is kept.
  const g = await call("manager", "POST", "/clients/1/generate-deadlines", { year: 2026 });
  record("generate 2026 (no overwrite) -> 200", g.status === 200, 200, g.status);
  sql("update deadlines set due_date='2026-12-31' where client_id=1 and title='BIR Form 1601C — November 2026'");
  const o = await call("manager", "POST", "/clients/1/generate-deadlines", { year: 2026, overwrite: true });
  record("overwrite reply counts the kept hand-edited date", o.status === 200 && /1 kept a due date edited by hand/.test(o.json?.message ?? ""), "… 1 kept a due date edited by hand …", `${o.status} ${o.json?.message}`);
  record("overwrite keeps the hand-edited due date", sql("select due_date from deadlines where id=1") === "2099-01-15", "2099-01-15", sql("select due_date from deadlines where id=1"));
  record("overwrite resets a drifted date that nobody edited",
    sql("select due_date from deadlines where client_id=1 and title='BIR Form 1601C — November 2026'") === "2026-12-10", "2026-12-10",
    sql("select due_date from deadlines where client_id=1 and title='BIR Form 1601C — November 2026'"));
  record("engagement 1 still has the hand-edited date", sql("select due_date from engagements where id=1") === "2099-01-15", "2099-01-15", sql("select due_date from engagements where id=1"));
});

// ═════════════════════════════════════════════════════════════════════════════
group("9 start-workflow labels: tax type, period and form code match the checklist", async () => {
  await reset();
  await call("manager", "POST", "/clients/1/generate-deadlines", { year: 2026 });
  const items = (await call("manager", "GET", "/clients/1/compliance?year=2026")).json?.items ?? [];
  const deadlines = (await call("maker", "GET", "/deadlines")).json ?? [];
  // Every saved deadline carries the checklist's own form code and period.
  let mismatches = [];
  for (const it of items) {
    if (it.deadlineId == null) continue;
    const d = deadlines.find((x) => x.id === it.deadlineId);
    if (!d || d.formNumber !== it.formNumber || d.period !== it.period) mismatches.push(`${it.formNumber} ${it.period} -> ${d?.formNumber} ${d?.period}`);
  }
  record(`GET /deadlines formNumber/period = checklist for all ${items.filter((i) => i.deadlineId != null).length} saved items`, mismatches.length === 0, "none", mismatches.slice(0, 5).join("; "));

  for (const [title, taxType, period, form] of [
    ["BIR Form 1601C — February 2026", "1601C", "February 2026", "1601C"],
    ["Alphalist of Employees (1604C Attachment) — 2026", "Alphalist-1604C", "Annual 2026", "Alphalist-1604C"],
    ["Annex F (Annual Alphalist of Employees) — 2026", "AnnexF", "Annual 2026", "AnnexF"],
    ["BIR Form 1601EQ — Q1 2026", "1601EQ", "Q1 2026", "1601EQ"],
  ]) {
    const id = sql(`select id from deadlines where client_id=1 and title=${"'" + title.replace(/'/g, "''") + "'"} order by id limit 1`);
    const s = await call("maker", "POST", `/deadlines/${id}/start-workflow`, {});
    record(`start-workflow "${title}" -> taxType ${taxType}, period ${period}`, (s.status === 201 || s.status === 200) && s.json?.taxType === taxType && s.json?.period === period,
      `${taxType} / ${period}`, `${s.status} ${s.json?.taxType} / ${s.json?.period}`);
    const e = await call("maker", "GET", `/engagements/${s.json?.id}`);
    record(`…GET /engagements/:id formNumber ${form}`, e.json?.formNumber === form, form, e.json?.formNumber);
  }
  // Hand-made engagements: the code in parentheses.
  const m = await call("manager", "GET", "/engagements/1");
  record("fixture engagement 1 (taxType 1601C) formNumber 1601C", m.json?.formNumber === "1601C", "1601C", m.json?.formNumber);
  sql("insert into engagements (client_id, title, tax_type, period, status) values (1, 'VAT Q1', 'VAT (2550Q)', 'Q1 2026', 'pending')");
  const all = (await call("manager", "GET", "/engagements")).json ?? [];
  const vat = all.find((e) => e.title === "VAT Q1");
  record("hand-made 'VAT (2550Q)' engagement formNumber 2550Q", vat?.formNumber === "2550Q", "2550Q", vat?.formNumber);
});

// ═════════════════════════════════════════════════════════════════════════════
await main({ reset });
