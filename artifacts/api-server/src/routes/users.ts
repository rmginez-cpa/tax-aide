import { Router } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

const VALID_ROLES = ["super_admin", "manager", "maker", "accountant", "client", "viewer"] as const;

function isValidRole(r: string): boolean {
  return (VALID_ROLES as readonly string[]).includes(r);
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
// Super admin sees all users; others see staff only (for dropdowns)
router.get("/users", requireAuth, async (req, res): Promise<void> => {
  const role = req.session.userRole || "";
  const users = await db.select().from(usersTable).orderBy(usersTable.name);

  if (role === "super_admin") {
    res.json(users.map(serializeUser));
    return;
  }

  // For non-admins: only expose staff accounts
  const staff = users.filter(u => !["client", "super_admin"].includes(u.role));
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
  if (typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  // Check email uniqueness
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase()));
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const parsedClientId = clientId != null && clientId !== "" ? parseInt(String(clientId)) : null;

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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.json(serializeUser(user));
});

// ── PATCH /api/users/:id ───────────────────────────────────────────────────
router.patch("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const callerRole = req.session.userRole || "";
  const callerId = req.session.userId!;

  // Non-super_admins can only update themselves
  if (callerRole !== "super_admin" && callerId !== id) {
    res.status(403).json({ error: "You can only update your own profile" });
    return;
  }

  const { name, role, password, clientId } = req.body ?? {};
  const updates: Partial<typeof usersTable.$inferInsert> = {};

  if (name != null) {
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "Name must be a non-empty string" }); return;
    }
    updates.name = name.trim();
  }

  if (password != null) {
    if (typeof password !== "string" || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" }); return;
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
      const parsed = clientId != null && clientId !== "" && clientId !== "none"
        ? parseInt(String(clientId)) : null;
      updates.clientId = parsed;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

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
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const callerId = req.session.userId!;
  if (callerId === id) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  const [user] = await db.delete(usersTable).where(eq(usersTable.id, id)).returning();
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
