import { Router } from "express";
import { eq, and, gte, lt } from "drizzle-orm";
import { db, clientsTable, deadlinesTable } from "@workspace/db";
import {
  CreateClientBody,
  UpdateClientBody,
  GetClientParams,
  UpdateClientParams,
  DeleteClientParams,
  GenerateClientDeadlinesParams,
  GenerateClientDeadlinesBody,
  GetClientComplianceParams,
  GetClientComplianceQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

function serializeClient(c: typeof clientsTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    tin: c.tin,
    businessType: c.businessType,
    contactEmail: c.contactEmail ?? null,
    contactPhone: c.contactPhone ?? null,
    address: c.address ?? null,
    fiscalYearEnd: c.fiscalYearEnd ?? null,
    fiscalYearStart: c.fiscalYearStart ?? null,
    status: c.status,
    tradeName: c.tradeName ?? null,
    rdoCode: c.rdoCode ?? null,
    registrationDate: c.registrationDate ?? null,
    lineOfBusiness: c.lineOfBusiness ?? null,
    incomeTaxType: c.incomeTaxType ?? null,
    vatRegistered: c.vatRegistered,
    percentageTaxRegistered: c.percentageTaxRegistered,
    withholdsCompensation: c.withholdsCompensation,
    withholdsEwt: c.withholdsEwt,
    subjectToDst: c.subjectToDst,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// BIR Deadline generation logic
// ──────────────────────────────────────────────────────────────────────────

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function isoDate(year: number, month: number, day: number): string {
  // month is 1-based
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toISOString().slice(0, 10);
}

function monthIndex(name: string): number {
  const idx = MONTHS.findIndex(m => m.toLowerCase() === name.toLowerCase());
  return idx >= 0 ? idx + 1 : 1;
}

// BIR quarter ending months relative to fiscal year start
// Each quarter = 3 months; quarters end at month 3, 6, 9, 12 of fiscal year
function fiscalQuarterMonths(fyStart: number): number[][] {
  const quarters: number[][] = [];
  for (let q = 0; q < 4; q++) {
    const endMonth = ((fyStart - 1 + (q + 1) * 3 - 1) % 12) + 1;
    const y_offset = Math.floor((fyStart - 1 + (q + 1) * 3 - 1) / 12);
    quarters.push([endMonth, y_offset]);
  }
  return quarters;
}

interface GeneratedDeadline {
  title: string;
  description: string;
  dueDate: string;
  priority: "high" | "medium" | "low";
  category: string;
}

function generateBIRDeadlines(client: typeof clientsTable.$inferSelect, year: number): GeneratedDeadline[] {
  const deadlines: GeneratedDeadline[] = [];
  const fyStartMonth = client.fiscalYearStart ? monthIndex(client.fiscalYearStart) : 1;
  const calYear = fyStartMonth === 1; // calendar year taxpayer

  // ── MONTHLY FORMS ──────────────────────────────────────────────────────

  // 2550M: Monthly VAT Return — due 20th of following month
  if (client.vatRegistered) {
    for (let m = 1; m <= 12; m++) {
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear = m === 12 ? year + 1 : year;
      const period = `${MONTHS[m - 1]} ${year}`;
      deadlines.push({
        title: `BIR Form 2550M — ${period}`,
        description: `Monthly VAT Return for ${period}. Due 20th of the following month.`,
        dueDate: isoDate(dueYear, dueMonth, 20),
        priority: "high",
        category: "VAT",
      });
    }
  }

  // 1601C: Monthly Withholding on Compensation — due 10th of following month
  if (client.withholdsCompensation) {
    for (let m = 1; m <= 12; m++) {
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear = m === 12 ? year + 1 : year;
      const period = `${MONTHS[m - 1]} ${year}`;
      deadlines.push({
        title: `BIR Form 1601C — ${period}`,
        description: `Monthly Remittance Return of Income Taxes Withheld on Compensation for ${period}.`,
        dueDate: isoDate(dueYear, dueMonth, 10),
        priority: "high",
        category: "Withholding Tax",
      });
    }
  }

  // 2000: Documentary Stamp Tax — due 5th of following month
  if (client.subjectToDst) {
    for (let m = 1; m <= 12; m++) {
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear = m === 12 ? year + 1 : year;
      const period = `${MONTHS[m - 1]} ${year}`;
      deadlines.push({
        title: `BIR Form 2000 — ${period}`,
        description: `Documentary Stamp Tax Declaration/Return for ${period}.`,
        dueDate: isoDate(dueYear, dueMonth, 5),
        priority: "medium",
        category: "DST",
      });
    }
  }

  // ── QUARTERLY FORMS ────────────────────────────────────────────────────

  const quarters = fiscalQuarterMonths(fyStartMonth);

  quarters.forEach(([endMonth, yOff], qIdx) => {
    const qYear = year + yOff;
    const qLabel = `Q${qIdx + 1} ${year}`;

    // 2550Q: Quarterly VAT — due 25th of following month after quarter end
    if (client.vatRegistered) {
      const dueMonth = endMonth === 12 ? 1 : endMonth + 1;
      const dueYear = endMonth === 12 ? qYear + 1 : qYear;
      deadlines.push({
        title: `BIR Form 2550Q — ${qLabel}`,
        description: `Quarterly VAT Return for ${qLabel}. Due 25th of the month following quarter end.`,
        dueDate: isoDate(dueYear, dueMonth, 25),
        priority: "high",
        category: "VAT",
      });
    }

    // 2551Q: Quarterly Percentage Tax — due 25th of following month after quarter
    if (client.percentageTaxRegistered) {
      const dueMonth = endMonth === 12 ? 1 : endMonth + 1;
      const dueYear = endMonth === 12 ? qYear + 1 : qYear;
      deadlines.push({
        title: `BIR Form 2551Q — ${qLabel}`,
        description: `Quarterly Percentage Tax Return for ${qLabel}.`,
        dueDate: isoDate(dueYear, dueMonth, 25),
        priority: "medium",
        category: "Percentage Tax",
      });
    }

    // 1601EQ: Quarterly EWT — due last day of month following quarter end
    if (client.withholdsEwt) {
      const dueMonth = endMonth === 12 ? 1 : endMonth + 1;
      const dueYear = endMonth === 12 ? qYear + 1 : qYear;
      // last day of that month
      const lastDay = new Date(Date.UTC(dueYear, dueMonth, 0)).getUTCDate();
      deadlines.push({
        title: `BIR Form 1601EQ — ${qLabel}`,
        description: `Quarterly Remittance Return of Creditable Income Taxes Withheld (EWT) for ${qLabel}.`,
        dueDate: isoDate(dueYear, dueMonth, lastDay),
        priority: "high",
        category: "Withholding Tax",
      });
    }

    // 1702Q: Quarterly Corporate ITR — 60 days after quarter end
    if (client.incomeTaxType === "corporate") {
      const quarterEndDate = new Date(Date.UTC(qYear, endMonth - 1, 1));
      quarterEndDate.setUTCMonth(quarterEndDate.getUTCMonth() + 1);
      quarterEndDate.setUTCDate(0); // last day of quarter end month
      const dueDate = new Date(quarterEndDate);
      dueDate.setUTCDate(dueDate.getUTCDate() + 60);
      // Skip Q4 as it's covered by the annual ITR
      if (qIdx < 3) {
        deadlines.push({
          title: `BIR Form 1702Q — ${qLabel}`,
          description: `Quarterly Income Tax Return for Corporations (${qLabel}).`,
          dueDate: dueDate.toISOString().slice(0, 10),
          priority: "high",
          category: "Income Tax",
        });
      }
    }

    // 1701Q: Quarterly Individual ITR — 60 days after quarter end
    if (client.incomeTaxType === "individual") {
      const quarterEndDate = new Date(Date.UTC(qYear, endMonth - 1, 1));
      quarterEndDate.setUTCMonth(quarterEndDate.getUTCMonth() + 1);
      quarterEndDate.setUTCDate(0);
      const dueDate = new Date(quarterEndDate);
      dueDate.setUTCDate(dueDate.getUTCDate() + 60);
      if (qIdx < 3) {
        deadlines.push({
          title: `BIR Form 1701Q — ${qLabel}`,
          description: `Quarterly Income Tax Return for Individuals (${qLabel}).`,
          dueDate: dueDate.toISOString().slice(0, 10),
          priority: "high",
          category: "Income Tax",
        });
      }
    }
  });

  // ── ANNUAL FORMS ───────────────────────────────────────────────────────

  // 1702: Annual Corporate ITR — 15th of 4th month after FY end
  if (client.incomeTaxType === "corporate") {
    const fyEnd = client.fiscalYearEnd ? monthIndex(client.fiscalYearEnd) : 12;
    const dueMonth = ((fyEnd + 3) % 12) + 1 || 12;
    const dueYear = fyEnd + 3 > 12 ? year + 1 : year;
    deadlines.push({
      title: `BIR Form 1702 (Annual Corporate ITR) — FY ${year}`,
      description: `Annual Income Tax Return for Corporations for Fiscal Year ${year}. Due 15th of the 4th month after fiscal year end.`,
      dueDate: isoDate(dueYear, dueMonth, 15),
      priority: "high",
      category: "Income Tax",
    });

    // 1702RT/EX/MX attachment
    deadlines.push({
      title: `Audited Financial Statements — FY ${year}`,
      description: `AFS must be submitted with the Annual ITR. Ensure statements are audited and signed by a CPA.`,
      dueDate: isoDate(dueYear, dueMonth, 15),
      priority: "high",
      category: "Income Tax",
    });
  }

  // 1701: Annual Individual ITR — April 15 for calendar year, or 15th of 4th month after FY end
  if (client.incomeTaxType === "individual") {
    const fyEnd = client.fiscalYearEnd ? monthIndex(client.fiscalYearEnd) : 12;
    const dueMonth = calYear ? 4 : (((fyEnd + 3) % 12) + 1 || 12);
    const dueYear = !calYear && fyEnd + 3 > 12 ? year + 1 : year;
    deadlines.push({
      title: `BIR Form 1701 (Annual Individual ITR) — FY ${year}`,
      description: `Annual Income Tax Return for Individuals for Fiscal Year ${year}. Due April 15 (calendar year) or 15th of 4th month after fiscal year end.`,
      dueDate: isoDate(dueYear, dueMonth, 15),
      priority: "high",
      category: "Income Tax",
    });
  }

  // 1604CF: Annual Information Return on Compensation — due March 1
  if (client.withholdsCompensation) {
    deadlines.push({
      title: `BIR Form 1604CF — Annual ${year}`,
      description: `Annual Information Return of Income Tax Withheld on Compensation for ${year}. Due March 1 of the following year.`,
      dueDate: isoDate(year + 1, 3, 1),
      priority: "medium",
      category: "Withholding Tax",
    });
    // Alphalist of Employees
    deadlines.push({
      title: `Alphalist of Employees (1604CF Attachment) — ${year}`,
      description: `Alphabetical List of Employees from whom income taxes have been withheld. Due with Form 1604CF.`,
      dueDate: isoDate(year + 1, 3, 1),
      priority: "medium",
      category: "Withholding Tax",
    });
  }

  // 1604E: Annual Information Return on EWT — due March 1
  if (client.withholdsEwt) {
    deadlines.push({
      title: `BIR Form 1604E — Annual ${year}`,
      description: `Annual Information Return of Creditable Income Taxes Withheld (Expanded) for ${year}. Due March 1 of the following year.`,
      dueDate: isoDate(year + 1, 3, 1),
      priority: "medium",
      category: "Withholding Tax",
    });
  }

  return deadlines;
}

// ──────────────────────────────────────────────────────────────────────────
// Compliance checklist generation (computed, no DB writes)
// ──────────────────────────────────────────────────────────────────────────

interface ComplianceItem {
  formNumber: string;
  description: string;
  period: string;
  dueDate: string;
  frequency: "monthly" | "quarterly" | "annual";
  status: "pending" | "filed" | "overdue";
  deadlineId: number | null;
}

const FREQUENCY_MAP: Record<string, "monthly" | "quarterly" | "annual"> = {
  "2550M": "monthly",
  "2550Q": "quarterly",
  "2551Q": "quarterly",
  "1601C": "monthly",
  "1601EQ": "quarterly",
  "1604CF": "annual",
  "1604E": "annual",
  "1702": "annual",
  "1702Q": "quarterly",
  "1701": "annual",
  "1701Q": "quarterly",
  "2000": "monthly",
  "AFS": "annual",
  "Alphalist": "annual",
};

function extractFormNumber(title: string): string {
  const match = title.match(/BIR Form (\w+)/);
  if (match) return match[1];
  if (title.includes("Audited Financial Statements") || title.includes("AFS")) return "AFS";
  if (title.includes("Alphalist")) return "Alphalist";
  return "OTHER";
}

function extractPeriod(title: string): string {
  const match = title.match(/(Q\d \d{4}|January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})|FY (\d{4})|Annual (\d{4})/);
  if (match) return match[0];
  return title;
}

async function buildComplianceItems(
  client: typeof clientsTable.$inferSelect,
  year: number
): Promise<ComplianceItem[]> {
  const required = generateBIRDeadlines(client, year);
  if (required.length === 0) return [];

  // Fetch existing deadlines for this client/year
  const yearStart = isoDate(year, 1, 1);
  const yearEnd = isoDate(year + 1, 1, 1);
  const existing = await db
    .select()
    .from(deadlinesTable)
    .where(
      and(
        eq(deadlinesTable.clientId, client.id),
        gte(deadlinesTable.dueDate, yearStart),
        lt(deadlinesTable.dueDate, yearEnd)
      )
    );

  const now = new Date();

  return required.map(req => {
    const formNumber = extractFormNumber(req.title);
    const period = extractPeriod(req.title);
    const frequency = FREQUENCY_MAP[formNumber] || "annual";

    // Match to existing deadline by title similarity
    const matched = existing.find(e => e.title === req.title);
    let status: "pending" | "filed" | "overdue" = "pending";
    if (matched?.status === "completed") {
      status = "filed";
    } else if (new Date(req.dueDate) < now) {
      status = "overdue";
    }

    return {
      formNumber,
      description: req.description,
      period,
      dueDate: req.dueDate,
      frequency,
      status,
      deadlineId: matched?.id ?? null,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────

router.get("/clients", requireAuth, async (req, res): Promise<void> => {
  const clients = await db.select().from(clientsTable).orderBy(clientsTable.name);
  res.json(clients.map(serializeClient));
});

router.post("/clients", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db.insert(clientsTable).values(parsed.data).returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "client",
    entityId: client.id,
    description: `Created client ${client.name} (TIN: ${client.tin})`,
  });

  res.status(201).json(serializeClient(client));
});

router.get("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(serializeClient(client));
});

router.patch("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof clientsTable.$inferInsert> = {};
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.tin != null) updates.tin = parsed.data.tin;
  if (parsed.data.businessType != null) updates.businessType = parsed.data.businessType;
  if ("contactEmail" in parsed.data) updates.contactEmail = parsed.data.contactEmail ?? null;
  if ("contactPhone" in parsed.data) updates.contactPhone = parsed.data.contactPhone ?? null;
  if ("address" in parsed.data) updates.address = parsed.data.address ?? null;
  if ("fiscalYearEnd" in parsed.data) updates.fiscalYearEnd = parsed.data.fiscalYearEnd ?? null;
  if ("fiscalYearStart" in parsed.data) updates.fiscalYearStart = parsed.data.fiscalYearStart ?? null;
  if (parsed.data.status != null) updates.status = parsed.data.status;
  if ("tradeName" in parsed.data) updates.tradeName = parsed.data.tradeName ?? null;
  if ("rdoCode" in parsed.data) updates.rdoCode = parsed.data.rdoCode ?? null;
  if ("registrationDate" in parsed.data) updates.registrationDate = parsed.data.registrationDate ?? null;
  if ("lineOfBusiness" in parsed.data) updates.lineOfBusiness = parsed.data.lineOfBusiness ?? null;
  if ("incomeTaxType" in parsed.data) updates.incomeTaxType = parsed.data.incomeTaxType ?? null;
  if (parsed.data.vatRegistered != null) updates.vatRegistered = parsed.data.vatRegistered;
  if (parsed.data.percentageTaxRegistered != null) updates.percentageTaxRegistered = parsed.data.percentageTaxRegistered;
  if (parsed.data.withholdsCompensation != null) updates.withholdsCompensation = parsed.data.withholdsCompensation;
  if (parsed.data.withholdsEwt != null) updates.withholdsEwt = parsed.data.withholdsEwt;
  if (parsed.data.subjectToDst != null) updates.subjectToDst = parsed.data.subjectToDst;

  const [client] = await db.update(clientsTable).set(updates).where(eq(clientsTable.id, params.data.id)).returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "client",
    entityId: client.id,
    description: `Updated client ${client.name}`,
  });

  res.json(serializeClient(client));
});

router.delete("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.delete(clientsTable).where(eq(clientsTable.id, params.data.id)).returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "client",
    entityId: params.data.id,
    description: `Deleted client ${client.name}`,
  });

  res.sendStatus(204);
});

// POST /clients/:id/generate-deadlines
router.post("/clients/:id/generate-deadlines", requireAuth, requireRole("accountant", "manager"), async (req, res): Promise<void> => {
  const params = GenerateClientDeadlinesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = GenerateClientDeadlinesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const year = parsed.data.year;
  const overwrite = parsed.data.overwrite ?? false;

  if (overwrite) {
    // Delete existing auto-generated deadlines for this client/year
    const yearStart = isoDate(year, 1, 1);
    const yearEnd = isoDate(year + 1, 1, 1);
    await db
      .delete(deadlinesTable)
      .where(
        and(
          eq(deadlinesTable.clientId, client.id),
          gte(deadlinesTable.dueDate, yearStart),
          lt(deadlinesTable.dueDate, yearEnd)
        )
      );
  }

  const deadlines = generateBIRDeadlines(client, year);

  if (deadlines.length === 0) {
    res.json({ created: 0, message: "No tax types registered. Please update the client's BIR 2303 information first." });
    return;
  }

  const inserted = await db.insert(deadlinesTable).values(
    deadlines.map(d => ({
      clientId: client.id,
      engagementId: null,
      title: d.title,
      description: d.description,
      dueDate: d.dueDate,
      priority: d.priority,
      status: "pending",
    }))
  ).returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "deadline",
    entityId: client.id,
    description: `Auto-generated ${inserted.length} BIR deadlines for ${client.name} (FY ${year})`,
  });

  res.json({
    created: inserted.length,
    message: `Successfully generated ${inserted.length} BIR deadline entries for FY ${year}.`,
  });
});

// GET /clients/:id/compliance
router.get("/clients/:id/compliance", requireAuth, async (req, res): Promise<void> => {
  const params = GetClientComplianceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const qParams = GetClientComplianceQueryParams.safeParse(req.query);
  const year = qParams.success && qParams.data.year ? qParams.data.year : new Date().getFullYear();

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const items = await buildComplianceItems(client, year);

  const summary = {
    total: items.length,
    filed: items.filter(i => i.status === "filed").length,
    pending: items.filter(i => i.status === "pending").length,
    overdue: items.filter(i => i.status === "overdue").length,
  };

  res.json({
    clientId: client.id,
    clientName: client.name,
    year,
    items,
    summary,
  });
});

export default router;
