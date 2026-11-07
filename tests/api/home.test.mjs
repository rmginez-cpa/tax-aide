// TaxAide home-track integration tests: GET /dashboard/my-work ("Needs my action" card) and
// the notifications endpoints (unread count, newest-first ordering, own-user scoping).
// Shared harness (_harness.mjs), environment and guard as the other suites.
//
// !! DESTRUCTIVE: fixture.sql TRUNCATEs every application table. Point it only at a
// !! throwaway database. The script refuses to run unless TAXAIDE_TEST_RESET_DB=1.
//
// Run:  see tests/api/README.md
// Env:  API_BASE, FIXTURE, UPLOADS_DIR (must equal the server's UPLOADS_DIR),
//       PGHOST/PGUSER/PGDATABASE/PGPASSWORD, ONLY=<group substring>, DRY_RUN=1

import { guard, sql, reset, is, pred, arr, check, assert, group, main } from "./_harness.mjs";

guard({ allowDryRun: true });

const STAFF = ["maker", "manager", "admin"];
const CLIENTS = ["client", "viewer"]; // both scoped to Alpha

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
await main({ reset });
