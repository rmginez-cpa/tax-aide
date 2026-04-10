import { useState, useRef } from "react";
import { useListDocuments, useDeleteDocument, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { FileViewer } from "@/components/FileViewer";
import {
  Plus, Search, FileText, Trash2, Download, User2, Eye,
  FileSpreadsheet, FileType, Image, Sparkles, Upload
} from "lucide-react";
import { format, parseISO } from "date-fns";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ mimeType, className = "h-5 w-5" }: { mimeType: string; className?: string }) {
  if (mimeType === "application/pdf") return <FileText className={`${className} text-red-500`} />;
  if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel")) return <FileSpreadsheet className={`${className} text-green-600`} />;
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword") return <FileType className={`${className} text-blue-600`} />;
  if (mimeType.startsWith("image/")) return <Image className={`${className} text-violet-500`} />;
  return <FileText className={`${className} text-muted-foreground`} />;
}

function getMimeLabel(mimeType: string, originalName?: string): { label: string; color: string } {
  const ext = (originalName?.split(".").pop() || "").toLowerCase();
  if (mimeType === "application/pdf") return { label: "PDF", color: "bg-red-100 text-red-700" };
  if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel")) return { label: "Excel", color: "bg-green-100 text-green-700" };
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword") return { label: "Word", color: "bg-blue-100 text-blue-700" };
  if (mimeType.startsWith("image/")) return { label: "Image", color: "bg-violet-100 text-violet-700" };
  if (mimeType === "text/csv" || ext === "csv") return { label: "CSV", color: "bg-green-100 text-green-800" };
  if (ext === "dat") return { label: "DAT", color: "bg-yellow-100 text-yellow-800" };
  if (mimeType.startsWith("text/")) return { label: "Text", color: "bg-slate-100 text-slate-700" };
  return { label: "File", color: "bg-gray-100 text-gray-700" };
}

const ACCEPTED_TYPES = ".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat";

export default function Documents() {
  const { user } = useAuth();
  const { data: documents, isLoading } = useListDocuments();
  const deleteDocument = useDeleteDocument();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filtered = documents?.filter(d =>
    d.originalName.toLowerCase().includes(search.toLowerCase()) ||
    (d.clientName ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (d.uploadedByName ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (d.description ?? "").toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const resetUpload = () => {
    setSelectedFile(null);
    setDescription("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      toast({ title: "Please select a file to upload", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (description.trim()) formData.append("description", description.trim());

      const res = await fetch("/api/documents/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      setUploadOpen(false);
      resetUpload();
      toast({ title: "File uploaded successfully" });
    } catch (e: any) {
      toast({ title: e.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleSeedSamples = async () => {
    setSeeding(true);
    try {
      const res = await fetch("/api/documents/seed-samples", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to create samples");
      }
      const data = await res.json();
      await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      toast({ title: data.message || "Sample documents created" });
    } catch (e: any) {
      toast({ title: e.message || "Failed to create sample files", variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    deleteDocument.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast({ title: "Document deleted" });
      },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  const handleDownload = async (doc: any) => {
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
      toast({ title: "Download failed", variant: "destructive" });
    }
  };

  const canView = (doc: any) => {
    // Only show View for docs uploaded via the real file system (fileUrl points to content endpoint)
    if (!doc.fileUrl?.startsWith("/api/documents/")) return false;
    const mt: string = doc.mimeType;
    const ext = (doc.originalName?.split(".").pop() || "").toLowerCase();
    return (
      mt === "application/pdf" ||
      mt.includes("spreadsheetml") ||
      mt.includes("ms-excel") ||
      mt.includes("wordprocessingml") ||
      mt === "application/msword" ||
      mt.startsWith("image/") ||
      mt.startsWith("text/") ||
      mt === "text/csv" ||
      ext === "csv" ||
      ext === "dat"
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Documents</h2>
          <p className="text-muted-foreground">Tax documents across all clients and engagements.</p>
        </div>
        <div className="flex gap-2">
          {user?.role === "manager" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSeedSamples}
              disabled={seeding}
              className="gap-1.5"
            >
              <Sparkles className="h-4 w-4" />
              {seeding ? "Creating..." : "Create Sample Files"}
            </Button>
          )}
          {user?.role !== "viewer" && (
            <Dialog open={uploadOpen} onOpenChange={v => { setUploadOpen(v); if (!v) resetUpload(); }}>
              <DialogTrigger asChild>
                <Button className="gap-1.5"><Plus className="h-4 w-4" />Upload File</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Upload Document</DialogTitle>
                  <p className="text-sm text-muted-foreground">Upload a PDF, Excel, Word, or image file.</p>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-1.5">
                    <Label>File *</Label>
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                        selectedFile ? "border-primary/50 bg-primary/5" : "border-muted-foreground/25 hover:border-primary/40 hover:bg-muted/30"
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_TYPES}
                        className="hidden"
                        onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                      />
                      {selectedFile ? (
                        <div className="space-y-1">
                          <FileIcon mimeType={selectedFile.type} className="h-8 w-8 mx-auto" />
                          <p className="font-medium text-sm">{selectedFile.name}</p>
                          <p className="text-xs text-muted-foreground">{formatFileSize(selectedFile.size)}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7"
                            onClick={e => { e.stopPropagation(); resetUpload(); }}
                          >
                            Change file
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <Upload className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
                          <p className="text-sm font-medium">Click to select a file</p>
                          <p className="text-xs text-muted-foreground">PDF, Excel, Word, Images, Text (max 50 MB)</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Description <span className="text-muted-foreground">(optional)</span></Label>
                    <Input
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Brief description of this document..."
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
                  <Button onClick={handleUpload} disabled={uploading || !selectedFile}>
                    {uploading ? "Uploading..." : "Upload"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by filename, client, uploader, or description..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No documents found</p>
            <p className="text-sm mt-1">
              {user?.role === "manager"
                ? 'Upload a file or click "Create Sample Files" to add test documents.'
                : "Upload a file to get started."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(doc => {
            const { label, color } = getMimeLabel(doc.mimeType, doc.originalName);
            return (
              <Card key={doc.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="shrink-0">
                      <FileIcon mimeType={doc.mimeType} className="h-8 w-8" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm truncate max-w-xs">{doc.originalName}</p>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${color}`}>{label}</span>
                        {doc.version > 1 && <span className="text-xs text-muted-foreground">v{doc.version}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                        {doc.uploadedByName && (
                          <span className="flex items-center gap-1"><User2 className="h-3 w-3" />{doc.uploadedByName}</span>
                        )}
                        {doc.clientName && <span>{doc.clientName}</span>}
                        <span>{formatFileSize(doc.fileSize)}</span>
                        <span>{format(parseISO(doc.createdAt), "MMM d, yyyy")}</span>
                      </div>
                      {doc.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 italic">{doc.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {canView(doc) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 h-8 text-xs"
                          onClick={() => setViewerDoc(doc)}
                        >
                          <Eye className="h-3.5 w-3.5" />View
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        title="Download"
                        onClick={() => handleDownload(doc)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      {user?.role !== "viewer" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(doc.id, doc.originalName)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <FileViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />
    </div>
  );
}
