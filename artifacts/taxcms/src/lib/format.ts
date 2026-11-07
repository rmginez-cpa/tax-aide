// Display formatting shared by every page. Dates are always shown in Asia/Manila,
// whatever the viewer's own time zone is.

export { manilaToday, isOverdue, daysUntil } from "@/lib/dates";

/** The firm's time zone; every displayed date/time is pinned to it. */
export const MANILA_TZ = "Asia/Manila";

/** File size for humans: 512 B, 12.3 KB, 4.5 MB, 1.2 GB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const pesoFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Philippine peso amount with 2 decimals, e.g. ₱1,234.50. Accepts numbers or numeric strings (DB decimals); "—" when empty. */
export function formatPeso(amount: number | string | null | undefined): string {
  if (amount == null || amount === "") return "—";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "—";
  return pesoFormatter.format(n);
}

/** Parse an API date value. Bare "YYYY-MM-DD" is a calendar date (kept as that day in Manila); anything else goes through Date. */
function toDate(value: string | number | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Noon Manila time, so the calendar day is the same in every rendering time zone.
    return new Date(`${value}T12:00:00+08:00`);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFormatters = {
  short: new Intl.DateTimeFormat("en-PH", { timeZone: MANILA_TZ, month: "short", day: "numeric", year: "numeric" }),
  long: new Intl.DateTimeFormat("en-PH", { timeZone: MANILA_TZ, month: "long", day: "numeric", year: "numeric" }),
  monthDay: new Intl.DateTimeFormat("en-PH", { timeZone: MANILA_TZ, month: "short", day: "numeric" }),
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-PH", {
  timeZone: MANILA_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * Calendar date in Manila. style "short" (default) = "Nov 7, 2026", "long" = "November 7, 2026",
 * "monthDay" = "Nov 7". Returns "—" for empty/invalid input.
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  style: keyof typeof dateFormatters = "short",
): string {
  if (value == null || value === "") return "—";
  const d = toDate(value);
  return d ? dateFormatters[style].format(d) : "—";
}

/** Date and time in Manila, e.g. "Nov 7, 2026, 3:45 PM". Returns "—" for empty/invalid input. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null || value === "") return "—";
  const d = toDate(value);
  return d ? dateTimeFormatter.format(d) : "—";
}
