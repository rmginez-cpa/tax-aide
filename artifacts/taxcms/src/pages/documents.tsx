import { useState } from "react";
import {
  useListDocuments, useUploadDocument, useDeleteDocument, getListDocumentsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, FileText, Trash2, Download, User2 } from "lucide-react";
import { format, parseISO } from "date-fns";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Documents() {
  const { user } = useAuth();
  const { data: documents, isLoading } = useListDocuments();
  const uploadDocument = useUploadDocument();
  const deleteDocument = useDeleteDocument();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ originalName: "", description: "" });

  const filtered = documents?.filter(d =>
    d.originalName.toLowerCase().includes(search.toLowerCase()) ||
    (d.clientName ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (d.uploadedByName ?? "").toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const handleUpload = () => {
    if (!form.originalName.trim()) {
      toast({ title: "Filename is required", variant: "destructive" });
      return;
    }
    const ext = form.originalName.split('.').pop() || 'pdf';
    const filename = `${Date.now()}-${form.originalName.replace(/\s+/g, '-')}`;
    uploadDocument.mutate({
      data: {
        filename,
        originalName: form.originalName,
        mimeType: ext === 'pdf' ? 'application/pdf' : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
        fileSize: Math.floor(Math.random() * 2000000) + 50000,
        fileUrl: `/files/${filename}`,
        description: form.description || null,
        engagementId: null,
        clientId: null,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        setOpen(false);
        setForm({ originalName: "", description: "" });
        toast({ title: "Document uploaded" });
      },
      onError: () => toast({ title: "Upload failed", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteDocument.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast({ title: "Document deleted" });
      },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
    return '📁';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Documents</h2>
          <p className="text-muted-foreground">All tax documents across clients and engagements.</p>
        </div>
        {user?.role !== "viewer" && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />Upload Document</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Upload Document</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="space-y-1.5">
                  <Label>Filename *</Label>
                  <Input value={form.originalName} onChange={e => setForm(f => ({ ...f, originalName: e.target.value }))} placeholder="Annual_ITR_2024.pdf" />
                  <p className="text-xs text-muted-foreground">Include the file extension (.pdf, .xlsx, .docx)</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Brief description of this document" />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleUpload} disabled={uploadDocument.isPending}>
                  {uploadDocument.isPending ? "Uploading..." : "Upload"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search documents..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No documents found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(doc => (
            <Card key={doc.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="text-2xl w-8 shrink-0">{getFileIcon(doc.mimeType)}</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{doc.originalName}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                      <span className="flex items-center gap-1"><User2 className="h-3 w-3" />{doc.uploadedByName}</span>
                      {doc.clientName && <span>{doc.clientName}</span>}
                      <span>{formatFileSize(doc.fileSize)}</span>
                      <span>v{doc.version}</span>
                      <span>{format(parseISO(doc.createdAt), 'MMM d, yyyy')}</span>
                    </div>
                    {doc.description && <p className="text-xs text-muted-foreground mt-1 italic">{doc.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" title="Download (simulated)">
                      <Download className="h-4 w-4" />
                    </Button>
                    {user?.role !== "viewer" && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(doc.id, doc.originalName)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
