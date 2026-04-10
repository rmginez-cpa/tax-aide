import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListDocuments, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FileViewer } from "@/components/FileViewer";
import {
  Upload, Check, ChevronRight, FileText, FileSpreadsheet,
  FileType, Image as ImageIcon, AlertCircle, Loader2,
  PlayCircle, SkipForward, SendHorizontal, ThumbsUp, ThumbsDown,
  Inbox, PenLine, Receipt, CreditCard, RotateCcw
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────────────

interface Engagement {
  id: number;
  status: string;
  workflowStage: string | null;
  title: string;
  notes: string | null;
  approvalNotes: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
}

interface Comment {
  id: number;
  content: string;
  isApproval: boolean;
  userId: number;
  userName?: string;
  createdAt: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  deadlineId: number | null;
  engagementId: number | null;
  clientId: number;
  formNumber: string;
  description: string;
  period: string;
  dueDate: string;
  onUpdate: () => void;
}

// ── Stages ───────────────────────────────────────────────────────────────────

const STAGES = [
  {
    id: "source_collection",
    label: "Source Documents",
    shortLabel: "Sources",
    icon: Inbox,
    hint: "Collect all taxpayer source documents (BIR alphalists, receipts, ledgers, etc.)",
  },
  {
    id: "draft_return",
    label: "Draft Tax Return",
    shortLabel: "Draft",
    icon: PenLine,
    hint: "Prepare and upload the draft BIR tax return for manager review.",
  },
  {
    id: "confirmation",
    label: "Confirmation Receipt",
    shortLabel: "Confirmation",
    icon: Receipt,
    hint: "Upload the eFiling or BIR confirmation receipt after successful submission.",
  },
  {
    id: "payment",
    label: "Payment Confirmation",
    shortLabel: "Payment",
    icon: CreditCard,
    hint: "Upload payment proof (bank receipt, GCash, or BIR payment confirmation).",
  },
];

const STAGE_ORDER = STAGES.map(s => s.id);

function stageIndex(stage: string | null) {
  if (!stage) return -1;
  return STAGE_ORDER.indexOf(stage);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function apiUrl(path: string) {
  return `${BASE}/api${path}`;
}

async function apiCall(method: string, path: string, body?: object) {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

function FileIcon({ mimeType, name }: { mimeType: string; name?: string }) {
  const ext = (name?.split(".").pop() || "").toLowerCase();
  if (mimeType === "application/pdf") return <FileText className="h-4 w-4 text-red-500" />;
  if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel") || ext === "csv")
    return <FileSpreadsheet className="h-4 w-4 text-green-600" />;
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword")
    return <FileType className="h-4 w-4 text-blue-600" />;
  if (mimeType.startsWith("image/")) return <ImageIcon className="h-4 w-4 text-violet-500" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function FilingWorkflowDialog({
  open,
  onClose,
  deadlineId,
  engagementId: initialEngagementId,
  clientId,
  formNumber,
  description,
  period,
  dueDate,
  onUpdate,
}: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [engagementId, setEngagementId] = useState<number | null>(initialEngagementId);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadDesc, setUploadDesc] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manager action state
  const [rejectReason, setRejectReason] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showVoidForm, setShowVoidForm] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  // Submit note
  const [submitNote, setSubmitNote] = useState("");

  // Viewer
  const [viewerDoc, setViewerDoc] = useState<any>(null);

  // Documents for this engagement
  const { data: allDocs } = useListDocuments();
  const engagementDocs = (allDocs ?? []).filter(
    d => d.engagementId === engagementId
  );

  // Sync engagementId from prop
  useEffect(() => {
    setEngagementId(initialEngagementId);
  }, [initialEngagementId]);

  // Load engagement data whenever engagementId changes
  useEffect(() => {
    if (!engagementId) { setEngagement(null); return; }
    setLoading(true);
    apiCall("GET", `/engagements/${engagementId}`)
      .then(data => setEngagement(data))
      .catch(() => toast({ title: "Failed to load workflow", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [engagementId, open]);

  // Load comments
  useEffect(() => {
    if (!engagementId) { setComments([]); return; }
    apiCall("GET", `/comments?engagementId=${engagementId}`)
      .then(data => setComments(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [engagementId, open, engagement?.status]);

  const refreshEngagement = () => {
    if (!engagementId) return;
    return apiCall("GET", `/engagements/${engagementId}`)
      .then(data => setEngagement(data))
      .catch(() => {});
  };

  const invalidateDocs = () => {
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
  };

  // ── Start workflow ─────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!deadlineId) return;
    setStarting(true);
    try {
      const eng = await apiCall("POST", `/deadlines/${deadlineId}/start-workflow`);
      setEngagementId(eng.id);
      toast({ title: "Filing workflow started" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Failed to start workflow", variant: "destructive" });
    } finally {
      setStarting(false);
    }
  };

  // ── Upload document ────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!selectedFile || !engagementId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      fd.append("engagementId", String(engagementId));
      fd.append("clientId", String(clientId));
      fd.append("stage", engagement?.workflowStage ?? "source_collection");
      if (uploadDesc.trim()) fd.append("description", uploadDesc.trim());

      const res = await fetch(apiUrl("/documents/upload"), {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");
      setSelectedFile(null);
      setUploadDesc("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      invalidateDocs();
      toast({ title: "Document uploaded" });
    } catch (e: any) {
      toast({ title: e.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // ── Accountant actions ─────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/submit-stage`, {
        notes: submitNote.trim() || undefined,
      });
      setSubmitNote("");
      await refreshEngagement();
      toast({ title: "Submitted for manager review" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Submit failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSkipSource = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/skip-source`);
      await refreshEngagement();
      toast({ title: "Proceeded to Draft Tax Return (no transactions)" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Action failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // ── Manager actions ────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/approve-stage`, {
        notes: approvalNote.trim() || undefined,
      });
      setApprovalNote("");
      await refreshEngagement();
      invalidateDocs();
      toast({ title: "Stage approved" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Approve failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    if (!engagementId || !rejectReason.trim()) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/reject-stage`, {
        notes: rejectReason.trim(),
      });
      setRejectReason("");
      setShowRejectForm(false);
      await refreshEngagement();
      toast({ title: "Stage returned for revision" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Reject failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleVoid = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/void-stage`, {
        notes: voidReason.trim() || undefined,
      });
      setVoidReason("");
      setShowVoidForm(false);
      await refreshEngagement();
      invalidateDocs();
      toast({ title: "Stage voided — accountant can redo" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Void failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const isManager = user?.role === "manager";
  const isViewer = user?.role === "viewer";
  const currentStageIdx = stageIndex(engagement?.workflowStage ?? null);
  const isCompleted = engagement?.status === "completed";
  const isForReview = engagement?.status === "for_review";
  const isInProgress = engagement?.status === "in_progress";
  const isSourceStage = engagement?.workflowStage === "source_collection";

  const stageDocs = (stage: string) =>
    engagementDocs.filter(d => (d as any).stage === stage);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="text-lg font-semibold flex items-center gap-2">
            <span className="font-mono text-primary">{formNumber}</span>
            <span className="text-muted-foreground text-sm font-normal">— Filing Workflow</span>
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              {description} · <span className="font-medium text-foreground">{period}</span> · Due {dueDate ? format(parseISO(dueDate), "MMM d, yyyy") : "—"}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 space-y-6">

          {/* ── Not started ─────────────────────────────────────────────── */}
          {!engagementId && (
            <div className="flex flex-col items-center py-12 gap-4">
              <div className="rounded-full bg-primary/10 p-4">
                <PlayCircle className="h-10 w-10 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-lg">Start Filing Workflow</p>
                <p className="text-sm text-muted-foreground max-w-sm mt-1">
                  Begin the 4-stage filing process for this BIR return. You'll collect source documents,
                  prepare the draft return, and confirm submission and payment.
                </p>
              </div>
              {!isViewer && (
                <Button onClick={handleStart} disabled={starting || !deadlineId}>
                  {starting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <PlayCircle className="h-4 w-4 mr-2" />}
                  Start Workflow
                </Button>
              )}
              {!deadlineId && (
                <p className="text-xs text-muted-foreground">Generate deadlines first to start this workflow.</p>
              )}
            </div>
          )}

          {/* ── Workflow in progress ─────────────────────────────────────── */}
          {engagementId && (
            <>
              {/* Stepper */}
              <div className="flex items-center gap-1 overflow-x-auto">
                {STAGES.map((stage, idx) => {
                  const done = isCompleted || idx < currentStageIdx;
                  const active = idx === currentStageIdx && !isCompleted;
                  const Icon = stage.icon;
                  return (
                    <div key={stage.id} className="flex items-center gap-1 flex-shrink-0">
                      <div className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                        done && "bg-green-100 text-green-700",
                        active && "bg-primary/10 text-primary ring-1 ring-primary",
                        !done && !active && "bg-muted text-muted-foreground"
                      )}>
                        {done ? (
                          <Check className="h-4 w-4 text-green-600 flex-shrink-0" />
                        ) : (
                          <Icon className="h-4 w-4 flex-shrink-0" />
                        )}
                        <span className="hidden sm:inline">{stage.shortLabel}</span>
                      </div>
                      {idx < STAGES.length - 1 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      )}
                    </div>
                  );
                })}
                {isCompleted && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-green-100 text-green-700">
                      <Check className="h-4 w-4" />
                      <span>Filed</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Status banner */}
              {isCompleted && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-green-800">
                    <Check className="h-5 w-5 flex-shrink-0" />
                    <div className="flex-1">
                      <span className="font-medium">Filing Complete</span>
                      <span className="text-sm ml-1">— All stages approved, deadline marked as filed.</span>
                    </div>
                    {isManager && !showVoidForm && (
                      <Button size="sm" variant="outline" className="border-rose-300 text-rose-700 hover:bg-rose-50 flex-shrink-0" onClick={() => setShowVoidForm(true)}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Void Completion
                      </Button>
                    )}
                  </div>
                  {isManager && showVoidForm && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 space-y-3">
                      <p className="text-sm font-medium text-rose-800">Void Filing Completion</p>
                      <p className="text-xs text-rose-700">This will revert the filing to "Payment" stage so the accountant can redo it. The deadline will be unmarked as filed.</p>
                      <Input
                        placeholder="Reason for voiding (optional)"
                        value={voidReason}
                        onChange={e => setVoidReason(e.target.value)}
                        className="text-sm bg-white"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" variant="destructive" onClick={handleVoid} disabled={loading}>
                          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                          Confirm Void
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setShowVoidForm(false); setVoidReason(""); }}>Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {isForReview && !isCompleted && (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-amber-800">
                  <AlertCircle className="h-5 w-5" />
                  <span className="font-medium">Awaiting Manager Approval</span>
                  {isManager && <span className="text-sm ml-1">— Review and approve or return below.</span>}
                </div>
              )}
              {engagement?.approvalNotes && isInProgress && (
                <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-rose-800">
                  <RotateCcw className="h-5 w-5 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Returned for revision</p>
                    <p className="text-sm mt-0.5">{engagement.approvalNotes}</p>
                  </div>
                </div>
              )}

              {/* ── Stage content ─────────────────────────────────────── */}
              {!isCompleted && (
                <div className="space-y-4">
                  {(() => {
                    const stage = STAGES[currentStageIdx];
                    if (!stage) return null;
                    const Icon = stage.icon;
                    const docs = stageDocs(stage.id);
                    return (
                      <div className="border rounded-lg p-4 space-y-4">
                        <div className="flex items-center gap-2">
                          <Icon className="h-5 w-5 text-primary" />
                          <h3 className="font-semibold">Stage {currentStageIdx + 1}: {stage.label}</h3>
                          <Badge variant="outline" className="text-xs ml-auto">
                            {isForReview ? "Awaiting Approval" : "In Progress"}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{stage.hint}</p>

                        {/* Documents list for this stage */}
                        {docs.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-muted-foreground">Uploaded Documents</p>
                            {docs.map(doc => (
                              <div key={doc.id} className="flex items-center gap-3 p-2 rounded-md bg-muted/50 hover:bg-muted cursor-pointer group"
                                onClick={() => setViewerDoc(doc)}>
                                <FileIcon mimeType={doc.mimeType} name={doc.originalName} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{doc.originalName}</p>
                                  {doc.description && <p className="text-xs text-muted-foreground truncate">{doc.description}</p>}
                                </div>
                                <span className="text-xs text-muted-foreground">{formatBytes(doc.fileSize)}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Upload area — only accountant/manager, and only when in_progress */}
                        {!isViewer && isInProgress && (
                          <div className="space-y-2 pt-2 border-t">
                            <p className="text-sm font-medium">Upload Document</p>
                            <div className="flex gap-2">
                              <Input
                                type="file"
                                ref={fileInputRef}
                                accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat"
                                onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                                className="text-sm"
                              />
                            </div>
                            {selectedFile && (
                              <>
                                <Input
                                  placeholder="Description (optional)"
                                  value={uploadDesc}
                                  onChange={e => setUploadDesc(e.target.value)}
                                  className="text-sm"
                                />
                                <Button size="sm" onClick={handleUpload} disabled={uploading}>
                                  {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                                  Upload
                                </Button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Accountant actions */}
                        {!isViewer && !isManager && isInProgress && (
                          <div className="flex flex-wrap gap-2 pt-2 border-t">
                            <div className="flex-1 min-w-0 space-y-2">
                              <Input
                                placeholder="Notes to manager (optional)"
                                value={submitNote}
                                onChange={e => setSubmitNote(e.target.value)}
                                className="text-sm"
                              />
                              <div className="flex gap-2 flex-wrap">
                                <Button size="sm" onClick={handleSubmit} disabled={loading}>
                                  {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <SendHorizontal className="h-4 w-4 mr-2" />}
                                  Submit for Manager Review
                                </Button>
                                {isSourceStage && (
                                  <Button size="sm" variant="outline" onClick={handleSkipSource} disabled={loading}>
                                    <SkipForward className="h-4 w-4 mr-2" />
                                    No Transactions — Proceed
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Manager can also upload when reviewing */}
                        {isManager && isForReview && (
                          <div className="space-y-2 pt-2 border-t">
                            <p className="text-sm font-medium">Upload Document (Optional)</p>
                            <div className="flex gap-2">
                              <Input
                                type="file"
                                ref={fileInputRef}
                                accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat"
                                onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                                className="text-sm"
                              />
                            </div>
                            {selectedFile && (
                              <>
                                <Input
                                  placeholder="Description (optional)"
                                  value={uploadDesc}
                                  onChange={e => setUploadDesc(e.target.value)}
                                  className="text-sm"
                                />
                                <Button size="sm" onClick={handleUpload} disabled={uploading}>
                                  {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                                  Upload
                                </Button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Manager: undo last approval (when accountant is in progress on a non-first stage) */}
                        {isManager && isInProgress && currentStageIdx > 0 && (
                          <div className="pt-2 border-t">
                            {!showVoidForm ? (
                              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-rose-700 text-xs" onClick={() => setShowVoidForm(true)}>
                                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                Undo Last Approval (revert to previous stage)
                              </Button>
                            ) : (
                              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2">
                                <p className="text-sm font-medium text-rose-800">Undo Last Approval</p>
                                <p className="text-xs text-rose-700">Reverts to "{STAGES[currentStageIdx - 1]?.label}" so the accountant can redo that stage.</p>
                                <Input placeholder="Reason (optional)" value={voidReason} onChange={e => setVoidReason(e.target.value)} className="text-sm bg-white" />
                                <div className="flex gap-2">
                                  <Button size="sm" variant="destructive" onClick={handleVoid} disabled={loading}>
                                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                                    Confirm Undo
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => { setShowVoidForm(false); setVoidReason(""); }}>Cancel</Button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Manager approval actions */}
                        {isManager && isForReview && (
                          <div className="pt-2 border-t space-y-3">
                            <p className="text-sm font-medium">Manager Decision</p>
                            {!showRejectForm ? (
                              <div className="flex flex-wrap gap-2">
                                <div className="space-y-2 flex-1">
                                  <Input
                                    placeholder="Approval note (optional)"
                                    value={approvalNote}
                                    onChange={e => setApprovalNote(e.target.value)}
                                    className="text-sm"
                                  />
                                  <div className="flex gap-2">
                                    <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={handleApprove} disabled={loading}>
                                      {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ThumbsUp className="h-4 w-4 mr-2" />}
                                      {currentStageIdx === STAGES.length - 1 ? "Approve & Complete Filing" : "Approve — Advance to Next Stage"}
                                    </Button>
                                    <Button size="sm" variant="destructive" onClick={() => setShowRejectForm(true)} disabled={loading}>
                                      <ThumbsDown className="h-4 w-4 mr-2" />
                                      Return for Revision
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <Label className="text-sm">Reason for returning (required)</Label>
                                <Textarea
                                  rows={3}
                                  placeholder="Describe what needs to be corrected..."
                                  value={rejectReason}
                                  onChange={e => setRejectReason(e.target.value)}
                                  className="text-sm"
                                />
                                <div className="flex gap-2">
                                  <Button size="sm" variant="destructive" onClick={handleReject} disabled={loading || !rejectReason.trim()}>
                                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ThumbsDown className="h-4 w-4 mr-2" />}
                                    Return for Revision
                                  </Button>
                                  <Button size="sm" variant="outline" onClick={() => { setShowRejectForm(false); setRejectReason(""); }}>
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Previous stages with doc summary */}
              {currentStageIdx > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">Previous Stages</p>
                  {STAGES.slice(0, isCompleted ? STAGES.length : currentStageIdx).map((stage, idx) => {
                    const docs = stageDocs(stage.id);
                    const Icon = stage.icon;
                    return (
                      <div key={stage.id} className="flex items-start gap-3 p-3 rounded-lg bg-green-50 border border-green-100">
                        <div className="rounded-full bg-green-100 p-1 mt-0.5">
                          <Check className="h-3 w-3 text-green-700" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-green-800">{stage.label}</p>
                          {docs.length > 0 ? (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {docs.map(d => (
                                <button
                                  key={d.id}
                                  className="flex items-center gap-1 text-xs bg-white border border-green-200 rounded px-2 py-0.5 hover:bg-green-50 truncate max-w-[200px]"
                                  onClick={() => setViewerDoc(d)}
                                >
                                  <FileIcon mimeType={d.mimeType} name={d.originalName} />
                                  <span className="truncate">{d.originalName}</span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-green-700 mt-0.5">No documents (skipped or N/A)</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Comments */}
              {comments.length > 0 && (
                <div className="space-y-2">
                  <Separator />
                  <p className="text-sm font-medium text-muted-foreground">Activity Log</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {comments.map(c => (
                      <div key={c.id} className={cn(
                        "text-sm p-3 rounded-lg",
                        c.isApproval ? "bg-amber-50 border border-amber-100 text-amber-800" : "bg-muted"
                      )}>
                        <p>{c.content}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {c.createdAt ? format(parseISO(c.createdAt), "MMM d, yyyy h:mm a") : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>

      {/* File Viewer */}
      {viewerDoc && (
        <FileViewer
          doc={viewerDoc}
          onClose={() => setViewerDoc(null)}
        />
      )}
    </Dialog>
  );
}
