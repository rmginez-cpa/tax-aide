import { Router } from "express";
import { eq, and, inArray, ne, type SQL } from "drizzle-orm";
import { db, engagementsTable, usersTable, clientsTable, notificationsTable, deadlinesTable, commentsTable } from "@workspace/db";
import {
  CreateEngagementBody,
  UpdateEngagementBody,
  GetEngagementParams,
  UpdateEngagementParams,
  DeleteEngagementParams,
  ListEngagementsQueryParams,
} from "@workspace/api-zod";
import {
  requireAuth,
  requireRole,
  requireStaff,
  requireManager,
  isStaffRole,
  isManagerRole,
  clientScope,
  canAccessClient,
} from "../middlewares/auth";
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
const STAGE_STATUS_COLS = {
  source_collection: "sourceCollectionStatus",
  draft_return: "draftReturnStatus",
  confirmation: "confirmationStatus",
  payment: "paymentStatus",
} as const satisfies Record<StageKey, keyof typeof engagementsTable.$inferSelect>;

type EngagementRow = typeof engagementsTable.$inferSelect;

/** Thrown inside a transaction to abort it and answer with a specific HTTP status. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function isValidStage(s: string): s is StageKey {
  return (STAGE_KEYS as readonly string[]).includes(s);
}

function getStageStatuses(e: EngagementRow): Record<StageKey, string> {
  return {
    source_collection: e.sourceCollectionStatus,
    draft_return: e.draftReturnStatus,
    confirmation: e.confirmationStatus,
    payment: e.paymentStatus,
  };
}

/** Payment stage is not applicable when taxPayable is explicitly set to 0. */
function isPaymentNotApplicable(e: EngagementRow): boolean {
  return e.taxPayable !== null && Number(e.taxPayable) === 0;
}

function allStagesApproved(e: EngagementRow): boolean {
  const paymentDone = isPaymentNotApplicable(e)
    ? true // no payment required
    : e.paymentStatus === "approved";
  return (
    e.sourceCollectionStatus === "approved" &&
    e.draftReturnStatus === "approved" &&
    e.confirmationStatus === "approved" &&
    paymentDone
  );
}

function stagesForReviewCount(e: EngagementRow): number {
  return [
    e.sourceCollectionStatus,
    e.draftReturnStatus,
    e.confirmationStatus,
    e.paymentStatus,
  ].filter(s => s === "for_review").length;
}

/**
 * Serializes a list of engagements, loading client and user names in two
 * batched queries instead of up to three queries per row.
 */
async function serializeEngagements(rows: EngagementRow[]) {
  const clientIds = [...new Set(rows.map(e => e.clientId).filter((v): v is number => v != null))];
  const userIds = [
    ...new Set(rows.flatMap(e => [e.assignedTo, e.approvedBy]).filter((v): v is number => v != null)),
  ];

  const [clients, users] = await Promise.all([
    clientIds.length
      ? db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, clientIds))
      : Promise.resolve([] as { id: number; name: string }[]),
    userIds.length
      ? db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds))
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);

  const clientNames = new Map<number, string>(clients.map(c => [c.id, c.name]));
  const userNames = new Map<number, string>(users.map(u => [u.id, u.name]));

  return rows.map(e =>
    toEngagementDto(
      e,
      e.clientId ? clientNames.get(e.clientId) ?? null : null,
      e.assignedTo ? userNames.get(e.assignedTo) ?? null : null,
      e.approvedBy ? userNames.get(e.approvedBy) ?? null : null,
    ),
  );
}

async function serializeEngagement(e: EngagementRow) {
  const [dto] = await serializeEngagements([e]);
  return dto;
}

function toEngagementDto(
  e: EngagementRow,
  clientName: string | null,
  assignedToName: string | null,
  approvedByName: string | null,
) {
  const statuses = getStageStatuses(e);
  const forReviewCount = stagesForReviewCount(e);

  // Override payment status to not_applicable when taxPayable === 0 (unconditional —
  // any in-flight payment-stage work is irrelevant once tax is zero).
  const paymentNotApplicable = isPaymentNotApplicable(e);
  const effectiveStatuses = { ...statuses };
  if (paymentNotApplicable) {
    effectiveStatuses.payment = "not_applicable";
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
    taxPayable: e.taxPayable !== null ? Number(e.taxPayable) : null,
    workflowStage: e.workflowStage ?? null,
    stageStatuses: effectiveStatuses,
    stagesForReview: forReviewCount,
    isAmendment: e.isAmendment ?? false,
    amendedEngagementId: e.amendedEngagementId ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** Returns an error message when `userId` is not an existing staff user, else null. */
async function validateAssignee(userId: number): Promise<string | null> {
  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) return "Assigned user not found";
  if (!isStaffRole(user.role)) return "Filings can only be assigned to staff members";
  return null;
}

/**
 * The assignee to notify, or null when there is none or they are no longer a
 * staff member (a former staff account turned client must not receive notices
 * about other clients' filings).
 */
async function staffRecipient(userId: number | null | undefined): Promise<number | null> {
  if (userId == null) return null;
  return (await validateAssignee(userId)) === null ? userId : null;
}

// ── GET /api/engagements ──────────────────────────────────────────────────────
router.get("/engagements", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListEngagementsQueryParams.safeParse(req.query);

  const conditions: SQL[] = [];
  if (queryParams.success && queryParams.data.clientId != null) {
    conditions.push(eq(engagementsTable.clientId, queryParams.data.clientId));
  }
  if (queryParams.success && queryParams.data.status != null) {
    conditions.push(eq(engagementsTable.status, queryParams.data.status));
  }
  // Client accounts only ever see their own linked client (0 = unlinked → nothing).
  const scope = clientScope(req);
  if (scope !== null) {
    conditions.push(eq(engagementsTable.clientId, scope));
  }

  const engagements = await db
    .select()
    .from(engagementsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(engagementsTable.createdAt);

  res.json(await serializeEngagements(engagements));
});

router.post("/engagements", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateEngagementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db
    .select({ id: clientsTable.id })
    .from(clientsTable)
    .where(eq(clientsTable.id, parsed.data.clientId));
  if (!client) {
    res.status(400).json({ error: "Client not found" });
    return;
  }

  if (parsed.data.assignedTo != null) {
    const assigneeError = await validateAssignee(parsed.data.assignedTo);
    if (assigneeError) {
      res.status(400).json({ error: assigneeError });
      return;
    }
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
  if (!engagement || !canAccessClient(req, engagement.clientId)) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  res.json(await serializeEngagement(engagement));
});

// ── GET /api/engagements/:id/amendments ──────────────────────────────────────
router.get("/engagements/:id/amendments", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [thisEng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!thisEng || !canAccessClient(req, thisEng.clientId)) {
    res.status(404).json({ error: "Engagement not found" }); return;
  }

  const rootId = thisEng.amendedEngagementId ?? id;

  const [original] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, rootId));
  const amendments = await db.select().from(engagementsTable).where(eq(engagementsTable.amendedEngagementId, rootId));

  const all = [original, ...amendments].filter(
    (e): e is EngagementRow => e != null && canAccessClient(req, e.clientId),
  );
  res.json(await serializeEngagements(all));
});

router.patch("/engagements/:id", requireStaff, async (req, res): Promise<void> => {
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

  // Fetch existing engagement so we can enforce business rules before mutating.
  const [existing] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Engagement not found" });
    return;
  }

  // ── Status is owned by the stage workflow ────────────────────────────────
  // The generated enum also admits the literal string "null"; treat it as "not sent".
  const requestedStatus =
    parsed.data.status != null && parsed.data.status !== "null" ? parsed.data.status : null;
  if (requestedStatus === "completed") {
    res.status(400).json({ error: "A filing is completed by approving its stages" });
    return;
  }
  const statusChanged = requestedStatus !== null && requestedStatus !== existing.status;
  if (statusChanged && !isManagerRole(req.session.userRole)) {
    res.status(403).json({ error: "Only a manager may change a filing's status" });
    return;
  }

  if (parsed.data.assignedTo != null && parsed.data.assignedTo !== existing.assignedTo) {
    const assigneeError = await validateAssignee(parsed.data.assignedTo);
    if (assigneeError) {
      res.status(400).json({ error: assigneeError });
      return;
    }
  }

  const updates: Partial<typeof engagementsTable.$inferInsert> = {};
  if (parsed.data.title != null) updates.title = parsed.data.title;
  if (parsed.data.taxType != null) updates.taxType = parsed.data.taxType;
  if (parsed.data.period != null) updates.period = parsed.data.period;
  if ("fiscalYear" in parsed.data) updates.fiscalYear = parsed.data.fiscalYear ?? null;
  if (statusChanged) updates.status = requestedStatus;
  if ("assignedTo" in parsed.data) updates.assignedTo = parsed.data.assignedTo ?? null;
  if ("dueDate" in parsed.data) updates.dueDate = parsed.data.dueDate ?? null;
  if ("notes" in parsed.data) updates.notes = parsed.data.notes ?? null;

  // ── taxPayable pre-flight checks (on `existing`, fetched above) ──────────
  let taxPayableInRequest = false;
  let incomingTaxPayableNorm: number | null = null;
  if ("taxPayable" in parsed.data) {
    taxPayableInRequest = true;
    if (existing.status === "completed") {
      res.status(400).json({ error: "Tax payable cannot be changed after the filing is completed" });
      return;
    }
    if (parsed.data.taxPayable != null && parsed.data.taxPayable < 0) {
      res.status(400).json({ error: "Tax payable amount must be zero or positive" });
      return;
    }
    incomingTaxPayableNorm = parsed.data.taxPayable != null ? Number(parsed.data.taxPayable) : null;
  }

  // ── Single transaction: apply all updates, evaluate completion ────────────
  let autoCompleted = false;
  let engagement: EngagementRow;

  try {
    engagement = await db.transaction(async (tx) => {
      const txUpdates: Partial<typeof engagementsTable.$inferInsert> = { ...updates };

      if (taxPayableInRequest) {
        txUpdates.taxPayable = incomingTaxPayableNorm != null ? String(incomingTaxPayableNorm) : null;

        // Re-read inside the transaction so comparison is against the committed state.
        const [locked] = await tx.select().from(engagementsTable).where(eq(engagementsTable.id, params.data.id));
        if (!locked) throw new HttpError(404, "Engagement not found");

        const persistedNorm = locked.taxPayable != null ? Number(locked.taxPayable) : null;
        const actuallyChanged = incomingTaxPayableNorm !== persistedNorm;

        // Reset payment stage only when the amount truly changes, so a no-op Save
        // does not invalidate an already-approved payment.
        if (actuallyChanged) {
          txUpdates.paymentStatus = "not_started";
        }

        const [updated] = await tx.update(engagementsTable)
          .set(txUpdates)
          .where(eq(engagementsTable.id, params.data.id))
          .returning();
        if (!updated) throw new HttpError(404, "Engagement not found");

        // Auto-complete when zeroing tax payable satisfies the remaining required stages —
        // evaluated against the just-written row so no concurrent edit can slip through.
        if (actuallyChanged && isPaymentNotApplicable(updated) && updated.status !== "completed") {
          const stages = getStageStatuses(updated);
          const nowComplete =
            stages.source_collection === "approved" &&
            stages.draft_return === "approved" &&
            stages.confirmation === "approved";
          if (nowComplete) {
            const [completed] = await tx
              .update(engagementsTable)
              .set({ status: "completed", approvedBy: req.session.userId!, approvedAt: new Date() })
              .where(eq(engagementsTable.id, updated.id))
              .returning();
            if (!completed) throw new Error("Auto-completion update failed");
            await tx.update(deadlinesTable)
              .set({ status: "completed" })
              .where(eq(deadlinesTable.engagementId, updated.id));
            const recipient = await staffRecipient(completed.assignedTo);
            if (recipient != null) {
              await tx.insert(notificationsTable).values({
                userId: recipient,
                title: "Filing Complete",
                message: `Tax payable set to zero — payment stage waived. Filing for "${completed.title}" is now complete.`,
                type: "engagement_approved",
                relatedId: completed.id,
                relatedType: "engagement",
              });
            }
            autoCompleted = true;
            return completed;
          }
        }
        return updated;
      }

      if (Object.keys(txUpdates).length === 0) {
        // Nothing to write (e.g. a no-op status) — return the current row unchanged.
        const [current] = await tx.select().from(engagementsTable).where(eq(engagementsTable.id, params.data.id));
        if (!current) throw new HttpError(404, "Engagement not found");
        return current;
      }

      const [updated] = await tx.update(engagementsTable)
        .set(txUpdates)
        .where(eq(engagementsTable.id, params.data.id))
        .returning();
      if (!updated) throw new HttpError(404, "Engagement not found");
      return updated;
    });
  } catch (err: unknown) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Internal error";
    res.status(status).json({ error: message });
    return;
  }

  if (autoCompleted) {
    await logAudit({
      userId: req.session.userId,
      action: "approve",
      entityType: "engagement",
      entityId: engagement.id,
      description: `Filing "${engagement.title}" auto-completed: taxPayable set to zero with all prior stages approved`,
    });
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "engagement",
    entityId: engagement.id,
    description: statusChanged
      ? `Updated engagement "${engagement.title}" (status ${existing.status} → ${engagement.status})`
      : `Updated engagement "${engagement.title}"`,
  });

  res.json(await serializeEngagement(engagement));
});

router.delete("/engagements/:id", requireManager, async (req, res): Promise<void> => {
  const params = DeleteEngagementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const engagement = await db.transaction(async (tx) => {
    // Linked deadlines got their status from this filing's workflow. Unlink them and
    // put them back to pending so they are not shown as in progress / filed.
    await tx.update(deadlinesTable)
      .set({ engagementId: null, status: "pending" })
      .where(eq(deadlinesTable.engagementId, params.data.id));

    const [deleted] = await tx
      .delete(engagementsTable)
      .where(eq(engagementsTable.id, params.data.id))
      .returning();
    return deleted;
  });

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

// ── POST /api/engagements/:id/approve (legacy) ───────────────────────────────
// Whole-filing approval bypassed the stage workflow. Filings are completed only by
// approving their stages, so this endpoint is retired (managers only, always 400).
router.post("/engagements/:id/approve", requireManager, async (_req, res): Promise<void> => {
  res.status(400).json({ error: "approve is no longer supported; use approve-stage with a stage parameter." });
});

// ── POST /api/engagements/:id/submit-stage ───────────────────────────────────
// Accountant submits a specific stage for manager review.
// Body: { stage: "source_collection" | "draft_return" | "confirmation" | "payment" }
router.post("/engagements/:id/submit-stage", requireStaff, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }
  if (engagement.status === "completed") { res.status(400).json({ error: "Filing is already complete" }); return; }

  // Reject payment-stage actions when tax payable is zero — payment is not required.
  if (stage === "payment" && isPaymentNotApplicable(engagement)) {
    res.status(400).json({ error: "Payment stage is not applicable when tax payable is zero" }); return;
  }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col];

  if (currentStageStatus === "for_review") {
    res.status(400).json({ error: "Stage is already submitted for review" }); return;
  }
  if (currentStageStatus === "approved") {
    res.status(400).json({ error: "Stage is already approved" }); return;
  }

  const [updated] = await db.update(engagementsTable)
    .set({ [col]: "for_review" })
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
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  // Reject payment-stage approval when tax payable is zero — payment is not required.
  if (stage === "payment" && isPaymentNotApplicable(engagement)) {
    res.status(400).json({ error: "Payment stage is not applicable when tax payable is zero" }); return;
  }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col];

  if (currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage "${STAGE_LABELS[stage]}" is not awaiting review (current: ${currentStageStatus})` }); return;
  }

  const rawNotes = req.body.notes;
  const notes = typeof rawNotes === "string" && rawNotes.trim() ? rawNotes.trim() : null;

  let result: { updated: EngagementRow; completed: boolean };
  try {
    result = await db.transaction(async (tx) => {
      // Conditional update: only succeeds while the stage is still awaiting review, so two
      // concurrent approvals cannot both pass the check above. A concurrent writer on the
      // same row blocks here until it commits; the WHERE is then re-evaluated on its result.
      const [stageApproved] = await tx.update(engagementsTable)
        .set({ [col]: "approved" })
        .where(and(eq(engagementsTable.id, id), eq(engagementsTable[col], "for_review")))
        .returning();
      if (!stageApproved) {
        throw new HttpError(409, `Stage "${STAGE_LABELS[stage]}" was changed by someone else. Refresh and try again.`);
      }

      // Evaluate completion against the just-written row (includes any stage another
      // manager approved concurrently), not the snapshot read before the transaction.
      let updated = stageApproved;
      let completed = false;
      if (stageApproved.status !== "completed" && allStagesApproved(stageApproved)) {
        const [done] = await tx.update(engagementsTable)
          .set({
            status: "completed",
            approvedBy: req.session.userId!,
            approvedAt: new Date(),
            ...(notes ? { approvalNotes: notes } : {}),
          })
          .where(and(eq(engagementsTable.id, id), ne(engagementsTable.status, "completed")))
          .returning();
        if (done) {
          updated = done;
          completed = true;
        }
      }

      await tx.insert(commentsTable).values({
        engagementId: id,
        authorId: req.session.userId!,
        content: notes ? `Approved ${STAGE_LABELS[stage]}: ${notes}` : `Approved ${STAGE_LABELS[stage]}.`,
        isApproval: true,
      });

      if (completed) {
        // Mark linked deadline as completed
        await tx.update(deadlinesTable)
          .set({ status: "completed" })
          .where(eq(deadlinesTable.engagementId, id));
      }

      const recipient = await staffRecipient(updated.assignedTo);
      if (recipient != null) {
        await tx.insert(notificationsTable).values(
          completed
            ? {
                userId: recipient,
                title: "Filing Complete",
                message: `All stages approved — filing for "${updated.title}" is now complete!`,
                type: "engagement_approved",
                relatedId: updated.id,
                relatedType: "engagement",
              }
            : {
                userId: recipient,
                title: "Stage Approved",
                message: `${STAGE_LABELS[stage]} was approved for "${updated.title}". Keep working on the remaining stages.`,
                type: "engagement_approved",
                relatedId: updated.id,
                relatedType: "engagement",
              },
        );
      }

      return { updated, completed };
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  await logAudit({
    userId: req.session.userId,
    action: "approve",
    entityType: "engagement",
    entityId: id,
    description: result.completed
      ? `Approved final stage "${STAGE_LABELS[stage]}" — filing "${result.updated.title}" is now complete`
      : `Approved stage "${STAGE_LABELS[stage]}" on "${result.updated.title}"`,
  });

  res.json(await serializeEngagement(result.updated));
});

// ── POST /api/engagements/:id/reject-stage ───────────────────────────────────
// Manager returns a specific stage for revision.
// Body: { stage: string, notes: string }
router.post("/engagements/:id/reject-stage", requireRole("manager"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col];

  if (currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage is not awaiting review` }); return;
  }

  const notes = (req.body.notes || "").trim();
  if (!notes) { res.status(400).json({ error: "Rejection reason is required" }); return; }

  const [updated] = await db.update(engagementsTable)
    .set({ [col]: "in_progress" })
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `Returned ${STAGE_LABELS[stage]} for revision: ${notes}`,
    isApproval: false,
  });

  const rejectRecipient = await staffRecipient(engagement.assignedTo);
  if (rejectRecipient != null) {
    await db.insert(notificationsTable).values({
      userId: rejectRecipient,
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
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col];

  if (currentStageStatus !== "approved" && currentStageStatus !== "for_review") {
    res.status(400).json({ error: `Stage "${STAGE_LABELS[stage]}" is not approved or pending review (current: ${currentStageStatus})` }); return;
  }

  const wasCompleted = engagement.status === "completed";
  const notes = req.body.notes?.trim() || null;

  const updatePayload: Partial<typeof engagementsTable.$inferInsert> = { [col]: "in_progress" };

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

  const voidRecipient = await staffRecipient(engagement.assignedTo);
  if (voidRecipient != null) {
    await db.insert(notificationsTable).values({
      userId: voidRecipient,
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

// ── POST /api/engagements/:id/recall-stage ───────────────────────────────────
// Maker retracts a submitted stage back to in_progress so they can make changes.
// Only allowed while the stage is for_review (not yet approved).
// Body: { stage: string }
router.post("/engagements/:id/recall-stage", requireStaff, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const stage = req.body.stage as string;
  if (!stage || !isValidStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${STAGE_KEYS.join(", ")}` }); return;
  }

  const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, id));
  if (!engagement) { res.status(404).json({ error: "Engagement not found" }); return; }

  const col = STAGE_STATUS_COLS[stage];
  const currentStageStatus = engagement[col];

  if (currentStageStatus !== "for_review") {
    res.status(400).json({ error: "Stage can only be recalled while it is pending approval" }); return;
  }

  const [updated] = await db.update(engagementsTable)
    .set({ [col]: "in_progress" })
    .where(eq(engagementsTable.id, id))
    .returning();

  await db.insert(commentsTable).values({
    engagementId: id,
    authorId: req.session.userId!,
    content: `Recalled ${STAGE_LABELS[stage]} submission — returned to In Progress for further editing.`,
    isApproval: false,
  });

  // Notify managers that the submission was recalled
  const managers = await db.select().from(usersTable).where(eq(usersTable.role, "manager"));
  for (const mgr of managers) {
    await db.insert(notificationsTable).values({
      userId: mgr.id,
      title: "Stage Submission Recalled",
      message: `"${engagement.title}" — ${STAGE_LABELS[stage]} submission was recalled by the maker for further editing.`,
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
    description: `Recalled "${STAGE_LABELS[stage]}" submission on "${engagement.title}"`,
  });

  res.json(await serializeEngagement(updated));
});

// ── POST /api/engagements/:id/advance-stage (legacy compat) ──────────────────
// Kept for backward compat — behaves same as submit-stage for current stage
router.post("/engagements/:id/advance-stage", requireStaff, async (_req, res): Promise<void> => {
  res.status(400).json({ error: "advance-stage is no longer supported. Use submit-stage with a stage parameter." });
});

// ── POST /api/engagements/:id/skip-source (legacy compat) ────────────────────
router.post("/engagements/:id/skip-source", requireStaff, async (_req, res): Promise<void> => {
  res.status(400).json({ error: "Use submit-stage with stage=source_collection to submit that stage." });
});

// ── POST /api/engagements/:id/skip-payment (legacy compat) ───────────────────
router.post("/engagements/:id/skip-payment", requireStaff, async (_req, res): Promise<void> => {
  res.status(400).json({ error: "Use submit-stage with stage=payment to submit that stage." });
});

// ── POST /api/engagements/:id/amend ──────────────────────────────────────────
router.post("/engagements/:id/amend", requireStaff, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
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
  // The original assignee may have left the staff since; do not carry them over.
  const amendAssignee = await staffRecipient(original.assignedTo);

  const [amendment] = await db.insert(engagementsTable).values({
    clientId: original.clientId,
    title: `${original.title} — Amendment #${amendmentNumber}`,
    taxType: original.taxType,
    period: original.period,
    fiscalYear: original.fiscalYear,
    status: "in_progress",
    assignedTo: amendAssignee,
    dueDate: original.dueDate,
    workflowStage: null,
    sourceCollectionStatus: "not_started",
    draftReturnStatus: "not_started",
    confirmationStatus: "not_started",
    paymentStatus: "not_started",
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
