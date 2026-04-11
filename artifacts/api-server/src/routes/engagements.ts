import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, engagementsTable, usersTable, clientsTable, notificationsTable, deadlinesTable, commentsTable } from "@workspace/db";
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
import { requireAuth, requireRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_KEYS = ["source_collection", "draft_return", "confirmation", "payment"] as const;
type StageKey = (typeof STAGE_KEYS)[number];

const STAGE_LABELS: Record<StageKey, string> = {
  source_collection: "Source Documents",
  draft_return: "Draft Tax Return",
  confirmation: "Confirmation Receipt",
  payment: "Payment Confirmation",
};

// Map stage id → column name on engagementsTable
const STAGE_STATUS_COLS: Record<StageKey, keyof typeof engagementsTable.$inferSelect> = {
  source_collection: "sourceCollectionStatus",
  draft_return: "draftReturnStatus",
  confirmation: "confirmationStatus",
  payment: "paymentStatus",
};

function isValidStage(s: string): s is StageKey {
  return (STAGE_KEYS as readonly string[]).includes(s);
}

function getStageStatuses(e: typeof engagementsTable.$inferSelect): Record<StageKey, string> {
  return {
    source_collection: e.sourceCollectionStatus,
    draft_return: e.draftReturnStatus,
    confirmation: e.confirmationStatus,
    payment: e.paymentStatus,
  };
}

function allStagesApproved(e: typeof engagementsTable.$inferSelect): boolean {
  return (
    e.sourceCollectionStatus === "approved" &&
    e.draftReturnStatus === "approved" &&
    e.confirmationStatus === "approved" &&
    e.paymentStatus === "approved"
  );
}

function stagesForReviewCount(e: typeof engagementsTable.$inferSelect): number {
  return [
    e.sourceCollectionStatus,
    e.draftReturnStatus,
    e.confirmationStatus,
    e.paymentStatus,
  ].filter(s => s === "for_review").length;
}

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

  const statuses = getStageStatuses(e);
  const forReviewCount = stagesForReviewCount(e);

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
    workflowStage: e.workflowStage ?? null,
    stageStatuses: statuses,
    stagesForReview: forReviewCount,
    isAmendment: e.isAmendment ?? false,
    amendedEngagementId: e.amendedEngagementId ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

// ── GET /api/engagements ──────────────────────────────────────────────────────
router.get("/engagements", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListEngagementsQueryParams.safeParse(req.query);
  let engagements = await db.select().from(engagementsTable).orderBy(engagementsTable.createdAt);

  if (queryParams.success && queryParams.data.clientId != null) {
    engagements = engagements.filter((e) => e.clientId === queryParams.data.clientId);
  }
  if (queryParams.success && queryParams.data.status != null) {
    engagements = engagements.filter((e) => e.status === queryParams.data.status);
  }

  // Client-role users: automatically scope to their client only
  const userRole = req.session.userRole || "";
  const userClientId = req.session.userClientId;
  if (userRole === "client" && userClientId) {
    engagements = engagements.filter((e) => e.clientId === userClientId);
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

// ── GET /api/engagements/:id/amendments ──────────────────────────────────────
router.get("/engagements/:id/amendments", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [thisEng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!thisEng) { res.status(404).json({ error: "Engagement not found" }); return; }

  const rootId = thisEng.amendedEngagementId ?? id;

  const [original] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, rootId));
  const amendments = await db.select().from(engagementsTable).where(eq(engagementsTable.amendedEngagementId, rootId));

  const all = [original, ...amendments].filter(Boolean);
  const serialized = await Promise.all(all.map(serializeEngagement));
  res.json(serialized);
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
    description: `Updated engagement "${engagement.title}"`,
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

  res.json(await serializeEngagement(engagement));
});

// ── POST /api/engagements/:id/submit-stage ───────────────────────────────────
// Accountant submits a specific stage for manager review.
// Body: { stage: "source_collection" | "draft_return" | "confirmation" | "payment" }
router.post("/engagements/:id/submit-stage", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }
  if (engagement.status === "completed") { res.status(400).json({ error: "Filing is already complete" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col] as string;

  if (currentStageStatus === "for_review") {
    res.status(400).json({ error: "Stage is already submitted for review" }); return;
  }
  if (currentStageStatus === "approved") {
    res.status(400).json({ error: "Stage is already approved" }); return;
  }

  const [updated] = await db.update(engagementsTable)
    .set({ [col]: "for_review" } as any)
    .where(eq(engagementsTable.id, id))
    .returning();

  // Notify managers
  const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager"));
  for (const mgr of managers) {
    await db.insert(notificationsTable).values({
      userId: mgr.id,
      title: `Stage Ready for Approval`,
      message: `"${engagement.title}" — ${STAGE_LABELS[stage]} stage submitted for your review.`,
      type: "engagement_approved",
      relatedId: engagement.id,
      relatedType: "engagement",
    });
  }

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `Submitted ${STAGE_LABELS[stage]} for manager review.`,
    isApproval: false,
  });

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: id,
    description: `Submitted "${STAGE_LABELS[stage]}" stage for review on "${engagement.title}"`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/approve-stage ──────────────────────────────────
// Manager approves a specific stage. When all 4 are approved → filing complete.
// Body: { stage: string, notes?: string }
router.post("/engagements/:id/approve-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col] as string;

  if (currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage "${STAGE_LABELS[stage]}" is not awaiting review (current: ${currentStageStatus})` }); return;
  }

  const notes = req.body.notes?.trim() || null;

  // Build update: set this stage to approved
  const updatePayload: Record<string, any> = { [col]: "approved" };

  // Check if all OTHER stages are also approved — if so, complete the filing
  const tempStatuses = getStageStatuses(engagement);
  tempStatuses[stage] = "approved";
  const willComplete = Object.values(tempStatuses).every(s => s === "approved");

  if (willComplete) {
    updatePayload.status = "completed";
    updatePayload.approvedBy = req.session.userId!;
    updatePayload.approvedAt = new Date();
    if (notes) updatePayload.approvalNotes = notes;
  }

  const [updated] = await db.update(engagementsTable)
    .set(updatePayload)
    .where(eq(engagementsTable.id, id))
    .returning();

  if (notes) {
    await db.insert(commentsTable).values({
      engagementId: id,
      authorId: req.session.userId!,
      content: `Approved ${STAGE_LABELS[stage]}: ${notes}`,
      isApproval: true,
    });
  } else {
    await db.insert(commentsTable).values({
      engagementId: id,
      authorId: req.session.userId!,
      content: `Approved ${STAGE_LABELS[stage]}.`,
      isApproval: true,
    });
  }

  if (willComplete) {
    // Mark linked deadline as completed
    await db.update(deadlinesTable)
      .set({ status: "completed" })
      .where(eq(deadlinesTable.engagementId, id));

    // Notify accountant
    if (engagement.assignedTo) {
      await db.insert(notificationsTable).values({
        userId: engagement.assignedTo,
        title: "Filing Complete",
        message: `All stages approved — filing for "${engagement.title}" is now complete!`,
        type: "engagement_approved",
        relatedId: engagement.id,
        relatedType: "engagement",
      });
    }

    await logAudit({
      userId: req.session.userId,
      action: "approve",
      entityType: "engagement",
      entityId: id,
      description: `Approved final stage "${STAGE_LABELS[stage]}" — filing "${engagement.title}" is now complete`,
    });
  } else {
    if (engagement.assignedTo) {
      await db.insert(notificationsTable).values({
        userId: engagement.assignedTo,
        title: "Stage Approved",
        message: `${STAGE_LABELS[stage]} was approved for "${engagement.title}". Keep working on the remaining stages.`,
        type: "engagement_approved",
        relatedId: engagement.id,
        relatedType: "engagement",
      });
    }

    await logAudit({
      userId: req.session.userId,
      action: "approve",
      entityType: "engagement",
      entityId: id,
      description: `Approved stage "${STAGE_LABELS[stage]}" on "${engagement.title}"`,
    });
  }

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/reject-stage ───────────────────────────────────
// Manager returns a specific stage for revision.
// Body: { stage: string, notes: string }
router.post("/engagements/:id/reject-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col] as string;

  if (currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage is not awaiting review` }); return;
  }

  const notes = (req.body.notes || "").trim();
  if (!notes) { res.status(400).json({ error: "Rejection reason is required" }); return; }

  const [updated] = await db.update(engagementsTable)
    .set({ [col]: "in_progress" } as any)
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `Returned ${STAGE_LABELS[stage]} for revision: ${notes}`,
    isApproval: false,
  });

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: "Stage Returned for Revision",
      message: `${STAGE_LABELS[stage]} was returned on "${engagement.title}". ${notes}`,
      type: "engagement_approved",
      relatedId: engagement.id,
      relatedType: "engagement",
    });
  }

  await logAudit({
    userId: req.session.userId,
    action: "reject",
    entityType: "engagement",
    entityId: id,
    description: `Returned "${STAGE_LABELS[stage]}" on "${engagement.title}" — ${notes}`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/void-stage ─────────────────────────────────────
// Manager voids/undoes a stage approval (or for_review submission).
// Body: { stage: string, notes?: string }
// If stage is "approved" → revert to "in_progress"; if was completed, revert engagement status
// If stage is "for_review" → revert to "in_progress"
router.post("/engagements/:id/void-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col] as string;

  if (currentStageStatus !== "approved" && currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage "${STAGE_LABELS[stage]}" is not approved or pending review (current: ${currentStageStatus})` }); return;
  }

  const wasCompleted = engagement.status === "completed";
  const notes = req.body.notes?.trim() || null;

  const updatePayload: Record<string, any> = { [col]: "in_progress" };

  // If filing was completed and we're undoing a stage, revert to in_progress
  if (wasCompleted) {
    updatePayload.status = "in_progress";
    updatePayload.approvedBy = null;
    updatePayload.approvedAt = null;
    updatePayload.approvalNotes = null;
  }

  const [updated] = await db.update(engagementsTable)
    .set(updatePayload)
    .where(eq(engagementsTable.id, id))
    .returning();

  // If we undid a completed filing, also unmark the deadline
  if (wasCompleted) {
    await db.update(deadlinesTable)
      .set({ status: "pending" })
      .where(eq(deadlinesTable.engagementId, id));
  }

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `${wasCompleted ? "Filing completion voided — " : ""}${STAGE_LABELS[stage]} stage returned for revision.${notes ? ` Reason: ${notes}` : ""}`,
    isApproval: false,
  });

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: wasCompleted ? "Filing Completion Voided" : "Stage Approval Voided",
      message: `${STAGE_LABELS[stage]} on "${engagement.title}" has been returned for revision.${notes ? ` Reason: ${notes}` : ""}`,
      type: "engagement_approved",
      relatedId: engagement.id,
      relatedType: "engagement",
    });
  }

  await logAudit({
    userId: req.session.userId,
    action: "reject",
    entityType: "engagement",
    entityId: id,
    description: `Voided approval for "${STAGE_LABELS[stage]}" on "${engagement.title}"${notes ? ` — ${notes}` : ""}`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/advance-stage (legacy compat) ──────────────────
// Kept for backward compat — behaves same as submit-stage for current stage
router.post("/engagements/:id/advance-stage", requireAuth, async (req, res): Promise<void> => {
  res.status(400).json({ error: "advance-stage is no longer supported. Use submit-stage with a stage parameter." });
});

// ── POST /api/engagements/:id/skip-source (legacy compat) ────────────────────
router.post("/engagements/:id/skip-source", requireAuth, async (req, res): Promise<void> => {
  res.status(400).json({ error: "Use submit-stage with stage=source_collection to submit that stage." });
});

// ── POST /api/engagements/:id/skip-payment (legacy compat) ───────────────────
router.post("/engagements/:id/skip-payment", requireAuth, async (req, res): Promise<void> => {
  res.status(400).json({ error: "Use submit-stage with stage=payment to submit that stage." });
});

// ── POST /api/engagements/:id/amend ──────────────────────────────────────────
router.post("/engagements/:id/amend", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [original] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!original) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (original.status !== "completed") {
    res.status(400).json({ error: "Can only amend a completed filing" }); return;
  }

  const existingAmendments = await db.select()
    .from(engagementsTable)
    .where(eq(engagementsTable.amendedEngagementId, id));
  const amendmentNumber = existingAmendments.length + 1;

  const [amendment] = await db.insert(engagementsTable).values({
    clientId: original.clientId,
    title: `${original.title} — Amendment #${amendmentNumber}`,
    taxType: original.taxType,
    period: original.period,
    fiscalYear: original.fiscalYear,
    status: "in_progress",
    assignedTo: original.assignedTo,
    dueDate: original.dueDate,
    workflowStage: null,
    sourceCollectionStatus: "not_started",
    draftReturnStatus: "not_started",
    confirmationStatus: "not_started",
    paymentStatus: "not_started",
    isAmendment: true,
    amendedEngagementId: id,
  } as any).returning();

  await db.insert(commentsTable).values({
    engagementId: amendment.id,
    authorId: req.session.userId!,
    content: `Amendment #${amendmentNumber} filing started based on original filing ID #${id}.`,
    isApproval: false,
  });

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "engagement",
    entityId: amendment.id,
    description: `Created Amendment #${amendmentNumber} for "${original.title}"`,
  });

  res.status(201).json(await serializeEngagement(amendment));
});

export default router;
