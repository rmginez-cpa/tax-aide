import { useEffect, useMemo, useRef, useState } from "react";
import { useListDeadlines, useCreateDeadline, useUpdateDeadline, useDeleteDeadline } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Search, Calendar, CheckCircle2, AlertTriangle, Clock, Trash2, Check, GitBranch } from "lucide-react";
import { isOverdue } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { getDeadlinePriority, getDeadlineUrgency, type DeadlineUrgency } from "@/lib/status";
import { can } from "@/lib/permissions";
import { errorMessage } from "@/lib/api";
import { invalidateFilingData } from "@/lib/queries";
import { workflowTargetFromDeadline, type WorkflowTarget } from "@/lib/workflow";
import { useUrlFilterState } from "@/hooks/use-url-filter-state";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["all", "upcoming", "overdue", "completed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const URGENCY_ICON: Record<DeadlineUrgency, typeof Clock> = {
  completed: CheckCircle2,
  overdue: AlertTriangle,
  due_soon: AlertTriangle,
  upcoming: Clock,
};

const EMPTY_FORM = { title: "", description: "", dueDate: "", priority: "medium" as "high" | "medium" | "low" };

/** Status bucket used by the filter and the summary cards (dates in Manila). */
function statusBucket(d: { dueDate: string; status: string }): Exclude<StatusFilter, "all"> {
  if (d.status === "completed") return "completed";
  return isOverdue(d.dueDate, d.status) ? "overdue" : "upcoming";
}

export default function Deadlines() {
  const { user } = useAuth();
  const { data: deadlines, isLoading, isError, error, refetch } = useListDeadlines();
  const createDeadline = useCreateDeadline();
  const updateDeadline = useUpdateDeadline();
  const deleteDeadline = useDeleteDeadline();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const [filters, setFilters] = useUrlFilterState({ status: "all", client: "", q: "", highlight: "" });
  const statusFilter: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(filters.status)
    ? (filters.status as StatusFilter)
    : "all";
  const highlightId = /^\d+$/.test(filters.highlight) ? Number(filters.highlight) : null;

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [workflowDeadline, setWorkflowDeadline] = useState<WorkflowTarget | null>(null);

  // Clients that have deadlines, for the client filter.
  const clientOptions = useMemo(() => {
    const map = new Map<number, string>();
    let hasUnassigned = false;
    for (const d of deadlines ?? []) {
      if (d.clientId) map.set(d.clientId, d.clientName || `Client #${d.clientId}`);
      else hasUnassigned = true;
    }
    return {
      clients: [...map.entries()].sort((a, b) => a[1].localeCompare(b[1])),
      hasUnassigned,
    };
  }, [deadlines]);

  const search = filters.q.trim().toLowerCase();
  const filtered = useMemo(() => (deadlines ?? []).filter(d => {
    if (search && !d.title.toLowerCase().includes(search) && !(d.clientName ?? "").toLowerCase().includes(search)) return false;
    if (filters.client === "none" ? d.clientId != null : filters.client && String(d.clientId ?? "") !== filters.client) return false;
    return statusFilter === "all" || statusBucket(d) === statusFilter;
  }), [deadlines, search, filters.client, statusFilter]);

  // ?highlight=<id> (notification links): make sure the row is visible, then scroll to it.
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const scrolledFor = useRef<number | null>(null);
  useEffect(() => {
    if (highlightId == null || !deadlines || scrolledFor.current === highlightId) return;
    const target = deadlines.find(d => d.id === highlightId);
    if (!target) return;
    if (!filtered.some(d => d.id === highlightId)) {
      // The current filters hide it: show everything so the linked deadline appears.
      setFilters({ status: "all", client: "", q: "" });
      return;
    }
    const el = rowRefs.current.get(highlightId);
    if (!el) return;
    scrolledFor.current = highlightId;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [highlightId, deadlines, filtered, setFilters]);

  const counts = useMemo(() => {
    const c = { overdue: 0, upcoming: 0, completed: 0 };
    for (const d of deadlines ?? []) c[statusBucket(d)]++;
    return c;
  }, [deadlines]);

  const refresh = () => invalidateFilingData(queryClient);

  const handleCreate = () => {
    if (!form.title.trim() || !form.dueDate) {
      toast({ title: "Title and due date required", variant: "destructive" });
      return;
    }
    createDeadline.mutate({ data: { ...form, title: form.title.trim(), description: form.description || null, engagementId: null, clientId: null } }, {
      onSuccess: () => {
        refresh();
        setOpen(false);
        setForm(EMPTY_FORM);
        toast({ title: "Deadline created" });
      },
      onError: (e) => toast({ title: "Failed to create deadline", description: errorMessage(e), variant: "destructive" }),
    });
  };

  const handleMarkDone = (id: number) => {
    updateDeadline.mutate({ id, data: { status: "completed" } }, {
      onSuccess: () => {
        refresh();
        toast({ title: "Deadline marked as completed" });
      },
      onError: (e) => toast({ title: "Failed to update", description: errorMessage(e), variant: "destructive" }),
    });
  };

  const handleDelete = async (id: number, title: string) => {
    const deleted = await confirm({
      title: "Delete this deadline?",
      description: `"${title}" will be removed permanently. Filings linked to it are kept.`,
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () => deleteDeadline.mutateAsync({ id }),
    });
    if (!deleted) return;
    if (highlightId === id) setFilters({ highlight: "" });
    await refresh();
    toast({ title: "Deadline deleted" });
  };

  const openWorkflow = (d: (typeof filtered)[number]) => {
    const target = workflowTargetFromDeadline(d);
    if (target) setWorkflowDeadline(target);
  };

  const filtersActive = statusFilter !== "all" || !!filters.client || !!filters.q;
  const summaryCards: Array<{ key: Exclude<StatusFilter, "all">; label: string; value: number; className: string }> = [
    { key: "overdue", label: "Overdue", value: counts.overdue, className: "text-red-600" },
    { key: "upcoming", label: "Upcoming", value: counts.upcoming, className: "text-amber-600" },
    { key: "completed", label: "Completed", value: counts.completed, className: "text-emerald-600" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight">Deadlines</h2>
          <p className="text-muted-foreground">Track all BIR filing deadlines across engagements.</p>
        </div>
        {can(user, "manageDeadlines") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />Add Deadline</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create Deadline</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="deadline-title">Title *</Label>
                  <Input id="deadline-title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Q2 VAT Filing (2550Q)" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="deadline-description">Description</Label>
                  <Textarea id="deadline-description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional details..." rows={2} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="deadline-due">Due Date *</Label>
                    <Input id="deadline-due" type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Priority</Label>
                    <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as typeof f.priority }))}>
                      <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="low">Low</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={createDeadline.isPending}>Create</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {summaryCards.map(c => (
          <button
            key={c.key}
            type="button"
            aria-pressed={statusFilter === c.key}
            onClick={() => setFilters({ status: statusFilter === c.key ? "all" : c.key })}
            className="text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className={cn("h-full transition-colors hover:border-primary/40", statusFilter === c.key && "border-primary/60 bg-primary/5")}>
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={cn("text-2xl font-bold", c.className)}>{c.value}</p>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search deadlines..."
            aria-label="Search deadlines"
            value={filters.q}
            onChange={e => setFilters({ q: e.target.value })}
          />
        </div>
        <Select value={filters.client || "all"} onValueChange={v => setFilters({ client: v === "all" ? "" : v })}>
          <SelectTrigger className="w-full sm:w-48" aria-label="Filter by client"><SelectValue placeholder="All clients" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {clientOptions.hasUnassigned && <SelectItem value="none">No client (firm)</SelectItem>}
            {clientOptions.clients.map(([id, name]) => (
              <SelectItem key={id} value={String(id)}>{name}</SelectItem>
            ))}
            {filters.client && filters.client !== "none" && !clientOptions.clients.some(([id]) => String(id) === filters.client) && (
              <SelectItem value={filters.client}>Client #{filters.client}</SelectItem>
            )}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={v => setFilters({ status: v })}>
          <SelectTrigger className="w-full sm:w-40" aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="upcoming">Upcoming</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : isError ? (
        <ErrorState title="Could not load deadlines" error={error} onRetry={refetch} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Calendar className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No deadlines found</p>
            {filtersActive && (
              <Button variant="link" className="mt-1" onClick={() => setFilters({ status: "all", client: "", q: "" })}>
                Clear filters
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(d => {
            const urgency = getDeadlineUrgency(d.dueDate, d.status);
            const StatusIcon = URGENCY_ICON[urgency.urgency];
            const priority = getDeadlinePriority(d.priority);
            const hasWorkflow = !!d.clientId;
            const highlighted = d.id === highlightId;
            const body = (
              <>
                <StatusIcon className={cn("h-5 w-5 shrink-0", urgency.className)} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={cn("font-medium text-sm break-words min-w-0", d.status === "completed" && "line-through text-muted-foreground")}>{d.title}</p>
                    <span className={cn("text-xs px-2 py-0.5 rounded-full border font-medium", priority.className)}>
                      {priority.label}
                    </span>
                    {hasWorkflow && (
                      <span className="text-xs text-primary flex items-center gap-1">
                        <GitBranch className="h-3 w-3" aria-hidden="true" /> Workflow
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
                    <span>{formatDate(d.dueDate, "long")}</span>
                    {d.clientName && <span className="font-medium">{d.clientName}</span>}
                    {d.description && <span className="truncate max-w-full sm:max-w-xs">{d.description}</span>}
                  </div>
                </div>
                <span className={cn("text-xs font-semibold shrink-0", urgency.className)}>{urgency.label}</span>
              </>
            );
            return (
              <Card
                key={d.id}
                ref={el => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                tabIndex={highlighted ? -1 : undefined}
                data-deadline-id={d.id}
                data-highlighted={highlighted || undefined}
                className={cn(
                  "transition-colors outline-none",
                  d.status === "completed" && !highlighted && "opacity-70",
                  hasWorkflow && "hover:border-primary/40",
                  highlighted && "ring-2 ring-primary border-primary bg-primary/5",
                )}
              >
                <CardContent className="p-0">
                  <div className="flex items-center gap-2 pr-3">
                    {hasWorkflow ? (
                      <button
                        type="button"
                        onClick={() => openWorkflow(d)}
                        aria-label={`Open filing workflow: ${d.title}${d.clientName ? `, ${d.clientName}` : ""}`}
                        className="flex flex-1 min-w-0 items-center gap-3 sm:gap-4 p-4 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex flex-1 min-w-0 items-center gap-3 sm:gap-4 p-4">{body}</div>
                    )}
                    {can(user, "manageDeadlines") && d.status !== "completed" && !hasWorkflow && !d.engagementId && (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                        aria-label={`Mark "${d.title}" as completed`}
                        title="Mark as completed"
                        disabled={updateDeadline.isPending}
                        onClick={() => handleMarkDone(d.id)}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                    {can(user, "deleteDeadlines") && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete deadline "${d.title}"`}
                        title="Delete deadline"
                        onClick={() => handleDelete(d.id, d.title)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Filing Workflow Dialog — opens when clicking a client-linked deadline */}
      {workflowDeadline && (
        <FilingWorkflowDialog
          open={!!workflowDeadline}
          onClose={() => setWorkflowDeadline(null)}
          deadlineId={workflowDeadline.deadlineId}
          engagementId={workflowDeadline.engagementId}
          clientId={workflowDeadline.clientId}
          formNumber={workflowDeadline.formNumber}
          description={workflowDeadline.description}
          period={workflowDeadline.period}
          dueDate={workflowDeadline.dueDate}
          onUpdate={refresh}
        />
      )}
    </div>
  );
}
