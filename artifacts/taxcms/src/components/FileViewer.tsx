import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, X, FileText, AlertCircle, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";

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

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(mime: string) { return mime === "application/pdf"; }
function isExcel(mime: string) { return mime.includes("spreadsheetml") || mime.includes("ms-excel"); }
function isWord(mime: string) { return mime.includes("wordprocessingml") || mime === "application/msword"; }
function isImage(mime: string) { return mime.startsWith("image/"); }
function isText(mime: string, name?: string) {
  if (mime.startsWith("text/")) return true;
  const ext = (name?.split(".").pop() || "").toLowerCase();
  return ext === "dat" || ext === "csv";
}

function getFileIcon(mimeType: string, name?: string): string {
  if (isPdf(mimeType)) return "📄";
  if (isExcel(mimeType)) return "📊";
  if (isWord(mimeType)) return "📝";
  if (isImage(mimeType)) return "🖼️";
  if (isText(mimeType, name)) return "📃";
  return "📁";
}

export function FileViewer({ doc, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [sheetData, setSheetData] = useState<{ name: string; rows: string[][] }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [textContent, setTextContent] = useState<string | null>(null);
  const prevBlobUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!doc) return;
    setLoading(true);
    setError(null);
    setBlobUrl(null);
    setHtmlContent(null);
    setSheetData([]);
    setTextContent(null);

    fetch(`/api/documents/${doc.id}/content`, { credentials: "include" })
      .then(async res => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const blob = await res.blob();

        if (isExcel(doc.mimeType)) {
          const arrayBuffer = await blob.arrayBuffer();
          const { read, utils } = await import("xlsx");
          const wb = read(new Uint8Array(arrayBuffer));
          const sheets = wb.SheetNames.map(name => ({
            name,
            rows: utils.sheet_to_json<string[]>(wb.Sheets[name], { header: 1 }) as string[][],
          }));
          setSheetData(sheets);
          setActiveSheet(0);
        } else if (isWord(doc.mimeType)) {
          const arrayBuffer = await blob.arrayBuffer();
          const mammoth = await import("mammoth");
          const result = await mammoth.convertToHtml({ arrayBuffer });
          setHtmlContent(result.value);
        } else if (isText(doc.mimeType, doc.originalName)) {
          const text = await blob.text();
          setTextContent(text);
        } else {
          const url = URL.createObjectURL(blob);
          if (prevBlobUrl.current) URL.revokeObjectURL(prevBlobUrl.current);
          prevBlobUrl.current = url;
          setBlobUrl(url);
        }
      })
      .catch(e => setError(e.message || "Failed to load file"))
      .finally(() => setLoading(false));

    return () => {
      if (prevBlobUrl.current) {
        URL.revokeObjectURL(prevBlobUrl.current);
        prevBlobUrl.current = null;
      }
    };
  }, [doc?.id]);

  const handleDownload = async () => {
    if (!doc) return;
    try {
      const res = await fetch(`/api/documents/${doc.id}/content`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.originalName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silently fail
    }
  };

  return (
    <Dialog open={!!doc} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-5xl w-full h-[90vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-5 py-3 border-b shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xl shrink-0">{doc ? getFileIcon(doc.mimeType, doc.originalName) : "📁"}</span>
              <div className="min-w-0">
                <DialogTitle className="text-sm font-semibold truncate">{doc?.originalName}</DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {doc && formatFileSize(doc.fileSize)}
                  {doc?.uploadedByName && ` • ${doc.uploadedByName}`}
                  {doc?.createdAt && ` • ${format(parseISO(doc.createdAt), "MMM d, yyyy")}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
                <Download className="h-3.5 w-3.5" />Download
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {doc?.description && <p className="text-xs text-muted-foreground mt-1 italic px-0.5">{doc.description}</p>}
        </DialogHeader>

        {/* Viewer Body */}
        <div className="flex-1 overflow-hidden bg-muted/30 relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col gap-3 p-6">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}

          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <AlertCircle className="h-10 w-10 text-destructive opacity-60" />
              <p className="font-medium text-destructive">Failed to load file</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
                <Download className="h-3.5 w-3.5" />Try downloading instead
              </Button>
            </div>
          )}

          {/* PDF viewer */}
          {!loading && !error && blobUrl && doc && isPdf(doc.mimeType) && (
            <iframe
              src={blobUrl}
              className="w-full h-full border-0"
              title={doc.originalName}
            />
          )}

          {/* Image viewer */}
          {!loading && !error && blobUrl && doc && isImage(doc.mimeType) && (
            <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
              <img
                src={blobUrl}
                alt={doc.originalName}
                className="max-w-full max-h-full object-contain rounded shadow"
              />
            </div>
          )}

          {/* Plain text viewer */}
          {!loading && !error && textContent !== null && (
            <div className="w-full h-full overflow-auto p-6">
              <pre className="text-sm font-mono whitespace-pre-wrap break-words text-foreground">{textContent}</pre>
            </div>
          )}

          {/* Word (.docx) viewer */}
          {!loading && !error && htmlContent !== null && (
            <div className="w-full h-full overflow-auto p-8 bg-white">
              <div
                className="max-w-3xl mx-auto prose prose-sm prose-slate"
                dangerouslySetInnerHTML={{ __html: htmlContent }}
              />
            </div>
          )}

          {/* Excel (.xlsx) viewer */}
          {!loading && !error && sheetData.length > 0 && (
            <div className="w-full h-full flex flex-col overflow-hidden">
              {/* Sheet tabs */}
              {sheetData.length > 1 && (
                <div className="flex gap-1 px-4 pt-3 pb-0 border-b bg-background shrink-0">
                  {sheetData.map((s, i) => (
                    <button
                      key={s.name}
                      onClick={() => setActiveSheet(i)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
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
              <div className="flex-1 overflow-auto">
                <table className="text-xs border-collapse min-w-full">
                  <thead>
                    {sheetData[activeSheet]?.rows[0] && (
                      <tr className="sticky top-0 z-10">
                        {sheetData[activeSheet].rows[0].map((cell, ci) => (
                          <th
                            key={ci}
                            className="border border-gray-300 bg-gray-100 px-2 py-1.5 text-left font-semibold text-gray-700 whitespace-nowrap"
                          >
                            {String(cell ?? "")}
                          </th>
                        ))}
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {sheetData[activeSheet]?.rows.slice(1).map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="border border-gray-200 px-2 py-1 text-gray-800 whitespace-nowrap">
                            {String(cell ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Unsupported format fallback */}
          {!loading && !error && !blobUrl && htmlContent === null && sheetData.length === 0 && textContent === null && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <FileText className="h-12 w-12 text-muted-foreground opacity-40" />
              <p className="font-medium text-muted-foreground">Preview not available</p>
              <p className="text-sm text-muted-foreground">This file type cannot be previewed in the browser.</p>
              <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
                <Download className="h-3.5 w-3.5" />Download to view
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
