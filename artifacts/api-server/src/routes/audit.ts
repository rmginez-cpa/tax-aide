import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { ListAuditLogsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/audit-logs", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListAuditLogsQueryParams.safeParse(req.query);
  const limit = (queryParams.success && queryParams.data.limit) ? queryParams.data.limit : 100;

  let logs = await db
    .select()
    .from(auditLogsTable)
    .orderBy(auditLogsTable.createdAt)
    .limit(limit);

  if (queryParams.success && queryParams.data.engagementId != null) {
    logs = logs.filter((l) => l.entityType === "engagement" && l.entityId === queryParams.data.engagementId);
  }
  if (queryParams.success && queryParams.data.clientId != null) {
    logs = logs.filter((l) => l.entityType === "client" && l.entityId === queryParams.data.clientId);
  }

  const serialized = await Promise.all(
    logs.map(async (log) => {
      let userName: string | null = null;
      if (log.userId) {
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, log.userId));
        userName = user?.name ?? null;
      }
      return {
        id: log.id,
        userId: log.userId ?? null,
        userName,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId ?? null,
        description: log.description,
        metadata: log.metadata ?? null,
        createdAt: log.createdAt.toISOString(),
      };
    })
  );

  res.json(serialized);
});

export default router;
