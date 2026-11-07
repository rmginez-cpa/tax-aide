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
- `documents.tsx` — Document repository with real file upload (multipart), file viewer (PDF/Excel/Word/image/text), download, delete; "Create Sample Files" for managers generates 3 realistic sample documents
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
- Client schema has BIR 2303 fields: tradeName, rdoCode, registrationDate, lineOfBusiness, incomeTaxType (individual/corporate), vatRegistered, percentageTaxRegistered, withholdsCompensation, withholdsEwt, subjectToDst, fiscalYearStart, fiscalYearEnd, hasInventory, isLessor, isEsalesRequired
- `POST /api/clients/:id/generate-deadlines` — auto-generates all required BIR deadlines for a tax year. Tax year Y = the client's taxable year starting in Y for income tax, VAT, percentage tax and the inventory list (annual ITR/AFS due the 15th of the 4th month after that fiscal year ends); withholding, DST, eSales and lessee forms always follow calendar year Y
- `GET /api/clients/:id/compliance?year=YYYY` — computed compliance checklist with filed/pending/overdue status; each item includes `engagementId`, `workflowStage`, `workflowStatus` for filing workflow integration
- BIR forms/submissions covered: 2550M, 2550Q, 2551Q, 1601C, 1601EQ, 1604CF, 1604E, 1702, 1702Q, 1701, 1701Q, 2000, AFS, Alphalist (employees), 2316 (substituted filing), Annex C, Annex F, QAP (quarterly alphalist of payees), SLS, SLP, eSales, Annual Inventory List, Lessee Information Statement
- File uploads: PDF, Excel, Word, images, CSV, DAT (SLS/SLP data files)

### 4-Stage Filing Workflow (Parallel / Independent)
- Compliance items in client-detail.tsx, deadlines.tsx, calendar.tsx, and engagements.tsx all open `FilingWorkflowDialog`
- Dialog is at `artifacts/taxcms/src/components/FilingWorkflowDialog.tsx`
- Stages: `source_collection`, `draft_return`, `confirmation`, `payment` — all **independent and parallel**
- **Model**: Accountant can work on all 4 stages simultaneously. Each stage has its own approval cycle. Filing is complete only when all 4 stages are individually approved.
- **Per-stage statuses**: `not_started | in_progress | for_review | approved` (stored in 4 DB columns)
- **Engagement-level status**: `pending` (not started) | `in_progress` (started, not all approved) | `completed` (all 4 approved)
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
- **Read-only by design**: tools only query clients, compliance (reuses `buildComplianceItems`), deadlines, filings (engagements), documents, checklists and comments. Client/viewer accounts are hard-scoped to their own `clientId` inside every tool.
- Page context: the panel sends the current route and the page's `<h1>`, so "this client" / "this filing" resolve.
- Conversations are stored per user in `assistant_conversations` (exact API history, append-only, so prompt caching and thinking blocks stay valid). Each question is written to the audit log as `assistant_query`.
- API: `GET /api/assistant/status`, `POST /api/assistant/chat` (SSE: `text`, `tool`, `error`, `done`), `GET|DELETE /api/assistant/conversations[/:id]`.
- Setup: add secret `ANTHROPIC_API_KEY`, run `pnpm install` and `pnpm --filter @workspace/db run push` (creates `assistant_conversations`). Optional env: `ASSISTANT_MODEL`, `ASSISTANT_EFFORT` (low|medium|high|xhigh|max, default medium), `ASSISTANT_DAILY_LIMIT` (questions per user per 24h, default 100, 0 = unlimited).

### Security / deployment
Code: `artifacts/api-server/src/lib/security.ts` (config + headers), `lib/rateLimit.ts` (login limiter), `lib/passwordPolicy.ts`, wired up in `app.ts` and `routes/auth.ts`.

| Env var | Default | Effect |
|---|---|---|
| `SESSION_SECRET` | dev: random per process (warning logged, sessions lost on restart) | **Required when `NODE_ENV=production`** — the server exits at startup without it (or if it is the old `tax-cms-secret-key`). Use `openssl rand -hex 32`. |
| `COOKIE_SECURE` | `true` in production, else `false` | Secure flag of the session cookie (`connect.sid`, always `HttpOnly`, `SameSite=Lax`, `Path=/`, 7 days). With `true` the cookie is only set over HTTPS (needs `trust proxy` behind a proxy). |
| `TRUST_PROXY` | `1` in production, else off | `app.set("trust proxy", …)`: Replit terminates TLS at a proxy, so `req.ip`/`req.secure` come from `X-Forwarded-*`. `false` disables, a number sets the hop count. Only enable when a proxy really sits in front (otherwise clients can spoof their IP for the rate limiter). |
| `ALLOWED_ORIGINS` | empty | Comma-separated origins allowed to call the API cross-origin with credentials. Empty = no CORS headers at all (the web app is same-origin). |
| `SEED_DEMO_ACCOUNTS` | on outside production, off in production | CONTRACT: `GET /api/auth/config` (no auth) → `{ "demoAccounts": boolean }`; true when `SEED_DEMO_ACCOUNTS=true`, or `NODE_ENV!=production` and `SEED_DEMO_ACCOUNTS!=false`. The 4 demo users are seeded (on an empty users table) only when true. Production + `true` logs a loud warning. Turning it off does **not** delete demo users already in a database: delete or re-password them. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | unset | When demo accounts are off and the users table is empty, creates the first `super_admin` at startup. Remove the password afterwards. |
| `LOGIN_MAX_FAILURES_PER_EMAIL` | `5` | Failed logins per (IP, email) per window before 429. |
| `LOGIN_MAX_FAILURES_PER_IP` | `50` | Failed logins per IP per window before 429 (blocks that IP's logins, even correct ones). |
| `LOGIN_FAILURE_WINDOW_MINUTES` | `15` | Window length (starts at the first failure). |

- **Login** (`POST /api/auth/login`): email trimmed + lower-cased (matched case-insensitively); unknown emails are compared against a dummy bcrypt hash so timing does not reveal accounts; same `401 Invalid credentials` either way. On success the session is **regenerated** (new id, old one destroyed — session fixation) and saved before the response. Logout destroys the session row and clears the cookie.
- **Rate limit**: in-memory (per process, cleared on restart). Each attempt is counted up front and a correct password takes it back, so successful logins never count and parallel guesses cannot race past the check; success also clears that (IP, email) counter. Blocked → `429` with `Retry-After` (seconds) and `{ error, retryAfter }`.
- **Passwords**: `POST /users` and `PATCH /users/:id` require at least 8 characters (`400 { error: "Password must be at least 8 characters" }`). Existing shorter passwords keep working until changed.
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
