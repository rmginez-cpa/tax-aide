import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  useListClients,
  useListEngagements,
  useDeleteDocument,
  getListEngagementsQueryKey,
  getListClientsQueryKey,
  type Document as ApiDocument,
  type Engagement,
} from "@workspace/api-client-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth, useAuthConfig } from "@/lib/auth";
import { can, isClientRole } from "@/lib/permissions";
import { apiFetch, downloadDocument, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { FILING_STAGES, FILING_STAGE_KEYS, getStageStatus, type FilingStageKey } from "@/lib/status";
import { invalidateFilingData } from "@/lib/queries";
import { useUrlFilterState } from "@/hooks/use-url-filter-state";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { FileViewer } from "@/components/FileViewer";
import { MergePDFDialog } from "@/components/MergePDFDialog";
import {
  Plus, Search, FileText, Trash2, Download, User2, Eye,
  FileSpreadsheet, FileType, Image, Sparkles, Upload, Merge, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** A document as returned by GET /api/documents (the server also sends `stage`). */
type DocumentRow = ApiDocument & { stage?: string | null };

const PAGE_SIZE = 25;
const MAX_UPLOAD_MB = 50;

/** Type filter: URL value -> label + the MIME prefixes sent as ?mimeType= (comma = any of). */
const TYPE_FILTERS: Record<string, { label: string; mimeType: string }> = {
  pdf: { label: "PDF", mimeType: "application/pdf" },
  excel: { label: "Excel", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml,application/vnd.ms-excel" },
  word: { label: "Word", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml,application/msword" },
  image: { label: "Image", mimeType: "image/" },
  text: { label: "Text / CSV", mimeType: "text/" },
  data: { label: "Data (DAT / other)", mimeType: "application/octet-stream" },
};

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

function isStageKey(value: string): value is FilingStageKey {
  return (FILING_STAGE_KEYS as readonly string[]).includes(value);
}

/** `value` once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Page numbers to show: first, last, and a window around the current page (0 = ellipsis). */
function pageWindow(page: number, pages: number): number[] {
  const set = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages));
  const sorted = [...set].sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(0);
    out.push(p);
  });
  return out;
}

const canView = (doc: DocumentRow) => {
  // Only show View for docs uploaded via the real file system (fileUrl points to content endpoint)
  if (!doc.fileUrl?.startsWith("/api/documents/")) return false;
  const mt = doc.mimeType;
  const ext = (doc.originalName?.split(".").pop() || "").toLowerCase();
  return (
    mt === "application/pdf" ||
    mt.includes("spreadsheetml") ||
    mt.includes("ms-excel") ||
    mt.includes("wordprocessingml") ||
    mt === "application/msword" ||
    mt.startsWith("image/") ||
    mt.startsWith("text/") ||
    ext === "csv" ||
    ext === "dat"
  );
};

export default function Documents() {
  const { user } = useAuth();
  const { config } = useAuthConfig();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const deleteDocument = useDeleteDocument();
  const clientUser = isClientRole(user?.role);
  const canUpload = can(user, "uploadDocuments");

  // ── Filters (in the URL) ────────────────────────────────────────────────
  const [filters, setFilters] = useUrlFilterState({ client: "", filing: "", stage: "", type: "", q: "", page: "" });
  const clientId = /^\d+$/.test(filters.client) ? filters.client : "";
  const filingId = /^\d+$/.test(filters.filing) ? filters.filing : "";
  const stage = filters.stage === "none" || isStageKey(filters.stage) ? filters.stage : "";
  const type = TYPE_FILTERS[filters.type] ? filters.type : "";
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  // Typing is debounced; clearing the search applies at once.
  const typedQ = useDebounced(filters.q.trim(), 300);
  const debouncedQ = filters.q.trim() ? typedQ : "";
  /** Change filters and go back to page 1. */
  const setFilter = (patch: Partial<typeof filters>) => setFilters({ ...patch, page: "" });

  const { data: clients } = useListClients({ query: { enabled: !clientUser, queryKey: getListClientsQueryKey() } });
  // Filings to pick from: a client account's own filings, or the chosen client's.
  const filingParams = clientUser ? undefined : { clientId: Number(clientId) };
  const { data: filings } = useListEngagements(filingParams, {
    query: { enabled: clientUser || !!clientId, queryKey: getListEngagementsQueryKey(filingParams) },
  });

  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (clientId) p.set("clientId", clientId);
    if (filingId) p.set("engagementId", filingId);
    if (stage) p.set("stage", stage);
    if (type) p.set("mimeType", TYPE_FILTERS[type].mimeType);
    if (debouncedQ) p.set("q", debouncedQ);
    p.set("order", "desc");
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String((page - 1) * PAGE_SIZE));
    return p.toString();
  }, [clientId, filingId, stage, type, debouncedQ, page]);

  // Key starts with "/api/documents" so invalidateFilingData() refreshes it.
  const documentsQuery = useQuery({
    queryKey: ["/api/documents", "page", listParams],
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Response>(`/documents?${listParams}`, { signal, responseType: "response" });
      const docs = (await res.json()) as DocumentRow[];
      const total = Number(res.headers.get("X-Total-Count") ?? docs.length);
      return { docs, total: Number.isFinite(total) ? total : docs.length };
    },
    placeholderData: keepPreviousData,
  });
  const documents = documentsQuery.data?.docs ?? [];
  const total = documentsQuery.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // A page past the end (after deletions, or a stale link): go to the last page.
  useEffect(() => {
    if (documentsQuery.data && page > pages) setFilters({ page: pages > 1 ? String(pages) : "" });
  }, [documentsQuery.data, page, pages, setFilters]);

  const filtersActive = !!(clientId || filingId || stage || type || filters.q);

  // ── Actions ─────────────────────────────────────────────────────────────
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<DocumentRow | null>(null);
  const [seeding, setSeeding] = useState(false);

  const handleSeedSamples = async () => {
    setSeeding(true);
    try {
      const data = await apiFetch<{ message?: string }>("/documents/seed-samples", { method: "POST" });
      await invalidateFilingData(queryClient);
      toast({ title: data?.message || "Sample documents created" });
    } catch (e) {
      toast({ title: "Failed to create sample files", description: errorMessage(e), variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = async (doc: DocumentRow) => {
    const deleted = await confirm({
      title: "Delete this document?",
      description: `"${doc.originalName}" will be deleted permanently. This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => deleteDocument.mutateAsync({ id: doc.id }),
    });
    if (!deleted) return;
    await invalidateFilingData(queryClient);
    toast({ title: "Document deleted" });
  };

  const handleDownload = async (doc: DocumentRow) => {
    try {
      await downloadDocument(doc.id, doc.originalName);
    } catch (e) {
      toast({ title: "Download failed", description: errorMessage(e), variant: "destructive" });
    }
  };

  const pageHref = (p: number) => {
    const next = new URLSearchParams(window.location.search);
    if (p > 1) next.set("page", String(p));
    else next.delete("page");
    const qs = next.toString();
    return qs ? `?${qs}` : window.location.pathname;
  };
  const goToPage = (p: number) => (e: MouseEvent) => {
    e.preventDefault();
    if (p < 1 || p > pages || p === page) return;
    setFilters({ page: p > 1 ? String(p) : "" }, { push: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const clientName = (id: string) => clients?.find(c => String(c.id) === id)?.name;
  const filingLabel = (f: { title: string; period: string; isAmendment?: unknown }) =>
    `${f.title}${f.isAmendment ? " (amendment)" : ""}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight">Documents</h2>
          <p className="text-muted-foreground">Tax documents across all clients and engagements.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {config.demoAccounts && can(user, "seedSamples") && (
            <Button variant="outline" size="sm" onClick={handleSeedSamples} disabled={seeding} className="gap-1.5">
              <Sparkles className="h-4 w-4" />
              {seeding ? "Creating..." : "Create Sample Files"}
            </Button>
          )}
          {canUpload && (
            <>
              <Button variant="outline" className="gap-1.5" onClick={() => setMergeOpen(true)}>
                <Merge className="h-4 w-4" />Upload Merged PDF
              </Button>
              <UploadDialog
                open={uploadOpen}
                onOpenChange={setUploadOpen}
                defaults={{ clientId, filingId, stage: isStageKey(stage) ? stage : "" }}
                clients={clients ?? []}
                onUploaded={async () => {
                  await invalidateFilingData(queryClient);
                  toast({ title: "File uploaded successfully" });
                }}
              />
            </>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by file name..."
            aria-label="Search by file name"
            value={filters.q}
            onChange={e => setFilter({ q: e.target.value })}
          />
        </div>
        {!clientUser && (
          <Select value={clientId || "all"} onValueChange={v => setFilter({ client: v === "all" ? "" : v, filing: "" })}>
            <SelectTrigger aria-label="Filter by client"><SelectValue placeholder="All clients" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {(clients ?? []).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              {clientId && !clientName(clientId) && <SelectItem value={clientId}>Client #{clientId}</SelectItem>}
            </SelectContent>
          </Select>
        )}
        <Select
          value={filingId || "all"}
          onValueChange={v => setFilter({ filing: v === "all" ? "" : v })}
          disabled={!clientUser && !clientId && !filingId}
        >
          <SelectTrigger aria-label="Filter by filing">
            <SelectValue placeholder={!clientUser && !clientId ? "Pick a client to filter by filing" : "All filings"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{!clientUser && !clientId ? "All filings (pick a client first)" : "All filings"}</SelectItem>
            {(filings ?? []).map(f => <SelectItem key={f.id} value={String(f.id)}>{filingLabel(f)}</SelectItem>)}
            {filingId && !(filings ?? []).some(f => String(f.id) === filingId) && (
              <SelectItem value={filingId}>Filing #{filingId}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select value={stage || "all"} onValueChange={v => setFilter({ stage: v === "all" ? "" : v })}>
          <SelectTrigger aria-label="Filter by workflow stage"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {FILING_STAGE_KEYS.map(k => <SelectItem key={k} value={k}>{FILING_STAGES[k].label}</SelectItem>)}
            <SelectItem value="none">No stage</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type || "all"} onValueChange={v => setFilter({ type: v === "all" ? "" : v })}>
          <SelectTrigger aria-label="Filter by file type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All file types</SelectItem>
            {Object.entries(TYPE_FILTERS).map(([k, t]) => <SelectItem key={k} value={k}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {documentsQuery.isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : documentsQuery.isError ? (
        <ErrorState title="Could not load documents" error={documentsQuery.error} onRetry={documentsQuery.refetch} />
      ) : documents.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No documents found</p>
            {filtersActive ? (
              <Button variant="link" className="mt-1" onClick={() => setFilters({ client: "", filing: "", stage: "", type: "", q: "", page: "" })}>
                Clear filters
              </Button>
            ) : (
              <p className="text-sm mt-1">
                {config.demoAccounts && can(user, "seedSamples")
                  ? 'Upload a file or click "Create Sample Files" to add test documents.'
                  : canUpload ? "Upload a file to get started." : null}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {total === 1 ? "1 document" : `${total} documents`}
            {pages > 1 && ` · showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)}`}
            {documentsQuery.isFetching && !documentsQuery.isLoading && <Loader2 className="inline h-3 w-3 ml-2 animate-spin" aria-label="Updating" />}
          </p>
          <ul className="space-y-2">
            {documents.map(doc => {
              const { label, color } = getMimeLabel(doc.mimeType, doc.originalName);
              const stageInfo = doc.stage && isStageKey(doc.stage) ? FILING_STAGES[doc.stage] : null;
              return (
                <li key={doc.id}>
                  <Card className="hover:shadow-sm transition-shadow">
                    <CardContent className="p-3 sm:p-4">
                      <div className="flex items-center gap-3 sm:gap-4">
                        <div className="shrink-0">
                          <FileIcon mimeType={doc.mimeType} className="h-8 w-8" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm truncate max-w-full sm:max-w-xs" title={doc.originalName}>{doc.originalName}</p>
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${color}`}>{label}</span>
                            {stageInfo && <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${stageInfo.className}`}>{stageInfo.shortLabel}</span>}
                            {doc.version > 1 && <span className="text-xs text-muted-foreground">v{doc.version}</span>}
                          </div>
                          <div className="flex items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
                            {doc.uploadedByName && (
                              <span className="flex items-center gap-1"><User2 className="h-3 w-3" aria-hidden="true" />{doc.uploadedByName}</span>
                            )}
                            {doc.clientName && <span>{doc.clientName}</span>}
                            <span>{formatBytes(doc.fileSize)}</span>
                            <span>{formatDateTime(doc.createdAt)}</span>
                          </div>
                          {doc.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 italic break-words">{doc.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {canView(doc) && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5 h-8 text-xs px-2 sm:px-3"
                              aria-label={`View ${doc.originalName}`}
                              onClick={() => setViewerDoc(doc)}
                            >
                              <Eye className="h-3.5 w-3.5" /><span className="hidden sm:inline">View</span>
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            title="Download"
                            aria-label={`Download ${doc.originalName}`}
                            onClick={() => handleDownload(doc)}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {can(user, "deleteDocuments") && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              title="Delete"
                              aria-label={`Delete ${doc.originalName}`}
                              onClick={() => handleDelete(doc)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <Pagination aria-label="Document pages">
              <PaginationContent className="flex-wrap justify-center">
                <PaginationItem>
                  <PaginationPrevious
                    href={pageHref(Math.max(1, page - 1))}
                    onClick={goToPage(page - 1)}
                    aria-disabled={page <= 1}
                    className={cn(page <= 1 && "pointer-events-none opacity-50")}
                  />
                </PaginationItem>
                {pageWindow(page, pages).map((p, i) => (
                  <PaginationItem key={p === 0 ? `gap-${i}` : p} className="hidden sm:list-item">
                    {p === 0 ? (
                      <span className="px-2 text-muted-foreground" aria-hidden="true">…</span>
                    ) : (
                      <PaginationLink href={pageHref(p)} isActive={p === page} onClick={goToPage(p)} aria-label={`Page ${p}`}>
                        {p}
                      </PaginationLink>
                    )}
                  </PaginationItem>
                ))}
                <PaginationItem className="sm:hidden text-sm text-muted-foreground px-2">
                  {page} / {pages}
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    href={pageHref(Math.min(pages, page + 1))}
                    onClick={goToPage(page + 1)}
                    aria-disabled={page >= pages}
                    className={cn(page >= pages && "pointer-events-none opacity-50")}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}

      <FileViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />

      <MergePDFDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        onUploaded={() => {
          invalidateFilingData(queryClient);
          toast({ title: "Merged PDF uploaded successfully" });
          setMergeOpen(false);
        }}
      />
    </div>
  );
}

// ── Upload dialog ─────────────────────────────────────────────────────────────

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected from the page filters when the dialog opens. */
  defaults: { clientId: string; filingId: string; stage: FilingStageKey | "" };
  clients: Array<{ id: number; name: string }>;
  onUploaded: () => Promise<void> | void;
}

/** Staff upload: a file, optionally linked to a client, one of its filings and a workflow stage. */
function UploadDialog({ open, onOpenChange, defaults, clients, onUploaded }: UploadDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [clientId, setClientId] = useState("");
  const [filingId, setFilingId] = useState("");
  const [stage, setStage] = useState<FilingStageKey | "">("");
  const [uploading, setUploading] = useState(false);

  const filingParams = { clientId: Number(clientId) };
  const { data: filings, isLoading: loadingFilings } = useListEngagements(filingParams, {
    query: { enabled: open && !!clientId, queryKey: getListEngagementsQueryKey(filingParams) },
  });
  // The server also sends per-stage statuses (not in the generated type).
  const filing = filings?.find(f => String(f.id) === filingId) as
    | (Engagement & { stageStatuses?: Record<string, string> })
    | undefined;

  const reset = () => {
    setSelectedFile(null);
    setDescription("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    if (uploading) return;
    if (next) {
      reset();
      setClientId(defaults.clientId);
      setFilingId(defaults.clientId ? defaults.filingId : "");
      setStage(defaults.clientId && defaults.filingId ? defaults.stage : "");
    }
    onOpenChange(next);
  };

  /** Why a stage cannot take uploads (mirrors the server's lock rules), or null. */
  const stageLock = (key: FilingStageKey): string | null => {
    if (!filing) return null;
    if (filing.status === "completed") return "filing completed";
    const s = filing.stageStatuses?.[key];
    if (s === "for_review" || s === "approved") return getStageStatus(s).label.toLowerCase();
    return null;
  };

  const tooLarge = !!selectedFile && selectedFile.size > MAX_UPLOAD_MB * 1024 * 1024;

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
      if (clientId) formData.append("clientId", clientId);
      if (clientId && filingId) formData.append("engagementId", filingId);
      if (clientId && filingId && stage) formData.append("stage", stage);
      await apiFetch("/documents/upload", { method: "POST", body: formData });
      await onUploaded();
      onOpenChange(false);
      reset();
    } catch (e) {
      toast({ title: "Upload failed", description: errorMessage(e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="gap-1.5"><Plus className="h-4 w-4" />Upload File</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Document</DialogTitle>
          <DialogDescription>Upload a PDF, Excel, Word, image, text, CSV or DAT file.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="upload-file">File *</Label>
            <input
              id="upload-file"
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="sr-only"
              onChange={e => setSelectedFile(e.target.files?.[0] || null)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "w-full border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selectedFile ? "border-primary/50 bg-primary/5" : "border-muted-foreground/25 hover:border-primary/40 hover:bg-muted/30",
              )}
            >
              {selectedFile ? (
                <span className="block space-y-1">
                  <FileIcon mimeType={selectedFile.type} className="h-8 w-8 mx-auto" />
                  <span className="block font-medium text-sm break-all">{selectedFile.name}</span>
                  <span className={cn("block text-xs", tooLarge ? "text-destructive" : "text-muted-foreground")}>
                    {formatBytes(selectedFile.size)}{tooLarge && ` — larger than ${MAX_UPLOAD_MB} MB`}
                  </span>
                  <span className="block text-xs text-primary">Click to choose a different file</span>
                </span>
              ) : (
                <span className="block space-y-1.5">
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
                  <span className="block text-sm font-medium">Click to select a file</span>
                  <span className="block text-xs text-muted-foreground">PDF, Excel, Word, Images, Text, CSV, DAT (max {MAX_UPLOAD_MB} MB)</span>
                </span>
              )}
            </button>
          </div>

          <div className="space-y-1.5">
            <Label>Client <span className="text-muted-foreground">(optional)</span></Label>
            <Select value={clientId || "none"} onValueChange={v => { setClientId(v === "none" ? "" : v); setFilingId(""); setStage(""); }}>
              <SelectTrigger aria-label="Client"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No client (firm document)</SelectItem>
                {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {clientId && (
            <div className="space-y-1.5">
              <Label>Filing <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={filingId || "none"} onValueChange={v => { setFilingId(v === "none" ? "" : v); setStage(""); }}>
                <SelectTrigger aria-label="Filing"><SelectValue placeholder={loadingFilings ? "Loading filings..." : undefined} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{loadingFilings ? "Loading filings..." : "Not linked to a filing"}</SelectItem>
                  {(filings ?? []).map(f => (
                    <SelectItem key={f.id} value={String(f.id)} disabled={f.status === "completed"}>
                      {f.title}{f.status === "completed" ? " (completed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!loadingFilings && filings?.length === 0 && (
                <p className="text-xs text-muted-foreground">This client has no filings yet. Start one from a deadline.</p>
              )}
            </div>
          )}

          {clientId && filingId && (
            <div className="space-y-1.5">
              <Label>Workflow stage <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={stage || "none"} onValueChange={v => setStage(v === "none" ? "" : (v as FilingStageKey))}>
                <SelectTrigger aria-label="Workflow stage"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No stage</SelectItem>
                  {FILING_STAGE_KEYS.map(k => {
                    const lock = stageLock(k);
                    return (
                      <SelectItem key={k} value={k} disabled={!!lock}>
                        {FILING_STAGES[k].label}{lock ? ` (${lock})` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="upload-description">Description <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="upload-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Brief description of this document..."
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={uploading}>Cancel</Button>
          <Button onClick={handleUpload} disabled={uploading || !selectedFile || tooLarge}>
            {uploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
