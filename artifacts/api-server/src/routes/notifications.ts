import { Router } from "express";
import { eq, and, count, desc } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { MarkNotificationReadParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router = Router();

function serializeNotification(n: typeof notificationsTable.$inferSelect) {
  return {
    id: n.id,
    userId: n.userId,
    title: n.title,
    message: n.message,
    type: n.type,
    relatedId: n.relatedId ?? null,
    relatedType: n.relatedType ?? null,
    isRead: n.isRead,
    createdAt: n.createdAt.toISOString(),
  };
}

// Newest first (ties broken by id, so same-instant rows keep a stable order).
router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, req.session.userId!))
    .orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id));

  res.json(notifications.map(serializeNotification));
});

// Unread badge in the navigation (polled every minute): the signed-in user's own count only.
router.get("/notifications/unread-count", requireAuth, async (req, res): Promise<void> => {
  const [row] = await db
    .select({ count: count() })
    .from(notificationsTable)
    .where(and(eq(notificationsTable.userId, req.session.userId!), eq(notificationsTable.isRead, false)));
  res.json({ count: Number(row?.count ?? 0) });
});

router.post("/notifications/:id/read", requireAuth, async (req, res): Promise<void> => {
  const params = MarkNotificationReadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [notification] = await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(
      and(
        eq(notificationsTable.id, params.data.id),
        eq(notificationsTable.userId, req.session.userId!)
      )
    )
    .returning();

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json(serializeNotification(notification));
});

router.post("/notifications/read-all", requireAuth, async (req, res): Promise<void> => {
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.userId, req.session.userId!));

  res.json({ message: "All notifications marked as read" });
});

export default router;
