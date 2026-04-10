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

## Project: BIR TaxCMS

Full-stack BIR Tax Client Management System for Philippine accounting firms.

### Pages (artifacts/taxcms/src/pages/)
- `login.tsx` — Auth page with demo credentials
- `dashboard.tsx` — Overview with stats, charts, deadlines, activity
- `clients.tsx` — Client list with CRUD, search; Add Client dialog has 2 tabs (Basic Info + BIR 2303 Registration); cards show tax type badges
- `client-detail.tsx` — Client info with BIR 2303 expand section, annual compliance checklist with year/filter controls, Generate Deadlines button, Edit dialog
- `engagements.tsx` — All engagements with status filter
- `engagement-detail.tsx` — Checklist, documents, comments, approval workflow
- `deadlines.tsx` — BIR filing deadlines with overdue/upcoming/completed
- `documents.tsx` — Document repository across all engagements
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
- Routes: auth, users, clients, engagements, deadlines, checklist, documents, comments, notifications, audit, dashboard

### BIR 2303 Features
- Client schema has BIR 2303 fields: tradeName, rdoCode, registrationDate, lineOfBusiness, incomeTaxType (individual/corporate), vatRegistered, percentageTaxRegistered, withholdsCompensation, withholdsEwt, subjectToDst, fiscalYearStart, fiscalYearEnd
- `POST /api/clients/:id/generate-deadlines` — auto-generates all required BIR deadlines for a tax year (35+ entries for fully-registered client)
- `GET /api/clients/:id/compliance?year=YYYY` — computed compliance checklist with filed/pending/overdue status
- BIR forms covered: 2550M, 2550Q, 2551Q, 1601C, 1601EQ, 1604CF, 1604E, 1702, 1702Q, 1701, 1701Q, 2000, AFS, Alphalist

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
