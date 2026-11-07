import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEngagement, useUpdateEngagement,
  useListChecklistItems, useCreateChecklistItem, useUpdateChecklistItem, useDeleteChecklistItem,
  useListDocuments, useUploadDocument,
  useListComments, useCreateComment,
  getGetEngagementQueryKey, getListChecklistItemsQueryKey, getListDocumentsQueryKey, getListCommentsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, isManager } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft, CheckSquare, FileText, MessageSquare, ThumbsUp,
  Plus, Trash2, User2, Calendar, Eye
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { FileViewer } from "@/components/FileViewer";

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-700" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700" },
  for_review: { label: "For Review", className: "bg-amber-100 text-amber-700" },
  approved: { label: "Approved", className: "bg-green-100 text-green-700" },
  filed: { label: "Filed", className: "bg-teal-100 text-teal-700" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700" },
};

const CHECKLIST_STATUSES = ["pending", "filed", "received", "paid", "not_applicable"] as const;
const CHECKLIST_STATUS_LABELS: Record<string, string> = {
  pending: "Pending", filed: "Filed", received: "Received", paid: "Paid", not_applicable: "N/A"
};

export default function EngagementDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: engagement, isLoading } = useGetEngagement(id, { query: { enabled: !!id, queryKey: getGetEngagementQueryKey(id) } });
  const { data: checklistItems } = useListChecklistItems({ engagementId: id }, { query: { enabled: !!id, queryKey: getListChecklistItemsQueryKey({ engagementId: id }) } });
  const { data: documents } = useListDocuments({ engagementId: id }, { query: { enabled: !!id, queryKey: getListDocumentsQueryKey({ engagementId: id }) } });
  const { data: comments } = useListComments({ engagementId: id }, { query: { enabled: !!id, queryKey: getListCommentsQueryKey({ engagementId: id }) } });

  const updateEngagement = useUpdateEngagement();
  const createChecklistItem = useCreateChecklistItem();
  const updateChecklistItem = useUpdateChecklistItem();
  const deleteChecklistItem = useDeleteChecklistItem();
  const uploadDocument = useUploadDocument();
  const createComment = useCreateComment();

  const [newChecklistLabel, setNewChecklistLabel] = useState("");
  const [newComment, setNewComment] = useState("");
  const [docForm, setDocForm] = useState({ originalName: "", description: "" });
  const [docOpen, setDocOpen] = useState(false);
  const [statusUpdate, setStatusUpdate] = useState("");
  const [viewerDoc, setViewerDoc] = useState<NonNullable<typeof documents>[number] | null>(null);

  const invalidateEngagement = () => queryClient.invalidateQueries({ queryKey: getGetEngagementQueryKey(id) });
  const invalidateChecklist = () => queryClient.invalidateQueries({ queryKey: getListChecklistItemsQueryKey({ engagementId: id }) });
  const invalidateComments = () => queryClient.invalidateQueries({ queryKey: getListCommentsQueryKey({ engagementId: id }) });
  const invalidateDocs = () => queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey({ engagementId: id }) });

  const handleAddChecklist = () => {
    if (!newChecklistLabel.trim()) return;
    createChecklistItem.mutate({ data: { engagementId: id, label: newChecklistLabel, sortOrder: (checklistItems?.length ?? 0) } }, {
      onSuccess: () => { setNewChecklistLabel(""); invalidateChecklist(); },
      onError: () => toast({ title: "Failed to add item", variant: "destructive" }),
    });
  };

  const handleChecklistStatusChange = (itemId: number, status: string) => {
    updateChecklistItem.mutate({ id: itemId, data: { status: status as any } }, {
      onSuccess: invalidateChecklist,
      onError: () => toast({ title: "Failed to update item", variant: "destructive" }),
    });
  };

  const handleDeleteChecklist = (itemId: number) => {
    deleteChecklistItem.mutate({ id: itemId }, {
      onSuccess: invalidateChecklist,
      onError: () => toast({ title: "Failed to delete item", variant: "destructive" }),
    });
  };

  const handleAddComment = () => {
    if (!newComment.trim()) return;
    createComment.mutate({ data: { engagementId: id, content: newComment, isApproval: false } }, {
      onSuccess: () => { setNewComment(""); invalidateComments(); toast({ title: "Comment added" }); },
      onError: () => toast({ title: "Failed to add comment", variant: "destructive" }),
    });
  };

  const handleStatusUpdate = () => {
    if (!statusUpdate) return;
    updateEngagement.mutate({ id, data: { status: statusUpdate as any } }, {
      onSuccess: () => { invalidateEngagement(); setStatusUpdate(""); toast({ title: "Status updated" }); },
      onError: (e: any) => toast({ title: e?.data?.error || "Failed to update status", variant: "destructive" }),
    });
  };

  const handleUploadDoc = () => {
    if (!docForm.originalName.trim()) return;
    const ext = docForm.originalName.split('.').pop() || 'pdf';
    const filename = `${Date.now()}-${docForm.originalName.replace(/\s/g, '-')}`;
    uploadDocument.mutate({
      data: {
        engagementId: id,
        clientId: engagement?.clientId ?? null,
        filename,
        originalName: docForm.originalName,
        mimeType: ext === 'pdf' ? 'application/pdf' : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
        fileSize: Math.floor(Math.random() * 2000000) + 50000,
        fileUrl: `/files/${filename}`,
        description: docForm.description || null,
      }
    }, {
      onSuccess: () => { setDocOpen(false); setDocForm({ originalName: "", description: "" }); invalidateDocs(); toast({ title: "Document uploaded" }); },
      onError: () => toast({ title: "Upload failed", variant: "destructive" }),
    });
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
  }

  if (!engagement) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Engagement not found.</p>
        <Link href="/engagements"><Button variant="outline" className="mt-4"><ArrowLeft className="h-4 w-4 mr-2" />Back</Button></Link>
      </div>
    );
  }

  const st = STATUS_STYLES[engagement.status] || STATUS_STYLES.pending;
  const checklistTotal = checklistItems?.length ?? 0;
  const checklistDone = checklistItems?.filter(i => i.status !== "pending").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/engagements">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold">{engagement.title}</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.className}`}>{st.label}</span>
          </div>
          <p className="text-muted-foreground text-sm">{engagement.clientName} • {engagement.taxType} • {engagement.period}</p>
        </div>

        {/* Status overrides are manager-only on the server */}
        {isManager(user?.role) && (
          <div className="flex items-center gap-2">
            <Select value={statusUpdate} onValueChange={setStatusUpdate}>
              <SelectTrigger className="w-40 text-xs"><SelectValue placeholder="Update status" /></SelectTrigger>
              <SelectContent>
                {/* "completed" is reached only by approving the workflow stages */}
                {Object.entries(STATUS_STYLES).filter(([k]) => k !== "completed").map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {statusUpdate && <Button size="sm" onClick={handleStatusUpdate} disabled={updateEngagement.isPending}>Update</Button>}
          </div>
        )}

      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {engagement.assignedToName && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><User2 className="h-3 w-3" />Assigned To</p>
              <p className="font-medium text-sm">{engagement.assignedToName}</p>
            </CardContent>
          </Card>
        )}
        {engagement.dueDate && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Calendar className="h-3 w-3" />Due Date</p>
              <p className="font-medium text-sm">{format(parseISO(engagement.dueDate), 'MMMM d, yyyy')}</p>
            </CardContent>
          </Card>
        )}
        {engagement.approvedByName && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><ThumbsUp className="h-3 w-3" />Approved By</p>
              <p className="font-medium text-sm">{engagement.approvedByName}</p>
              {engagement.approvedAt && <p className="text-xs text-muted-foreground">{format(parseISO(engagement.approvedAt), 'MMM d, yyyy')}</p>}
            </CardContent>
          </Card>
        )}
      </div>

      {engagement.approvalNotes && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4">
            <p className="text-xs font-semibold text-amber-700 mb-1">Manager Notes</p>
            <p className="text-sm text-amber-900">{engagement.approvalNotes}</p>
          </CardContent>
        </Card>
      )}

      {/* Checklist */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckSquare className="h-4 w-4" />Checklist
            </CardTitle>
            <span className="text-xs text-muted-foreground">{checklistDone}/{checklistTotal} completed</span>
          </div>
          {checklistTotal > 0 && (
            <div className="w-full bg-muted rounded-full h-1.5 mt-2">
              <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${checklistTotal ? (checklistDone / checklistTotal) * 100 : 0}%` }} />
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {checklistItems?.map(item => (
            <div key={item.id} className="flex items-center gap-3 p-2 rounded-md border">
              <Select value={item.status} onValueChange={v => handleChecklistStatusChange(item.id, v)} disabled={!can(user, "editFilings")}>
                <SelectTrigger className="w-32 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECKLIST_STATUSES.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">{CHECKLIST_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className={`flex-1 text-sm ${item.status !== "pending" ? "line-through text-muted-foreground" : ""}`}>{item.label}</span>
              {item.completedByName && <span className="text-xs text-muted-foreground">{item.completedByName}</span>}
              {can(user, "editFilings") && (
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteChecklist(item.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {can(user, "editFilings") && (
            <div className="flex gap-2 pt-2">
              <Input value={newChecklistLabel} onChange={e => setNewChecklistLabel(e.target.value)} placeholder="Add checklist item..." className="text-sm" onKeyDown={e => e.key === "Enter" && handleAddChecklist()} />
              <Button size="sm" onClick={handleAddChecklist} disabled={!newChecklistLabel.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documents */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle>
            {can(user, "uploadDocuments") && (
              <Dialog open={docOpen} onOpenChange={setDocOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1" />Upload</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Upload Document</DialogTitle></DialogHeader>
                  <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                      <Label>Filename *</Label>
                      <Input value={docForm.originalName} onChange={e => setDocForm(f => ({ ...f, originalName: e.target.value }))} placeholder="ITR 1702 Form.pdf" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Description</Label>
                      <Input value={docForm.description} onChange={e => setDocForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setDocOpen(false)}>Cancel</Button>
                    <Button onClick={handleUploadDoc} disabled={uploadDocument.isPending}>Upload</Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {documents && documents.length > 0 ? (
            <div className="space-y-2">
              {documents.map(doc => (
                <button
                  key={doc.id}
                  className="w-full flex items-center gap-3 p-3 rounded-md border hover:bg-muted/50 transition-colors text-left group"
                  onClick={() => setViewerDoc(doc)}
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.originalName}</p>
                    <p className="text-xs text-muted-foreground">v{doc.version} · {doc.uploadedByName} · {format(parseISO(doc.createdAt), 'MMM d, yyyy')}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{(doc.fileSize / 1024).toFixed(0)} KB</span>
                  <Eye className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No documents uploaded yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Comments */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><MessageSquare className="h-4 w-4" />Comments & Review</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {comments && comments.length > 0 ? (
            <div className="space-y-3">
              {comments.map(comment => (
                <div key={comment.id} className={`p-3 rounded-md border ${comment.isApproval ? 'bg-green-50 border-green-200' : 'bg-muted/30'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-sm">{comment.authorName}</span>
                    <span className="text-xs text-muted-foreground capitalize bg-muted px-1.5 py-0.5 rounded">{comment.authorRole}</span>
                    {comment.isApproval && <span className="text-xs text-green-700 font-semibold">Approval</span>}
                    <span className="text-xs text-muted-foreground ml-auto">{format(parseISO(comment.createdAt), 'MMM d, h:mm a')}</span>
                  </div>
                  <p className="text-sm">{comment.content}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          )}
          {can(user, "comment") && (
            <div className="space-y-2 pt-2">
              <Separator />
              <Textarea value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Add a comment..." rows={2} />
              <div className="flex justify-end">
                <Button size="sm" onClick={handleAddComment} disabled={!newComment.trim() || createComment.isPending}>
                  Post Comment
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {viewerDoc && (
        <FileViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />
      )}
    </div>
  );
}
