// Parses an uploaded workbook off the main thread. SheetJS 0.18.5 (the last npm release)
// is affected by CVE-2023-30533 (prototype pollution on read) and CVE-2024-22363 (ReDoS):
// running it here keeps any pollution inside this throw-away worker (only plain, cloned
// rows reach the page) and lets the page terminate a parse that hangs.
import { read, utils } from "xlsx";

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

export type ParseResponse = { ok: true; sheets: WorkerSheet[] } | { ok: false; error: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<ParseRequest>) => void) | null; postMessage(m: ParseResponse): void };

scope.onmessage = (e) => {
  const { buffer, maxRows, maxCols } = e.data;
  try {
    const wb = read(new Uint8Array(buffer), { sheetRows: maxRows + 1, cellDates: true });
    const sheets = wb.SheetNames.map((name): WorkerSheet => {
      const ws = wb.Sheets[name];
      // With sheetRows, SheetJS keeps the real extent in "!fullref".
      const fullRef = (ws["!fullref"] as string | undefined) ?? (ws["!ref"] as string | undefined);
      const full = fullRef ? utils.decode_range(fullRef) : null;
      const totalRows = full ? full.e.r - full.s.r + 1 : 0;
      const totalColumns = full ? full.e.c - full.s.c + 1 : 0;
      const raw = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", blankrows: false });
      const columns = Math.min(maxCols, raw.reduce<number>((m, r) => Math.max(m, r.length), 0));
      const rows = raw.slice(0, maxRows + 1).map((r) => {
        const out: string[] = new Array(columns);
        for (let i = 0; i < columns; i++) {
          const v = Object.prototype.hasOwnProperty.call(r, i) ? r[i] : "";
          out[i] = v == null ? "" : String(v);
        }
        return out;
      });
      return {
        name: String(name),
        rows,
        columns,
        totalRows: Math.max(totalRows, rows.length),
        totalColumns: Math.max(totalColumns, columns),
      };
    });
    scope.postMessage({ ok: true, sheets });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
