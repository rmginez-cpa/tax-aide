import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, commentsTable, usersTable } from "@workspace/db";
import {
  CreateCommentBody,
  UpdateCommentBody,
  UpdateCommentParams,
  DeleteCommentParams,
  ListCommentsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

async function serializeComment(c: typeof commentsTable.$inferSelect) {
  const [author] = await db.select().from(usersTable).where(eq(usersTable.id, c.authorId));

  return {
    id: c.id,
    engagementId: c.engagementId,
    content: c.content,
    isApproval: c.isApproval,
    authorId: c.authorId,
    authorName: author?.name ?? null,
    authorRole: author?.role ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

router.get("/comments", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListCommentsQueryParams.safeParse(req.query);
  let comments = await db.select().from(commentsTable).orderBy(commentsTable.createdAt);

  if (queryParams.success && queryParams.data.engagementId != null) {
    comments = comments.filter((c) => c.engagementId === queryParams.data.engagementId);
  }

  const serialized = await Promise.all(comments.map(serializeComment));
  res.json(serialized);
});

router.post("/comments", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [comment] = await db.insert(commentsTable).values({
    ...parsed.data,
    isApproval: parsed.data.isApproval ?? false,
    authorId: req.session.userId!,
  }).returning();

  await logAudit({
    userId: req.session.userId,
    action: "comment",
    entityType: "engagement",
    entityId: comment.engagementId,
    description: `Added ${comment.isApproval ? "approval " : ""}comment on engagement`,
  });

  res.status(201).json(await serializeComment(comment));
});

router.patch("/comments/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateCommentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof commentsTable.$inferInsert> = {};
  if (parsed.data.content != null) updates.content = parsed.data.content;

  const [comment] = await db
    .update(commentsTable)
    .set(updates)
    .where(eq(commentsTable.id, params.data.id))
    .returning();

  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }

  res.json(await serializeComment(comment));
});

router.delete("/comments/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteCommentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [comment] = await db.delete(commentsTable).where(eq(commentsTable.id, params.data.id)).returning();
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
