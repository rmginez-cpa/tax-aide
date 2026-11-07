import { useMemo, useRef, useState } from "react";
import { useListDeadlines } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isValid,
} from "date-fns";
import { manilaToday } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { DEADLINE_DOT_CLASS, DEADLINE_PILL_CLASS, deadlineColorKey, getDeadlineUrgency } from "@/lib/status";
import { invalidateFilingData } from "@/lib/queries";
import { workflowTargetFromDeadline, type WorkflowTarget } from "@/lib/workflow";
import { useUrlFilterState } from "@/hooks/use-url-filter-state";
import { ChevronLeft, ChevronRight, CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { cn } from "@/lib/utils";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Pills shown in a day cell before "+N more". */
const MAX_PILLS = 3;

type DeadlineItem = {
  id: number;
  title: string;
  dueDate: string;
  status: string;
  priority: string;
  clientId?: number | null;
  clientName?: string | null;
  engagementId?: number | null;
  description?: string | null;
};

const LEGEND: Array<{ key: keyof typeof DEADLINE_DOT_CLASS; label: string }> = [
  { key: "overdue", label: "Overdue" },
  { key: "high", label: "High priority" },
  { key: "upcoming", label: "Upcoming" },
  { key: "completed", label: "Completed" },
];

/** "2026-11" -> first day of that month (local midnight); null when malformed. */
function parseMonth(value: string): Date | null {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const d = parseISO(`${value}-01`);
  return isValid(d) ? d : null;
}

/** Screen-reader description of one deadline. */
function describeDeadline(d: DeadlineItem): string {
  const urgency = getDeadlineUrgency(d.dueDate, d.status).label;
  const parts = [d.title, d.clientName, urgency, d.priority === "high" && d.status !== "completed" ? "high priority" : null];
  const action = d.clientId ? "open filing workflow" : "show in list";
  return `${parts.filter(Boolean).join(", ")}. ${action}`;
}

export default function CalendarPage() {
  const { data: deadlines, isLoading, isError, error, refetch } = useListDeadlines();
  const queryClient = useQueryClient();

  // Month and selected day live in the URL (?month=2026-11&day=2026-11-07).
  const today = manilaToday();
  const [filters, setFilters] = useUrlFilterState({ month: today.slice(0, 7), day: "" });
  const currentMonth = parseMonth(filters.month) ?? parseMonth(today.slice(0, 7))!;
  const monthKey = format(currentMonth, "yyyy-MM");
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(filters.day) && filters.day.startsWith(monthKey) ? filters.day : "";

  const [workflowDeadline, setWorkflowDeadline] = useState<WorkflowTarget | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const goToMonth = (month: Date) => setFilters({ month: format(month, "yyyy-MM"), day: "" });

  // Build the calendar grid — from the first Sunday on/before month start
  // to the last Saturday on/after month end
  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 0 });
    const gridEnd = endOfWeek(endOfMonth(currentMonth), { weekStartsOn: 0 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentMonth is derived from monthKey
  }, [monthKey]);

  // Deadlines grouped by due date ("YYYY-MM-DD" — calendar dates, no time zone shifts).
  const byDay = useMemo(() => {
    const map = new Map<string, DeadlineItem[]>();
    for (const d of (deadlines ?? []) as DeadlineItem[]) {
      const key = d.dueDate.slice(0, 10);
      const list = map.get(key);
      if (list) list.push(d);
      else map.set(key, [d]);
    }
    return map;
  }, [deadlines]);

  // Sidebar: the selected day's deadlines, or the whole month's.
  const listed = useMemo(() => {
    const all = ((deadlines ?? []) as DeadlineItem[]).filter(d =>
      selectedDay ? d.dueDate.slice(0, 10) === selectedDay : d.dueDate.slice(0, 7) === monthKey,
    );
    return all.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  }, [deadlines, selectedDay, monthKey]);

  /** Show one day's deadlines in the list; clicking the selected day again (toggle) shows the month. */
  const selectDay = (key: string, reveal: boolean, toggle = true) => {
    setFilters({ day: toggle && key === selectedDay ? "" : key });
    // Below lg the list sits under the grid: bring it into view.
    if (reveal && key !== selectedDay && window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  const activate = (d: DeadlineItem) => {
    const target = workflowTargetFromDeadline(d);
    if (target) setWorkflowDeadline(target);
    else selectDay(d.dueDate.slice(0, 10), true, false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight">Calendar</h2>
          <p className="text-muted-foreground">BIR filing deadlines by month.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => goToMonth(subMonths(currentMonth, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold w-32 sm:w-36 text-center" aria-live="polite">
            {format(currentMonth, "MMMM yyyy")}
          </span>
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => goToMonth(addMonths(currentMonth, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setFilters({ month: today.slice(0, 7), day: "" })}>Today</Button>
        </div>
      </div>

      {/* Colour legend */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Colour legend">
        {LEGEND.map(l => (
          <li key={l.key} className="flex items-center gap-1.5">
            <span className={cn("w-2.5 h-2.5 rounded-full", DEADLINE_DOT_CLASS[l.key])} aria-hidden="true" />
            {l.label}
          </li>
        ))}
      </ul>

      <div className="flex flex-col lg:flex-row gap-6 items-stretch lg:items-start">
        {/* Calendar grid */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : isError ? (
            <ErrorState title="Could not load deadlines" error={error} onRetry={refetch} />
          ) : (
            <Card>
              <CardContent className="p-0">
                {/* Day-of-week headers */}
                <div className="grid grid-cols-7 border-b" aria-hidden="true">
                  {DAY_NAMES.map(d => (
                    <div key={d} className="text-center py-2 text-xs font-semibold text-muted-foreground">{d}</div>
                  ))}
                </div>
                {/* Grid cells */}
                <div className="grid grid-cols-7" role="list" aria-label={`Deadlines in ${format(currentMonth, "MMMM yyyy")}`}>
                  {days.map((day, i) => {
                    const key = format(day, "yyyy-MM-dd");
                    const inMonth = isSameMonth(day, currentMonth);
                    const isT = key === today;
                    const isSelected = key === selectedDay;
                    const dayDeadlines = byDay.get(key) ?? [];
                    const isLast = i >= days.length - 7;
                    const dayLabel = `${formatDate(key, "long")}${isT ? " (today)" : ""}: ${
                      dayDeadlines.length === 0 ? "no deadlines" : `${dayDeadlines.length} deadline${dayDeadlines.length === 1 ? "" : "s"}`
                    }`;
                    return (
                      <div
                        key={key}
                        role="listitem"
                        className={cn(
                          "min-h-[72px] sm:min-h-[90px] p-1 sm:p-2 border-b border-r relative min-w-0",
                          !inMonth && "bg-muted/30",
                          isT && "bg-primary/5",
                          isSelected && "ring-2 ring-inset ring-primary",
                          i % 7 === 6 && "border-r-0",
                          isLast && "border-b-0"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => selectDay(key, true)}
                          aria-label={dayLabel}
                          aria-pressed={isSelected}
                          className="flex w-full flex-col items-center sm:items-start gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className={cn(
                            "text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full",
                            isT ? "bg-primary text-primary-foreground" : inMonth ? "text-foreground" : "text-muted-foreground"
                          )}>
                            {format(day, "d")}
                          </span>
                          {/* Phones: one dot per deadline (the list below shows the details). */}
                          {dayDeadlines.length > 0 && (
                            <span className="flex sm:hidden flex-wrap justify-center gap-0.5" aria-hidden="true">
                              {dayDeadlines.slice(0, 6).map(d => (
                                <span key={d.id} className={cn("w-1.5 h-1.5 rounded-full", DEADLINE_DOT_CLASS[deadlineColorKey(d)])} />
                              ))}
                              {dayDeadlines.length > 6 && <span className="text-[10px] leading-none text-muted-foreground">+</span>}
                            </span>
                          )}
                        </button>
                        <div className="hidden sm:block space-y-0.5 mt-1">
                          {dayDeadlines.slice(0, MAX_PILLS).map(d => (
                            <button
                              key={d.id}
                              type="button"
                              className={cn(
                                "w-full text-left text-xs px-1.5 py-0.5 rounded border truncate flex items-center gap-1 hover:opacity-80",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                DEADLINE_PILL_CLASS[deadlineColorKey(d)],
                              )}
                              onClick={() => activate(d)}
                              title={d.title}
                              aria-label={describeDeadline(d)}
                            >
                              <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", DEADLINE_DOT_CLASS[deadlineColorKey(d)])} aria-hidden="true" />
                              <span className="truncate">{d.title}</span>
                            </button>
                          ))}
                          {dayDeadlines.length > MAX_PILLS && (
                            <button
                              type="button"
                              onClick={() => selectDay(key, true, false)}
                              aria-label={`Show all ${dayDeadlines.length} deadlines on ${formatDate(key, "long")}`}
                              className="text-xs text-muted-foreground hover:text-foreground hover:underline pl-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              +{dayDeadlines.length - MAX_PILLS} more
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar: the selected day's or this month's deadlines */}
        <div ref={listRef} className="w-full lg:w-64 shrink-0 space-y-3 scroll-mt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {selectedDay ? formatDate(selectedDay, "monthDay") : format(currentMonth, "MMMM")} Deadlines
            </p>
            {selectedDay && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => setFilters({ day: "" })}
                aria-label={`Show all ${format(currentMonth, "MMMM")} deadlines`}
              >
                <X className="h-3 w-3" aria-hidden="true" />All {format(currentMonth, "MMM")}
              </Button>
            )}
          </div>
          {isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14" />)}</div>
          ) : isError ? null : listed.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-30" aria-hidden="true" />
              <p className="text-xs">{selectedDay ? "No deadlines on this day" : "No deadlines this month"}</p>
            </div>
          ) : (
            <ul className="space-y-2 lg:max-h-[600px] lg:overflow-y-auto lg:pr-1">
              {listed.map(d => {
                const content = (
                  <CardContent className="p-3">
                    <div className="flex items-start gap-2">
                      <span className={cn("w-2 h-2 rounded-full mt-1.5 flex-shrink-0", DEADLINE_DOT_CLASS[deadlineColorKey(d)])} aria-hidden="true" />
                      <div className="min-w-0">
                        <p className={cn("text-xs font-medium leading-tight truncate", d.status === "completed" && "line-through")}>{d.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDate(d.dueDate, "monthDay")}
                          {d.clientName && <> · {d.clientName}</>}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                );
                return (
                  <li key={d.id}>
                    {d.clientId ? (
                      <button
                        type="button"
                        onClick={() => activate(d)}
                        aria-label={describeDeadline(d)}
                        className="block w-full text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Card className={cn("overflow-hidden border transition-colors hover:border-primary/40", d.status === "completed" && "opacity-60")}>
                          {content}
                        </Card>
                      </button>
                    ) : (
                      <Card className={cn("overflow-hidden border", d.status === "completed" && "opacity-60")}>{content}</Card>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Filing Workflow Dialog */}
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
          onUpdate={() => invalidateFilingData(queryClient)}
        />
      )}
    </div>
  );
}
