import { Router } from "express";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { db, documentsTable, usersTable, clientsTable, engagementsTable } from "@workspace/db";
import {
  UploadDocumentBody,
  UpdateDocumentBody,
  GetDocumentParams,
  UpdateDocumentParams,
  DeleteDocumentParams,
  ListDocumentsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { getStoredFile, deleteStoredFile } from "../lib/fileStore";
import { UPLOADS_DIR } from "./upload";

const router = Router();

// Client-role users may only access documents belonging to their own client.
// Returns true if access is denied (and the 404 response has been sent).
function deniedForClientRole(
  req: { session: { userRole?: string; userClientId?: number | null } },
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  doc: { clientId: number | null },
): boolean {
  if (req.session.userRole === "client" && doc.clientId !== req.session.userClientId) {
    res.status(404).json({ error: "Document not found" });
    return true;
  }
  return false;
}

async function serializeDocument(doc: typeof documentsTable.$inferSelect) {
  let uploadedByName: string | null = null;
  let clientName: string | null = null;

  const [uploader] = await db.select().from(usersTable).where(eq(usersTable.id, doc.uploadedBy));
  uploadedByName = uploader?.name ?? null;

  if (doc.clientId) {
    const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, doc.clientId));
    clientName = client?.name ?? null;
  }

  return {
    id: doc.id,
    engagementId: doc.engagementId ?? null,
    clientId: doc.clientId ?? null,
    clientName,
    filename: doc.filename,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    fileUrl: doc.fileUrl,
    version: doc.version,
    description: doc.description ?? null,
    uploadedBy: doc.uploadedBy,
    uploadedByName,
    stage: doc.stage ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

router.get("/documents", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListDocumentsQueryParams.safeParse(req.query);
  let docs = await db.select().from(documentsTable).orderBy(documentsTable.createdAt);

  if (queryParams.success && queryParams.data.engagementId != null) {
    docs = docs.filter((d) => d.engagementId === queryParams.data.engagementId);
  }
  if (queryParams.success && queryParams.data.clientId != null) {
    docs = docs.filter((d) => d.clientId === queryParams.data.clientId);
  }

  // Client-role users: automatically scope to their client only
  const userRole = req.session.userRole || "";
  const userClientId = req.session.userClientId;
  if (userRole === "client" && userClientId) {
    docs = docs.filter((d) => d.clientId === userClientId);
  }

  const serialized = await Promise.all(docs.map(serializeDocument));
  res.json(serialized);
});

router.post("/documents", requireAuth, async (req, res): Promise<void> => {
  const parsed = UploadDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [doc] = await db.insert(documentsTable).values({
    ...parsed.data,
    uploadedBy: req.session.userId!,
    version: 1,
  }).returning();

  await logAudit({
    userId: req.session.userId,
    action: "upload",
    entityType: "document",
    entityId: doc.id,
    description: `Uploaded document "${doc.originalName}"`,
  });

  res.status(201).json(await serializeDocument(doc));
});

router.get("/documents/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, params.data.id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (deniedForClientRole(req, res, doc)) return;

  res.json(await serializeDocument(doc));
});

router.patch("/documents/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(documentsTable).where(eq(documentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (deniedForClientRole(req, res, existing)) return;

  const [doc] = await db
    .update(documentsTable)
    .set({ description: parsed.data.description ?? null })
    .where(eq(documentsTable.id, params.data.id))
    .returning();

  res.json(await serializeDocument(doc));
});

router.delete("/documents/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Look up the document first to check engagement lock state
  const [existingDoc] = await db.select().from(documentsTable).where(eq(documentsTable.id, params.data.id));
  if (!existingDoc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (deniedForClientRole(req, res, existingDoc)) return;

  // Guard: if the document's stage is locked (for_review or approved), block deletion
  if (existingDoc.engagementId) {
    const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, existingDoc.engagementId));
    if (eng) {
      const docStage = existingDoc.stage as string | null;
      const stageStatusMap: Record<string, string> = {
        source_collection: eng.sourceCollectionStatus,
        draft_return: eng.draftReturnStatus,
        confirmation: eng.confirmationStatus,
        payment: eng.paymentStatus,
      };
      const stageStatus = docStage && stageStatusMap[docStage] ? stageStatusMap[docStage] : null;

      if (stageStatus === "for_review") {
        res.status(403).json({ error: "Cannot delete documents from a stage that is pending manager approval." });
        return;
      }
      if (stageStatus === "approved") {
        res.status(403).json({ error: "Cannot delete documents from an approved stage. The manager must undo the approval first." });
        return;
      }
      // Fallback: if whole filing is completed, also block
      if (eng.status === "completed" && !stageStatus) {
        res.status(403).json({ error: "Cannot delete documents from a completed filing." });
        return;
      }
    }
  }

  const [doc] = await db.delete(documentsTable).where(eq(documentsTable.id, params.data.id)).returning();
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  // Also remove the stored file (object storage and/or local disk)
  await deleteStoredFile(doc.filename, UPLOADS_DIR);

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "document",
    entityId: params.data.id,
    description: `Deleted document "${doc.originalName}"`,
  });

  res.sendStatus(204);
});

// ── GET /api/documents/:id/content ─────────────────────────────────────────
// Streams the actual file bytes, authenticated. Used by the file viewer.
router.get("/documents/:id/content", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  if (deniedForClientRole(req, res, doc)) return;

  const stored = await getStoredFile(doc.filename, UPLOADS_DIR);
  if (!stored) {
    res.status(404).json({ error: "File not found in storage" });
    return;
  }

  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.originalName)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (stored.size != null) {
    res.setHeader("Content-Length", stored.size);
  }

  if (stored.kind === "disk") {
    fs.createReadStream(stored.path).pipe(res);
  } else {
    stored.file.createReadStream()
      .on("error", (err) => {
        console.error("Storage stream error:", err);
        if (!res.headersSent) res.status(500).json({ error: "Failed to read file" });
        else res.end();
      })
      .pipe(res);
  }
});

export default router;
