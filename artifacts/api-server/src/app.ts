import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool, db, usersTable, clientsTable } from "@workspace/db";

const PgSession = connectPgSimple(session);

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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET || "tax-cms-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use("/api", router);

// ── Startup seed: create default accounts if none exist ───────────────────────
async function seedDefaultAccounts() {
  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (existing.length > 0) {
      logger.info("Seed skipped: users already exist");
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

// Run seed asynchronously on startup (does not block the server from starting)
seedDefaultAccounts();

export default app;
