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
- Demo: manager@firm.ph/manager123, accountant@firm.ph/accountant123, client@example.com/client123
- Roles: manager (full access), accountant (no users/audit), viewer (read-only)

### API Server (artifacts/api-server)
- Express 5 on port 8080, PostgreSQL + Drizzle ORM
- Session via express-session + connect-pg-simple (table: user_sessions created via raw SQL in app.ts startup)
- `tablesFilter: ["!user_sessions"]` in drizzle.config.ts to prevent drizzle-kit from dropping the manually-managed session table
- Routes: auth, users, clients, engagements, deadlines, checklist, upload (multipart + seed-samples), documents (+ content streaming), comments, notifications, audit, dashboard
- File uploads stored in `/home/runner/workspace/uploads/` (UPLOADS_DIR env var); served via `GET /api/documents/:id/content`
- pdfkit externalized in esbuild (added to external[] in build.mjs) so Node.js can access font files at runtime

### BIR 2303 Features
- Client schema has BIR 2303 fields: tradeName, rdoCode, registrationDate, lineOfBusiness, incomeTaxType (individual/corporate), vatRegistered, percentageTaxRegistered, withholdsCompensation, withholdsEwt, subjectToDst, fiscalYearStart, fiscalYearEnd, hasInventory, isLessor, isEsalesRequired
- `POST /api/clients/:id/generate-deadlines` — auto-generates all required BIR deadlines for a tax year
- `GET /api/clients/:id/compliance?year=YYYY` — computed compliance checklist with filed/pending/overdue status; each item includes `engagementId`, `workflowStage`, `workflowStatus` for filing workflow integration
- BIR forms/submissions covered: 2550M, 2550Q, 2551Q, 1601C, 1601EQ, 1604CF, 1604E, 1702, 1702Q, 1701, 1701Q, 2000, AFS, Alphalist (employees), 2316 (substituted filing), Annex C, Annex F, QAP (quarterly alphalist of payees), SLS, SLP, eSales, Annual Inventory List, Lessee Information Statement
- File uploads: PDF, Excel, Word, images, CSV, DAT (SLS/SLP data files)

### 4-Stage Filing Workflow
- Compliance items in client-detail.tsx are clickable buttons that open `FilingWorkflowDialog`
- Deadlines in deadlines.tsx and calendar.tsx are also clickable and open `FilingWorkflowDialog`
- Dialog is at `artifacts/taxcms/src/components/FilingWorkflowDialog.tsx`
- Stages: `source_collection` → `draft_return` → `confirmation` → `payment`
- State: `engagement.workflowStage` (current stage) + `engagement.status` (in_progress | for_review | completed)
- Accountant actions: upload docs, submit for review, skip source collection ("No Transactions")
- Manager actions: approve (advances to next stage or completes filing), reject (returns with comment), **void/undo** (reverts to previous stage)
- Completing payment stage marks the linked `deadline.status = 'completed'` automatically
- Completed workflows show "Void Completion" button for managers, which reverts to payment + in_progress and unmarks the deadline as filed
- In-progress non-first stages show "Undo Last Approval" button for managers (reverts to previous stage)
- Completed workflow dialog shows all 4 stages with their uploaded documents in a "Previous Stages" section
- API routes: `POST /api/deadlines/:id/start-workflow`, `POST /api/engagements/:id/submit-stage`, `skip-source`, `approve-stage`, `reject-stage`, `void-stage`
- `documents.stage` column added to track which workflow stage each document belongs to
- `engagements.workflow_stage` column added to track current filing stage

### Calendar Page
- Route: `/calendar`, accessible by accountant and manager roles
- Monthly calendar grid view with day-of-week headers and month navigation
- All BIR deadlines shown as color-coded pills on their due dates (red=overdue, green=completed, amber=high priority, blue=default)
- Right sidebar shows scrollable list of all deadlines in the current month
- Clicking any deadline with a clientId opens `FilingWorkflowDialog` directly from the calendar
- "Calendar" added to sidebar navigation with CalendarDays icon (between Deadlines and Documents)

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
