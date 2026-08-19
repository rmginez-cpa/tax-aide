import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useListDocuments, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { MergePDFDialog } from "@/components/MergePDFDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { FileViewer } from "@/components/FileViewer";
import {
  Upload, Check, FileText, FileSpreadsheet,
  FileType, Image as ImageIcon, Loader2,
  PlayCircle, ThumbsUp, ThumbsDown,
  Inbox, PenLine, Receipt, CreditCard, RotateCcw, Trash2,
  ChevronDown, FilePlus, History, Lock, Send, Merge
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

type StageKey = "source_collection" | "draft_return" | "confirmation" | "payment";

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
  stageStatuses: Record<StageKey, string>;
  stagesForReview: number;
  taxPayable: number | null;
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

// ── Stage definitions ─────────────────────────────────────────────────────────

const STAGES: Array<{
  id: StageKey;
  label: string;
  shortLabel: string;
  icon: React.ElementType;
  hint: string;
}> = [
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

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
function apiUrl(path: string) { return `${BASE}/api${path}`; }

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

const STAGE_STATUS_STYLES: Record<string, { label: string; className: string }> = {
  not_started: { label: "Not Started", className: "bg-gray-100 text-gray-600 border-gray-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  for_review: { label: "Pending Approval", className: "bg-amber-100 text-amber-700 border-amber-200" },
  approved: { label: "Approved", className: "bg-green-100 text-green-700 border-green-200" },
  not_applicable: { label: "Not Applicable", className: "bg-slate-100 text-slate-500 border-slate-200" },
};

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
  const [amending, setAmending] = useState(false);

  const [allFilings, setAllFilings] = useState<Engagement[]>([]);

  // Per-stage upload state
  const [stageFiles, setStageFiles] = useState<Partial<Record<StageKey, File>>>({});
  const [stageDescs, setStageDescs] = useState<Partial<Record<StageKey, string>>>({});
  const [uploadingStage, setUploadingStage] = useState<StageKey | null>(null);
  const fileInputRefs = useRef<Partial<Record<StageKey, HTMLInputElement>>>({});
  // Tax payable input (Stage 2)
  const [taxPayableInput, setTaxPayableInput] = useState<string>("");
  const [savingTaxPayable, setSavingTaxPayable] = useState(false);

  // Per-stage manager action state
  const [stageApprovalNotes, setStageApprovalNotes] = useState<Partial<Record<StageKey, string>>>({});
  const [stageRejectReasons, setStageRejectReasons] = useState<Partial<Record<StageKey, string>>>({});
  const [showRejectForm, setShowRejectForm] = useState<Partial<Record<StageKey, boolean>>>({});
  const [showVoidForm, setShowVoidForm] = useState<Partial<Record<StageKey, boolean>>>({});
  const [voidReasons, setVoidReasons] = useState<Partial<Record<StageKey, string>>>({});
  const [actionLoadingStage, setActionLoadingStage] = useState<StageKey | null>(null);

  const [deletingDocId, setDeletingDocId] = useState<number | null>(null);
  const [viewerDoc, setViewerDoc] = useState<any>(null);
  const [mergePDFStage, setMergePDFStage] = useState<StageKey | null>(null);

  const { data: allDocs } = useListDocuments();
  const engagementDocs = (allDocs ?? []).filter(d => d.engagementId === engagementId);

  // Sync engagementId from prop
  useEffect(() => {
    setEngagementId(initialEngagementId);
  }, [initialEngagementId]);

  // Load engagement data
  useEffect(() => {
    if (!engagementId) { setEngagement(null); return; }
    setLoading(true);
    apiCall("GET", `/engagements/${engagementId}`)
      .then(data => setEngagement(data))
      .catch(() => toast({ title: "Failed to load workflow", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [engagementId, open]);

  // Load amendments list
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
  }, [engagementId, open, engagement?.stageStatuses]);

  const refreshEngagement = async () => {
    if (!engagementId) return;
    const data = await apiCall("GET", `/engagements/${engagementId}`);
    setEngagement(data);
    return data;
  };

  const refreshAll = async () => {
    const data = await refreshEngagement();
    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    // Also refresh comments
    if (engagementId) {
      apiCall("GET", `/comments?engagementId=${engagementId}`)
        .then(c => setComments(Array.isArray(c) ? c : []))
        .catch(() => {});
    }
    onUpdate();
    return data;
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

  // ── Upload document to a specific stage ────────────────────────────────────
  const handleUpload = async (stageId: StageKey) => {
    const file = stageFiles[stageId];
    if (!file || !engagementId) return;
    setUploadingStage(stageId);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("engagementId", String(engagementId));
      fd.append("clientId", String(clientId));
      fd.append("stage", stageId);
      const desc = stageDescs[stageId];
      if (desc?.trim()) fd.append("description", desc.trim());

      const res = await fetch(apiUrl("/documents/upload"), {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) throw new Error("Upload failed");

      setStageFiles(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      setStageDescs(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      const ref = fileInputRefs.current[stageId];
      if (ref) ref.value = "";

      // Auto-advance stage to in_progress if it was not_started
      if (engagement?.stageStatuses[stageId] === "not_started") {
        await refreshEngagement();
      }

      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      toast({ title: "Document uploaded" });
    } catch (e: any) {
      toast({ title: e.message || "Upload failed", variant: "destructive" });
    } finally {
      setUploadingStage(null);
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

  // ── Recall a stage submission (maker retracts from for_review) ────────────
  const handleRecallStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      await apiCall("POST", `/engagements/${engagementId}/recall-stage`, { stage: stageId });
      await refreshAll();
      toast({ title: `${STAGES.find(s => s.id === stageId)?.label} submission recalled — you can now make changes` });
    } catch (e: any) {
      toast({ title: e.message || "Recall failed", variant: "destructive" });
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── Save tax payable amount (Stage 2) ─────────────────────────────────────
  const handleSaveTaxPayable = async () => {
    if (!engagementId) return;
    const val = taxPayableInput.trim();
    const parsed = val === "" ? null : parseFloat(val);
    if (val !== "" && (isNaN(parsed!) || parsed! < 0)) {
      toast({ title: "Enter a valid non-negative amount", variant: "destructive" });
      return;
    }
    setSavingTaxPayable(true);
    try {
      await apiCall("PATCH", `/engagements/${engagementId}`, { taxPayable: parsed });
      await refreshAll();
      toast({ title: parsed === 0 ? "No tax payable — Stage 4 marked Not Applicable" : "Tax payable saved" });
    } catch (e: any) {
      toast({ title: e.message || "Failed to save", variant: "destructive" });
    } finally {
      setSavingTaxPayable(false);
    }
  };

  // ── Submit a stage for manager review ─────────────────────────────────────
  const handleSubmitStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      await apiCall("POST", `/engagements/${engagementId}/submit-stage`, { stage: stageId });
      await refreshAll();
      toast({ title: `${STAGES.find(s => s.id === stageId)?.label} submitted for approval` });
    } catch (e: any) {
      toast({ title: e.message || "Submit failed", variant: "destructive" });
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── Manager: approve a stage ───────────────────────────────────────────────
  const handleApproveStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      const notes = stageApprovalNotes[stageId]?.trim() || undefined;
      const updated = await apiCall("POST", `/engagements/${engagementId}/approve-stage`, { stage: stageId, notes });
      setStageApprovalNotes(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      await refreshAll();
      toast({ title: updated.status === "completed" ? "All stages approved — filing complete!" : `${STAGES.find(s => s.id === stageId)?.label} approved` });
    } catch (e: any) {
      toast({ title: e.message || "Approve failed", variant: "destructive" });
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── Manager: return a stage ────────────────────────────────────────────────
  const handleRejectStage = async (stageId: StageKey) => {
    const reason = stageRejectReasons[stageId]?.trim();
    if (!engagementId || !reason) return;
    setActionLoadingStage(stageId);
    try {
      await apiCall("POST", `/engagements/${engagementId}/reject-stage`, { stage: stageId, notes: reason });
      setStageRejectReasons(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      setShowRejectForm(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      await refreshAll();
      toast({ title: `${STAGES.find(s => s.id === stageId)?.label} returned for revision` });
    } catch (e: any) {
      toast({ title: e.message || "Return failed", variant: "destructive" });
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── Manager: void a stage approval ────────────────────────────────────────
  const handleVoidStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      const notes = voidReasons[stageId]?.trim() || undefined;
      await apiCall("POST", `/engagements/${engagementId}/void-stage`, { stage: stageId, notes });
      setVoidReasons(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      setShowVoidForm(prev => { const n = { ...prev }; delete n[stageId]; return n; });
      await refreshAll();
      toast({ title: `${STAGES.find(s => s.id === stageId)?.label} approval voided` });
    } catch (e: any) {
      toast({ title: e.message || "Void failed", variant: "destructive" });
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── File amendment ─────────────────────────────────────────────────────────
  const handleAmend = async () => {
    if (!engagementId) return;
    setAmending(true);
    try {
      const amendment = await apiCall("POST", `/engagements/${engagementId}/amend`);
      toast({ title: "Amendment filing started" });
      setEngagementId(amendment.id);
      onUpdate();
    } catch (e: any) {
      toast({ title: e.message || "Could not create amendment", variant: "destructive" });
    } finally {
      setAmending(false);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const isManager = user?.role === "manager";
  const isViewer = user?.role === "viewer";
  const isCompleted = engagement?.status === "completed";
  const isStarted = !!engagementId && !!engagement;

  const stageStatuses = engagement?.stageStatuses ?? {
    source_collection: "not_started",
    draft_return: "not_started",
    confirmation: "not_started",
    payment: "not_started",
  };

  const taxPayable = engagement?.taxPayable ?? null;
  const isPaymentNA = taxPayable !== null && taxPayable === 0;

  // Sync tax payable input when engagement loads/changes
  const taxPayableRef = useRef<number | null>(null);
  if (taxPayableRef.current !== taxPayable) {
    taxPayableRef.current = taxPayable;
    setTaxPayableInput(taxPayable !== null ? String(taxPayable) : "");
  }
  // For the progress bar: not_applicable counts as "done" (same as approved)
  const totalStages = isPaymentNA ? 3 : 4;
  const approvedCount = Object.values(stageStatuses).filter(s => s === "approved").length;

  const stageDocs = (stageId: StageKey) =>
    engagementDocs.filter(d => (d as any).stage === stageId);

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
              <DialogTitle className="text-lg font-semibold flex items-center gap-2 flex-wrap">
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

        <div className="p-6 space-y-5">

          {/* ── Not started ─────────────────────────────────────────────── */}
          {!engagementId && (
            <div className="flex flex-col items-center py-12 gap-4">
              <div className="rounded-full bg-primary/10 p-4">
                <PlayCircle className="h-10 w-10 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-lg">Start Filing Workflow</p>
                <p className="text-sm text-muted-foreground max-w-sm mt-1">
                  Begin the 4-stage filing process. Work on all stages simultaneously and submit each for manager approval independently.
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
          {isStarted && loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {isStarted && !loading && (
            <>
              {/* Progress header */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-muted-foreground">
                    {isCompleted ? "Filing Complete" : `${approvedCount} / ${totalStages} stages approved`}
                  </span>
                  {isCompleted && <Badge className="bg-green-600 text-white border-green-600">Completed</Badge>}
                  {!isCompleted && approvedCount > 0 && (
                    <span className="text-xs text-muted-foreground">{totalStages - approvedCount} remaining</span>
                  )}
                </div>
                <Progress value={(approvedCount / totalStages) * 100} className="h-2" />
              </div>

              {/* Completed banner */}
              {isCompleted && (
                <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-green-800">
                  <Check className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1">
                    <span className="font-medium">{isPaymentNA ? "All required stages approved — Filing Complete!" : "All 4 stages approved — Filing Complete!"}</span>
                    <span className="text-sm ml-1">The deadline has been marked as filed.</span>
                  </div>
                  {!isViewer && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-300 text-amber-700 hover:bg-amber-50 shrink-0"
                      onClick={handleAmend}
                      disabled={amending}
                    >
                      {amending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <FilePlus className="h-3.5 w-3.5 mr-1.5" />}
                      File Amendment
                    </Button>
                  )}
                </div>
              )}

              {/* ── 4 Stage Cards ──────────────────────────────────────── */}
              <div className="space-y-3">
                {STAGES.map((stage, idx) => {
                  const stageStatus = stageStatuses[stage.id] ?? "not_started";
                  const statusStyle = STAGE_STATUS_STYLES[stageStatus] ?? STAGE_STATUS_STYLES.not_started;
                  const Icon = stage.icon;
                  const docs = stageDocs(stage.id);

                  const isStageNotApplicable = stageStatus === "not_applicable";
                  const isStageApproved = stageStatus === "approved";
                  const isStageForReview = stageStatus === "for_review";
                  const isStageEditable = stageStatus === "not_started" || stageStatus === "in_progress";
                  const isStageLoading = actionLoadingStage === stage.id;
                  const isStageUploading = uploadingStage === stage.id;

                  const selectedFile = stageFiles[stage.id];
                  const descValue = stageDescs[stage.id] ?? "";

                  // Stage 4: if not applicable, show a locked card
                  if (isStageNotApplicable) {
                    return (
                      <div key={stage.id} className="border rounded-lg p-4 border-slate-200 bg-slate-50/50 opacity-75">
                        <div className="flex items-center gap-2">
                          <div className="rounded-full p-1.5 bg-slate-100">
                            <Icon className="h-3.5 w-3.5 text-slate-400" />
                          </div>
                          <span className="font-medium text-sm text-slate-500">Stage {idx + 1}: {stage.label}</span>
                          <Badge variant="outline" className={cn("ml-auto text-xs", statusStyle.className)}>
                            {statusStyle.label}
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-400 mt-2">No tax payable — payment stage is not required for this filing.</p>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={stage.id}
                      className={cn(
                        "border rounded-lg p-4 space-y-3 transition-colors",
                        isStageApproved && "border-green-200 bg-green-50/30",
                        isStageForReview && "border-amber-200 bg-amber-50/30",
                        isStageEditable && "border-border"
                      )}
                    >
                      {/* Stage header */}
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "rounded-full p-1.5",
                          isStageApproved ? "bg-green-100" : isStageForReview ? "bg-amber-100" : "bg-muted"
                        )}>
                          {isStageApproved
                            ? <Check className="h-3.5 w-3.5 text-green-700" />
                            : <Icon className={cn("h-3.5 w-3.5", isStageForReview ? "text-amber-700" : "text-muted-foreground")} />
                          }
                        </div>
                        <span className="font-medium text-sm">Stage {idx + 1}: {stage.label}</span>
                        <Badge
                          variant="outline"
                          className={cn("ml-auto text-xs", statusStyle.className)}
                        >
                          {statusStyle.label}
                        </Badge>
                        {isStageForReview && isManager && (
                          <span className="text-xs text-amber-600 font-medium">Action required</span>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground">{stage.hint}</p>

                      {/* Stage 2: Tax Payable input */}
                      {stage.id === "draft_return" && !isViewer && (
                        <div className="pt-1 border-t space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Tax Payable Amount (₱)</Label>
                          <div className="flex gap-2 items-center">
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="e.g. 12500.00 — enter 0 if no tax due"
                              value={taxPayableInput}
                              onChange={e => setTaxPayableInput(e.target.value)}
                              className="text-sm flex-1"
                              disabled={isCompleted}
                            />
                            {!isCompleted && (
                              <Button size="sm" variant="outline" onClick={handleSaveTaxPayable} disabled={savingTaxPayable}>
                                {savingTaxPayable ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                              </Button>
                            )}
                          </div>
                          {taxPayable !== null && (
                            <p className="text-xs text-muted-foreground">
                              {taxPayable === 0
                                ? "✓ No tax payable — Stage 4 (Payment) is Not Applicable."
                                : `✓ Tax payable: ₱${taxPayable.toLocaleString("en-PH", { minimumFractionDigits: 2 })} — Stage 4 required.`}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Documents */}
                      {docs.length > 0 && (
                        <div className="space-y-1">
                          {docs.map(doc => (
                            <div
                              key={doc.id}
                              className="flex items-center gap-2 p-2 rounded-md bg-muted/50 hover:bg-muted group"
                            >
                              <button
                                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                                onClick={() => setViewerDoc(doc)}
                              >
                                <FileIcon mimeType={doc.mimeType} name={doc.originalName} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{doc.originalName}</p>
                                  {doc.description && <p className="text-xs text-muted-foreground truncate">{doc.description}</p>}
                                </div>
                                <span className="text-xs text-muted-foreground shrink-0">{formatBytes(doc.fileSize)}</span>
                              </button>

                              {/* Delete — only when stage is editable */}
                              {!isViewer && isStageEditable && (
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
                              {!isViewer && !isStageEditable && (
                                <Lock className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 opacity-0 group-hover:opacity-100" />
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Upload — when stage is editable (not_started or in_progress) */}
                      {!isViewer && isStageEditable && (
                        <div className="space-y-2 pt-1 border-t">
                          {/* Option 1: single file */}
                          <div className="flex gap-2">
                            <Input
                              type="file"
                              ref={el => { if (el) fileInputRefs.current[stage.id] = el; }}
                              accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat"
                              onChange={e => {
                                const file = e.target.files?.[0] ?? undefined;
                                setStageFiles(prev => file ? { ...prev, [stage.id]: file } : prev);
                              }}
                              className="text-sm flex-1"
                            />
                          </div>
                          {selectedFile && (
                            <div className="flex gap-2 items-start">
                              <Input
                                placeholder="Description (optional)"
                                value={descValue}
                                onChange={e => setStageDescs(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm flex-1"
                              />
                              <Button size="sm" onClick={() => handleUpload(stage.id)} disabled={isStageUploading}>
                                {isStageUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                                Upload
                              </Button>
                            </div>
                          )}
                          {/* Divider */}
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-xs text-muted-foreground">or</span>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                          {/* Option 2: merge PDFs */}
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full gap-2 border-dashed"
                            onClick={() => setMergePDFStage(stage.id)}
                          >
                            <Merge className="h-4 w-4" />
                            Upload Merged PDF
                            <span className="text-xs text-muted-foreground font-normal">(combine multiple PDFs into one)</span>
                          </Button>
                        </div>
                      )}

                      {/* Manager can also upload when stage is for_review */}
                      {isManager && isStageForReview && (
                        <div className="space-y-2 pt-1 border-t">
                          <p className="text-xs text-muted-foreground">Upload additional documents (optional)</p>
                          <div className="flex gap-2">
                            <Input
                              type="file"
                              ref={el => { if (el) fileInputRefs.current[stage.id] = el; }}
                              accept=".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat"
                              onChange={e => {
                                const file = e.target.files?.[0] ?? undefined;
                                setStageFiles(prev => file ? { ...prev, [stage.id]: file } : prev);
                              }}
                              className="text-sm flex-1"
                            />
                          </div>
                          {selectedFile && (
                            <div className="flex gap-2 items-start">
                              <Input
                                placeholder="Description (optional)"
                                value={descValue}
                                onChange={e => setStageDescs(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm flex-1"
                              />
                              <Button size="sm" onClick={() => handleUpload(stage.id)} disabled={isStageUploading}>
                                {isStageUploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                                Upload
                              </Button>
                            </div>
                          )}
                          {/* Divider + Merge option */}
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-xs text-muted-foreground">or</span>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full gap-2 border-dashed"
                            onClick={() => setMergePDFStage(stage.id)}
                          >
                            <Merge className="h-4 w-4" />
                            Upload Merged PDF
                            <span className="text-xs text-muted-foreground font-normal">(combine multiple PDFs into one)</span>
                          </Button>
                        </div>
                      )}

                      {/* Maker: Submit button */}
                      {!isViewer && !isManager && isStageEditable && !isCompleted && (
                        <div className="pt-1 border-t">
                          <Button
                            size="sm"
                            onClick={() => handleSubmitStage(stage.id)}
                            disabled={isStageLoading}
                            className="bg-amber-600 hover:bg-amber-700 text-white"
                          >
                            {isStageLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
                            Submit for Manager Approval
                          </Button>
                        </div>
                      )}

                      {/* Maker: Recall button — when stage is pending approval */}
                      {!isViewer && !isManager && isStageForReview && !isCompleted && (
                        <div className="pt-2 border-t flex items-center justify-between gap-3">
                          <div className="flex items-center gap-1.5 text-amber-700">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ animationPlayState: "paused" }} />
                            <span className="text-xs font-medium">Awaiting manager approval</span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRecallStage(stage.id)}
                            disabled={isStageLoading}
                            className="gap-1.5 text-muted-foreground hover:text-foreground shrink-0"
                          >
                            {isStageLoading
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RotateCcw className="h-3.5 w-3.5" />
                            }
                            Recall Submission
                          </Button>
                        </div>
                      )}

                      {/* Manager: Approve / Return (when for_review) */}
                      {isManager && isStageForReview && (
                        <div className="pt-2 border-t space-y-2">
                          {!showRejectForm[stage.id] ? (
                            <div className="space-y-2">
                              <Input
                                placeholder="Approval note (optional)"
                                value={stageApprovalNotes[stage.id] ?? ""}
                                onChange={e => setStageApprovalNotes(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm"
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="bg-green-600 hover:bg-green-700 text-white"
                                  onClick={() => handleApproveStage(stage.id)}
                                  disabled={isStageLoading}
                                >
                                  {isStageLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ThumbsUp className="h-4 w-4 mr-2" />}
                                  Approve Stage
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => setShowRejectForm(prev => ({ ...prev, [stage.id]: true }))}
                                  disabled={isStageLoading}
                                >
                                  <ThumbsDown className="h-4 w-4 mr-2" />
                                  Return for Revision
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <Label className="text-sm">Reason for returning (required)</Label>
                              <Textarea
                                rows={2}
                                placeholder="Describe what needs to be corrected..."
                                value={stageRejectReasons[stage.id] ?? ""}
                                onChange={e => setStageRejectReasons(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm"
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => handleRejectStage(stage.id)}
                                  disabled={isStageLoading || !stageRejectReasons[stage.id]?.trim()}
                                >
                                  {isStageLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ThumbsDown className="h-4 w-4 mr-2" />}
                                  Confirm Return
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setShowRejectForm(prev => { const n = { ...prev }; delete n[stage.id]; return n; });
                                    setStageRejectReasons(prev => { const n = { ...prev }; delete n[stage.id]; return n; });
                                  }}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Manager: Undo Approval (when approved) */}
                      {isManager && isStageApproved && (
                        <div className="pt-2 border-t">
                          {!showVoidForm[stage.id] ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-rose-600 hover:bg-rose-50 text-xs h-7"
                              onClick={() => setShowVoidForm(prev => ({ ...prev, [stage.id]: true }))}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                              Undo Approval
                            </Button>
                          ) : (
                            <div className="space-y-2 rounded-md bg-rose-50 border border-rose-200 p-3">
                              <p className="text-xs font-medium text-rose-800">Undo approval for {stage.label}?</p>
                              {isCompleted && (
                                <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-300 px-3 py-2">
                                  <span className="text-amber-600 mt-0.5 shrink-0">⚠</span>
                                  <p className="text-xs text-amber-800 font-medium">
                                    This filing is already marked <strong>Complete</strong> and the deadline shows as <strong>Filed</strong>.
                                    Undoing this approval will revert the filing to <em>In Progress</em> and reset the deadline back to <em>Pending</em>.
                                  </p>
                                </div>
                              )}
                              <Input
                                placeholder="Reason (optional)"
                                value={voidReasons[stage.id] ?? ""}
                                onChange={e => setVoidReasons(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm bg-white"
                              />
                              <div className="flex gap-2">
                                <Button size="sm" variant="destructive" onClick={() => handleVoidStage(stage.id)} disabled={isStageLoading}>
                                  {isStageLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                                  Confirm Undo
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => {
                                  setShowVoidForm(prev => { const n = { ...prev }; delete n[stage.id]; return n; });
                                  setVoidReasons(prev => { const n = { ...prev }; delete n[stage.id]; return n; });
                                }}>Cancel</Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Comments / Activity Log */}
              {comments.length > 0 && (
                <div className="space-y-2">
                  <Separator />
                  <p className="text-sm font-medium text-muted-foreground">Activity Log</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {comments.map(c => (
                      <div key={c.id} className={cn(
                        "text-sm p-3 rounded-lg",
                        c.isApproval ? "bg-green-50 border border-green-100 text-green-800" : "bg-muted"
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

      {/* Merge PDF Dialog — per stage */}
      <MergePDFDialog
        open={mergePDFStage !== null}
        onClose={() => setMergePDFStage(null)}
        engagementId={engagementId}
        clientId={clientId}
        stageId={mergePDFStage}
        onUploaded={() => {
          setMergePDFStage(null);
          queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
          toast({ title: "Merged PDF uploaded" });
          refreshEngagement();
        }}
      />
    </Dialog>
  );
}
