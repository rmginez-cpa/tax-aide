import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

export async function logAudit(params: {
  userId?: number;
  action: string;
  entityType: string;
  entityId?: number;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      description: params.description,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write audit log");
  }
}
