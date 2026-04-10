import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, checklistItemsTable, usersTable } from "@workspace/db";
import {
  CreateChecklistItemBody,
  UpdateChecklistItemBody,
  UpdateChecklistItemParams,
  DeleteChecklistItemParams,
  ListChecklistItemsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

async function serializeItem(item: typeof checklistItemsTable.$inferSelect) {
  let completedByName: string | null = null;
  if (item.completedBy) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, item.completedBy));
    completedByName = user?.name ?? null;
  }

  return {
    id: item.id,
    engagementId: item.engagementId,
    label: item.label,
    status: item.status,
    notes: item.notes ?? null,
    completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    completedBy: item.completedBy ?? null,
    completedByName,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

router.get("/checklist-items", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListChecklistItemsQueryParams.safeParse(req.query);
  let items = await db.select().from(checklistItemsTable).orderBy(checklistItemsTable.sortOrder);

  if (queryParams.success && queryParams.data.engagementId != null) {
    items = items.filter((i) => i.engagementId === queryParams.data.engagementId);
  }

  const serialized = await Promise.all(items.map(serializeItem));
  res.json(serialized);
});

router.post("/checklist-items", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateChecklistItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [item] = await db.insert(checklistItemsTable).values({
    ...parsed.data,
    sortOrder: parsed.data.sortOrder ?? 0,
  }).returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "checklist_item",
    entityId: item.id,
    description: `Added checklist item "${item.label}"`,
  });

  res.status(201).json(await serializeItem(item));
});

router.patch("/checklist-items/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateChecklistItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateChecklistItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof checklistItemsTable.$inferInsert> = {};
  if (parsed.data.label != null) updates.label = parsed.data.label;
  if (parsed.data.status != null) {
    updates.status = parsed.data.status;
    if (parsed.data.status !== "pending") {
      updates.completedAt = new Date();
      updates.completedBy = req.session.userId;
    } else {
      updates.completedAt = null;
      updates.completedBy = null;
    }
  }
  if ("notes" in parsed.data) updates.notes = parsed.data.notes ?? null;
  if (parsed.data.sortOrder != null) updates.sortOrder = parsed.data.sortOrder;

  const [item] = await db
    .update(checklistItemsTable)
    .set(updates)
    .where(eq(checklistItemsTable.id, params.data.id))
    .returning();

  if (!item) {
    res.status(404).json({ error: "Checklist item not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "checklist_item",
    entityId: item.id,
    description: `Updated checklist item "${item.label}" to ${item.status}`,
  });

  res.json(await serializeItem(item));
});

router.delete("/checklist-items/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteChecklistItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db.delete(checklistItemsTable).where(eq(checklistItemsTable.id, params.data.id)).returning();
  if (!item) {
    res.status(404).json({ error: "Checklist item not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "checklist_item",
    entityId: params.data.id,
    description: `Deleted checklist item "${item.label}"`,
  });

  res.sendStatus(204);
});

export default router;
