import { eq } from "drizzle-orm";
import { db, deadlinesTable, engagementsTable } from "@workspace/db";
import type { UpdateDeadlineBody } from "@workspace/api-zod";
import type { z } from "zod";
import type { Actor } from "../../middlewares/auth";
import { logAudit } from "../audit";
import { ServiceError, assertStaff, auditVia, type WriteChannel } from "./common";

type DeadlineRow = typeof deadlinesTable.$inferSelect;

/** PATCH /deadlines/:id. Returns the deadline unchanged when the patch changes nothing. */
export async function updateDeadline(
  actor: Actor,
  id: number,
  patch: z.infer<typeof UpdateDeadlineBody>,
  via?: WriteChannel,
): Promise<DeadlineRow> {
  assertStaff(actor);
  const [current] = await db.select().from(deadlinesTable).where(eq(deadlinesTable.id, id));
  if (!current) throw new ServiceError(404, "Deadline not found");

  // The generated enums include a literal "null"; it is not a real status/priority.
  const status = patch.status != null && patch.status !== "null" ? patch.status : null;
  const priority = patch.priority != null && patch.priority !== "null" ? patch.priority : null;

  // A deadline linked to an engagement takes its status from the filing workflow.
  if (status != null && status !== current.status && current.engagementId != null) {
    throw new ServiceError(400, "This deadline is linked to a filing; its status is set by the filing workflow");
  }

  const updates: Partial<typeof deadlinesTable.$inferInsert> = {};
  if (patch.title != null) updates.title = patch.title;
  if ("description" in patch) updates.description = patch.description ?? null;
  const dueDateChanged = patch.dueDate != null && patch.dueDate !== current.dueDate;
  if (dueDateChanged) {
    updates.dueDate = patch.dueDate!;
    // Edited by hand (e.g. a BIR extension): regenerating with overwrite keeps it.
    updates.dueDateManual = true;
  }
  if (status != null) updates.status = status;
  if (priority != null) updates.priority = priority;

  if (Object.keys(updates).length === 0) return current;

  const deadline = await db.transaction(async (tx) => {
    const [row] = await tx.update(deadlinesTable).set(updates).where(eq(deadlinesTable.id, id)).returning();
    // The filing started from this deadline keeps the same due date.
    if (row && dueDateChanged && row.engagementId != null) {
      await tx.update(engagementsTable).set({ dueDate: row.dueDate }).where(eq(engagementsTable.id, row.engagementId));
    }
    return row;
  });
  if (!deadline) throw new ServiceError(404, "Deadline not found");

  const v = auditVia(via);
  await logAudit({
    userId: actor.id,
    action: "update",
    entityType: "deadline",
    entityId: deadline.id,
    description: `Updated deadline "${deadline.title}"${v.suffix}`,
    metadata: v.metadata,
  });
  return deadline;
}
