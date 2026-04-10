import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, engagementsTable, usersTable, clientsTable, notificationsTable } from "@workspace/db";
import {
  CreateEngagementBody,
  UpdateEngagementBody,
  GetEngagementParams,
  UpdateEngagementParams,
  DeleteEngagementParams,
  ApproveEngagementParams,
  ApproveEngagementBody,
  ListEngagementsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

async function serializeEngagement(e: typeof engagementsTable.$inferSelect) {
  let clientName: string | null = null;
  let assignedToName: string | null = null;
  let approvedByName: string | null = null;

  if (e.clientId) {
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, e.clientId));
    clientName = client?.name ?? null;
  }
  if (e.assignedTo) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, e.assignedTo));
    assignedToName = user?.name ?? null;
  }
  if (e.approvedBy) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, e.approvedBy));
    approvedByName = user?.name ?? null;
  }

  return {
    id: e.id,
    clientId: e.clientId,
    clientName,
    title: e.title,
    taxType: e.taxType,
    period: e.period,
    fiscalYear: e.fiscalYear ?? null,
    status: e.status,
    assignedTo: e.assignedTo ?? null,
    assignedToName,
    approvedBy: e.approvedBy ?? null,
    approvedByName,
    approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
    approvalNotes: e.approvalNotes ?? null,
    dueDate: e.dueDate ?? null,
    notes: e.notes ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

router.get("/engagements", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListEngagementsQueryParams.safeParse(req.query);
  let engagements = await db.select().from(engagementsTable).orderBy(engagementsTable.createdAt);

  if (queryParams.success && queryParams.data.clientId != null) {
    engagements = engagements.filter((e) => e.clientId === queryParams.data.clientId);
  }
  if (queryParams.success && queryParams.data.status != null) {
    engagements = engagements.filter((e) => e.status === queryParams.data.status);
  }

  const serialized = await Promise.all(engagements.map(serializeEngagement));
  res.json(serialized);
});

router.post("/engagements", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [engagement] = await db.insert(engagementsTable).values(parsed.data).returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "engagement",
    entityId: engagement.id,
    description: `Created engagement "${engagement.title}" (${engagement.taxType})`,
  });

  res.status(201).json(await serializeEngagement(engagement));
});

router.get("/engagements/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, params.data.id));
  if (!engagement) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  res.json(await serializeEngagement(engagement));
});

router.patch("/engagements/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof engagementsTable.$inferInsert> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if (parsed.data.taxType != null) updates.taxType = parsed.data.taxType;
  if (parsed.data.period != null) updates.period = parsed.data.period;
  if ("fiscalYear" in parsed.data) updates.fiscalYear = parsed.data.fiscalYear ?? null;
  if (parsed.data.status != null) updates.status = parsed.data.status;
  if ("assignedTo" in parsed.data) updates.assignedTo = parsed.data.assignedTo ?? null;
  if ("dueDate" in parsed.data) updates.dueDate = parsed.data.dueDate ?? null;
  if ("notes" in parsed.data) updates.notes = parsed.data.notes ?? null;

  const [engagement] = await db
    .update(engagementsTable)
    .set(updates)
    .where(eq(engagementsTable.id, params.data.id))
    .returning();

  if (!engagement) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: engagement.id,
    description: `Updated engagement "${engagement.title}" status to ${engagement.status}`,
  });

  res.json(await serializeEngagement(engagement));
});

router.delete("/engagements/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [engagement] = await db
    .delete(engagementsTable)
    .where(eq(engagementsTable.id, params.data.id))
    .returning();

  if (!engagement) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "engagement",
    entityId: params.data.id,
    description: `Deleted engagement "${engagement.title}"`,
  });

  res.sendStatus(204);
});

router.post("/engagements/:id/approve", requireAuth, async (req, res): Promise<void> => {
  const params = ApproveEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = ApproveEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const newStatus = parsed.data.approved ? "approved" : "for_review";
  const [engagement] = await db
    .update(engagementsTable)
    .set({
      status: newStatus,
      approvedBy: parsed.data.approved ? req.session.userId : null,
      approvedAt: parsed.data.approved ? new Date() : null,
      approvalNotes: parsed.data.notes ?? null,
    })
    .where(eq(engagementsTable.id, params.data.id))
    .returning();

  if (!engagement) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: parsed.data.approved ? "Engagement Approved" : "Engagement Returned for Review",
      message: `"${engagement.title}" has been ${parsed.data.approved ? "approved" : "returned for review"}.${parsed.data.notes ? ` Notes: ${parsed.data.notes}` : ""}`,
      type: "engagement_approved",
      relatedId: engagement.id,
      relatedType: "engagement",
    });
  }

  await logAudit({
    userId: req.session.userId,
    action: parsed.data.approved ? "approve" : "reject",
    entityType: "engagement",
    entityId: engagement.id,
    description: `${parsed.data.approved ? "Approved" : "Rejected"} engagement "${engagement.title}"`,
  });

  res.json(await serializeEngagement(engagement));
});

export default router;
