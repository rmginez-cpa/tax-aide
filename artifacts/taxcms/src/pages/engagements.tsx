import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useUrlFilterState } from "@/hooks/use-url-filter-state";
import {
  useListEngagements, useCreateEngagement, useListClients, useListUsers, useListDocuments,
  useListDeadlines, getListEngagementsQueryKey, getListDocumentsQueryKey,
  getListClientsQueryKey, getListUsersQueryKey, getListDeadlinesQueryKey,
  type Engagement, type ListEngagementsParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, isStaff } from "@/lib/permissions";
import { errorMessage } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { ENGAGEMENT_STATUS, ENGAGEMENT_STATUS_KEYS, FILING_STAGES, getEngagementStatus, type FilingStageKey } from "@/lib/status";
import { invalidateFilingData } from "@/lib/queries";
import { ErrorState } from "@/components/ErrorState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, Briefcase, ExternalLink, User2, Calendar, Paperclip, FileText, Image, Sheet, FileCode,
  X, ClipboardCheck, UserCheck, Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileViewer } from "@/components/FileViewer";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";
import { UnlinkedClientNotice } from "@/components/UnlinkedClientNotice";

// ── Helpers ──────────────────────────────────────────────────────────────────
function FileTypeIcon({ mimeType, name }: { mimeType: string; name?: string }) {
  const ext = name?.split(".").pop()?.toLowerCase() ?? "";
  if (mimeType === "application/pdf") return <FileText className="h-4 w-4 text-red-500 shrink-0" />;
  if (mimeType.startsWith("image/")) return <Image className="h-4 w-4 text-purple-500 shrink-0" />;
  if (mimeType.includes("spreadsheetml") || mimeType.includes("ms-excel") || ext === "xlsx" || ext === "xls")
    return <Sheet className="h-4 w-4 text-green-600 shrink-0" />;
  if (ext === "csv" || ext === "dat") return <FileCode className="h-4 w-4 text-blue-500 shrink-0" />;
  return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />;
}

/** Stage group heading in the documents dialog (documents without a stage go under "Other Documents"). */
function stageGroupLabel(stage: string): string {
  return FILING_STAGES[stage as FilingStageKey]?.label ?? "Other Documents";
}

// ── Per-engagement document panel ────────────────────────────────────────────
function EngagementDocsDialog({
  engagementId, title, open, onClose,
}: { engagementId: number; title: string; open: boolean; onClose: () => void }) {
  const { data: docs, isLoading, isError, error, refetch } = useListDocuments(
    { engagementId },
    { query: { enabled: open, queryKey: getListDocumentsQueryKey({ engagementId }) } }
  );
  type DocItem = NonNullable<typeof docs>[number];
  const [viewerDoc, setViewerDoc] = useState<DocItem | null>(null);

  const byStage: Record<string, DocItem[]> = {};
  docs?.forEach(d => {
    const s = d.stage ?? "general";
    (byStage[s] ??= []).push(d);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={v => !v && onClose()}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base pr-6">
              <Paperclip className="h-4 w-4 text-primary shrink-0" />
              <span className="min-w-0 break-words">Documents — {title}</span>
            </DialogTitle>
            <DialogDescription>The documents uploaded to this filing, grouped by workflow stage.</DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="space-y-2 py-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : isError ? (
            <ErrorState title="Could not load documents" error={error} onRetry={refetch} compact />
          ) : !docs || docs.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Paperclip className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No documents attached to this engagement.</p>
            </div>
          ) : (
            <div className="space-y-4 py-1">
              {Object.entries(byStage).map(([stage, stageDocs]) => (
                <div key={stage}>
                  {Object.keys(byStage).length > 1 && (
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 px-1">
                      {stageGroupLabel(stage)}
                    </p>
                  )}
                  <div className="space-y-1">
                    {stageDocs.map(doc => (
                      <button
                        key={doc.id}
                        type="button"
                        className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/60 transition-colors text-left group"
                        onClick={() => setViewerDoc(doc)}
                      >
                        <FileTypeIcon mimeType={doc.mimeType} name={doc.originalName} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{doc.originalName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {formatBytes(doc.fileSize)}
                            {doc.uploadedByName && <> · {doc.uploadedByName}</>}
                            {' · '}{formatDate(doc.createdAt)}
                            {doc.description && <> · {doc.description}</>}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {viewerDoc && (
        <FileViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />
      )}
    </>
  );
}

/**
 * Tax types for a manual engagement: the BIR forms generateBIRDeadlines (api-server
 * routes/clients.ts) produces, the form number in parentheses (the server's engagementFormNumber
 * in api-server/src/lib/filingLabels.ts reads it into the engagement's `formNumber`).
 * 2550M is not offered (not required from 2023) and 1601E was replaced by 1601EQ / 0619E.
 */
const TAX_TYPES = [
  "Income Tax (1701Q)", "Income Tax (1701)", "Income Tax (1702Q)", "Income Tax (1702)",
  "VAT (2550Q)", "Percentage Tax (2551Q)",
  "Withholding Tax (1601C)", "Withholding Tax (0619E)", "Withholding Tax (1601EQ)",
  "Withholding Tax (0619F)", "Withholding Tax (1601FQ)",
  "Annual Information Return (1604C)", "Annual Information Return (1604E)", "Annual Information Return (1604F)",
  "Certificate of Compensation (2316)", "Documentary Stamp Tax (2000)",
];

interface WorkflowTarget {
  engagementId: number;
  deadlineId: number | null;
  clientId: number;
  formNumber: string;
  description: string;
  period: string;
  dueDate: string;
}

/** Engagement-level statuses to filter on. */
const STATUS_FILTERS = ENGAGEMENT_STATUS_KEYS;

/** Filters kept in the URL query string: ?status=&review=1&mine=1&clientId=&q= */
interface Filters {
  status: string;
  review: boolean;
  mine: boolean;
  clientId: number | null;
  q: string;
}

/** URL keys and their defaults (useUrlFilterState drops a value equal to its default). */
const FILTER_DEFAULTS = { status: "all", review: "", mine: "", clientId: "", q: "" };

function parseFilters(raw: Record<keyof typeof FILTER_DEFAULTS, string>): Filters {
  const clientId = Number(raw.clientId);
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(raw.status) ? raw.status : "all",
    review: raw.review === "1",
    mine: raw.mine === "1",
    clientId: Number.isInteger(clientId) && clientId > 0 ? clientId : null,
    q: raw.q,
  };
}

const EMPTY_FORM = { clientId: "", title: "", taxType: "", period: "", fiscalYear: "", assignedTo: "", dueDate: "", notes: "" };

export default function Engagements() {
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  // Shared URL filter state: parameters this page does not manage (e.g. a shared link's extras) are kept.
  const [rawFilters, setRawFilters] = useUrlFilterState(FILTER_DEFAULTS);
  const filters = parseFilters(rawFilters);

  const listParams: ListEngagementsParams = {};
  if (filters.clientId) listParams.clientId = filters.clientId;
  if (filters.status !== "all") listParams.status = filters.status;
  const hasListParams = Object.keys(listParams).length > 0;
  const { data: engagements, isLoading, isError, error, refetch } = useListEngagements(
    hasListParams ? listParams : undefined,
    { query: { queryKey: getListEngagementsQueryKey(hasListParams ? listParams : undefined) } },
  );
  // Clients/users/deadlines are only needed for staff actions (create dialog, starting workflows).
  const { data: clients } = useListClients({ query: { enabled: staff, queryKey: getListClientsQueryKey() } });
  const { data: users } = useListUsers({ query: { enabled: staff, queryKey: getListUsersQueryKey() } });
  const { data: deadlines } = useListDeadlines(undefined, { query: { enabled: staff, queryKey: getListDeadlinesQueryKey() } });
  const createEngagement = useCreateEngagement();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [docsEngagement, setDocsEngagement] = useState<{ id: number; title: string } | null>(null);
  const [workflowTarget, setWorkflowTarget] = useState<WorkflowTarget | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  // The search box keeps its own state (so typing never fights the URL) and writes through to ?q=.
  const [searchText, setSearchText] = useState(filters.q);
  useEffect(() => { setSearchText(filters.q); }, [filters.q]);

  const updateFilters = (patch: Partial<Filters>) => {
    const out: Partial<Record<keyof typeof FILTER_DEFAULTS, string>> = {};
    if ("status" in patch) out.status = patch.status ?? "all";
    if ("review" in patch) out.review = patch.review ? "1" : "";
    if ("mine" in patch) out.mine = patch.mine ? "1" : "";
    if ("clientId" in patch) out.clientId = patch.clientId ? String(patch.clientId) : "";
    if ("q" in patch) out.q = patch.q ?? "";
    setRawFilters(out);
  };

  const rows = engagements ?? [];
  const needle = searchText.trim().toLowerCase();
  const filtered = rows.filter(e => {
    if (needle) {
      const haystack = [e.title, e.taxType, e.clientName ?? "", e.period].join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.status !== "all" && e.status !== filters.status) return false;
    if (filters.review && !((e.stagesForReview ?? 0) > 0)) return false;
    if (filters.mine && e.assignedTo !== user?.id) return false;
    return true;
  });

  const filterClientName = filters.clientId
    ? clients?.find(c => c.id === filters.clientId)?.name
      ?? rows.find(e => e.clientId === filters.clientId)?.clientName
      ?? `Client #${filters.clientId}`
    : null;

  const anyFilter = filters.status !== "all" || filters.review || filters.mine || !!filters.clientId || !!needle;

  // Find the deadline linked to an engagement (by engagementId foreign key)
  const findDeadlineId = (engagementId: number): number | null => {
    return deadlines?.find(d => d.engagementId === engagementId)?.id ?? null;
  };

  const handleOpenWorkflow = (e: Engagement) => {
    setWorkflowTarget({
      engagementId: e.id,
      deadlineId: findDeadlineId(e.id),
      clientId: e.clientId,
      // Server-derived code (same rules as the compliance checklist); the subtitle is the client.
      formNumber: e.formNumber ?? e.taxType,
      description: e.clientName ?? "",
      period: e.period,
      dueDate: e.dueDate ?? "",
    });
  };

  const handleCreate = () => {
    if (!form.clientId || !form.title || !form.taxType || !form.period) {
      toast({ title: "Please fill in all required fields", variant: "destructive" });
      return;
    }
    createEngagement.mutate({
      data: {
        clientId: parseInt(form.clientId, 10),
        title: form.title,
        taxType: form.taxType,
        period: form.period,
        fiscalYear: form.fiscalYear || null,
        assignedTo: form.assignedTo ? parseInt(form.assignedTo, 10) : null,
        dueDate: form.dueDate || null,
        notes: form.notes || null,
      }
    }, {
      onSuccess: () => {
        void invalidateFilingData(queryClient);
        setOpen(false);
        setForm(EMPTY_FORM);
        toast({ title: "Engagement created" });
      },
      onError: (err) => toast({ title: "Failed to create engagement", description: errorMessage(err), variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight">Engagements</h2>
          <p className="text-muted-foreground">Track all tax filing engagements across clients.</p>
        </div>
        {can(user, "editFilings") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />New Engagement</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Create Engagement</DialogTitle>
                <DialogDescription>Start a filing by hand. Filings for generated BIR deadlines start from the deadline with Start Workflow.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="eng-client">Client *</Label>
                  <Select value={form.clientId} onValueChange={v => setForm(f => ({ ...f, clientId: v }))}>
                    <SelectTrigger id="eng-client"><SelectValue placeholder="Select client" /></SelectTrigger>
                    <SelectContent>
                      {clients?.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="eng-title">Engagement Title *</Label>
                  <Input id="eng-title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Q1 2025 VAT Return" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <Label htmlFor="eng-taxtype">Tax Type *</Label>
                    <Select value={form.taxType} onValueChange={v => setForm(f => ({ ...f, taxType: v }))}>
                      <SelectTrigger id="eng-taxtype"><SelectValue placeholder="Select type" /></SelectTrigger>
                      <SelectContent>
                        {TAX_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 min-w-0">
                    <Label htmlFor="eng-period">Period *</Label>
                    <Input id="eng-period" value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value }))} placeholder="Q1 2025" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <Label htmlFor="eng-fy">Fiscal Year</Label>
                    <Input id="eng-fy" value={form.fiscalYear} onChange={e => setForm(f => ({ ...f, fiscalYear: e.target.value }))} placeholder="2025" />
                  </div>
                  <div className="space-y-1.5 min-w-0">
                    <Label htmlFor="eng-due">Due Date</Label>
                    <Input id="eng-due" type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="eng-assignee">Assign to</Label>
                  <Select value={form.assignedTo} onValueChange={v => setForm(f => ({ ...f, assignedTo: v }))}>
                    <SelectTrigger id="eng-assignee"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                    <SelectContent>
                      {users?.filter(u => (u.role as string) === "accountant" || (u.role as string) === "maker").map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="eng-notes">Notes</Label>
                  <Textarea id="eng-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes..." rows={2} />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={createEngagement.isPending}>
                  {createEngagement.isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <UnlinkedClientNotice />

      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search by title, client or form..."
              aria-label="Search engagements by title, client or form"
              value={searchText}
              onChange={e => { setSearchText(e.target.value); updateFilters({ q: e.target.value }); }}
            />
          </div>
          <Select value={filters.status} onValueChange={v => updateFilters({ status: v })}>
            <SelectTrigger className="w-full sm:w-44" aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {STATUS_FILTERS.map(k => (
                <SelectItem key={k} value={k}>{ENGAGEMENT_STATUS[k]?.label ?? k}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {staff && (
            <>
              <Button
                type="button"
                size="sm"
                variant={filters.review ? "default" : "outline"}
                aria-pressed={filters.review}
                className="h-8 gap-1.5"
                onClick={() => updateFilters({ review: !filters.review })}
              >
                <ClipboardCheck className="h-3.5 w-3.5" />
                Has stages for review
              </Button>
              <Button
                type="button"
                size="sm"
                variant={filters.mine ? "default" : "outline"}
                aria-pressed={filters.mine}
                className="h-8 gap-1.5"
                onClick={() => updateFilters({ mine: !filters.mine })}
              >
                <UserCheck className="h-3.5 w-3.5" />
                Assigned to me
              </Button>
            </>
          )}
          {filters.clientId && (
            <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-primary/5 border-primary/20 text-primary pl-2.5 pr-1 py-0.5 text-xs font-medium">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">Client: {filterClientName}</span>
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove client filter ${filterClientName}`}
                onClick={() => updateFilters({ clientId: null })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {anyFilter && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-muted-foreground"
              onClick={() => { setSearchText(""); setRawFilters({ ...FILTER_DEFAULTS }); }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}</div>
      ) : isError ? (
        <ErrorState title="Could not load engagements" error={error} onRetry={refetch} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Briefcase className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No engagements found</p>
            {anyFilter && <p className="text-sm mt-1">Try changing or clearing the filters.</p>}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(e => {
            const st = getEngagementStatus(e.status);
            const forReview = e.stagesForReview ?? 0;
            return (
              <Card key={e.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-0">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left p-4 pr-0 rounded-l-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => handleOpenWorkflow(e)}
                      aria-label={`Open filing workflow: ${e.title}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm break-words">{e.title}</p>
                        <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium border", st.className)}>{st.label}</span>
                        {forReview > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium border bg-amber-50 text-amber-700 border-amber-200">
                            {forReview} for review
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground flex-wrap">
                        <span className="font-medium text-foreground/70">{e.clientName}</span>
                        <span>{e.taxType}</span>
                        <span>{e.period}</span>
                        {e.assignedToName && (
                          <span className="flex items-center gap-1"><User2 className="h-3 w-3" />{e.assignedToName}</span>
                        )}
                        {e.dueDate && (
                          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Due {formatDate(e.dueDate)}</span>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0 pr-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground hover:text-primary hover:bg-primary/5 gap-1.5"
                        title="View attached documents"
                        aria-label={`Docs for ${e.title}`}
                        onClick={() => setDocsEngagement({ id: e.id, title: e.title })}
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        <span className="text-xs hidden sm:inline">Docs</span>
                      </Button>
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground hover:text-primary hover:bg-primary/5"
                      >
                        <Link href={`/engagements/${e.id}`} title="Open detail page" aria-label={`Open detail page for ${e.title}`}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Document viewer for selected engagement */}
      {docsEngagement && (
        <EngagementDocsDialog
          engagementId={docsEngagement.id}
          title={docsEngagement.title}
          open={!!docsEngagement}
          onClose={() => setDocsEngagement(null)}
        />
      )}

      {/* Filing workflow dialog (it refreshes all filing data itself after every change) */}
      {workflowTarget && (
        <FilingWorkflowDialog
          open={!!workflowTarget}
          onClose={() => setWorkflowTarget(null)}
          deadlineId={workflowTarget.deadlineId}
          engagementId={workflowTarget.engagementId}
          clientId={workflowTarget.clientId}
          formNumber={workflowTarget.formNumber}
          description={workflowTarget.description}
          period={workflowTarget.period}
          dueDate={workflowTarget.dueDate}
        />
      )}
    </div>
  );
}
