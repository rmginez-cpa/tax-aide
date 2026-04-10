import { useState, useCallback } from "react";
import { useParams, Link } from "wouter";
import {
  useGetClient, useUpdateClient, useListEngagements, useListDocuments,
  useGetClientCompliance, useGenerateClientDeadlines,
  getGetClientQueryKey, getListEngagementsQueryKey, getGetClientComplianceQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, Building2, Mail, Phone, MapPin, FileText, Briefcase,
  Calendar, ExternalLink, Edit2, Wand2, CheckCircle2, AlertCircle, Clock,
  FileCheck, ChevronDown, ChevronUp, PlayCircle
} from "lucide-react";
import { format, parseISO, isPast } from "date-fns";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const BUSINESS_TYPES = ["Corporation","Sole Proprietorship","Partnership","Cooperative","Non-Profit Organization","One Person Corporation (OPC)","Barangay Micro Business Enterprise (BMBE)"];

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-700",
  for_review: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  filed: "bg-teal-100 text-teal-700",
  completed: "bg-emerald-100 text-emerald-700",
};

const COMPLIANCE_STATUS = {
  filed: { label: "Filed", icon: CheckCircle2, className: "text-emerald-600" },
  pending: { label: "Pending", icon: Clock, className: "text-muted-foreground" },
  overdue: { label: "Overdue", icon: AlertCircle, className: "text-red-600" },
};

const FORM_DESCRIPTIONS: Record<string, string> = {
  "2550M": "Monthly Value-Added Tax Declaration",
  "2550Q": "Quarterly Value-Added Tax Return",
  "2551Q": "Quarterly Percentage Tax Return",
  "1601C": "Monthly Remittance Return — Compensation",
  "1601EQ": "Quarterly Remittance Return — Creditable (EWT)",
  "1604CF": "Annual Information Return — Compensation",
  "1604E": "Annual Information Return — Creditable (EWT)",
  "1702": "Annual Income Tax Return — Corporations",
  "1702Q": "Quarterly Income Tax Return — Corporations",
  "1701": "Annual Income Tax Return — Individuals",
  "1701Q": "Quarterly Income Tax Return — Individuals",
  "2000": "Documentary Stamp Tax Declaration",
  "AFS": "Audited Financial Statements",
  "Alphalist": "Alphalist of Employees/Payees",
  "2316": "Certificate of Compensation Payment/Tax Withheld (Substituted Filing)",
  "AnnexC": "Annex C — Employees Qualified for Substituted Filing",
  "AnnexF": "Annex F — Annual Alphalist of Employees",
  "QAP": "Quarterly Alphalist of Payees (EWT)",
  "SLS": "Summary List of Sales",
  "SLP": "Summary List of Purchases",
  "eSales": "eSales Report",
  "Inventory": "Annual Inventory List",
  "LesseeInfo": "Lessee Information Statement",
};

const FREQUENCY_COLORS = {
  monthly: "bg-blue-50 border-blue-200",
  quarterly: "bg-violet-50 border-violet-200",
  annual: "bg-amber-50 border-amber-200",
};

export default function ClientDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: client, isLoading: loadingClient } = useGetClient(id, { query: { enabled: !!id, queryKey: getGetClientQueryKey(id) } });
  const { data: engagements } = useListEngagements({ clientId: id }, { query: { enabled: !!id, queryKey: getListEngagementsQueryKey({ clientId: id }) } });
  const { data: documents } = useListDocuments({ clientId: id }, { query: { enabled: !!id } });

  const [complianceYear, setComplianceYear] = useState(new Date().getFullYear());
  const [complianceFilter, setComplianceFilter] = useState<"all" | "monthly" | "quarterly" | "annual">("all");
  const { data: compliance, isLoading: loadingCompliance } = useGetClientCompliance(id, { year: complianceYear }, {
    query: { enabled: !!id, queryKey: getGetClientComplianceQueryKey(id, { year: complianceYear }) }
  });

  const updateClient = useUpdateClient();
  const generateDeadlines = useGenerateClientDeadlines();

  const [editOpen, setEditOpen] = useState(false);
  const [editTab, setEditTab] = useState("basic");
  const [generateYear, setGenerateYear] = useState(new Date().getFullYear().toString());
  const [overwrite, setOverwrite] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [bir2303Expanded, setBir2303Expanded] = useState(false);

  // Filing workflow dialog
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowItem, setWorkflowItem] = useState<{
    deadlineId: number | null;
    engagementId: number | null;
    formNumber: string;
    description: string;
    period: string;
    dueDate: string;
  } | null>(null);

  const openWorkflow = useCallback((item: typeof workflowItem) => {
    setWorkflowItem(item);
    setWorkflowOpen(true);
  }, []);

  const handleWorkflowUpdate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetClientComplianceQueryKey(id, { year: complianceYear }) });
  }, [queryClient, id, complianceYear]);

  const [editForm, setEditForm] = useState<any>({});
  const ef = (key: string, val: any) => setEditForm((prev: any) => ({ ...prev, [key]: val }));

  const openEdit = () => {
    if (!client) return;
    setEditForm({
      name: client.name, tin: client.tin, businessType: client.businessType,
      contactEmail: client.contactEmail || "", contactPhone: client.contactPhone || "",
      address: client.address || "", fiscalYearStart: client.fiscalYearStart || "",
      fiscalYearEnd: client.fiscalYearEnd || "", status: client.status,
      tradeName: client.tradeName || "", rdoCode: client.rdoCode || "",
      registrationDate: client.registrationDate || "", lineOfBusiness: client.lineOfBusiness || "",
      incomeTaxType: client.incomeTaxType || "",
      vatRegistered: client.vatRegistered, percentageTaxRegistered: client.percentageTaxRegistered,
      withholdsCompensation: client.withholdsCompensation, withholdsEwt: client.withholdsEwt,
      subjectToDst: client.subjectToDst,
      withholdsFinal: client.withholdsFinal ?? false,
      hasInventory: client.hasInventory ?? false,
      isLessor: client.isLessor ?? false,
      isEsalesRequired: client.isEsalesRequired ?? false,
    });
    setEditOpen(true);
  };

  const handleSave = () => {
    updateClient.mutate({ id, data: {
      name: editForm.name, tin: editForm.tin, businessType: editForm.businessType,
      contactEmail: editForm.contactEmail || null, contactPhone: editForm.contactPhone || null,
      address: editForm.address || null, fiscalYearStart: editForm.fiscalYearStart || null,
      fiscalYearEnd: editForm.fiscalYearEnd || null, status: editForm.status,
      tradeName: editForm.tradeName || null, rdoCode: editForm.rdoCode || null,
      registrationDate: editForm.registrationDate || null, lineOfBusiness: editForm.lineOfBusiness || null,
      incomeTaxType: editForm.incomeTaxType || null,
      vatRegistered: editForm.vatRegistered, percentageTaxRegistered: editForm.percentageTaxRegistered,
      withholdsCompensation: editForm.withholdsCompensation, withholdsEwt: editForm.withholdsEwt,
      subjectToDst: editForm.subjectToDst,
      withholdsFinal: editForm.withholdsFinal,
      hasInventory: editForm.hasInventory, isLessor: editForm.isLessor,
      isEsalesRequired: editForm.isEsalesRequired,
    }}, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetClientQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetClientComplianceQueryKey(id, { year: complianceYear }) });
        setEditOpen(false);
        toast({ title: "Client updated successfully" });
      },
      onError: () => toast({ title: "Failed to update client", variant: "destructive" }),
    });
  };

  const handleGenerateDeadlines = () => {
    const yr = parseInt(generateYear, 10);
    if (!yr || yr < 2020 || yr > 2035) {
      toast({ title: "Please enter a valid year (2020–2035)", variant: "destructive" });
      return;
    }
    generateDeadlines.mutate({ id, data: { year: yr, overwrite } }, {
      onSuccess: (data) => {
        setGenerateOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetClientComplianceQueryKey(id, { year: complianceYear }) });
        toast({ title: data.message });
      },
      onError: () => toast({ title: "Failed to generate deadlines", variant: "destructive" }),
    });
  };

  if (loadingClient) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-48 w-full" /></div>;
  }

  if (!client) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Client not found.</p>
        <Link href="/clients"><Button variant="outline" className="mt-4"><ArrowLeft className="h-4 w-4 mr-2" />Back to Clients</Button></Link>
      </div>
    );
  }

  const hasBir2303 = client.rdoCode || client.registrationDate || client.lineOfBusiness || client.incomeTaxType || client.vatRegistered || client.percentageTaxRegistered || client.withholdsCompensation || client.withholdsEwt || client.subjectToDst || client.withholdsFinal || client.hasInventory || client.isLessor || client.isEsalesRequired;
  const registeredTypes: { label: string; color: string }[] = [];
  if (client.incomeTaxType === "corporate") registeredTypes.push({ label: "1702/1702Q — Corp ITR", color: "bg-emerald-100 text-emerald-700" });
  if (client.incomeTaxType === "individual") registeredTypes.push({ label: "1701/1701Q — Indiv ITR", color: "bg-green-100 text-green-700" });
  if (client.vatRegistered) registeredTypes.push({ label: "2550Q/SLS/SLP — VAT", color: "bg-blue-100 text-blue-700" });
  if (client.percentageTaxRegistered) registeredTypes.push({ label: "2551Q — Percentage Tax", color: "bg-violet-100 text-violet-700" });
  if (client.withholdsCompensation) registeredTypes.push({ label: "1601C/1604C — WHT Comp", color: "bg-amber-100 text-amber-700" });
  if (client.withholdsEwt) registeredTypes.push({ label: "0619E/1601EQ/1604E — EWT", color: "bg-orange-100 text-orange-700" });
  if (client.subjectToDst) registeredTypes.push({ label: "2000 — DST", color: "bg-slate-100 text-slate-700" });
  if (client.withholdsFinal) registeredTypes.push({ label: "Final WHT", color: "bg-violet-100 text-violet-700" });
  if (client.hasInventory) registeredTypes.push({ label: "Annual Inventory List", color: "bg-teal-100 text-teal-700" });
  if (client.isLessor) registeredTypes.push({ label: "Lessee Info Statement", color: "bg-pink-100 text-pink-700" });
  if (client.isEsalesRequired) registeredTypes.push({ label: "eSales Report", color: "bg-indigo-100 text-indigo-700" });

  const filteredCompliance = compliance?.items.filter(item =>
    complianceFilter === "all" || item.frequency === complianceFilter
  ) ?? [];

  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/clients">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold">{client.name}</h2>
            {client.tradeName && <span className="text-muted-foreground text-base">"{client.tradeName}"</span>}
            <Badge variant={client.status === "active" ? "default" : "secondary"}>{client.status}</Badge>
          </div>
          <p className="text-muted-foreground text-sm font-mono">TIN: {client.tin} {client.rdoCode && `• RDO: ${client.rdoCode}`}</p>
        </div>
        {user?.role !== "viewer" && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={openEdit}><Edit2 className="h-4 w-4 mr-1.5" />Edit</Button>
          </div>
        )}
      </div>

      {/* Basic Info + BIR 2303 */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><Building2 className="h-4 w-4" />Client Information</CardTitle>
              {hasBir2303 && (
                <button onClick={() => setBir2303Expanded(!bir2303Expanded)} className="text-xs text-primary flex items-center gap-1">
                  BIR 2303 details {bir2303Expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div><span className="text-muted-foreground">Business Type</span><p className="font-medium">{client.businessType}</p></div>
              {client.lineOfBusiness && <div><span className="text-muted-foreground">Line of Business</span><p className="font-medium">{client.lineOfBusiness}</p></div>}
              {client.contactEmail && <div><span className="text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />Email</span><p>{client.contactEmail}</p></div>}
              {client.contactPhone && <div><span className="text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />Phone</span><p>{client.contactPhone}</p></div>}
              {client.address && <div className="col-span-2"><span className="text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" />Address</span><p>{client.address}</p></div>}
              {client.fiscalYearStart && <div><span className="text-muted-foreground">FY Period</span><p className="font-medium">{client.fiscalYearStart} – {client.fiscalYearEnd || "—"}</p></div>}
            </div>

            {bir2303Expanded && hasBir2303 && (
              <>
                <Separator className="my-3" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">BIR 2303 Certificate of Registration</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {client.rdoCode && <div><span className="text-muted-foreground">RDO Code</span><p className="font-medium font-mono">{client.rdoCode}</p></div>}
                  {client.registrationDate && <div><span className="text-muted-foreground">Date of Registration</span><p className="font-medium">{format(parseISO(client.registrationDate), "MMMM d, yyyy")}</p></div>}
                </div>
                <div className="mt-2">
                  <p className="text-xs text-muted-foreground mb-1.5">Registered Tax Types</p>
                  <div className="flex flex-wrap gap-1.5">
                    {registeredTypes.map(t => (
                      <span key={t.label} className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.color}`}>{t.label}</span>
                    ))}
                    {registeredTypes.length === 0 && <span className="text-xs text-muted-foreground italic">No tax types registered</span>}
                  </div>
                </div>
              </>
            )}

            {!hasBir2303 && user?.role !== "viewer" && (
              <div className="mt-3 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>BIR 2303 details are missing. <button onClick={openEdit} className="underline font-medium">Add registration data</button> to enable automatic deadline generation.</span>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Active Engagements</p>
              <p className="text-3xl font-bold">{engagements?.filter(e => !["completed","filed"].includes(e.status)).length ?? 0}</p>
              <p className="text-xs text-muted-foreground">of {engagements?.length ?? 0} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Documents</p>
              <p className="text-3xl font-bold">{documents?.length ?? 0}</p>
              <p className="text-xs text-muted-foreground">files on record</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── COMPLIANCE CHECKLIST ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><FileCheck className="h-4 w-4" />Annual Compliance Checklist</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">BIR filing requirements based on registered tax types (BIR 2303)</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={String(complianceYear)} onValueChange={v => setComplianceYear(parseInt(v))}>
                <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
              {user?.role !== "viewer" && (
                <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-1.5 h-8 text-xs" disabled={!hasBir2303}>
                      <Wand2 className="h-3.5 w-3.5" />Generate Deadlines
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle>Generate BIR Deadlines</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <p className="text-sm text-muted-foreground">
                        This will create deadline entries for all registered BIR tax forms for the selected year, based on the BIR 2303 registration of <strong>{client.name}</strong>.
                      </p>
                      <div className="space-y-1.5">
                        <Label>Tax Year</Label>
                        <Input value={generateYear} onChange={e => setGenerateYear(e.target.value)} placeholder="e.g. 2025" maxLength={4} />
                      </div>
                      <div className="flex items-start gap-3">
                        <Checkbox id="overwrite" checked={overwrite} onCheckedChange={v => setOverwrite(v as boolean)} />
                        <div>
                          <label htmlFor="overwrite" className="text-sm font-medium cursor-pointer">Replace existing deadlines</label>
                          <p className="text-xs text-muted-foreground">Delete previously generated deadlines for this year before creating new ones.</p>
                        </div>
                      </div>
                      <div className="p-3 bg-muted rounded-md">
                        <p className="text-xs font-medium mb-1.5">Will generate deadlines for:</p>
                        <div className="flex flex-wrap gap-1">
                          {registeredTypes.length > 0 ? registeredTypes.map(t => (
                            <span key={t.label} className={`text-xs px-1.5 py-0.5 rounded font-medium ${t.color}`}>{t.label.split(" — ")[0]}</span>
                          )) : <span className="text-xs text-muted-foreground">No tax types registered</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
                      <Button onClick={handleGenerateDeadlines} disabled={generateDeadlines.isPending || !hasBir2303}>
                        {generateDeadlines.isPending ? "Generating..." : "Generate"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </div>

          {/* Summary row */}
          {compliance && (
            <div className="grid grid-cols-4 gap-3 mt-3">
              {[
                { label: "Total", value: compliance.summary.total, color: "text-foreground" },
                { label: "Filed", value: compliance.summary.filed, color: "text-emerald-600" },
                { label: "Pending", value: compliance.summary.pending, color: "text-muted-foreground" },
                { label: "Overdue", value: compliance.summary.overdue, color: "text-red-600" },
              ].map(s => (
                <div key={s.label} className="text-center p-2 rounded-md bg-muted/40">
                  <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Progress bar */}
          {compliance && compliance.summary.total > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Filing Progress</span>
                <span>{Math.round((compliance.summary.filed / compliance.summary.total) * 100)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(compliance.summary.filed / compliance.summary.total) * 100}%` }} />
              </div>
            </div>
          )}
        </CardHeader>

        <CardContent>
          {/* Filter tabs */}
          <div className="flex gap-1 mb-4">
            {(["all", "monthly", "quarterly", "annual"] as const).map(f => (
              <button key={f} onClick={() => setComplianceFilter(f)} className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${complianceFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {!hasBir2303 ? (
            <div className="py-12 text-center text-muted-foreground">
              <FileCheck className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No BIR 2303 data</p>
              <p className="text-sm mt-1">Add the client's registered tax types to see their compliance checklist.</p>
              {user?.role !== "viewer" && <Button variant="outline" size="sm" className="mt-3" onClick={openEdit}>Add BIR 2303 Data</Button>}
            </div>
          ) : loadingCompliance ? (
            <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : filteredCompliance.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No {complianceFilter !== "all" ? complianceFilter : ""} filings found for {complianceYear}.</div>
          ) : (
            <div className="space-y-1.5">
              {filteredCompliance.map((item, idx) => {
                const statusInfo = COMPLIANCE_STATUS[item.status];
                const StatusIcon = statusInfo.icon;
                const freqColor = FREQUENCY_COLORS[item.frequency];
                const isOverdue = item.status === "overdue";
                const isFiled = item.status === "filed";
                const hasWorkflow = !!(item as any).engagementId;
                const wfStage = (item as any).workflowStage as string | null;
                const wfStatus = (item as any).workflowStatus as string | null;
                const STAGE_SHORT: Record<string, string> = {
                  source_collection: "Sources",
                  draft_return: "Draft",
                  confirmation: "Confirmation",
                  payment: "Payment",
                };
                const STAGE_COLORS: Record<string, string> = {
                  source_collection: "bg-blue-100 text-blue-700",
                  draft_return: "bg-amber-100 text-amber-700",
                  confirmation: "bg-violet-100 text-violet-700",
                  payment: "bg-cyan-100 text-cyan-700",
                };
                const isForReview = wfStatus === "for_review";
                return (
                  <button
                    key={idx}
                    className={`flex items-center gap-3 p-3 rounded-md border w-full text-left transition-colors hover:brightness-95 cursor-pointer ${freqColor} ${isOverdue ? "border-red-300" : ""}`}
                    onClick={() => openWorkflow({
                      deadlineId: (item as any).deadlineId ?? null,
                      engagementId: (item as any).engagementId ?? null,
                      formNumber: item.formNumber,
                      description: item.description,
                      period: item.period,
                      dueDate: item.dueDate,
                    })}
                  >
                    <StatusIcon className={`h-4 w-4 shrink-0 ${statusInfo.className}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold font-mono bg-white border px-1.5 py-0.5 rounded">{item.formNumber}</span>
                        <span className={`text-sm font-medium ${isFiled ? "line-through text-muted-foreground" : ""}`}>
                          {FORM_DESCRIPTIONS[item.formNumber] || item.formNumber}
                        </span>
                        {hasWorkflow && wfStage && !isFiled && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isForReview ? "bg-amber-100 text-amber-700" : STAGE_COLORS[wfStage] || "bg-gray-100 text-gray-700"}`}>
                            {isForReview ? `${STAGE_SHORT[wfStage] || wfStage} · For Review` : `${STAGE_SHORT[wfStage] || wfStage} · In Progress`}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                        <span>{item.period}</span>
                        <span>Due: {format(parseISO(item.dueDate), "MMM d, yyyy")}</span>
                        <span className="capitalize">{item.frequency}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs font-semibold ${statusInfo.className}`}>{statusInfo.label}</span>
                      {!hasWorkflow && !isFiled && (
                        <PlayCircle className="h-4 w-4 text-muted-foreground/60" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Engagements */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Briefcase className="h-4 w-4" />Engagements</CardTitle>
          <Link href={`/engagements?clientId=${id}`}><Button variant="outline" size="sm">View All</Button></Link>
        </CardHeader>
        <CardContent>
          {engagements && engagements.length > 0 ? (
            <div className="space-y-2">
              {engagements.slice(0, 5).map(e => (
                <Link key={e.id} href={`/engagements/${e.id}`}>
                  <div className="flex items-center justify-between p-3 rounded-md border hover:bg-muted/50 transition-colors cursor-pointer">
                    <div>
                      <p className="font-medium text-sm">{e.title}</p>
                      <p className="text-xs text-muted-foreground">{e.period} • {e.taxType}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {e.dueDate && <span className="text-xs text-muted-foreground">{format(parseISO(e.dueDate), "MMM d")}</span>}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[e.status] || STATUS_COLORS.pending}`}>{e.status.replace("_", " ")}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </Link>
              ))}
              {engagements.length > 5 && <p className="text-xs text-muted-foreground text-center py-2">+{engagements.length - 5} more</p>}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No engagements for this client.</p>
          )}
        </CardContent>
      </Card>

      {/* Documents */}
      {documents && documents.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {documents.map(doc => (
                <div key={doc.id} className="flex items-center gap-3 p-3 rounded-md border">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.originalName}</p>
                    <p className="text-xs text-muted-foreground">v{doc.version} • {doc.uploadedByName} • {format(parseISO(doc.createdAt), "MMM d, yyyy")}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{(doc.fileSize / 1024).toFixed(0)} KB</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── EDIT DIALOG ─────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Client: {client.name}</DialogTitle>
          </DialogHeader>
          <Tabs value={editTab} onValueChange={setEditTab}>
            <TabsList className="w-full">
              <TabsTrigger value="basic" className="flex-1">Basic Info</TabsTrigger>
              <TabsTrigger value="bir2303" className="flex-1">BIR 2303 Registration</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5 col-span-2">
                  <Label>Registered Business Name *</Label>
                  <Input value={editForm.name || ""} onChange={e => ef("name", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Trade / Business Style</Label>
                  <Input value={editForm.tradeName || ""} onChange={e => ef("tradeName", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>TIN *</Label>
                  <Input value={editForm.tin || ""} onChange={e => ef("tin", e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Business Type *</Label>
                  <Select value={editForm.businessType || ""} onValueChange={v => ef("businessType", v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{BUSINESS_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select value={editForm.status || "active"} onValueChange={v => ef("status", v)}>
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
                <Input value={editForm.address || ""} onChange={e => ef("address", e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Contact Email</Label>
                  <Input type="email" value={editForm.contactEmail || ""} onChange={e => ef("contactEmail", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Contact Phone</Label>
                  <Input value={editForm.contactPhone || ""} onChange={e => ef("contactPhone", e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Fiscal Year Start</Label>
                  <Select value={editForm.fiscalYearStart || ""} onValueChange={v => ef("fiscalYearStart", v)}>
                    <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
                    <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Fiscal Year End</Label>
                  <Select value={editForm.fiscalYearEnd || ""} onValueChange={v => ef("fiscalYearEnd", v)}>
                    <SelectTrigger><SelectValue placeholder="Month" /></SelectTrigger>
                    <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={() => setEditTab("bir2303")}>Next: BIR 2303 →</Button>
              </div>
            </TabsContent>

            <TabsContent value="bir2303" className="space-y-4 mt-4">
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
                Update the tax types registered in the client's BIR 2303 to keep compliance deadlines accurate.
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>RDO Code</Label>
                  <Input value={editForm.rdoCode || ""} onChange={e => ef("rdoCode", e.target.value)} placeholder="e.g. 047" />
                </div>
                <div className="space-y-1.5">
                  <Label>Date of Registration</Label>
                  <Input type="date" value={editForm.registrationDate || ""} onChange={e => ef("registrationDate", e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Line of Business / Industry</Label>
                <Input value={editForm.lineOfBusiness || ""} onChange={e => ef("lineOfBusiness", e.target.value)} placeholder="e.g. Retail Trade, Manufacturing" />
              </div>
              <Separator />
              <div className="space-y-3">
                <Label className="text-sm font-semibold">Registered Tax Types (from BIR 2303)</Label>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground uppercase">Income Tax</Label>
                  <Select value={editForm.incomeTaxType || "none"} onValueChange={v => ef("incomeTaxType", v === "none" ? "" : v)}>
                    <SelectTrigger><SelectValue placeholder="Select income tax type" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not registered / N/A</SelectItem>
                      <SelectItem value="individual">Individual — Form 1701 / 1701Q</SelectItem>
                      <SelectItem value="corporate">Corporate — Form 1702 / 1702Q</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="p-3 rounded-md border space-y-2 bg-muted/30">
                  <Label className="text-xs text-muted-foreground uppercase">VAT / Percentage Tax</Label>
                  {[
                    { key: "vatRegistered", label: "Value-Added Tax (VAT)", sub: "Quarterly 2550Q + SLS/SLP (due 25th of following month)" },
                    { key: "percentageTaxRegistered", label: "Percentage Tax (Non-VAT)", sub: "Quarterly 2551Q (due 25th of following month)" },
                  ].map(item => (
                    <div key={item.key} className="flex items-start gap-3">
                      <Checkbox checked={!!editForm[item.key]} onCheckedChange={v => ef(item.key, v)} />
                      <div><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.sub}</p></div>
                    </div>
                  ))}
                </div>
                <div className="p-3 rounded-md border space-y-2 bg-muted/30">
                  <Label className="text-xs text-muted-foreground uppercase">Withholding Taxes</Label>
                  {[
                    { key: "withholdsCompensation", label: "Withholding Tax on Compensation", sub: "Monthly 1601C (due 10th) + Annual 1604C (due March 1)" },
                    { key: "withholdsEwt", label: "Expanded Withholding Tax (EWT)", sub: "Monthly 0619E (due 10th) + Quarterly 1601EQ + QAP + Annual 1604E (due March 1)" },
                    { key: "withholdsFinal", label: "Final Withholding Tax (FWT)", sub: "Monthly 0619F (due 10th) + Quarterly 1601FQ + Annual 1604F (due March 1)" },
                  ].map(item => (
                    <div key={item.key} className="flex items-start gap-3">
                      <Checkbox checked={!!editForm[item.key]} onCheckedChange={v => ef(item.key, v)} />
                      <div><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.sub}</p></div>
                    </div>
                  ))}
                </div>
                <div className="p-3 rounded-md border bg-muted/30">
                  <div className="flex items-start gap-3">
                    <Checkbox checked={!!editForm.subjectToDst} onCheckedChange={v => ef("subjectToDst", v)} />
                    <div><p className="text-sm font-medium">Documentary Stamp Tax (DST)</p><p className="text-xs text-muted-foreground">Monthly Form 2000</p></div>
                  </div>
                </div>
                <div className="p-3 rounded-md border space-y-2 bg-muted/30">
                  <Label className="text-xs text-muted-foreground uppercase">Additional Compliance Requirements</Label>
                  {[
                    { key: "hasInventory", label: "Has Inventory", sub: "Annual Inventory List due January 30" },
                    { key: "isLessor", label: "Lessor of Commercial Property", sub: "Lessee Information Statement due January 31" },
                    { key: "isEsalesRequired", label: "eSales Reporting Required", sub: "Monthly eSales report due 8th or 10th (based on TIN last digit)" },
                  ].map(item => (
                    <div key={item.key} className="flex items-start gap-3">
                      <Checkbox checked={!!editForm[item.key]} onCheckedChange={v => ef(item.key, v)} />
                      <div><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.sub}</p></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-between pt-2">
                <Button type="button" variant="ghost" onClick={() => setEditTab("basic")}>← Back</Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
                  <Button onClick={handleSave} disabled={updateClient.isPending}>
                    {updateClient.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Filing Workflow Dialog */}
      {workflowItem && (
        <FilingWorkflowDialog
          open={workflowOpen}
          onClose={() => setWorkflowOpen(false)}
          deadlineId={workflowItem.deadlineId}
          engagementId={workflowItem.engagementId}
          clientId={id}
          formNumber={workflowItem.formNumber}
          description={workflowItem.description}
          period={workflowItem.period}
          dueDate={workflowItem.dueDate}
          onUpdate={handleWorkflowUpdate}
        />
      )}
    </div>
  );
}
