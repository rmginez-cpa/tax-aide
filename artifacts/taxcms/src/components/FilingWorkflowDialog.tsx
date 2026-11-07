import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListDocuments, getListDocumentsQueryKey,
  useGetEngagement, getGetEngagementQueryKey,
  useListComments, getListCommentsQueryKey,
  type Engagement,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { apiFetch, errorMessage } from "@/lib/api";
import { formatBytes, formatDate, formatDateTime, formatPeso } from "@/lib/format";
import { FILING_STAGES, getEngagementStatus, getStageStatus, type FilingStageKey } from "@/lib/status";
import { invalidateFilingData } from "@/lib/queries";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
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

type StageKey = FilingStageKey;

interface Props {
  open: boolean;
  onClose: () => void;
  deadlineId: number | null;
  engagementId: number | null;
  clientId: number;
  formNumber: string;
  /** Subtitle: the client name (every caller passes it). */
  description: string;
  period: string;
  dueDate: string;
  /** Called after every successful change (filing data is already invalidated app-wide). */
  onUpdate?: () => void;
}

// ── Stage definitions ─────────────────────────────────────────────────────────
// Names come from lib/status FILING_STAGES; the icon and hint are workflow-specific.

const STAGE_DETAILS: Record<StageKey, { icon: React.ElementType; hint: string }> = {
  source_collection: {
    icon: Inbox,
    hint: "Collect all taxpayer source documents (BIR alphalists, receipts, ledgers, etc.)",
  },
  draft_return: {
    icon: PenLine,
    hint: "Prepare and upload the draft BIR tax return.",
  },
  confirmation: {
    icon: Receipt,
    hint: "Upload the eFiling or BIR confirmation receipt after successful submission.",
  },
  payment: {
    icon: CreditCard,
    hint: "Upload payment proof (bank receipt, GCash, or BIR payment confirmation).",
  },
};

const STAGES = (Object.keys(FILING_STAGES) as StageKey[]).map(id => ({
  id,
  label: FILING_STAGES[id].label,
  shortLabel: FILING_STAGES[id].shortLabel,
  ...STAGE_DETAILS[id],
}));

const stageLabel = (id: StageKey) => FILING_STAGES[id].label;

const UPLOAD_ACCEPT = ".pdf,.xlsx,.xls,.docx,.doc,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.dat";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/** Copy of `obj` without `key` (per-stage form state). */
function without<T extends object>(obj: T, key: keyof T): T {
  const next = { ...obj };
  delete next[key];
  return next;
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
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [engagementId, setEngagementId] = useState<number | null>(initialEngagementId);
  const [starting, setStarting] = useState(false);
  const [amending, setAmending] = useState(false);

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

  // Sync engagementId from prop
  useEffect(() => {
    setEngagementId(initialEngagementId);
  }, [initialEngagementId]);

  // ── Data (react-query, so invalidateFilingData refreshes it everywhere) ────
  const enabled = open && !!engagementId;
  const engId = engagementId ?? 0;

  const engagementQuery = useGetEngagement(engId, {
    query: { enabled, queryKey: getGetEngagementQueryKey(engId) },
  });
  const engagement = enabled ? engagementQuery.data ?? null : null;

  const { data: amendments } = useQuery({
    queryKey: [`/api/engagements/${engId}/amendments`],
    queryFn: ({ signal }) => apiFetch<Engagement[]>(`/engagements/${engId}/amendments`, { signal }),
    enabled,
  });
  const allFilings = enabled && Array.isArray(amendments) ? amendments : [];

  const { data: commentsData } = useListComments(
    { engagementId: engId },
    { query: { enabled, queryKey: getListCommentsQueryKey({ engagementId: engId }) } },
  );
  const comments = enabled ? commentsData ?? [] : [];

  const { data: docsData } = useListDocuments(
    { engagementId: engId },
    { query: { enabled, queryKey: getListDocumentsQueryKey({ engagementId: engId }) } },
  );
  const engagementDocs = enabled ? docsData ?? [] : [];

  /** After any change: refetch all filing data (deadlines, compliance, lists...) and tell the parent. */
  const afterMutation = async () => {
    await invalidateFilingData(queryClient);
    onUpdate?.();
  };

  const failToast = (err: unknown, fallback: string) =>
    toast({ title: fallback, description: errorMessage(err), variant: "destructive" });

  // ── Start workflow ─────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!deadlineId) return;
    setStarting(true);
    try {
      const eng = await apiFetch<Engagement>(`/deadlines/${deadlineId}/start-workflow`, { method: "POST" });
      queryClient.setQueryData(getGetEngagementQueryKey(eng.id), eng);
      setEngagementId(eng.id);
      toast({ title: "Filing workflow started" });
      await afterMutation();
    } catch (e) {
      failToast(e, "Failed to start workflow");
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

      await apiFetch("/documents/upload", { method: "POST", body: fd });

      setStageFiles(prev => without(prev, stageId));
      setStageDescs(prev => without(prev, stageId));
      const ref = fileInputRefs.current[stageId];
      if (ref) ref.value = "";

      // Refresh the stage documents (and anything else showing this filing).
      await afterMutation();
      toast({ title: "Document uploaded" });
    } catch (e) {
      failToast(e, "Upload failed");
    } finally {
      setUploadingStage(null);
    }
  };

  // ── Delete document ────────────────────────────────────────────────────────
  const handleDeleteDoc = async (docId: number, name: string) => {
    const ok = await confirm({
      title: "Remove this document?",
      description: `"${name}" will be permanently deleted from this filing.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setDeletingDocId(docId);
    try {
      await apiFetch(`/documents/${docId}`, { method: "DELETE" });
      await afterMutation();
      toast({ title: "Document removed" });
    } catch (e) {
      failToast(e, "Could not delete document");
    } finally {
      setDeletingDocId(null);
    }
  };

  // ── Recall a stage submission (maker retracts from for_review) ────────────
  const handleRecallStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      await apiFetch(`/engagements/${engagementId}/recall-stage`, { method: "POST", json: { stage: stageId } });
      await afterMutation();
      toast({ title: `${stageLabel(stageId)} submission recalled — you can now make changes` });
    } catch (e) {
      failToast(e, "Recall failed");
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── Save tax payable amount (Stage 2) ─────────────────────────────────────
  const handleSaveTaxPayable = async () => {
    if (!engagementId) return;
    const val = taxPayableInput.trim();
    const parsed = val === "" ? null : parseFloat(val);
    if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
      toast({ title: "Enter a valid non-negative amount", variant: "destructive" });
      return;
    }
    setSavingTaxPayable(true);
    try {
      await apiFetch(`/engagements/${engagementId}`, { method: "PATCH", json: { taxPayable: parsed } });
      await afterMutation();
      toast({ title: parsed === 0 ? "No tax payable — Stage 4 marked Not Applicable" : "Tax payable saved" });
    } catch (e) {
      failToast(e, "Failed to save");
    } finally {
      setSavingTaxPayable(false);
    }
  };

  // ── Submit a stage for manager review ─────────────────────────────────────
  const handleSubmitStage = async (stageId: StageKey) => {
    if (!engagementId) return;
    setActionLoadingStage(stageId);
    try {
      await apiFetch(`/engagements/${engagementId}/submit-stage`, { method: "POST", json: { stage: stageId } });
      await afterMutation();
      toast({ title: `${stageLabel(stageId)} submitted for approval` });
    } catch (e) {
      failToast(e, "Submit failed");
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
      const updated = await apiFetch<Engagement>(`/engagements/${engagementId}/approve-stage`, {
        method: "POST",
        json: { stage: stageId, notes },
      });
      setStageApprovalNotes(prev => without(prev, stageId));
      await afterMutation();
      toast({ title: updated?.status === "completed" ? "All stages approved — filing complete!" : `${stageLabel(stageId)} approved` });
    } catch (e) {
      failToast(e, "Approve failed");
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
      await apiFetch(`/engagements/${engagementId}/reject-stage`, { method: "POST", json: { stage: stageId, notes: reason } });
      setStageRejectReasons(prev => without(prev, stageId));
      setShowRejectForm(prev => without(prev, stageId));
      await afterMutation();
      toast({ title: `${stageLabel(stageId)} returned for revision` });
    } catch (e) {
      failToast(e, "Return failed");
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
      await apiFetch(`/engagements/${engagementId}/void-stage`, { method: "POST", json: { stage: stageId, notes } });
      setVoidReasons(prev => without(prev, stageId));
      setShowVoidForm(prev => without(prev, stageId));
      await afterMutation();
      toast({ title: `${stageLabel(stageId)} approval voided` });
    } catch (e) {
      failToast(e, "Void failed");
    } finally {
      setActionLoadingStage(null);
    }
  };

  // ── File amendment ─────────────────────────────────────────────────────────
  const handleAmend = async () => {
    if (!engagementId) return;
    setAmending(true);
    try {
      const amendment = await apiFetch<Engagement>(`/engagements/${engagementId}/amend`, { method: "POST" });
      queryClient.setQueryData(getGetEngagementQueryKey(amendment.id), amendment);
      toast({ title: "Amendment filing started" });
      setEngagementId(amendment.id);
      await afterMutation();
    } catch (e) {
      failToast(e, "Could not create amendment");
    } finally {
      setAmending(false);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  // isManager includes super_admin; isViewer = any read-only (client) account.
  const isManager = can(user, "approveStages");
  const isViewer = !can(user, "editFilings");
  const isCompleted = engagement?.status === "completed";
  const isStarted = !!engagementId && !!engagement;
  const loading = !!engagementId && !engagement && !engagementQuery.isError;

  const stageStatuses: Record<StageKey, string> = engagement?.stageStatuses ?? {
    source_collection: "not_started",
    draft_return: "not_started",
    confirmation: "not_started",
    payment: "not_started",
  };

  const taxPayable = engagement?.taxPayable ?? null;
  const isPaymentNA = taxPayable !== null && taxPayable === 0;
  // The figure belongs to the draft return: once it is submitted or approved only a
  // manager may change it (the server refuses a maker's change with 403).
  const draftLocked = stageStatuses.draft_return === "for_review" || stageStatuses.draft_return === "approved";
  const taxPayableLocked = isCompleted || (draftLocked && !isManager);

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
    engagementDocs.filter(d => d.stage === stageId);

  const activeFilingLabel = engagement?.isAmendment
    ? `${engagement.title.includes("Amendment") ? engagement.title.split("—")[1]?.trim() ?? "Amendment" : "Amendment"}`
    : "Original Filing";

  const hasMultipleFilings = allFilings.length > 1;

  /** File picker + description + Upload, or a merged PDF (editable stages only: the server refuses uploads to a for_review or approved stage). */
  const renderUploader = (stageId: StageKey) => {
    const selectedFile = stageFiles[stageId];
    const descValue = stageDescs[stageId] ?? "";
    const isStageUploading = uploadingStage === stageId;
    return (
      <div className="space-y-2 pt-1 border-t">
        {/* Option 1: single file */}
        <div className="flex gap-2">
          <Input
            type="file"
            aria-label={`Choose a file for ${stageLabel(stageId)}`}
            ref={el => { if (el) fileInputRefs.current[stageId] = el; }}
            accept={UPLOAD_ACCEPT}
            onChange={e => {
              const file = e.target.files?.[0] ?? undefined;
              setStageFiles(prev => file ? { ...prev, [stageId]: file } : prev);
            }}
            className="text-sm flex-1 min-w-0"
          />
        </div>
        {selectedFile && (
          <div className="flex gap-2 items-start">
            <Input
              placeholder="Description (optional)"
              aria-label="Document description (optional)"
              value={descValue}
              onChange={e => setStageDescs(prev => ({ ...prev, [stageId]: e.target.value }))}
              className="text-sm flex-1 min-w-0"
            />
            <Button size="sm" onClick={() => handleUpload(stageId)} disabled={isStageUploading}>
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
          onClick={() => setMergePDFStage(stageId)}
        >
          <Merge className="h-4 w-4" />
          Upload Merged PDF
          <span className="hidden sm:inline text-xs text-muted-foreground font-normal">(combine multiple PDFs into one)</span>
        </Button>
      </div>
    );
  };

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
                  {description ? `${description} · ` : null}<span className="font-medium text-foreground">{period}</span> · Due {formatDate(dueDate)}
                </div>
              </DialogDescription>
            </div>

            {hasMultipleFilings && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="shrink-0 gap-1.5" aria-label={`Filing history: ${activeFilingLabel}`}>
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
                        <p className="text-xs text-muted-foreground">{getEngagementStatus(f.status).label}</p>
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
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading workflow" />
            </div>
          )}

          {!!engagementId && !engagement && engagementQuery.isError && (
            <ErrorState
              title="Failed to load workflow"
              error={engagementQuery.error}
              onRetry={() => engagementQuery.refetch()}
            />
          )}

          {isStarted && (
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
                <div className="flex flex-wrap items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-green-800">
                  <Check className="h-5 w-5 flex-shrink-0" />
                  <div className="flex-1 min-w-[12rem]">
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
                  const statusStyle = getStageStatus(stageStatus);
                  const Icon = stage.icon;
                  const docs = stageDocs(stage.id);

                  const isStageNotApplicable = stageStatus === "not_applicable";
                  const isStageApproved = stageStatus === "approved";
                  const isStageForReview = stageStatus === "for_review";
                  const isStageEditable = stageStatus === "not_started" || stageStatus === "in_progress";
                  const isStageLoading = actionLoadingStage === stage.id;

                  // Stage 4: if not applicable, show a locked card
                  if (isStageNotApplicable) {
                    return (
                      <div key={stage.id} className="border rounded-lg p-4 border-slate-200 bg-slate-50/50 opacity-75">
                        <div className="flex flex-wrap items-center gap-2">
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
                      <div className="flex flex-wrap items-center gap-2">
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
                          <Label htmlFor={`tax-payable-${engId}`} className="text-xs font-medium text-muted-foreground">Tax Payable Amount (₱)</Label>
                          <div className="flex gap-2 items-center">
                            <Input
                              id={`tax-payable-${engId}`}
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="e.g. 12500.00 — enter 0 if no tax due"
                              value={taxPayableInput}
                              onChange={e => setTaxPayableInput(e.target.value)}
                              className="text-sm flex-1 min-w-0"
                              disabled={taxPayableLocked}
                            />
                            {!taxPayableLocked && (
                              <Button size="sm" variant="outline" onClick={handleSaveTaxPayable} disabled={savingTaxPayable}>
                                {savingTaxPayable ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                              </Button>
                            )}
                          </div>
                          {!isCompleted && taxPayableLocked && (
                            <p className="text-xs text-muted-foreground">
                              {stageStatuses.draft_return === "approved"
                                ? "Locked: the draft return is approved. A manager can undo that approval to change it."
                                : "Locked while the draft return is pending approval. Recall the submission to change it."}
                            </p>
                          )}
                          {taxPayable !== null && (
                            <p className="text-xs text-muted-foreground">
                              {taxPayable === 0
                                ? "✓ No tax payable — Stage 4 (Payment) is Not Applicable."
                                : `✓ Tax payable: ${formatPeso(taxPayable)} — Stage 4 required.`}
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
                              className="flex items-center gap-2 p-2 rounded-md bg-muted/50 hover:bg-muted"
                            >
                              <button
                                type="button"
                                aria-label={`View ${doc.originalName}`}
                                className="flex items-center gap-2 flex-1 min-w-0 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                  className="h-7 w-7 shrink-0 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                                  disabled={deletingDocId === doc.id}
                                  onClick={() => handleDeleteDoc(doc.id, doc.originalName)}
                                  title="Remove attachment"
                                  aria-label={`Remove ${doc.originalName}`}
                                >
                                  {deletingDocId === doc.id
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Trash2 className="h-3.5 w-3.5" />
                                  }
                                </Button>
                              )}
                              {!isViewer && !isStageEditable && (
                                <span className="shrink-0" title="Locked while the stage is pending approval or approved">
                                  <Lock className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
                                  <span className="sr-only">Locked: documents cannot be removed while the stage is pending approval or approved</span>
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Upload — when stage is editable (not_started or in_progress) */}
                      {!isViewer && isStageEditable && renderUploader(stage.id)}

                      {/* Staff (makers and above): Submit button */}
                      {!isViewer && isStageEditable && !isCompleted && (
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

                      {/* Staff (makers and above): Recall button — when stage is pending approval */}
                      {!isViewer && isStageForReview && !isCompleted && (
                        <div className="pt-2 border-t flex flex-wrap items-center justify-between gap-3">
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
                                aria-label={`Approval note for ${stage.label} (optional)`}
                                value={stageApprovalNotes[stage.id] ?? ""}
                                onChange={e => setStageApprovalNotes(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm"
                              />
                              <div className="flex flex-wrap gap-2">
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
                              <Label htmlFor={`reject-${stage.id}`} className="text-sm">Reason for returning (required)</Label>
                              <Textarea
                                id={`reject-${stage.id}`}
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
                                    setShowRejectForm(prev => without(prev, stage.id));
                                    setStageRejectReasons(prev => without(prev, stage.id));
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
                                aria-label={`Reason for undoing the ${stage.label} approval (optional)`}
                                value={voidReasons[stage.id] ?? ""}
                                onChange={e => setVoidReasons(prev => ({ ...prev, [stage.id]: e.target.value }))}
                                className="text-sm bg-white"
                              />
                              <div className="flex flex-wrap gap-2">
                                <Button size="sm" variant="destructive" onClick={() => handleVoidStage(stage.id)} disabled={isStageLoading}>
                                  {isStageLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                                  Confirm Undo
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => {
                                  setShowVoidForm(prev => without(prev, stage.id));
                                  setVoidReasons(prev => without(prev, stage.id));
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
                          {c.createdAt ? formatDateTime(c.createdAt) : ""}
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
          toast({ title: "Merged PDF uploaded" });
          void afterMutation();
        }}
      />
    </Dialog>
  );
}
