import { useListAuditLogs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, User2 } from "lucide-react";
import { format, parseISO } from "date-fns";

const ACTION_STYLES: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-blue-100 text-blue-700",
  delete: "bg-red-100 text-red-700",
  upload: "bg-violet-100 text-violet-700",
  comment: "bg-amber-100 text-amber-700",
  approve: "bg-teal-100 text-teal-700",
  reject: "bg-orange-100 text-orange-700",
  login: "bg-gray-100 text-gray-700",
};

const ENTITY_LABELS: Record<string, string> = {
  user: "User",
  client: "Client",
  engagement: "Engagement",
  deadline: "Deadline",
  checklist_item: "Checklist",
  document: "Document",
  comment: "Comment",
};

export default function AuditLog() {
  const { data: logs, isLoading } = useListAuditLogs();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Audit Trail</h2>
        <p className="text-muted-foreground">Complete log of all actions taken in the system.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Activity Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : !logs || logs.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p>No audit logs yet.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {[...logs].reverse().map((log, idx) => {
                const actionStyle = ACTION_STYLES[log.action] || "bg-gray-100 text-gray-700";
                return (
                  <div key={log.id} className={`flex items-start gap-4 py-3 ${idx < logs.length - 1 ? "border-b" : ""}`}>
                    <div className="text-xs shrink-0 text-muted-foreground w-32 mt-0.5 text-right hidden sm:block">
                      {format(parseISO(log.createdAt), 'MMM d, h:mm a')}
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
                          {ENTITY_LABELS[log.entityType] || log.entityType}
                          {log.entityId != null ? ` #${log.entityId}` : ""}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{log.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 sm:hidden">{format(parseISO(log.createdAt), 'MMM d, h:mm a')}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
