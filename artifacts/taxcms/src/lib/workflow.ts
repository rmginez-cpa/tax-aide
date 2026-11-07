// Opening the filing workflow dialog from a saved deadline (deadlines list, calendar).
// Form numbers and periods come from the server (GET /deadlines sends `formNumber` and
// `period`, from the same extractFormNumber / extractPeriod as the compliance checklist
// in api-server/src/lib/filingLabels.ts), so every page shows the same
// "2550Q" / "1601EQ" / "Q1 2026" labels as client detail. There is no client-side copy.

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
  /** Server-derived form code ("OTHER" when the title names no form). */
  formNumber?: string;
  /** Server-derived period label (the whole title when it has none). */
  period?: string;
}

/**
 * Dialog props for a client-linked deadline, or null when the deadline has no client
 * (manual firm deadlines have no filing workflow). Hand-made titles that name no BIR
 * form keep their title as the heading instead of "OTHER".
 */
export function workflowTargetFromDeadline(d: WorkflowDeadline): WorkflowTarget | null {
  if (!d.clientId) return null;
  const formNumber = d.formNumber ?? "OTHER";
  return {
    deadlineId: d.id,
    engagementId: d.engagementId ?? null,
    clientId: d.clientId,
    formNumber: formNumber === "OTHER" ? d.title : formNumber,
    description: d.clientName ?? "",
    period: d.period ?? d.title,
    dueDate: d.dueDate,
  };
}
