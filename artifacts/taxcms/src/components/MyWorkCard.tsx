// Dashboard "Needs my action" card (GET /api/dashboard/my-work), role-aware:
// managers see filing stages awaiting review, makers their open filings and
// deadlines due in the next 14 days, clients their open deadlines and filings in progress.

import { useQuery } from "@tanstack/react-query";
import type { MyWork, MyWorkDeadline, MyWorkFiling } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ChevronRight, ClipboardCheck, Inbox } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { apiFetch } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { FILING_STAGES, getEngagementStatus, getDeadlineUrgency, type FilingStageKey } from "@/lib/status";
import { cn } from "@/lib/utils";

export type { MyWork, MyWorkDeadline, MyWorkFiling } from "@workspace/api-client-react";

/** Starts with "/api/dashboard", so invalidateFilingData() refreshes it after filing mutations. */
export const MY_WORK_QUERY_KEY = ["/api/dashboard/my-work"] as const;

export function useMyWork() {
  return useQuery({
    queryKey: MY_WORK_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<MyWork>("/dashboard/my-work", { signal }),
  });
}

const DESCRIPTIONS: Record<MyWork["kind"], string> = {
  review: "Filing stages waiting for your review, oldest first.",
  maker: "Your open filings by due date, and your deadlines in the next 14 days.",
  client: "Your open deadlines and the filings in progress.",
};

const ROW_CLASS =
  "flex items-center gap-3 rounded-md px-2 py-2 -mx-2 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function DueText({ dueDate, overdue }: { dueDate: string | null; overdue?: boolean }) {
  if (!dueDate) return <span className="text-xs text-muted-foreground">No due date</span>;
  const u = getDeadlineUrgency(dueDate);
  return (
    <span className="text-right">
      <span className={cn("block text-xs font-semibold", overdue ? "text-red-600" : u.className)}>
        {overdue ? "Overdue" : u.label}
      </span>
      <span className="block text-xs text-muted-foreground">{formatDate(dueDate)}</span>
    </span>
  );
}

function FilingRow({ f, kind }: { f: MyWorkFiling; kind: MyWork["kind"] }) {
  const status = getEngagementStatus(f.status);
  return (
    <li>
      <Link
        href={`/engagements/${f.id}`}
        className={cn(ROW_CLASS, f.overdue && kind !== "review" && "border-l-2 border-red-500 pl-3 bg-red-50/60 dark:bg-red-950/20")}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug break-words">{f.title}</p>
          <p className="text-xs text-muted-foreground truncate">
            {[f.clientName, f.taxType].filter(Boolean).join(" · ")}
          </p>
          <div className="flex flex-wrap gap-1">
            {kind === "review"
              ? f.stagesForReview.map((s) => {
                  const stage = FILING_STAGES[s as FilingStageKey];
                  return (
                    <span key={s} className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", stage?.className ?? "bg-muted")}>
                      {stage?.label ?? s}
                    </span>
                  );
                })
              : <Badge variant="outline" className={cn("text-[11px] px-1.5 py-0", status.className)}>{status.label}</Badge>}
          </div>
          {kind === "review" && (
            <p className="text-[11px] text-muted-foreground">Waiting since {formatDate(f.waitingSince)}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <DueText dueDate={f.dueDate} overdue={f.overdue} />
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </Link>
    </li>
  );
}

function DeadlineRow({ d }: { d: MyWorkDeadline }) {
  const body = (
    <>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium leading-snug break-words">{d.title}</p>
        {d.clientName && <p className="text-xs text-muted-foreground truncate">{d.clientName}</p>}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <DueText dueDate={d.dueDate} overdue={d.overdue} />
        {d.engagementId != null && <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      </div>
    </>
  );
  const highlight = d.overdue && "border-l-2 border-red-500 pl-3 bg-red-50/60 dark:bg-red-950/20";
  return (
    <li>
      {d.engagementId != null ? (
        <Link href={`/engagements/${d.engagementId}`} className={cn(ROW_CLASS, highlight)}>{body}</Link>
      ) : (
        <div className={cn("flex items-center gap-3 px-2 py-2 -mx-2 rounded-md", highlight)}>{body}</div>
      )}
    </li>
  );
}

function Section({
  title, empty, total, shown, moreHref, children,
}: {
  title?: string; empty: string; total: number; shown: number; moreHref?: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-1" aria-label={title}>
      {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>}
      {shown === 0 ? (
        <p className="py-3 text-sm text-muted-foreground flex items-center gap-2">
          <Inbox className="h-4 w-4 opacity-60" aria-hidden="true" />
          {empty}
        </p>
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
      {total > shown && moreHref && (
        <Link href={moreHref} className="inline-block text-xs font-medium text-primary hover:underline pt-1">
          and {total - shown} more
        </Link>
      )}
    </section>
  );
}

export function MyWorkCard() {
  const { data, isLoading, isError, error, refetch } = useMyWork();
  const kind = data?.kind;
  const count = data ? data.totals.filings + data.totals.deadlines : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
              Needs my action
            </CardTitle>
            <CardDescription className="mt-1.5">{kind ? DESCRIPTIONS[kind] : "Items waiting for you."}</CardDescription>
          </div>
          {data && count > 0 && (
            <Badge variant="secondary" className="shrink-0" aria-label={`${count} items`}>{count}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : isError ? (
          <ErrorState compact error={error} onRetry={refetch} title="Could not load your work" />
        ) : !data ? null : data.kind === "review" ? (
          <Section empty="Nothing is waiting for your review." total={data.totals.filings} shown={data.filings.length} moreHref="/engagements?review=1">
            {data.filings.map((f) => <FilingRow key={f.id} f={f} kind="review" />)}
          </Section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {data.kind === "maker" ? (
              <>
                <Section title="My open filings" empty="No open filings assigned to you." total={data.totals.filings} shown={data.filings.length} moreHref="/engagements?mine=1">
                  {data.filings.map((f) => <FilingRow key={f.id} f={f} kind="maker" />)}
                </Section>
                <Section title={`My deadlines (next ${data.windowDays ?? 14} days)`} empty="No deadlines due in the next two weeks." total={data.totals.deadlines} shown={data.deadlines.length} moreHref="/deadlines">
                  {data.deadlines.map((d) => <DeadlineRow key={d.id} d={d} />)}
                </Section>
              </>
            ) : (
              <>
                <Section title="Open deadlines" empty="No open deadlines." total={data.totals.deadlines} shown={data.deadlines.length}>
                  {data.deadlines.map((d) => <DeadlineRow key={d.id} d={d} />)}
                </Section>
                <Section title="Filings in progress" empty="No filings in progress." total={data.totals.filings} shown={data.filings.length} moreHref="/engagements">
                  {data.filings.map((f) => <FilingRow key={f.id} f={f} kind="client" />)}
                </Section>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
