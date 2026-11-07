import { Router } from "express";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db, deadlinesTable, clientsTable, engagementsTable } from "@workspace/db";
import {
  CreateDeadlineBody,
  UpdateDeadlineBody,
  GetDeadlineParams,
  UpdateDeadlineParams,
  DeleteDeadlineParams,
  ListDeadlinesQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, requireManager, clientScope, canAccessClient } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { extractFormNumber, extractPeriod, taxTypeFromDeadlineTitle } from "../lib/filingLabels";

const router = Router();

type DeadlineRow = typeof deadlinesTable.$inferSelect;

/** Loads client names for a set of client ids in one query. */
async function loadClientNames(clientIds: Array<number | null>): Promise<Map<number, string>> {
  const ids = [...new Set(clientIds.filter((id): id is number => id != null))];
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const rows = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(inArray(clientsTable.id, ids));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

function toJson(d: DeadlineRow, clientNames: Map<number, string>) {
  return {
    id: d.id,
    engagementId: d.engagementId ?? null,
    clientId: d.clientId ?? null,
    clientName: d.clientId != null ? clientNames.get(d.clientId) ?? null : null,
    title: d.title,
    // Same labels as the compliance checklist, so every page shows one form code / period.
    formNumber: extractFormNumber(d.title),
    period: extractPeriod(d.title),
    description: d.description ?? null,
    dueDate: d.dueDate,
    status: d.status,
    priority: d.priority,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function serializeDeadline(d: DeadlineRow) {
  return toJson(d, await loadClientNames([d.clientId]));
}

/**
 * The filing period a deadline covers, labelled like the compliance checklist
 * (extractPeriod: "Q1 2026", "FY 2026", "Annual 2026", "2nd Semester 2025").
 * For a hand-made title with no period: the text after the last " — ", then the tax year.
 */
function periodFromDeadline(d: Pick<DeadlineRow, "title" | "taxYear">): string {
  const period = extractPeriod(d.title);
  if (period !== d.title) return period;
  const dash = d.title.lastIndexOf(" — ");
  if (dash >= 0) {
    const tail = d.title.slice(dash + 3).trim();
    if (tail) return tail;
  }
  return d.taxYear != null ? String(d.taxYear) : "";
}

router.get("/deadlines", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListDeadlinesQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];

  if (queryParams.success && queryParams.data.engagementId != null) {
    conditions.push(eq(deadlinesTable.engagementId, queryParams.data.engagementId));
  }
  if (queryParams.success && queryParams.data.clientId != null) {
    conditions.push(eq(deadlinesTable.clientId, queryParams.data.clientId));
  }

  // Client accounts only ever see their own client's deadlines (0 => nothing).
  const scope = clientScope(req);
  if (scope !== null) {
    conditions.push(eq(deadlinesTable.clientId, scope));
  }

  const deadlines = await db
    .select()
    .from(deadlinesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(deadlinesTable.dueDate);

  const clientNames = await loadClientNames(deadlines.map((d) => d.clientId));
  res.json(deadlines.map((d) => toJson(d, clientNames)));
});

router.post("/deadlines", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateDeadlineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let clientId = parsed.data.clientId ?? null;
  const engagementId = parsed.data.engagementId ?? null;

  if (engagementId != null) {
    const [engagement] = await db
      .select({ id: engagementsTable.id, clientId: engagementsTable.clientId })
      .from(engagementsTable)
      .where(eq(engagementsTable.id, engagementId));
    if (!engagement) {
      res.status(400).json({ error: "Engagement not found" });
      return;
    }
    if (clientId != null && clientId !== engagement.clientId) {
      res.status(400).json({ error: "clientId does not match the engagement's client" });
      return;
    }
    clientId = engagement.clientId;
  }

  if (clientId != null) {
    const [client] = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));
    if (!client) {
      res.status(400).json({ error: "Client not found" });
      return;
    }
  }

  const [deadline] = await db
    .insert(deadlinesTable)
    .values({ ...parsed.data, clientId, engagementId })
    .returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "deadline",
    entityId: deadline.id,
    description: `Created deadline "${deadline.title}" due ${deadline.dueDate}`,
  });

  res.status(201).json(await serializeDeadline(deadline));
});

router.get("/deadlines/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetDeadlineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deadline] = await db.select().from(deadlinesTable).where(eq(deadlinesTable.id, params.data.id));
  // Outside the caller's scope reads as "not found" so existence is not leaked.
  if (!deadline || !canAccessClient(req, deadline.clientId)) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }

  res.json(await serializeDeadline(deadline));
});

router.patch("/deadlines/:id", requireStaff, async (req, res): Promise<void> => {
  const params = UpdateDeadlineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDeadlineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [current] = await db.select().from(deadlinesTable).where(eq(deadlinesTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }

  // The generated enums include a literal "null"; it is not a real status/priority.
  const status = parsed.data.status != null && parsed.data.status !== "null" ? parsed.data.status : null;
  const priority = parsed.data.priority != null && parsed.data.priority !== "null" ? parsed.data.priority : null;

  // A deadline linked to an engagement takes its status from the filing workflow.
  if (status != null && status !== current.status && current.engagementId != null) {
    res.status(400).json({
      error: "This deadline is linked to a filing; its status is set by the filing workflow",
    });
    return;
  }

  const updates: Partial<typeof deadlinesTable.$inferInsert> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if ("description" in parsed.data) updates.description = parsed.data.description ?? null;
  const dueDateChanged = parsed.data.dueDate != null && parsed.data.dueDate !== current.dueDate;
  if (dueDateChanged) {
    updates.dueDate = parsed.data.dueDate!;
    // Edited by hand (e.g. a BIR extension): regenerating with overwrite keeps it.
    updates.dueDateManual = true;
  }
  if (status != null) updates.status = status;
  if (priority != null) updates.priority = priority;

  if (Object.keys(updates).length === 0) {
    res.json(await serializeDeadline(current));
    return;
  }

  const deadline = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(deadlinesTable)
      .set(updates)
      .where(eq(deadlinesTable.id, params.data.id))
      .returning();
    // The filing started from this deadline keeps the same due date.
    if (row && dueDateChanged && row.engagementId != null) {
      await tx.update(engagementsTable).set({ dueDate: row.dueDate }).where(eq(engagementsTable.id, row.engagementId));
    }
    return row;
  });

  if (!deadline) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "deadline",
    entityId: deadline.id,
    description: `Updated deadline "${deadline.title}"`,
  });

  res.json(await serializeDeadline(deadline));
});

router.delete("/deadlines/:id", requireManager, async (req, res): Promise<void> => {
  const params = DeleteDeadlineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deadline] = await db.delete(deadlinesTable).where(eq(deadlinesTable.id, params.data.id)).returning();
  if (!deadline) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "deadline",
    entityId: params.data.id,
    description: `Deleted deadline "${deadline.title}"`,
  });

  res.sendStatus(204);
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── POST /api/deadlines/:id/start-workflow ───────────────────────────────────
// Start a filing workflow for this deadline (creates an engagement).
// Idempotent and race-safe: the deadline row is locked while we decide, so two
// concurrent clicks cannot create two engagements for the same deadline.
// Responds with the raw engagement row (FilingWorkflowDialog reads `.id`):
// 201 when a new engagement was created, 200 when one already existed.
router.post("/deadlines/:id/start-workflow", requireStaff, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  let result: { engagement: typeof engagementsTable.$inferSelect; created: boolean; deadline: DeadlineRow };
  try {
    result = await db.transaction(async (tx) => {
      const [deadline] = await tx
        .select()
        .from(deadlinesTable)
        .where(eq(deadlinesTable.id, id))
        .for("update");
      if (!deadline) throw new HttpError(404, "Deadline not found");

      if (deadline.engagementId != null) {
        // Already started — return the existing engagement.
        const [existing] = await tx
          .select()
          .from(engagementsTable)
          .where(eq(engagementsTable.id, deadline.engagementId));
        if (existing) return { engagement: existing, created: false, deadline };
        // The linked engagement no longer exists; start a fresh one below.
      }

      if (deadline.clientId == null) {
        throw new HttpError(400, "This deadline is not linked to a client");
      }
      const [client] = await tx
        .select({ id: clientsTable.id })
        .from(clientsTable)
        .where(eq(clientsTable.id, deadline.clientId));
      if (!client) throw new HttpError(400, "Client not found");

      const [engagement] = await tx
        .insert(engagementsTable)
        .values({
          clientId: deadline.clientId,
          title: deadline.title,
          // The form code ("1601C"), like hand-made engagements' tax types, not the whole title.
          taxType: taxTypeFromDeadlineTitle(deadline.title),
          period: periodFromDeadline(deadline),
          status: "in_progress",
          workflowStage: "source_collection",
          assignedTo: req.session.userId!,
          dueDate: deadline.dueDate ?? null,
          notes: null,
        })
        .returning();

      await tx
        .update(deadlinesTable)
        .set({ engagementId: engagement.id })
        .where(eq(deadlinesTable.id, id));

      return { engagement, created: true, deadline };
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  const { engagement, created, deadline } = result;
  if (!created) {
    res.json(engagement);
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "engagement",
    entityId: engagement.id,
    description: `Started filing workflow for "${deadline.title}" (${engagement.period})`,
  });

  res.status(201).json(engagement);
});

export default router;
