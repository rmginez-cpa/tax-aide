import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, X, FileText, AlertCircle, Loader2, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, downloadDocument, errorMessage } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import type { ParseRequest, ParseResponse } from "./spreadsheet.worker";

interface Doc {
  id: number;
  originalName: string;
  mimeType: string;
  fileSize: number;
  description?: string | null;
  createdAt: string;
  uploadedByName?: string | null;
}

interface FileViewerProps {
  doc: Doc | null;
  onClose: () => void;
}

/** Rows shown per Excel sheet (after the header row); the full file is available via Download. */
const MAX_SHEET_ROWS = 500;
/** Columns shown per Excel sheet. */
const MAX_SHEET_COLS = 100;
/** Characters shown for text/CSV/DAT files. */
const MAX_TEXT_CHARS = 1_000_000;
/**
 * Largest .xlsx previewed. exceljs inflates and loads the whole workbook, so beyond this
 * (well under the 50 MB upload cap) it is offered as a download instead.
 */
const MAX_SHEET_PREVIEW_BYTES = 10 * 1024 * 1024;

function isPdf(mime: string) { return mime === "application/pdf"; }
function fileExt(name?: string) { return (name?.split(".").pop() || "").toLowerCase(); }
/** Excel 97-2003 (BIFF) workbook: exceljs can't read these, so they are download-only. */
function isLegacyExcel(mime: string, name?: string) { return mime === "application/vnd.ms-excel" || fileExt(name) === "xls"; }
/** .xlsx workbook, previewed with exceljs (also when the browser uploaded it as octet-stream). */
function isXlsx(mime: string, name?: string) {
  return !isLegacyExcel(mime, name) && (mime.includes("spreadsheetml") || fileExt(name) === "xlsx");
}
function isExcel(mime: string, name?: string) { return isXlsx(mime, name) || isLegacyExcel(mime, name) || mime.includes("ms-excel"); }
function isWord(mime: string) { return mime.includes("wordprocessingml") || mime === "application/msword"; }
function isImage(mime: string) { return mime.startsWith("image/"); }
function isText(mime: string, name?: string) {
  if (mime.startsWith("text/")) return true;
  const ext = fileExt(name);
  return ext === "dat" || ext === "csv";
}

function getFileIcon(mimeType: string, name?: string): string {
  if (isPdf(mimeType)) return "📄";
  if (isExcel(mimeType, name)) return "📊";
  if (isWord(mimeType)) return "📝";
  if (isImage(mimeType)) return "🖼️";
  if (isText(mimeType, name)) return "📃";
  return "📁";
}

interface Sheet {
  name: string;
  /** Header row followed by at most MAX_SHEET_ROWS data rows, each padded to `columns`. */
  rows: string[][];
  columns: number;
  totalRows: number;
  totalColumns: number;
}

type Preview =
  | { kind: "blob"; url: string }
  | { kind: "html"; html: string }
  | { kind: "sheets"; sheets: Sheet[] }
  | { kind: "text"; text: string; truncated: boolean }
  /** No preview; `reason` says why when it is more than "this type isn't previewable". */
  | { kind: "none"; reason?: string };

let purifyHooked = false;

/** Convert .docx to sanitised HTML; links open in a new tab so they can't navigate the app away. */
async function docxToSafeHtml(arrayBuffer: ArrayBuffer): Promise<string> {
  const [mammoth, { default: DOMPurify }] = await Promise.all([import("mammoth"), import("dompurify")]);
  const result = await mammoth.convertToHtml({ arrayBuffer });
  if (!purifyHooked) {
    purifyHooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", node => {
      if (node.tagName === "A" && node.getAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
  }
  return DOMPurify.sanitize(result.value, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style"],
  });
}

/** A workbook that takes longer than this to parse (huge or pathological) is abandoned. */
const SHEET_PARSE_TIMEOUT_MS = 20_000;

/** The worker read the file but it can't be previewed (damaged, legacy, encrypted, too big). */
class NoPreviewError extends Error {}

/**
 * Parse a workbook, keeping at most MAX_SHEET_ROWS data rows per sheet. exceljs runs in a
 * dedicated worker (see spreadsheet.worker.ts), never on the page, because it loads the whole
 * workbook into memory; the worker is terminated afterwards, on abort and on timeout.
 */
function parseWorkbook(arrayBuffer: ArrayBuffer, signal: AbortSignal): Promise<Sheet[]> {
  return new Promise<Sheet[]>((resolve, reject) => {
    const worker = new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), { type: "module" });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => { done(); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { done(); reject(new Error("The spreadsheet took too long to read. Download it to view it.")); }, SHEET_PARSE_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort);
    worker.onmessage = (e: MessageEvent<ParseResponse>) => {
      done();
      if (e.data.ok) resolve(e.data.sheets);
      else reject(new NoPreviewError(e.data.error || "This workbook couldn't be read for preview."));
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || "Could not read the spreadsheet")); };
    const req: ParseRequest = { buffer: arrayBuffer, maxRows: MAX_SHEET_ROWS, maxCols: MAX_SHEET_COLS };
    worker.postMessage(req, [arrayBuffer]);
  });
}

export function FileViewer({ doc, onClose }: FileViewerProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: "none" });
  const [activeSheet, setActiveSheet] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Id of the document whose load finished; until it matches `doc.id` we show the skeleton.
  const [settledId, setSettledId] = useState<number | null>(null);

  useEffect(() => {
    if (!doc) return;
    const controller = new AbortController();
    const { signal } = controller;
    let objectUrl: string | null = null;

    setLoading(true);
    setError(null);
    setPreview({ kind: "none" });
    setActiveSheet(0);

    (async () => {
      try {
        if (isLegacyExcel(doc.mimeType, doc.originalName)) {
          setPreview({ kind: "none", reason: "Excel 97-2003 (.xls) workbooks can't be previewed in the browser. Download the file to open it in Excel." });
          return;
        }
        if (isXlsx(doc.mimeType, doc.originalName) && doc.fileSize > MAX_SHEET_PREVIEW_BYTES) {
          setPreview({ kind: "none", reason: `This workbook is too large to preview (over ${formatBytes(MAX_SHEET_PREVIEW_BYTES)}). Download it to open it in Excel.` });
          return;
        }
        const blob = await apiFetch<Blob>(`/documents/${doc.id}/content`, { responseType: "blob", signal });
        if (signal.aborted) return;

        let next: Preview;
        if (isXlsx(doc.mimeType, doc.originalName)) {
          try {
            next = { kind: "sheets", sheets: await parseWorkbook(await blob.arrayBuffer(), signal) };
          } catch (e) {
            if (!(e instanceof NoPreviewError)) throw e;
            next = { kind: "none", reason: `${e.message} Download it to open it in Excel.` };
          }
        } else if (isWord(doc.mimeType)) {
          next = { kind: "html", html: await docxToSafeHtml(await blob.arrayBuffer()) };
        } else if (isText(doc.mimeType, doc.originalName)) {
          const text = await blob.text();
          next = text.length > MAX_TEXT_CHARS
            ? { kind: "text", text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
            : { kind: "text", text, truncated: false };
        } else if (isPdf(doc.mimeType) || isImage(doc.mimeType)) {
          objectUrl = URL.createObjectURL(blob);
          next = { kind: "blob", url: objectUrl };
        } else {
          next = { kind: "none" };
        }
        // A newer document was opened while this one was parsing: drop the stale result.
        if (signal.aborted) return;
        setPreview(next);
      } catch (e) {
        if (signal.aborted) return;
        setError(errorMessage(e, "Failed to load file"));
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setSettledId(doc.id);
        }
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc?.id, reloadKey]);

  const handleDownload = useCallback(async () => {
    if (!doc) return;
    setDownloading(true);
    try {
      await downloadDocument(doc.id, doc.originalName);
    } catch (e) {
      toast({ title: "Download failed", description: errorMessage(e), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }, [doc, toast]);

  const DownloadButton = ({ label, className }: { label: string; className?: string }) => (
    <Button variant="outline" size="sm" onClick={handleDownload} disabled={downloading} className={`gap-1.5 ${className ?? ""}`}>
      {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );

  const isLoading = loading || (doc != null && settledId !== doc.id);
  const ready = !isLoading && !error;
  const sheets = preview.kind === "sheets" ? preview.sheets : [];
  const sheet = sheets[activeSheet];
  const sheetTruncated = sheet && (sheet.totalRows > sheet.rows.length || sheet.totalColumns > sheet.columns);

  return (
    <Dialog open={!!doc} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-5xl w-full h-[90vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-5 py-3 border-b shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xl shrink-0" aria-hidden>{doc ? getFileIcon(doc.mimeType, doc.originalName) : "📁"}</span>
              <div className="min-w-0">
                <DialogTitle className="text-sm font-semibold truncate">{doc?.originalName}</DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {doc && formatBytes(doc.fileSize)}
                  {doc?.uploadedByName && ` • ${doc.uploadedByName}`}
                  {doc?.createdAt && ` • ${formatDate(doc.createdAt)}`}
                </DialogDescription>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <DownloadButton label="Download" />
              <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {doc?.description && <p className="text-xs text-muted-foreground mt-1 italic px-0.5">{doc.description}</p>}
        </DialogHeader>

        {/* Viewer Body */}
        <div className="flex-1 overflow-hidden bg-muted/30 relative">
          {isLoading && (
            <div className="absolute inset-0 flex flex-col gap-3 p-6">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}

          {!isLoading && error && (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <AlertCircle className="h-10 w-10 text-destructive opacity-60" />
              <p className="font-medium text-destructive">Failed to load file</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setReloadKey(k => k + 1)}>Retry</Button>
                <DownloadButton label="Try downloading instead" />
              </div>
            </div>
          )}

          {/* PDF viewer */}
          {ready && preview.kind === "blob" && doc && isPdf(doc.mimeType) && (
            <iframe src={preview.url} className="w-full h-full border-0" title={doc.originalName} />
          )}

          {/* Image viewer */}
          {ready && preview.kind === "blob" && doc && isImage(doc.mimeType) && (
            <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
              <img src={preview.url} alt={doc.originalName} className="max-w-full max-h-full object-contain rounded shadow" />
            </div>
          )}

          {/* Plain text viewer */}
          {ready && preview.kind === "text" && (
            <div className="w-full h-full overflow-auto p-6">
              {preview.truncated && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span className="flex items-center gap-1.5"><Info className="h-3.5 w-3.5" />This file is large; only the beginning is shown.</span>
                  <DownloadButton label="Download full file" />
                </div>
              )}
              <pre className="text-sm font-mono whitespace-pre-wrap break-words text-foreground">{preview.text}</pre>
            </div>
          )}

          {/* Word (.docx) viewer — HTML is sanitised with DOMPurify */}
          {ready && preview.kind === "html" && (
            <div className="w-full h-full overflow-auto p-8 bg-white">
              <div
                className="max-w-3xl mx-auto prose prose-sm prose-slate"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            </div>
          )}

          {/* Excel (.xlsx) viewer */}
          {ready && preview.kind === "sheets" && (
            <div className="w-full h-full flex flex-col overflow-hidden">
              {sheets.length > 1 && (
                <div role="tablist" className="flex gap-1 px-4 pt-3 pb-0 border-b bg-background shrink-0 overflow-x-auto">
                  {sheets.map((s, i) => (
                    <button
                      key={`${i}-${s.name}`}
                      role="tab"
                      aria-selected={activeSheet === i}
                      onClick={() => setActiveSheet(i)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors whitespace-nowrap ${
                        activeSheet === i
                          ? "border-primary text-primary bg-white"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              {sheetTruncated && (
                <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 shrink-0">
                  <span className="flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Showing the first {Math.max(sheet.rows.length - 1, 0).toLocaleString()} of {Math.max(sheet.totalRows - 1, 0).toLocaleString()} rows
                    {sheet.totalColumns > sheet.columns && ` and ${sheet.columns} of ${sheet.totalColumns} columns`}.
                    Download the file to see everything.
                  </span>
                  <DownloadButton label="Download" />
                </div>
              )}
              <div className="flex-1 overflow-auto">
                {!sheet || sheet.rows.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">This sheet is empty.</p>
                ) : (
                  <table className="text-xs border-collapse min-w-full">
                    <thead>
                      <tr className="sticky top-0 z-10">
                        {sheet.rows[0].map((cell, ci) => (
                          <th
                            key={ci}
                            className="border border-gray-300 bg-gray-100 px-2 py-1.5 text-left font-semibold text-gray-700 whitespace-nowrap"
                          >
                            {cell}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(1).map((row, ri) => (
                        <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                          {row.map((cell, ci) => (
                            <td key={ci} className="border border-gray-200 px-2 py-1 text-gray-800 whitespace-nowrap">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* Unsupported format fallback */}
          {ready && preview.kind === "none" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <FileText className="h-12 w-12 text-muted-foreground opacity-40" />
              <p className="font-medium text-muted-foreground">Preview not available</p>
              <p className="text-sm text-muted-foreground max-w-md">{preview.reason ?? "This file type cannot be previewed in the browser."}</p>
              <DownloadButton label="Download to view" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
