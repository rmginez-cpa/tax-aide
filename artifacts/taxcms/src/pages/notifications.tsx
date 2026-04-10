import {
  useListNotifications, useMarkNotificationRead, useMarkAllNotificationsRead,
  getListNotificationsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, Calendar, FileText, MessageSquare, CheckCircle2, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";

const TYPE_INFO: Record<string, { icon: React.ElementType; color: string }> = {
  deadline_upcoming: { icon: Calendar, color: "text-amber-500" },
  deadline_overdue: { icon: AlertTriangle, color: "text-red-500" },
  engagement_approved: { icon: CheckCircle2, color: "text-emerald-500" },
  engagement_status_change: { icon: CheckCircle2, color: "text-blue-500" },
  document_uploaded: { icon: FileText, color: "text-slate-500" },
  comment_added: { icon: MessageSquare, color: "text-violet-500" },
};

export default function Notifications() {
  const { data: notifications, isLoading } = useListNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const unread = notifications?.filter(n => !n.isRead).length ?? 0;

  const handleMarkRead = (id: number) => {
    markRead.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    });
  };

  const handleMarkAllRead = () => {
    markAllRead.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
        toast({ title: "All notifications marked as read" });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Notifications</h2>
          <p className="text-muted-foreground">{unread > 0 ? `${unread} unread notification${unread > 1 ? 's' : ''}` : 'All caught up'}</p>
        </div>
        {unread > 0 && (
          <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
            Mark All Read
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : !notifications || notifications.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Bell className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No notifications</p>
            <p className="text-sm mt-1">You're all caught up.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {[...notifications].reverse().map(n => {
            const info = TYPE_INFO[n.type] || { icon: Bell, color: "text-muted-foreground" };
            const Icon = info.icon;
            return (
              <Card
                key={n.id}
                className={`transition-colors cursor-pointer ${!n.isRead ? "border-primary/30 bg-primary/5" : ""}`}
                onClick={() => !n.isRead && handleMarkRead(n.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className={`mt-0.5 p-2 rounded-full bg-muted shrink-0 ${info.color}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-semibold ${!n.isRead ? "text-foreground" : "text-foreground/70"}`}>{n.title}</p>
                        {!n.isRead && <span className="h-2 w-2 bg-primary rounded-full shrink-0" />}
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{n.message}</p>
                      <p className="text-xs text-muted-foreground mt-1">{format(parseISO(n.createdAt), 'MMM d, yyyy h:mm a')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
