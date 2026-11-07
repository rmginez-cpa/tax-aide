// Philippine working-day calendar for BIR due dates.
//
// RMC 65-2016 (applying Sec. 31, Book I of the Administrative Code of 1987, EO 292):
// when a filing or payment deadline falls on a Saturday, Sunday or holiday it moves
// to the next working day (eFPS, eBIRForms and manual filers alike). If that day is
// also a non-working day, keep rolling forward.
//
// Computed here: weekends and the regular holidays that need no proclamation
// (Sec. 26, Chapter 7, Book I of EO 292 as amended by RA 9492):
//   fixed  - New Year's Day (Jan 1), Araw ng Kagitingan (Apr 9), Labor Day (May 1),
//            Independence Day (Jun 12), Bonifacio Day (Nov 30), Christmas Day (Dec 25),
//            Rizal Day (Dec 30)
//   movable - Maundy Thursday and Good Friday (from Western Easter, anonymous
//            Gregorian algorithm) and National Heroes Day (last Monday of August).
// NOT computed: Eid'l Fitr / Eid'l Adha (proclaimed each year on NCMF advice), the
// special non-working days (Chinese New Year, Black Saturday, Aug 21, Nov 1-2, Dec 8,
// Dec 24, Dec 31, ...) and ad hoc suspensions. Add those to EXTRA_HOLIDAYS once
// proclaimed (BIR treats nationwide special non-working days as holidays for this rule).
//
// All maths is on YYYY-MM-DD strings via Date.UTC, so the server's timezone never matters.

/**
 * Proclaimed non-working days the calendar cannot compute (Eid dates, special
 * non-working days, declared suspensions), as YYYY-MM-DD. Extend this list in code,
 * or set BIR_EXTRA_HOLIDAYS to a comma-separated list of dates (read at startup).
 */
export const EXTRA_HOLIDAYS: string[] = [
  // e.g. "2026-03-20" (Eid'l Fitr, once proclaimed)
];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

for (const raw of (process.env.BIR_EXTRA_HOLIDAYS ?? "").split(",")) {
  const d = raw.trim();
  if (d && ISO_RE.test(d) && !EXTRA_HOLIDAYS.includes(d)) EXTRA_HOLIDAYS.push(d);
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const match = ISO_RE.exec(iso);
  if (!match) throw new Error(`not a YYYY-MM-DD date: ${iso}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`not a valid calendar date: ${iso}`);
  }
  return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** Western (Gregorian) Easter Sunday of `year`, anonymous Gregorian algorithm. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toIso(year, month, day);
}

const FIXED_REGULAR_HOLIDAYS: Record<string, string> = {
  "01-01": "New Year's Day",
  "04-09": "Araw ng Kagitingan",
  "05-01": "Labor Day",
  "06-12": "Independence Day",
  "11-30": "Bonifacio Day",
  "12-25": "Christmas Day",
  "12-30": "Rizal Day",
};

const movableCache = new Map<number, Map<string, string>>();

/** The movable regular holidays of `year` that need no proclamation. */
function movableRegularHolidays(year: number): Map<string, string> {
  let out = movableCache.get(year);
  if (out) return out;
  out = new Map();
  const easter = parseIso(easterSunday(year));
  out.set(toIso(year, easter.m, easter.d - 3), "Maundy Thursday");
  out.set(toIso(year, easter.m, easter.d - 2), "Good Friday");
  // Last Monday of August: step back from August 31 to the Monday.
  const aug31Dow = new Date(Date.UTC(year, 7, 31)).getUTCDay(); // 0 = Sunday
  out.set(toIso(year, 8, 31 - ((aug31Dow + 6) % 7)), "National Heroes Day");
  movableCache.set(year, out);
  return out;
}

/** Name of the holiday on `iso` (regular holiday, or "Proclaimed holiday" for EXTRA_HOLIDAYS), else null. */
export function holidayName(iso: string): string | null {
  const { y } = parseIso(iso);
  const fixed = FIXED_REGULAR_HOLIDAYS[iso.slice(5)];
  if (fixed) return fixed;
  const movable = movableRegularHolidays(y).get(iso);
  if (movable) return movable;
  return EXTRA_HOLIDAYS.includes(iso) ? "Proclaimed holiday" : null;
}

/** Day of week, 0 = Sunday ... 6 = Saturday. */
function dayOfWeek(iso: string): number {
  const { y, m, d } = parseIso(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** True for Saturdays, Sundays, computable Philippine regular holidays and EXTRA_HOLIDAYS. */
export function isNonWorkingDay(iso: string): boolean {
  const dow = dayOfWeek(iso);
  return dow === 0 || dow === 6 || holidayName(iso) !== null;
}

/**
 * The first working day on or after `iso`: `iso` itself when it is a working day,
 * otherwise the next working day (RMC 65-2016 roll-forward).
 */
export function nextWorkingDay(iso: string): string {
  let { y, m, d } = parseIso(iso);
  let cur = toIso(y, m, d);
  // A run of non-working days is never longer than a couple of weeks; cap the loop anyway.
  for (let i = 0; i < 60 && isNonWorkingDay(cur); i++) {
    d += 1;
    cur = toIso(y, m, d);
    ({ y, m, d } = parseIso(cur));
  }
  return cur;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat, Feb 28 2026" */
export function formatBirDate(iso: string): string {
  const { y, m, d } = parseIso(iso);
  return `${DOW[dayOfWeek(iso)]}, ${MON[m - 1]} ${d} ${y}`;
}

/**
 * Applies the weekend/holiday rule to a statutory due date. `note` explains the move
 * (for the deadline description) and is null when the date does not move.
 */
export function adjustDueDate(statutory: string): { dueDate: string; note: string | null } {
  const dueDate = nextWorkingDay(statutory);
  if (dueDate === statutory) return { dueDate, note: null };
  const dow = dayOfWeek(statutory);
  const why = ` (${holidayName(statutory) ?? (dow === 6 ? "Saturday" : "Sunday")})`;
  return {
    dueDate,
    note:
      `Statutory due date ${formatBirDate(statutory)} falls on a non-working day${why}; ` +
      `due the next working day, ${formatBirDate(dueDate)} (RMC 65-2016).`,
  };
}
