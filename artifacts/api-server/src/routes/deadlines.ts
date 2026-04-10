import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, deadlinesTable, clientsTable } from "@workspace/db";
import {
  CreateDeadlineBody,
  UpdateDeadlineBody,
  GetDeadlineParams,
  UpdateDeadlineParams,
  DeleteDeadlineParams,
  ListDeadlinesQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

async function serializeDeadline(d: typeof deadlinesTable.$inferSelect) {
  let clientName: string | null = null;
  if (d.clientId) {
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, d.clientId));
    clientName = client?.name ?? null;
  }

  return {
    id: d.id,
    engagementId: d.engagementId ?? null,
    clientId: d.clientId ?? null,
    clientName,
    title: d.title,
    description: d.description ?? null,
    dueDate: d.dueDate,
    status: d.status,
    priority: d.priority,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

router.get("/deadlines", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListDeadlinesQueryParams.safeParse(req.query);
  let deadlines = await db.select().from(deadlinesTable).orderBy(deadlinesTable.dueDate);

  if (queryParams.success && queryParams.data.engagementId != null) {
    deadlines = deadlines.filter((d) => d.engagementId === queryParams.data.engagementId);
  }
  if (queryParams.success && queryParams.data.clientId != null) {
    deadlines = deadlines.filter((d) => d.clientId === queryParams.data.clientId);
  }

  const serialized = await Promise.all(deadlines.map(serializeDeadline));
  res.json(serialized);
});

router.post("/deadlines", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateDeadlineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [deadline] = await db.insert(deadlinesTable).values(parsed.data).returning();

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
  if (!deadline) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }

  res.json(await serializeDeadline(deadline));
});

router.patch("/deadlines/:id", requireAuth, async (req, res): Promise<void> => {
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

  const updates: Partial<typeof deadlinesTable.$inferInsert> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if ("description" in parsed.data) updates.description = parsed.data.description ?? null;
  if (parsed.data.dueDate != null) updates.dueDate = parsed.data.dueDate;
  if (parsed.data.status != null) updates.status = parsed.data.status;
  if (parsed.data.priority != null) updates.priority = parsed.data.priority;

  const [deadline] = await db
    .update(deadlinesTable)
    .set(updates)
    .where(eq(deadlinesTable.id, params.data.id))
    .returning();

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

router.delete("/deadlines/:id", requireAuth, async (req, res): Promise<void> => {
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

export default router;
