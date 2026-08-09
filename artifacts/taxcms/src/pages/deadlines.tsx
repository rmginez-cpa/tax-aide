import { useState } from "react";
import {
  useListDeadlines, useCreateDeadline, useUpdateDeadline, useDeleteDeadline,
  getListDeadlinesQueryKey
} from "@workspace/api-client-react";
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
import { format, parseISO, isPast, isToday, differenceInDays } from "date-fns";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

const PRIORITY_STYLES = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

export default function Deadlines() {
  const { user } = useAuth();
  const { data: deadlines, isLoading } = useListDeadlines();
  const createDeadline = useCreateDeadline();
  const updateDeadline = useUpdateDeadline();
  const deleteDeadline = useDeleteDeadline();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", dueDate: "", priority: "medium" as const });
  const [workflowDeadline, setWorkflowDeadline] = useState<{
    deadlineId: number;
    engagementId: number | null;
    clientId: number | null;
    formNumber: string;
    description: string;
    period: string;
    dueDate: string;
  } | null>(null);

  const openWorkflow = (d: typeof filtered[0]) => {
    if (!d.clientId) return;
    const formMatch = d.title.match(/(\d{4}[A-Z]?(?:EZ)?)\b/);
    setWorkflowDeadline({
      deadlineId: d.id,
      engagementId: d.engagementId ?? null,
      clientId: d.clientId,
      formNumber: formMatch ? `BIR Form ${formMatch[1]}` : d.title,
      description: d.clientName ? `${d.clientName}` : d.description ?? "",
      period: d.description ?? "",
      dueDate: d.dueDate,
    });
  };

  const filtered = deadlines?.filter(d => {
    const matchSearch = d.title.toLowerCase().includes(search.toLowerCase()) || (d.clientName ?? "").toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;
    if (filter === "overdue") return isPast(parseISO(d.dueDate)) && d.status === "pending";
    if (filter === "upcoming") return !isPast(parseISO(d.dueDate)) && d.status === "pending";
    if (filter === "completed") return d.status === "completed";
    return true;
  }) ?? [];

  const handleCreate = () => {
    if (!form.title || !form.dueDate) {
      toast({ title: "Title and due date required", variant: "destructive" });
      return;
    }
    createDeadline.mutate({ data: { ...form, description: form.description || null, engagementId: null, clientId: null } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDeadlinesQueryKey() });
        setOpen(false);
        setForm({ title: "", description: "", dueDate: "", priority: "medium" });
        toast({ title: "Deadline created" });
      },
      onError: () => toast({ title: "Failed to create deadline", variant: "destructive" }),
    });
  };

  const handleMarkDone = (id: number) => {
    updateDeadline.mutate({ id, data: { status: "completed" } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDeadlinesQueryKey() });
        toast({ title: "Deadline marked as completed" });
      },
      onError: () => toast({ title: "Failed to update", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number, title: string) => {
    if (!confirm(`Delete "${title}"?`)) return;
    deleteDeadline.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDeadlinesQueryKey() });
        toast({ title: "Deadline deleted" });
      },
      onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
    });
  };

  const getDeadlineStatus = (d: typeof filtered[0]) => {
    if (d.status === "completed") return { label: "Completed", icon: CheckCircle2, className: "text-emerald-600" };
    if (isPast(parseISO(d.dueDate)) && !isToday(parseISO(d.dueDate))) return { label: "Overdue", icon: AlertTriangle, className: "text-red-600" };
    const days = differenceInDays(parseISO(d.dueDate), new Date());
    if (days <= 3) return { label: `${days}d left`, icon: AlertTriangle, className: "text-amber-600" };
    return { label: `${days}d left`, icon: Clock, className: "text-muted-foreground" };
  };

  const pending = deadlines?.filter(d => d.status === "pending" && isPast(parseISO(d.dueDate))).length ?? 0;
  const upcoming = deadlines?.filter(d => d.status === "pending" && !isPast(parseISO(d.dueDate))).length ?? 0;
  const completed = deadlines?.filter(d => d.status === "completed").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Deadlines</h2>
          <p className="text-muted-foreground">Track all BIR filing deadlines across engagements.</p>
        </div>
        {user?.role !== "viewer" && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />Add Deadline</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create Deadline</DialogTitle></DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="space-y-1.5">
                  <Label>Title *</Label>
                  <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Q2 VAT Filing (2550Q)" />
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional details..." rows={2} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Due Date *</Label>
                    <Input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Priority</Label>
                    <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as any }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
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

      <div className="grid grid-cols-3 gap-4">
        <Card className="cursor-pointer" onClick={() => setFilter("overdue")}>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Overdue</p>
            <p className="text-2xl font-bold text-red-600">{pending}</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer" onClick={() => setFilter("upcoming")}>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Upcoming</p>
            <p className="text-2xl font-bold text-amber-600">{upcoming}</p>
          </CardContent>
        </Card>
        <Card className="cursor-pointer" onClick={() => setFilter("completed")}>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Completed</p>
            <p className="text-2xl font-bold text-emerald-600">{completed}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search deadlines..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="upcoming">Upcoming</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Calendar className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No deadlines found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(d => {
            const status = getDeadlineStatus(d);
            const StatusIcon = status.icon;
            const hasWorkflow = !!d.clientId;
            return (
              <Card key={d.id} className={`transition-colors ${d.status === "completed" ? "opacity-70" : ""} ${hasWorkflow ? "hover:border-primary/40 cursor-pointer" : ""}`}
                onClick={hasWorkflow ? () => openWorkflow(d) : undefined}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <StatusIcon className={`h-5 w-5 shrink-0 ${status.className}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`font-medium text-sm ${d.status === "completed" ? "line-through text-muted-foreground" : ""}`}>{d.title}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${PRIORITY_STYLES[d.priority as keyof typeof PRIORITY_STYLES]}`}>
                          {d.priority}
                        </span>
                        {hasWorkflow && (
                          <span className="text-xs text-primary flex items-center gap-1">
                            <GitBranch className="h-3 w-3" /> Workflow
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                        <span>{format(parseISO(d.dueDate), 'MMMM d, yyyy')}</span>
                        {d.clientName && <span className="font-medium">{d.clientName}</span>}
                        {d.description && <span className="truncate max-w-xs">{d.description}</span>}
                      </div>
                    </div>
                    <span className={`text-xs font-semibold ${status.className}`}>{status.label}</span>
                    {user?.role !== "viewer" && d.status !== "completed" && !hasWorkflow && (
                      <Button variant="outline" size="icon" className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                        onClick={e => { e.stopPropagation(); handleMarkDone(d.id); }}>
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                    {user?.role === "manager" && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={e => { e.stopPropagation(); handleDelete(d.id, d.title); }}>
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
          clientId={workflowDeadline.clientId!}
          formNumber={workflowDeadline.formNumber}
          description={workflowDeadline.description}
          period={workflowDeadline.period}
          dueDate={workflowDeadline.dueDate}
          onUpdate={() => queryClient.invalidateQueries({ queryKey: getListDeadlinesQueryKey() })}
        />
      )}
    </div>
  );
}
