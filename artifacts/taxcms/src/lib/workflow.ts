// Opening the filing workflow dialog from a saved deadline (deadlines list, calendar).
// Form numbers and periods are derived from the deadline title exactly like the
// server derives them for the compliance checklist (extractFormNumber /
// extractPeriod in api-server/src/routes/clients.ts), so every page shows the
// same "2550Q" / "1601EQ" / "Q1 2026" labels as client detail.

/** The props FilingWorkflowDialog needs, minus open/onClose/onUpdate. */
export interface WorkflowTarget {
  deadlineId: number;
  engagementId: number | null;
  clientId: number;
  formNumber: string;
  description: string;
  period: string;
  dueDate: string;
}

/** A deadline as listed by GET /api/deadlines (only the fields used here). */
export interface WorkflowDeadline {
  id: number;
  title: string;
  dueDate: string;
  clientId?: number | null;
  clientName?: string | null;
  engagementId?: number | null;
  description?: string | null;
}

/**
 * Form code of a deadline title: "BIR Form 1601EQ — Q1 2026" -> "1601EQ",
 * "Summary List of Sales (SLS) — Q1 2026" -> "SLS". Same rules and order as the
 * server's extractFormNumber; "OTHER" when the title names no known form.
 */
export function extractFormNumber(title: string): string {
  const match = title.match(/BIR Form ([\w]+)/);
  if (match) return match[1];
  if (title.includes("Audited Financial Statements") || title.includes("AFS")) return "AFS";
  if (title.includes("Alphalist of Payees") && title.includes("Quarterly")) return "QAP";
  if (title.includes("Alphalist of Payees") || title.includes("Annual Alphalist")) return "Alphalist";
  if (title.includes("Alphalist of Employees")) return "Alphalist";
  if (title.includes("Annex C")) return "AnnexC";
  if (title.includes("Annex F")) return "AnnexF";
  if (title.includes("Summary List of Sales")) return "SLS";
  if (title.includes("Summary List of Purchases")) return "SLP";
  if (title.includes("eSales")) return "eSales";
  if (title.includes("Annual Inventory")) return "Inventory";
  if (title.includes("Lessee Information")) return "LesseeInfo";
  return "OTHER";
}

/**
 * Period label of a deadline title ("Q1 2026", "January 2026", "FY 2025", "Annual 2025"),
 * same as the server's extractPeriod; the whole title when none is found.
 */
export function extractPeriod(title: string): string {
  const match = title.match(
    /(Q\d \d{4}|January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})|FY (\d{4})|Annual (\d{4})/,
  );
  return match ? match[0] : title;
}

/**
 * Dialog props for a client-linked deadline, or null when the deadline has no client
 * (manual firm deadlines have no filing workflow). Hand-made titles that name no BIR
 * form keep their title as the heading instead of "OTHER".
 */
export function workflowTargetFromDeadline(d: WorkflowDeadline): WorkflowTarget | null {
  if (!d.clientId) return null;
  const formNumber = extractFormNumber(d.title);
  return {
    deadlineId: d.id,
    engagementId: d.engagementId ?? null,
    clientId: d.clientId,
    formNumber: formNumber === "OTHER" ? d.title : formNumber,
    description: d.clientName || d.description || "",
    period: extractPeriod(d.title),
    dueDate: d.dueDate,
  };
}
