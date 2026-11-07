import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { CorsOptions } from "cors";

/**
 * Deployment / security configuration, read from the environment.
 * See the "Security / deployment" section of replit.md for every variable.
 */

export const SESSION_COOKIE_NAME = "connect.sid";

/** The secret that used to be hard-coded; refused in production. */
const LEGACY_DEFAULT_SECRET = "tax-cms-secret-key";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Parses "true"/"false"/"1"/"0"/"yes"/"no"; anything else (or unset) gives undefined. */
function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface SessionSecret {
  secret: string;
  /** Set when the secret is not suitable for production use. */
  warning?: string;
}

/**
 * SESSION_SECRET is required in production. In development a random secret is
 * generated per process (sessions then do not survive a restart) with a warning.
 */
export function resolveSessionSecret(): SessionSecret {
  const secret = process.env.SESSION_SECRET?.trim() ?? "";
  if (isProduction()) {
    if (!secret) {
      throw new ConfigError(
        "SESSION_SECRET must be set when NODE_ENV=production. " +
          "Add a long random value (e.g. `openssl rand -hex 32`) as a deployment secret.",
      );
    }
    if (secret === LEGACY_DEFAULT_SECRET) {
      throw new ConfigError(
        `SESSION_SECRET is set to the old public default "${LEGACY_DEFAULT_SECRET}". ` +
          "Replace it with a long random value (e.g. `openssl rand -hex 32`).",
      );
    }
    if (secret.length < 32) {
      return { secret, warning: "SESSION_SECRET is shorter than 32 characters; use a longer random value." };
    }
    return { secret };
  }
  if (secret) return { secret };
  return {
    secret: crypto.randomBytes(32).toString("hex"),
    warning:
      "SESSION_SECRET is not set: using a random per-process secret (development only). " +
      "Sessions will not survive a server restart.",
  };
}

/** Secure cookies in production; COOKIE_SECURE=true|false overrides. */
export function cookieSecure(): boolean {
  return envBool("COOKIE_SECURE") ?? isProduction();
}

/**
 * Value for app.set("trust proxy"): 1 hop in production (Replit terminates TLS at
 * a proxy) or when TRUST_PROXY is set. TRUST_PROXY=false disables it; a number
 * sets the hop count.
 */
export function trustProxySetting(): number | false {
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  if (raw) return 1;
  return isProduction() ? 1 : false;
}

/**
 * CONTRACT (GET /api/auth/config): demo accounts are enabled when
 * SEED_DEMO_ACCOUNTS === "true", or when NODE_ENV !== "production" and
 * SEED_DEMO_ACCOUNTS !== "false".
 */
export function demoAccountsEnabled(): boolean {
  const v = process.env.SEED_DEMO_ACCOUNTS;
  if (v === "true") return true;
  return !isProduction() && v !== "false";
}

function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/** Origins from ALLOWED_ORIGINS (comma-separated). Empty = no CORS at all. */
export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(normaliseOrigin)
    .filter((o) => o.length > 0);
}

/** cors() options that only answer the listed origins (never reflects others). */
export function corsOptions(origins: string[]): CorsOptions {
  const allowed = new Set(origins);
  return {
    credentials: true,
    origin(origin, cb) {
      cb(null, origin != null && allowed.has(normaliseOrigin(origin)));
    },
  };
}

/** Routes that stream stored files inline and set their own headers. */
const FILE_ROUTES = [/^\/documents\/[^/]+\/content\/?$/];

/**
 * Security headers for /api responses. JSON responses also get a CSP that
 * forbids everything. File-content routes keep nosniff/Referrer-Policy but no CSP
 * or frame denial, so the viewer can still render PDFs and images.
 */
export const securityHeaders: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const isFileRoute = FILE_ROUTES.some((re) => re.test(req.path));
  if (!isFileRoute) {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    // API data is per-user (often tax records): never cache it in shared caches or on disk.
    res.setHeader("Cache-Control", "no-store");
  }
  next();
};
