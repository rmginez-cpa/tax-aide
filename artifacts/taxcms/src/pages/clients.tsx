import { useState } from "react";
import { Link } from "wouter";
import { useListClients, useCreateClient, useDeleteClient, getListClientsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Plus, Search, Building2, Phone, Mail, Trash2, ExternalLink, Clock, Eye, AlertTriangle } from "lucide-react";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const BUSINESS_TYPES = ["Corporation","Sole Proprietorship","Partnership","Cooperative","Non-Profit Organization","One Person Corporation (OPC)","Barangay Micro Business Enterprise (BMBE)"];

const initialForm = {
  name: "", tin: "", businessType: "", contactEmail: "", contactPhone: "",
  address: "", fiscalYearStart: "", fiscalYearEnd: "", status: "active" as const,
  tradeName: "", rdoCode: "", registrationDate: "", lineOfBusiness: "",
  incomeTaxType: "" as "" | "individual" | "corporate",
  vatRegistered: false, percentageTaxRegistered: false,
  withholdsCompensation: false, withholdsEwt: false, subjectToDst: false,
  withholdsFinal: false, hasInventory: false, isLessor: false, isEsalesRequired: false,
};

function WorkflowStatusBadges({ client }: { client: any }) {
  const counts: { inProgress: number; forReview: number; overdue: number } | undefined = client.workflowCounts;
  if (!counts) return null;
  const badges = [
    { key: "in_progress",  count: counts.inProgress, label: "in progress", icon: Clock,         cls: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" },
    { key: "for_review",   count: counts.forReview,  label: "for review",  icon: Eye,            cls: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100" },
    { key: "overdue",      count: counts.overdue,    label: "overdue",     icon: AlertTriangle,  cls: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" },
  ].filter(b => b.count > 0);

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1.5">
      {badges.map(({ key, count, label, icon: Icon, cls }) => (
        <a
          key={key}
          href={`/clients/${client.id}?wf=${key}`}
          onClick={e => e.stopPropagation()}
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium transition-colors ${cls}`}
        >
          <Icon className="h-3 w-3 shrink-0" />
          {count} {label}
        </a>
      ))}
    </div>
  );
}

function TaxTypeBadges({ client }: { client: any }) {
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
  const { data: clients, isLoading } = useListClients();
  const createClient = useCreateClient();
  const deleteClient = useDeleteClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [tab, setTab] = useState("basic");

  const f = (key: string, val: any) => setForm(prev => ({ ...prev, [key]: val }));
  const toggle = (key: string) => setForm(prev => ({ ...prev, [key]: !(prev as any)[key] }));

  const filtered = clients?.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.tin.toLowerCase().includes(search.toLowerCase()) ||
    c.businessType.toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  const handleCreate = () => {
    if (!form.name || !form.tin || !form.businessType) {
      toast({ title: "Company name, TIN, and business type are required", variant: "destructive" });
      return;
    }
    createClient.mutate({
      data: {
        name: form.name, tin: form.tin, businessType: form.businessType,
        contactEmail: form.contactEmail || null,
        contactPhone: form.contactPhone || null,
        address: form.address || null,
        fiscalYearStart: form.fiscalYearStart || null,
        fiscalYearEnd: form.fiscalYearEnd || null,
        status: form.status,
        tradeName: form.tradeName || null,
        rdoCode: form.rdoCode || null,
        registrationDate: form.registrationDate || null,
        lineOfBusiness: form.lineOfBusiness || null,
        incomeTaxType: form.incomeTaxType || null,
        vatRegistered: form.vatRegistered,
        percentageTaxRegistered: form.percentageTaxRegistered,
        withholdsCompensation: form.withholdsCompensation,
        withholdsEwt: form.withholdsEwt,
        subjectToDst: form.subjectToDst,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
        setOpen(false);
        setForm(initialForm);
        setTab("basic");
        toast({ title: "Client created successfully" });
      },
      onError: (e: any) => toast({ title: e?.message || "Failed to create client", variant: "destructive" }),
    });
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete client "${name}"? This cannot be undone.`)) return;
    deleteClient.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListClientsQueryKey() });
        toast({ title: "Client deleted" });
      },
      onError: (e: any) => toast({ title: e?.data?.error || "Failed to delete client", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Clients</h2>
          <p className="text-muted-foreground">Manage your tax clients and their BIR 2303 registration details.</p>
        </div>
        {can(user, "manageClients") && (
          <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) { setForm(initialForm); setTab("basic"); } }}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />Add Client</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add New Client</DialogTitle>
                <p className="text-sm text-muted-foreground">Enter the client's BIR 2303 Certificate of Registration details to enable automatic deadline generation.</p>
              </DialogHeader>

              <Tabs value={tab} onValueChange={setTab} className="mt-2">
                <TabsList className="w-full">
                  <TabsTrigger value="basic" className="flex-1">Basic Information</TabsTrigger>
                  <TabsTrigger value="bir2303" className="flex-1">BIR 2303 Registration</TabsTrigger>
                </TabsList>

                {/* ── TAB 1: BASIC INFO ── */}
                <TabsContent value="basic" className="space-y-4 mt-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5 col-span-2">
                      <Label>Registered Business Name *</Label>
                      <Input value={form.name} onChange={e => f("name", e.target.value)} placeholder="Reyes Enterprises, Inc." />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Trade / Business Style Name</Label>
                      <Input value={form.tradeName} onChange={e => f("tradeName", e.target.value)} placeholder="Reyes Ent." />
                    </div>
                    <div className="space-y-1.5">
                      <Label>TIN *</Label>
                      <Input value={form.tin} onChange={e => f("tin", e.target.value)} placeholder="123-456-789-000" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Business Type *</Label>
                      <Select value={form.businessType} onValueChange={v => f("businessType", v)}>
                        <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                        <SelectContent>
                          {BUSINESS_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select value={form.status} onValueChange={v => f("status", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Registered Address</Label>
                    <Input value={form.address} onChange={e => f("address", e.target.value)} placeholder="123 Ayala Avenue, Makati City, Metro Manila" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Contact Email</Label>
                      <Input type="email" value={form.contactEmail} onChange={e => f("contactEmail", e.target.value)} placeholder="contact@company.com" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Contact Phone</Label>
                      <Input value={form.contactPhone} onChange={e => f("contactPhone", e.target.value)} placeholder="+63-2-8xxx-xxxx" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Fiscal Year Start</Label>
                      <Select value={form.fiscalYearStart} onValueChange={v => f("fiscalYearStart", v)}>
                        <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
                        <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Fiscal Year End</Label>
                      <Select value={form.fiscalYearEnd} onValueChange={v => f("fiscalYearEnd", v)}>
                        <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
                        <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button type="button" onClick={() => setTab("bir2303")} variant="outline">
                      Next: BIR 2303 →
                    </Button>
                  </div>
                </TabsContent>

                {/* ── TAB 2: BIR 2303 ── */}
                <TabsContent value="bir2303" className="space-y-4 mt-4">
                  <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
                    <strong>BIR 2303 — Certificate of Registration</strong><br />
                    These details are taken from the client's Certificate of Registration issued by the BIR. They determine which tax forms must be filed and their deadlines.
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>RDO Code</Label>
                      <Input value={form.rdoCode} onChange={e => f("rdoCode", e.target.value)} placeholder="e.g. 047" maxLength={5} />
                      <p className="text-xs text-muted-foreground">Revenue District Office code from BIR 2303</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Date of Registration</Label>
                      <Input type="date" value={form.registrationDate} onChange={e => f("registrationDate", e.target.value)} />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Line of Business / Industry</Label>
                    <Input value={form.lineOfBusiness} onChange={e => f("lineOfBusiness", e.target.value)} placeholder="e.g. Retail Trade, Manufacturing, IT Services" />
                  </div>

                  <Separator />
                  <div className="space-y-3">
                    <Label className="text-sm font-semibold">Registered Tax Types</Label>
                    <p className="text-xs text-muted-foreground -mt-2">Check all tax types listed on the client's BIR 2303. These determine the auto-generated filing deadlines.</p>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground uppercase tracking-wider">Income Tax</Label>
                      <Select value={form.incomeTaxType || "none"} onValueChange={v => f("incomeTaxType", v === "none" ? "" : v)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select income tax type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not registered / N/A</SelectItem>
                          <SelectItem value="individual">Individual — Form 1701 / 1701Q</SelectItem>
                          <SelectItem value="corporate">Corporate — Form 1702 / 1702Q</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                      <Label className="text-xs text-muted-foreground uppercase tracking-wider">VAT / Percentage Tax</Label>
                      <div className="space-y-2">
                        <div className="flex items-start gap-3">
                          <Checkbox id="vat" checked={form.vatRegistered} onCheckedChange={() => toggle("vatRegistered")} />
                          <div>
                            <label htmlFor="vat" className="text-sm font-medium cursor-pointer">Value-Added Tax (VAT)</label>
                            <p className="text-xs text-muted-foreground">Quarterly 2550Q + SLS/SLP (due 25th of following month)</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox id="pt" checked={form.percentageTaxRegistered} onCheckedChange={() => toggle("percentageTaxRegistered")} />
                          <div>
                            <label htmlFor="pt" className="text-sm font-medium cursor-pointer">Percentage Tax (Non-VAT)</label>
                            <p className="text-xs text-muted-foreground">Quarterly 2551Q (due 25th of following month)</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                      <Label className="text-xs text-muted-foreground uppercase tracking-wider">Withholding Taxes</Label>
                      <div className="space-y-2">
                        <div className="flex items-start gap-3">
                          <Checkbox id="comp" checked={form.withholdsCompensation} onCheckedChange={() => toggle("withholdsCompensation")} />
                          <div>
                            <label htmlFor="comp" className="text-sm font-medium cursor-pointer">Withholding Tax on Compensation</label>
                            <p className="text-xs text-muted-foreground">Monthly 1601C (due 10th) + Annual 1604C (due March 1)</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox id="ewt" checked={form.withholdsEwt} onCheckedChange={() => toggle("withholdsEwt")} />
                          <div>
                            <label htmlFor="ewt" className="text-sm font-medium cursor-pointer">Expanded Withholding Tax (EWT)</label>
                            <p className="text-xs text-muted-foreground">Monthly 0619E (due 10th) + Quarterly 1601EQ + QAP + Annual 1604E (due March 1)</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox id="whtFinal" checked={form.withholdsFinal} onCheckedChange={() => toggle("withholdsFinal")} />
                          <div>
                            <label htmlFor="whtFinal" className="text-sm font-medium cursor-pointer">Final Withholding Tax (FWT)</label>
                            <p className="text-xs text-muted-foreground">Monthly 0619F (due 10th) + Quarterly 1601FQ + Annual 1604F (due March 1)</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                      <Label className="text-xs text-muted-foreground uppercase tracking-wider">Other Taxes</Label>
                      <div className="flex items-start gap-3">
                        <Checkbox id="dst" checked={form.subjectToDst} onCheckedChange={() => toggle("subjectToDst")} />
                        <div>
                          <label htmlFor="dst" className="text-sm font-medium cursor-pointer">Documentary Stamp Tax (DST)</label>
                          <p className="text-xs text-muted-foreground">Monthly Form 2000 (due 5th of following month)</p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                      <Label className="text-xs text-muted-foreground uppercase tracking-wider">Additional Compliance Requirements</Label>
                      <div className="space-y-2">
                        <div className="flex items-start gap-3">
                          <Checkbox id="inv" checked={form.hasInventory} onCheckedChange={() => toggle("hasInventory")} />
                          <div>
                            <label htmlFor="inv" className="text-sm font-medium cursor-pointer">Has Inventory</label>
                            <p className="text-xs text-muted-foreground">Annual Inventory List due January 30</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox id="lessor" checked={form.isLessor} onCheckedChange={() => toggle("isLessor")} />
                          <div>
                            <label htmlFor="lessor" className="text-sm font-medium cursor-pointer">Lessor of Commercial Property</label>
                            <p className="text-xs text-muted-foreground">Lessee Information Statement due January 31</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <Checkbox id="esales" checked={form.isEsalesRequired} onCheckedChange={() => toggle("isEsalesRequired")} />
                          <div>
                            <label htmlFor="esales" className="text-sm font-medium cursor-pointer">eSales Reporting Required</label>
                            <p className="text-xs text-muted-foreground">Monthly eSales report due 8th or 10th (based on TIN last digit)</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between pt-2">
                    <Button type="button" variant="ghost" onClick={() => setTab("basic")}>← Back</Button>
                    <Button onClick={handleCreate} disabled={createClient.isPending}>
                      {createClient.isPending ? "Creating..." : "Create Client"}
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search clients by name, TIN, or type..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1,2,3].map(i => <Skeleton key={i} className="h-56" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">No clients found</p>
            <p className="text-sm mt-1">Try adjusting your search or add a new client.</p>
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
                  <Link href={`/clients/${client.id}`}>
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                      <ExternalLink className="h-3.5 w-3.5" />View & Compliance
                    </Button>
                  </Link>
                  {can(user, "deleteClients") && (
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(client.id, client.name)}>
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
