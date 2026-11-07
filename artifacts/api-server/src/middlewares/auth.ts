import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    userRole?: string;
    userClientId?: number | null;
  }
}

// ── Roles ─────────────────────────────────────────────────────────────────────
// super_admin  everything (bypasses every role gate)
// manager      reviews/approves stages, deletes, sees the audit log
// maker        (= legacy "accountant") prepares filings, uploads, submits stages
// client       (= legacy "viewer") read-only, and only for their own linked client

export function isClientRole(role: string | undefined | null): boolean {
  return role === "client" || role === "viewer";
}

export function isStaffRole(role: string | undefined | null): boolean {
  return role === "super_admin" || role === "manager" || role === "maker" || role === "accountant";
}

export function isManagerRole(role: string | undefined | null): boolean {
  return role === "super_admin" || role === "manager";
}

/**
 * Re-reads the signed-in user on every request so that a role change, a client
 * re-link or a deleted account takes effect immediately instead of when the
 * 7-day session expires. Returns false (and sends 401) when there is no valid user.
 */
async function loadSessionUser(req: Request, res: Response): Promise<boolean> {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const [user] = await db
    .select({ role: usersTable.role, clientId: usersTable.clientId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  req.session.userRole = user.role;
  req.session.userClientId = user.clientId ?? null;
  return true;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await loadSessionUser(req, res))) return;
  next();
}

// super_admin bypasses all role checks (they can do anything)
// maker is treated as equivalent to accountant everywhere
export function requireRole(...roles: string[]) {
  const allowed = new Set(roles);
  if (allowed.has("accountant")) allowed.add("maker");
  if (allowed.has("maker")) allowed.add("accountant");
  if (allowed.has("client")) allowed.add("viewer");
  if (allowed.has("viewer")) allowed.add("client");

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!(await loadSessionUser(req, res))) return;
    const role = req.session.userRole || "";
    if (role !== "super_admin" && !allowed.has(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

/** Firm staff: makers, managers and super admins. */
export const requireStaff = requireRole("maker", "manager");

/** Managers and super admins. */
export const requireManager = requireRole("manager");

/**
 * The client a session is restricted to.
 * - `null`   staff: no restriction
 * - a number the only client this session may see. An unlinked client account
 *            gets 0, which matches no row (ids start at 1), so it sees nothing.
 */
export function clientScope(req: Request): number | null {
  return clientScopeFor({ role: req.session.userRole ?? "", clientId: req.session.userClientId ?? null });
}

/** Who is acting, independent of how they signed in (session cookie or connector token). */
export interface Actor {
  id: number;
  role: string;
  clientId: number | null;
}

/** clientScope() for an actor: the one rule shared by the HTTP routes and the assistant / MCP tools. */
export function clientScopeFor(actor: Pick<Actor, "role" | "clientId">): number | null {
  if (!isClientRole(actor.role)) return null;
  return actor.clientId ?? 0;
}

/** Whether this session may see records belonging to `clientId`. */
export function canAccessClient(req: Request, clientId: number | null | undefined): boolean {
  const scope = clientScope(req);
  if (scope === null) return true;
  return clientId != null && clientId === scope;
}

// Kept for compatibility; prefer clientScope()/canAccessClient().
export function requireClient(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (isClientRole(req.session.userRole) && !req.session.userClientId) {
    res.status(403).json({ error: "Client account is not linked to a client record" });
    return;
  }
  next();
}

/** The signed-in user as an Actor (after requireAuth / requireRole has refreshed role and client). */
export function sessionActor(req: Request): Actor {
  return { id: req.session.userId!, role: req.session.userRole ?? "", clientId: req.session.userClientId ?? null };
}
