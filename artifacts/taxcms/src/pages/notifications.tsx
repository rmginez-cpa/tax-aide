import { useListNotifications, useMarkNotificationRead, useMarkAllNotificationsRead } from "@workspace/api-client-react";
import type { Notification } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { Bell, Calendar, FileText, MessageSquare, CheckCircle2, AlertTriangle, ChevronRight, Loader2 } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import { invalidatePrefixes } from "@/lib/queries";
import { notificationHref } from "@/lib/notifications";
import { useAuth } from "@/lib/auth";

const TYPE_INFO: Record<string, { icon: React.ElementType; color: string }> = {
  deadline_upcoming: { icon: Calendar, color: "text-amber-500" },
  deadline_overdue: { icon: AlertTriangle, color: "text-red-500" },
  engagement_approved: { icon: CheckCircle2, color: "text-emerald-500" },
  engagement_status_change: { icon: CheckCircle2, color: "text-blue-500" },
  document_uploaded: { icon: FileText, color: "text-slate-500" },
  comment_added: { icon: MessageSquare, color: "text-violet-500" },
};

/** The notifications list and the nav badge's unread count. */
const NOTIFICATION_PREFIXES = ["/api/notifications"] as const;

export default function Notifications() {
  // The server returns them newest first.
  const { data: notifications, isLoading, isError, error, refetch } = useListNotifications();
  const queryClient = useQueryClient();
  const refresh = () => invalidatePrefixes(queryClient, NOTIFICATION_PREFIXES);
  // Hook-level onSettled: it still runs after the page unmounts (we navigate away on click),
  // so the nav badge refreshes too.
  const markRead = useMarkNotificationRead({ mutation: { onSettled: () => { void refresh(); } } });
  const markAllRead = useMarkAllNotificationsRead();
  const { toast } = useToast();
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  const unread = notifications?.filter(n => !n.isRead).length ?? 0;

  const open = (n: Notification) => {
    if (!n.isRead) {
      // Fire and forget: the mutation keeps running after we navigate away.
      markRead.mutate({ id: n.id });
    }
    const href = notificationHref(n, user?.role);
    if (href) setLocation(href);
  };

  const handleMarkAllRead = () => {
    markAllRead.mutate(undefined, {
      onSuccess: () => {
        void refresh();
        toast({ title: "All notifications marked as read" });
      },
      onError: (err) => {
        toast({ title: "Could not mark notifications as read", description: errorMessage(err), variant: "destructive" });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Notifications</h2>
          <p className="text-muted-foreground">{unread > 0 ? `${unread} unread notification${unread > 1 ? 's' : ''}` : 'All caught up'}</p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={handleMarkAllRead} disabled={markAllRead.isPending}>
            {markAllRead.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {markAllRead.isPending ? "Marking..." : "Mark all read"}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : isError ? (
        <ErrorState error={error} onRetry={refetch} title="Could not load notifications" />
      ) : !notifications || notifications.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Bell className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No notifications</p>
            <p className="text-sm mt-1">You're all caught up.</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Notifications">
          {notifications.map(n => {
            const info = TYPE_INFO[n.type] || { icon: Bell, color: "text-muted-foreground" };
            const Icon = info.icon;
            const href = notificationHref(n, user?.role);
            const actionable = !!href || !n.isRead;
            return (
              <li key={n.id}>
                <Card className={`transition-colors ${!n.isRead ? "border-primary/30 bg-primary/5" : ""} ${actionable ? "hover:bg-muted/50" : ""}`}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    disabled={!actionable}
                    aria-label={`${n.title}${!n.isRead ? " (unread)" : ""}${href ? " - open" : ""}`}
                    className="w-full text-left p-4 rounded-[inherit] cursor-pointer disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <div className="flex items-start gap-4">
                      <div className={`mt-0.5 p-2 rounded-full bg-muted shrink-0 ${info.color}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`text-sm font-semibold break-words ${!n.isRead ? "text-foreground" : "text-foreground/70"}`}>{n.title}</p>
                          {!n.isRead && <span className="h-2 w-2 bg-primary rounded-full shrink-0" aria-hidden="true" />}
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5 break-words">{n.message}</p>
                        <p className="text-xs text-muted-foreground mt-1">{formatDateTime(n.createdAt)}</p>
                      </div>
                      {href && <ChevronRight className="h-4 w-4 mt-1 text-muted-foreground shrink-0" aria-hidden="true" />}
                    </div>
                  </button>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
