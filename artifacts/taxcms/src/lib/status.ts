// One source of truth for status / priority / role labels and badge colours.
// Each map entry is { label, className }; `className` is meant for an outline
// <Badge variant="outline"> or a rounded <span> (it includes a border colour).
// Use the get*() helpers: they fall back gracefully for unknown values.

import { isOverdue, daysUntil } from "@/lib/dates";

/** A label plus Tailwind classes for a badge/pill. */
export interface StatusStyle {
  label: string;
  className: string;
}

/** Fallback badge classes for unknown values. */
export const NEUTRAL_BADGE = "bg-gray-100 text-gray-700 border-gray-200";

/** "in_progress" -> "In Progress" (used for values missing from a map). */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function lookup(map: Record<string, StatusStyle>, value: string | null | undefined): StatusStyle {
  return (value && map[value]) || { label: humanize(value), className: NEUTRAL_BADGE };
}

// ── Engagement (filing) status ────────────────────────────────────────────────

/**
 * Engagement-level statuses the server returns: pending (no stage started), in_progress,
 * completed (every required stage approved). Review / approval happen per stage (STAGE_STATUS).
 */
export const ENGAGEMENT_STATUS_KEYS = ["pending", "in_progress", "completed"] as const;

/** Engagement status badges. */
export const ENGAGEMENT_STATUS: Record<string, StatusStyle> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-700 border-gray-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
};

/**
 * Badge style for an engagement status. Anything else (e.g. the retired for_review / approved /
 * filed on rows from before the stage workflow) gets a neutral badge with the humanized value.
 */
export function getEngagementStatus(status: string | null | undefined): StatusStyle {
  return lookup(ENGAGEMENT_STATUS, status);
}

/** Chart fill colours per engagement status (dashboard pie chart). */
export const ENGAGEMENT_STATUS_CHART_COLORS: Record<string, string> = {
  pending: "hsl(215 16% 47%)", // gray
  in_progress: "hsl(214 100% 41%)", // blue
  completed: "hsl(152 69% 31%)", // emerald
};

/** Pie-chart colour of an engagement status; unknown (retired) values get a neutral slate. */
export function engagementStatusChartColor(status: string | null | undefined): string {
  return (status && ENGAGEMENT_STATUS_CHART_COLORS[status]) || "hsl(215 20% 65%)";
}

// ── Workflow stages ───────────────────────────────────────────────────────────

/** The four parallel filing workflow stages, in display order. */
export const FILING_STAGE_KEYS = ["source_collection", "draft_return", "confirmation", "payment"] as const;

/** A filing workflow stage key. */
export type FilingStageKey = (typeof FILING_STAGE_KEYS)[number];

/** Stage names: `label` (dialog headings), `shortLabel` (chips), `className` (stage chip colour). */
export const FILING_STAGES: Record<FilingStageKey, { label: string; shortLabel: string; className: string }> = {
  source_collection: { label: "Source Documents", shortLabel: "Sources", className: "bg-blue-100 text-blue-700" },
  draft_return: { label: "Draft Tax Return", shortLabel: "Draft", className: "bg-amber-100 text-amber-700" },
  confirmation: { label: "Confirmation Receipt", shortLabel: "Confirmation", className: "bg-violet-100 text-violet-700" },
  payment: { label: "Payment Confirmation", shortLabel: "Payment", className: "bg-cyan-100 text-cyan-700" },
};

/** Per-stage status badges: not_started / in_progress / for_review / approved / not_applicable. */
export const STAGE_STATUS: Record<string, StatusStyle> = {
  not_started: { label: "Not Started", className: "bg-gray-100 text-gray-600 border-gray-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  for_review: { label: "Pending Approval", className: "bg-amber-100 text-amber-700 border-amber-200" },
  approved: { label: "Approved", className: "bg-green-100 text-green-700 border-green-200" },
  not_applicable: { label: "Not Applicable", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

/** Badge style for a stage status. */
export function getStageStatus(status: string | null | undefined): StatusStyle {
  return lookup(STAGE_STATUS, status);
}

/** Icon text colour per stage status (compact stage-progress icons, e.g. client compliance list). */
export const STAGE_STATUS_ICON_CLASS: Record<string, string> = {
  not_started: "text-muted-foreground/25",
  in_progress: "text-blue-500",
  for_review: "text-amber-500",
  approved: "text-emerald-500",
  not_applicable: "text-slate-300",
};

// ── Deadlines ─────────────────────────────────────────────────────────────────

/** Deadline priority badges: high / medium / low. */
export const DEADLINE_PRIORITY: Record<string, StatusStyle> = {
  high: { label: "High", className: "bg-red-100 text-red-700 border-red-200" },
  medium: { label: "Medium", className: "bg-amber-100 text-amber-700 border-amber-200" },
  low: { label: "Low", className: "bg-slate-100 text-slate-700 border-slate-200" },
};

/** Badge style for a deadline priority. */
export function getDeadlinePriority(priority: string | null | undefined): StatusStyle {
  return lookup(DEADLINE_PRIORITY, priority);
}

/** Stored deadline status badges: pending / completed (plus the derived "overdue"). */
export const DEADLINE_STATUS: Record<string, StatusStyle> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-700 border-gray-200" },
  overdue: { label: "Overdue", className: "bg-red-100 text-red-700 border-red-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
};

/** Compliance-checklist item states (client detail): filed / pending / overdue, as text colours. */
export const COMPLIANCE_STATUS: Record<string, StatusStyle> = {
  filed: { label: "Filed", className: "text-emerald-600" },
  pending: { label: "Pending", className: "text-muted-foreground" },
  overdue: { label: "Overdue", className: "text-red-600" },
};

/** Urgency bucket of a deadline, derived from its status and due date (Manila). */
export type DeadlineUrgency = "completed" | "overdue" | "due_soon" | "upcoming";

/** Derived urgency + countdown label for a deadline: "Completed", "Overdue", "Due today", "3d left". */
export function getDeadlineUrgency(
  dueDate: string,
  status?: string | null,
  soonDays = 3,
): { urgency: DeadlineUrgency; label: string; days: number; className: string } {
  const days = daysUntil(dueDate);
  if (status === "completed") return { urgency: "completed", label: "Completed", days, className: DEADLINE_URGENCY_TEXT.completed };
  if (isOverdue(dueDate, status)) return { urgency: "overdue", label: "Overdue", days, className: DEADLINE_URGENCY_TEXT.overdue };
  const label = days === 0 ? "Due today" : `${days}d left`;
  if (days <= soonDays) return { urgency: "due_soon", label, days, className: DEADLINE_URGENCY_TEXT.due_soon };
  return { urgency: "upcoming", label, days, className: DEADLINE_URGENCY_TEXT.upcoming };
}

/** Text colour per deadline urgency (deadline lists, dashboard countdowns). */
export const DEADLINE_URGENCY_TEXT: Record<DeadlineUrgency, string> = {
  completed: "text-emerald-600",
  overdue: "text-red-600",
  due_soon: "text-amber-600",
  upcoming: "text-muted-foreground",
};

/** Calendar pill classes per urgency; "high" is an upcoming high-priority deadline. */
export const DEADLINE_PILL_CLASS: Record<DeadlineUrgency | "high", string> = {
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200 line-through opacity-70",
  overdue: "bg-red-50 text-red-700 border-red-200",
  high: "bg-amber-50 text-amber-800 border-amber-200",
  due_soon: "bg-primary/5 text-primary border-primary/20",
  upcoming: "bg-primary/5 text-primary border-primary/20",
};

/** Calendar dot classes, same buckets as DEADLINE_PILL_CLASS. */
export const DEADLINE_DOT_CLASS: Record<DeadlineUrgency | "high", string> = {
  completed: "bg-emerald-500",
  overdue: "bg-red-500",
  high: "bg-amber-500",
  due_soon: "bg-primary",
  upcoming: "bg-primary",
};

/** Calendar colour bucket: completed > overdue > high priority > default. Index DEADLINE_PILL_CLASS / DEADLINE_DOT_CLASS with it. */
export function deadlineColorKey(d: { dueDate: string; status?: string | null; priority?: string | null }): DeadlineUrgency | "high" {
  if (d.status === "completed") return "completed";
  if (isOverdue(d.dueDate, d.status)) return "overdue";
  if (d.priority === "high") return "high";
  return "upcoming";
}

// ── Roles ─────────────────────────────────────────────────────────────────────

/** Every role value the API can return. maker == accountant; viewer is a legacy alias of client. */
export const ROLE_VALUES = ["super_admin", "manager", "maker", "accountant", "client", "viewer"] as const;

/** Role shown to users. accountant is displayed as "Maker". */
export const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  manager: "Manager",
  maker: "Maker",
  accountant: "Maker",
  client: "Client",
  viewer: "Viewer",
};

/** Role badge classes (sidebar, login demo cards, account management). */
export const ROLE_BADGE_CLASS: Record<string, string> = {
  super_admin: "bg-violet-100 text-violet-800 border-violet-200",
  manager: "bg-blue-100 text-blue-800 border-blue-200",
  maker: "bg-emerald-100 text-emerald-800 border-emerald-200",
  accountant: "bg-emerald-100 text-emerald-800 border-emerald-200",
  client: "bg-amber-100 text-amber-800 border-amber-200",
  viewer: "bg-gray-100 text-gray-700 border-gray-200",
};

/** One-line role descriptions for role pickers. */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
  super_admin: "Full system access, account management",
  manager: "Approves filings, views all data",
  maker: "Prepares and submits filings",
  accountant: "Prepares and submits filings",
  client: "Read-only view of own filings",
  viewer: "Read-only access",
};

/** Display label for a role (falls back to the humanized value). */
export function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABELS[role]) || humanize(role);
}

/** Badge classes for a role (falls back to neutral grey). */
export function roleBadgeClass(role: string | null | undefined): string {
  return (role && ROLE_BADGE_CLASS[role]) || NEUTRAL_BADGE;
}

/** Roles offered when creating/editing accounts (accountant is the legacy spelling of maker, so it is not offered). */
export const ASSIGNABLE_ROLES = ["super_admin", "manager", "maker", "client", "viewer"] as const;
