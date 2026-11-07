# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Project: TaxAide

Full-stack BIR Tax Compliance Management System for Philippine accounting firms (branded "TaxAide").

### Pages (artifacts/taxcms/src/pages/)
- `login.tsx` — Auth page with demo credentials
- `dashboard.tsx` — Overview with stats, charts, deadlines, activity
- `clients.tsx` — Client list with CRUD, search; Add Client dialog has 2 tabs (Basic Info + BIR 2303 Registration); cards show tax type badges
- `client-detail.tsx` — Client info with BIR 2303 expand section, annual compliance checklist with year/filter controls, Generate Deadlines button, Edit dialog
- `engagements.tsx` — All engagements with status filter
- `engagement-detail.tsx` — Checklist, documents, comments, approval workflow
- `deadlines.tsx` — BIR filing deadlines with overdue/upcoming/completed
- `documents.tsx` — Document repository with real file upload (multipart), file viewer (PDF, .xlsx via exceljs in a Web Worker, Word, image, text; legacy .xls is download-only), download, delete; "Create Sample Files" for managers generates 3 realistic sample documents
- `users.tsx` — User management (manager-only)
- `notifications.tsx` — Notifications with mark-read
- `audit-log.tsx` — Full audit trail (manager-only)

### Auth (session-based)
- Demo accounts: admin@firm.ph/admin123 (super_admin), manager@firm.ph/manager123, accountant@firm.ph/accountant123 (maker), client@example.com/client123
- **Roles**:
  - `super_admin` — Full access + account management. Bypasses all role gates in middleware.
  - `manager` — Can approve stages, view all data, audit log. Cannot manage accounts.
  - `maker` (formerly `accountant`) — Prepares filings, uploads documents. Treated as `accountant` everywhere.
  - `client` — Read-only, automatically scoped to their linked `clientId`. Pedro Reyes → EverBright (clientId=18).
  - `viewer` — Legacy read-only role, treated same as `client`.
- **`requireRole` middleware**: `super_admin` bypasses all role checks. `maker` ↔ `accountant` are equivalent.
- **Client scoping**: When `role=client` hits GET /deadlines, /engagements, /documents — backend auto-filters by `session.userClientId`.
- **Account Management page**: `/account-management` — super_admin only. Full CRUD for all users. Login page shows clickable demo account cards.
- **Last super_admin**: `PATCH /users/:id` that would demote, or `DELETE /users/:id` that would remove, the last `super_admin` answers `409` (super_admin rows are locked in the transaction, so two admins removing each other at once cannot both succeed).
- **Client TIN**: `POST/PATCH /clients` require `###-###-###-###` or `###-###-###-#####` (trimmed; else `400`), the same `TIN_PATTERN` as the client form (`taxcms/src/lib/policy.ts`). Older rows with other values keep working until their TIN is edited.
- **`users` table**: new `client_id` column (nullable FK to clients) — used for client-role scoping.
- **`/users` page** (formerly manager-only): Now accessible to super_admin and manager (view team members). Full account CRUD is in `/account-management`.

### API Server (artifacts/api-server)
- Express 5 on port 8080, PostgreSQL + Drizzle ORM
- Session via express-session + connect-pg-simple (table: user_sessions created via raw SQL in app.ts startup)
- `tablesFilter: ["!user_sessions"]` in drizzle.config.ts to prevent drizzle-kit from dropping the manually-managed session table
- Routes: auth, users, clients, engagements, deadlines, checklist, upload (multipart + seed-samples), documents (+ content streaming), comments, notifications, audit, dashboard
- File uploads stored in `/home/runner/workspace/uploads/` (UPLOADS_DIR env var); served via `GET /api/documents/:id/content`
- pdfkit externalized in esbuild (added to external[] in build.mjs) so Node.js can access font files at runtime

### BIR 2303 Features
- Client schema has BIR 2303 fields: tradeName, rdoCode, registrationDate, lineOfBusiness, incomeTaxType (individual/corporate), vatRegistered, percentageTaxRegistered, withholdsCompensation, withholdsEwt, subjectToDst, withholdsFinal, fiscalYearStart, fiscalYearEnd, hasInventory, isLessor, isEsalesRequired
- `POST /api/clients/:id/generate-deadlines` — auto-generates all required BIR deadlines for a tax year (`overwrite: true` refreshes the due date/description of existing rows, matched by title; status and engagement links are never touched). Tax year Y = the client's taxable year starting in Y for corporate income tax, VAT, percentage tax and the inventory list (annual 1702/AFS due the 15th of the 4th month after that fiscal year ends); individual income tax (1701Q/1701) is always calendar year Y (individuals cannot use a fiscal year, so for an individual client every form, VAT / percentage tax / inventory list included, follows calendar year Y and its fiscal-year setting is ignored); `fiscalYearStart` / `fiscalYearEnd` must name a month (stored as the full name; the end is always the month before the start, derived when only one is sent; a disagreeing pair is `400`); quarterly VAT / percentage-tax / 1702Q / SLS / SLP descriptions name the months the (fiscal) quarter covers; withholding, DST, eSales and lessee forms always follow calendar year Y with calendar quarters
- `GET /api/clients/:id/compliance?year=YYYY` — computed compliance checklist with filed/pending/overdue status; each item includes `engagementId`, `workflowStage`, `workflowStatus` for filing workflow integration
- BIR forms/submissions covered: 1601C, 0619E, 1601EQ, 0619F, 1601FQ, QAP (EWT and final), 1604C + Alphalist of Employees, 1604E + Annual Alphalist of Payees, 1604F, 2316 (issue to employees; substituted-filing duplicates), Annex C, Annex F, 2550Q, SLS, SLP, 2551Q, 1702Q, 1702 + AFS, 1701Q, 1701, 2000, eSales, Annual Inventory List, Lessee Information Statement. 2550M is not generated (not required from 2023: TRAIN Sec. 114(A), RR 13-2018, RMC 5-2023); 0605 is voluntary and not generated.

#### BIR due-date rules (generator: `generateBIRDeadlines` in `artifacts/api-server/src/routes/clients.ts`)
Dates are the manual/eBIRForms statutory dates. Titles are stable (existing rows are matched by title); only due dates and descriptions change when rules are corrected.

| Form | Due date | Issuance |
|---|---|---|
| 1601C | 10th of the following month; December return January 15 of Y+1. eFPS filers are staggered up to 5 days later by industry group (not modelled) | RR 2-98 Sec. 2.58(A) as amended by RR 11-2018; RR 26-2002 |
| 0619E / 0619F | 10th of the following month, first two months of each calendar quarter only | RR 11-2018 |
| 1601EQ / 1601FQ | Last day of the month after the calendar quarter (Apr 30, Jul 31, Oct 31, Jan 31) | RR 11-2018 |
| QAP (EWT, and a separate QAP for final withholding) | Same as 1601EQ / 1601FQ (attachment, by eSubmission). SAWT is a payee-side attachment with no own deadline, so it is not generated | RR 11-2018 |
| 1604C + Alphalist of Employees | January 31 of Y+1 | RR 2-98 Sec. 2.83.2 as amended by RR 11-2018; RR 1-2014 |
| 1604E + Annual Alphalist of Payees | March 1 of Y+1 | RR 11-2018 |
| 1604F | January 31 of Y+1 | RR 11-2018 |
| 2316 (Issue to Employees) | January 31 of Y+1 (leavers: day of last pay) | RR 2-98 Sec. 2.83.1 as amended by RR 11-2018 |
| 2316 (Substituted Filing) duplicates + Annex F | February 28 of Y+1, also in leap years. Annex F = certified list of employees qualified for substituted filing | RR 11-2018; RMC 29-2024 (employee signature) |
| Annex C (payor's sworn declaration) | January 31 of Y+1 (and 15 days after the month a new payee's declaration arrives); generated for EWT withholders, only needed where payees gave Annex B sworn declarations. The historical title "Annex C (Substituted Filing Employees)" is kept for row matching | RR 11-2018 |
| 2550Q, SLS, SLP | 25th of the month after each taxable (fiscal) quarter | NIRC Sec. 114(A) as amended by RA 10963 / RA 11976; RR 16-2005 / RR 1-2012 |
| 2551Q | 25th of the month after each taxable (fiscal) quarter | NIRC Sec. 128(A) as amended by RA 10963 / RA 11976 |
| 1702Q | 60 days after the close of each of the first three taxable quarters | NIRC Sec. 75, 77(B) |
| 1702 + AFS | 15th of the 4th month after the taxable year (eAFS upload within 15 days after the deadline or e-filing date) | NIRC Sec. 77(B); RMC 14-2015, RMC 44-2022 |
| 1701Q | May 15, August 15, November 15 of Y (calendar quarters) | NIRC Sec. 74 as amended by RA 10963; RR 8-2018; RMC 32-2018 |
| 1701 | April 15 of Y+1 (second installment option by October 15) | NIRC Sec. 51(C)(1), 56(A)(2) |
| 2000 (DST) | 5th of the following month | NIRC Sec. 200(B); RMC 67-2024 |
| eSales | Last digit of the 9-digit TIN (branch code excluded): even → 8th, odd → 10th of the following month; no 9-digit TIN → 8th | RMO 12-2012; RMC 45-2014 |
| Annual Inventory List | 30 days after the taxable year ends | RR 17-2013; RMC 57-2015 |
| Lessee Information Statement | Semi-annual: July 31 of Y ("1st Semester") and January 31 of Y+1 | RR 12-2011 as amended by RR 15-2011 |

- **Weekend / holiday roll-forward (RMC 65-2016; Sec. 31, Book I, Administrative Code of 1987)**: every generated date that falls on a Saturday, Sunday or holiday moves to the next working day (repeatedly), and the description says so ("Statutory due date Sat, Feb 28 2026 falls on a non-working day (Saturday); due the next working day, Mon, Mar 2 2026 (RMC 65-2016).").
- Holidays come from `artifacts/api-server/src/lib/birCalendar.ts` (`isNonWorkingDay`, `nextWorkingDay`): the fixed regular holidays (Jan 1, Apr 9, May 1, Jun 12, Nov 30, Dec 25, Dec 30), Maundy Thursday and Good Friday (from Western Easter, anonymous Gregorian algorithm) and National Heroes Day (last Monday of August) — RA 9492. Eid'l Fitr / Eid'l Adha, special non-working days (e.g. Nov 1-2, Dec 8, Dec 24, Dec 31, Chinese New Year) and ad hoc suspensions are **not** computed: add them each year, once proclaimed, to `EXTRA_HOLIDAYS` in that file or the `BIR_EXTRA_HOLIDAYS` env var (comma-separated YYYY-MM-DD, read at startup), then regenerate with `overwrite: true`. Until then the generator shows the earlier date (safe side).
- One-off BIR extensions (e.g. RMC 17-2021 for 1604C/F, RMC 29-2024 for 2316) are not modelled; edit the deadline's due date by hand. A hand-edited due date is flagged (`deadlines.due_date_manual`): regenerating with `overwrite: true` keeps it (the reply counts them as "kept a due date edited by hand"), the compliance checklist shows and judges overdue by the saved row's date (the generator's date only for filings with no saved row), and the linked filing's due date follows every change.
- Tests: `tests/api/deadline-rules.test.mjs` asserts these dates for tax years 2025-2027. All API suites share `tests/api/_harness.mjs`; `node tests/api/run-all.mjs` (`pnpm --filter @workspace/tests run test:api`) runs them all — see `tests/api/README.md`.
- File uploads: PDF, Excel, Word, images, CSV, DAT (SLS/SLP data files)

### 4-Stage Filing Workflow (Parallel / Independent)
- Compliance items in client-detail.tsx, deadlines.tsx, calendar.tsx, and engagements.tsx all open `FilingWorkflowDialog`
- Dialog is at `artifacts/taxcms/src/components/FilingWorkflowDialog.tsx`
- Stages: `source_collection`, `draft_return`, `confirmation`, `payment` — all **independent and parallel**
- **Model**: Accountant can work on all 4 stages simultaneously. Each stage has its own approval cycle. Filing is complete only when all 4 stages are individually approved.
- **Per-stage statuses**: `not_started | in_progress | for_review | approved` (stored in 4 DB columns)
- **Engagement-level status**: `pending` (not started) | `in_progress` (started, not all approved) | `completed` (all 4 approved). The pre-workflow `for_review` / `approved` / `filed` are retired: `PATCH /engagements/:id` refuses them (400); old rows that still hold one render with a neutral badge.
- **Accountant actions per stage**: upload documents, then click "Submit for Manager Approval"
- **Manager actions per stage**: "Approve Stage" (green) or "Return for Revision" (red, requires reason)
- **Manager: Undo Approval**: appears on each approved stage; reverts that stage to `in_progress`; if filing was completed, reverts engagement to `in_progress` and unmarks deadline
- **Document deletion**: Locked per-stage — deletable when stage is `not_started`/`in_progress`; blocked (403) when `for_review` or `approved`. Lock icon shows on hover.
- **Filing progress**: "X / 4 stages approved" progress bar shown at top of dialog
- **Amended Returns**: "File Amendment" button on completed filing banner. Creates new engagement (isAmendment=true) with all 4 stages reset to `not_started`.
- "Filing History" dropdown shows original + all amendments; click to switch views
- **API routes**: `POST /api/deadlines/:id/start-workflow`, `POST /api/engagements/:id/submit-stage` (body: {stage}), `recall-stage` (body: {stage}, makers and above — retracts from for_review → in_progress), `approve-stage` (body: {stage, notes?}), `reject-stage` (body: {stage, notes}), `void-stage` (body: {stage, notes?}), `amend`
- `GET /api/engagements/:id/amendments` — returns original + all amendments
- Engagement serialization includes `stageStatuses: Record<stage, status>` and `stagesForReview: number`
- Schema: `source_collection_status`, `draft_return_status`, `confirmation_status`, `payment_status` columns on engagements table

### Calendar Page
- Route: `/calendar`, accessible by accountant and manager roles
- Monthly calendar grid view with day-of-week headers and month navigation
- All BIR deadlines shown as color-coded pills on their due dates (red=overdue, green=completed, amber=high priority, blue=default)
- Right sidebar shows scrollable list of all deadlines in the current month
- Clicking any deadline with a clientId opens `FilingWorkflowDialog` directly from the calendar
- "Calendar" added to sidebar navigation with CalendarDays icon (between Deadlines and Documents)

### TaxAide Assistant (Claude)
- "Ask TaxAide" button (bottom-right) or **Ctrl/⌘ + J** opens a chat side panel on every page (`components/assistant/AssistantPanel.tsx`, state in `lib/assistant.tsx`).
- Backend: `artifacts/api-server/src/routes/assistant.ts` streams Server-Sent Events from the Anthropic Messages API (`@anthropic-ai/sdk`, model `claude-opus-5-5`, adaptive thinking, server-side refusal fallback). Tools live in `src/lib/assistant/tools.ts`.
- **Read-only by design**: the in-app assistant gets only the read tools (the same implementation also backs the Claude connector below, whose write tools it never sees); tools only query clients, compliance (reuses `buildComplianceItems`), deadlines, filings (engagements), documents, checklists and comments. Client/viewer accounts are hard-scoped to their own `clientId` inside every tool.
- Page context: the panel sends the current route and the page's `<h1>`, so "this client" / "this filing" resolve.
- Conversations are stored per user in `assistant_conversations` (exact API history, append-only, so prompt caching and thinking blocks stay valid). Each question is written to the audit log as `assistant_query`.
- API: `GET /api/assistant/status`, `POST /api/assistant/chat` (SSE: `text`, `tool`, `error`, `done`), `GET|DELETE /api/assistant/conversations[/:id]`.
- Setup: add secret `ANTHROPIC_API_KEY`, run `pnpm install` and `pnpm --filter @workspace/db run push` (creates `assistant_conversations`). Optional env: `ASSISTANT_MODEL`, `ASSISTANT_EFFORT` (low|medium|high|xhigh|max, default medium), `ASSISTANT_DAILY_LIMIT` (questions per user per 24h, default 100, 0 = unlimited).

### Connecting Claude (claude.ai custom connector)
TaxAide includes a **remote MCP server** so Claude (claude.ai, Claude Desktop, Claude mobile, Cowork, Claude Code) can look up — and, if allowed, make small edits to — TaxAide data **as the signed-in TaxAide user, with exactly that user's permissions**. TaxAide is its own OAuth 2.1 authorization server; Claude never sees a password.

- **Connector URL**: `https://<your-domain>/api/mcp`. Every signed-in user can copy it, with short setup steps, from the web app's **Claude Connector** page (`/settings/claude`, in the sidebar and the command palette; it reads `GET /api/oauth/connector` → `mcpUrl`).
- **Must be publicly reachable over HTTPS on port 443** with a public IPv4 (A) record: claude.ai connects from Anthropic's cloud (outbound ranges `160.79.104.0/21`, `153.61.208.0/20`), never from the user's browser or computer. A published Replit deployment (`https://<app>.replit.app` or a custom domain) works; a private/VPN-only or `localhost` server does not (Claude Code on the same machine can use `http://localhost`). Do not put a WAF/CDN rule in front that returns 403/429 to those ranges.

**Adding it (individual Free/Pro/Max plans)** — Free allows one custom connector:
1. In claude.ai: **Customize → Connectors → + Add → Add custom connector**.
2. Name: `TaxAide`; URL: `https://<your-domain>/api/mcp`; Continue. Keep the detected settings (OAuth, "Register automatically" / dynamic client registration; leave client ID/secret empty) and click **Add**, then **Connect**.
3. A TaxAide page opens: sign in if needed, review the requesting app (the return host should be `claude.ai`) and the permissions, and click **Approve**. "Make limited changes" is offered to staff accounts only.
4. In a chat, enable it under **+ → Connectors**. Claude asks before each tool call ("Allow once / Always allow"); read tools are marked read-only, so you can set them to *Always allow* on the connector's page, while write tools keep asking.

**Team / Enterprise**: an Owner or Primary Owner (on Enterprise also a custom role with *Manage* access to Libraries) adds it once under **Organization settings → Connectors → Add → Custom → Web** with the same name and URL. Each member then opens **Customize → Connectors**, finds TaxAide (labelled *Custom*) and clicks **Connect**, which signs them in with *their own* TaxAide account. Auth settings cannot be edited later: to change them, remove and re-add the connector. Claude Code: `claude mcp add --transport http taxaide https://<your-domain>/api/mcp`, then `/mcp` to sign in.

**Scopes and tools** (all scoped like the web app: client/viewer accounts see only their linked client; out-of-scope ids look "not found"; an unlinked client account sees nothing):

| Scope | Who can grant it | Tools |
|---|---|---|
| `taxaide.read` "View your TaxAide data" | everyone (always granted) | `find_clients`, `get_client`, `get_client_compliance`, `list_deadlines`, `list_filings`, `get_filing`, `list_documents`, `workload_overview` (the in-app assistant's tools, `src/lib/assistant/tools.ts`; annotated `readOnlyHint`) |
| `taxaide.write` "Make limited changes" | staff roles only (maker, manager, super_admin); dropped for client accounts | `add_filing_comment` (POST /comments), `set_deadline_notes` (deadline description; `list_deadlines` returns the current notes and the result the previous ones), `update_checklist_item` (status / notes; takes the filing's `engagement_id` and the item id from `get_filing`, and refuses an item of another filing). Same service functions, rules and audit entries as the HTTP routes (`src/lib/services/*`), marked "(via Claude connector)" with `metadata.via = "claude_connector"` and the grant id. |

Never available: approving / returning / recalling stages, deleting, uploading or downloading files, user/account administration, passwords and roles. A staff user whose grant lacks `taxaide.write` gets `403 insufficient_scope` for a write tool (Claude then offers to re-authorize). Tool results are compact JSON (also as `structuredContent`), capped at 80,000 characters, and never contain password hashes, sessions, tokens or storage paths; the server instructions tell Claude that record text is untrusted data.

**Revoking**: users disconnect under "Connected apps" on the Claude Connector page (`DELETE /api/oauth/grants/:id`); a super_admin also gets an "All users" tab there to list and revoke everyone's (`GET /api/oauth/grants?all=1`). Grants are revoked automatically when the user changes their password, when an admin resets it or changes their role or linked client, and when the user is deleted. Tokens re-check the user on every request. Removing the connector in claude.ai does not revoke it in TaxAide.

**How it works** (`src/routes/mcp.ts`, `src/routes/oauth.ts`, `src/lib/mcp/*`; tables `oauth_clients`, `oauth_authorization_requests`, `oauth_codes`, `oauth_grants`, `oauth_tokens` from `lib/db/src/schema/oauth.ts`):
- `POST /api/mcp` — Streamable HTTP, stateless (a new MCP server + transport per request, JSON responses, no `Mcp-Session-Id`); `GET`/`DELETE` → 405. Bearer token required: without one → `401` + `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/api/mcp", scope="taxaide.read taxaide.write"`. Body limit 128 KB. Mounted before the cookie session: MCP and token requests never read or create sessions.
- Discovery: protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-protected-resource` and `/api/.well-known/oauth-protected-resource`; authorization-server metadata (RFC 8414) at `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration`. The issuer is the origin itself (`https://<host>`).
- OAuth endpoints: `/api/oauth/authorize`, `/api/oauth/token`, `/api/oauth/register` (dynamic client registration, RFC 7591), `/api/oauth/revoke` (RFC 7009), with origin-root aliases `/authorize`, `/token`, `/register` for a known claude.ai fallback. Authorization code + PKCE S256 only; codes single-use, 5 minutes, bound to client, redirect URI, PKCE challenge, resource and user; access tokens 1 hour; refresh tokens 30 days, rotated on every use, and a reused refresh token (or code) revokes the whole grant. The one exception is a retry: a rotated refresh token presented again within 60 seconds, while its successor is still unused (a lost response, two refreshes at once), gets a new pair instead; once one of those pairs is used the others are dropped. Revoking a grant (and a password, role or client change) also deletes the authorization codes that were approved but not yet exchanged, so none can mint a new grant afterwards. Dynamic registration accepts up to 10 redirect URIs of at most 512 characters each; requested grant or response types this server does not support are dropped (only a client without `authorization_code` / `code` is refused). The `resource` parameter (RFC 8707) must be this server's `/api/mcp` URL. Only SHA-256 hashes of codes and tokens are stored; a confidential client's secret is derived from `SESSION_SECRET` (rotating it invalidates those secrets). Per-IP rate limits: authorize 300 / token 1000 / revoke 300 per 15 min, register 200 per hour. Expired rows are cleaned up hourly.
- Consent: `/api/oauth/authorize` validates the request (an unknown client or unregistered redirect URI is shown as an error, never redirected), stores it for 10 minutes and redirects the browser to the web app's `/connect/authorize?request=<id>`; that page uses `GET /api/oauth/requests/:id` and `POST /api/oauth/requests/:id/decision` (session + same-Origin + JSON).
- Consent page (`taxcms/src/pages/connect-authorize.tsx`): standalone, outside the app shell. Signed out, it goes to `/login?next=<the same URL>` and comes back after sign-in (`lib/return-to.ts` accepts only same-origin app paths, so `next` cannot redirect elsewhere). It shows the return host prominently, the app's self-declared name marked as unverified, the signed-in user with "Not you? Sign out", the requested scopes (the write checkbox only when requested and allowed for the role) and the expiry; it refuses to show Approve/Deny inside a frame (clickjacking) and only follows a `redirectTo` that matches the registered redirect URI.
- **Replit routing**: the API artifact serves `["/api", "/.well-known", "/authorize", "/token", "/register"]` (`artifacts/api-server/.replit-artifact/artifact.toml`). Without the extra paths the web app's `/* → /index.html` rewrite would answer discovery with HTML and claude.ai could not sign in. Do not add web-app routes under those paths.

| Env var | Default | Effect |
|---|---|---|
| `MCP_ENABLED` | on | `false` turns off `/api/mcp`, the OAuth endpoints, the consent endpoints and the discovery documents (404). `GET /api/oauth/connector` then says `enabled: false`; existing grants can still be listed and revoked. |
| `PUBLIC_BASE_URL` | derived per request | Public origin, e.g. `https://taxaide.example.com` (no path). When set, every URL uses it and connector requests for any other `Host` get 403 (DNS-rebinding / Host-header protection). When unset, URLs come from the request (`X-Forwarded-Proto` / `X-Forwarded-Host` with `TRUST_PROXY`). Invalid values stop the server at startup; `http://` is refused in production. |
| `MCP_ALLOWED_REDIRECT_URIS` | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,http://localhost/*,http://127.0.0.1/*,http://[::1]/*` | Comma-separated redirect URIs clients may register: https entries match exactly; loopback `http://` entries match any port (RFC 8252), and with `/*` any path. Setting it replaces the defaults. |
| `MCP_ALLOW_INSECURE_HTTP` | `false` | Allows an `http://` public URL in production. Never on the public internet. |

- **Tests**: `tests/api/mcp.test.mjs` (in `run-all.mjs`) and `tests/api/mcp-interop.mjs` (the MCP SDK's own client doing the claude.ai flow end to end; same env, run it directly).

### Security / deployment
Code: `artifacts/api-server/src/lib/security.ts` (config + headers), `lib/rateLimit.ts` (login limiter), `lib/passwordPolicy.ts`, wired up in `app.ts` and `routes/auth.ts`.

| Env var | Default | Effect |
|---|---|---|
| `SESSION_SECRET` | dev: random per process (warning logged, sessions lost on restart) | **Required when `NODE_ENV=production`** — the server exits at startup without it (or if it is the old `tax-cms-secret-key`). Use `openssl rand -hex 32`. |
| `COOKIE_SECURE` | `true` in production, else `false` | Secure flag of the session cookie (`connect.sid`, always `HttpOnly`, `SameSite=Lax`, `Path=/`, 7 days). With `true` the cookie is only set over HTTPS (needs `trust proxy` behind a proxy). |
| `TRUST_PROXY` | `1` in production and on Replit (`REPLIT_DEV_DOMAIN` / `REPLIT_DOMAINS` set), else off | `app.set("trust proxy", …)`: Replit terminates TLS at a proxy, so `req.ip`/`req.secure` come from `X-Forwarded-*`. `false` disables, a number sets the hop count. Only enable when a proxy really sits in front (otherwise clients can spoof their IP for the rate limiter). The Claude connector needs it (or `PUBLIC_BASE_URL`) behind any TLS proxy: without it the server sees `http://`, advertises `http://` URLs and refuses the consent page's `https://` Origin; the Claude Connector page then reports the problem instead of showing a URL. |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call the API cross-origin with credentials. Empty = no CORS headers at all (the web app is same-origin). |
| `SEED_DEMO_ACCOUNTS` | on outside production, off in production | CONTRACT: `GET /api/auth/config` (no auth) → `{ "demoAccounts": boolean }`; true when `SEED_DEMO_ACCOUNTS=true`, or `NODE_ENV!=production` and `SEED_DEMO_ACCOUNTS!=false`. The 4 demo users are seeded (on an empty users table) only when true. Production + `true` logs a loud warning. Turning it off does **not** delete demo users already in a database: delete or re-password them. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | unset | When demo accounts are off and the users table is empty, creates the first `super_admin` at startup. Remove the password afterwards. |
| `LOGIN_MAX_FAILURES_PER_EMAIL` | `5` | Failed logins per (IP, email) per window before 429. |
| `LOGIN_MAX_FAILURES_PER_IP` | `50` | Failed logins per IP per window before 429 (blocks that IP's logins, even correct ones). |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `20` | Failed logins per email from all IPs together per window before 429 (a successful login resets it). IPs are counted IPv4-as-is (IPv4-mapped IPv6 folded to IPv4) and IPv6 per /64. |
| `LOGIN_FAILURE_WINDOW_MINUTES` | `15` | Window length (starts at the first failure). |

- **Login** (`POST /api/auth/login`): email trimmed + lower-cased (matched case-insensitively); unknown emails are compared against a dummy bcrypt hash so timing does not reveal accounts; same `401 Invalid credentials` either way. On success the session is **regenerated** (new id, old one destroyed — session fixation) and saved before the response. Logout destroys the session row and clears the cookie.
- **Rate limit**: in-memory (per process, cleared on restart). Each attempt is counted up front and a correct password takes it back, so successful logins never count and parallel guesses cannot race past the check; success also clears that (IP, email) counter. Blocked → `429` with `Retry-After` (seconds) and `{ error, retryAfter }`.
- **Passwords**: `POST /users` and `PATCH /users/:id` require at least 8 characters (`400 { error: "Password must be at least 8 characters" }`). Existing shorter passwords keep working until changed. The frontend copy is `MIN_PASSWORD_LENGTH` in `taxcms/src/lib/policy.ts`.
- **Headers** on every `/api` response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; JSON routes also `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cache-Control: no-store`. `GET /api/documents/:id/content` is exempt from those three (it sets its own `Content-Type`/`Content-Disposition`/`Cache-Control`; the viewer embeds it via a blob URL). `X-Powered-By` is off. JSON/urlencoded bodies are capped at 1 MB (`413`). Errors are returned as JSON `{ error }` (no HTML stack traces).
- **Deploying**: set `SESSION_SECRET` as a deployment secret; leave `SEED_DEMO_ACCOUNTS` unset (or `false`); set `BOOTSTRAP_ADMIN_*` once on a fresh database.
- **Tests**: `tests/api/security.test.mjs` (same env/guard as `authz.test.mjs`, also resets the fixture). Start the API with `TRUST_PROXY=1` and run the test with `TRUST_PROXY=1` too: every rate-limit scenario then uses its own fake `X-Forwarded-For` IP and never locks out localhost (without it the per-IP cases are skipped and the other failures count against the real IP). If the server uses non-default `LOGIN_*` limits or `ALLOWED_ORIGINS`, export the same values for the test.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — start API dev server (builds first)
- `pnpm --filter @workspace/taxcms run dev` — start frontend dev server

## Important Notes

- `requireRole` middleware uses rest params: call as `requireRole("accountant", "manager")` not `requireRole(["accountant","manager"])`
- Radix UI SelectItem cannot have `value=""` — use `value="none"` with logic to convert to null before sending to API
- Session table is created manually via raw SQL in `artifacts/api-server/src/app.ts` on startup
