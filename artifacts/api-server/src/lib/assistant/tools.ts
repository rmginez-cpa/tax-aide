import { z } from "zod/v4";
import { and, desc, eq, gte, ilike, inArray, lte, lt, ne, or, type SQL } from "drizzle-orm";
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
import { manilaToday } from "../dates";

// ── Who is asking ─────────────────────────────────────────────────────────────
// Every tool runs with the signed-in user's own access. Client (and legacy
// viewer) accounts only ever see their linked client; tools never write.

export interface AssistantUser {
  id: number;
  name: string;
  role: string;
  clientId: number | null;
}

export function isClientUser(u: AssistantUser): boolean {
  return u.role === "client" || u.role === "viewer";
}

export { manilaToday };

class ToolError extends Error {}

/** For client accounts, the client id they may see; otherwise the requested one. */
function scopeClientId(u: AssistantUser, requested?: number): number | undefined {
  if (!isClientUser(u)) return requested;
  if (!u.clientId) throw new ToolError("This account is not linked to a client record, so there is no data to show.");
  if (requested != null && requested !== u.clientId) {
    throw new ToolError("Not found, or you do not have access to that client.");
  }
  return u.clientId;
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
  description: string;
  /** Short present-tense label shown to the user while the tool runs. */
  label: string;
  input: S;
  run: (input: z.infer<S>, user: AssistantUser) => Promise<unknown>;
}

function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> {
  return t;
}

const id = () => z.number().int().positive();
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const TOOLS = [
  defineTool({
    name: "find_clients",
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
      if (status === "pending") conds.push(ne(deadlinesTable.status, "completed"));
      if (status === "overdue") conds.push(ne(deadlinesTable.status, "completed"), lt(deadlinesTable.dueDate, today));
      if (due_from) conds.push(gte(deadlinesTable.dueDate, due_from));
      if (due_to) conds.push(lte(deadlinesTable.dueDate, due_to));
      const max = limit ?? 50;
      const rows = await db.select().from(deadlinesTable).where(conds.length ? and(...conds) : undefined).orderBy(deadlinesTable.dueDate).limit(max + 1);
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
    label: "Reading the filing",
    description:
      "Everything about one filing (engagement): stage statuses, tax payable, assignee, approval notes, the documents uploaded to each stage, " +
      "the checklist and the latest comments (including manager approvals and return-for-revision reasons).",
    input: z.object({ engagement_id: id() }),
    run: async ({ engagement_id }, user) => {
      const [e] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, engagement_id));
      if (!e || (isClientUser(user) && e.clientId !== user.clientId)) {
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

      const dl = await db
        .select({ dueDate: deadlinesTable.dueDate, status: deadlinesTable.status })
        .from(deadlinesTable)
        .where(cid != null ? eq(deadlinesTable.clientId, cid) : undefined);
      const eng = await db.select().from(engagementsTable).where(cid != null ? eq(engagementsTable.clientId, cid) : undefined);

      const open = dl.filter((d) => d.status !== "completed");
      return {
        today,
        overdueDeadlines: open.filter((d) => d.dueDate < today).length,
        dueSoon: { until, count: open.filter((d) => d.dueDate >= today && d.dueDate <= until).length },
        filingsInProgress: eng.filter((e) => e.status === "in_progress").length,
        stagesAwaitingReview: eng.reduce(
          (n, e) => n + [e.sourceCollectionStatus, e.draftReturnStatus, e.confirmationStatus, e.paymentStatus].filter((s) => s === "for_review").length,
          0,
        ),
        filingsCompletedThisMonth: eng.filter(
          (e) => e.status === "completed" && e.approvedAt && e.approvedAt.toISOString().slice(0, 10) >= monthStart,
        ).length,
        myOpenFilings: isClientUser(user) ? undefined : eng.filter((e) => e.assignedTo === user.id && e.status !== "completed").length,
      };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool definitions for the Messages API (stable order, so the prompt cache holds). */
export const assistantTools: Anthropic.Beta.Messages.BetaTool[] = TOOLS.map((t) => {
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

/** Validate and run one tool call. Never throws: failures come back as an is_error result. */
export async function runTool(
  name: string,
  rawInput: unknown,
  user: AssistantUser,
): Promise<{ content: string; isError: boolean }> {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: `Unknown tool "${name}".`, isError: true };
  // With eager input streaming the API does not validate tool input, so do it here.
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { content: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
  }
  try {
    const result = await (tool.run as (i: unknown, u: AssistantUser) => Promise<unknown>)(parsed.data, user);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: err.message, isError: true };
    throw err;
  }
}
