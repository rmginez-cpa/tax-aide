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
    workflowStage: e.workflowStage ?? null,
    isAmendment: e.isAmendment ?? false,
    amendedEngagementId: e.amendedEngagementId ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

// ── Helper: stage progression ────────────────────────────────────────────────
const STAGE_ORDER = ["source_collection", "draft_return", "confirmation", "payment"] as const;
type WorkflowStage = (typeof STAGE_ORDER)[number];

function nextStage(current: string): WorkflowStage | null {
  const idx = STAGE_ORDER.indexOf(current as WorkflowStage);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

const STAGE_LABELS: Record<string, string> = {
  source_collection: "Source Documents",
  draft_return: "Draft Tax Return",
  confirmation: "Confirmation Receipt",
  payment: "Payment Confirmation",
};

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

// ── GET /api/engagements/:id/amendments ──────────────────────────────────────
// Returns all amendments for an engagement (original or amendment)
router.get("/engagements/:id/amendments", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  // First resolve to original: if this is itself an amendment, get its root
  const [thisEng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!thisEng) { res.status(404).json({ error: "Engagement not found" }); return; }

  const rootId = thisEng.amendedEngagementId ?? id;

  // Get original + all amendments
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

// ── POST /api/engagements/:id/advance-stage ──────────────────────────────────
// NEW: Accountant advances to next stage directly (no manager approval needed between stages).
// At the FINAL stage (payment), this submits for manager review instead.
router.post("/engagements/:id/advance-stage", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.status !== "in_progress") {
    res.status(400).json({ error: "Engagement is not in progress" }); return;
  }
  if (!engagement.workflowStage) {
    res.status(400).json({ error: "Engagement has no workflow stage" }); return;
  }

  const notes = req.body.notes?.trim() || null;
  const next = nextStage(engagement.workflowStage);

  let updatedData: Partial<typeof engagementsTable.$inferInsert>;
  let action: string;

  if (next) {
    // Not the last stage: advance directly without manager approval
    updatedData = {
      workflowStage: next,
      status: "in_progress",
      notes: notes ?? engagement.notes,
    };
    action = `Advanced from "${STAGE_LABELS[engagement.workflowStage]}" to "${STAGE_LABELS[next]}"`;
  } else {
    // Last stage (payment): submit for manager review
    updatedData = {
      status: "for_review",
      notes: notes ?? engagement.notes,
    };
    action = `Submitted "${STAGE_LABELS[engagement.workflowStage]}" for manager review`;

    // Notify all managers
    const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager"));
    for (const mgr of managers) {
      await db.insert(notificationsTable).values({
        userId: mgr.id,
        title: "Filing Ready for Approval",
        message: `"${engagement.title}" — all stages complete. Ready for your final approval.`,
        type: "engagement_approved",
        relatedId: engagement.id,
        relatedType: "engagement",
      });
    }
  }

  const [updated] = await db.update(engagementsTable)
    .set(updatedData as any)
    .where(eq(engagementsTable.id, id))
    .returning();

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: id,
    description: action,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/submit-stage ───────────────────────────────────
// Legacy: kept for backward compat. Behaves same as advance-stage.
router.post("/engagements/:id/submit-stage", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.status !== "in_progress") {
    res.status(400).json({ error: "Engagement is not in progress" }); return;
  }
  if (!engagement.workflowStage) {
    res.status(400).json({ error: "Engagement has no workflow stage" }); return;
  }

  const notes = req.body.notes?.trim() || null;
  const next = nextStage(engagement.workflowStage);

  let updatedData: Partial<typeof engagementsTable.$inferInsert>;

  if (next) {
    updatedData = { workflowStage: next, status: "in_progress", notes: notes ?? engagement.notes };
  } else {
    updatedData = { status: "for_review", notes: notes ?? engagement.notes };

    const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager"));
    for (const mgr of managers) {
      await db.insert(notificationsTable).values({
        userId: mgr.id,
        title: "Filing Ready for Approval",
        message: `"${engagement.title}" — all stages complete. Ready for your final approval.`,
        type: "engagement_approved",
        relatedId: engagement.id,
        relatedType: "engagement",
      });
    }
  }

  const [updated] = await db.update(engagementsTable)
    .set(updatedData as any)
    .where(eq(engagementsTable.id, id))
    .returning();

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/skip-source ────────────────────────────────────
router.post("/engagements/:id/skip-source", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.workflowStage !== "source_collection" || engagement.status !== "in_progress") {
    res.status(400).json({ error: "Can only skip source collection when in progress" }); return;
  }

  const [updated] = await db.update(engagementsTable)
    .set({ workflowStage: "draft_return", status: "in_progress", notes: "No taxpayer transactions to report for this period." })
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: "Source collection skipped — no taxpayer transactions for this period.",
    isApproval: false,
  });

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: id,
    description: `Skipped source collection (no transactions) — advanced to Draft Tax Return`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/skip-payment ───────────────────────────────────
router.post("/engagements/:id/skip-payment", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.workflowStage !== "payment" || engagement.status !== "in_progress") {
    res.status(400).json({ error: "Can only skip payment when in the payment stage and in progress" }); return;
  }

  const [updated] = await db.update(engagementsTable)
    .set({ status: "for_review", notes: (engagement.notes ? engagement.notes + " | " : "") + "No payment required for this filing." })
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: "Payment stage skipped — no payment required. Submitted for manager approval.",
    isApproval: false,
  });

  // Notify managers
  const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager"));
  for (const mgr of managers) {
    await db.insert(notificationsTable).values({
      userId: mgr.id,
      title: "Filing Ready for Approval (No Payment)",
      message: `"${engagement.title}" — no payment required. Ready for your approval.`,
      type: "engagement_approved",
      relatedId: engagement.id,
      relatedType: "engagement",
    });
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: id,
    description: `Payment skipped — submitted for manager approval`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/approve-stage ──────────────────────────────────
// Manager approves the complete filing (all stages done → completed)
router.post("/engagements/:id/approve-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.status !== "for_review") {
    res.status(400).json({ error: "Engagement is not awaiting review" }); return;
  }

  const notes = req.body.notes?.trim() || null;

  const [updated] = await db.update(engagementsTable)
    .set({
      status: "completed",
      approvedBy: req.session.userId!,
      approvedAt: new Date(),
      approvalNotes: notes,
    } as any)
    .where(eq(engagementsTable.id, id))
    .returning();

  // Mark linked deadline as completed
  await db.update(deadlinesTable)
    .set({ status: "completed" })
    .where(eq(deadlinesTable.engagementId, id));

  if (notes) {
    await db.insert(commentsTable).values({
      engagementId: id,
      authorId: req.session.userId!,
      content: notes,
      isApproval: true,
    });
  }

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: "Filing Complete",
      message: `Filing workflow for "${engagement.title}" is now complete and approved!`,
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
    description: `Approved and completed filing for "${engagement.title}"`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/void-stage ────────────────────────────────────
// Manager voids/undoes the filing approval — reverts back to in_progress
router.post("/engagements/:id/void-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const wasCompleted = engagement.status === "completed";
  const wasForReview = engagement.status === "for_review";

  if (!wasCompleted && !wasForReview) {
    res.status(400).json({ error: "Can only void completed or for-review engagements" }); return;
  }

  const notes = req.body.notes?.trim() || null;
  const reason = notes || "Voided by manager";

  const [updated] = await db.update(engagementsTable)
    .set({
      status: "in_progress",
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
    })
    .where(eq(engagementsTable.id, id))
    .returning();

  // If was completed, revert the linked deadline status
  if (wasCompleted) {
    await db.update(deadlinesTable)
      .set({ status: "pending" })
      .where(eq(deadlinesTable.engagementId, id));
  }

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `${wasCompleted ? "Filing completion voided" : "Review submission voided"} — returned to accountant. Reason: ${reason}`,
    isApproval: false,
  });

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: wasCompleted ? "Filing Completion Voided" : "Review Returned",
      message: `"${engagement.title}" has been returned for revision. ${reason}`,
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
    description: `Voided ${wasCompleted ? "completed" : "for-review"} status for "${engagement.title}" — returned to in_progress`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/reject-stage ───────────────────────────────────
// Manager rejects current stage, returns to accountant
router.post("/engagements/:id/reject-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (engagement.status !== "for_review") {
    res.status(400).json({ error: "Engagement is not awaiting review" }); return;
  }

  const notes = (req.body.notes || "").trim();
  if (!notes) { res.status(400).json({ error: "Rejection reason is required" }); return; }

  const [updated] = await db.update(engagementsTable)
    .set({ status: "in_progress", approvalNotes: notes })
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `Returned for revision: ${notes}`,
    isApproval: false,
  });

  if (engagement.assignedTo) {
    await db.insert(notificationsTable).values({
      userId: engagement.assignedTo,
      title: "Filing Returned for Revision",
      message: `"${engagement.title}" returned. ${notes}`,
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
    description: `Rejected filing for "${engagement.title}" — ${notes}`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/amend ──────────────────────────────────────────
// Create an amended return filing for a completed engagement
router.post("/engagements/:id/amend", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [original] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!original) { res.status(404).json({ error: "Engagement not found" }); return; }

  if (original.status !== "completed") {
    res.status(400).json({ error: "Can only amend a completed filing" }); return;
  }

  // Count existing amendments to number this one
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
    workflowStage: "source_collection",
    isAmendment: true,
    amendedEngagementId: id,
  }).returning();

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
