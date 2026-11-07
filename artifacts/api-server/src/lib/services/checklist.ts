import { eq } from "drizzle-orm";
import { db, checklistItemsTable } from "@workspace/db";
import type { UpdateChecklistItemBody } from "@workspace/api-zod";
import type { z } from "zod";
import type { Actor } from "../../middlewares/auth";
import { logAudit } from "../audit";
import { ServiceError, assertStaff, auditVia, type WriteChannel } from "./common";

type ChecklistRow = typeof checklistItemsTable.$inferSelect;

/** PATCH /checklist-items/:id. Returns the item unchanged when the patch changes nothing. */
export async function updateChecklistItem(
  actor: Actor,
  id: number,
  patch: z.infer<typeof UpdateChecklistItemBody>,
  via?: WriteChannel,
): Promise<ChecklistRow> {
  assertStaff(actor);
  const updates: Partial<typeof checklistItemsTable.$inferInsert> = {};
  if (patch.label != null) updates.label = patch.label;
  if (patch.status != null) {
    updates.status = patch.status;
    if (patch.status !== "pending") {
      updates.completedAt = new Date();
      updates.completedBy = actor.id;
    } else {
      updates.completedAt = null;
      updates.completedBy = null;
    }
  }
  if ("notes" in patch) updates.notes = patch.notes ?? null;
  if (patch.sortOrder != null) updates.sortOrder = patch.sortOrder;

  if (Object.keys(updates).length === 0) {
    const [current] = await db.select().from(checklistItemsTable).where(eq(checklistItemsTable.id, id));
    if (!current) throw new ServiceError(404, "Checklist item not found");
    return current;
  }

  const [item] = await db.update(checklistItemsTable).set(updates).where(eq(checklistItemsTable.id, id)).returning();
  if (!item) throw new ServiceError(404, "Checklist item not found");

  const v = auditVia(via);
  await logAudit({
    userId: actor.id,
    action: "update",
    entityType: "checklist_item",
    entityId: item.id,
    description: `Updated checklist item "${item.label}" to ${item.status}${v.suffix}`,
    metadata: v.metadata,
  });
  return item;
}
