import { differenceInCalendarDays, parseISO } from "date-fns";

/** Today's date in Asia/Manila as YYYY-MM-DD. */
export function manilaToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A deadline is overdue only once its due date is strictly before today (Manila). */
export function isOverdue(dueDate: string, status?: string | null): boolean {
  return status !== "completed" && dueDate.slice(0, 10) < manilaToday();
}

/** Whole calendar days from today (Manila) until the due date; 0 = due today, 1 = tomorrow. */
export function daysUntil(dueDate: string): number {
  return differenceInCalendarDays(parseISO(dueDate.slice(0, 10)), parseISO(manilaToday()));
}
