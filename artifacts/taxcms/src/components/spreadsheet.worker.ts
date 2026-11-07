// Parses an uploaded .xlsx workbook with exceljs off the main thread. exceljs has no row
// limit on read (it builds the whole workbook in memory), so parsing here keeps a large or
// hostile file from freezing the page, the page can terminate a parse that runs too long,
// and only plain, cloned string rows ever reach it.
//
// "exceljs" resolves to its browser field (dist/exceljs.min.js), a self-contained bundle
// that carries its own Buffer/stream polyfills, so no Node shims are needed here.
import * as ExcelJS from "exceljs";
import type { Cell, CellValue, Worksheet } from "exceljs";

export interface WorkerSheet {
  name: string;
  rows: string[][];
  columns: number;
  totalRows: number;
  totalColumns: number;
}

export interface ParseRequest {
  buffer: ArrayBuffer;
  maxRows: number;
  maxCols: number;
}

/** `error` is a sentence for the user; the page shows it in place of the preview. */
export type ParseResponse = { ok: true; sheets: WorkerSheet[] } | { ok: false; error: string };

/**
 * Most bytes the workbook's parts may inflate to, as declared by the zip directory. Real
 * filing workbooks are a few MB unpacked; past this exceljs would need gigabytes of cells.
 */
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
/**
 * Most <row> elements exceljs may read in one sheet before it gives up. A lying zip
 * directory gets past MAX_UNPACKED_BYTES, so this bounds memory from the XML side too.
 */
const MAX_PARSE_ROWS = 50_000;

const TOO_LARGE = "This workbook is too large to preview.";
const NOT_XLSX = "This file is not a valid .xlsx workbook, so it can't be previewed.";
const LEGACY_OR_ENCRYPTED = "This workbook is in the older Excel 97-2003 format or is password-protected, so it can't be previewed.";
const UNREADABLE = "This workbook couldn't be read for preview. It may be damaged or use features the previewer doesn't support.";

class PreviewError extends Error {}

/**
 * Sum of the uncompressed sizes declared in the zip central directory, checked before
 * exceljs inflates anything (zip-bomb guard). Throws PreviewError for non-zip input.
 */
function declaredUnpackedBytes(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // OLE compound file: a BIFF .xls renamed to .xlsx, or an encrypted OOXML workbook.
  if (bytes.length >= 8 && view.getUint32(0) === 0xd0cf11e0 && view.getUint32(4) === 0xa1b11ae1) {
    throw new PreviewError(LEGACY_OR_ENCRYPTED);
  }
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new PreviewError(NOT_XLSX);
  const entries = view.getUint16(eocd + 10, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  // Zip64 markers: an xlsx that needs zip64 is far beyond what we preview.
  if (entries === 0xffff || dirOffset === 0xffffffff) throw new PreviewError(TOO_LARGE);
  let total = 0;
  let p = dirOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new PreviewError(NOT_XLSX);
    const size = view.getUint32(p + 24, true);
    if (size === 0xffffffff) throw new PreviewError(TOO_LARGE);
    total += size;
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return total;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * exceljs turns date-formatted serials into Dates at UTC, so UTC parts are the sheet's own
 * wall-clock values. Serials below 1 (before 1899-12-31) are times of day with no date.
 */
function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const time = d.getUTCSeconds()
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  if (d.getTime() < Date.UTC(1899, 11, 31)) return time;
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? `${date} ${time}` : date;
}

/** Excel's General format shows 15 significant digits; this also hides float noise like 0.1+0.2. */
const plainNumber = (n: number) => String(Number(n.toPrecision(15)));

/** Splits a number format into its ;-separated sections, ignoring ; inside quotes. */
function formatSections(fmt: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === "\"") quoted = !quoted;
    else if (ch === "\\" && !quoted) { cur += ch + (fmt[++i] ?? ""); continue; }
    if (ch === ";" && !quoted) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Formats a number the way common fixed, grouped, percent, currency and accounting formats
 * display it. Anything costlier to emulate (dates, fractions, scientific, conditions, scaling)
 * falls back to the plain value rather than guessing.
 */
function formatNumber(n: number, fmt: string | undefined): string {
  if (!Number.isFinite(n)) return String(n);
  if (!fmt || /^general$/i.test(fmt.trim())) return plainNumber(n);
  const sections = formatSections(fmt);
  let section = sections[0];
  let value = Math.abs(n);
  let sign = n < 0 ? "-" : "";
  // A negative section supplies its own sign or parentheses.
  if (n < 0 && sections.length > 1 && sections[1] !== "") { section = sections[1]; sign = ""; }
  else if (n === 0 && sections.length > 2 && sections[2] !== "") section = sections[2];

  let prefix = "";
  let suffix = "";
  let pattern = "";
  let percent = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    const lit = (s: string) => { if (pattern) suffix += s; else prefix += s; };
    if (ch === "\"") {
      const end = section.indexOf("\"", i + 1);
      lit(section.slice(i + 1, end < 0 ? undefined : end));
      i = end < 0 ? section.length : end;
    } else if (ch === "\\") lit(section[++i] ?? "");
    else if (ch === "_" || ch === "*") i++; // padding / fill: column-width effects only
    else if (ch === "[") {
      const end = section.indexOf("]", i);
      const inner = section.slice(i + 1, end < 0 ? undefined : end);
      if (inner.startsWith("$")) lit(inner.slice(1).split("-")[0]);
      else if (/^[<>=]/.test(inner) || /^[hms]+$/i.test(inner)) return plainNumber(n);
      i = end < 0 ? section.length : end; // colours, locales
    } else if ("0#?.,".includes(ch)) {
      if (suffix) return plainNumber(n); // placeholders split by literals
      pattern += ch;
    } else if (ch === "%") { percent = true; lit("%"); }
    else if (ch === "@") return plainNumber(n);
    else if (/[a-z/]/i.test(ch)) return plainNumber(n); // dates, E+ notation, fractions, "General"
    else lit(ch);
  }
  if (!pattern) return (prefix + suffix).trim() || plainNumber(n);

  const [intPat, decPat = ""] = pattern.split(".");
  if (intPat.endsWith(",")) return plainNumber(n); // thousands scaling
  if (percent) value *= 100;
  const maxDec = decPat.replace(/,/g, "").length;
  const minDec = (decPat.match(/0/g) ?? []).length;
  let [intPart, decPart = ""] = value.toFixed(maxDec).split(".");
  while (decPart.length > minDec && decPart.endsWith("0")) decPart = decPart.slice(0, -1);
  const minInt = (intPat.match(/0/g) ?? []).length;
  if (intPart === "0" && minInt === 0) intPart = "";
  intPart = intPart.padStart(minInt, "0");
  if (intPat.includes(",")) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // A negative that rounds to zero shows without its sign, as Excel does.
  if (!/[1-9]/.test(intPart + decPart)) sign = "";
  return `${sign}${prefix}${intPart}${decPart ? `.${decPart}` : ""}${suffix}`.trim();
}

/** Display text for any exceljs cell value (or formula result). */
function valueText(v: CellValue | undefined, numFmt: string | undefined, formula?: string): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return formatNumber(v, numFmt);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return formatDate(v);
  if (typeof v !== "object") return String(v);
  if ("error" in v) return String(v.error ?? "");
  if ("richText" in v) return Array.isArray(v.richText) ? v.richText.map((r) => String(r?.text ?? "")).join("") : "";
  if ("hyperlink" in v) return valueText(v.text as CellValue, numFmt);
  if ("formula" in v || "sharedFormula" in v) {
    const { result } = v as { result?: CellValue };
    // No cached result (saved by a tool that doesn't calculate): show the formula itself.
    return result === undefined ? (formula ? `=${formula}` : "") : valueText(result, numFmt);
  }
  return "";
}

function cellText(cell: Cell): string {
  // Merged slaves echo the master's value; show it once, in the master cell.
  if (cell.type === ExcelJS.ValueType.Merge) return "";
  let formula: string | undefined;
  if (cell.type === ExcelJS.ValueType.Formula) {
    try { formula = cell.formula; } catch { /* malformed shared formula */ }
  }
  return valueText(cell.value, cell.numFmt, formula);
}

function readSheet(ws: Worksheet, maxRows: number, maxCols: number): WorkerSheet {
  // Used range of non-empty cells (blank rows are skipped, as before).
  let left = 0;
  let right = 0;
  let totalRows = 0;
  ws.eachRow((row) => {
    totalRows++;
    // Typed as a number, but at runtime it is the row's {min, max} non-empty column, or null.
    const dims = row.dimensions as unknown as { min: number; max: number } | null;
    if (!dims) return;
    if (!left || dims.min < left) left = dims.min;
    if (dims.max > right) right = dims.max;
  });
  const totalColumns = left ? right - left + 1 : 0;
  const columns = Math.min(maxCols, totalColumns);
  const rows: string[][] = [];
  ws.eachRow((row) => {
    if (rows.length > maxRows) return;
    const out: string[] = new Array(columns).fill("");
    row.eachCell((cell, col) => {
      const i = col - left;
      if (i >= 0 && i < columns) out[i] = cellText(cell);
    });
    rows.push(out);
  });
  return { name: String(ws.name), rows, columns, totalRows, totalColumns };
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<ParseRequest>) => void) | null; postMessage(m: ParseResponse): void };

scope.onmessage = async (e) => {
  const { buffer, maxRows, maxCols } = e.data;
  try {
    if (declaredUnpackedBytes(new Uint8Array(buffer)) > MAX_UNPACKED_BYTES) throw new PreviewError(TOO_LARGE);
    const wb = new ExcelJS.Workbook();
    try {
      // The typings say Buffer; the browser bundle takes an ArrayBuffer. dataValidations is
      // skipped because exceljs expands each validated range into one entry per cell.
      await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0], {
        ignoreNodes: ["dataValidations"],
        maxRows: MAX_PARSE_ROWS,
      } as Parameters<typeof wb.xlsx.load>[1]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      throw new PreviewError(/^Max \w+ count/.test(msg) ? TOO_LARGE : UNREADABLE);
    }
    const sheets = wb.worksheets.map((ws) => readSheet(ws, maxRows, maxCols));
    scope.postMessage({ ok: true, sheets });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof PreviewError ? err.message : UNREADABLE });
  }
};
