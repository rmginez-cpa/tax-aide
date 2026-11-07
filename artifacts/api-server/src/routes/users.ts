import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  clientsTable,
  engagementsTable,
  notificationsTable,
  assistantConversationsTable,
} from "@workspace/db";
import { requireAuth, requireRole, isClientRole, isStaffRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";
import { passwordPolicyError } from "../lib/passwordPolicy";

const router = Router();

const VALID_ROLES = ["super_admin", "manager", "maker", "accountant", "client", "viewer"] as const;

function isValidRole(r: string): boolean {
  return (VALID_ROLES as readonly string[]).includes(r);
}

/**
 * Parses a clientId from a request body and checks that the client exists.
 * Returns { clientId } (null = unlinked) or { error } for a 400.
 */
async function resolveClientId(value: unknown): Promise<{ clientId: number | null } | { error: string }> {
  if (value == null || value === "" || value === "none") return { clientId: null };
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return { error: "clientId must be a positive integer" };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return { error: "clientId must be a positive integer" };
  const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, n));
  if (!client) return { error: "Client not found" };
  return { clientId: client.id };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const LAST_SUPER_ADMIN_ERROR = "At least one super admin account must remain";

/**
 * Whether a super_admin other than `userId` exists. Locks every super_admin row (FOR UPDATE)
 * for the rest of the transaction, so two concurrent demotions / deletions of different
 * super admins are serialized and cannot both remove "the other" one.
 */
async function otherSuperAdminExists(tx: Tx, userId: number): Promise<boolean> {
  const admins = await tx
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.role, "super_admin"))
    .for("update");
  return admins.some((a) => a.id !== userId);
}

function serializeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clientId: user.clientId ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

// ── GET /api/users ─────────────────────────────────────────────────────────
// Super admin sees all users. Other staff see the firm's staff (for assignee
// dropdowns). Client accounts only get their own record: the staff names they
// need already come with their engagements and comments.
router.get("/users", requireAuth, async (req, res): Promise<void> => {
  const role = req.session.userRole || "";
  const users = await db.select().from(usersTable).orderBy(usersTable.name);

  if (role === "super_admin") {
    res.json(users.map(serializeUser));
    return;
  }

  if (isClientRole(role)) {
    res.json(users.filter((u) => u.id === req.session.userId).map(serializeUser));
    return;
  }

  // Other staff: only staff accounts, never client accounts or super admins.
  const staff = users.filter((u) => isStaffRole(u.role) && u.role !== "super_admin");

  res.json(staff.map(serializeUser));
});

// ── POST /api/users ────────────────────────────────────────────────────────
router.post("/users", requireRole("super_admin"), async (req, res): Promise<void> => {
  const { email, name, role, password, clientId } = req.body ?? {};

  if (!email || !name || !role || !password) {
    res.status(400).json({ error: "email, name, role, and password are required" });
    return;
  }
  if (typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "Invalid email address" });
    return;
  }
  if (!isValidRole(role)) {
    res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    return;
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  // Check email uniqueness
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const resolved = await resolveClientId(clientId);
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const parsedClientId = resolved.clientId;

  const passwordHash = await bcrypt.hash(password, 10);

  const [user] = await db
    .insert(usersTable)
    .values({ email: email.toLowerCase(), name, role, passwordHash, clientId: parsedClientId })
    .returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "user",
    entityId: user.id,
    description: `Created user ${name} (${email}) with role ${role}`,
  });

  res.status(201).json(serializeUser(user));
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────
router.get("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const callerId = req.session.userId!;
  const callerRole = req.session.userRole || "";

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  // Self always; super_admin anyone; other staff may view staff accounts.
  // Everything else answers 404 so account existence is not leaked.
  const visible =
    user != null &&
    (user.id === callerId ||
      callerRole === "super_admin" ||
      (isStaffRole(callerRole) && isStaffRole(user.role)));
  if (!visible) { res.status(404).json({ error: "User not found" }); return; }

  res.json(serializeUser(user));
});

// ── PATCH /api/users/:id ───────────────────────────────────────────────────
router.patch("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const callerRole = req.session.userRole || "";
  const callerId = req.session.userId!;

  // Non-super_admins can only update themselves
  if (callerRole !== "super_admin" && callerId !== id) {
    res.status(403).json({ error: "You can only update your own profile" });
    return;
  }

  const { name, role, password, clientId, currentPassword } = req.body ?? {};
  const updates: Partial<typeof usersTable.$inferInsert> = {};

  if (name != null) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "Name must be a non-empty string" }); return;
    }
    updates.name = name.trim();
  }

  if (password != null) {
    const passwordError = passwordPolicyError(password);
    if (passwordError) {
      res.status(400).json({ error: passwordError }); return;
    }
    // Changing your own password needs the current one, so a stolen or left-open
    // session cannot lock the owner out. (A super_admin resetting someone else's does not.)
    if (callerId === id) {
      if (typeof currentPassword !== "string" || currentPassword === "") {
        res.status(400).json({ error: "Enter your current password to change it" }); return;
      }
      const [self] = await db.select({ passwordHash: usersTable.passwordHash }).from(usersTable).where(eq(usersTable.id, id));
      if (!self || !(await bcrypt.compare(currentPassword, self.passwordHash))) {
        res.status(403).json({ error: "Current password is incorrect" }); return;
      }
    }
    updates.passwordHash = await bcrypt.hash(password, 10);
  }

  // Only super_admin can change role or clientId
  if (callerRole === "super_admin") {
    if (role != null) {
      if (!isValidRole(role)) {
        res.status(400).json({ error: `Invalid role` }); return;
      }
      updates.role = role;
    }
    if ("clientId" in req.body) {
      const resolved = await resolveClientId(clientId);
      if ("error" in resolved) {
        res.status(400).json({ error: resolved.error }); return;
      }
      updates.clientId = resolved.clientId;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Demoting a super admin: lock the super admins first, then re-read the target.
    if (updates.role != null && updates.role !== "super_admin") {
      const others = await otherSuperAdminExists(tx, id);
      const [target] = await tx.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, id));
      if (target?.role === "super_admin" && !others) return "last_super_admin" as const;
    }
    const [before] = await tx.select().from(usersTable).where(eq(usersTable.id, id));
    if (!before) return null;
    const [after] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();

    // A new password ends every other session of that account (an attacker's included);
    // the caller's own session stays signed in.
    if (updates.passwordHash) {
      await tx.execute(sql`DELETE FROM user_sessions WHERE (sess->>'userId') = ${String(id)} AND sid <> ${req.sessionID}`);
    }

    // Data the account saw under its old scope must not follow it to the new one.
    const scopeChanged = before.role !== after.role || (before.clientId ?? null) !== (after.clientId ?? null);
    if (scopeChanged) {
      // Stored assistant conversations replay earlier tool results to the model.
      await tx.delete(assistantConversationsTable).where(eq(assistantConversationsTable.userId, id));
    }
    if (isStaffRole(before.role) && !isStaffRole(after.role)) {
      // A former staff member keeps no filings assigned to them and none of the
      // notifications about other clients' filings they received as staff.
      await tx.update(engagementsTable).set({ assignedTo: null }).where(eq(engagementsTable.assignedTo, id));
      await tx.delete(notificationsTable).where(eq(notificationsTable.userId, id));
    }
    return after;
  });

  if (result === "last_super_admin") { res.status(409).json({ error: LAST_SUPER_ADMIN_ERROR }); return; }
  const user = result;
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "user",
    entityId: user.id,
    description: `Updated user ${user.name}`,
  });

  res.json(serializeUser(user));
});

// ── DELETE /api/users/:id ──────────────────────────────────────────────────
router.delete("/users/:id", requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const callerId = req.session.userId!;
  if (callerId === id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  // The caller is a super admin, so this only triggers when two super admins delete each
  // other at the same time: the row locks make the second one see it would remove the last.
  const result = await db.transaction(async (tx) => {
    const others = await otherSuperAdminExists(tx, id);
    const [target] = await tx.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, id));
    if (!target) return null;
    if (target.role === "super_admin" && !others) return "last_super_admin" as const;
    // The caller must still exist (and still be a super admin) once the locks are held.
    const [caller] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, callerId), eq(usersTable.role, "super_admin"), ne(usersTable.id, id)));
    if (!caller) return "caller_gone" as const;
    const [deleted] = await tx.delete(usersTable).where(eq(usersTable.id, id)).returning();
    return deleted ?? null;
  });
  if (result === "last_super_admin") { res.status(409).json({ error: LAST_SUPER_ADMIN_ERROR }); return; }
  if (result === "caller_gone") { res.status(403).json({ error: "Forbidden" }); return; }
  const user = result;
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "user",
    entityId: id,
    description: `Deleted user ${user.name} (${user.email})`,
  });

  res.sendStatus(204);
});

export default router;
