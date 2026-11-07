import { useState, useCallback } from "react";
import { useParams, Link, useLocation, useSearchParams } from "wouter";
import {
  useGetClient, useUpdateClient, useDeleteClient, useListEngagements, useListDocuments,
  useGetClientCompliance, useGenerateClientDeadlines,
  getGetClientQueryKey, getListEngagementsQueryKey, getGetClientComplianceQueryKey, getListDocumentsQueryKey,
  type ComplianceItem, type Document as ClientDocument,
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  ArrowLeft, Building2, Mail, Phone, MapPin, FileText, Briefcase,
  ExternalLink, Edit2, Wand2, CheckCircle2, AlertCircle, Clock,
  FileCheck, ChevronDown, ChevronUp, PlayCircle, Search, X, Trash2,
  Inbox, PenLine, Receipt, CreditCard, MinusCircle, type LucideIcon,
} from "lucide-react";
import { can } from "@/lib/permissions";
import { errorMessage, errorStatus } from "@/lib/api";
import { formatBytes, formatDate, manilaToday } from "@/lib/format";
import { invalidateFilingData } from "@/lib/queries";
import {
  COMPLIANCE_STATUS, FILING_STAGES, FILING_STAGE_KEYS, STAGE_STATUS_ICON_CLASS,
  getEngagementStatus, getStageStatus, type FilingStageKey,
} from "@/lib/status";
import { useConfirm } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { FileViewer } from "@/components/FileViewer";
import { FilingWorkflowDialog } from "@/components/FilingWorkflowDialog";
import { ClientForm, clientToFormValues } from "@/components/ClientForm";

const COMPLIANCE_ICONS: Record<string, LucideIcon> = {
  filed: CheckCircle2,
  pending: Clock,
  overdue: AlertCircle,
};

/** Checklist labels per formNumber (codes from extractFormNumber in api-server routes/clients.ts). */
const FORM_DESCRIPTIONS: Record<string, string> = {
  "2550Q": "Quarterly Value-Added Tax Return",
  "2551Q": "Quarterly Percentage Tax Return",
  "1601C": "Monthly Remittance Return — Compensation",
  "0619E": "Monthly Remittance Form — Creditable (EWT)",
  "0619F": "Monthly Remittance Form — Final Withholding",
  "1601EQ": "Quarterly Remittance Return — Creditable (EWT)",
  "1601FQ": "Quarterly Remittance Return — Final Withholding",
  "1604C": "Annual Information Return — Compensation",
  "1604E": "Annual Information Return — Creditable (EWT)",
  "1604F": "Annual Information Return — Final Withholding",
  "1702": "Annual Income Tax Return — Corporations",
  "1702Q": "Quarterly Income Tax Return — Corporations",
  "1701": "Annual Income Tax Return — Individuals",
  "1701Q": "Quarterly Income Tax Return — Individuals",
  "2000": "Documentary Stamp Tax Declaration",
  "AFS": "Audited Financial Statements",
  "Alphalist": "Alphalist of Employees/Payees",
  "Alphalist-1604C": "Alphalist of Employees (1604C attachment)",
  "Alphalist-1604E": "Annual Alphalist of Payees (1604E attachment)",
  "2316-Issue": "Certificate of Compensation Payment/Tax Withheld — Issue to Employees",
  "2316": "Certificate of Compensation Payment/Tax Withheld — Substituted Filing Duplicates",
  "AnnexC": "Annex C — Payor's Sworn Declaration (payees' Annex B)",
  "AnnexF": "Annex F — Employees Qualified for Substituted Filing",
  "QAP": "Quarterly Alphalist of Payees (EWT)",
  "QAP-Final": "Quarterly Alphalist of Payees (Final Withholding)",
  "SLS": "Summary List of Sales",
  "SLP": "Summary List of Purchases",
  "eSales": "eSales Report",
  "Inventory": "Annual Inventory List",
  "LesseeInfo": "Lessee Information Statement",
};

const FREQUENCY_COLORS: Record<string, string> = {
  monthly: "bg-blue-50 border-blue-200",
  quarterly: "bg-violet-50 border-violet-200",
  annual: "bg-amber-50 border-amber-200",
};

const STAGE_ICONS: Record<FilingStageKey, LucideIcon> = {
  source_collection: Inbox,
  draft_return: PenLine,
  confirmation: Receipt,
  payment: CreditCard,
};

const FREQUENCIES = ["all", "monthly", "quarterly", "annual"] as const;
type Frequency = (typeof FREQUENCIES)[number];
const WF_FILTERS = ["in_progress", "for_review", "overdue"] as const;
const WF_LABELS: Record<string, string> = { in_progress: "In progress", for_review: "For review", overdue: "Overdue" };

/** Stable React key of a checklist row: its deadline, else its form + period (unique per tax year). */
function complianceKey(item: ComplianceItem): string {
  return item.deadlineId != null ? `d${item.deadlineId}` : `${item.formNumber}|${item.period}`;
}

function hasStageForReview(item: ComplianceItem): boolean {
  return Object.values(item.stageStatuses ?? {}).includes("for_review");
}

interface WorkflowItem {
  deadlineId: number | null;
  engagementId: number | null;
  formNumber: string;
  description: string;
  period: string;
  dueDate: string;
}

export default function ClientDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [, setLocation] = useLocation();

  const clientQuery = useGetClient(id, { query: { enabled: !!id, queryKey: getGetClientQueryKey(id) } });
  const client = clientQuery.data;
  const engagementsQuery = useListEngagements({ clientId: id }, { query: { enabled: !!id, queryKey: getListEngagementsQueryKey({ clientId: id }) } });
  const engagements = engagementsQuery.data;
  const documentsQuery = useListDocuments({ clientId: id }, { query: { enabled: !!id, queryKey: getListDocumentsQueryKey({ clientId: id }) } });
  const documents = documentsQuery.data;

  // ── Checklist filters live in the URL (?year=&freq=&q=&from=&to=&wf=) ────────
  const currentYear = Number(manilaToday().slice(0, 4));
  const [searchParams, setSearchParams] = useSearchParams();
  const yearParam = Number(searchParams.get("year"));
  // The tax year shown by default is the current Manila year, as on the server.
  const complianceYear = Number.isInteger(yearParam) && yearParam >= 1900 && yearParam <= 9999 ? yearParam : currentYear;
  const freqParam = searchParams.get("freq") as Frequency | null;
  const complianceFilter: Frequency = freqParam && FREQUENCIES.includes(freqParam) ? freqParam : "all";
  const complianceSearch = searchParams.get("q") ?? "";
  const dateFrom = searchParams.get("from") ?? "";
  const dateTo = searchParams.get("to") ?? "";
  const wfParam = searchParams.get("wf") ?? "";
  const wfFilter = (WF_FILTERS as readonly string[]).includes(wfParam) ? wfParam : "";

  const setParams = useCallback((updates: Record<string, string | number | null>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") next.delete(k); else next.set(k, String(v));
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const setComplianceYear = (y: number) => setParams({ year: y === currentYear ? null : y });

  const complianceQuery = useGetClientCompliance(id, { year: complianceYear }, {
    query: { enabled: !!id, queryKey: getGetClientComplianceQueryKey(id, { year: complianceYear }) }
  });
  const compliance = complianceQuery.data;

  const updateClient = useUpdateClient();
  const deleteClient = useDeleteClient();
  const generateDeadlines = useGenerateClientDeadlines();

  const [editOpen, setEditOpen] = useState(false);
  const [generateYear, setGenerateYear] = useState(String(currentYear));
  const [overwrite, setOverwrite] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [bir2303Expanded, setBir2303Expanded] = useState(false);
  const [viewerDoc, setViewerDoc] = useState<ClientDocument | null>(null);

  // Filing workflow dialog
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [workflowItem, setWorkflowItem] = useState<WorkflowItem | null>(null);
  const [workflowSeq, setWorkflowSeq] = useState(0);

  const openWorkflow = useCallback((item: WorkflowItem) => {
    setWorkflowItem(item);
    setWorkflowSeq(n => n + 1);
    setWorkflowOpen(true);
  }, []);

  const handleWorkflowUpdate = useCallback(() => {
    void invalidateFilingData(queryClient);
  }, [queryClient]);

  // Tax years offered by the checklist and by Generate Deadlines (Manila years).
  const yearOptions = [currentYear - 3, currentYear - 2, currentYear - 1, currentYear, currentYear + 1];
  if (!yearOptions.includes(complianceYear)) yearOptions.push(complianceYear);
  yearOptions.sort((a, b) => a - b);
  const generateYearOptions = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  const openGenerate = (open: boolean) => {
    if (open) {
      setGenerateYear(String(generateYearOptions.includes(complianceYear) ? complianceYear : currentYear));
      setOverwrite(false);
    }
    setGenerateOpen(open);
  };

  const handleSave = async (payload: Parameters<typeof updateClient.mutateAsync>[0]["data"]) => {
    try {
      await updateClient.mutateAsync({ id, data: payload });
    } catch (e) {
      toast({ title: "Failed to update client", description: errorMessage(e), variant: "destructive" });
      throw e;
    }
    await invalidateFilingData(queryClient);
    setEditOpen(false);
    toast({ title: "Client updated successfully" });
  };

  const handleDelete = () => {
    if (!client) return;
    void confirm({
      title: `Delete client "${client.name}"?`,
      description: "This removes the client and its generated deadlines and cannot be undone. A client with filings or documents cannot be deleted: set it to inactive instead (Edit → Status).",
      confirmLabel: "Delete client",
      destructive: true,
      onConfirm: async () => {
        await deleteClient.mutateAsync({ id });
        toast({ title: "Client deleted" });
        setLocation("/clients");
        await invalidateFilingData(queryClient);
      },
    });
  };

  const handleGenerateDeadlines = async () => {
    const yr = parseInt(generateYear, 10);
    if (!generateYearOptions.includes(yr)) {
      toast({ title: "Please choose a tax year", variant: "destructive" });
      return;
    }
    if (overwrite) {
      const ok = await confirm({
        title: `Replace existing deadlines for ${yr}?`,
        description: `Existing ${yr} deadlines of ${client?.name ?? "this client"} get the current due dates, descriptions and priorities (their status and linked filings are kept). Generated deadlines that no longer apply to the BIR 2303 registration are removed, unless they are completed or linked to a filing. Missing deadlines are created.`,
        confirmLabel: "Replace deadlines",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      const data = await generateDeadlines.mutateAsync({ id, data: { year: yr, overwrite } });
      setGenerateOpen(false);
      setComplianceYear(yr);
      await invalidateFilingData(queryClient);
      toast({ title: data.message });
    } catch (e) {
      toast({ title: "Failed to generate deadlines", description: errorMessage(e), variant: "destructive" });
    }
  };

  if (clientQuery.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-48 w-full" /></div>;
  }

  if (clientQuery.isError && errorStatus(clientQuery.error) !== 404) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm"><Link href="/clients"><ArrowLeft className="h-4 w-4 mr-2" />Back to Clients</Link></Button>
        <ErrorState title="Could not load this client" error={clientQuery.error} onRetry={clientQuery.refetch} />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Client not found.</p>
        <Button asChild variant="outline" className="mt-4"><Link href="/clients"><ArrowLeft className="h-4 w-4 mr-2" />Back to Clients</Link></Button>
      </div>
    );
  }

  const hasBir2303 = client.rdoCode || client.registrationDate || client.lineOfBusiness || client.incomeTaxType || client.vatRegistered || client.percentageTaxRegistered || client.withholdsCompensation || client.withholdsEwt || client.subjectToDst || client.withholdsFinal || client.hasInventory || client.isLessor || client.isEsalesRequired;
  const registeredTypes: { label: string; color: string }[] = [];
  if (client.incomeTaxType === "corporate") registeredTypes.push({ label: "1702/1702Q — Corp ITR", color: "bg-emerald-100 text-emerald-700" });
  if (client.incomeTaxType === "individual") registeredTypes.push({ label: "1701/1701Q — Indiv ITR", color: "bg-green-100 text-green-700" });
  if (client.vatRegistered) registeredTypes.push({ label: "2550Q/SLS/SLP — VAT", color: "bg-blue-100 text-blue-700" });
  if (client.percentageTaxRegistered) registeredTypes.push({ label: "2551Q — Percentage Tax", color: "bg-violet-100 text-violet-700" });
  if (client.withholdsCompensation) registeredTypes.push({ label: "1601C/1604C/2316 — WHT Comp", color: "bg-amber-100 text-amber-700" });
  if (client.withholdsEwt) registeredTypes.push({ label: "0619E/1601EQ/1604E — EWT", color: "bg-orange-100 text-orange-700" });
  if (client.subjectToDst) registeredTypes.push({ label: "2000 — DST", color: "bg-slate-100 text-slate-700" });
  if (client.withholdsFinal) registeredTypes.push({ label: "0619F/1601FQ/1604F — Final WHT", color: "bg-violet-100 text-violet-700" });
  if (client.hasInventory) registeredTypes.push({ label: "Annual Inventory List", color: "bg-teal-100 text-teal-700" });
  if (client.isLessor) registeredTypes.push({ label: "Lessee Info Statement", color: "bg-pink-100 text-pink-700" });
  if (client.isEsalesRequired) registeredTypes.push({ label: "eSales Report", color: "bg-indigo-100 text-indigo-700" });

  const filteredCompliance = compliance?.items.filter(item => {
    if (complianceFilter !== "all" && item.frequency !== complianceFilter) return false;
    if (complianceSearch.trim()) {
      const q = complianceSearch.trim().toLowerCase();
      const label = FORM_DESCRIPTIONS[item.formNumber] ?? "";
      if (
        !item.formNumber.toLowerCase().includes(q) &&
        !label.toLowerCase().includes(q) &&
        !item.description.toLowerCase().includes(q) &&
        !(item.period ?? "").toLowerCase().includes(q)
      ) return false;
    }
    if (dateFrom && item.dueDate < dateFrom) return false;
    if (dateTo && item.dueDate > dateTo) return false;
    if (wfFilter === "overdue" && item.status !== "overdue") return false;
    if (wfFilter === "in_progress" && item.workflowStatus !== "in_progress") return false;
    // Engagement status never becomes "for_review": a stage does (matches the client-list badge).
    if (wfFilter === "for_review" && !hasStageForReview(item)) return false;
    return true;
  }) ?? [];

  const activeEngagements = engagements?.filter(e => !["completed", "filed"].includes(e.status)).length ?? 0;

  return (
    <div className="space-y-6 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button asChild variant="ghost" size="icon" aria-label="Back to clients">
          <Link href="/clients"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-2xl font-bold break-words min-w-0">{client.name}</h2>
            {client.tradeName && <span className="text-muted-foreground text-base">"{client.tradeName}"</span>}
            <Badge variant={client.status === "active" ? "default" : "secondary"}>{client.status}</Badge>
          </div>
          <p className="text-muted-foreground text-sm font-mono break-words">TIN: {client.tin} {client.rdoCode && `• RDO: ${client.rdoCode}`}</p>
        </div>
        {(can(user, "manageClients") || can(user, "deleteClients")) && (
          <div className="flex gap-2">
            {can(user, "manageClients") && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}><Edit2 className="h-4 w-4 mr-1.5" />Edit</Button>
            )}
            {can(user, "deleteClients") && (
              <Button variant="outline" size="sm" className="text-muted-foreground hover:text-destructive" onClick={handleDelete}>
                <Trash2 className="h-4 w-4 mr-1.5" />Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Basic Info + BIR 2303 */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2 min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2"><Building2 className="h-4 w-4" />Client Information</CardTitle>
              {hasBir2303 && (
                <button
                  type="button"
                  onClick={() => setBir2303Expanded(!bir2303Expanded)}
                  aria-expanded={bir2303Expanded}
                  className="text-xs text-primary flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  BIR 2303 details {bir2303Expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 [&>div]:min-w-0 [&_p]:break-words">
              <div><span className="text-muted-foreground">Business Type</span><p className="font-medium">{client.businessType}</p></div>
              {client.lineOfBusiness && <div><span className="text-muted-foreground">Line of Business</span><p className="font-medium">{client.lineOfBusiness}</p></div>}
              {client.contactEmail && <div><span className="text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />Email</span><p className="break-all">{client.contactEmail}</p></div>}
              {client.contactPhone && <div><span className="text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />Phone</span><p>{client.contactPhone}</p></div>}
              {client.address && <div className="sm:col-span-2"><span className="text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" />Address</span><p>{client.address}</p></div>}
              {client.fiscalYearStart && <div><span className="text-muted-foreground">FY Period</span><p className="font-medium">{client.fiscalYearStart} – {client.fiscalYearEnd || "—"}</p></div>}
            </div>

            {bir2303Expanded && hasBir2303 && (
              <>
                <Separator className="my-3" />
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">BIR 2303 Certificate of Registration</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {client.rdoCode && <div><span className="text-muted-foreground">RDO Code</span><p className="font-medium font-mono">{client.rdoCode}</p></div>}
                  {client.registrationDate && <div><span className="text-muted-foreground">Date of Registration</span><p className="font-medium">{formatDate(client.registrationDate, "long")}</p></div>}
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

            {!hasBir2303 && can(user, "manageClients") && (
              <div className="mt-3 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>BIR 2303 details are missing. <button type="button" onClick={() => setEditOpen(true)} className="underline font-medium">Add registration data</button> to enable automatic deadline generation.</span>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Active Engagements</p>
              <p className="text-3xl font-bold">{engagementsQuery.isError ? "—" : activeEngagements}</p>
              <p className="text-xs text-muted-foreground">of {engagements?.length ?? 0} total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground mb-1">Documents</p>
              <p className="text-3xl font-bold">{documentsQuery.isError ? "—" : documents?.length ?? 0}</p>
              <p className="text-xs text-muted-foreground">files on record</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── COMPLIANCE CHECKLIST ──────────────────────────────────────────── */}
      <Card className="min-w-0">
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2"><FileCheck className="h-4 w-4" />Annual Compliance Checklist</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">BIR filing requirements based on registered tax types (BIR 2303)</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={String(complianceYear)} onValueChange={v => setComplianceYear(parseInt(v, 10))}>
                <SelectTrigger className="w-28 h-8 text-xs" aria-label="Tax year"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
              {can(user, "manageDeadlines") && (
                <Dialog open={generateOpen} onOpenChange={openGenerate}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-1.5 h-8 text-xs" disabled={!hasBir2303}>
                      <Wand2 className="h-3.5 w-3.5" />Generate Deadlines
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle>Generate BIR Deadlines</DialogTitle>
                      <DialogDescription>
                        Creates the missing deadline entries for all registered BIR tax forms of the selected tax year, based on the BIR 2303 registration of <strong>{client.name}</strong>.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="generate-year">Tax Year</Label>
                        <Select value={generateYear} onValueChange={setGenerateYear}>
                          <SelectTrigger id="generate-year"><SelectValue placeholder="Select year" /></SelectTrigger>
                          <SelectContent>
                            {generateYearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-start gap-3">
                        <Checkbox id="overwrite" checked={overwrite} onCheckedChange={v => setOverwrite(v === true)} className="mt-0.5" aria-describedby="overwrite-help" />
                        <div>
                          <label htmlFor="overwrite" className="text-sm font-medium cursor-pointer">Replace existing deadlines</label>
                          <p id="overwrite-help" className="text-xs text-muted-foreground">Update the due dates of existing items for this year and remove generated items that no longer apply (unless completed or linked to a filing).</p>
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
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
            <div className="grid grid-cols-4 gap-2 sm:gap-3 mt-3">
              {[
                { label: "Total", value: compliance.summary.total, color: "text-foreground" },
                { label: "Filed", value: compliance.summary.filed, color: "text-emerald-600" },
                { label: "Pending", value: compliance.summary.pending, color: "text-muted-foreground" },
                { label: "Overdue", value: compliance.summary.overdue, color: "text-red-600" },
              ].map(s => (
                <div key={s.label} className="text-center p-2 rounded-md bg-muted/40 min-w-0">
                  <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-xs text-muted-foreground truncate">{s.label}</p>
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
          <div className="flex flex-wrap items-center gap-1 mb-3" role="group" aria-label="Filter by frequency">
            {FREQUENCIES.map(f => (
              <button
                key={f}
                type="button"
                aria-pressed={complianceFilter === f}
                onClick={() => setParams({ freq: f === "all" ? null : f })}
                className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${complianceFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            {wfFilter && (
              <span className={`ml-1 inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full border font-medium ${
                wfFilter === "overdue" ? "bg-red-50 text-red-700 border-red-200" :
                wfFilter === "for_review" ? "bg-amber-50 text-amber-700 border-amber-200" :
                "bg-blue-50 text-blue-700 border-blue-200"
              }`}>
                {WF_LABELS[wfFilter]}
                <button type="button" onClick={() => setParams({ wf: null })} className="ml-0.5 opacity-60 hover:opacity-100" aria-label={`Clear "${WF_LABELS[wfFilter]}" filter`} title="Clear filter">
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>

          {/* Search + date-range filters */}
          <div className="flex flex-wrap gap-2 mb-4">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={complianceSearch}
                onChange={e => setParams({ q: e.target.value })}
                placeholder="Search form, description, period…"
                aria-label="Search filings"
                className="pl-8 h-8 text-xs"
              />
            </div>
            <Input
              type="date"
              value={dateFrom}
              onChange={e => setParams({ from: e.target.value })}
              className="w-36 h-8 text-xs"
              aria-label="Due date from"
              title="Due date from"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={e => setParams({ to: e.target.value })}
              className="w-36 h-8 text-xs"
              aria-label="Due date to"
              title="Due date to"
            />
            {(complianceSearch || dateFrom || dateTo) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground"
                onClick={() => setParams({ q: null, from: null, to: null })}
              >
                <X className="h-3.5 w-3.5 mr-1" />Clear
              </Button>
            )}
          </div>

          {!hasBir2303 ? (
            <div className="py-12 text-center text-muted-foreground">
              <FileCheck className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No BIR 2303 data</p>
              <p className="text-sm mt-1">Add the client's registered tax types to see their compliance checklist.</p>
              {can(user, "manageClients") && <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditOpen(true)}>Add BIR 2303 Data</Button>}
            </div>
          ) : complianceQuery.isError ? (
            <ErrorState title="Could not load the compliance checklist" error={complianceQuery.error} onRetry={complianceQuery.refetch} />
          ) : complianceQuery.isLoading ? (
            <div className="space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : filteredCompliance.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No {complianceFilter !== "all" ? complianceFilter : ""} filings found for {complianceYear}.</div>
          ) : (
            <div className="space-y-1.5">
              {filteredCompliance.map(item => {
                const statusInfo = COMPLIANCE_STATUS[item.status] ?? COMPLIANCE_STATUS.pending;
                const StatusIcon = COMPLIANCE_ICONS[item.status] ?? Clock;
                const freqColor = FREQUENCY_COLORS[item.frequency] ?? FREQUENCY_COLORS.annual;
                const isOverdue = item.status === "overdue";
                const isFiled = item.status === "filed";
                const hasWorkflow = !!item.engagementId;
                const wfStage = (item.workflowStage ?? null) as FilingStageKey | null;
                const stageInfo = wfStage ? FILING_STAGES[wfStage] : undefined;
                const isForReview = hasStageForReview(item);
                return (
                  <button
                    key={complianceKey(item)}
                    type="button"
                    className={`flex items-center gap-3 p-3 rounded-md border w-full text-left transition-colors hover:brightness-95 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${freqColor} ${isOverdue ? "border-red-300" : ""}`}
                    onClick={() => openWorkflow({
                      deadlineId: item.deadlineId ?? null,
                      engagementId: item.engagementId ?? null,
                      formNumber: item.formNumber,
                      description: item.description,
                      period: item.period,
                      dueDate: item.dueDate,
                    })}
                  >
                    <StatusIcon className={`h-4 w-4 shrink-0 ${statusInfo.className}`} aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold font-mono bg-white border px-1.5 py-0.5 rounded">{item.formNumber}</span>
                        <span className={`text-sm font-medium min-w-0 break-words ${isFiled ? "line-through text-muted-foreground" : ""}`}>
                          {FORM_DESCRIPTIONS[item.formNumber] || item.formNumber}
                        </span>
                        {hasWorkflow && wfStage && !isFiled && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isForReview ? "bg-amber-100 text-amber-700" : stageInfo?.className || "bg-gray-100 text-gray-700"}`}>
                            {`${stageInfo?.shortLabel || wfStage} · ${isForReview ? "For Review" : "In Progress"}`}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5 flex-wrap">
                        <span>{item.period}</span>
                        <span>Due: {formatDate(item.dueDate)}</span>
                        <span className="capitalize">{item.frequency}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {hasWorkflow && item.stageStatuses && (
                        <div className="hidden sm:flex items-center gap-0.5">
                          {FILING_STAGE_KEYS.map(key => {
                            const status = (item.stageStatuses as Record<string, string | undefined>)[key] ?? "not_started";
                            const IconComp = status === "not_applicable" ? MinusCircle : STAGE_ICONS[key];
                            return (
                              <span key={key} title={`${FILING_STAGES[key].label}: ${getStageStatus(status).label}`}>
                                <IconComp className={`h-3.5 w-3.5 ${STAGE_STATUS_ICON_CLASS[status] ?? "text-muted-foreground/25"}`} aria-hidden="true" />
                              </span>
                            );
                          })}
                        </div>
                      )}
                      <span className={`text-xs font-semibold ${statusInfo.className}`}>{statusInfo.label}</span>
                      {!hasWorkflow && !isFiled && (
                        <PlayCircle className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
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
      <Card className="min-w-0">
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2"><Briefcase className="h-4 w-4" />Engagements</CardTitle>
          <Button asChild variant="outline" size="sm">
            <Link href={`/engagements?clientId=${id}`}>View All</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {engagementsQuery.isError ? (
            <ErrorState compact title="Could not load engagements" error={engagementsQuery.error} onRetry={engagementsQuery.refetch} />
          ) : engagementsQuery.isLoading ? (
            <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-14" />)}</div>
          ) : engagements && engagements.length > 0 ? (
            <div className="space-y-2">
              {engagements.slice(0, 5).map(e => {
                const st = getEngagementStatus(e.status);
                return (
                  <Link
                    key={e.id}
                    href={`/engagements/${e.id}`}
                    className="flex items-center justify-between gap-3 p-3 rounded-md border hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm break-words">{e.title}</p>
                      <p className="text-xs text-muted-foreground">{e.period} • {e.taxType}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {e.dueDate && <span className="text-xs text-muted-foreground">{formatDate(e.dueDate, "monthDay")}</span>}
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${st.className}`}>{st.label}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    </div>
                  </Link>
                );
              })}
              {engagements.length > 5 && (
                <Link href={`/engagements?clientId=${id}`} className="block text-xs text-muted-foreground text-center py-2 hover:underline">
                  +{engagements.length - 5} more
                </Link>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No engagements for this client.</p>
          )}
        </CardContent>
      </Card>

      {/* Documents */}
      {documentsQuery.isError ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle></CardHeader>
          <CardContent>
            <ErrorState compact title="Could not load documents" error={documentsQuery.error} onRetry={documentsQuery.refetch} />
          </CardContent>
        </Card>
      ) : documents && documents.length > 0 && (
        <Card className="min-w-0">
          <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" />Documents</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {documents.map(doc => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setViewerDoc(doc)}
                  aria-label={`View ${doc.originalName}`}
                  className="flex items-center gap-3 p-3 rounded-md border w-full text-left hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.originalName}</p>
                    <p className="text-xs text-muted-foreground truncate">v{doc.version} • {doc.uploadedByName ?? "—"} • {formatDate(doc.createdAt)}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{formatBytes(doc.fileSize)}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── EDIT DIALOG ─────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="break-words pr-6">Edit Client: {client.name}</DialogTitle>
            <DialogDescription className="sr-only">Update the client's basic information and BIR 2303 registration.</DialogDescription>
          </DialogHeader>
          {/* Mounted per open, so it always starts from the saved client. */}
          <ClientForm
            initialValues={clientToFormValues(client)}
            onSubmit={handleSave}
            onCancel={() => setEditOpen(false)}
            submitLabel="Save Changes"
            pendingLabel="Saving..."
            pending={updateClient.isPending}
            birIntro="Update the tax types registered in the client's BIR 2303 to keep compliance deadlines accurate. After a change, use Generate Deadlines with “Replace existing deadlines” to refresh this year's items."
          />
        </DialogContent>
      </Dialog>

      <FileViewer doc={viewerDoc} onClose={() => setViewerDoc(null)} />

      {/* Filing Workflow Dialog: keyed per opening and filing, so no state carries over from the previous item. */}
      {workflowItem && (
        <FilingWorkflowDialog
          key={`${workflowSeq}-${workflowItem.deadlineId ?? "new"}-${workflowItem.engagementId ?? "none"}-${workflowItem.formNumber}-${workflowItem.period}`}
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
