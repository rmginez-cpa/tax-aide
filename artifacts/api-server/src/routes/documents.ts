import { Router, type Response } from "express";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
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
import { requireAuth, requireStaff, clientScope, canAccessClient } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { getStoredFile, deleteStoredFile } from "../lib/fileStore";
import {
  UPLOADS_DIR,
  DOCUMENT_STAGES,
  isDocumentStage,
  stageStatusOf,
  uploadLockError,
  makeStoredFilename,
} from "./upload";

const router = Router();

type DocumentRow = typeof documentsTable.$inferSelect;

/**
 * Loads a document the session may see. Documents outside a client account's
 * scope (including documents with no client at all) answer 404 so their
 * existence is not leaked. Returns null once the response has been sent.
 */
async function loadVisibleDocument(
  req: Parameters<typeof canAccessClient>[0],
  res: Response,
  id: number,
): Promise<DocumentRow | null> {
  const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc || !canAccessClient(req, doc.clientId)) {
    res.status(404).json({ error: "Document not found" });
    return null;
  }
  return doc;
}

/** Serializes documents, loading uploader and client names in two queries. */
async function serializeDocuments(docs: DocumentRow[]) {
  const userIds = [...new Set(docs.map((d) => d.uploadedBy))];
  const clientIds = [...new Set(docs.map((d) => d.clientId).filter((id): id is number => id != null))];

  const [users, clients] = await Promise.all([
    userIds.length
      ? db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(inArray(usersTable.id, userIds))
      : Promise.resolve([]),
    clientIds.length
      ? db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, clientIds))
      : Promise.resolve([]),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const clientNames = new Map(clients.map((c) => [c.id, c.name]));

  return docs.map((doc) => ({
    id: doc.id,
    engagementId: doc.engagementId ?? null,
    clientId: doc.clientId ?? null,
    clientName: doc.clientId != null ? clientNames.get(doc.clientId) ?? null : null,
    filename: doc.filename,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    fileSize: doc.fileSize,
    fileUrl: doc.fileUrl,
    version: doc.version,
    description: doc.description ?? null,
    uploadedBy: doc.uploadedBy,
    uploadedByName: userNames.get(doc.uploadedBy) ?? null,
    stage: doc.stage ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));
}

async function serializeDocument(doc: DocumentRow) {
  const [serialized] = await serializeDocuments([doc]);
  return serialized;
}

/** Escapes LIKE/ILIKE wildcards so user text matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Parses an optional non-negative integer query value. undefined = absent, NaN = invalid. */
function parseOptionalInt(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return NaN;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : NaN;
}

/** The first value of a query parameter given once or repeated (?a=1&a=2). */
function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Most documents one page may ask for. */
const MAX_DOCUMENT_PAGE = 200;

// GET /api/documents
//   engagementId, clientId   exact filters (as before)
//   q                        original file name contains (case-insensitive)
//   stage                    one of DOCUMENT_STAGES, or "none" for documents not linked to a stage
//   mimeType                 MIME type prefix ("image/", "application/pdf"); comma-separated = any of
//   order                    "asc" (default, oldest first) | "desc" (newest first)
//   limit, offset            pagination (limit 1-200). The body stays a plain array; the
//                            X-Total-Count header carries the number of matches before paging.
// Client accounts are always restricted to their own client, whatever filters they pass.
router.get("/documents", requireAuth, async (req, res): Promise<void> => {
  const queryParams = ListDocumentsQueryParams.safeParse(req.query);
  const conditions: SQL[] = [];

  if (queryParams.success && queryParams.data.engagementId != null) {
    conditions.push(eq(documentsTable.engagementId, queryParams.data.engagementId));
  }
  if (queryParams.success && queryParams.data.clientId != null) {
    conditions.push(eq(documentsTable.clientId, queryParams.data.clientId));
  }

  const q = firstQueryValue(req.query.q);
  if (typeof q === "string" && q.trim()) {
    if (q.length > 200) {
      res.status(400).json({ error: "q must be at most 200 characters" });
      return;
    }
    conditions.push(ilike(documentsTable.originalName, `%${escapeLike(q.trim())}%`));
  }

  const stage = firstQueryValue(req.query.stage);
  if (stage != null && stage !== "") {
    if (stage === "none") {
      conditions.push(isNull(documentsTable.stage));
    } else if (isDocumentStage(stage)) {
      conditions.push(eq(documentsTable.stage, stage));
    } else {
      res.status(400).json({ error: `Invalid stage. Must be one of: ${DOCUMENT_STAGES.join(", ")}, none` });
      return;
    }
  }

  const mimeType = firstQueryValue(req.query.mimeType);
  if (typeof mimeType === "string" && mimeType.trim()) {
    const prefixes = mimeType.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (prefixes.length > 10 || prefixes.some((p) => p.length > 100 || !/^[a-z0-9!#$&^_.+\/-]+$/.test(p))) {
      res.status(400).json({ error: "Invalid mimeType filter" });
      return;
    }
    const matches = prefixes.map((p) => ilike(documentsTable.mimeType, `${escapeLike(p)}%`));
    conditions.push(matches.length === 1 ? matches[0] : or(...matches)!);
  }

  const order = firstQueryValue(req.query.order);
  if (order != null && order !== "" && order !== "asc" && order !== "desc") {
    res.status(400).json({ error: "order must be asc or desc" });
    return;
  }

  const limit = parseOptionalInt(firstQueryValue(req.query.limit));
  const offset = parseOptionalInt(firstQueryValue(req.query.offset));
  if (Number.isNaN(limit) || (limit !== undefined && (limit < 1 || limit > MAX_DOCUMENT_PAGE))) {
    res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_DOCUMENT_PAGE}` });
    return;
  }
  if (Number.isNaN(offset)) {
    res.status(400).json({ error: "offset must be a non-negative integer" });
    return;
  }

  // Client accounts only ever see their own client's documents. An unlinked
  // client account has scope 0, which matches nothing.
  const scope = clientScope(req);
  if (scope !== null) {
    if (scope <= 0) {
      res.setHeader("X-Total-Count", "0");
      res.json([]);
      return;
    }
    conditions.push(eq(documentsTable.clientId, scope));
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const direction = order === "desc" ? desc : asc;
  let query = db
    .select()
    .from(documentsTable)
    .where(where)
    .orderBy(direction(documentsTable.createdAt), direction(documentsTable.id))
    .$dynamic();
  if (limit !== undefined) query = query.limit(limit);
  if (offset) query = query.offset(offset);
  const docs = await query;

  let total = docs.length;
  if (limit !== undefined || offset) {
    const [row] = await db.select({ n: count() }).from(documentsTable).where(where);
    total = Number(row?.n ?? 0);
  }
  res.setHeader("X-Total-Count", String(total));
  res.json(await serializeDocuments(docs));
});

router.post("/documents", requireStaff, async (req, res): Promise<void> => {
  const parsed = UploadDocumentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let engagementId: number | null = null;
  let clientId: number | null = null;
  if (parsed.data.engagementId != null) {
    const [eng] = await db
      .select()
      .from(engagementsTable)
      .where(eq(engagementsTable.id, parsed.data.engagementId));
    if (!eng) {
      res.status(400).json({ error: "Engagement not found" });
      return;
    }
    if (parsed.data.clientId != null && parsed.data.clientId !== eng.clientId) {
      res.status(400).json({ error: "clientId does not match the engagement's client" });
      return;
    }
    // Same lock rules as /documents/upload (this route never takes a stage).
    const lockError = uploadLockError(eng, null);
    if (lockError) {
      res.status(403).json({ error: lockError });
      return;
    }
    engagementId = eng.id;
    clientId = eng.clientId;
  } else if (parsed.data.clientId != null) {
    const [client] = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.id, parsed.data.clientId));
    if (!client) {
      res.status(400).json({ error: "Client not found" });
      return;
    }
    clientId = client.id;
  }

  // The stored filename and the content URL are always server-generated: a
  // client-supplied filename could point outside the uploads directory or at
  // another document's file (read via /content, unlinked on delete).
  const { filename: _ignoredFilename, fileUrl: _ignoredFileUrl, ...metadata } = parsed.data;
  const [inserted] = await db.insert(documentsTable).values({
    ...metadata,
    filename: makeStoredFilename(parsed.data.originalName),
    fileUrl: "pending",
    engagementId,
    clientId,
    uploadedBy: req.session.userId!,
    version: 1,
  }).returning();
  const [doc] = await db
    .update(documentsTable)
    .set({ fileUrl: `/api/documents/${inserted.id}/content` })
    .where(eq(documentsTable.id, inserted.id))
    .returning();

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

  const doc = await loadVisibleDocument(req, res, params.data.id);
  if (!doc) return;

  res.json(await serializeDocument(doc));
});

router.patch("/documents/:id", requireStaff, async (req, res): Promise<void> => {
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

  const [existing] = await db.select({ id: documentsTable.id }).from(documentsTable).where(eq(documentsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const [doc] = await db
    .update(documentsTable)
    .set({ description: parsed.data.description ?? null })
    .where(eq(documentsTable.id, params.data.id))
    .returning();

  res.json(await serializeDocument(doc));
});

router.delete("/documents/:id", requireStaff, async (req, res): Promise<void> => {
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
  // Guard: if the document's stage is locked (for_review or approved), block deletion
  if (existingDoc.engagementId) {
    const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, existingDoc.engagementId));
    if (eng) {
      const stageStatus = stageStatusOf(eng, existingDoc.stage);

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

// Only types a browser renders without running scripts are shown inline; anything
// else (HTML, SVG, XML, Office files, octet-stream, ...) is always downloaded.
const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
]);

/** Lower-cased "type/subtype" without parameters; octet-stream when unusable. */
function normalizeMimeType(raw: string | null | undefined): string {
  const base = String(raw ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : "application/octet-stream";
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 filename*. */
function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const name = filename || "download";
  const fallback = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ── GET /api/documents/:id/content ─────────────────────────────────────────
// Streams the actual file bytes, authenticated. Used by the file viewer.
router.get("/documents/:id/content", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const doc = await loadVisibleDocument(req, res, id);
  if (!doc) return;

  const stored = await getStoredFile(doc.filename, UPLOADS_DIR);
  if (!stored) {
    res.status(404).json({ error: "File not found in storage" });
    return;
  }

  const mimeType = normalizeMimeType(doc.mimeType);
  const disposition = INLINE_MIME_TYPES.has(mimeType) ? "inline" : "attachment";
  res.setHeader("Content-Type", mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", contentDisposition(disposition, doc.originalName));
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
