import { Router } from "express";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { db, documentsTable, usersTable, clientsTable } from "@workspace/db";
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
import { UPLOADS_DIR } from "./upload";

const router = Router();

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

  const [doc] = await db
    .update(documentsTable)
    .set({ description: parsed.data.description ?? null })
    .where(eq(documentsTable.id, params.data.id))
    .returning();

  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  res.json(await serializeDocument(doc));
});

router.delete("/documents/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteDocumentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [doc] = await db.delete(documentsTable).where(eq(documentsTable.id, params.data.id)).returning();
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  // Also remove the physical file
  const filePath = path.join(UPLOADS_DIR, doc.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

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
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, doc.filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "File not found on disk" });
    return;
  }

  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.originalName)}"`);
  res.setHeader("Cache-Control", "private, max-age=3600");

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

export default router;
