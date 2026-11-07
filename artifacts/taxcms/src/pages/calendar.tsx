import { useState } from "react";
import {
  useListDeadlines,
  getListDeadlinesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  isToday,
} from "date-fns";
import { isOverdue } from "@/lib/dates";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type DeadlineItem = {
  id: number;
  title: string;
  dueDate: string;
  status: string;
  priority: string;
  clientId: number | null;
  clientName?: string | null;
  engagementId: number | null;
  description?: string | null;
};

function deadlineDotClass(d: DeadlineItem) {
  if (d.status === "completed") return "bg-emerald-500";
  if (isOverdue(d.dueDate, d.status)) return "bg-red-500";
  if (d.priority === "high") return "bg-amber-500";
  return "bg-primary";
}

function deadlinePillClass(d: DeadlineItem) {
  if (d.status === "completed") return "bg-emerald-100 text-emerald-800 border-emerald-200 line-through opacity-70";
  if (isOverdue(d.dueDate, d.status)) return "bg-red-50 text-red-700 border-red-200";
  if (d.priority === "high") return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-primary/5 text-primary border-primary/20";
}

export default function CalendarPage() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const { data: deadlines, isLoading } = useListDeadlines();
  const queryClient = useQueryClient();

  const [workflowDeadline, setWorkflowDeadline] = useState<{
    deadlineId: number;
    engagementId: number | null;
    clientId: number | null;
    formNumber: string;
    description: string;
    period: string;
    dueDate: string;
  } | null>(null);

  const openWorkflow = (d: DeadlineItem) => {
    if (!d.clientId) return;
    const formMatch = d.title.match(/(\d{4}[A-Z]?(?:EZ)?)\b/);
    setWorkflowDeadline({
      deadlineId: d.id,
      engagementId: d.engagementId ?? null,
      clientId: d.clientId,
      formNumber: formMatch ? `BIR Form ${formMatch[1]}` : d.title,
      description: d.clientName ?? "",
      period: d.description ?? "",
      dueDate: d.dueDate,
    });
  };

  // Build the calendar grid — from the first Sunday on/before month start
  // to the last Saturday on/after month end
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  // Get deadlines for a given day
  const deadlinesForDay = (day: Date): DeadlineItem[] => {
    if (!deadlines) return [];
    return (deadlines as DeadlineItem[]).filter(d => {
      try { return isSameDay(parseISO(d.dueDate), day); } catch { return false; }
    });
  };

  // Sidebar: upcoming deadlines for this month
  const monthDeadlines = (deadlines as DeadlineItem[] | undefined)?.filter(d => {
    try { return isSameMonth(parseISO(d.dueDate), currentMonth); } catch { return false; }
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate)) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Calendar</h2>
          <p className="text-muted-foreground">BIR filing deadlines by month.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setCurrentMonth(m => subMonths(m, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold w-36 text-center">
            {format(currentMonth, "MMMM yyyy")}
          </span>
          <Button variant="outline" size="icon" onClick={() => setCurrentMonth(m => addMonths(m, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCurrentMonth(new Date())}>Today</Button>
        </div>
      </div>

      <div className="flex gap-6 items-start">
        {/* Calendar grid */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <Skeleton className="h-96 w-full rounded-xl" />
          ) : (
            <Card>
              <CardContent className="p-0">
                {/* Day-of-week headers */}
                <div className="grid grid-cols-7 border-b">
                  {DAY_NAMES.map(d => (
                    <div key={d} className="text-center py-2 text-xs font-semibold text-muted-foreground">{d}</div>
                  ))}
                </div>
                {/* Grid cells */}
                <div className="grid grid-cols-7">
                  {days.map((day, i) => {
                    const inMonth = isSameMonth(day, currentMonth);
                    const isT = isToday(day);
                    const dayDeadlines = deadlinesForDay(day);
                    const isLast = i >= days.length - 7;
                    return (
                      <div
                        key={day.toISOString()}
                        className={cn(
                          "min-h-[90px] p-2 border-b border-r relative",
                          !inMonth && "bg-muted/30",
                          isT && "bg-primary/5",
                          i % 7 === 6 && "border-r-0",
                          isLast && "border-b-0"
                        )}
                      >
                        <div className={cn(
                          "text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full",
                          isT ? "bg-primary text-primary-foreground" : inMonth ? "text-foreground" : "text-muted-foreground"
                        )}>
                          {format(day, "d")}
                        </div>
                        <div className="space-y-0.5">
                          {dayDeadlines.slice(0, 3).map(d => (
                            <button
                              key={d.id}
                              className={cn(
                                "w-full text-left text-xs px-1.5 py-0.5 rounded border truncate flex items-center gap-1",
                                deadlinePillClass(d),
                                d.clientId ? "cursor-pointer hover:opacity-80" : "cursor-default"
                              )}
                              onClick={() => d.clientId && openWorkflow(d)}
                              title={d.title}
                            >
                              <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", deadlineDotClass(d))} />
                              <span className="truncate">{d.title}</span>
                            </button>
                          ))}
                          {dayDeadlines.length > 3 && (
                            <p className="text-xs text-muted-foreground pl-1">+{dayDeadlines.length - 3} more</p>
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

        {/* Sidebar: this month's deadlines */}
        <div className="w-64 shrink-0 space-y-3">
          <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {format(currentMonth, "MMMM")} Deadlines
          </p>
          {isLoading ? (
            <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14" />)}</div>
          ) : monthDeadlines.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-xs">No deadlines this month</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {monthDeadlines.map(d => (
                <Card
                  key={d.id}
                  className={cn(
                    "overflow-hidden border transition-colors",
                    d.clientId ? "cursor-pointer hover:border-primary/40" : "",
                    d.status === "completed" && "opacity-60"
                  )}
                  onClick={() => d.clientId && openWorkflow(d)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-2">
                      <span className={cn("w-2 h-2 rounded-full mt-1.5 flex-shrink-0", deadlineDotClass(d))} />
                      <div className="min-w-0">
                        <p className={cn("text-xs font-medium leading-tight truncate", d.status === "completed" && "line-through")}>{d.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {format(parseISO(d.dueDate), "MMM d")}
                          {d.clientName && <> · {d.clientName}</>}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
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
