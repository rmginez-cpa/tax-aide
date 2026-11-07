import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  ConfigError,
  SESSION_COOKIE_NAME,
  allowedOrigins,
  cookieSecure,
  corsOptions,
  demoAccountsEnabled,
  isProduction,
  resolveSessionSecret,
  securityHeaders,
  trustProxySetting,
} from "./lib/security";
import { passwordPolicyError } from "./lib/passwordPolicy";
import { pool, db, usersTable, clientsTable, engagementsTable } from "@workspace/db";
import { createMcpProtocolRouter } from "./routes/mcp";
import { configuredBaseUrl, mcpEnabled, redirectRules } from "./lib/mcp/config";
import { startOAuthCleanup } from "./lib/mcp/oauthProvider";
import { taxTypeFromDeadlineTitle } from "./lib/filingLabels";

const PgSession = connectPgSimple(session);

// ── Security configuration (fail fast on a bad production setup) ─────────────
let sessionSecret: string;
const MCP = mcpEnabled();
try {
  const resolved = resolveSessionSecret();
  sessionSecret = resolved.secret;
  if (resolved.warning) logger.warn(resolved.warning);
  if (MCP) {
    // Validates PUBLIC_BASE_URL and MCP_ALLOWED_REDIRECT_URIS now rather than on the first connection.
    const base = configuredBaseUrl();
    redirectRules();
    logger.info({ publicBaseUrl: base?.origin ?? "(derived from each request)" }, "MCP connector enabled at /api/mcp");
  }
} catch (err) {
  if (err instanceof ConfigError) {
    // console.error as well: the pretty-printing logger transport is asynchronous.
    console.error(`FATAL: ${err.message}`);
    logger.fatal(err.message);
    process.exit(1);
  }
  throw err;
}

const DEMO_ACCOUNTS = demoAccountsEnabled();
if (DEMO_ACCOUNTS && isProduction()) {
  const banner = "!".repeat(78);
  const msg =
    "SECURITY WARNING: demo accounts are ENABLED in production (SEED_DEMO_ACCOUNTS=true). " +
    "Anyone can sign in with the published demo passwords. Unset SEED_DEMO_ACCOUNTS and " +
    "delete or re-password the demo users (admin@firm.ph, manager@firm.ph, accountant@firm.ph, client@example.com).";
  console.warn(`${banner}\n${msg}\n${banner}`);
  logger.warn(msg);
}

// Ensure session table exists without relying on the bundled table.sql file
pool.query(`
  CREATE TABLE IF NOT EXISTS "user_sessions" (
    "sid" varchar NOT NULL COLLATE "default",
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
  );
  CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
`).catch((err: Error) => logger.warn({ err }, "Session table setup warning (may already exist)"));

const app: Express = express();

app.disable("x-powered-by");
const trustProxy = trustProxySetting();
if (trustProxy !== false) app.set("trust proxy", trustProxy);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use("/api", securityHeaders);

// The web app is served from the same origin, so CORS is off unless specific
// origins are listed in ALLOWED_ORIGINS (never reflect arbitrary origins with credentials).
const origins = allowedOrigins();
if (origins.length > 0) {
  app.use(cors(corsOptions(origins)));
  logger.info({ origins }, "CORS enabled for ALLOWED_ORIGINS");
}

// The MCP connector (OAuth endpoints, discovery documents, /api/mcp) authenticates with
// bearer tokens: it goes before the body parsers (it has its own, smaller limits) and
// before the cookie session, which it must neither read nor create.
if (MCP) {
  app.use(createMcpProtocolRouter());
  startOAuthCleanup();
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
    }),
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: cookieSecure(),
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", router);

// JSON errors (body too large, malformed JSON, upload errors...) instead of
// Express's HTML page, which includes a stack trace outside production.
app.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
  // multer's errors carry no HTTP status: they are all problems with the upload itself.
  const multerStatus = e?.name === "MulterError" ? (e.code === "LIMIT_FILE_SIZE" ? 413 : 400) : undefined;
  const raw = Number(multerStatus ?? e?.status ?? e?.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) req.log.error({ err }, "Unhandled error");
  const message =
    status === 413
      ? multerStatus ? "File is too large" : "Request body is too large"
      : status < 500 && typeof e?.message === "string" && e.expose !== false
        ? e.message
        : status < 500
          ? "Bad request"
          : "Internal server error";
  res.status(status).json({ error: message });
});

// ── Startup seed: create default accounts if none exist ───────────────────────
// Demo accounts are seeded only when the CONTRACT says so (demoAccountsEnabled()).
// Without them, BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD create the first
// super_admin on an empty database.
async function seedDefaultAccounts() {
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (existing.length > 0) {
      logger.info("Seed skipped: users already exist");
      return;
    }

    if (!DEMO_ACCOUNTS) {
      await bootstrapAdmin();
      return;
    }

    logger.info("Seeding default accounts...");

    // Find EverBright client if it exists (for client user linking)
    const [everbright] = await db.select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.name, "Everbright Real Estate Inc."))
      .limit(1);

    const accounts = [
      { email: "admin@firm.ph", name: "System Administrator", role: "super_admin", password: "admin123", clientId: null },
      { email: "manager@firm.ph", name: "Maria Santos", role: "manager", password: "manager123", clientId: null },
      { email: "accountant@firm.ph", name: "Juan Dela Cruz", role: "maker", password: "accountant123", clientId: null },
      { email: "client@example.com", name: "Pedro Reyes", role: "client", password: "client123", clientId: everbright?.id ?? null },
    ];

    for (const acct of accounts) {
      const passwordHash = await bcrypt.hash(acct.password, 10);
      await db.insert(usersTable).values({
        email: acct.email,
        name: acct.name,
        role: acct.role,
        passwordHash,
        clientId: acct.clientId,
      }).onConflictDoNothing();
      logger.info({ email: acct.email, role: acct.role }, "Seeded user");
    }

    logger.info("Default accounts seeded successfully");
  } catch (err) {
    logger.warn({ err }, "Seed failed (non-fatal — accounts may already exist)");
  }
}

async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    logger.warn(
      "No user accounts exist and demo accounts are disabled. Set BOOTSTRAP_ADMIN_EMAIL and " +
        "BOOTSTRAP_ADMIN_PASSWORD and restart to create the first super admin.",
    );
    return;
  }
  const policyError = passwordPolicyError(password);
  if (!email.includes("@") || policyError) {
    logger.error({ reason: policyError ?? "BOOTSTRAP_ADMIN_EMAIL is not a valid email address" }, "Bootstrap admin not created");
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(usersTable).values({
    email,
    name: "System Administrator",
    role: "super_admin",
    passwordHash,
    clientId: null,
  }).onConflictDoNothing();
  logger.warn({ email }, "Created bootstrap super admin; remove BOOTSTRAP_ADMIN_PASSWORD from the environment now");
}

/**
 * One-off data fix (idempotent): engagements started from a deadline used to store the
 * whole deadline title as their tax type ("BIR Form 1601C — February 2026"); store the
 * form code ("1601C") like every other engagement.
 */
async function backfillEngagementTaxTypes() {
  const rows = await db
    .select({ id: engagementsTable.id, title: engagementsTable.title })
    .from(engagementsTable)
    .where(eq(engagementsTable.taxType, engagementsTable.title));
  let fixed = 0;
  for (const row of rows) {
    const taxType = taxTypeFromDeadlineTitle(row.title);
    if (taxType === row.title) continue;
    await db.update(engagementsTable).set({ taxType }).where(eq(engagementsTable.id, row.id));
    fixed++;
  }
  if (fixed) logger.info({ fixed }, "Backfilled engagement tax types from deadline titles");
}

// Run seed asynchronously on startup (does not block the server from starting)
seedDefaultAccounts();
backfillEngagementTaxTypes().catch((err: Error) => logger.warn({ err }, "Engagement tax type backfill failed"));

export default app;
