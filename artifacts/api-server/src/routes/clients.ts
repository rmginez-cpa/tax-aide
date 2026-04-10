import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, clientsTable } from "@workspace/db";
import {
  CreateClientBody,
  UpdateClientBody,
  GetClientParams,
  UpdateClientParams,
  DeleteClientParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { logAudit } from "../lib/audit";

const router = Router();

function serializeClient(c: typeof clientsTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    tin: c.tin,
    businessType: c.businessType,
    contactEmail: c.contactEmail ?? null,
    contactPhone: c.contactPhone ?? null,
    address: c.address ?? null,
    fiscalYearEnd: c.fiscalYearEnd ?? null,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

router.get("/clients", requireAuth, async (req, res): Promise<void> => {
  const clients = await db.select().from(clientsTable).orderBy(clientsTable.name);
  res.json(clients.map(serializeClient));
});

router.post("/clients", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [client] = await db.insert(clientsTable).values(parsed.data).returning();

  await logAudit({
    userId: req.session.userId,
    action: "create",
    entityType: "client",
    entityId: client.id,
    description: `Created client ${client.name} (TIN: ${client.tin})`,
  });

  res.status(201).json(serializeClient(client));
});

router.get("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, params.data.id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json(serializeClient(client));
});

router.patch("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof clientsTable.$inferInsert> = {};
  if (parsed.data.name != null) updates.name = parsed.data.name;
  if (parsed.data.tin != null) updates.tin = parsed.data.tin;
  if (parsed.data.businessType != null) updates.businessType = parsed.data.businessType;
  if ("contactEmail" in parsed.data) updates.contactEmail = parsed.data.contactEmail ?? null;
  if ("contactPhone" in parsed.data) updates.contactPhone = parsed.data.contactPhone ?? null;
  if ("address" in parsed.data) updates.address = parsed.data.address ?? null;
  if ("fiscalYearEnd" in parsed.data) updates.fiscalYearEnd = parsed.data.fiscalYearEnd ?? null;
  if (parsed.data.status != null) updates.status = parsed.data.status;

  const [client] = await db.update(clientsTable).set(updates).where(eq(clientsTable.id, params.data.id)).returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "update",
    entityType: "client",
    entityId: client.id,
    description: `Updated client ${client.name}`,
  });

  res.json(serializeClient(client));
});

router.delete("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [client] = await db.delete(clientsTable).where(eq(clientsTable.id, params.data.id)).returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  await logAudit({
    userId: req.session.userId,
    action: "delete",
    entityType: "client",
    entityId: params.data.id,
    description: `Deleted client ${client.name}`,
  });

  res.sendStatus(204);
});

export default router;
