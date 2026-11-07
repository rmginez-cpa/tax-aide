import { Router } from "express";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { ListAuditLogsQueryParams } from "@workspace/api-zod";
import { requireManager } from "../middlewares/auth";

const router = Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// The audit trail is for managers and super admins only.
router.get("/audit-logs", requireManager, async (req, res): Promise<void> => {
  const queryParams = ListAuditLogsQueryParams.safeParse(req.query);
  const query = queryParams.success ? queryParams.data : undefined;

  const requested = query?.limit != null ? Math.floor(Number(query.limit)) : DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

  // Filters go into the query so the limit applies to the filtered rows.
  const conditions: SQL[] = [];
  if (query?.engagementId != null) {
    conditions.push(eq(auditLogsTable.entityType, "engagement"), eq(auditLogsTable.entityId, query.engagementId));
  }
  if (query?.clientId != null) {
    conditions.push(eq(auditLogsTable.entityType, "client"), eq(auditLogsTable.entityId, query.clientId));
  }

  const logs = await db
    .select()
    .from(auditLogsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
    .limit(limit);

  const userIds = [...new Set(logs.map((l) => l.userId).filter((id): id is number => id != null))];
  const users = userIds.length
    ? await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const userNames = new Map(users.map((u) => [u.id, u.name]));

  res.json(logs.map((log) => ({
    id: log.id,
    userId: log.userId ?? null,
    userName: log.userId != null ? userNames.get(log.userId) ?? null : null,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId ?? null,
    description: log.description,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt.toISOString(),
  })));
});

export default router;
