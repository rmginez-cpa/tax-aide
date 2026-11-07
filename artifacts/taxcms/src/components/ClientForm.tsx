// Shared Add/Edit client form: "Basic Info" + "BIR 2303 Registration" tabs with one
// footer (Save is reachable from either tab). Every field is always sent, so no
// BIR 2303 flag can be dropped by one of the dialogs.
//
//   <ClientForm
//     initialValues={client ? clientToFormValues(client) : EMPTY_CLIENT_FORM}
//     submitLabel="Create Client"
//     onSubmit={payload => createClient.mutateAsync({ data: payload })}
//     onCancel={() => setOpen(false)}
//   />
//
// Due-date help text mirrors generateBIRDeadlines (api-server routes/clients.ts) and
// the "BIR due-date rules" table in replit.md.

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { Client, CreateClientBody } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TIN_PATTERN } from "@/lib/policy";

export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export const BUSINESS_TYPES = ["Corporation","Sole Proprietorship","Partnership","Cooperative","Non-Profit Organization","One Person Corporation (OPC)","Barangay Micro Business Enterprise (BMBE)"];

export { TIN_PATTERN };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RDO_PATTERN = /^\d{1,3}[A-Za-z]?$/;

/** The flags on BIR 2303 that drive deadline generation. */
const BIR_FLAGS = [
  "vatRegistered", "percentageTaxRegistered", "withholdsCompensation", "withholdsEwt",
  "subjectToDst", "withholdsFinal", "hasInventory", "isLessor", "isEsalesRequired",
] as const;
type BirFlag = (typeof BIR_FLAGS)[number];

export interface ClientFormValues extends Record<BirFlag, boolean> {
  name: string;
  tin: string;
  businessType: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  status: "active" | "inactive";
  tradeName: string;
  rdoCode: string;
  registrationDate: string;
  lineOfBusiness: string;
  incomeTaxType: "" | "individual" | "corporate";
}

export const EMPTY_CLIENT_FORM: ClientFormValues = {
  name: "", tin: "", businessType: "", contactEmail: "", contactPhone: "",
  address: "", fiscalYearStart: "", fiscalYearEnd: "", status: "active",
  tradeName: "", rdoCode: "", registrationDate: "", lineOfBusiness: "",
  incomeTaxType: "",
  vatRegistered: false, percentageTaxRegistered: false,
  withholdsCompensation: false, withholdsEwt: false, subjectToDst: false,
  withholdsFinal: false, hasInventory: false, isLessor: false, isEsalesRequired: false,
};

/** Form values for an existing client (nulls become empty strings / false). */
export function clientToFormValues(client: Client): ClientFormValues {
  const it = client.incomeTaxType;
  return {
    name: client.name ?? "",
    tin: client.tin ?? "",
    businessType: client.businessType ?? "",
    contactEmail: client.contactEmail ?? "",
    contactPhone: client.contactPhone ?? "",
    address: client.address ?? "",
    fiscalYearStart: client.fiscalYearStart ?? "",
    fiscalYearEnd: client.fiscalYearEnd ?? "",
    status: client.status === "inactive" ? "inactive" : "active",
    tradeName: client.tradeName ?? "",
    rdoCode: client.rdoCode ?? "",
    registrationDate: client.registrationDate ?? "",
    lineOfBusiness: client.lineOfBusiness ?? "",
    incomeTaxType: it === "individual" || it === "corporate" ? it : "",
    vatRegistered: !!client.vatRegistered,
    percentageTaxRegistered: !!client.percentageTaxRegistered,
    withholdsCompensation: !!client.withholdsCompensation,
    withholdsEwt: !!client.withholdsEwt,
    subjectToDst: !!client.subjectToDst,
    withholdsFinal: !!client.withholdsFinal,
    hasInventory: !!client.hasInventory,
    isLessor: !!client.isLessor,
    isEsalesRequired: !!client.isEsalesRequired,
  };
}

/** The full create/update body: every field, empty strings as null. */
export function toClientPayload(v: ClientFormValues): CreateClientBody {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  return {
    name: v.name.trim(),
    tin: v.tin.trim(),
    businessType: v.businessType,
    contactEmail: opt(v.contactEmail),
    contactPhone: opt(v.contactPhone),
    address: opt(v.address),
    fiscalYearStart: opt(v.fiscalYearStart),
    fiscalYearEnd: opt(v.fiscalYearEnd),
    status: v.status,
    tradeName: opt(v.tradeName),
    rdoCode: opt(v.rdoCode),
    registrationDate: opt(v.registrationDate),
    lineOfBusiness: opt(v.lineOfBusiness),
    incomeTaxType: v.incomeTaxType || null,
    vatRegistered: v.vatRegistered,
    percentageTaxRegistered: v.percentageTaxRegistered,
    withholdsCompensation: v.withholdsCompensation,
    withholdsEwt: v.withholdsEwt,
    subjectToDst: v.subjectToDst,
    withholdsFinal: v.withholdsFinal,
    hasInventory: v.hasInventory,
    isLessor: v.isLessor,
    isEsalesRequired: v.isEsalesRequired,
  };
}

/** "123456789000" -> "123-456-789-000" (12 or 14 digits); anything else is returned trimmed. */
export function formatTin(raw: string): string {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (/^[\d\s-]+$/.test(s) && (digits.length === 12 || digits.length === 14)) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  return s;
}

/** The month before `start` (a 12-month fiscal year starting in `start` ends then). */
function monthBefore(start: string): string {
  const i = MONTHS.indexOf(start);
  return i < 0 ? "" : MONTHS[(i + 11) % 12];
}

export type ClientFormErrors = Partial<Record<keyof ClientFormValues, string>>;

/** Field errors for the form; empty when it can be submitted. */
export function validateClientForm(v: ClientFormValues): ClientFormErrors {
  const e: ClientFormErrors = {};
  if (!v.name.trim()) e.name = "Registered business name is required.";
  if (!v.tin.trim()) e.tin = "TIN is required.";
  else if (!TIN_PATTERN.test(v.tin.trim())) e.tin = "Use the format 123-456-789-000 (or a 5-digit branch code: 123-456-789-00000).";
  if (!v.businessType) e.businessType = "Business type is required.";
  if (v.contactEmail.trim() && !EMAIL_PATTERN.test(v.contactEmail.trim())) e.contactEmail = "Enter a valid email address.";
  if (v.fiscalYearStart && v.fiscalYearEnd && v.fiscalYearEnd !== monthBefore(v.fiscalYearStart)) {
    e.fiscalYearEnd = `A fiscal year starting in ${v.fiscalYearStart} ends in ${monthBefore(v.fiscalYearStart)}.`;
  }
  if (v.rdoCode.trim() && !RDO_PATTERN.test(v.rdoCode.trim())) e.rdoCode = "RDO code is up to 3 digits, optionally with a letter (e.g. 047, 21B).";
  return e;
}

const BASIC_FIELDS: Array<keyof ClientFormValues> = ["name", "tradeName", "tin", "businessType", "status", "address", "contactEmail", "contactPhone", "fiscalYearStart", "fiscalYearEnd"];

interface FlagOption { key: BirFlag; label: string; help: string }

// Help text per registration; dates as produced by generateBIRDeadlines (before the
// weekend/holiday roll-forward).
const VAT_PT_FLAGS: FlagOption[] = [
  { key: "vatRegistered", label: "Value-Added Tax (VAT)", help: "Quarterly 2550Q + SLS/SLP (due the 25th of the month after each taxable quarter)" },
  { key: "percentageTaxRegistered", label: "Percentage Tax (Non-VAT)", help: "Quarterly 2551Q (due the 25th of the month after each taxable quarter)" },
];
const WITHHOLDING_FLAGS: FlagOption[] = [
  { key: "withholdsCompensation", label: "Withholding Tax on Compensation", help: "Monthly 1601C (due the 10th; December return January 15) + Annual 1604C with Alphalist of Employees (due January 31) + 2316 to employees (January 31) + 2316 duplicates with Annex F (February 28)" },
  { key: "withholdsEwt", label: "Expanded Withholding Tax (EWT)", help: "0619E (due the 10th, first two months of each quarter) + Quarterly 1601EQ + QAP (last day of the month after the quarter) + Annual 1604E with Alphalist of Payees (due March 1) + Annex C (January 31)" },
  { key: "withholdsFinal", label: "Final Withholding Tax (FWT)", help: "0619F (due the 10th, first two months of each quarter) + Quarterly 1601FQ + QAP (last day of the month after the quarter) + Annual 1604F (due January 31)" },
];
const OTHER_FLAGS: FlagOption[] = [
  { key: "subjectToDst", label: "Documentary Stamp Tax (DST)", help: "Monthly Form 2000 (due the 5th of the following month)" },
];
const ADDITIONAL_FLAGS: FlagOption[] = [
  { key: "hasInventory", label: "Has Inventory", help: "Annual Inventory List due 30 days after the taxable year ends (January 30 for calendar-year clients)" },
  { key: "isLessor", label: "Lessor of Commercial Property", help: "Lessee Information Statement, semi-annual: due July 31 (January–June) and January 31 (July–December)" },
  { key: "isEsalesRequired", label: "eSales Reporting Required", help: "Monthly eSales report due the 8th (even 9th TIN digit) or 10th (odd) of the following month" },
];

const INCOME_TAX_HELP: Record<string, string> = {
  individual: "1701Q due May 15, August 15 and November 15; annual 1701 due April 15 of the following year (always the calendar year).",
  corporate: "1702Q due 60 days after each of the first three quarters; annual 1702 + AFS due the 15th of the 4th month after the taxable year ends (April 15 for calendar-year clients).",
};

export interface ClientFormProps {
  initialValues: ClientFormValues;
  /** Receives the full payload; reject to keep the form open (the caller shows the error). */
  onSubmit: (payload: CreateClientBody) => Promise<unknown> | void;
  onCancel: () => void;
  submitLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  /** Info box at the top of the BIR 2303 tab. */
  birIntro?: ReactNode;
}

/** Add/Edit client form with tabs and a shared sticky footer. Mount it fresh (e.g. inside the dialog) per open. */
export function ClientForm({ initialValues, onSubmit, onCancel, submitLabel, pendingLabel = "Saving...", pending, birIntro }: ClientFormProps) {
  const uid = useId();
  const [values, setValues] = useState<ClientFormValues>(initialValues);
  const [errors, setErrors] = useState<ClientFormErrors>({});
  const [tab, setTab] = useState<"basic" | "bir2303">("basic");

  const set = <K extends keyof ClientFormValues>(key: K, val: ClientFormValues[K]) => {
    setValues(prev => {
      const next = { ...prev, [key]: val };
      // The fiscal year end follows the start month (the server derives it the same way).
      if (key === "fiscalYearStart" && typeof val === "string") next.fiscalYearEnd = monthBefore(val);
      return next;
    });
    if (errors[key] || (key === "fiscalYearStart" && errors.fiscalYearEnd)) {
      setErrors(prev => ({ ...prev, [key]: undefined, ...(key === "fiscalYearStart" ? { fiscalYearEnd: undefined } : {}) }));
    }
  };

  const fid = (key: string) => `${uid}-${key}`;
  const errProps = (key: keyof ClientFormValues) => errors[key]
    ? { "aria-invalid": true as const, "aria-describedby": `${fid(key)}-error` }
    : {};
  const fieldError = (name: keyof ClientFormValues) =>
    errors[name] ? <p id={`${fid(name)}-error`} className="text-xs text-destructive">{errors[name]}</p> : null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const normalized = { ...values, tin: formatTin(values.tin) };
    setValues(normalized);
    const found = validateClientForm(normalized);
    setErrors(found);
    const keys = Object.keys(found) as Array<keyof ClientFormValues>;
    if (keys.length > 0) {
      const firstTab = keys.some(k => BASIC_FIELDS.includes(k)) ? "basic" : "bir2303";
      setTab(firstTab);
      const first = (firstTab === "basic" ? BASIC_FIELDS : keys).find(k => found[k]);
      setTimeout(() => document.getElementById(fid(String(first)))?.focus(), 0);
      return;
    }
    try {
      await onSubmit(toClientPayload(normalized));
    } catch {
      // The caller reports the error; keep the form as it is.
    }
  };

  const businessTypes = values.businessType && !BUSINESS_TYPES.includes(values.businessType)
    ? [values.businessType, ...BUSINESS_TYPES]
    : BUSINESS_TYPES;
  const basicErrors = BASIC_FIELDS.filter(k => errors[k]).length;
  const birErrors = Object.keys(errors).filter(k => errors[k as keyof ClientFormValues] && !BASIC_FIELDS.includes(k as keyof ClientFormValues)).length;

  const flagList = (title: string, flags: FlagOption[]) => (
    <div className="space-y-2 p-3 rounded-md border bg-muted/30">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
      <div className="space-y-2">
        {flags.map(flag => (
          <div key={flag.key} className="flex items-start gap-3">
            <Checkbox
              id={fid(flag.key)}
              checked={values[flag.key]}
              onCheckedChange={v => set(flag.key, v === true)}
              aria-describedby={`${fid(flag.key)}-help`}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <label htmlFor={fid(flag.key)} className="text-sm font-medium cursor-pointer">{flag.label}</label>
              <p id={`${fid(flag.key)}-help`} className="text-xs text-muted-foreground">{flag.help}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} noValidate className="min-w-0">
      <Tabs value={tab} onValueChange={v => setTab(v as "basic" | "bir2303")} className="mt-2">
        <TabsList className="w-full">
          <TabsTrigger value="basic" className="flex-1 min-w-0">
            Basic Info{basicErrors > 0 && <span className="ml-1 text-destructive" aria-label={`${basicErrors} error(s)`}>•</span>}
          </TabsTrigger>
          <TabsTrigger value="bir2303" className="flex-1 min-w-0">
            BIR 2303<span className="hidden sm:inline">&nbsp;Registration</span>{birErrors > 0 && <span className="ml-1 text-destructive" aria-label={`${birErrors} error(s)`}>•</span>}
          </TabsTrigger>
        </TabsList>

        {/* ── TAB 1: BASIC INFO ── */}
        <TabsContent value="basic" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={fid("name")}>Registered Business Name *</Label>
              <Input id={fid("name")} value={values.name} onChange={e => set("name", e.target.value)} placeholder="Reyes Enterprises, Inc." required {...errProps("name")} />
              {fieldError("name")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("tradeName")}>Trade / Business Style Name</Label>
              <Input id={fid("tradeName")} value={values.tradeName} onChange={e => set("tradeName", e.target.value)} placeholder="Reyes Ent." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("tin")}>TIN *</Label>
              <Input
                id={fid("tin")}
                value={values.tin}
                onChange={e => set("tin", e.target.value)}
                onBlur={() => setValues(prev => ({ ...prev, tin: formatTin(prev.tin) }))}
                placeholder="123-456-789-000"
                inputMode="numeric"
                autoComplete="off"
                required
                {...errProps("tin")}
              />
              {fieldError("tin")}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={fid("businessType")}>Business Type *</Label>
              <Select value={values.businessType} onValueChange={v => set("businessType", v)}>
                <SelectTrigger id={fid("businessType")} {...errProps("businessType")}><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {businessTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              {fieldError("businessType")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("status")}>Status</Label>
              <Select value={values.status} onValueChange={v => set("status", v as "active" | "inactive")}>
                <SelectTrigger id={fid("status")}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fid("address")}>Registered Address</Label>
            <Input id={fid("address")} value={values.address} onChange={e => set("address", e.target.value)} placeholder="123 Ayala Avenue, Makati City, Metro Manila" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={fid("contactEmail")}>Contact Email</Label>
              <Input id={fid("contactEmail")} type="email" value={values.contactEmail} onChange={e => set("contactEmail", e.target.value)} placeholder="contact@company.com" {...errProps("contactEmail")} />
              {fieldError("contactEmail")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("contactPhone")}>Contact Phone</Label>
              <Input id={fid("contactPhone")} type="tel" value={values.contactPhone} onChange={e => set("contactPhone", e.target.value)} placeholder="+63-2-8xxx-xxxx" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={fid("fiscalYearStart")}>Fiscal Year Start</Label>
              <Select value={values.fiscalYearStart} onValueChange={v => set("fiscalYearStart", v)}>
                <SelectTrigger id={fid("fiscalYearStart")}><SelectValue placeholder="Month" /></SelectTrigger>
                <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("fiscalYearEnd")}>Fiscal Year End</Label>
              <Select value={values.fiscalYearEnd} onValueChange={v => set("fiscalYearEnd", v)}>
                <SelectTrigger id={fid("fiscalYearEnd")} {...errProps("fiscalYearEnd")}><SelectValue placeholder="Month" /></SelectTrigger>
                <SelectContent>{MONTHS.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
              {fieldError("fiscalYearEnd")}
            </div>
          </div>
        </TabsContent>

        {/* ── TAB 2: BIR 2303 ── */}
        <TabsContent value="bir2303" className="space-y-4 mt-4">
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
            {birIntro ?? (
              <>
                <strong>BIR 2303 — Certificate of Registration</strong><br />
                These details are taken from the client's Certificate of Registration issued by the BIR. They determine which tax forms must be filed and their deadlines.
              </>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor={fid("rdoCode")}>RDO Code</Label>
              <Input id={fid("rdoCode")} value={values.rdoCode} onChange={e => set("rdoCode", e.target.value)} placeholder="e.g. 047" maxLength={5} {...errProps("rdoCode")} />
              {errors.rdoCode ? fieldError("rdoCode") : <p className="text-xs text-muted-foreground">Revenue District Office code from BIR 2303</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fid("registrationDate")}>Date of Registration</Label>
              <Input id={fid("registrationDate")} type="date" value={values.registrationDate} onChange={e => set("registrationDate", e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={fid("lineOfBusiness")}>Line of Business / Industry</Label>
            <Input id={fid("lineOfBusiness")} value={values.lineOfBusiness} onChange={e => set("lineOfBusiness", e.target.value)} placeholder="e.g. Retail Trade, Manufacturing, IT Services" />
          </div>

          <Separator />
          <div className="space-y-3">
            <p className="text-sm font-semibold">Registered Tax Types</p>
            <p className="text-xs text-muted-foreground -mt-2">Check all tax types listed on the client's BIR 2303. These determine the auto-generated filing deadlines.</p>

            <div className="space-y-1.5">
              <Label htmlFor={fid("incomeTaxType")} className="text-xs text-muted-foreground uppercase tracking-wider">Income Tax</Label>
              <Select value={values.incomeTaxType || "none"} onValueChange={v => set("incomeTaxType", v === "none" ? "" : (v as "individual" | "corporate"))}>
                <SelectTrigger id={fid("incomeTaxType")}><SelectValue placeholder="Select income tax type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not registered / N/A</SelectItem>
                  <SelectItem value="individual">Individual — Form 1701 / 1701Q</SelectItem>
                  <SelectItem value="corporate">Corporate — Form 1702 / 1702Q</SelectItem>
                </SelectContent>
              </Select>
              {values.incomeTaxType && <p className="text-xs text-muted-foreground">{INCOME_TAX_HELP[values.incomeTaxType]}</p>}
            </div>

            {flagList("VAT / Percentage Tax", VAT_PT_FLAGS)}
            {flagList("Withholding Taxes", WITHHOLDING_FLAGS)}
            {flagList("Other Taxes", OTHER_FLAGS)}
            {flagList("Additional Compliance Requirements", ADDITIONAL_FLAGS)}
          </div>
        </TabsContent>
      </Tabs>

      {/* Shared footer: Save works from either tab; it sticks to the bottom of the scrolling dialog. */}
      <div className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-4 px-6 py-4 border-t bg-background sm:rounded-b-lg flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" className="hidden sm:inline-flex" onClick={() => setTab(tab === "basic" ? "bir2303" : "basic")}>
          {tab === "basic" ? "Next: BIR 2303 →" : "← Back to Basic Info"}
        </Button>
        <div className="flex flex-1 justify-end gap-2 sm:flex-none">
          <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button type="submit" className="flex-1 sm:flex-none" disabled={pending}>{pending ? pendingLabel : submitLabel}</Button>
        </div>
      </div>
    </form>
  );
}
