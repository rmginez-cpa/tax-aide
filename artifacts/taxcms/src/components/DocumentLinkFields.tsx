// Client / filing / workflow-stage pickers for a staff upload (documents page upload dialog
// and the merged-PDF dialog). The stage options mirror the server's upload locks: a completed
// filing takes no uploads, and a stage that is for review or approved takes none either.

import {
  useListEngagements,
  getListEngagementsQueryKey,
  type Engagement,
} from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FILING_STAGES, FILING_STAGE_KEYS, getStageStatus, type FilingStageKey } from "@/lib/status";

/** Where an upload goes. Empty strings = not linked. */
export interface DocumentLink {
  clientId: string;
  filingId: string;
  stage: FilingStageKey | "";
}

export const NO_DOCUMENT_LINK: DocumentLink = { clientId: "", filingId: "", stage: "" };

/** A link with the dependent parts dropped (no filing without a client, no stage without a filing). */
export function normalizeDocumentLink(link: DocumentLink): DocumentLink {
  const clientId = link.clientId;
  const filingId = clientId ? link.filingId : "";
  return { clientId, filingId, stage: clientId && filingId ? link.stage : "" };
}

/** Adds the link to an upload body (fields of POST /api/documents/upload). */
export function appendDocumentLink(form: FormData, link: DocumentLink): void {
  const { clientId, filingId, stage } = normalizeDocumentLink(link);
  if (clientId) form.append("clientId", clientId);
  if (filingId) form.append("engagementId", filingId);
  if (stage) form.append("stage", stage);
}

/** Why `filing`'s stage `key` cannot take uploads (mirrors the server's lock rules), or null. */
export function stageUploadLock(filing: Engagement | undefined, key: FilingStageKey): string | null {
  if (!filing) return null;
  if (filing.status === "completed") return "filing completed";
  const s = filing.stageStatuses?.[key];
  if (s === "for_review" || s === "approved") return getStageStatus(s).label.toLowerCase();
  return null;
}

interface DocumentLinkFieldsProps {
  value: DocumentLink;
  onChange: (next: DocumentLink) => void;
  clients: Array<{ id: number; name: string }>;
  /** Load the selected client's filings only while the surrounding dialog is open. */
  enabled: boolean;
  disabled?: boolean;
}

export function DocumentLinkFields({ value, onChange, clients, enabled, disabled }: DocumentLinkFieldsProps) {
  const { clientId, filingId, stage } = value;
  const filingParams = { clientId: Number(clientId) };
  const { data: filings, isLoading: loadingFilings } = useListEngagements(filingParams, {
    query: { enabled: enabled && !!clientId, queryKey: getListEngagementsQueryKey(filingParams) },
  });
  const filing = filings?.find(f => String(f.id) === filingId);

  return (
    <>
      <div className="space-y-1.5">
        <Label>Client <span className="text-muted-foreground">(optional)</span></Label>
        <Select
          value={clientId || "none"}
          disabled={disabled}
          onValueChange={v => onChange({ clientId: v === "none" ? "" : v, filingId: "", stage: "" })}
        >
          <SelectTrigger aria-label="Client"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No client (firm document)</SelectItem>
            {clients.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {clientId && (
        <div className="space-y-1.5">
          <Label>Filing <span className="text-muted-foreground">(optional)</span></Label>
          <Select
            value={filingId || "none"}
            disabled={disabled}
            onValueChange={v => onChange({ clientId, filingId: v === "none" ? "" : v, stage: "" })}
          >
            <SelectTrigger aria-label="Filing"><SelectValue placeholder={loadingFilings ? "Loading filings..." : undefined} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{loadingFilings ? "Loading filings..." : "Not linked to a filing"}</SelectItem>
              {(filings ?? []).map(f => (
                <SelectItem key={f.id} value={String(f.id)} disabled={f.status === "completed"}>
                  {f.title}{f.status === "completed" ? " (completed)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!loadingFilings && filings?.length === 0 && (
            <p className="text-xs text-muted-foreground">This client has no filings yet. Start one from a deadline.</p>
          )}
        </div>
      )}

      {clientId && filingId && (
        <div className="space-y-1.5">
          <Label>Workflow stage <span className="text-muted-foreground">(optional)</span></Label>
          <Select
            value={stage || "none"}
            disabled={disabled}
            onValueChange={v => onChange({ clientId, filingId, stage: v === "none" ? "" : (v as FilingStageKey) })}
          >
            <SelectTrigger aria-label="Workflow stage"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No stage</SelectItem>
              {FILING_STAGE_KEYS.map(k => {
                const lock = stageUploadLock(filing, k);
                return (
                  <SelectItem key={k} value={k} disabled={!!lock}>
                    {FILING_STAGES[k].label}{lock ? ` (${lock})` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}
