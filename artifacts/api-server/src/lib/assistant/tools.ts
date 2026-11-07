import { z } from "zod/v4";
import { and, desc, eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import {
  db,
  clientsTable,
  deadlinesTable,
  engagementsTable,
  documentsTable,
  commentsTable,
  checklistItemsTable,
  usersTable,
} from "@workspace/db";
import { buildComplianceItems, serializeClient } from "../../routes/clients";
import { clientScopeFor, isClientRole, isStaffRole, type Actor } from "../../middlewares/auth";
import { manilaToday } from "../dates";
import { openDeadlines } from "../openDeadlines";
import { ServiceError, type WriteChannel } from "../services/common";
import { createComment } from "../services/comments";
import { updateDeadline } from "../services/deadlines";
import { updateChecklistItem } from "../services/checklist";

// ── Who is asking ─────────────────────────────────────────────────────────────
// One tool implementation serves the in-app assistant (read tools only) and the
// remote MCP connector (read tools, plus the write tools when the grant has the
// write scope). Every tool runs with the user's own access: client (and legacy
// viewer) accounts only ever see their linked client (clientScopeFor, the same
// rule as the HTTP routes), and write tools go through the same service
// functions, permission checks and audit logging as the HTTP routes.

export interface AssistantUser extends Actor {
  name: string;
}

export function isClientUser(u: AssistantUser): boolean {
  return isClientRole(u.role);
}

export { manilaToday };

class ToolError extends Error {}

/** For client accounts, the client id they may see; otherwise the requested one. */
function scopeClientId(u: AssistantUser, requested?: number): number | undefined {
  const scope = clientScopeFor(u);
  if (scope === null) return requested;
  if (!scope) throw new ToolError("This account is not linked to a client record, so there is no data to show.");
  if (requested != null && requested !== scope) {
    throw new ToolError("Not found, or you do not have access to that client.");
  }
  return scope;
}

/** Whether `u` may see a record of `clientId` (the HTTP routes' canAccessClient). */
function canSeeClient(u: AssistantUser, clientId: number | null | undefined): boolean {
  const scope = clientScopeFor(u);
  return scope === null || (clientId != null && clientId === scope);
}

const STAGES = ["source_collection", "draft_return", "confirmation", "payment"] as const;

function stageStatuses(e: typeof engagementsTable.$inferSelect) {
  const paymentNA = e.taxPayable !== null && Number(e.taxPayable) === 0;
  return {
    source_collection: e.sourceCollectionStatus,
    draft_return: e.draftReturnStatus,
    confirmation: e.confirmationStatus,
    payment: paymentNA ? "not_applicable" : e.paymentStatus,
  };
}

async function namesById(table: "clients" | "users", ids: Array<number | null | undefined>) {
  const unique = [...new Set(ids.filter((i): i is number => i != null))];
  const map = new Map<number, string>();
  if (unique.length === 0) return map;
  const rows =
    table === "clients"
      ? await db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, unique))
      : await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, unique));
  for (const r of rows) map.set(r.id, r.name);
  return map;
}

function registrations(c: typeof clientsTable.$inferSelect): string[] {
  const out: string[] = [];
  if (c.incomeTaxType === "corporate") out.push("Corporate income tax (1702/1702Q)");
  if (c.incomeTaxType === "individual") out.push("Individual income tax (1701/1701Q)");
  if (c.vatRegistered) out.push("VAT (2550Q, SLS/SLP)");
  if (c.percentageTaxRegistered) out.push("Percentage tax (2551Q)");
  if (c.withholdsCompensation) out.push("Withholding on compensation (1601C, 1604C, 2316)");
  if (c.withholdsEwt) out.push("Expanded withholding (0619E, 1601EQ, 1604E, QAP)");
  if (c.withholdsFinal) out.push("Final withholding (0619F, 1601FQ, 1604F)");
  if (c.subjectToDst) out.push("Documentary stamp tax (2000)");
  if (c.isEsalesRequired) out.push("eSales report");
  if (c.hasInventory) out.push("Annual inventory list");
  if (c.isLessor) out.push("Lessee information statement");
  return out;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

interface ToolDef<S extends z.ZodType> {
  name: string;
  /** Human-readable name (MCP `title`). */
  title: string;
  description: string;
  /** Short present-tense label shown to the user while the tool runs. */
  label: string;
  input: S;
  /**
   * read: available to everyone, scoped to what the user may see.
   * write: only over the MCP connector, with the write scope, for staff roles
   * (every write tool wraps a staff-only HTTP route).
   */
  access: "read" | "write";
  /** MCP hints for write tools: may overwrite existing data / same call twice has no further effect. */
  destructive?: boolean;
  idempotent?: boolean;
  run: (input: z.infer<S>, user: AssistantUser, via?: WriteChannel) => Promise<unknown>;
}

function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

const id = () => z.number().int().positive();
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const TOOLS = [
  defineTool({
    name: "find_clients",
    title: "Find clients",
    access: "read",
    label: "Looking up clients",
    description:
      "Search the firm's clients by name, trade name or TIN. Returns id, name, TIN, status, RDO and registered tax types. " +
      "Call this first whenever the user names a client in their own words, to get the client_id the other tools need.",
    input: z.object({
      query: z.string().optional().describe("Part of the client's registered name, trade name or TIN. Omit to list all clients."),
      status: z.enum(["active", "inactive"]).optional(),
    }),
    run: async ({ query, status }, user) => {
      const conds: SQL[] = [];
      const scoped = scopeClientId(user);
      if (scoped != null) conds.push(eq(clientsTable.id, scoped));
      if (status) conds.push(eq(clientsTable.status, status));
      if (query?.trim()) {
        const q = `%${query.trim()}%`;
        conds.push(or(ilike(clientsTable.name, q), ilike(clientsTable.tradeName, q), ilike(clientsTable.tin, q))!);
      }
      const rows = await db.select().from(clientsTable).where(conds.length ? and(...conds) : undefined).orderBy(clientsTable.name).limit(51);
      return {
        clients: rows.slice(0, 50).map((c) => ({
          id: c.id,
          name: c.name,
          tradeName: c.tradeName,
          tin: c.tin,
          status: c.status,
          rdoCode: c.rdoCode,
          registeredTaxTypes: registrations(c),
        })),
        truncated: rows.length > 50,
      };
    },
  }),

  defineTool({
    name: "get_client",
    title: "Get client profile",
    access: "read",
    label: "Reading client profile",
    description:
      "Full profile of one client: contact details, BIR 2303 registration (RDO, line of business, fiscal year, income tax type) and every registered tax type.",
    input: z.object({ client_id: id() }),
    run: async ({ client_id }, user) => {
      const cid = scopeClientId(user, client_id)!;
      const [c] = await db.select().from(clientsTable).where(eq(clientsTable.id, cid));
      if (!c) throw new ToolError("Client not found.");
      return { ...serializeClient(c), registeredTaxTypes: registrations(c) };
    },
  }),

  defineTool({
    name: "get_client_compliance",
    title: "Get client compliance checklist",
    access: "read",
    label: "Checking the compliance calendar",
    description:
      "The BIR compliance checklist for one client and tax year, computed from their 2303 registration: every required return/attachment " +
      "with its due date, whether it is filed, pending or overdue, and the 4-stage filing workflow status " +
      "(source_collection, draft_return, confirmation, payment) when a filing has been started.",
    input: z.object({
      client_id: id(),
      year: z.number().int().min(2000).max(2100).optional().describe("Tax year. Defaults to the current year."),
      only: z.enum(["overdue", "pending", "filed"]).optional().describe("Return only items with this status."),
    }),
    run: async ({ client_id, year, only }, user) => {
      const cid = scopeClientId(user, client_id)!;
      const [c] = await db.select().from(clientsTable).where(eq(clientsTable.id, cid));
      if (!c) throw new ToolError("Client not found.");
      const y = year ?? Number(manilaToday().slice(0, 4));
      const items = await buildComplianceItems(c, y);
      const summary = {
        total: items.length,
        filed: items.filter((i) => i.status === "filed").length,
        pending: items.filter((i) => i.status === "pending").length,
        overdue: items.filter((i) => i.status === "overdue").length,
      };
      return {
        client: { id: c.id, name: c.name },
        year: y,
        summary,
        items: items
          .filter((i) => !only || i.status === only)
          .map((i) => ({
            form: i.formNumber,
            period: i.period,
            dueDate: i.dueDate,
            status: i.status,
            deadlineId: i.deadlineId,
            engagementId: i.engagementId,
            stageStatuses: i.stageStatuses,
            taxPayable: i.taxPayable,
          })),
        note:
          items.length === 0
            ? "No tax types are registered for this client, so no BIR deadlines apply. Update the client's 2303 information first."
            : undefined,
      };
    },
  }),

  defineTool({
    name: "list_deadlines",
    title: "List deadlines",
    access: "read",
    label: "Checking deadlines",
    description:
      "BIR filing deadlines saved in TaxAide, ordered by due date. Filter by client, status and due-date range. " +
      "status 'overdue' means not completed and due before today (Asia/Manila).",
    input: z.object({
      client_id: id().optional(),
      status: z.enum(["pending", "completed", "overdue"]).optional(),
      due_from: isoDate().optional(),
      due_to: isoDate().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    }),
    run: async ({ client_id, status, due_from, due_to, limit }, user) => {
      const cid = scopeClientId(user, client_id);
      const today = manilaToday();
      const conds: SQL[] = [];
      if (cid != null) conds.push(eq(deadlinesTable.clientId, cid));
      if (status === "completed") conds.push(eq(deadlinesTable.status, "completed"));
      if (due_from) conds.push(gte(deadlinesTable.dueDate, due_from));
      if (due_to) conds.push(lte(deadlinesTable.dueDate, due_to));
      const max = limit ?? 50;
      // Open deadlines are counted like the dashboard and the client badges (openDeadlines):
      // copies of one filing once, and none of a filing that has a completed copy.
      const rows = status === "pending" || status === "overdue"
        ? (await openDeadlines(cid != null ? eq(deadlinesTable.clientId, cid) : undefined))
            .filter((d) => (status !== "overdue" || d.dueDate < today) && (!due_from || d.dueDate >= due_from) && (!due_to || d.dueDate <= due_to))
            .slice(0, max + 1)
        : await db.select().from(deadlinesTable).where(conds.length ? and(...conds) : undefined).orderBy(deadlinesTable.dueDate).limit(max + 1);
      const clients = await namesById("clients", rows.map((r) => r.clientId));
      return {
        today,
        deadlines: rows.slice(0, max).map((d) => ({
          id: d.id,
          title: d.title,
          client: d.clientId ? { id: d.clientId, name: clients.get(d.clientId) ?? null } : null,
          dueDate: d.dueDate,
          status: d.status !== "completed" && d.dueDate < today ? "overdue" : d.status,
          priority: d.priority,
          engagementId: d.engagementId,
        })),
        truncated: rows.length > max,
      };
    },
  }),

  defineTool({
    name: "list_filings",
    title: "List filings",
    access: "read",
    label: "Checking filings in progress",
    description:
      "Filing workflows (engagements). Each has four independent stages - source_collection, draft_return, confirmation, payment - " +
      "with status not_started | in_progress | for_review | approved (payment is not_applicable when tax payable is zero). " +
      "A filing is completed when every required stage is approved. Use awaiting_review=true for the manager approval queue.",
    input: z.object({
      client_id: id().optional(),
      status: z.enum(["pending", "in_progress", "completed"]).optional(),
      awaiting_review: z.boolean().optional().describe("Only filings with at least one stage submitted for manager review."),
      assigned_to_me: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    }),
    run: async ({ client_id, status, awaiting_review, assigned_to_me, limit }, user) => {
      const cid = scopeClientId(user, client_id);
      const conds: SQL[] = [];
      if (cid != null) conds.push(eq(engagementsTable.clientId, cid));
      if (status) conds.push(eq(engagementsTable.status, status));
      if (assigned_to_me) conds.push(eq(engagementsTable.assignedTo, user.id));
      if (awaiting_review) {
        conds.push(
          or(
            eq(engagementsTable.sourceCollectionStatus, "for_review"),
            eq(engagementsTable.draftReturnStatus, "for_review"),
            eq(engagementsTable.confirmationStatus, "for_review"),
            eq(engagementsTable.paymentStatus, "for_review"),
          )!,
        );
      }
      const max = limit ?? 50;
      const rows = await db
        .select()
        .from(engagementsTable)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(engagementsTable.dueDate)
        .limit(max + 1);
      const clients = await namesById("clients", rows.map((r) => r.clientId));
      const users = await namesById("users", rows.map((r) => r.assignedTo));
      return {
        filings: rows.slice(0, max).map((e) => ({
          id: e.id,
          title: e.title,
          client: { id: e.clientId, name: clients.get(e.clientId) ?? null },
          period: e.period,
          dueDate: e.dueDate,
          status: e.status,
          stageStatuses: stageStatuses(e),
          taxPayable: e.taxPayable !== null ? Number(e.taxPayable) : null,
          assignedTo: e.assignedTo ? users.get(e.assignedTo) ?? null : null,
          isAmendment: e.isAmendment,
        })),
        truncated: rows.length > max,
      };
    },
  }),

  defineTool({
    name: "get_filing",
    title: "Get filing details",
    access: "read",
    label: "Reading the filing",
    description:
      "Everything about one filing (engagement): stage statuses, tax payable, assignee, approval notes, the documents uploaded to each stage, " +
      "the checklist and the latest comments (including manager approvals and return-for-revision reasons).",
    input: z.object({ engagement_id: id() }),
    run: async ({ engagement_id }, user) => {
      const [e] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, engagement_id));
      if (!e || !canSeeClient(user, e.clientId)) {
        throw new ToolError("Filing not found, or you do not have access to it.");
      }
      const [docs, checklist, comments] = await Promise.all([
        db.select().from(documentsTable).where(eq(documentsTable.engagementId, e.id)).orderBy(documentsTable.createdAt),
        db.select().from(checklistItemsTable).where(eq(checklistItemsTable.engagementId, e.id)).orderBy(checklistItemsTable.sortOrder),
        db.select().from(commentsTable).where(eq(commentsTable.engagementId, e.id)).orderBy(desc(commentsTable.createdAt)).limit(20),
      ]);
      const clients = await namesById("clients", [e.clientId]);
      const users = await namesById("users", [e.assignedTo, e.approvedBy, ...docs.map((d) => d.uploadedBy), ...comments.map((c) => c.authorId)]);
      return {
        id: e.id,
        title: e.title,
        client: { id: e.clientId, name: clients.get(e.clientId) ?? null },
        period: e.period,
        dueDate: e.dueDate,
        status: e.status,
        stageStatuses: stageStatuses(e),
        taxPayable: e.taxPayable !== null ? Number(e.taxPayable) : null,
        taxPayableCurrency: "PHP",
        assignedTo: e.assignedTo ? users.get(e.assignedTo) ?? null : null,
        approvedBy: e.approvedBy ? users.get(e.approvedBy) ?? null : null,
        approvedAt: e.approvedAt?.toISOString() ?? null,
        approvalNotes: e.approvalNotes,
        isAmendment: e.isAmendment,
        amendsFilingId: e.amendedEngagementId,
        documentsByStage: Object.fromEntries(
          [...STAGES, "unassigned"].map((s) => [
            s,
            docs
              .filter((d) => (d.stage ?? "unassigned") === s)
              .map((d) => ({ id: d.id, name: d.originalName, type: d.mimeType, uploadedBy: users.get(d.uploadedBy) ?? null, uploadedAt: d.createdAt.toISOString() })),
          ]),
        ),
        checklist: checklist.map((i) => ({ label: i.label, status: i.status, notes: i.notes })),
        latestComments: comments.map((c) => ({
          author: users.get(c.authorId) ?? null,
          isApproval: c.isApproval,
          content: c.content,
          at: c.createdAt.toISOString(),
        })),
      };
    },
  }),

  defineTool({
    name: "list_documents",
    title: "List documents",
    access: "read",
    label: "Searching documents",
    description: "Uploaded documents (file name, type, client, filing, stage, uploader, date), newest first. Filter by client, filing or file name.",
    input: z.object({
      client_id: id().optional(),
      engagement_id: id().optional(),
      name_contains: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
    }),
    run: async ({ client_id, engagement_id, name_contains, limit }, user) => {
      const cid = scopeClientId(user, client_id);
      const conds: SQL[] = [];
      if (cid != null) conds.push(eq(documentsTable.clientId, cid));
      if (engagement_id != null) conds.push(eq(documentsTable.engagementId, engagement_id));
      if (name_contains?.trim()) conds.push(ilike(documentsTable.originalName, `%${name_contains.trim()}%`));
      const max = limit ?? 50;
      const rows = await db.select().from(documentsTable).where(conds.length ? and(...conds) : undefined).orderBy(desc(documentsTable.createdAt)).limit(max + 1);
      const clients = await namesById("clients", rows.map((r) => r.clientId));
      const users = await namesById("users", rows.map((r) => r.uploadedBy));
      return {
        documents: rows.slice(0, max).map((d) => ({
          id: d.id,
          name: d.originalName,
          type: d.mimeType,
          sizeKb: Math.round(d.fileSize / 1024),
          client: d.clientId ? clients.get(d.clientId) ?? null : null,
          engagementId: d.engagementId,
          stage: d.stage,
          description: d.description,
          uploadedBy: users.get(d.uploadedBy) ?? null,
          uploadedAt: d.createdAt.toISOString(),
        })),
        truncated: rows.length > max,
      };
    },
  }),

  defineTool({
    name: "workload_overview",
    title: "Workload overview",
    access: "read",
    label: "Summarizing the workload",
    description:
      "Headline numbers for the user's view of TaxAide: overdue deadlines, deadlines due in the next N days, filings in progress, " +
      "stages awaiting manager review, and filings completed this month.",
    input: z.object({
      days_ahead: z.number().int().min(1).max(120).optional().describe("Window for 'due soon'. Default 14."),
    }),
    run: async ({ days_ahead }, user) => {
      const cid = scopeClientId(user);
      const today = manilaToday();
      const horizon = new Date(`${today}T00:00:00Z`);
      horizon.setUTCDate(horizon.getUTCDate() + (days_ahead ?? 14));
      const until = horizon.toISOString().slice(0, 10);
      const monthStart = `${today.slice(0, 7)}-01`;

      // Same rules as GET /dashboard/summary, so the assistant quotes the numbers on screen:
      // open deadlines one per filing (openDeadlines), completion dated in Manila time.
      const open = await openDeadlines(cid != null ? eq(deadlinesTable.clientId, cid) : undefined);
      const eng = await db.select().from(engagementsTable).where(cid != null ? eq(engagementsTable.clientId, cid) : undefined);

      return {
        today,
        overdueDeadlines: open.filter((d) => d.dueDate < today).length,
        dueSoon: { until, count: open.filter((d) => d.dueDate >= today && d.dueDate <= until).length },
        filingsInProgress: eng.filter((e) => e.status === "in_progress").length,
        stagesAwaitingReview: eng.reduce(
          (n, e) => n + [e.sourceCollectionStatus, e.draftReturnStatus, e.confirmationStatus, e.paymentStatus].filter((s) => s === "for_review").length,
          0,
        ),
        filingsCompletedThisMonth: eng.filter((e) => {
          if (e.status !== "completed") return false;
          const completedOn = manilaToday(e.approvedAt ?? e.updatedAt);
          return completedOn >= monthStart && completedOn <= today;
        }).length,
        myOpenFilings: isClientUser(user) ? undefined : eng.filter((e) => e.assignedTo === user.id && e.status !== "completed").length,
      };
    },
  }),

  // ── Write tools (MCP connector only) ────────────────────────────────────────
  // Small, reversible edits. Approving / returning / recalling stages, deleting,
  // files and account administration are deliberately not offered.

  defineTool({
    name: "add_filing_comment",
    title: "Add a comment to a filing",
    access: "write",
    destructive: false,
    idempotent: false,
    label: "Adding a comment",
    description:
      "Add a note to a filing's (engagement's) comment thread, shown to the firm's staff and to the client on the filing page. " +
      "It is posted under the connected user's name. It cannot approve or return a stage. Confirm the text with the user first.",
    input: z.object({
      engagement_id: id(),
      content: z.string().min(1).max(5000).describe("The comment text (plain text, up to 5000 characters)."),
    }),
    run: async ({ engagement_id, content }, user, via) => {
      const c = await createComment(user, { engagementId: engagement_id, content }, via);
      return { comment: { id: c.id, engagementId: c.engagementId, content: c.content, author: user.name, createdAt: c.createdAt.toISOString() } };
    },
  }),

  defineTool({
    name: "set_deadline_notes",
    title: "Set a deadline's notes",
    access: "write",
    destructive: true,
    idempotent: true,
    label: "Updating deadline notes",
    description:
      "Replace the notes (description) of one saved deadline. The previous notes are overwritten, so read them first with list_deadlines " +
      "or include them if the user wants to add to them. Pass null to clear the notes. Does not change the due date or status.",
    input: z.object({
      deadline_id: id(),
      notes: z.string().max(5000).nullable().describe("New notes (up to 5000 characters), or null to clear them."),
    }),
    run: async ({ deadline_id, notes }, user, via) => {
      const d = await updateDeadline(user, deadline_id, { description: notes }, via);
      return { deadline: { id: d.id, title: d.title, dueDate: d.dueDate, status: d.status, notes: d.description ?? null } };
    },
  }),

  defineTool({
    name: "update_checklist_item",
    title: "Update a checklist item",
    access: "write",
    destructive: true,
    idempotent: true,
    label: "Updating the checklist",
    description:
      "Set the status and/or the notes of one item on a filing's checklist (the ids come from get_filing's checklist). " +
      "status: pending | received | filed | paid | not_applicable; any status other than pending records the connected user as completing it. " +
      "notes replaces the previous notes (null clears them).",
    input: z
      .object({
        item_id: id(),
        status: z.enum(["pending", "received", "filed", "paid", "not_applicable"]).optional(),
        notes: z.string().max(5000).nullable().optional(),
      })
      .refine((v) => v.status !== undefined || v.notes !== undefined, { message: "Give a status, notes, or both." }),
    run: async ({ item_id, status, notes }, user, via) => {
      const patch: { status?: typeof status; notes?: string | null } = {};
      if (status !== undefined) patch.status = status;
      if (notes !== undefined) patch.notes = notes;
      const i = await updateChecklistItem(user, item_id, patch, via);
      return { checklistItem: { id: i.id, engagementId: i.engagementId, label: i.label, status: i.status, notes: i.notes ?? null } };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export type ToolSpec = (typeof TOOLS)[number];

/** Whether `user`'s role may use the write tools at all (they all wrap staff-only routes). */
export function canUseWriteTools(user: Pick<Actor, "role">): boolean {
  return isStaffRole(user.role);
}

/** The tools `user` may call: the read tools, plus the write tools when `allowWrite` and the role permits. */
export function toolsFor(user: AssistantUser, opts: { allowWrite: boolean }): ToolSpec[] {
  const write = opts.allowWrite && canUseWriteTools(user);
  return TOOLS.filter((t) => t.access === "read" || write);
}

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.filter((t) => t.access === "write").map((t) => t.name));

const READ_TOOLS = TOOLS.filter((t) => t.access === "read");

/** Read tool definitions for the Messages API (stable order, so the prompt cache holds). The in-app assistant never writes. */
export const assistantTools: Anthropic.Beta.Messages.BetaTool[] = READ_TOOLS.map((t) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.description,
    input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
});

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.label ?? name;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; message: string };

/**
 * Validates and runs one tool call for `user`. Rule violations (scope, not found,
 * permission, bad input) come back as { ok: false }; unexpected errors throw.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  user: AssistantUser,
  opts: { allowWrite: boolean; via?: WriteChannel },
): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool || !toolsFor(user, opts).includes(tool)) return { ok: false, message: `Unknown tool "${name}".` };
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, message: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}` };
  try {
    const result = await (tool.run as (i: unknown, u: AssistantUser, v?: WriteChannel) => Promise<unknown>)(parsed.data, user, opts.via);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, message: err.message };
    // Out-of-scope or missing records answer 404 / 400 in the routes; never reveal which.
    if (err instanceof ServiceError) return { ok: false, message: err.status === 403 ? "You do not have permission to do that." : err.message };
    throw err;
  }
}

/** The in-app assistant's entry point (read tools only). Never throws for rule violations: they come back as an is_error result. */
export async function runTool(
  name: string,
  rawInput: unknown,
  user: AssistantUser,
): Promise<{ content: string; isError: boolean }> {
  // With eager input streaming the API does not validate tool input; executeTool does.
  const r = await executeTool(name, rawInput, user, { allowWrite: false });
  return r.ok ? { content: JSON.stringify(r.result), isError: false } : { content: r.message, isError: true };
}
