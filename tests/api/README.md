# API integration tests

Dependency-free Node 22+ suites that test a **running API server** against a Postgres fixture.

> **Destructive.** `fixture.sql` truncates every application table (users 1–4 are kept). Use a
> throwaway database. Every suite refuses to run unless `TAXAIDE_TEST_RESET_DB=1`.

| Suite | What it covers |
|---|---|
| `authz.test.mjs` | Server-side permission policy: client scoping, maker / manager / super_admin gates, immutable approval comments, stage locks, file-path safety, deadline tax-year logic, the last super_admin (409), retired filing statuses |
| `admin.test.mjs` | Audit trail: `GET /audit-logs` pagination + filters (`X-Total-Count`), `GET /audit-logs/filters`, `GET /audit-logs/export.csv` (CSV escaping, row cap, role gates) |
| `clients.test.mjs` | Client form round-trip (every BIR 2303 flag), compliance checklist mapping, client route roles / scope, TIN format validation, fiscal-year month validation, individuals on the calendar year, fiscal-quarter months in descriptions, hand-edited due dates (checklist, linked filing, overwrite), start-workflow tax type / period / form code |
| `deadline-rules.test.mjs` | Due dates written by `POST /clients/:id/generate-deadlines` for tax years 2025–2027, incl. the weekend / holiday roll-forward |
| `docs.test.mjs` | `GET /documents` filters (`q`, `stage`, `mimeType`), pagination with `X-Total-Count`, client scoping, upload error statuses |
| `home.test.mjs` | `GET /dashboard/my-work` and the notification endpoints (unread count, ordering, own-user scope) |
| `mcp.test.mjs` | Claude / MCP connector: OAuth discovery documents, `401` + `WWW-Authenticate`, dynamic client registration (allowed / refused redirect URIs), authorize errors (never redirecting for a bad client or redirect URI), consent endpoints (session, Origin, JSON, single use, role-limited scopes), PKCE / code reuse / redirect / resource checks, refresh rotation + reuse detection, RFC 7009 revocation, grants API, revocation on password / role / client change and user deletion, MCP initialize / tools/list / tools/call per role and client scoping, write tools (scope + role, audit entries, step-up `403 insufficient_scope`) |
| `security.test.mjs` | Session cookie / fixation, login normalisation and timing, login rate limiting, password policy, security headers, CORS |

`mcp-interop.mjs` (not a `*.test.mjs` suite, so `run-all.mjs` skips it; same env, run it with
`node tests/api/mcp-interop.mjs`) drives the whole connector flow with the MCP SDK's own `Client`,
`StreamableHTTPClientTransport` and OAuth helpers, the way claude.ai does: bare `401` → discovery →
DCR with `https://claude.ai/api/mcp/auth_callback` → PKCE → consent via the JSON decision endpoint →
token → `listTools` / `callTool` → refresh. Both MCP scripts load the SDK from
`artifacts/api-server/node_modules` (it is not a dependency of `tests/`) and send their OAuth
requests from made-up `X-Forwarded-For` addresses, so start the server with `TRUST_PROXY=1` and
without `PUBLIC_BASE_URL`.

Shared code lives in `_harness.mjs` (env, guard, DB reset, sign-in, request helpers, the
PASS/FAIL runner); each suite imports it. `run-all.mjs` runs every suite one after another.

## Running

```bash
# 1. a throwaway Postgres database
createdb taxaide_test
export DATABASE_URL=postgres://USER:PASS@localhost:5432/taxaide_test
pnpm --filter @workspace/db run push

# 2. start the API against it (UPLOADS_DIR must match step 3; TRUST_PROXY=1, see below)
cd artifacts/api-server && pnpm run build
PORT=8080 SESSION_SECRET=test TRUST_PROXY=1 UPLOADS_DIR=/tmp/taxaide-test-uploads node dist/index.mjs &

# 3. run every suite (PG* variables point the fixture reset at the same database)
cd ../..
export TAXAIDE_TEST_RESET_DB=1 TRUST_PROXY=1 API_BASE=http://localhost:8080/api \
  PGHOST=localhost PGUSER=USER PGPASSWORD=PASS PGDATABASE=taxaide_test \
  UPLOADS_DIR=/tmp/taxaide-test-uploads
node tests/api/run-all.mjs              # or: pnpm --filter @workspace/tests run test:api
node tests/api/run-all.mjs authz docs   # only some suites
node tests/api/authz.test.mjs           # one suite on its own
ONLY="9 deadline" node tests/api/authz.test.mjs   # one group (substring of the group name)
```

Start the server once before the first run so it seeds the four demo users; the fixture keeps
users 1–4 and adds the others (`clientb`, `orphan`, `viewer`). Each suite resets the fixture
itself and leaves the database in the fixture state when it ends. The suites share the database,
so never run two at the same time (`run-all.mjs` runs them sequentially).

`run-all.mjs` prints only FAIL / SKIP lines and one summary per suite (`VERBOSE=1` streams every
line), then a table and the totals; it exits 1 if any suite fails, crashes or refuses to run.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TAXAIDE_TEST_RESET_DB` | — | Must be `1` (the suites wipe the database). |
| `API_BASE` | `http://localhost:8080/api` | The API under test. |
| `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `localhost` / `taxaide` / `taxaide` / `taxaide` | The database the API uses; `psql` reloads `fixture.sql` there. |
| `FIXTURE` | `tests/api/fixture.sql` | Fixture file. |
| `UPLOADS_DIR` | `tests/api/uploads` | **Must equal the server's `UPLOADS_DIR`**: the fixture's documents point at `a.txt` / `b.txt` written there. |
| `ONLY` | — | Run only the groups whose name contains this text. |
| `DRY_RUN` | — | `1` = stub the API and the DB (counts cases only; `authz`, `docs`, `home`). |
| `TRUST_PROXY` | — | See below (security suite). |
| `LOGIN_MAX_FAILURES_PER_EMAIL` / `LOGIN_MAX_FAILURES_PER_IP` / `LOGIN_MAX_FAILURES_PER_ACCOUNT` / `LOGIN_FAILURE_WINDOW_MINUTES` | 5 / 50 / 20 / 15 | Security suite: pass the same values the server was started with, if not the defaults. |
| `ALLOWED_ORIGINS` | — | Security suite: set it to the server's value so the allowed-origin case runs (skipped otherwise). |

### `TRUST_PROXY=1` and the rate-limit cases

The login rate limiter counts failures per client IP. Start the **server** with `TRUST_PROXY=1`
and set `TRUST_PROXY=1` for the **tests** too: the server then takes the client IP from
`X-Forwarded-For`, so `security.test.mjs` gives every rate-limit scenario its own made-up IP.
Without it the per-IP cases are skipped and the remaining failures count against your real IP
(localhost) — which can lock every suite's sign-ins out for the 15-minute window. Only use
`TRUST_PROXY` on a test server: in front of real users it must reflect a real proxy.
