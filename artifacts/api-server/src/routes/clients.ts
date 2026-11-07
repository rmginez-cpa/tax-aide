import { Router } from "express";
import { eq, and, ne, or, inArray, notInArray, isNull, count } from "drizzle-orm";
import { db, clientsTable, deadlinesTable, engagementsTable, documentsTable } from "@workspace/db";
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
import { requireAuth, requireStaff, requireManager, clientScope, canAccessClient } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { manilaToday, manilaYear, addDays } from "../lib/dates";
import { adjustDueDate } from "../lib/birCalendar";
import { openDeadlines } from "../lib/openDeadlines";

const router = Router();

export function serializeClient(c: typeof clientsTable.$inferSelect) {
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
    withholdsFinal: c.withholdsFinal,
    hasInventory: c.hasInventory,
    isLessor: c.isLessor,
    isEsalesRequired: c.isEsalesRequired,
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

/**
 * A day of the month after (year, month): `day` or "last" for its last day.
 * month is 1-based; month 0 means December of the previous year.
 */
function monthAfter(year: number, month: number, day: number | "last"): string {
  const y = month >= 12 ? year + 1 : year;
  const m = month >= 12 ? 1 : month + 1;
  return day === "last" ? isoDate(y, m + 1, 0) : isoDate(y, m, day);
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

/**
 * The client's fiscal year as months (1-12). The end month is derived from the
 * start month so the two can never disagree; fiscalYearEnd is only used when
 * no start month is recorded.
 */
function fiscalYearMonths(client: typeof clientsTable.$inferSelect): { fyStart: number; fyEnd: number } {
  const fyStart = client.fiscalYearStart
    ? monthIndex(client.fiscalYearStart)
    : client.fiscalYearEnd
      ? (monthIndex(client.fiscalYearEnd) % 12) + 1
      : 1;
  return { fyStart, fyEnd: fyStart === 1 ? 12 : fyStart - 1 };
}

/**
 * The BIR filings of tax year `year`.
 *
 * Tax year Y means:
 * - corporate income tax (1702Q, annual 1702 + AFS), VAT (2550Q, SLS/SLP),
 *   percentage tax (2551Q) and the inventory list: the client's taxable year
 *   that STARTS in Y (the calendar year Y for calendar-year clients). Its
 *   quarters are the fiscal quarters, and the annual return of that same
 *   fiscal year is due the 15th of the 4th month after it ends.
 * - individual income tax (1701Q, 1701): always the calendar year Y.
 *   Individuals cannot use a fiscal year (NIRC Sec. 43/74), so a fiscal-year
 *   setting on an individual client is ignored for these two forms.
 * - withholding taxes (1601C, 0619E/1601EQ, 0619F/1601FQ, QAP, 1604C/E/F,
 *   2316, Annex C/F), DST (2000), eSales and the lessee statement: always the
 *   calendar year Y with calendar quarters, whatever the client's fiscal year.
 * Every title therefore carries Y in its period label.
 *
 * Every statutory date is then moved to the next working day when it falls on
 * a Saturday, Sunday or holiday (RMC 65-2016; see lib/birCalendar.ts), and the
 * description says so. The rules and their issuances are listed in replit.md.
 */
export function generateBIRDeadlines(client: typeof clientsTable.$inferSelect, year: number): GeneratedDeadline[] {
  const deadlines: GeneratedDeadline[] = [];
  const { fyStart: fyStartMonth, fyEnd: fyEndMonth } = fiscalYearMonths(client);
  // The fiscal year that starts in `year` ends in fyEndMonth of fyEndYear.
  const fyEndYear = fyStartMonth === 1 ? year : year + 1;
  const fyLabel = fyStartMonth === 1
    ? `calendar year ${year}`
    : `fiscal year ${MONTHS[fyStartMonth - 1]} ${year} – ${MONTHS[fyEndMonth - 1]} ${fyEndYear}`;
  // Annual ITR / AFS: 15th of the 4th month after the fiscal year ends.
  const annualDueMonth = ((fyEndMonth + 3) % 12) + 1;
  const annualDueYear = fyEndMonth + 4 > 12 ? fyEndYear + 1 : fyEndYear;

  // NOTE: BIR Form 0605 is a voluntary payment form — not auto-generated.
  // Accountants can upload 0605 documents manually in the client's document section.

  // ── MONTHLY FORMS ──────────────────────────────────────────────────────

  // 1601C: Monthly Withholding on Compensation (RR 2-98 Sec. 2.58(A) as amended
  // by RR 11-2018) — 10th of the following month; the December return is due
  // January 15 of the following year.
  if (client.withholdsCompensation) {
    for (let m = 1; m <= 12; m++) {
      const period = `${MONTHS[m - 1]} ${year}`;
      const december = m === 12;
      deadlines.push({
        title: `BIR Form 1601C — ${period}`,
        description:
          `Monthly Remittance Return of Income Taxes Withheld on Compensation for ${period}. ` +
          (december
            ? "The December return is due January 15 of the following year (RR 2-98 Sec. 2.58(A) as amended by RR 11-2018)."
            : "Due the 10th of the following month (RR 2-98 Sec. 2.58(A) as amended by RR 11-2018).") +
          " Manual/eBIRForms date; eFPS filers are staggered by industry group up to 5 days later (RR 26-2002).",
        dueDate: december ? isoDate(year + 1, 1, 15) : isoDate(year, m + 1, 10),
        priority: "high",
        category: "Withholding Tax",
      });
    }
  }

  // 2000: Documentary Stamp Tax — within 5 days after the close of the month (NIRC Sec. 200(B))
  if (client.subjectToDst) {
    for (let m = 1; m <= 12; m++) {
      const period = `${MONTHS[m - 1]} ${year}`;
      deadlines.push({
        title: `BIR Form 2000 — ${period}`,
        description: `Documentary Stamp Tax Declaration/Return for ${period}. Due within 5 days after the close of the month (NIRC Sec. 200(B); RMC 67-2024).`,
        dueDate: monthAfter(year, m, 5),
        priority: "medium",
        category: "DST",
      });
    }
  }

  // ── QUARTERLY FORMS ────────────────────────────────────────────────────

  const quarters = fiscalQuarterMonths(fyStartMonth);
  // Withholding returns always follow calendar quarters.
  const calendarQuarters = fiscalQuarterMonths(1);

  calendarQuarters.forEach(([endMonth, yOff], qIdx) => {
    const qYear = year + yOff;
    const qLabel = `Q${qIdx + 1} ${year}`;
    // Last day of the month after the quarter (RR 11-2018): Apr 30, Jul 31, Oct 31, Jan 31.
    const quarterlyWhtDue = monthAfter(qYear, endMonth, "last");

    // 0619E: Monthly EWT for the first two months of the quarter — 10th of the following month (RR 11-2018)
    if (client.withholdsEwt) {
      for (const { month, year: mYear } of nonQuarterMonths(endMonth, qYear)) {
        const period = `${MONTHS[month - 1]} ${mYear}`;
        deadlines.push({
          title: `BIR Form 0619E — ${period}`,
          description: `Monthly Remittance Form of Creditable Income Taxes Withheld (Expanded) for ${period}. Due the 10th of the following month (RR 11-2018). (Non-quarter month; quarter-end is covered by 1601EQ.) eFPS filers may be staggered up to the 15th.`,
          dueDate: monthAfter(mYear, month, 10),
          priority: "high",
          category: "Withholding Tax",
        });
      }
    }

    // 1601EQ: Quarterly EWT — last day of the month following quarter end (RR 11-2018)
    if (client.withholdsEwt) {
      deadlines.push({
        title: `BIR Form 1601EQ — ${qLabel}`,
        description: `Quarterly Remittance Return of Creditable Income Taxes Withheld (EWT) for ${qLabel}. Due the last day of the month after the quarter (RR 11-2018). Covers the quarter-end month; prior months covered by 0619E. Attach the QAP.`,
        dueDate: quarterlyWhtDue,
        priority: "high",
        category: "Withholding Tax",
      });
    }

    // 0619F: Monthly Final WT for the first two months of the quarter — 10th of the following month
    // 1601FQ: Quarterly Final WT — last day of month following quarter end (RR 11-2018)
    if (client.withholdsFinal) {
      for (const { month, year: mYear } of nonQuarterMonths(endMonth, qYear)) {
        const period = `${MONTHS[month - 1]} ${mYear}`;
        deadlines.push({
          title: `BIR Form 0619F — ${period}`,
          description: `Monthly Remittance Form of Final Income Taxes Withheld for ${period}. Due the 10th of the following month (RR 11-2018). (Non-quarter month; quarter-end is covered by 1601FQ.) eFPS filers may be staggered up to the 15th.`,
          dueDate: monthAfter(mYear, month, 10),
          priority: "high",
          category: "Withholding Tax",
        });
      }
      deadlines.push({
        title: `BIR Form 1601FQ — ${qLabel}`,
        description: `Quarterly Remittance Return of Final Income Taxes Withheld for ${qLabel}. Due the last day of the month after the quarter (RR 11-2018). Covers the quarter-end month; prior months covered by 0619F. Attach the QAP of final-withholding payees.`,
        dueDate: quarterlyWhtDue,
        priority: "high",
        category: "Withholding Tax",
      });
    }
  });

  quarters.forEach(([endMonth, yOff], qIdx) => {
    const qYear = year + yOff;
    const qLabel = `Q${qIdx + 1} ${year}`;

    // 2550Q: Quarterly VAT — within 25 days after the quarter (NIRC Sec. 114(A) as amended by TRAIN / RA 11976)
    if (client.vatRegistered) {
      deadlines.push({
        title: `BIR Form 2550Q — ${qLabel}`,
        description: `Quarterly VAT Return for ${qLabel}. Due the 25th of the month following quarter end (NIRC Sec. 114(A) as amended by RA 10963 and RA 11976). Monthly 2550M is no longer required from 2023 (RR 13-2018; RMC 5-2023).`,
        dueDate: monthAfter(qYear, endMonth, 25),
        priority: "high",
        category: "VAT",
      });
    }

    // 2551Q: Quarterly Percentage Tax — within 25 days after the quarter (NIRC Sec. 128(A))
    if (client.percentageTaxRegistered) {
      deadlines.push({
        title: `BIR Form 2551Q — ${qLabel}`,
        description: `Quarterly Percentage Tax Return for ${qLabel}. Due the 25th of the month following quarter end (NIRC Sec. 128(A) as amended by RA 10963 and RA 11976).`,
        dueDate: monthAfter(qYear, endMonth, 25),
        priority: "medium",
        category: "Percentage Tax",
      });
    }

    // 1702Q: Quarterly Corporate ITR — 60 days after the close of each of the
    // first three quarters (NIRC Sec. 75 and 77(B)). Q4 is covered by the annual ITR.
    if (client.incomeTaxType === "corporate" && qIdx < 3) {
      deadlines.push({
        title: `BIR Form 1702Q — ${qLabel}`,
        description: `Quarterly Income Tax Return for Corporations (${qLabel}). Due within 60 days after the close of the quarter (NIRC Sec. 75 and 77(B)).`,
        dueDate: addDays(monthAfter(qYear, endMonth - 1, "last"), 60),
        priority: "high",
        category: "Income Tax",
      });
    }
  });

  // 1701Q: Quarterly Individual ITR — fixed dates since TRAIN: May 15, August 15,
  // November 15 (NIRC Sec. 74 as amended by RA 10963; RR 8-2018; RMC 32-2018).
  // Individuals are on the calendar year, so calendar quarters apply.
  if (client.incomeTaxType === "individual") {
    const QUARTER_MONTHS = ["January–March", "April–June", "July–September"];
    const DUE = [[5, "May 15"], [8, "August 15"], [11, "November 15"]] as const;
    for (let qIdx = 0; qIdx < 3; qIdx++) {
      const qLabel = `Q${qIdx + 1} ${year}`;
      const [dueMonth, dueLabel] = DUE[qIdx];
      deadlines.push({
        title: `BIR Form 1701Q — ${qLabel}`,
        description:
          `Quarterly Income Tax Return for Individuals (${qLabel}, ${QUARTER_MONTHS[qIdx]} ${year}). ` +
          `Due ${dueLabel} (NIRC Sec. 74 as amended by RA 10963; RR 8-2018).` +
          (fyStartMonth !== 1 ? " Individuals use the calendar year, so the client's fiscal year setting does not apply." : ""),
        dueDate: isoDate(year, dueMonth, 15),
        priority: "high",
        category: "Income Tax",
      });
    }
  }

  // ── ANNUAL FORMS ───────────────────────────────────────────────────────

  // 1702: Annual Corporate ITR — 15th of 4th month after the end of the fiscal
  // year that starts in `year` (April 15 of year + 1 for calendar-year clients). NIRC Sec. 77(B).
  if (client.incomeTaxType === "corporate") {
    deadlines.push({
      title: `BIR Form 1702 (Annual Corporate ITR) — FY ${year}`,
      description: `Annual Income Tax Return for Corporations for ${fyLabel}. Due the 15th of the 4th month after the fiscal year ends (NIRC Sec. 77(B)).`,
      dueDate: isoDate(annualDueYear, annualDueMonth, 15),
      priority: "high",
      category: "Income Tax",
    });

    // 1702RT/EX/MX attachment
    deadlines.push({
      title: `Audited Financial Statements — FY ${year}`,
      description: `AFS for ${fyLabel}, submitted with the Annual ITR (audited by a CPA if quarterly gross sales exceed P3M). Manual filers attach it at filing; eFPS/eBIRForms filers upload it through eAFS within 15 days from the ITR deadline or e-filing date, whichever is later (RMC 14-2015, RMC 44-2022).`,
      dueDate: isoDate(annualDueYear, annualDueMonth, 15),
      priority: "high",
      category: "Income Tax",
    });
  }

  // 1701: Annual Individual ITR — April 15 of year + 1 (NIRC Sec. 51(C)(1)).
  // Individuals are on the calendar year whatever the client's fiscal-year setting.
  if (client.incomeTaxType === "individual") {
    deadlines.push({
      title: `BIR Form 1701 (Annual Individual ITR) — FY ${year}`,
      description:
        `Annual Income Tax Return for Individuals for calendar year ${year}. Due April 15 of the following year (NIRC Sec. 51(C)(1)). ` +
        `Tax due over P2,000 may be paid in two installments: with the return, and by October 15 (NIRC Sec. 56(A)(2)).` +
        (fyStartMonth !== 1 ? " Individuals use the calendar year, so the client's fiscal year setting does not apply." : ""),
      dueDate: isoDate(year + 1, 4, 15),
      priority: "high",
      category: "Income Tax",
    });
  }

  // 1604C + Alphalist of Employees: January 31 (RR 2-98 Sec. 2.83.2 as amended by RR 11-2018)
  if (client.withholdsCompensation) {
    deadlines.push({
      title: `BIR Form 1604C — Annual ${year}`,
      description: `Annual Information Return of Income Taxes Withheld on Compensation for ${year}. Due January 31 of the following year, with the Alphalist of Employees (RR 2-98 Sec. 2.83.2 as amended by RR 11-2018). BIR has extended this in some years (e.g. RMC 17-2021).`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "medium",
      category: "Withholding Tax",
    });
    deadlines.push({
      title: `Alphalist of Employees (1604C Attachment) — ${year}`,
      description: `Alphabetical List of Employees from whom income taxes have been withheld. Submitted with Form 1604C by January 31 of the following year (RR 11-2018; RR 1-2014).`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "medium",
      category: "Withholding Tax",
    });
  }

  // 1604E + Annual Alphalist of Payees: March 1 (RR 11-2018)
  if (client.withholdsEwt) {
    deadlines.push({
      title: `BIR Form 1604E — Annual ${year}`,
      description: `Annual Information Return of Creditable Income Taxes Withheld (Expanded) for ${year}. Due March 1 of the following year (RR 11-2018).`,
      dueDate: isoDate(year + 1, 3, 1),
      priority: "medium",
      category: "Withholding Tax",
    });
    deadlines.push({
      title: `Annual Alphalist of Payees (1604E Attachment) — ${year}`,
      description: `Alphabetical list of payees from whom expanded withholding taxes have been withheld. Filed with Form 1604E by March 1 of the following year (RR 11-2018).`,
      dueDate: isoDate(year + 1, 3, 1),
      priority: "medium",
      category: "Withholding Tax",
    });
  }

  // 1604F: January 31 (RR 11-2018)
  if (client.withholdsFinal) {
    deadlines.push({
      title: `BIR Form 1604F — Annual ${year}`,
      description: `Annual Information Return of Income Payments Subjected to Final Withholding Taxes for ${year}, with the alphalist of payees subject to final tax. Due January 31 of the following year (RR 11-2018). BIR has extended this in some years (e.g. RMC 17-2021).`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "medium",
      category: "Withholding Tax",
    });
  }

  // ── 2316 / Annex F — Substituted Filing (Compensation) ───────────────────
  // RR 2-98 Sec. 2.83.1 as amended by RR 11-2018: furnish 2316 to employees by
  // January 31; submit the duplicates of qualified employees with the Annex F
  // certified list by February 28 (February 28 even in leap years).
  if (client.withholdsCompensation) {
    deadlines.push({
      title: `BIR Form 2316 (Issue to Employees) — ${year}`,
      description: `Furnish each employee the Certificate of Compensation Payment/Tax Withheld for ${year} on or before January 31 of the following year (RR 2-98 Sec. 2.83.1 as amended by RR 11-2018). An employee who left during the year gets it on the day of the last payment of compensation.`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "medium",
      category: "Withholding Tax",
    });
    deadlines.push({
      title: `BIR Form 2316 (Substituted Filing) — ${year}`,
      description: `Submit to the BIR the duplicate copies of BIR Form 2316 of employees qualified for substituted filing, signed by both employer and employee, together with the Annex F certified list. Due not later than February 28 of the following year (RR 2-98 Sec. 2.83.1 as amended by RR 11-2018; RMC 29-2024). BIR has extended this in some years (e.g. to March 31, 2024).`,
      dueDate: isoDate(year + 1, 2, 28),
      priority: "medium",
      category: "Withholding Tax",
    });
    deadlines.push({
      title: `Annex F (Annual Alphalist of Employees) — ${year}`,
      description: `Annex F (RR 11-2018): Certified List of Employees Qualified for Substituted Filing of ITR, submitted to the RDO with the duplicate 2316 copies not later than February 28 of the following year. The BIR-stamped list is the substituted filing of those employees' ITRs. (Not the alphalist of employees, which goes with 1604C by January 31.)`,
      dueDate: isoDate(year + 1, 2, 28),
      priority: "low",
      category: "Withholding Tax",
    });
  }

  // ── Annex C — Income payor's sworn declaration (RR 11-2018) ──────────────
  // Filed by income payors whose payees submitted sworn declarations of gross
  // receipts (Annex B-1/B-2/B-3, an EWT matter): January 31, or within 15 days
  // after the month a new payee's declaration is received. The title is kept
  // as generated historically (existing rows are matched by title).
  if (client.withholdsEwt) {
    deadlines.push({
      title: `Annex C (Substituted Filing Employees) — ${year}`,
      description: `Annex C (RR 11-2018): Income Payor/Withholding Agent's Sworn Declaration, with the list of payees who gave sworn declarations of gross receipts (Annex B-1/B-2/B-3), filed in two copies at the RDO/LTS on or before January 31 of the following year, and within 15 days after the month a new payee's declaration is received. Only required where payees submitted sworn declarations. (Not a substituted-filing list; that is Annex F.)`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "low",
      category: "Withholding Tax",
    });
  }

  // ── Quarterly Alphalist of Payees (QAP) — attachment to 1601EQ / 1601FQ ──
  // Last day of the month after the calendar quarter (RR 11-2018), by eSubmission.
  const qapKinds: Array<{ suffix: string; form: string; wht: string }> = [];
  if (client.withholdsEwt) qapKinds.push({ suffix: "", form: "1601EQ", wht: "expanded withholding tax" });
  if (client.withholdsFinal) qapKinds.push({ suffix: "Final Withholding", form: "1601FQ", wht: "final withholding tax" });
  for (const { suffix, form, wht } of qapKinds) {
    calendarQuarters.forEach(([endMonth, yOff], qIdx) => {
      const qLabel = `Q${qIdx + 1} ${year}`;
      deadlines.push({
        title: suffix
          ? `Quarterly Alphalist of Payees (QAP, ${suffix}) — ${qLabel}`
          : `Quarterly Alphalist of Payees (QAP) — ${qLabel}`,
        description: `Alphabetical list of payees subjected to ${wht} for ${qLabel}. Attached to Form ${form} and submitted by eSubmission. Due the last day of the month following quarter end (RR 11-2018).`,
        dueDate: monthAfter(year + yOff, endMonth, "last"),
        priority: "medium",
        category: "Withholding Tax",
      });
    });
  }

  // ── SLS / SLP — Summary List of Sales & Purchases (VAT) ──────────────────
  if (client.vatRegistered) {
    quarters.forEach(([endMonth, yOff], qIdx) => {
      const qYear = year + yOff;
      const qLabel = `Q${qIdx + 1} ${year}`;
      deadlines.push({
        title: `Summary List of Sales (SLS) — ${qLabel}`,
        description: `Quarterly Summary List of Sales for VAT-registered taxpayers for ${qLabel}. Due the 25th of the month following quarter end, with 2550Q (RR 16-2005 / RR 1-2012 as amended).`,
        dueDate: monthAfter(qYear, endMonth, 25),
        priority: "medium",
        category: "VAT",
      });
      deadlines.push({
        title: `Summary List of Purchases (SLP) — ${qLabel}`,
        description: `Quarterly Summary List of Purchases for VAT-registered taxpayers for ${qLabel}. Due the 25th of the month following quarter end, with 2550Q (RR 16-2005 / RR 1-2012 as amended).`,
        dueDate: monthAfter(qYear, endMonth, 25),
        priority: "medium",
        category: "VAT",
      });
    });
  }

  // ── eSales Report — Monthly (RMO 12-2012; RMC 45-2014) ───────────────────
  if (client.isEsalesRequired) {
    const { day: eDay, basis } = esalesDay(client.tin);
    const eDayLabel = eDay === 8 ? "8th" : "10th";
    for (let m = 1; m <= 12; m++) {
      const period = `${MONTHS[m - 1]} ${year}`;
      deadlines.push({
        title: `eSales Report — ${period}`,
        description: `Monthly electronic sales report for ${period}. Due the ${eDayLabel} of the following month: ${basis} (RMO 12-2012; RMC 45-2014: even last digit of the 9-digit TIN → 8th, odd → 10th).`,
        dueDate: monthAfter(year, m, eDay),
        priority: "medium",
        category: "eSales",
      });
    }
  }

  // ── Annual Inventory List — 30 days after the taxable year (RR 17-2013; RMC 57-2015) ─
  if (client.hasInventory) {
    deadlines.push({
      title: `Annual Inventory List — FY ${year}`,
      description: `Annual list of inventory at the end of ${fyLabel}, submitted to the RDO within 30 days after the year ends (January 30 for calendar-year clients; RR 17-2013, RMC 57-2015).`,
      dueDate: addDays(isoDate(fyEndYear, fyEndMonth + 1, 0), 30),
      priority: "medium",
      category: "Other",
    });
  }

  // ── Lessee Information Statement — semi-annual (RR 12-2011 as amended by RR 15-2011) ─
  // Due the 31st day after the close of each semester: July 31 (tenants as of
  // June 30) and January 31 (tenants as of December 31). The second-semester
  // item keeps its historical title.
  if (client.isLessor) {
    const contents = "the lessee information statement (hard and soft copy), certified true copies of new or renewed lease contracts and the building/space layout, filed with the RDO where the property is";
    deadlines.push({
      title: `Lessee Information Statement — 1st Semester ${year}`,
      description: `Semi-annual submission by lessors of commercial establishments, buildings or spaces for January–June ${year} (tenants as of June 30): ${contents}. Due July 31 (RR 12-2011 as amended by RR 15-2011).`,
      dueDate: isoDate(year, 7, 31),
      priority: "medium",
      category: "Other",
    });
    deadlines.push({
      title: `Lessee Information Statement — ${year}`,
      description: `Semi-annual submission by lessors of commercial establishments, buildings or spaces for July–December ${year} (tenants as of December 31): ${contents}. Due January 31 of the following year (RR 12-2011 as amended by RR 15-2011).`,
      dueDate: isoDate(year + 1, 1, 31),
      priority: "medium",
      category: "Other",
    });
  }

  // ── Weekend / holiday roll-forward (RMC 65-2016) ─────────────────────────
  return deadlines.map((d) => {
    const { dueDate, note } = adjustDueDate(d.dueDate);
    return note ? { ...d, dueDate, description: `${d.description} ${note}` } : d;
  });
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
  engagementId: number | null;
  workflowStage: string | null;
  workflowStatus: string | null;
  stageStatuses: {
    source_collection: string;
    draft_return: string;
    confirmation: string;
    payment: string;
  } | null;
  taxPayable: number | null;
}

/**
 * Frequency of every formNumber extractFormNumber() can return. The Lessee
 * Information Statement is semi-annual; the checklist has no such bucket, so it
 * is listed with the annual items (its period says "1st/2nd Semester").
 */
export const FREQUENCY_MAP: Record<string, "monthly" | "quarterly" | "annual"> = {
  "2550Q": "quarterly",
  "2551Q": "quarterly",
  "1601C": "monthly",
  "1601EQ": "quarterly",
  "1601FQ": "quarterly",
  "1604C": "annual",
  "1604E": "annual",
  "1604F": "annual",
  "1702": "annual",
  "1702Q": "quarterly",
  "1701": "annual",
  "1701Q": "quarterly",
  "2000": "monthly",
  "0619E": "monthly",
  "0619F": "monthly",
  "AFS": "annual",
  "Alphalist": "annual",
  "Alphalist-1604C": "annual",
  "Alphalist-1604E": "annual",
  "2316": "annual",
  "2316-Issue": "annual",
  "AnnexC": "annual",
  "AnnexF": "annual",
  "QAP": "quarterly",
  "QAP-Final": "quarterly",
  "SLS": "quarterly",
  "SLP": "quarterly",
  "eSales": "monthly",
  "Inventory": "annual",
  "LesseeInfo": "annual",
};

/**
 * Short form code of a generated deadline title. Codes are distinct per filing
 * kind, so (formNumber, period) identifies one checklist item: the 2316 issue to
 * employees ("2316-Issue") vs. the substituted-filing duplicates ("2316"), the
 * 1604C vs. 1604E alphalists, and the EWT vs. final-withholding QAP.
 */
export function extractFormNumber(title: string): string {
  // Annexes first: "Annex F (Annual Alphalist of Employees)" is not an alphalist.
  if (title.startsWith("Annex C")) return "AnnexC";
  if (title.startsWith("Annex F")) return "AnnexF";
  if (/^BIR Form 2316 \(Issue to Employees\)/.test(title)) return "2316-Issue";
  const match = title.match(/BIR Form (\w+)/);
  if (match) return match[1];
  if (title.includes("Audited Financial Statements") || /\bAFS\b/.test(title)) return "AFS";
  if (title.includes("Alphalist of Payees") && title.includes("Quarterly")) {
    return title.includes("Final Withholding") ? "QAP-Final" : "QAP";
  }
  if (title.includes("1604C Attachment")) return "Alphalist-1604C";
  if (title.includes("1604E Attachment")) return "Alphalist-1604E";
  if (title.includes("Alphalist")) return "Alphalist";
  if (title.includes("Summary List of Sales")) return "SLS";
  if (title.includes("Summary List of Purchases")) return "SLP";
  if (title.includes("eSales")) return "eSales";
  if (title.includes("Annual Inventory")) return "Inventory";
  if (title.includes("Lessee Information")) return "LesseeInfo";
  return "OTHER";
}

// Helper: the first two months of the calendar quarter ending in `endMonth`
// (the 0619E/0619F months; the quarter-end month is covered by 1601EQ/1601FQ).
function nonQuarterMonths(endMonth: number, qYear: number): Array<{ month: number; year: number }> {
  const result = [];
  for (const offset of [2, 1]) {
    let m = endMonth - offset;
    let mYear = qYear;
    if (m <= 0) { m += 12; mYear -= 1; }
    result.push({ month: m, year: mYear });
  }
  return result;
}

/**
 * eSales due day (RMO 12-2012 implementing RR 5-2005; RMC 92-2010; RMC 45-2014):
 * the last digit of the 9-digit TIN, branch code excluded. Even (0, 2, 4, 6, 8) →
 * 8th of the following month; odd (1, 3, 5, 7, 9) → 10th. Without a usable TIN
 * the earlier (8th) date is used.
 */
function esalesDay(tin: string | null | undefined): { day: 8 | 10; basis: string } {
  const digits = (tin ?? "").replace(/\D/g, "");
  if (digits.length < 9) {
    return { day: 8, basis: "no 9-digit TIN on file, so the earlier (8th) deadline is used" };
  }
  const ninth = Number(digits[8]);
  return ninth % 2 === 0
    ? { day: 8, basis: `9th TIN digit ${ninth} is even` }
    : { day: 10, basis: `9th TIN digit ${ninth} is odd` };
}

const PERIOD_RE = /^(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|FY|Annual|1st Semester|2nd Semester) \d{4}$/;

/**
 * Period label of a generated deadline title, from the part after the last " — ":
 * "Q2 2026", "March 2026", "FY 2026", "Annual 2026", "1st Semester 2026". A bare
 * tax year ("Alphalist of Employees (1604C Attachment) — 2026", "BIR Form 2316
 * (Issue to Employees) — 2026") is an annual filing, except the Lessee Information
 * Statement, whose bare-year title is its second semester.
 */
export function extractPeriod(title: string): string {
  const sep = title.lastIndexOf(" — ");
  const tail = (sep >= 0 ? title.slice(sep + 3) : title).trim();
  if (PERIOD_RE.test(tail)) return tail;
  if (/^\d{4}$/.test(tail)) {
    return title.startsWith("Lessee Information Statement") ? `2nd Semester ${tail}` : `Annual ${tail}`;
  }
  const inner = title.match(/\b(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|FY|Annual|1st Semester|2nd Semester) \d{4}\b/);
  return inner ? inner[0] : title;
}

type DeadlineRow = typeof deadlinesTable.$inferSelect;

/**
 * Picks, for each title, the saved deadline that best represents the filing.
 * Deadline titles embed the period/tax year, so a title identifies one filing.
 * When several rows share a title (duplicates from older generate runs) prefer
 * a completed row, then one linked to an engagement, then the oldest (lowest id).
 */
function pickDeadlinesByTitle(rows: DeadlineRow[]): Map<string, DeadlineRow> {
  const rank = (d: DeadlineRow): number =>
    (d.status === "completed" ? 2 : 0) + (d.engagementId != null ? 1 : 0);
  const byTitle = new Map<string, DeadlineRow>();
  for (const row of rows) {
    const current = byTitle.get(row.title);
    if (
      !current ||
      rank(row) > rank(current) ||
      (rank(row) === rank(current) && row.id < current.id)
    ) {
      byTitle.set(row.title, row);
    }
  }
  return byTitle;
}

export async function buildComplianceItems(
  client: typeof clientsTable.$inferSelect,
  year: number
): Promise<ComplianceItem[]> {
  const required = generateBIRDeadlines(client, year);
  if (required.length === 0) return [];

  // Match saved deadlines by title, whatever their due date: many filings for a
  // tax year fall due in the following calendar year (December monthlies, Q4
  // quarterlies, annual returns), and fiscal-year clients shift further.
  const titles = [...new Set(required.map(r => r.title))];
  const existing = await db
    .select()
    .from(deadlinesTable)
    .where(and(eq(deadlinesTable.clientId, client.id), inArray(deadlinesTable.title, titles)));
  const byTitle = pickDeadlinesByTitle(existing);

  const engagementIds = [
    ...new Set(
      [...byTitle.values()]
        .map(d => d.engagementId)
        .filter((eid): eid is number => eid !== null && eid !== undefined),
    ),
  ];
  const engagementsMap = new Map<number, typeof engagementsTable.$inferSelect>();
  if (engagementIds.length > 0) {
    const engagements = await db
      .select()
      .from(engagementsTable)
      .where(inArray(engagementsTable.id, engagementIds));
    for (const eng of engagements) engagementsMap.set(eng.id, eng);
  }

  const today = manilaToday();

  return required.map(req => {
    const formNumber = extractFormNumber(req.title);
    const period = extractPeriod(req.title);
    const frequency = FREQUENCY_MAP[formNumber] || "annual";

    const matched = byTitle.get(req.title);
    let status: "pending" | "filed" | "overdue" = "pending";
    if (matched?.status === "completed") {
      status = "filed";
    } else if (req.dueDate < today) {
      status = "overdue";
    }

    const engagementId = matched?.engagementId ?? null;
    const eng = engagementId ? engagementsMap.get(engagementId) : null;

    // Compute effective stage statuses (payment → not_applicable when taxPayable === 0)
    let stageStatuses: ComplianceItem["stageStatuses"] = null;
    if (eng) {
      const paymentNA = eng.taxPayable !== null && Number(eng.taxPayable) === 0;
      stageStatuses = {
        source_collection: eng.sourceCollectionStatus,
        draft_return: eng.draftReturnStatus,
        confirmation: eng.confirmationStatus,
        payment: paymentNA ? "not_applicable" : eng.paymentStatus,
      };
    }

    return {
      formNumber,
      description: req.description,
      period,
      dueDate: req.dueDate,
      frequency,
      status,
      deadlineId: matched?.id ?? null,
      engagementId: engagementId ?? null,
      workflowStage: eng?.workflowStage ?? null,
      workflowStatus: eng?.status ?? null,
      stageStatuses,
      taxPayable: eng?.taxPayable !== null && eng?.taxPayable !== undefined ? Number(eng.taxPayable) : null,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────────────────

router.get("/clients", requireAuth, async (req, res): Promise<void> => {
  // Staff see every client; a client account sees only its linked client
  // (an unlinked client account has scope 0 and sees nothing).
  const scope = clientScope(req);
  if (scope === 0) {
    res.json([]);
    return;
  }

  const clients = await db
    .select()
    .from(clientsTable)
    .where(scope === null ? undefined : eq(clientsTable.id, scope))
    .orderBy(clientsTable.name);
  if (clients.length === 0) {
    res.json([]);
    return;
  }

  const today = manilaToday();

  // Overdue: the client's open deadlines already past due (any tax year), one
  // per filing (duplicate copies of a filing count once; a filed one not at all).
  const overdueMap = new Map<number, number>();
  for (const d of await openDeadlines(scope === null ? undefined : eq(deadlinesTable.clientId, scope))) {
    if (d.clientId == null || d.dueDate >= today) continue;
    overdueMap.set(d.clientId, (overdueMap.get(d.clientId) ?? 0) + 1);
  }

  // In progress / for review: the same items the client page lists for the
  // current tax year (?wf=in_progress / ?wf=for_review), i.e. this year's
  // filings whose linked engagement is in progress / has a stage for review.
  const year = manilaYear();
  const titlesByClient = new Map(clients.map(c => [c.id, new Set(generateBIRDeadlines(c, year).map(d => d.title))]));
  const allTitles = [...new Set([...titlesByClient.values()].flatMap(t => [...t]))];
  const yearRows = allTitles.length === 0
    ? []
    : await db
        .select()
        .from(deadlinesTable)
        .where(and(inArray(deadlinesTable.clientId, clients.map(c => c.id)), inArray(deadlinesTable.title, allTitles)));
  const linkedByClient = new Map<number, number[]>();
  for (const c of clients) {
    const titles = titlesByClient.get(c.id)!;
    const picked = pickDeadlinesByTitle(yearRows.filter(d => d.clientId === c.id && titles.has(d.title)));
    linkedByClient.set(
      c.id,
      [...picked.values()].map(d => d.engagementId).filter((id): id is number => id != null),
    );
  }
  const engagementIds = [...new Set([...linkedByClient.values()].flat())];
  const engagementById = new Map(
    (engagementIds.length === 0
      ? []
      : await db.select().from(engagementsTable).where(inArray(engagementsTable.id, engagementIds))
    ).map(e => [e.id, e]),
  );
  const inProgressMap = new Map<number, number>();
  const forReviewMap = new Map<number, number>();
  for (const [clientId, ids] of linkedByClient) {
    for (const id of ids) {
      const e = engagementById.get(id);
      if (!e) continue;
      if (e.status === "in_progress") inProgressMap.set(clientId, (inProgressMap.get(clientId) ?? 0) + 1);
      const stages = [e.sourceCollectionStatus, e.draftReturnStatus, e.confirmationStatus, e.paymentStatus];
      if (stages.includes("for_review")) forReviewMap.set(clientId, (forReviewMap.get(clientId) ?? 0) + 1);
    }
  }

  res.json(clients.map(c => ({
    ...serializeClient(c),
    workflowCounts: {
      inProgress: inProgressMap.get(c.id) ?? 0,
      forReview: forReviewMap.get(c.id) ?? 0,
      overdue: overdueMap.get(c.id) ?? 0,
    },
  })));
});

router.post("/clients", requireStaff, async (req, res): Promise<void> => {
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

  // Outside a client account's scope: 404, so existence is not leaked.
  if (!canAccessClient(req, params.data.id)) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(serializeClient(client));
});

router.patch("/clients/:id", requireStaff, async (req, res): Promise<void> => {
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
  if (parsed.data.withholdsFinal != null) updates.withholdsFinal = parsed.data.withholdsFinal;
  if (parsed.data.hasInventory != null) updates.hasInventory = parsed.data.hasInventory;
  if (parsed.data.isLessor != null) updates.isLessor = parsed.data.isLessor;
  if (parsed.data.isEsalesRequired != null) updates.isEsalesRequired = parsed.data.isEsalesRequired;

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

router.delete("/clients/:id", requireManager, async (req, res): Promise<void> => {
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const clientId = params.data.id;

  // A client with filings or documents keeps its history: deactivate it instead.
  // Otherwise remove its deadlines and the client together.
  const result = await db.transaction(async (tx) => {
    const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, clientId));
    if (!client) return { kind: "not_found" as const };

    const [eng] = await tx
      .select({ n: count() })
      .from(engagementsTable)
      .where(eq(engagementsTable.clientId, clientId));
    const [doc] = await tx
      .select({ n: count() })
      .from(documentsTable)
      .where(eq(documentsTable.clientId, clientId));
    const engagements = Number(eng?.n ?? 0);
    const documents = Number(doc?.n ?? 0);
    if (engagements > 0 || documents > 0) {
      return { kind: "in_use" as const, engagements, documents };
    }

    await tx.delete(deadlinesTable).where(eq(deadlinesTable.clientId, clientId));
    await tx.delete(clientsTable).where(eq(clientsTable.id, clientId));
    return { kind: "deleted" as const, client };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  if (result.kind === "in_use") {
    res.status(409).json({
      error: `This client has ${result.engagements} filing(s) and ${result.documents} document(s) and cannot be deleted. Set the client to inactive instead.`,
    });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "client",
    entityId: clientId,
    description: `Deleted client ${result.client.name}`,
  });

  res.sendStatus(204);
});

// POST /clients/:id/generate-deadlines
router.post("/clients/:id/generate-deadlines", requireStaff, async (req, res): Promise<void> => {
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

  const year = parsed.data.year;
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    res.status(400).json({ error: "year must be a four-digit tax year" });
    return;
  }
  const overwrite = parsed.data.overwrite ?? false;

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  // Deadline titles embed the period, so a title identifies one filing of this
  // tax year. One row per title (first occurrence wins if the generator repeats one).
  const required = new Map<string, GeneratedDeadline>();
  for (const d of generateBIRDeadlines(client, year)) {
    if (!required.has(d.title)) required.set(d.title, d);
  }
  const titles = [...required.keys()];

  // Titles that only exist in other tax years must never be removed by this
  // year's clean-up of legacy rows (see below).
  const neighbourTitles = new Set([
    ...generateBIRDeadlines(client, year - 1).map(d => d.title),
    ...generateBIRDeadlines(client, year + 1).map(d => d.title),
  ]);
  // Every title the generator could produce for this year, whatever the
  // client's registrations: a legacy row with such a title that is no longer
  // required (e.g. VAT was dropped) is a stale generated deadline.
  const generatableTitles = generateBIRDeadlines(
    {
      ...client,
      vatRegistered: true,
      percentageTaxRegistered: true,
      withholdsCompensation: true,
      withholdsEwt: true,
      subjectToDst: true,
      withholdsFinal: true,
      hasInventory: true,
      isLessor: true,
      isEsalesRequired: true,
      incomeTaxType: "corporate",
    },
    year,
  )
    .concat(generateBIRDeadlines({ ...client, incomeTaxType: "individual" }, year))
    .map(d => d.title)
    .filter(t => !required.has(t) && !neighbourTitles.has(t));

  const outcome = await db.transaction(async (tx) => {
    // Serialize generate runs per client (READ COMMITTED would otherwise let two
    // concurrent runs both see no rows and both insert the full set).
    await tx.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, client.id)).for("update");

    const found = titles.length === 0
      ? []
      : await tx
          .select()
          .from(deadlinesTable)
          .where(and(eq(deadlinesTable.clientId, client.id), inArray(deadlinesTable.title, titles)));

    // Merge duplicate rows of one filing (left by older runs): keep the row the
    // compliance view shows (completed, then engagement-linked, then lowest id)
    // and drop the other copies that are unlinked and not completed.
    const kept = pickDeadlinesByTitle(found);
    const keptIds = new Set([...kept.values()].map(d => d.id));
    const duplicateIds = found
      .filter(d => !keptIds.has(d.id) && d.engagementId == null && d.status !== "completed")
      .map(d => d.id);
    if (duplicateIds.length > 0) {
      await tx.delete(deadlinesTable).where(inArray(deadlinesTable.id, duplicateIds));
    }
    const duplicateSet = new Set(duplicateIds);
    const existing = found.filter(d => !duplicateSet.has(d.id));
    const existingTitles = new Set(existing.map(d => d.title));

    // Legacy rows (generated before tax_year existed) of this year's filings
    // belong to this tax year.
    const untagged = existing.filter(d => d.taxYear == null).map(d => d.id);
    if (untagged.length > 0) {
      await tx.update(deadlinesTable).set({ taxYear: year }).where(inArray(deadlinesTable.id, untagged));
      for (const d of existing) if (d.taxYear == null) d.taxYear = year;
    }

    // New filings: insert only what is missing. Existing rows (and their status
    // and engagement links) are left alone.
    const missing = titles.filter(t => !existingTitles.has(t));
    const inserted = missing.length === 0
      ? []
      : await tx
          .insert(deadlinesTable)
          .values(
            missing.map(t => {
              const d = required.get(t)!;
              return {
                clientId: client.id,
                engagementId: null,
                title: d.title,
                description: d.description,
                dueDate: d.dueDate,
                priority: d.priority,
                status: "pending",
                taxYear: year,
              };
            }),
          )
          .returning({ id: deadlinesTable.id });

    let updated = 0;
    let removed = duplicateIds.length;
    if (overwrite) {
      // Refresh the schedule fields of existing rows. Never touch status or engagementId.
      for (const row of existing) {
        const d = required.get(row.title);
        if (!d) continue;
        if (
          row.dueDate === d.dueDate &&
          (row.description ?? null) === d.description &&
          row.priority === d.priority &&
          row.taxYear === year
        ) {
          continue;
        }
        await tx
          .update(deadlinesTable)
          .set({ dueDate: d.dueDate, description: d.description, priority: d.priority, taxYear: year })
          .where(eq(deadlinesTable.id, row.id));
        updated++;
      }

      // Remove this tax year's generated deadlines that no longer apply (e.g. a
      // registration was dropped). Engagement-linked and completed rows, and rows
      // of other tax years, are kept. Legacy rows (no tax year) are matched by a
      // title the generator produces only for this year.
      const thisYearsRows = generatableTitles.length === 0
        ? eq(deadlinesTable.taxYear, year)
        : or(
            eq(deadlinesTable.taxYear, year),
            and(isNull(deadlinesTable.taxYear), inArray(deadlinesTable.title, generatableTitles)),
          );
      const deleted = await tx
        .delete(deadlinesTable)
        .where(
          and(
            eq(deadlinesTable.clientId, client.id),
            thisYearsRows,
            isNull(deadlinesTable.engagementId),
            ne(deadlinesTable.status, "completed"),
            titles.length === 0 ? undefined : notInArray(deadlinesTable.title, titles),
          ),
        )
        .returning({ id: deadlinesTable.id });
      removed += deleted.length;
    }

    return { created: inserted.length, updated, removed, alreadyExisted: existingTitles.size };
  });

  const { created, updated, removed, alreadyExisted } = outcome;

  if (created > 0 || updated > 0 || removed > 0) {
    await logAudit({
      userId: req.session.userId,
      action: "create",
      entityType: "deadline",
      entityId: client.id,
      description:
        `Generated BIR deadlines for ${client.name} (tax year ${year}): ` +
        `${created} created, ${updated} updated, ${removed} removed, ${alreadyExisted} already existed`,
    });
  }

  if (titles.length === 0) {
    res.json({
      created: 0,
      message:
        "No tax types registered. Please update the client's BIR 2303 information first." +
        (removed > 0 ? ` Removed ${removed} deadline(s) for ${year} that no longer apply.` : ""),
    });
    return;
  }

  const parts = [`${created} created`];
  if (overwrite) parts.push(`${updated} updated`);
  if (overwrite || removed > 0) parts.push(`${removed} removed`);
  parts.push(`${alreadyExisted} already existed`);
  res.json({
    created,
    message: `BIR deadlines for tax year ${year}: ${parts.join(", ")}.`,
  });
});

// GET /clients/:id/compliance
router.get("/clients/:id/compliance", requireAuth, async (req, res): Promise<void> => {
  const params = GetClientComplianceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Outside a client account's scope: 404, so existence is not leaked.
  if (!canAccessClient(req, params.data.id)) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const qParams = GetClientComplianceQueryParams.safeParse(req.query);
  const year = qParams.success && qParams.data.year ? qParams.data.year : manilaYear();

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
