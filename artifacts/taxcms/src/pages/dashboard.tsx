import { useGetDashboardSummary, useGetUpcomingDeadlines, useGetOverdueItems, useGetRecentActivity, useGetEngagementStatusBreakdown } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Briefcase, Calendar, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip, Legend } from "recharts";

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary({ query: { queryKey: ["dashboard-summary"] } });
  const { data: deadlines, isLoading: isLoadingDeadlines } = useGetUpcomingDeadlines({ query: { queryKey: ["dashboard-deadlines"] } });
  const { data: activity, isLoading: isLoadingActivity } = useGetRecentActivity({ query: { queryKey: ["dashboard-activity"] } });
  const { data: breakdown, isLoading: isLoadingBreakdown } = useGetEngagementStatusBreakdown({ query: { queryKey: ["dashboard-breakdown"] } });

  const STATUS_COLORS: Record<string, string> = {
    pending: "hsl(215 16% 47%)", // Gray
    in_progress: "hsl(214 100% 41%)", // Blue
    for_review: "hsl(35 92% 33%)", // Amber
    approved: "hsl(142 71% 45%)", // Green
    filed: "hsl(173 58% 39%)", // Teal
    completed: "hsl(152 69% 31%)", // Emerald
  };

  const chartData = breakdown?.map(item => ({
    name: item.status.replace("_", " ").replace(/\b\w/g, l => l.toUpperCase()),
    value: item.count,
    color: STATUS_COLORS[item.status] || STATUS_COLORS.pending
  })) || [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard Overview</h2>
        <p className="text-muted-foreground">Welcome back. Here's what's happening with your engagements.</p>
      </div>

      {/* Stats Row */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard 
          title="Total Clients" 
          value={summary?.totalClients} 
          icon={Users} 
          isLoading={isLoadingSummary} 
        />
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

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-7">
        {/* Main Chart */}
        <Card className="col-span-1 lg:col-span-4">
          <CardHeader>
            <CardTitle>Engagement Status Breakdown</CardTitle>
            <CardDescription>Current distribution of all tax engagements.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingBreakdown ? (
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
            <CardDescription>Items requiring attention in the next 14 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingDeadlines ? (
              <div className="space-y-4">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : deadlines && deadlines.length > 0 ? (
              <div className="space-y-4">
                {deadlines.map((deadline) => (
                  <div key={deadline.id} className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0">
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none">{deadline.title}</p>
                      <p className="text-xs text-muted-foreground">{deadline.clientName} - {deadline.engagementTitle}</p>
                    </div>
                    <div className="text-right">
                      <div className={`text-xs font-semibold ${
                        deadline.daysUntilDue < 0 ? 'text-destructive' :
                        deadline.daysUntilDue <= 3 ? 'text-amber-600 dark:text-amber-500' :
                        'text-muted-foreground'
                      }`}>
                        {deadline.daysUntilDue < 0 ? 'Overdue' : 
                         deadline.daysUntilDue === 0 ? 'Due Today' : 
                         `In ${deadline.daysUntilDue} days`}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {format(parseISO(deadline.dueDate), 'MMM d')}
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

      {/* Activity Feed */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest actions across your engagements.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingActivity ? (
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
                  <div className="flex-1">
                    <p>
                      <span className="font-medium text-foreground">{log.userName}</span>{' '}
                      <span className="text-muted-foreground">{log.action}</span>{' '}
                      <span className="font-medium text-foreground">{log.entityType.toLowerCase()}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {format(parseISO(log.createdAt), 'MMM d, yyyy h:mm a')} • {log.description}
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
