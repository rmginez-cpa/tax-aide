import { useState, useRef, useCallback } from "react";
import { PDFDocument } from "pdf-lib";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  FileText, Upload, X, ArrowUp, ArrowDown,
  Loader2, Merge, GripVertical, CheckCircle2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatBytes as formatFileSize } from "@/lib/format";

interface MergePDFDialogProps {
  open: boolean;
  onClose: () => void;
  onUploaded?: (doc: any) => void;
  engagementId?: number | null;
  clientId?: number | null;
  stageId?: string | null;
}

interface PDFEntry {
  id: string;
  file: File;
  pageCount: number | null;
  dragging?: boolean;
}

type Step = "select" | "reorder" | "uploading" | "done";

export function MergePDFDialog({
  open,
  onClose,
  onUploaded,
  engagementId,
  clientId,
  stageId,
}: MergePDFDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("select");
  const [entries, setEntries] = useState<PDFEntry[]>([]);
  const [description, setDescription] = useState("");
  const [outputName, setOutputName] = useState("merged.pdf");
  const [isDragOver, setIsDragOver] = useState(false);
  const [merging, setMerging] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep("select");
    setEntries([]);
    setDescription("");
    setOutputName("merged.pdf");
    setIsDragOver(false);
    setMerging(false);
    setDragOverIndex(null);
    setDraggingIndex(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // Count pages in a PDF file
  const countPages = async (file: File): Promise<number | null> => {
    try {
      const buf = await file.arrayBuffer();
      const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
      return pdf.getPageCount();
    } catch {
      return null;
    }
  };

  const addFiles = useCallback(async (files: File[]) => {
    const pdfs = files.filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) {
      toast({ title: "Only PDF files can be merged", variant: "destructive" });
      return;
    }
    const newEntries = await Promise.all(
      pdfs.map(async (file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        pageCount: await countPages(file),
      }))
    );
    setEntries(prev => {
      const updated = [...prev, ...newEntries];
      // Set default output name from first file
      if (prev.length === 0 && updated.length > 0) {
        const base = updated[0].file.name.replace(/\.pdf$/i, "");
        setOutputName(`${base}-merged.pdf`);
      }
      return updated;
    });
  }, [toast]);

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeEntry = (id: string) => {
    setEntries(prev => prev.filter(e => e.id !== id));
  };

  const moveEntry = (index: number, dir: -1 | 1) => {
    setEntries(prev => {
      const arr = [...prev];
      const target = index + dir;
      if (target < 0 || target >= arr.length) return arr;
      [arr[index], arr[target]] = [arr[target], arr[index]];
      return arr;
    });
  };

  // Drag-to-reorder handlers
  const handleDragStart = (index: number) => setDraggingIndex(index);
  const handleDragEnter = (index: number) => setDragOverIndex(index);
  const handleDragEnd = () => {
    if (draggingIndex !== null && dragOverIndex !== null && draggingIndex !== dragOverIndex) {
      setEntries(prev => {
        const arr = [...prev];
        const [moved] = arr.splice(draggingIndex, 1);
        arr.splice(dragOverIndex, 0, moved);
        return arr;
      });
    }
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const totalPages = entries.reduce((acc, e) => acc + (e.pageCount ?? 0), 0);

  // ── Merge + Upload ──────────────────────────────────────────────────────────
  const handleMergeAndUpload = async () => {
    if (entries.length < 1) return;
    setMerging(true);
    setStep("uploading");
    try {
      const merged = await PDFDocument.create();
      for (const entry of entries) {
        const buf = await entry.file.arrayBuffer();
        const srcPdf = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(srcPdf, srcPdf.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      }
      const mergedBytes = await merged.save();
      const blob = new Blob([mergedBytes as unknown as BlobPart], { type: "application/pdf" });
      const safeOutputName = outputName.trim() || "merged.pdf";
      const file = new File([blob], safeOutputName.endsWith(".pdf") ? safeOutputName : `${safeOutputName}.pdf`, {
        type: "application/pdf",
      });

      const fd = new FormData();
      fd.append("file", file);
      if (description.trim()) fd.append("description", description.trim());
      if (engagementId) fd.append("engagementId", String(engagementId));
      if (clientId) fd.append("clientId", String(clientId));
      if (stageId) fd.append("stage", stageId);

      const doc = await apiFetch("/documents/upload", { method: "POST", body: fd });
      setStep("done");
      onUploaded?.(doc);
    } catch (e) {
      toast({ title: "Merge and upload failed", description: errorMessage(e), variant: "destructive" });
      setStep("reorder");
    } finally {
      setMerging(false);
    }
  };

  const totalSize = entries.reduce((acc, e) => acc + e.file.size, 0);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5 text-primary" />
            Upload Merged PDF
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Combine multiple PDFs into one file before uploading.
          </p>
        </DialogHeader>

        {/* ── Done ── */}
        {step === "done" && (
          <div className="py-8 text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
            <p className="font-semibold text-lg">Merged PDF uploaded!</p>
            <p className="text-sm text-muted-foreground">
              {entries.length} files ({totalPages} pages) merged and uploaded successfully.
            </p>
            <Button onClick={handleClose} className="mt-2">Done</Button>
          </div>
        )}

        {/* ── Uploading ── */}
        {step === "uploading" && (
          <div className="py-10 text-center space-y-3">
            <Loader2 className="h-10 w-10 text-primary animate-spin mx-auto" />
            <p className="font-medium">Merging and uploading…</p>
            <p className="text-sm text-muted-foreground">
              Combining {entries.length} PDF files, please wait.
            </p>
          </div>
        )}

        {/* ── Select / Reorder ── */}
        {(step === "select" || step === "reorder") && (
          <div className="space-y-4 py-1">

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors",
                isDragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/40 hover:bg-muted/30"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
              <Upload className="h-7 w-7 mx-auto text-muted-foreground opacity-50 mb-2" />
              <p className="text-sm font-medium">
                {entries.length === 0 ? "Click or drag PDF files here" : "Add more PDFs"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Only PDF files are supported</p>
            </div>

            {/* File list */}
            {entries.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                    Files — drag rows to reorder
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {entries.length} file{entries.length !== 1 ? "s" : ""}
                    {totalPages > 0 ? ` · ${totalPages} pages` : ""}
                    {" · "}{formatFileSize(totalSize)}
                  </span>
                </div>
                <div className="border rounded-md overflow-hidden divide-y">
                  {entries.map((entry, idx) => (
                    <div
                      key={entry.id}
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragEnter={() => handleDragEnter(idx)}
                      onDragEnd={handleDragEnd}
                      onDragOver={e => e.preventDefault()}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 bg-background transition-colors",
                        dragOverIndex === idx && draggingIndex !== idx && "bg-primary/8 border-l-2 border-primary",
                        draggingIndex === idx && "opacity-40"
                      )}
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing" />
                      <span className="text-xs font-medium text-muted-foreground w-5 text-right shrink-0">{idx + 1}</span>
                      <FileText className="h-4 w-4 text-red-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{entry.file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {entry.pageCount !== null ? `${entry.pageCount}p` : "?"} · {formatFileSize(entry.file.size)}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6"
                          disabled={idx === 0}
                          onClick={() => moveEntry(idx, -1)}
                          title="Move up"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6"
                          disabled={idx === entries.length - 1}
                          onClick={() => moveEntry(idx, 1)}
                          title="Move down"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => removeEntry(entry.id)}
                          title="Remove"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {entries.length > 0 && (
              <>
                <div className="space-y-1.5">
                  <Label>Output filename</Label>
                  <Input
                    value={outputName}
                    onChange={e => setOutputName(e.target.value)}
                    placeholder="merged.pdf"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Description <span className="text-muted-foreground">(optional)</span></Label>
                  <Input
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Brief description of this document…"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={() => {
                  if (entries.length < 2) {
                    toast({ title: "Add at least 2 PDF files to merge", variant: "destructive" });
                    return;
                  }
                  setStep("reorder");
                  handleMergeAndUpload();
                }}
                disabled={entries.length === 0}
                className="gap-2"
              >
                <Merge className="h-4 w-4" />
                Merge &amp; Upload
                {entries.length > 0 && ` (${entries.length} files)`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
