import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq } from "drizzle-orm";
import { db, documentsTable, engagementsTable, clientsTable } from "@workspace/db";
import { requireStaff, requireManager } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { saveFileToStorage } from "../lib/fileStore";

export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.resolve(process.cwd(), "../../uploads");

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const DOCUMENT_STAGES = ["source_collection", "draft_return", "confirmation", "payment"] as const;
export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

export function isDocumentStage(value: unknown): value is DocumentStage {
  return typeof value === "string" && (DOCUMENT_STAGES as readonly string[]).includes(value);
}

/** The workflow status of one stage of an engagement. */
export function stageStatusOf(
  eng: typeof engagementsTable.$inferSelect,
  stage: string | null | undefined,
): string | null {
  switch (stage) {
    case "source_collection": return eng.sourceCollectionStatus;
    case "draft_return": return eng.draftReturnStatus;
    case "confirmation": return eng.confirmationStatus;
    case "payment": return eng.paymentStatus;
    default: return null;
  }
}

/**
 * Documents in a stage that is awaiting review or already approved are frozen,
 * as is everything in a completed filing. Returns the error to send (403), or
 * null when the stage may be changed.
 */
export function uploadLockError(
  eng: typeof engagementsTable.$inferSelect,
  stage: string | null | undefined,
): string | null {
  const stageStatus = stageStatusOf(eng, stage);
  if (stageStatus === "for_review") {
    return "Cannot upload documents to a stage that is pending manager approval.";
  }
  if (stageStatus === "approved") {
    return "Cannot upload documents to an approved stage. The manager must undo the approval first.";
  }
  if (eng.status === "completed") {
    return "Cannot upload documents to a completed filing. Amend the filing instead.";
  }
  return null;
}

/** Parses an optional positive integer form field. undefined = absent, NaN = invalid. */
function parseOptionalId(value: unknown): number | undefined {
  if (value == null || value === "" || value === "null") return undefined;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : NaN;
}

export function makeStoredFilename(originalname: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = path.extname(originalname);
  return `${unique}${ext}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "text/plain",
      "text/csv",
      "application/octet-stream", // .dat files often come through as octet-stream
    ];
    // Also allow by extension for .dat and .csv files regardless of reported MIME
    const ext = (file.originalname.split(".").pop() || "").toLowerCase();
    if (allowed.includes(file.mimetype) || ext === "dat" || ext === "csv") {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const router = Router();

// ── POST /api/documents/upload ──────────────────────────────────────────────
router.post("/documents/upload", requireStaff, upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  // ── Validate everything before any bytes reach storage ──────────────────
  const rawEngagementId = parseOptionalId(req.body.engagementId);
  const rawClientId = parseOptionalId(req.body.clientId);
  if (Number.isNaN(rawEngagementId)) {
    res.status(400).json({ error: "Invalid engagementId" });
    return;
  }
  if (Number.isNaN(rawClientId)) {
    res.status(400).json({ error: "Invalid clientId" });
    return;
  }

  const description = typeof req.body.description === "string" ? req.body.description.trim() || null : null;
  const stageInput = typeof req.body.stage === "string" ? req.body.stage.trim() : "";
  const stage = stageInput || null;
  if (stage !== null && !isDocumentStage(stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${DOCUMENT_STAGES.join(", ")}` });
    return;
  }

  let engagementId: number | null = null;
  let clientId: number | null = null;

  if (rawEngagementId !== undefined) {
    const [eng] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, rawEngagementId));
    if (!eng) {
      res.status(400).json({ error: "Engagement not found" });
      return;
    }
    if (rawClientId !== undefined && rawClientId !== eng.clientId) {
      res.status(400).json({ error: "clientId does not match the engagement's client" });
      return;
    }
    const lockError = uploadLockError(eng, stage);
    if (lockError) {
      res.status(403).json({ error: lockError });
      return;
    }
    engagementId = eng.id;
    clientId = eng.clientId;
  } else if (rawClientId !== undefined) {
    const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, rawClientId));
    if (!client) {
      res.status(400).json({ error: "Client not found" });
      return;
    }
    clientId = client.id;
  }

  const storedFilename = makeStoredFilename(req.file.originalname);

  // Persist file bytes durably (object storage in all environments;
  // falls back to local disk only if object storage is unavailable).
  try {
    await saveFileToStorage(storedFilename, req.file.buffer, req.file.mimetype);
  } catch (err) {
    if (process.env.PRIVATE_OBJECT_DIR) {
      console.error("Object storage write failed:", err);
      res.status(500).json({ error: "Failed to store file" });
      return;
    }
    // No object storage configured — write to local disk instead
    fs.writeFileSync(path.join(UPLOADS_DIR, storedFilename), req.file.buffer);
  }

  const [doc] = await db.insert(documentsTable).values({
    filename: storedFilename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
    fileUrl: `pending`, // updated immediately below
    description,
    engagementId,
    clientId,
    uploadedBy: req.session.userId!,
    version: 1,
    stage,
  }).returning();

  // Update fileUrl now that we have the real ID
  const [updated] = await db.update(documentsTable)
    .set({ fileUrl: `/api/documents/${doc.id}/content` })
    .where(eq(documentsTable.id, doc.id))
    .returning();

  await logAudit({
    userId: req.session.userId,
    action: "upload",
    entityType: "document",
    entityId: doc.id,
    description: `Uploaded file "${req.file.originalname}" (${(req.file.size / 1024).toFixed(1)} KB)`,
  });

  res.status(201).json({
    id: updated.id,
    filename: updated.filename,
    originalName: updated.originalName,
    mimeType: updated.mimeType,
    fileSize: updated.fileSize,
    fileUrl: updated.fileUrl,
    description: updated.description,
    engagementId: updated.engagementId,
    clientId: updated.clientId,
    version: updated.version,
    uploadedBy: updated.uploadedBy,
    stage: updated.stage ?? null,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

// ── POST /api/documents/seed-samples ─────────────────────────────────────────
// Creates sample PDF, Excel, and Word files in the database for testing.
router.post("/documents/seed-samples", requireManager, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const created: string[] = [];

  try {
    // ── 1. Sample PDF ──────────────────────────────────────────────────────
    const pdfFilename = `sample-bir-2303-${Date.now()}.pdf`;
    const pdfPath = path.join(UPLOADS_DIR, pdfFilename);

    await new Promise<void>((resolve, reject) => {
      // Dynamic import to avoid esbuild bundling issues
      import("pdfkit").then(({ default: PDFDocument }) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);

        // Header
        doc.fontSize(18).fillColor("#1a365d").text("BIR FORM 2303", { align: "center" });
        doc.fontSize(13).fillColor("#2d3748").text("Certificate of Registration", { align: "center" });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#cbd5e0").stroke();
        doc.moveDown(0.8);

        // Content
        doc.fontSize(11).fillColor("#000");
        const fields = [
          ["Taxpayer Identification No. (TIN):", "123-456-789-000"],
          ["Registered Name:", "Reyes Enterprises, Inc."],
          ["Trade/Business Name:", "Reyes Ent."],
          ["RDO Code:", "047 – Makati"],
          ["Date of Registration:", "January 15, 2015"],
          ["Registered Address:", "123 Ayala Avenue, Makati City, Metro Manila"],
          ["Line of Business:", "IT Services and Consultancy"],
        ];
        fields.forEach(([label, value]) => {
          doc.font("Helvetica-Bold").text(label, { continued: true });
          doc.font("Helvetica").text(` ${value}`);
          doc.moveDown(0.3);
        });

        doc.moveDown(0.8);
        doc.font("Helvetica-Bold").fontSize(11).text("Registered Tax Types (as per BIR 2303):");
        doc.moveDown(0.3);
        const taxTypes = ["☑ VAT — Form 2550M (monthly) / 2550Q (quarterly)", "☑ Income Tax — Corporate (Form 1702 / 1702Q)", "☑ Withholding Tax on Compensation — Form 1601C / 1604CF", "☑ Expanded Withholding Tax (EWT) — Form 1601EQ / 1604E"];
        taxTypes.forEach(t => { doc.font("Helvetica").fontSize(10).text(t); doc.moveDown(0.3); });

        doc.moveDown(1);
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#718096").text("This is a sample document generated by BIR TaxCMS for testing and demonstration purposes only.", { align: "center" });

        doc.end();
        stream.on("finish", resolve);
        stream.on("error", reject);
      }).catch(reject);
    });

    const pdfStat = fs.statSync(pdfPath);
    try { await saveFileToStorage(pdfFilename, fs.readFileSync(pdfPath), "application/pdf"); } catch { /* local dev fallback */ }
    const [pdfDoc] = await db.insert(documentsTable).values({
      filename: pdfFilename, originalName: "BIR_Form_2303_Sample.pdf",
      mimeType: "application/pdf", fileSize: pdfStat.size,
      fileUrl: `/api/documents/0/content`, description: "Sample BIR Certificate of Registration (Form 2303)",
      uploadedBy: userId, version: 1,
    }).returning();
    await db.update(documentsTable).set({ fileUrl: `/api/documents/${pdfDoc.id}/content` }).where(eq(documentsTable.id, pdfDoc.id));
    created.push(pdfDoc.originalName);

    // ── 2. Sample Excel ────────────────────────────────────────────────────
    const { utils, write } = await import("xlsx");
    const xlsxFilename = `sample-tax-calendar-${Date.now()}.xlsx`;
    const xlsxPath = path.join(UPLOADS_DIR, xlsxFilename);

    const deadlinesData = [
      ["Form", "Description", "Period", "Due Date", "Status"],
      ["BIR 2550M", "Monthly VAT Return", "January 2025", "February 20, 2025", "Filed"],
      ["BIR 2550M", "Monthly VAT Return", "February 2025", "March 20, 2025", "Filed"],
      ["BIR 2550M", "Monthly VAT Return", "March 2025", "April 20, 2025", "Filed"],
      ["BIR 2550Q", "Quarterly VAT Return", "Q1 2025", "April 25, 2025", "Filed"],
      ["BIR 1601C", "Withholding Tax - Compensation", "January 2025", "February 10, 2025", "Filed"],
      ["BIR 1601C", "Withholding Tax - Compensation", "February 2025", "March 10, 2025", "Filed"],
      ["BIR 1601C", "Withholding Tax - Compensation", "March 2025", "April 10, 2025", "Filed"],
      ["BIR 1702Q", "Quarterly Corporate ITR", "Q1 2025", "May 29, 2025", "Pending"],
      ["BIR 1601EQ", "Quarterly EWT Return", "Q1 2025", "April 30, 2025", "Filed"],
      ["BIR 2550M", "Monthly VAT Return", "April 2025", "May 20, 2025", "Pending"],
      ["BIR 1601C", "Withholding Tax - Compensation", "April 2025", "May 10, 2025", "Pending"],
    ];
    const ws = utils.aoa_to_sheet(deadlinesData);
    ws["!cols"] = [{ wch: 14 }, { wch: 36 }, { wch: 16 }, { wch: 22 }, { wch: 12 }];
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "BIR Tax Calendar");

    const summaryData = [
      ["Client", "TIN", "Total Filings", "Filed", "Pending", "Overdue"],
      ["Reyes Enterprises, Inc.", "123-456-789-000", 35, 22, 10, 3],
      ["Santos Trading Co.", "987-654-321-000", 24, 18, 6, 0],
      ["Dela Cruz & Associates", "111-222-333-444", 12, 8, 4, 0],
    ];
    const ws2 = utils.aoa_to_sheet(summaryData);
    ws2["!cols"] = [{ wch: 28 }, { wch: 20 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 10 }];
    utils.book_append_sheet(wb, ws2, "Client Summary");
    const xlsxBuffer = write(wb, { type: "buffer", bookType: "xlsx" });
    fs.writeFileSync(xlsxPath, xlsxBuffer);
    try { await saveFileToStorage(xlsxFilename, xlsxBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); } catch { /* local dev fallback */ }

    const [xlsxDoc] = await db.insert(documentsTable).values({
      filename: xlsxFilename, originalName: "BIR_Tax_Calendar_2025.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSize: xlsxBuffer.length,
      fileUrl: `/api/documents/0/content`, description: "Annual BIR filing calendar and client compliance summary for 2025",
      uploadedBy: userId, version: 1,
    }).returning();
    await db.update(documentsTable).set({ fileUrl: `/api/documents/${xlsxDoc.id}/content` }).where(eq(documentsTable.id, xlsxDoc.id));
    created.push(xlsxDoc.originalName);

    // ── 3. Sample Word Document ────────────────────────────────────────────
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, BorderStyle, WidthType } = await import("docx");
    const docxFilename = `sample-engagement-memo-${Date.now()}.docx`;
    const docxPath = path.join(UPLOADS_DIR, docxFilename);

    const wordDoc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({ text: "ENGAGEMENT MEMORANDUM", heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
          new Paragraph({ text: "BIR Annual Income Tax Return Preparation", heading: HeadingLevel.HEADING_2, alignment: AlignmentType.CENTER }),
          new Paragraph({ text: "" }),
          new Paragraph({ children: [new TextRun({ text: "Client: ", bold: true }), new TextRun("Reyes Enterprises, Inc.")] }),
          new Paragraph({ children: [new TextRun({ text: "TIN: ", bold: true }), new TextRun("123-456-789-000")] }),
          new Paragraph({ children: [new TextRun({ text: "Fiscal Year: ", bold: true }), new TextRun("January 1, 2024 – December 31, 2024")] }),
          new Paragraph({ children: [new TextRun({ text: "Prepared by: ", bold: true }), new TextRun("Juan Dela Cruz, CPA")] }),
          new Paragraph({ children: [new TextRun({ text: "Date: ", bold: true }), new TextRun("April 1, 2025")] }),
          new Paragraph({ text: "" }),
          new Paragraph({ text: "1. SCOPE OF ENGAGEMENT", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "This engagement covers the preparation and filing of the Annual Income Tax Return (BIR Form 1702-RT) for Reyes Enterprises, Inc. for the taxable year ended December 31, 2024." }),
          new Paragraph({ text: "" }),
          new Paragraph({ text: "2. DOCUMENTS REQUIRED", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "The following documents are required for the completion of this engagement:" }),
          new Paragraph({ text: "• Audited Financial Statements (Balance Sheet and Income Statement)", bullet: { level: 0 } }),
          new Paragraph({ text: "• General Ledger and Trial Balance", bullet: { level: 0 } }),
          new Paragraph({ text: "• BIR-stamped copy of prior year's ITR (Form 1702)", bullet: { level: 0 } }),
          new Paragraph({ text: "• Quarterly ITR filings (Forms 1702Q for Q1-Q3)", bullet: { level: 0 } }),
          new Paragraph({ text: "• Summary of all withholding tax certificates (2307) received", bullet: { level: 0 } }),
          new Paragraph({ text: "" }),
          new Paragraph({ text: "3. FILING DEADLINE", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "The Annual ITR (Form 1702) is due on April 15, 2025. Extensions may be available upon filing of BIR Form 1702 with the required attachments." }),
          new Paragraph({ text: "" }),
          new Paragraph({ text: "4. FEES AND BILLING", heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: "Professional fees for this engagement are billed at a fixed rate as agreed in the Engagement Letter dated January 10, 2025." }),
          new Paragraph({ text: "" }),
          new Paragraph({ children: [new TextRun({ text: "Note: ", bold: true, italics: true }), new TextRun({ text: "This is a sample engagement memorandum generated by BIR TaxCMS for testing and demonstration purposes only.", italics: true })] }),
        ],
      }],
    });

    const docxBuffer = await Packer.toBuffer(wordDoc);
    fs.writeFileSync(docxPath, docxBuffer);
    try { await saveFileToStorage(docxFilename, docxBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); } catch { /* local dev fallback */ }

    const [docxDoc] = await db.insert(documentsTable).values({
      filename: docxFilename, originalName: "Engagement_Memo_Reyes_Enterprises_2024.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileSize: docxBuffer.length,
      fileUrl: `/api/documents/0/content`, description: "Engagement memorandum for annual ITR preparation – Reyes Enterprises FY 2024",
      uploadedBy: userId, version: 1,
    }).returning();
    await db.update(documentsTable).set({ fileUrl: `/api/documents/${docxDoc.id}/content` }).where(eq(documentsTable.id, docxDoc.id));
    created.push(docxDoc.originalName);

    res.json({ message: `Created ${created.length} sample documents`, files: created });
  } catch (err: any) {
    console.error("Seed error:", err);
    res.status(500).json({ error: err?.message || "Failed to create sample files" });
  }
});

export default router;
