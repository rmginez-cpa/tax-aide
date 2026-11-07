# API permission & deadline tests

`authz.test.mjs` checks the server-side permission policy (client scoping, maker / manager /
super_admin gates, immutable approval comments, stage locks, file-path safety) and the deadline
tax-year logic against a **running API server** — about 600 cases, no dependencies beyond Node 22+.

> **Destructive.** `fixture.sql` truncates every application table. Use a throwaway database.

```bash
# 1. a throwaway Postgres database
createdb taxaide_test
export DATABASE_URL=postgres://USER:PASS@localhost:5432/taxaide_test
pnpm --filter @workspace/db run push

# 2. start the API against it (UPLOADS_DIR must match step 3)
cd artifacts/api-server && pnpm run build
PORT=8080 SESSION_SECRET=test UPLOADS_DIR=/tmp/taxaide-test-uploads node dist/index.mjs &

# 3. run (PG* variables point the fixture reset at the same database)
cd ../..
TAXAIDE_TEST_RESET_DB=1 PGHOST=localhost PGUSER=USER PGPASSWORD=PASS PGDATABASE=taxaide_test \
  UPLOADS_DIR=/tmp/taxaide-test-uploads node tests/api/authz.test.mjs
```

Start the server once before the first run so it seeds the four demo users; the fixture keeps
users 1–4 and adds the others. `ONLY="9 deadline"` runs a single group.
