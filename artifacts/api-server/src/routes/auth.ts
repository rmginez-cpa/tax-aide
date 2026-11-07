import { Router, type Request } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { LoginRateLimiter, describeWait } from "../lib/rateLimit";
import { SESSION_COOKIE_NAME, cookieSecure, demoAccountsEnabled } from "../lib/security";

const router = Router();

const loginLimiter = new LoginRateLimiter();

// Compared against when the email is unknown, so a miss costs about as much as a
// wrong password and response timing does not reveal which emails have accounts.
// Same cost factor (10) as the stored hashes.
const dummyHash: Promise<string> = bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10);

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

function clientIp(req: Request): string {
  // req.ip honours app.set("trust proxy"), so behind Replit's proxy it is the
  // caller's address rather than the proxy's.
  return req.ip || req.socket.remoteAddress || "unknown";
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

// ── GET /api/auth/config (no auth) ───────────────────────────────────────────
// CONTRACT: { demoAccounts: boolean } — whether the login page may show demo accounts.
router.get("/auth/config", (_req, res): void => {
  res.json({ demoAccounts: demoAccountsEnabled() });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = normaliseEmail(parsed.data.email);
  const { password } = parsed.data;
  const ip = clientIp(req);

  const wait = loginLimiter.begin(ip, email);
  if (wait > 0) {
    res.setHeader("Retry-After", String(wait));
    res.status(429).json({
      error: `Too many failed sign-in attempts. Please wait ${describeWait(wait)} and try again.`,
      retryAfter: wait,
    });
    return;
  }

  const [user] = email
    ? await db.select().from(usersTable).where(sql`lower(${usersTable.email}) = ${email}`).limit(1)
    : [];

  const valid = await bcrypt.compare(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !valid) {
    // Already counted by begin().
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  loginLimiter.succeeded(ip, email);

  // New session id on every sign-in (session fixation): the pre-login session,
  // including one planted by an attacker, is destroyed.
  try {
    await regenerate(req);
    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.userClientId = user.clientId ?? null;
    await save(req);
  } catch (err) {
    req.log.error({ err }, "Could not create session");
    res.status(500).json({ error: "Could not sign in, please try again" });
    return;
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clientId: user.clientId ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    message: "Logged in successfully",
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  req.session.destroy((err) => {
    if (err) req.log.warn({ err }, "Session destroy failed on logout");
    res.clearCookie(SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(),
    });
    res.json({ message: "Logged out successfully" });
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));

  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clientId: user.clientId ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  });
});

export default router;
