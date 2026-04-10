import { useParams, Link } from "wouter";
import { useGetClient, useListEngagements, useListDocuments, useListDeadlines, getListEngagementsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Building2, Mail, Phone, MapPin, FileText, Briefcase, Calendar, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  for_review: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  filed: "bg-teal-100 text-teal-700",
  completed: "bg-emerald-100 text-emerald-700",
};

export default function ClientDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);

  const { data: client, isLoading: loadingClient } = useGetClient(id, { query: { enabled: !!id } });
  const { data: engagements, isLoading: loadingEngagements } = useListEngagements({ clientId: id }, { query: { enabled: !!id, queryKey: getListEngagementsQueryKey({ clientId: id }) } });
  const { data: documents, isLoading: loadingDocs } = useListDocuments({ clientId: id });
  const { data: deadlines, isLoading: loadingDeadlines } = useListDeadlines({ clientId: id });

  if (loadingClient) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Client not found.</p>
        <Link href="/clients"><Button variant="outline" className="mt-4"><ArrowLeft className="h-4 w-4 mr-2" />Back to Clients</Button></Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/clients">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h2 className="text-2xl font-bold">{client.name}</h2>
          <p className="text-muted-foreground font-mono text-sm">TIN: {client.tin}</p>
        </div>
        <Badge variant={client.status === "active" ? "default" : "secondary"} className="ml-2">{client.status}</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Building2 className="h-4 w-4" />Client Information</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Business Type</span>
              <span className="font-medium">{client.businessType}</span>
            </div>
            {client.contactEmail && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><Mail className="h-3.5 w-3.5" />Email</span>
                <span>{client.contactEmail}</span>
              </div>
            )}
            {client.contactPhone && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><Phone className="h-3.5 w-3.5" />Phone</span>
                <span>{client.contactPhone}</span>
              </div>
            )}
            {client.address && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />Address</span>
                <span className="text-right max-w-[60%]">{client.address}</span>
              </div>
            )}
            {client.fiscalYearEnd && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fiscal Year End</span>
                <span>{client.fiscalYearEnd}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-rows-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Active Engagements</CardTitle></CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{engagements?.filter(e => !["completed","filed"].includes(e.status)).length ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">of {engagements?.length ?? 0} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Documents</CardTitle></CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{documents?.length ?? 0}</div>
              <p className="text-xs text-muted-foreground mt-1">files on record</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Engagements */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Briefcase className="h-4 w-4" />Engagements</CardTitle>
          <Link href={`/engagements?clientId=${id}`}>
            <Button variant="outline" size="sm">View All</Button>
          </Link>
        </CardHeader>
        <CardContent>
          {loadingEngagements ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : engagements && engagements.length > 0 ? (
            <div className="space-y-2">
              {engagements.map(e => (
                <Link key={e.id} href={`/engagements/${e.id}`}>
                  <div className="flex items-center justify-between p-3 rounded-md border hover:bg-muted/50 transition-colors cursor-pointer">
                    <div>
                      <p className="font-medium text-sm">{e.title}</p>
                      <p className="text-xs text-muted-foreground">{e.period} • {e.taxType}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {e.dueDate && <span className="text-xs text-muted-foreground">{format(parseISO(e.dueDate), 'MMM d')}</span>}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[e.status] || STATUS_COLORS.pending}`}>
                        {e.status.replace("_", " ")}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No engagements for this client.</p>
          )}
        </CardContent>
      </Card>

      {/* Deadlines */}
      {deadlines && deadlines.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Calendar className="h-4 w-4" />Deadlines</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {deadlines.map(d => (
                <div key={d.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div>
                    <p className="font-medium text-sm">{d.title}</p>
                    <p className="text-xs text-muted-foreground">{d.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{format(parseISO(d.dueDate), 'MMM d, yyyy')}</span>
                    <Badge variant={d.status === "completed" ? "secondary" : d.priority === "high" ? "destructive" : "outline"}>
                      {d.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Documents */}
      {documents && documents.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {documents.map(doc => (
                <div key={doc.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div className="flex items-center gap-3">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{doc.originalName}</p>
                      <p className="text-xs text-muted-foreground">v{doc.version} • {doc.uploadedByName} • {format(parseISO(doc.createdAt), 'MMM d, yyyy')}</p>
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">{(doc.fileSize / 1024).toFixed(0)} KB</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
