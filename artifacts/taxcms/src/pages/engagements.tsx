import { useState } from "react";
import { Link } from "wouter";
import {
  useListEngagements, useCreateEngagement, useListClients, useListUsers, useListDocuments,
  useListDeadlines, getListEngagementsQueryKey, getListDocumentsQueryKey,
  getListClientsQueryKey, getListUsersQueryKey, getListDeadlinesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, isStaff } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Search, Briefcase, ExternalLink, User2, Calendar, Paperclip, FileText, Image, Sheet, FileCode } from "lucide-react";
import { format, parseISO } from "date-fns";
import { FileViewer } from "@/components/FileViewer";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

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

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Extract a short form number from a taxType string, e.g. "VAT (2550M)" → "2550M"
function extractFormNumber(taxType: string): string {
  const m = taxType.match(/\(([^)]+)\)/);
  return m ? m[1] : taxType;
}

// ── Per-engagement document panel ────────────────────────────────────────────
function EngagementDocsDialog({
  engagementId, title, open, onClose,
}: { engagementId: number; title: string; open: boolean; onClose: () => void }) {
  const { data: docs, isLoading } = useListDocuments(
    { engagementId },
    { query: { enabled: open, queryKey: getListDocumentsQueryKey({ engagementId }) } }
  );
  type DocItem = NonNullable<typeof docs>[number];
  const [viewerDoc, setViewerDoc] = useState<DocItem | null>(null);

  const byStage: Record<string, typeof docs> = {};
  docs?.forEach(d => {
    const s = (d as any).stage ?? "general";
    if (!byStage[s]) byStage[s] = [];
    byStage[s]!.push(d);
  });

  const STAGE_LABELS: Record<string, string> = {
    source_collection: "Source Collection",
    draft_return: "Draft Tax Return",
    confirmation: "Confirmation Receipt",
    payment: "Payment Confirmation",
    general: "Other Documents",
  };

  return (
    <>
      <Dialog open={open} onOpenChange={v => !v && onClose()}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Paperclip className="h-4 w-4 text-primary" />
              Documents — {title}
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="space-y-2 py-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}
            </div>
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
                      {STAGE_LABELS[stage] ?? stage}
                    </p>
                  )}
                  <div className="space-y-1">
                    {stageDocs?.map(doc => (
                      <button
                        key={doc.id}
                        className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/60 transition-colors text-left group"
                        onClick={() => setViewerDoc(doc as any)}
                      >
                        <FileTypeIcon mimeType={doc.mimeType} name={doc.originalName} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{doc.originalName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {fmtBytes(doc.fileSize)}
                            {doc.uploadedByName && <> · {doc.uploadedByName}</>}
                            {' · '}{format(parseISO(doc.createdAt), 'MMM d, yyyy')}
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
        <FileViewer doc={viewerDoc as any} onClose={() => setViewerDoc(null)} />
      )}
    </>
  );
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-700 border-gray-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-700 border-blue-200" },
  for_review: { label: "For Review", className: "bg-amber-100 text-amber-700 border-amber-200" },
  approved: { label: "Approved", className: "bg-green-100 text-green-700 border-green-200" },
  filed: { label: "Filed", className: "bg-teal-100 text-teal-700 border-teal-200" },
  completed: { label: "Completed", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
};

const TAX_TYPES = [
  "Income Tax (1701)", "Income Tax (1702)", "VAT (2550M)", "VAT (2550Q)",
  "Withholding Tax (1601C)", "Withholding Tax (1601E)", "Withholding Tax (1604E)",
  "Percentage Tax (2551Q)", "Documentary Stamp Tax (2000)",
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

export default function Engagements() {
  const { user } = useAuth();
  const staff = isStaff(user?.role);
  const { data: engagements, isLoading } = useListEngagements();
  // Clients/users/deadlines are only needed for staff actions (create dialog, starting workflows).
  const { data: clients } = useListClients({ query: { enabled: staff, queryKey: getListClientsQueryKey() } });
  const { data: users } = useListUsers({ query: { enabled: staff, queryKey: getListUsersQueryKey() } });
  const { data: deadlines } = useListDeadlines(undefined, { query: { enabled: staff, queryKey: getListDeadlinesQueryKey() } });
  const createEngagement = useCreateEngagement();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [docsEngagement, setDocsEngagement] = useState<{ id: number; title: string } | null>(null);
  const [workflowTarget, setWorkflowTarget] = useState<WorkflowTarget | null>(null);
  const [form, setForm] = useState({
    clientId: "", title: "", taxType: "", period: "", fiscalYear: "", assignedTo: "", dueDate: "", notes: "",
  });

  const filtered = engagements?.filter(e => {
    const matchSearch = e.title.toLowerCase().includes(search.toLowerCase()) ||
      e.taxType.toLowerCase().includes(search.toLowerCase()) ||
      (e.clientName ?? "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || e.status === statusFilter;
    return matchSearch && matchStatus;
  }) ?? [];

  // Find the deadline linked to an engagement (by engagementId foreign key)
  const findDeadlineId = (engagementId: number): number | null => {
    return deadlines?.find(d => (d as any).engagementId === engagementId)?.id ?? null;
  };

  const handleOpenWorkflow = (e: NonNullable<typeof engagements>[number]) => {
    setWorkflowTarget({
      engagementId: e.id,
      deadlineId: findDeadlineId(e.id),
      clientId: e.clientId,
      formNumber: extractFormNumber(e.taxType),
      description: e.title,
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
        queryClient.invalidateQueries({ queryKey: getListEngagementsQueryKey() });
        setOpen(false);
        setForm({ clientId: "", title: "", taxType: "", period: "", fiscalYear: "", assignedTo: "", dueDate: "", notes: "" });
        toast({ title: "Engagement created" });
      },
      onError: () => toast({ title: "Failed to create engagement", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Engagements</h2>
          <p className="text-muted-foreground">Track all tax filing engagements across clients.</p>
        </div>
        {can(user, "editFilings") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />New Engagement</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader><DialogTitle>Create Engagement</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="space-y-1.5">
                  <Label>Client *</Label>
                  <Select value={form.clientId} onValueChange={v => setForm(f => ({ ...f, clientId: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select client" /></SelectTrigger>
                    <SelectContent>
                      {clients?.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Engagement Title *</Label>
                  <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Q1 2025 VAT Return" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Tax Type *</Label>
                    <Select value={form.taxType} onValueChange={v => setForm(f => ({ ...f, taxType: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                      <SelectContent>
                        {TAX_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Period *</Label>
                    <Input value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value }))} placeholder="Q1 2025" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Fiscal Year</Label>
                    <Input value={form.fiscalYear} onChange={e => setForm(f => ({ ...f, fiscalYear: e.target.value }))} placeholder="2025" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Due Date</Label>
                    <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Assign to</Label>
                  <Select value={form.assignedTo} onValueChange={v => setForm(f => ({ ...f, assignedTo: v }))}>
                    <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                    <SelectContent>
                      {users?.filter(u => (u.role as string) === "accountant" || (u.role as string) === "maker").map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Notes</Label>
                  <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes..." rows={2} />
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

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search engagements..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {Object.entries(STATUS_STYLES).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Briefcase className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No engagements found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(e => {
            const st = STATUS_STYLES[e.status] || STATUS_STYLES.pending;
            return (
              <Card
                key={e.id}
                className="hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => handleOpenWorkflow(e)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{e.title}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${st.className}`}>{st.label}</span>
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
                        <span className="font-medium text-foreground/70">{e.clientName}</span>
                        <span>{e.taxType}</span>
                        <span>{e.period}</span>
                        {e.assignedToName && (
                          <span className="flex items-center gap-1"><User2 className="h-3 w-3" />{e.assignedToName}</span>
                        )}
                        {e.dueDate && (
                          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />Due {format(parseISO(e.dueDate), 'MMM d, yyyy')}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-muted-foreground hover:text-primary hover:bg-primary/5 gap-1.5"
                        title="View attached documents"
                        onClick={ev => { ev.preventDefault(); ev.stopPropagation(); setDocsEngagement({ id: e.id, title: e.title }); }}
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        <span className="text-xs">Docs</span>
                      </Button>
                      <Link
                        href={`/engagements/${e.id}`}
                        onClick={ev => ev.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-muted-foreground hover:text-primary hover:bg-primary/5"
                          title="Open detail page"
                          tabIndex={-1}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </Link>
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

      {/* Filing workflow dialog */}
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
          onUpdate={() => queryClient.invalidateQueries({ queryKey: getListEngagementsQueryKey() })}
        />
      )}
    </div>
  );
}
