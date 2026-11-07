import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditLog as AuditLogEntry } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination";
import { ErrorState } from "@/components/ErrorState";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, errorMessage, saveBlob } from "@/lib/api";
import { formatDateTime, manilaToday } from "@/lib/format";
import { humanize } from "@/lib/status";
import { invalidatePrefixes } from "@/lib/queries";
import { Activity, ChevronLeft, ChevronRight, Download, Loader2, Search, User2, X } from "lucide-react";

// Audit-specific pill colours (actions are free-form strings written by the server).
const ACTION_STYLES: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-blue-100 text-blue-700",
  delete: "bg-red-100 text-red-700",
  upload: "bg-violet-100 text-violet-700",
  comment: "bg-amber-100 text-amber-700",
  approve: "bg-teal-100 text-teal-700",
  reject: "bg-orange-100 text-orange-700",
  login: "bg-gray-100 text-gray-700",
  export: "bg-sky-100 text-sky-700",
};

const ENTITY_LABELS: Record<string, string> = {
  user: "User",
  client: "Client",
  engagement: "Engagement",
  deadline: "Deadline",
  checklist_item: "Checklist",
  document: "Document",
  comment: "Comment",
  assistant: "Assistant",
  audit_log: "Audit Log",
};

const entityLabel = (t: string) => ENTITY_LABELS[t] || humanize(t);

const PAGE_SIZE = 50;
const ALL = "all";
/** URL query keys that filter the list (page is separate). */
const FILTER_KEYS = ["userId", "action", "entityType", "from", "to", "q"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

interface AuditFacets {
  users: { id: number; name: string }[];
  actions: string[];
  entityTypes: string[];
}

interface AuditPage {
  rows: AuditLogEntry[];
  total: number;
}

function readFilters(search: string): { filters: Filters; page: number } {
  const sp = new URLSearchParams(search);
  const filters: Filters = {};
  for (const k of FILTER_KEYS) {
    const v = sp.get(k)?.trim();
    if (v) filters[k] = v;
  }
  const page = Math.max(1, Math.floor(Number(sp.get("page")) || 1));
  return { filters, page };
}

function filterParams(filters: Filters): URLSearchParams {
  const sp = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) sp.set(k, filters[k]!);
  return sp;
}

/** Saved file name from a Content-Disposition header, if it carries one. */
function dispositionFilename(header: string | null): string | null {
  const m = header?.match(/filename="?([^";]+)"?/i);
  return m ? m[1] : null;
}

export default function AuditLog() {
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { filters, page } = useMemo(() => readFilters(search), [search]);
  const [exporting, setExporting] = useState(false);

  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // Search box: typed text is pushed to the URL after a short pause; URL changes
  // made elsewhere (back button, Clear filters) flow back into the box.
  const [qInput, setQInput] = useState(filters.q ?? "");
  useEffect(() => {
    setQInput(prev => (prev.trim() === (filters.q ?? "") ? prev : filters.q ?? ""));
  }, [filters.q]);

  const navigate = (next: Filters, nextPage = 1) => {
    const sp = filterParams(next);
    if (nextPage > 1) sp.set("page", String(nextPage));
    const qs = sp.toString();
    setLocation(qs ? `${location}?${qs}` : location, { replace: true });
  };
  const setFilter = (key: FilterKey, value: string | undefined) => {
    navigate({ ...filters, [key]: value && value !== ALL ? value : undefined });
  };

  useEffect(() => {
    const typed = qInput.trim();
    if (typed === (filters.q ?? "")) return;
    const t = setTimeout(() => navigate({ ...filtersRef.current, q: typed || undefined }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const listParams = filterParams(filters);
  listParams.set("limit", String(PAGE_SIZE));
  listParams.set("offset", String((page - 1) * PAGE_SIZE));
  const listQs = listParams.toString();

  const { data, isLoading, isError, error, refetch, isFetching, isPlaceholderData } = useQuery<AuditPage>({
    queryKey: ["/api/audit-logs", "page", listQs],
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Response>(`/audit-logs?${listQs}`, { responseType: "response", signal });
      const rows = (await res.json()) as AuditLogEntry[];
      const total = Number(res.headers.get("X-Total-Count") ?? rows.length);
      return { rows, total: Number.isFinite(total) ? total : rows.length };
    },
    placeholderData: keepPreviousData,
  });

  const { data: facets } = useQuery<AuditFacets>({
    queryKey: ["/api/audit-logs/filters"],
    queryFn: ({ signal }) => apiFetch<AuditFacets>("/audit-logs/filters", { signal }),
    staleTime: 60_000,
  });

  const logs = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(total, (page - 1) * PAGE_SIZE + logs.length);
  const hasFilters = FILTER_KEYS.some(k => filters[k]);

  // A page past the end (e.g. after narrowing the filters): jump to the last page.
  useEffect(() => {
    if (data && !isPlaceholderData && page > 1 && data.rows.length === 0 && total > 0) navigate(filters, pageCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, isPlaceholderData, page, total, pageCount]);

  // Options: what the log contains, plus the current URL value if it is not among them.
  const withCurrent = (values: string[] | undefined, current: string | undefined) => {
    const list = [...(values ?? [])];
    if (current && !list.includes(current)) list.unshift(current);
    return list;
  };
  const actionOptions = withCurrent(facets?.actions, filters.action);
  const entityOptions = withCurrent(facets?.entityTypes, filters.entityType);
  const userOptions = [...(facets?.users ?? [])];
  if (filters.userId && !userOptions.some(u => String(u.id) === filters.userId)) {
    userOptions.unshift({ id: Number(filters.userId), name: `User #${filters.userId}` });
  }

  const handleExport = async () => {
    setExporting(true);
    try {
      const qs = filterParams(filters).toString();
      const res = await apiFetch<Response>(`/audit-logs/export.csv${qs ? `?${qs}` : ""}`, { responseType: "response" });
      const blob = await res.blob();
      const filename = dispositionFilename(res.headers.get("Content-Disposition")) ?? `audit-log-${manilaToday()}.csv`;
      saveBlob(blob, filename);
      const exportedTotal = Number(res.headers.get("X-Total-Count") ?? 0);
      if (res.headers.get("X-Export-Truncated") === "true") {
        toast({
          title: "Export limited to 10,000 entries",
          description: `${exportedTotal.toLocaleString()} entries match. Narrow the date range to export the rest.`,
        });
      } else {
        toast({ title: "Audit log exported", description: `${exportedTotal.toLocaleString()} entr${exportedTotal === 1 ? "y" : "ies"}.` });
      }
      // The export itself is audited, so refresh the list and the filter options.
      void invalidatePrefixes(queryClient, ["/api/audit-logs"]);
    } catch (err) {
      toast({ title: "Export failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Audit Trail</h2>
          <p className="text-muted-foreground">Complete log of all actions taken in the system.</p>
        </div>
        <Button variant="outline" onClick={handleExport} disabled={exporting} className="self-start sm:self-auto">
          {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
          Export CSV
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7">
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3 xl:col-span-2">
              <Label htmlFor="audit-q" className="text-xs">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="audit-q"
                  className="pl-9"
                  placeholder="Search descriptions..."
                  value={qInput}
                  maxLength={200}
                  onChange={e => setQInput(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="audit-user" className="text-xs">User</Label>
              <Select value={filters.userId ?? ALL} onValueChange={v => setFilter("userId", v)}>
                <SelectTrigger id="audit-user"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All users</SelectItem>
                  {userOptions.map(u => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="audit-action" className="text-xs">Action</Label>
              <Select value={filters.action ?? ALL} onValueChange={v => setFilter("action", v)}>
                <SelectTrigger id="audit-action"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All actions</SelectItem>
                  {actionOptions.map(a => <SelectItem key={a} value={a}>{humanize(a)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="audit-entity" className="text-xs">Entity type</Label>
              <Select value={filters.entityType ?? ALL} onValueChange={v => setFilter("entityType", v)}>
                <SelectTrigger id="audit-entity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {entityOptions.map(t => <SelectItem key={t} value={t}>{entityLabel(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-2">
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="audit-from" className="text-xs">From</Label>
                <Input
                  id="audit-from"
                  type="date"
                  value={filters.from ?? ""}
                  max={filters.to}
                  onChange={e => setFilter("from", e.target.value || undefined)}
                />
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="audit-to" className="text-xs">To</Label>
                <Input
                  id="audit-to"
                  type="date"
                  value={filters.to ?? ""}
                  min={filters.from}
                  onChange={e => setFilter("to", e.target.value || undefined)}
                />
              </div>
            </div>
          </div>
          {hasFilters && (
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => { setQInput(""); navigate({}); }}>
                <X className="h-4 w-4 mr-1" />Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
            <Activity className="h-4 w-4" />
            Activity Log
            {data && (
              <span className="text-xs font-normal text-muted-foreground">
                {total === 0 ? "0 entries" : `${firstRow.toLocaleString()}–${lastRow.toLocaleString()} of ${total.toLocaleString()}`}
              </span>
            )}
            {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : isError ? (
            <ErrorState error={error} onRetry={refetch} />
          ) : logs.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>{hasFilters ? "No audit logs match these filters." : "No audit logs yet."}</p>
            </div>
          ) : (
            <div className="space-y-1">
              {logs.map((log, idx) => {
                const actionStyle = ACTION_STYLES[log.action] || "bg-gray-100 text-gray-700";
                const when = formatDateTime(log.createdAt);
                return (
                  <div key={log.id} className={`flex items-start gap-4 py-3 ${idx < logs.length - 1 ? "border-b" : ""}`}>
                    <div className="text-xs shrink-0 text-muted-foreground w-32 mt-0.5 text-right hidden sm:block">
                      <time dateTime={log.createdAt}>{when}</time>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {log.userName && (
                          <span className="text-sm font-medium flex items-center gap-1">
                            <User2 className="h-3 w-3" />{log.userName}
                          </span>
                        )}
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionStyle}`}>{log.action}</span>
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          {entityLabel(log.entityType)}
                          {log.entityId != null ? ` #${log.entityId}` : ""}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5 break-words">{log.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 sm:hidden"><time dateTime={log.createdAt}>{when}</time></p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isError && total > PAGE_SIZE && (
            <Pagination className="mt-4 border-t pt-4">
              <PaginationContent className="w-full justify-between sm:justify-center sm:gap-3">
                <PaginationItem>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(filters, page - 1)}
                    disabled={page <= 1}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />Previous
                  </Button>
                </PaginationItem>
                <PaginationItem className="text-sm text-muted-foreground" aria-current="page">
                  Page {page} of {pageCount}
                </PaginationItem>
                <PaginationItem>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate(filters, page + 1)}
                    disabled={page >= pageCount}
                    aria-label="Next page"
                  >
                    Next<ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
