import { eq } from "drizzle-orm";
import { db, commentsTable, engagementsTable } from "@workspace/db";
import type { Actor } from "../../middlewares/auth";
import { logAudit } from "../audit";
import { ServiceError, assertStaff, auditVia, type WriteChannel } from "./common";

/** POST /comments: a staff note on a filing (never an approval comment). */
export async function createComment(
  actor: Actor,
  input: { engagementId: number; content: string },
  via?: WriteChannel,
): Promise<typeof commentsTable.$inferSelect> {
  assertStaff(actor);
  if (!input.content.trim()) throw new ServiceError(400, "Comment cannot be empty");

  const [engagement] = await db
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(eq(engagementsTable.id, input.engagementId));
  if (!engagement) throw new ServiceError(400, "Engagement not found");

  // Approval comments are written only by the approve-stage workflow, never from the body.
  const [comment] = await db
    .insert(commentsTable)
    .values({ engagementId: input.engagementId, content: input.content, isApproval: false, authorId: actor.id })
    .returning();

  const v = auditVia(via);
  await logAudit({
    userId: actor.id,
    action: "comment",
    entityType: "engagement",
    entityId: comment.engagementId,
    description: `Added comment on engagement${v.suffix}`,
    metadata: v.metadata,
  });
  return comment;
}
