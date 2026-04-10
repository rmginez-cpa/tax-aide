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
  Inbox, PenLine, Receipt, CreditCard, RotateCcw, Trash2,
  ChevronDown, FilePlus, History
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

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
  isAmendment?: boolean;
  amendedEngagementId?: number | null;
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
    hint: "Prepare and upload the draft BIR tax return.",
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

  // All filings for this form (original + amendments)
  const [allFilings, setAllFilings] = useState<Engagement[]>([]);

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

  // Submit / advance note
  const [submitNote, setSubmitNote] = useState("");

  // Document deletion
  const [deletingDocId, setDeletingDocId] = useState<number | null>(null);

  // Amendment creation
  const [amending, setAmending] = useState(false);

  // Viewer
  const [viewerDoc, setViewerDoc] = useState<any>(null);

  // Documents for this engagement
  const { data: allDocs } = useListDocuments();
  const engagementDocs = (allDocs ?? []).filter(d => d.engagementId === engagementId);

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

  // Load all filings (original + amendments) when we have an engagementId
  useEffect(() => {
    if (!engagementId) { setAllFilings([]); return; }
    apiCall("GET", `/engagements/${engagementId}/amendments`)
      .then(data => setAllFilings(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [engagementId, open, engagement?.status]);

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

  const refreshAll = async () => {
    await refreshEngagement();
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    onUpdate();
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
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      toast({ title: "Document uploaded" });
    } catch (e: any) {
      toast({ title: e.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // ── Delete document ────────────────────────────────────────────────────────
  const handleDeleteDoc = async (docId: number) => {
    setDeletingDocId(docId);
    try {
      const res = await fetch(apiUrl(`/documents/${docId}`), {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Delete failed" }));
        throw new Error(err.error || "Delete failed");
      }
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      toast({ title: "Document removed" });
    } catch (e: any) {
      toast({ title: e.message || "Could not delete document", variant: "destructive" });
    } finally {
      setDeletingDocId(null);
    }
  };

  // ── Advance / submit stage ─────────────────────────────────────────────────
  const handleAdvance = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/advance-stage`, {
        notes: submitNote.trim() || undefined,
      });
      setSubmitNote("");
      await refreshEngagement();
      const next = nextStageLabel();
      toast({ title: next ? `Advanced to ${next}` : "Submitted for manager approval" });
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Action failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const nextStageLabel = () => {
    const idx = stageIndex(engagement?.workflowStage ?? null);
    if (idx === -1) return null;
    return idx < STAGES.length - 1 ? STAGES[idx + 1].label : null;
  };

  const isLastStage = stageIndex(engagement?.workflowStage ?? null) === STAGES.length - 1;

  const handleSkipSource = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/skip-source`);
      await refreshAll();
      toast({ title: "Proceeded to Draft Tax Return (no transactions)" });
    } catch (e: any) {
      toast({ title: e.message || "Action failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSkipPayment = async () => {
    if (!engagementId) return;
    setLoading(true);
    try {
      await apiCall("POST", `/engagements/${engagementId}/skip-payment`);
      await refreshAll();
      toast({ title: "Submitted for manager approval (no payment required)" });
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
      await refreshAll();
      toast({ title: "Filing approved and marked complete" });
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
      toast({ title: "Filing returned for revision" });
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
      await refreshAll();
      toast({ title: "Voided — returned to accountant" });
    } catch (e: any) {
      toast({ title: e.message || "Void failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  // ── File amendment ─────────────────────────────────────────────────────────
  const handleAmend = async () => {
    if (!engagementId) return;
    setAmending(true);
    try {
      const amendment = await apiCall("POST", `/engagements/${engagementId}/amend`);
      toast({ title: `Amendment filing started` });
      setEngagementId(amendment.id);
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Could not create amendment", variant: "destructive" });
    } finally {
      setAmending(false);
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
  const isPaymentStage = engagement?.workflowStage === "payment";
  const isLocked = isForReview || isCompleted;

  const stageDocs = (stage: string) =>
    engagementDocs.filter(d => (d as any).stage === stage);

  // ── Filing history dropdown label ─────────────────────────────────────────
  const activeFilingLabel = engagement?.isAmendment
    ? `${engagement.title.includes("Amendment") ? engagement.title.split("—")[1]?.trim() ?? "Amendment" : "Amendment"}`
    : "Original Filing";

  const hasMultipleFilings = allFilings.length > 1;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-lg font-semibold flex items-center gap-2">
                <span className="font-mono text-primary">{formNumber}</span>
                <span className="text-muted-foreground text-sm font-normal">— Filing Workflow</span>
                {engagement?.isAmendment && (
                  <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">Amendment</Badge>
                )}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm text-muted-foreground mt-1">
                  {description} · <span className="font-medium text-foreground">{period}</span> · Due {dueDate ? format(parseISO(dueDate), "MMM d, yyyy") : "—"}
                </div>
              </DialogDescription>
            </div>

            {/* Filing history dropdown */}
            {hasMultipleFilings && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
                    <History className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{activeFilingLabel}</span>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel>Filing History</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {allFilings.map((f, idx) => (
                    <DropdownMenuItem
                      key={f.id}
                      className={cn("gap-2", f.id === engagementId && "font-medium bg-muted")}
                      onClick={() => setEngagementId(f.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{f.isAmendment ? `Amendment #${idx}` : "Original Filing"}</p>
                        <p className="text-xs text-muted-foreground capitalize">{f.status.replace("_", " ")}</p>
                      </div>
                      {f.id === engagementId && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
                  Begin the 4-stage filing process for this BIR return. Work through each stage freely and submit for manager approval when ready.
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

              {/* Status banners */}
              {isCompleted && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-green-800">
                    <Check className="h-5 w-5 flex-shrink-0" />
                    <div className="flex-1">
                      <span className="font-medium">Filing Complete</span>
                      <span className="text-sm ml-1">— All stages done, approved by manager.</span>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      {!isViewer && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-amber-300 text-amber-700 hover:bg-amber-50"
                          onClick={handleAmend}
                          disabled={amending}
                        >
                          {amending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <FilePlus className="h-3.5 w-3.5 mr-1.5" />}
                          File Amendment
                        </Button>
                      )}
                      {isManager && !showVoidForm && (
                        <Button size="sm" variant="outline" className="border-rose-300 text-rose-700 hover:bg-rose-50" onClick={() => setShowVoidForm(true)}>
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          Void Completion
                        </Button>
                      )}
                    </div>
                  </div>
                  {isManager && showVoidForm && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 space-y-3">
                      <p className="text-sm font-medium text-rose-800">Void Filing Completion</p>
                      <p className="text-xs text-rose-700">This will revert the filing back to the payment stage so the accountant can redo it. The deadline will be unmarked as filed.</p>
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
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1">
                    <span className="font-medium">Awaiting Manager Approval</span>
                    <span className="text-sm ml-1">— All stages submitted. Pending final review.</span>
                  </div>
                  {isManager && !showVoidForm && (
                    <Button size="sm" variant="ghost" className="text-rose-600 hover:bg-rose-50 text-xs shrink-0" onClick={() => setShowVoidForm(true)}>
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      Return
                    </Button>
                  )}
                </div>
              )}
              {isManager && showVoidForm && isForReview && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 space-y-3">
                  <p className="text-sm font-medium text-rose-800">Return for Revision</p>
                  <p className="text-xs text-rose-700">The accountant will be able to update documents and resubmit.</p>
                  <Input
                    placeholder="Reason (optional)"
                    value={voidReason}
                    onChange={e => setVoidReason(e.target.value)}
                    className="text-sm bg-white"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={handleVoid} disabled={loading}>
                      {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                      Confirm Return
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setShowVoidForm(false); setVoidReason(""); }}>Cancel</Button>
                  </div>
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
                              <div
                                key={doc.id}
                                className="flex items-center gap-3 p-2 rounded-md bg-muted/50 hover:bg-muted group"
                              >
                                <button
                                  className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                                  onClick={() => setViewerDoc(doc)}
                                >
                                  <FileIcon mimeType={doc.mimeType} name={doc.originalName} />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{doc.originalName}</p>
                                    {doc.description && <p className="text-xs text-muted-foreground truncate">{doc.description}</p>}
                                  </div>
                                  <span className="text-xs text-muted-foreground shrink-0">{formatBytes(doc.fileSize)}</span>
                                </button>
                                {/* Delete button — only when not locked, and not viewer */}
                                {!isViewer && !isLocked && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                                    disabled={deletingDocId === doc.id}
                                    onClick={() => handleDeleteDoc(doc.id)}
                                    title="Remove attachment"
                                  >
                                    {deletingDocId === doc.id
                                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      : <Trash2 className="h-3.5 w-3.5" />
                                    }
                                  </Button>
                                )}
                                {isLocked && !isViewer && (
                                  <span className="text-xs text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100">
                                    {isCompleted ? "Locked" : "Pending review"}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Upload area — only when in_progress (not for_review) */}
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

                        {/* Accountant: advance / submit */}
                        {!isViewer && !isManager && isInProgress && (
                          <div className="flex flex-wrap gap-2 pt-2 border-t">
                            <div className="flex-1 min-w-0 space-y-2">
                              <Input
                                placeholder={isLastStage ? "Notes to manager (optional)" : "Notes (optional)"}
                                value={submitNote}
                                onChange={e => setSubmitNote(e.target.value)}
                                className="text-sm"
                              />
                              <div className="flex gap-2 flex-wrap">
                                {isLastStage ? (
                                  <Button size="sm" onClick={handleAdvance} disabled={loading} className="bg-amber-600 hover:bg-amber-700 text-white">
                                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <SendHorizontal className="h-4 w-4 mr-2" />}
                                    Submit for Manager Approval
                                  </Button>
                                ) : (
                                  <Button size="sm" onClick={handleAdvance} disabled={loading}>
                                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ChevronRight className="h-4 w-4 mr-2" />}
                                    Advance to {STAGES[currentStageIdx + 1]?.label ?? "Next Stage"}
                                  </Button>
                                )}
                                {isSourceStage && (
                                  <Button size="sm" variant="outline" onClick={handleSkipSource} disabled={loading}>
                                    <SkipForward className="h-4 w-4 mr-2" />
                                    No Transactions — Proceed
                                  </Button>
                                )}
                                {isPaymentStage && (
                                  <Button size="sm" variant="outline" onClick={handleSkipPayment} disabled={loading}>
                                    <SkipForward className="h-4 w-4 mr-2" />
                                    No Payment Required — File Directly
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Manager approval actions (final review) */}
                        {isManager && isForReview && (
                          <div className="pt-2 border-t space-y-3">
                            <p className="text-sm font-medium">Manager Decision — Final Approval</p>
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
                                      Approve & Complete Filing
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
              {(currentStageIdx > 0 || isCompleted) && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">
                    {isCompleted ? "All Stages" : "Previous Stages"}
                  </p>
                  {STAGES.slice(0, isCompleted ? STAGES.length : currentStageIdx).map((stage) => {
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
