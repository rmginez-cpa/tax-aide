import { Router } from "express";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db, checklistItemsTable, engagementsTable, usersTable } from "@workspace/db";
import {
  CreateChecklistItemBody,
  UpdateChecklistItemBody,
  UpdateChecklistItemParams,
  DeleteChecklistItemParams,
  ListChecklistItemsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireStaff, clientScope, sessionActor } from "../middlewares/auth";
import { updateChecklistItem } from "../lib/services/checklist";
import { sendServiceError } from "../lib/services/http";
import { logAudit } from "../lib/audit";

const router = Router();

type ChecklistRow = typeof checklistItemsTable.$inferSelect;

/** Loads user names for a set of user ids in one query. */
async function loadUserNames(userIds: Array<number | null>): Promise<Map<number, string>> {
  const ids = [...new Set(userIds.filter((id): id is number => id != null))];
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  for (const row of rows) names.set(row.id, row.name);
  return names;
}

function toJson(item: ChecklistRow, userNames: Map<number, string>) {
  return {
    id: item.id,
    engagementId: item.engagementId,
    label: item.label,
    status: item.status,
    notes: item.notes ?? null,
    completedAt: item.completedAt ? item.completedAt.toISOString() : null,
    completedBy: item.completedBy ?? null,
    completedByName: item.completedBy != null ? userNames.get(item.completedBy) ?? null : null,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function serializeItem(item: ChecklistRow) {
  return toJson(item, await loadUserNames([item.completedBy]));
}

router.get("/checklist-items", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListChecklistItemsQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];

  if (queryParams.success && queryParams.data.engagementId != null) {
    conditions.push(eq(checklistItemsTable.engagementId, queryParams.data.engagementId));
  }

  // Client accounts only see items on their own client's engagements (0 => nothing).
  const scope = clientScope(req);
  if (scope !== null) {
    conditions.push(
      inArray(
        checklistItemsTable.engagementId,
        db.select({ id: engagementsTable.id }).from(engagementsTable).where(eq(engagementsTable.clientId, scope)),
      ),
    );
  }

  const items = await db
    .select()
    .from(checklistItemsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(checklistItemsTable.sortOrder);

  const userNames = await loadUserNames(items.map((i) => i.completedBy));
  res.json(items.map((i) => toJson(i, userNames)));
});

router.post("/checklist-items", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateChecklistItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [engagement] = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, parsed.data.engagementId));
  if (!engagement) {
    res.status(400).json({ error: "Engagement not found" });
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

router.patch("/checklist-items/:id", requireStaff, async (req, res): Promise<void> => {
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

  try {
    const item = await updateChecklistItem(sessionActor(req), params.data.id, parsed.data);
    res.json(await serializeItem(item));
  } catch (err) {
    if (sendServiceError(res, err)) return;
    throw err;
  }
});

router.delete("/checklist-items/:id", requireStaff, async (req, res): Promise<void> => {
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
