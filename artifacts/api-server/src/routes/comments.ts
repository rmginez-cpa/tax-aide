import { Router } from "express";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db, commentsTable, engagementsTable, usersTable } from "@workspace/db";
import {
  CreateCommentBody,
  UpdateCommentBody,
  UpdateCommentParams,
  DeleteCommentParams,
  ListCommentsQueryParams,
} from "@workspace/api-zod";
import type { Request, Response } from "express";
import { requireAuth, requireStaff, clientScope } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

type CommentRow = typeof commentsTable.$inferSelect;
type Author = { name: string; role: string };

/** Loads comment authors for a set of user ids in one query. */
async function loadAuthors(userIds: number[]): Promise<Map<number, Author>> {
  const ids = [...new Set(userIds)];
  const authors = new Map<number, Author>();
  if (ids.length === 0) return authors;
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name, role: usersTable.role })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  for (const row of rows) authors.set(row.id, { name: row.name, role: row.role });
  return authors;
}

function toJson(c: CommentRow, authors: Map<number, Author>) {
  const author = authors.get(c.authorId);
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

async function serializeComment(c: CommentRow) {
  return toJson(c, await loadAuthors([c.authorId]));
}

router.get("/comments", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListCommentsQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];

  if (queryParams.success && queryParams.data.engagementId != null) {
    conditions.push(eq(commentsTable.engagementId, queryParams.data.engagementId));
  }

  // Client accounts only see comments on their own client's engagements (0 => nothing).
  const scope = clientScope(req);
  if (scope !== null) {
    conditions.push(
      inArray(
        commentsTable.engagementId,
        db.select({ id: engagementsTable.id }).from(engagementsTable).where(eq(engagementsTable.clientId, scope)),
      ),
    );
  }

  const comments = await db
    .select()
    .from(commentsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(commentsTable.createdAt);

  const authors = await loadAuthors(comments.map((c) => c.authorId));
  res.json(comments.map((c) => toJson(c, authors)));
});

router.post("/comments", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateCommentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!parsed.data.content.trim()) {
    res.status(400).json({ error: "Comment cannot be empty" });
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

  // Approval comments are written only by the approve-stage workflow, never from the body.
  const [comment] = await db.insert(commentsTable).values({
    engagementId: parsed.data.engagementId,
    content: parsed.data.content,
    isApproval: false,
    authorId: req.session.userId!,
  }).returning();

  await logAudit({
    userId: req.session.userId,
    action: "comment",
    entityType: "engagement",
    entityId: comment.engagementId,
    description: "Added comment on engagement",
  });

  res.status(201).json(await serializeComment(comment));
});

/**
 * Loads a comment and checks the caller may change it: authors may change their own,
 * super_admin may change any non-approval comment, approval comments are immutable.
 * Sends the error response and returns null when not allowed.
 */
async function loadEditableComment(req: Request, res: Response, id: number): Promise<CommentRow | null> {
  const [comment] = await db.select().from(commentsTable).where(eq(commentsTable.id, id));
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return null;
  }
  if (comment.isApproval) {
    res.status(403).json({ error: "Approval comments cannot be changed" });
    return null;
  }
  const isAuthor = comment.authorId === req.session.userId;
  if (!isAuthor && req.session.userRole !== "super_admin") {
    res.status(403).json({ error: "You can only change your own comments" });
    return null;
  }
  return comment;
}

router.patch("/comments/:id", requireStaff, async (req, res): Promise<void> => {
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

  const existing = await loadEditableComment(req, res, params.data.id);
  if (!existing) return;

  if (parsed.data.content == null) {
    res.json(await serializeComment(existing));
    return;
  }
  if (!parsed.data.content.trim()) {
    res.status(400).json({ error: "Comment cannot be empty" });
    return;
  }

  // Re-check isApproval in the WHERE so the guard holds even under concurrent writes.
  const [comment] = await db
    .update(commentsTable)
    .set({ content: parsed.data.content })
    .where(and(eq(commentsTable.id, params.data.id), eq(commentsTable.isApproval, false)))
    .returning();

  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "comment",
    entityId: comment.id,
    description: `Edited comment on engagement #${comment.engagementId}`,
  });

  res.json(await serializeComment(comment));
});

router.delete("/comments/:id", requireStaff, async (req, res): Promise<void> => {
  const params = DeleteCommentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const existing = await loadEditableComment(req, res, params.data.id);
  if (!existing) return;

  const [comment] = await db
    .delete(commentsTable)
    .where(and(eq(commentsTable.id, params.data.id), eq(commentsTable.isApproval, false)))
    .returning();
  if (!comment) {
    res.status(404).json({ error: "Comment not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "comment",
    entityId: comment.id,
    description: `Deleted comment on engagement #${comment.engagementId}`,
  });

  res.sendStatus(204);
});

export default router;
