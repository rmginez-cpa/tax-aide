import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEngagement, useUpdateEngagement,
  useListChecklistItems, useCreateChecklistItem, useUpdateChecklistItem, useDeleteChecklistItem,
  useListDocuments, useListDeadlines,
  useListComments, useCreateComment,
  getGetEngagementQueryKey, getListChecklistItemsQueryKey, getListDocumentsQueryKey, getListCommentsQueryKey,
  getListDeadlinesQueryKey,
  type ChecklistItemStatus, type EngagementStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, isManager } from "@/lib/permissions";
import { errorMessage, errorStatus } from "@/lib/api";
import { formatBytes, formatDate, formatDateTime } from "@/lib/format";
import {
  ENGAGEMENT_STATUS, FILING_STAGES, FILING_STAGE_KEYS, getEngagementStatus, getStageStatus, roleLabel,
  type FilingStageKey,
} from "@/lib/status";
import { invalidateFilingData } from "@/lib/queries";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, CheckSquare, FileText, MessageSquare, ThumbsUp,
  Plus, Trash2, User2, Calendar, Eye, Workflow, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileViewer } from "@/components/FileViewer";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

const CHECKLIST_STATUSES = ["pending", "filed", "received", "paid", "not_applicable"] as const;
const CHECKLIST_STATUS_LABELS: Record<string, string> = {
  pending: "Pending", filed: "Filed", received: "Received", paid: "Paid", not_applicable: "N/A"
};

/** Manual status overrides a manager may set ("completed" is reached only by approving the workflow stages). */
const STATUS_OVERRIDES = ["pending", "in_progress"] as const;

function BackButton({ label = "Back to engagements", withText = false }: { label?: string; withText?: boolean }) {
  return withText ? (
    <Button asChild variant="outline" className="mt-4">
      <Link href="/engagements"><ArrowLeft className="h-4 w-4 mr-2" />Back</Link>
    </Button>
  ) : (
    <Button asChild variant="ghost" size="icon" aria-label={label}>
      <Link href="/engagements"><ArrowLeft className="h-4 w-4" /></Link>
    </Button>
  );
}

export default function EngagementDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const canEdit = can(user, "editFilings");

  const engagementQuery = useGetEngagement(id, { query: { enabled: !!id, queryKey: getGetEngagementQueryKey(id) } });
  const { data: engagement, isLoading } = engagementQuery;
  const checklistQuery = useListChecklistItems({ engagementId: id }, { query: { enabled: !!id, queryKey: getListChecklistItemsQueryKey({ engagementId: id }) } });
  const documentsQuery = useListDocuments({ engagementId: id }, { query: { enabled: !!id, queryKey: getListDocumentsQueryKey({ engagementId: id }) } });
  const commentsQuery = useListComments({ engagementId: id }, { query: { enabled: !!id, queryKey: getListCommentsQueryKey({ engagementId: id }) } });
  // The linked deadline (if any) is what the workflow marks completed.
  const { data: linkedDeadlines } = useListDeadlines({ engagementId: id }, { query: { enabled: !!id, queryKey: getListDeadlinesQueryKey({ engagementId: id }) } });

  const checklistItems = checklistQuery.data;
  const documents = documentsQuery.data;
  const comments = commentsQuery.data;

  const updateEngagement = useUpdateEngagement();
  const createChecklistItem = useCreateChecklistItem();
  const updateChecklistItem = useUpdateChecklistItem();
  const deleteChecklistItem = useDeleteChecklistItem();
  const createComment = useCreateComment();

  const [newChecklistLabel, setNewChecklistLabel] = useState("");
  const [newComment, setNewComment] = useState("");
  const [statusUpdate, setStatusUpdate] = useState("");
  const [viewerDoc, setViewerDoc] = useState<NonNullable<typeof documents>[number] | null>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);

  const refresh = () => invalidateFilingData(queryClient);
  const failToast = (title: string) => (err: unknown) =>
    toast({ title, description: errorMessage(err), variant: "destructive" });

  const handleAddChecklist = () => {
    const label = newChecklistLabel.trim();
    if (!label) return;
    createChecklistItem.mutate({ data: { engagementId: id, label, sortOrder: (checklistItems?.length ?? 0) } }, {
      onSuccess: () => { setNewChecklistLabel(""); void refresh(); },
      onError: failToast("Failed to add item"),
    });
  };

  const handleChecklistStatusChange = (itemId: number, status: string) => {
    updateChecklistItem.mutate({ id: itemId, data: { status: status as ChecklistItemStatus } }, {
      onSuccess: () => { void refresh(); },
      onError: failToast("Failed to update item"),
    });
  };

  const handleDeleteChecklist = async (itemId: number, label: string) => {
    await confirm({
      title: "Delete checklist item?",
      description: `"${label}" will be removed from this engagement's checklist.`,
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: async () => {
        await deleteChecklistItem.mutateAsync({ id: itemId });
        await refresh();
        toast({ title: "Checklist item deleted" });
      },
    });
  };

  const handleAddComment = () => {
    const content = newComment.trim();
    if (!content) return;
    createComment.mutate({ data: { engagementId: id, content, isApproval: false } }, {
      onSuccess: () => { setNewComment(""); void refresh(); toast({ title: "Comment added" }); },
      onError: failToast("Failed to add comment"),
    });
  };

  const handleStatusUpdate = () => {
    if (!statusUpdate) return;
    updateEngagement.mutate({ id, data: { status: statusUpdate as EngagementStatus } }, {
      onSuccess: () => { void refresh(); setStatusUpdate(""); toast({ title: "Status updated" }); },
      onError: failToast("Failed to update status"),
    });
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
  }

  if (engagementQuery.isError && errorStatus(engagementQuery.error) !== 404) {
    return (
      <div className="space-y-4">
        <BackButton />
        <ErrorState title="Could not load this engagement" error={engagementQuery.error} onRetry={() => engagementQuery.refetch()} />
      </div>
    );
  }

  if (!engagement) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Engagement not found.</p>
        <BackButton withText />
      </div>
    );
  }

  const st = getEngagementStatus(engagement.status);
  const stageStatuses: Partial<Record<FilingStageKey, string>> = engagement.stageStatuses ?? {};
  const paymentNA = stageStatuses.payment === "not_applicable";
  const totalStages = paymentNA ? 3 : 4;
  const approvedStages = FILING_STAGE_KEYS.filter(k => stageStatuses[k] === "approved").length;
  const linkedDeadline = linkedDeadlines?.[0] ?? null;

  const checklistTotal = checklistItems?.length ?? 0;
  const checklistDone = checklistItems?.filter(i => i.status !== "pending").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <BackButton />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold break-words min-w-0">{engagement.title}</h2>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium border", st.className)}>{st.label}</span>
          </div>
          <p className="text-muted-foreground text-sm">{engagement.clientName} • {engagement.taxType} • {engagement.period}</p>
        </div>

        {/* Status overrides are manager-only on the server */}
        {isManager(user?.role) && (
          <div className="flex items-center gap-2">
            <Select value={statusUpdate} onValueChange={setStatusUpdate}>
              <SelectTrigger className="w-40 text-xs" aria-label="Update status"><SelectValue placeholder="Update status" /></SelectTrigger>
              <SelectContent>
                {STATUS_OVERRIDES.map(k => (
                  <SelectItem key={k} value={k}>{ENGAGEMENT_STATUS[k]?.label ?? k}</SelectItem>
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
              <p className="font-medium text-sm">{formatDate(engagement.dueDate, "long")}</p>
            </CardContent>
          </Card>
        )}
        {engagement.approvedByName && (
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><ThumbsUp className="h-3 w-3" />Approved By</p>
              <p className="font-medium text-sm">{engagement.approvedByName}</p>
              {engagement.approvedAt && <p className="text-xs text-muted-foreground">{formatDate(engagement.approvedAt)}</p>}
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

      {/* Filing workflow: the 4 parallel stages */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2"><Workflow className="h-4 w-4" />Filing Workflow</CardTitle>
            <span className="text-xs text-muted-foreground">
              {engagement.status === "completed" ? "Filing complete" : `${approvedStages} / ${totalStages} stages approved`}
            </span>
          </div>
          <Progress value={(approvedStages / totalStages) * 100} className="h-1.5 mt-2" aria-label="Stages approved" />
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="grid gap-2 sm:grid-cols-2">
            {FILING_STAGE_KEYS.map((key, idx) => {
              const ss = getStageStatus(stageStatuses[key] ?? "not_started");
              return (
                <li key={key} className="flex items-center justify-between gap-2 rounded-md border p-2.5">
                  <span className="text-sm min-w-0">
                    <span className="text-muted-foreground">Stage {idx + 1}:</span> {FILING_STAGES[key].label}
                  </span>
                  <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium border shrink-0", ss.className)}>{ss.label}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {canEdit
                ? "Upload documents, submit stages and track approvals in the filing workflow."
                : "View each stage's documents and approval status in the filing workflow."}
            </p>
            <Button size="sm" onClick={() => setWorkflowOpen(true)}>
              <Workflow className="h-4 w-4 mr-2" />Open filing workflow
            </Button>
          </div>
        </CardContent>
      </Card>

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
          {checklistQuery.isError && (
            <ErrorState compact title="Could not load the checklist" error={checklistQuery.error} onRetry={() => checklistQuery.refetch()} />
          )}
          {checklistItems?.map(item => (
            <div key={item.id} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 p-2 rounded-md border">
              <Select value={item.status} onValueChange={v => handleChecklistStatusChange(item.id, v)} disabled={!canEdit}>
                <SelectTrigger className="w-32 h-7 text-xs" aria-label={`Status of ${item.label}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECKLIST_STATUSES.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">{CHECKLIST_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className={cn("flex-1 min-w-0 break-words text-sm", item.status !== "pending" && "line-through text-muted-foreground")}>{item.label}</span>
              {item.completedByName && <span className="text-xs text-muted-foreground">{item.completedByName}</span>}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete checklist item ${item.label}`}
                  onClick={() => handleDeleteChecklist(item.id, item.label)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {!checklistQuery.isError && checklistTotal === 0 && !canEdit && (
            <p className="text-sm text-muted-foreground text-center py-2">No checklist items.</p>
          )}
          {canEdit && (
            <div className="flex gap-2 pt-2">
              <Input
                value={newChecklistLabel}
                onChange={e => setNewChecklistLabel(e.target.value)}
                placeholder="Add checklist item..."
                aria-label="New checklist item"
                className="text-sm"
                onKeyDown={e => e.key === "Enter" && handleAddChecklist()}
              />
              <Button
                size="sm"
                onClick={handleAddChecklist}
                disabled={!newChecklistLabel.trim() || createChecklistItem.isPending}
                aria-label="Add checklist item"
              >
                {createChecklistItem.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documents (uploaded per stage in the filing workflow) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle>
            {can(user, "uploadDocuments") && (
              <Button size="sm" variant="outline" onClick={() => setWorkflowOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />Upload
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {documentsQuery.isError ? (
            <ErrorState compact title="Could not load documents" error={documentsQuery.error} onRetry={() => documentsQuery.refetch()} />
          ) : documents && documents.length > 0 ? (
            <div className="space-y-2">
              {documents.map(doc => {
                const stage = doc.stage ? FILING_STAGES[doc.stage] : undefined;
                return (
                  <button
                    key={doc.id}
                    type="button"
                    className="w-full flex items-center gap-3 p-3 rounded-md border hover:bg-muted/50 transition-colors text-left group"
                    onClick={() => setViewerDoc(doc)}
                  >
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{doc.originalName}</p>
                      <p className="text-xs text-muted-foreground">
                        {stage && <span className={cn("inline-block rounded px-1.5 mr-1.5 font-medium", stage.className)}>{stage.shortLabel}</span>}
                        v{doc.version} · {doc.uploadedByName} · {formatDate(doc.createdAt)}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{formatBytes(doc.fileSize)}</span>
                    <Eye className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" aria-hidden="true" />
                  </button>
                );
              })}
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
          {commentsQuery.isError ? (
            <ErrorState compact title="Could not load comments" error={commentsQuery.error} onRetry={() => commentsQuery.refetch()} />
          ) : comments && comments.length > 0 ? (
            <div className="space-y-3">
              {comments.map(comment => (
                <div key={comment.id} className={cn("p-3 rounded-md border", comment.isApproval ? "bg-green-50 border-green-200" : "bg-muted/30")}>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-semibold text-sm">{comment.authorName}</span>
                    {comment.authorRole && (
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{roleLabel(comment.authorRole)}</span>
                    )}
                    {comment.isApproval && <span className="text-xs text-green-700 font-semibold">Approval</span>}
                    <span className="text-xs text-muted-foreground ml-auto">{formatDateTime(comment.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{comment.content}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          )}
          {can(user, "comment") && (
            <div className="space-y-2 pt-2">
              <Separator />
              <Textarea value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Add a comment..." aria-label="New comment" rows={2} />
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

      {workflowOpen && (
        <FilingWorkflowDialog
          open={workflowOpen}
          onClose={() => setWorkflowOpen(false)}
          deadlineId={linkedDeadline?.id ?? null}
          engagementId={engagement.id}
          clientId={engagement.clientId}
          formNumber={engagement.formNumber ?? engagement.taxType}
          description={engagement.clientName ?? ""}
          period={engagement.period}
          dueDate={engagement.dueDate ?? linkedDeadline?.dueDate ?? ""}
        />
      )}
    </div>
  );
}
