import {
  useGetDashboardSummary, useGetUpcomingDeadlines, useGetRecentActivity, useGetEngagementStatusBreakdown,
  getGetDashboardSummaryQueryKey, getGetUpcomingDeadlinesQueryKey, getGetRecentActivityQueryKey,
  getGetEngagementStatusBreakdownQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Briefcase, Calendar, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend } from "recharts";
import { useAuth } from "@/lib/auth";
import { can, isClientRole } from "@/lib/permissions";
import { formatDate, formatDateTime } from "@/lib/format";
import { getEngagementStatus, ENGAGEMENT_STATUS_CHART_COLORS, DEADLINE_URGENCY_TEXT } from "@/lib/status";
import { ErrorState } from "@/components/ErrorState";
import { MyWorkCard } from "@/components/MyWorkCard";

// Every query key here starts with "/api/dashboard", so invalidateFilingData()
// refreshes the whole dashboard after any filing mutation.
export default function Dashboard() {
  const { user } = useAuth();
  const isClient = isClientRole(user?.role);
  const summaryQuery = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey() } });
  const deadlinesQuery = useGetUpcomingDeadlines({ query: { queryKey: getGetUpcomingDeadlinesQueryKey() } });
  // Recent activity is the audit trail: managers and super admins only.
  const showActivity = can(user, "viewAuditLog");
  const activityQuery = useGetRecentActivity({ query: { queryKey: getGetRecentActivityQueryKey(), enabled: showActivity } });
  const breakdownQuery = useGetEngagementStatusBreakdown({ query: { queryKey: getGetEngagementStatusBreakdownQueryKey() } });

  const { data: summary, isLoading: isLoadingSummary } = summaryQuery;
  const { data: deadlines, isLoading: isLoadingDeadlines } = deadlinesQuery;
  const { data: activity, isLoading: isLoadingActivity } = activityQuery;
  const { data: breakdown, isLoading: isLoadingBreakdown } = breakdownQuery;

  const chartData = breakdown?.map(item => ({
    name: getEngagementStatus(item.status).label,
    value: item.count,
    color: ENGAGEMENT_STATUS_CHART_COLORS[item.status] || ENGAGEMENT_STATUS_CHART_COLORS.pending
  })) || [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard Overview</h2>
        <p className="text-muted-foreground">Welcome back. Here's what's happening with your engagements.</p>
      </div>

      <MyWorkCard />

      {/* Stats Row */}
      {summaryQuery.isError ? (
        <ErrorState compact error={summaryQuery.error} onRetry={summaryQuery.refetch} title="Could not load the summary" />
      ) : (
      <div className={`grid gap-4 md:grid-cols-2 ${isClient ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
        {!isClient && (
          <StatCard
            title="Total Clients"
            value={summary?.totalClients}
            icon={Users}
            isLoading={isLoadingSummary}
          />
        )}
        <StatCard 
          title="Active Engagements" 
          value={summary?.activeEngagements} 
          icon={Briefcase} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Upcoming Deadlines" 
          value={summary?.upcomingDeadlines} 
          icon={Calendar} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Overdue Items" 
          value={summary?.overdueItems} 
          icon={AlertCircle} 
          className={summary?.overdueItems ? "text-destructive" : ""}
          isLoading={isLoadingSummary} 
        />
      </div>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        {/* Main Chart */}
        <Card className="col-span-1 lg:col-span-4">
          <CardHeader>
            <CardTitle>Engagement Status Breakdown</CardTitle>
            <CardDescription>Current distribution of all tax engagements.</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownQuery.isError ? (
              <ErrorState compact error={breakdownQuery.error} onRetry={breakdownQuery.refetch} title="Could not load the breakdown" />
            ) : isLoadingBreakdown ? (
              <div className="h-[300px] flex items-center justify-center">
                <Skeleton className="h-64 w-64 rounded-full" />
              </div>
            ) : chartData.length > 0 ? (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                No engagements found.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deadlines Widget */}
        <Card className="col-span-1 lg:col-span-3">
          <CardHeader>
            <CardTitle>Upcoming Deadlines</CardTitle>
            <CardDescription>Items requiring attention in the next 30 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {deadlinesQuery.isError ? (
              <ErrorState compact error={deadlinesQuery.error} onRetry={deadlinesQuery.refetch} title="Could not load deadlines" />
            ) : isLoadingDeadlines ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : deadlines && deadlines.length > 0 ? (
              <div className="space-y-4">
                {deadlines.map((deadline) => (
                  <div key={deadline.id} className="flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
                    <div className="space-y-1 min-w-0">
                      <p className="text-sm font-medium leading-snug break-words">{deadline.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{[deadline.clientName, deadline.engagementTitle].filter(Boolean).join(" - ")}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-xs font-semibold ${
                        deadline.daysUntilDue < 0 ? DEADLINE_URGENCY_TEXT.overdue :
                        deadline.daysUntilDue <= 3 ? DEADLINE_URGENCY_TEXT.due_soon :
                        DEADLINE_URGENCY_TEXT.upcoming
                      }`}>
                        {deadline.daysUntilDue < 0 ? 'Overdue' : 
                         deadline.daysUntilDue === 0 ? 'Due Today' : 
                         `In ${deadline.daysUntilDue} days`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(deadline.dueDate, "monthDay")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-500 mb-2 opacity-50" />
                No upcoming deadlines. You're all caught up!
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Feed (managers and super admins only) */}
      {showActivity && (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest actions across your engagements.</CardDescription>
        </CardHeader>
        <CardContent>
          {activityQuery.isError ? (
            <ErrorState compact error={activityQuery.error} onRetry={activityQuery.refetch} title="Could not load recent activity" />
          ) : isLoadingActivity ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : activity && activity.length > 0 ? (
            <div className="space-y-4">
              {activity.map((log) => (
                <div key={log.id} className="flex items-start gap-4 text-sm">
                  <div className="mt-0.5 p-1 bg-muted rounded-full">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0 break-words">
                    <p>
                      <span className="font-medium text-foreground">{log.userName}</span>{' '}
                      <span className="text-muted-foreground">{log.action}</span>{' '}
                      <span className="font-medium text-foreground">{log.entityType.toLowerCase()}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDateTime(log.createdAt)} • {log.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-4">
              No recent activity.
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}

function StatCard({ 
  title, 
  value, 
  icon: Icon, 
  isLoading,
  className = "" 
}: { 
  title: string; 
  value?: number; 
  icon: React.ElementType; 
  isLoading: boolean;
  className?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className={`text-2xl font-bold ${className}`}>{value || 0}</div>
        )}
      </CardContent>
    </Card>
  );
}
