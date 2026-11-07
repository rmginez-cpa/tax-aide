import { useState } from "react";
import { Link, useSearchParams } from "wouter";
import { useListClients, useCreateClient, useDeleteClient, type Client } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { errorMessage } from "@/lib/api";
import { invalidateFilingData } from "@/lib/queries";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { ClientForm, EMPTY_CLIENT_FORM } from "@/components/ClientForm";
import { Plus, Search, Building2, Phone, Mail, Trash2, ExternalLink, Clock, Eye, AlertTriangle } from "lucide-react";

function WorkflowStatusBadges({ client }: { client: Client }) {
  const counts = client.workflowCounts;
  if (!counts) return null;
  const badges = [
    // In progress / for review count this tax year's checklist items, so they open the client page's
    // matching filter. Overdue counts the client's saved open deadlines of every tax year (like the
    // dashboard), so it opens the deadlines list filtered to exactly those rows.
    { key: "in_progress",  count: counts.inProgress, label: "in progress", icon: Clock,         cls: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
      href: `/clients/${client.id}?wf=in_progress`, title: undefined },
    { key: "for_review",   count: counts.forReview,  label: "for review",  icon: Eye,            cls: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100",
      href: `/clients/${client.id}?wf=for_review`, title: undefined },
    { key: "overdue",      count: counts.overdue,    label: "overdue",     icon: AlertTriangle,  cls: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100",
      href: `/deadlines?status=overdue&client=${client.id}`, title: "Open deadlines past due, all tax years" },
  ].filter(b => b.count > 0);

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1.5">
      {badges.map(({ key, count, label, icon: Icon, cls, href, title }) => (
        <Link
          key={key}
          href={href}
          title={title}
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium transition-colors ${cls}`}
        >
          <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
          {count} {label}
        </Link>
      ))}
    </div>
  );
}

function TaxTypeBadges({ client }: { client: Client }) {
  const badges: { label: string; color: string }[] = [];
  if (client.vatRegistered) badges.push({ label: "VAT", color: "bg-blue-100 text-blue-700" });
  if (client.percentageTaxRegistered) badges.push({ label: "Percentage Tax", color: "bg-violet-100 text-violet-700" });
  if (client.withholdsCompensation) badges.push({ label: "WHT-Comp", color: "bg-amber-100 text-amber-700" });
  if (client.withholdsEwt) badges.push({ label: "EWT", color: "bg-orange-100 text-orange-700" });
  if (client.subjectToDst) badges.push({ label: "DST", color: "bg-slate-100 text-slate-700" });
  if (client.incomeTaxType === "corporate") badges.push({ label: "Corp ITR", color: "bg-emerald-100 text-emerald-700" });
  if (client.incomeTaxType === "individual") badges.push({ label: "Indiv ITR", color: "bg-green-100 text-green-700" });
  if (client.withholdsFinal) badges.push({ label: "WHT-Final", color: "bg-violet-100 text-violet-700" });
  if (client.hasInventory) badges.push({ label: "Inventory", color: "bg-teal-100 text-teal-700" });
  if (client.isLessor) badges.push({ label: "Lessor", color: "bg-pink-100 text-pink-700" });
  if (client.isEsalesRequired) badges.push({ label: "eSales", color: "bg-indigo-100 text-indigo-700" });
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {badges.map(b => (
        <span key={b.label} className={`text-xs px-1.5 py-0.5 rounded font-medium ${b.color}`}>{b.label}</span>
      ))}
      {badges.length === 0 && <span className="text-xs text-muted-foreground italic">No BIR 2303 data</span>}
    </div>
  );
}

export default function Clients() {
  const { user } = useAuth();
  const { data: clients, isLoading, isError, error, refetch } = useListClients();
  const createClient = useCreateClient();
  const deleteClient = useDeleteClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q") ?? "";
  const [open, setOpen] = useState(false);

  const setSearch = (value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set("q", value); else next.delete("q");
      return next;
    }, { replace: true });
  };

  const needle = search.trim().toLowerCase();
  const filtered = clients?.filter(c =>
    !needle ||
    c.name.toLowerCase().includes(needle) ||
    c.tin.toLowerCase().includes(needle) ||
    c.businessType.toLowerCase().includes(needle) ||
    (c.tradeName ?? "").toLowerCase().includes(needle)
  ) ?? [];

  const handleCreate = async (payload: Parameters<typeof createClient.mutateAsync>[0]["data"]) => {
    try {
      await createClient.mutateAsync({ data: payload });
    } catch (e) {
      toast({ title: "Failed to create client", description: errorMessage(e), variant: "destructive" });
      throw e;
    }
    await invalidateFilingData(queryClient);
    setOpen(false);
    toast({ title: "Client created successfully" });
  };

  const handleDelete = (id: number, name: string) => {
    void confirm({
      title: `Delete client "${name}"?`,
      description: "This removes the client and its generated deadlines and cannot be undone. A client with filings or documents cannot be deleted: set it to inactive instead.",
      confirmLabel: "Delete client",
      destructive: true,
      onConfirm: async () => {
        await deleteClient.mutateAsync({ id });
        await invalidateFilingData(queryClient);
        toast({ title: "Client deleted" });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight">Clients</h2>
          <p className="text-muted-foreground">Manage your tax clients and their BIR 2303 registration details.</p>
        </div>
        {can(user, "manageClients") && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="shrink-0"><Plus className="h-4 w-4 mr-2" />Add Client</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add New Client</DialogTitle>
                <DialogDescription>Enter the client's BIR 2303 Certificate of Registration details to enable automatic deadline generation.</DialogDescription>
              </DialogHeader>
              <ClientForm
                initialValues={EMPTY_CLIENT_FORM}
                onSubmit={handleCreate}
                onCancel={() => setOpen(false)}
                submitLabel="Create Client"
                pendingLabel="Creating..."
                pending={createClient.isPending}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search clients by name, TIN, or type..." aria-label="Search clients" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isError ? (
        <ErrorState title="Could not load clients" error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1,2,3].map(i => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">{needle ? "No clients match your search" : "No clients yet"}</p>
            <p className="text-sm mt-1">{needle ? "Try a different name, TIN or business type." : can(user, "manageClients") ? "Add your first client to get started." : "No clients are available to you."}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map(client => (
            <Card key={client.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <CardTitle className="text-base truncate">{client.name}</CardTitle>
                    {client.tradeName && <p className="text-xs text-muted-foreground">"{client.tradeName}"</p>}
                    <p className="text-xs text-muted-foreground font-mono">TIN: {client.tin}</p>
                  </div>
                  <Badge variant={client.status === "active" ? "default" : "secondary"} className="ml-2 shrink-0 text-xs">
                    {client.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1.5">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{client.businessType}</span>
                </div>
                {client.rdoCode && (
                  <p className="text-xs text-muted-foreground">RDO: {client.rdoCode} {client.lineOfBusiness && `• ${client.lineOfBusiness}`}</p>
                )}
                {client.contactEmail && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{client.contactEmail}</span>
                  </div>
                )}
                {client.contactPhone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span>{client.contactPhone}</span>
                  </div>
                )}
                <TaxTypeBadges client={client} />
                <WorkflowStatusBadges client={client} />
                <div className="flex items-center justify-between pt-2 border-t">
                  <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs">
                    <Link href={`/clients/${client.id}`}>
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />View & Compliance
                    </Link>
                  </Button>
                  {can(user, "deleteClients") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete client ${client.name}`}
                      title="Delete client"
                      onClick={() => handleDelete(client.id, client.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
