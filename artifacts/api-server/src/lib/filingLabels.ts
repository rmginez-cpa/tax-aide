// Labels derived from a filing's title, shared by every route (and sent to the web app,
// which shows them as-is): the short form code ("1601EQ", "AnnexF", "2316-Issue") and
// the period ("Q1 2026", "Annual 2026", "1st Semester 2026").

/**
 * Short form code of a generated deadline title. Codes are distinct per filing
 * kind, so (formNumber, period) identifies one checklist item: the 2316 issue to
 * employees ("2316-Issue") vs. the substituted-filing duplicates ("2316"), the
 * 1604C vs. 1604E alphalists, and the EWT vs. final-withholding QAP.
 */
export function extractFormNumber(title: string): string {
  // Annexes first: "Annex F (Annual Alphalist of Employees)" is not an alphalist.
  if (title.startsWith("Annex C")) return "AnnexC";
  if (title.startsWith("Annex F")) return "AnnexF";
  if (/^BIR Form 2316 \(Issue to Employees\)/.test(title)) return "2316-Issue";
  const match = title.match(/BIR Form (\w+)/);
  if (match) return match[1];
  if (title.includes("Audited Financial Statements") || /\bAFS\b/.test(title)) return "AFS";
  if (title.includes("Alphalist of Payees") && title.includes("Quarterly")) {
    return title.includes("Final Withholding") ? "QAP-Final" : "QAP";
  }
  if (title.includes("1604C Attachment")) return "Alphalist-1604C";
  if (title.includes("1604E Attachment")) return "Alphalist-1604E";
  if (title.includes("Alphalist")) return "Alphalist";
  if (title.includes("Summary List of Sales")) return "SLS";
  if (title.includes("Summary List of Purchases")) return "SLP";
  if (title.includes("eSales")) return "eSales";
  if (title.includes("Annual Inventory")) return "Inventory";
  if (title.includes("Lessee Information")) return "LesseeInfo";
  return "OTHER";
}

const PERIOD_RE = /^(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|FY|Annual|1st Semester|2nd Semester) \d{4}$/;

/**
 * Period label of a generated deadline title, from the part after the last " — ":
 * "Q2 2026", "March 2026", "FY 2026", "Annual 2026", "1st Semester 2026". A bare
 * tax year ("Alphalist of Employees (1604C Attachment) — 2026", "BIR Form 2316
 * (Issue to Employees) — 2026") is an annual filing, except the Lessee Information
 * Statement, whose bare-year title is its second semester.
 */
export function extractPeriod(title: string): string {
  const sep = title.lastIndexOf(" — ");
  const tail = (sep >= 0 ? title.slice(sep + 3) : title).trim();
  if (PERIOD_RE.test(tail)) return tail;
  if (/^\d{4}$/.test(tail)) {
    return title.startsWith("Lessee Information Statement") ? `2nd Semester ${tail}` : `Annual ${tail}`;
  }
  const inner = title.match(/\b(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|FY|Annual|1st Semester|2nd Semester) \d{4}\b/);
  return inner ? inner[0] : title;
}

/**
 * Form code shown for an engagement. Engagements started from a deadline carry the
 * generated title and its code as taxType (older rows: the title itself); hand-made ones
 * use a tax type like "VAT (2550Q)". The title's code when the tax type is that code or
 * the title; else the generated-title rules on the tax type, then the parenthesised code
 * in it, then the title's code, then the tax type itself.
 */
export function engagementFormNumber(taxType: string, title: string): string {
  const fromTitle = extractFormNumber(title);
  // Started from a deadline: taxType is the title's own code (or, on old rows, the title).
  if (fromTitle !== "OTHER" && (taxType === fromTitle || taxType === title)) return fromTitle;
  const fromType = extractFormNumber(taxType);
  if (fromType !== "OTHER") return fromType;
  const paren = taxType.match(/\(([^)]+)\)/);
  if (paren) return paren[1].trim();
  if (fromTitle !== "OTHER") return fromTitle;
  return taxType || title;
}

/**
 * Tax type stored on an engagement started from a deadline: the form code
 * ("1601C"), not the whole deadline title; the title itself for a hand-made
 * deadline that names no BIR form.
 */
export function taxTypeFromDeadlineTitle(title: string): string {
  const code = extractFormNumber(title);
  return code === "OTHER" ? title : code;
}
