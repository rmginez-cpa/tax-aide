import { Router } from "express";
import { and, asc, desc, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { db, clientsTable, engagementsTable, deadlinesTable, auditLogsTable, usersTable } from "@workspace/db";
import { requireAuth, clientScope, isManagerRole } from "../middlewares/auth";
import { openDeadlines } from "../lib/openDeadlines";
import { manilaToday, addDays, monthStart } from "../lib/dates";

const router = Router();

type EngagementRow = typeof engagementsTable.$inferSelect;

const UPCOMING_WINDOW_DAYS = 30;
/** "My deadlines" window of the maker's Needs-my-action card. */
const MY_WORK_WINDOW_DAYS = 14;
/** Cap per list of GET /dashboard/my-work (the card links to the full lists). */
const MY_WORK_LIMIT = 25;

// ── Helpers ───────────────────────────────────────────────────────────────────
// Every date here is a Philippine calendar date (Asia/Manila), via lib/dates.
// clientScope(req) is null for staff (everything) and otherwise the linked
// client id; an unlinked client account gets 0, which matches no row.

function engagementScope(scope: number | null): SQL | undefined {
  return scope === null ? undefined : eq(engagementsTable.clientId, scope);
}

function deadlineScope(scope: number | null): SQL | undefined {
  return scope === null ? undefined : eq(deadlinesTable.clientId, scope);
}

/** Number of stages of an engagement currently awaiting manager review. */
function stagesForReview(e: EngagementRow): number {
  return [e.sourceCollectionStatus, e.draftReturnStatus, e.confirmationStatus, e.paymentStatus]
    .filter((s) => s === "for_review").length;
}

/** Whole days from `fromIso` to `toIso` (both YYYY-MM-DD). */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function uniqueIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => id != null))];
}

async function loadClientNames(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
  const unique = uniqueIds(ids);
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(inArray(clientsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function loadEngagementTitles(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
  const unique = uniqueIds(ids);
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: engagementsTable.id, title: engagementsTable.title })
    .from(engagementsTable)
    .where(inArray(engagementsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.title]));
}

async function loadUserNames(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
  const unique = uniqueIds(ids);
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── GET /dashboard/summary ────────────────────────────────────────────────────

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const scope = clientScope(req);
  const today = manilaToday();
  const futureStr = addDays(today, UPCOMING_WINDOW_DAYS);
  const startOfMonth = monthStart(today);

  // Open deadlines: anything not completed (pending or overdue), one per filing.
  const [clients, engagements, pendingDeadlines] = await Promise.all([
    db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(scope === null ? undefined : eq(clientsTable.id, scope)),
    db.select().from(engagementsTable).where(engagementScope(scope)),
    openDeadlines(deadlineScope(scope)),
  ]);

  // For a client account this is 1 (its own client) or 0 (unlinked).
  const totalClients = clients.length;
  const activeEngagements = engagements.filter((e) =>
    ["pending", "in_progress", "for_review"].includes(e.status)
  ).length;
  const upcomingDeadlines = pendingDeadlines.filter((d) => d.dueDate >= today && d.dueDate <= futureStr).length;
  const overdueItems = pendingDeadlines.filter((d) => d.dueDate < today).length;
  // Approval happens per stage now, so count the stages awaiting review.
  const pendingApprovals = engagements.reduce((sum, e) => sum + stagesForReview(e), 0);
  const completedThisMonth = engagements.filter((e) => {
    if (e.status !== "completed") return false;
    const completedOn = manilaToday(e.approvedAt ?? e.updatedAt);
    return completedOn >= startOfMonth && completedOn <= today;
  }).length;

  res.json({
    totalClients,
    activeEngagements,
    upcomingDeadlines,
    overdueItems,
    pendingApprovals,
    completedThisMonth,
  });
});

// ── GET /dashboard/my-work ────────────────────────────────────────────────────
// The dashboard's "Needs my action" card, role-aware:
// - managers / super admins ("review"): filings with stages awaiting review,
//   oldest first (by when the filing last changed, i.e. roughly when it was submitted).
// - makers ("maker"): open filings assigned to me by due date (no due date last),
//   plus open deadlines of those filings due in the next 14 days.
// - clients ("client"): their open deadlines and their filings in progress,
//   always scoped with clientScope (an unlinked account sees nothing).
// Each list holds at most MY_WORK_LIMIT rows; `totals` has the full counts.

const STAGE_COLUMNS = [
  ["source_collection", "sourceCollectionStatus"],
  ["draft_return", "draftReturnStatus"],
  ["confirmation", "confirmationStatus"],
  ["payment", "paymentStatus"],
] as const;

/** Stage keys of `e` that are awaiting review (payment is ignored when no tax is payable). */
function reviewStages(e: EngagementRow): string[] {
  const noPayment = e.taxPayable !== null && Number(e.taxPayable) === 0;
  return STAGE_COLUMNS
    .filter(([key, col]) => e[col] === "for_review" && !(key === "payment" && noPayment))
    .map(([key]) => key);
}

function byDueDate(a: { dueDate: string | null; id: number }, b: { dueDate: string | null; id: number }): number {
  if (a.dueDate === b.dueDate) return a.id - b.id;
  if (a.dueDate == null) return 1;
  if (b.dueDate == null) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}

router.get("/dashboard/my-work", requireAuth, async (req, res): Promise<void> => {
  const scope = clientScope(req);
  const role = req.session.userRole ?? "";
  const userId = req.session.userId!;
  const today = manilaToday();
  const kind = scope !== null ? "client" : isManagerRole(role) ? "review" : "maker";

  let engagementRows: EngagementRow[] = [];
  let deadlineRows: Awaited<ReturnType<typeof openDeadlines>> = [];

  if (kind === "review") {
    engagementRows = await db
      .select()
      .from(engagementsTable)
      .where(
        or(
          eq(engagementsTable.sourceCollectionStatus, "for_review"),
          eq(engagementsTable.draftReturnStatus, "for_review"),
          eq(engagementsTable.confirmationStatus, "for_review"),
          eq(engagementsTable.paymentStatus, "for_review"),
        ),
      )
      .orderBy(asc(engagementsTable.updatedAt), asc(engagementsTable.id));
    engagementRows = engagementRows.filter((e) => reviewStages(e).length > 0);
  } else if (kind === "maker") {
    engagementRows = (
      await db
        .select()
        .from(engagementsTable)
        .where(and(eq(engagementsTable.assignedTo, userId), ne(engagementsTable.status, "completed")))
    ).sort(byDueDate);
    const ids = engagementRows.map((e) => e.id);
    const windowEnd = addDays(today, MY_WORK_WINDOW_DAYS);
    deadlineRows = ids.length
      ? (await openDeadlines(inArray(deadlinesTable.engagementId, ids)))
          .filter((d) => d.dueDate >= today && d.dueDate <= windowEnd)
      : [];
  } else {
    const [engagements, deadlines] = await Promise.all([
      db
        .select()
        .from(engagementsTable)
        .where(and(engagementScope(scope), inArray(engagementsTable.status, ["in_progress", "for_review", "approved", "filed"]))),
      openDeadlines(deadlineScope(scope)),
    ]);
    engagementRows = engagements.sort(byDueDate);
    deadlineRows = deadlines;
  }

  const filings = engagementRows.slice(0, MY_WORK_LIMIT);
  const deadlines = deadlineRows.slice(0, MY_WORK_LIMIT);
  const clientNames = await loadClientNames([
    ...filings.map((e) => e.clientId),
    ...deadlines.map((d) => d.clientId),
  ]);

  res.json({
    kind,
    today,
    windowDays: kind === "maker" ? MY_WORK_WINDOW_DAYS : null,
    totals: { filings: engagementRows.length, deadlines: deadlineRows.length },
    filings: filings.map((e) => ({
      id: e.id,
      title: e.title,
      clientId: e.clientId,
      clientName: clientNames.get(e.clientId) ?? null,
      taxType: e.taxType,
      period: e.period,
      status: e.status,
      dueDate: e.dueDate ?? null,
      overdue: e.dueDate != null && e.dueDate < today,
      daysUntilDue: e.dueDate != null ? daysBetween(today, e.dueDate) : null,
      stagesForReview: reviewStages(e),
      waitingSince: e.updatedAt.toISOString(),
    })),
    deadlines: deadlines.map((d) => ({
      id: d.id,
      title: d.title,
      clientId: d.clientId ?? null,
      clientName: d.clientId != null ? clientNames.get(d.clientId) ?? null : null,
      engagementId: d.engagementId ?? null,
      dueDate: d.dueDate,
      priority: d.priority,
      overdue: d.dueDate < today,
      daysUntilDue: daysBetween(today, d.dueDate),
    })),
  });
});

// ── GET /dashboard/upcoming-deadlines ─────────────────────────────────────────

router.get("/dashboard/upcoming-deadlines", requireAuth, async (req, res): Promise<void> => {
  const scope = clientScope(req);
  const today = manilaToday();
  const futureStr = addDays(today, UPCOMING_WINDOW_DAYS);

  const upcoming = (await openDeadlines(deadlineScope(scope)))
    .filter((d) => d.dueDate >= today && d.dueDate <= futureStr);

  const [clientNames, engagementTitles] = await Promise.all([
    loadClientNames(upcoming.map((d) => d.clientId)),
    loadEngagementTitles(upcoming.map((d) => d.engagementId)),
  ]);

  res.json(upcoming.map((d) => ({
    id: d.id,
    title: d.title,
    dueDate: d.dueDate,
    status: d.status,
    priority: d.priority,
    clientName: d.clientId != null ? clientNames.get(d.clientId) ?? null : null,
    engagementTitle: d.engagementId != null ? engagementTitles.get(d.engagementId) ?? null : null,
    daysUntilDue: daysBetween(today, d.dueDate),
  })));
});

// ── GET /dashboard/overdue ────────────────────────────────────────────────────

router.get("/dashboard/overdue", requireAuth, async (req, res): Promise<void> => {
  const scope = clientScope(req);
  const today = manilaToday();

  const [overdueDeadlineRows, engagementRows] = await Promise.all([
    openDeadlines(deadlineScope(scope)).then((rows) => rows.filter((d) => d.dueDate < today)),
    db.select().from(engagementsTable).where(engagementScope(scope)),
  ]);

  const overdueEngagementRows = engagementRows.filter(
    (e) => e.dueDate && e.dueDate < today && !["completed", "filed"].includes(e.status)
  );

  const clientNames = await loadClientNames([
    ...overdueDeadlineRows.map((d) => d.clientId),
    ...overdueEngagementRows.map((e) => e.clientId),
  ]);

  const overdueDeadlines = overdueDeadlineRows.map((d) => ({
    id: d.id,
    engagementId: d.engagementId ?? null,
    clientId: d.clientId ?? null,
    clientName: d.clientId != null ? clientNames.get(d.clientId) ?? null : null,
    title: d.title,
    description: d.description ?? null,
    dueDate: d.dueDate,
    status: "overdue",
    priority: d.priority,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));

  const overdueEngagements = overdueEngagementRows.map((e) => ({
    id: e.id,
    clientId: e.clientId,
    clientName: clientNames.get(e.clientId) ?? null,
    title: e.title,
    taxType: e.taxType,
    period: e.period,
    fiscalYear: e.fiscalYear ?? null,
    status: e.status,
    assignedTo: e.assignedTo ?? null,
    assignedToName: null,
    approvedBy: e.approvedBy ?? null,
    approvedByName: null,
    approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
    approvalNotes: e.approvalNotes ?? null,
    dueDate: e.dueDate ?? null,
    notes: e.notes ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }));

  res.json({ overdueDeadlines, overdueEngagements });
});

// ── GET /dashboard/recent-activity ────────────────────────────────────────────
// This is the audit trail, which is for managers and super admins only (as
// GET /audit-logs): everyone else gets an empty list.

router.get("/dashboard/recent-activity", requireAuth, async (req, res): Promise<void> => {
  if (!isManagerRole(req.session.userRole ?? "")) {
    res.json([]);
    return;
  }

  const logs = await db
    .select()
    .from(auditLogsTable)
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
    .limit(20);

  const userNames = await loadUserNames(logs.map((l) => l.userId));

  res.json(logs.map((log) => ({
    id: log.id,
    userId: log.userId ?? null,
    userName: log.userId != null ? userNames.get(log.userId) ?? null : null,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId ?? null,
    description: log.description,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt.toISOString(),
  })));
});

// ── GET /dashboard/engagement-status ──────────────────────────────────────────

router.get("/dashboard/engagement-status", requireAuth, async (req, res): Promise<void> => {
  const engagements = await db
    .select({ status: engagementsTable.status })
    .from(engagementsTable)
    .where(engagementScope(clientScope(req)));

  const statusMap: Record<string, number> = {};
  for (const e of engagements) {
    statusMap[e.status] = (statusMap[e.status] ?? 0) + 1;
  }

  const result = Object.entries(statusMap).map(([status, count]) => ({ status, count }));
  res.json(result);
});

export default router;
