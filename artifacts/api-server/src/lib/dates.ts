// BIR deadlines are Philippine calendar dates, so "today" must be the date in
// Asia/Manila, not the server's UTC date (which lags Manila by 8 hours).

/** Today's date in Asia/Manila as YYYY-MM-DD. */
export function manilaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
}

/** The current calendar year in Asia/Manila. */
export function manilaYear(now: Date = new Date()): number {
  return Number(manilaToday(now).slice(0, 4));
}

/** Adds whole days to a YYYY-MM-DD date string. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First day of the month of a YYYY-MM-DD date. */
export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}
