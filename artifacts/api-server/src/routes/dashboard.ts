import { Router } from "express";
import { eq, and, lte, gte } from "drizzle-orm";
import { db, clientsTable, engagementsTable, deadlinesTable, auditLogsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const nowStr = now.toISOString().split("T")[0];
  const futureStr = thirtyDaysFromNow.toISOString().split("T")[0];
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];

  const [allClients, allEngagements, allDeadlines] = await Promise.all([
    db.select().from(clientsTable),
    db.select().from(engagementsTable),
    db.select().from(deadlinesTable),
  ]);

  const totalClients = allClients.length;
  const activeEngagements = allEngagements.filter((e) =>
    ["pending", "in_progress", "for_review"].includes(e.status)
  ).length;
  const upcomingDeadlines = allDeadlines.filter(
    (d) => d.dueDate >= nowStr && d.dueDate <= futureStr && d.status === "pending"
  ).length;
  const overdueItems = allDeadlines.filter(
    (d) => d.dueDate < nowStr && d.status === "pending"
  ).length;
  const pendingApprovals = allEngagements.filter((e) => e.status === "for_review").length;
  const completedThisMonth = allEngagements.filter(
    (e) => e.status === "completed" && e.updatedAt.toISOString().split("T")[0] >= startOfMonth
  ).length;

  res.json({
    totalClients,
    activeEngagements,
    upcomingDeadlines,
    overdueItems,
    pendingApprovals,
    completedThisMonth,
  });
});

router.get("/dashboard/upcoming-deadlines", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const nowStr = now.toISOString().split("T")[0];
  const futureStr = thirtyDaysFromNow.toISOString().split("T")[0];

  const deadlines = await db.select().from(deadlinesTable).orderBy(deadlinesTable.dueDate);
  const upcoming = deadlines.filter(
    (d) => d.dueDate >= nowStr && d.dueDate <= futureStr && d.status === "pending"
  );

  const result = await Promise.all(
    upcoming.map(async (d) => {
      let clientName: string | null = null;
      let engagementTitle: string | null = null;

      if (d.clientId) {
        const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, d.clientId));
        clientName = client?.name ?? null;
      }
      if (d.engagementId) {
        const [engagement] = await db.select().from(engagementsTable).where(eq(engagementsTable.id, d.engagementId));
        engagementTitle = engagement?.title ?? null;
      }

      const dueDate = new Date(d.dueDate);
      const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      return {
        id: d.id,
        title: d.title,
        dueDate: d.dueDate,
        status: d.status,
        priority: d.priority,
        clientName,
        engagementTitle,
        daysUntilDue,
      };
    })
  );

  res.json(result);
});

router.get("/dashboard/overdue", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();
  const nowStr = now.toISOString().split("T")[0];

  const [allDeadlines, allEngagements] = await Promise.all([
    db.select().from(deadlinesTable).orderBy(deadlinesTable.dueDate),
    db.select().from(engagementsTable),
  ]);

  const overdueDeadlines = await Promise.all(
    allDeadlines
      .filter((d) => d.dueDate < nowStr && d.status === "pending")
      .map(async (d) => {
        let clientName: string | null = null;
        if (d.clientId) {
          const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, d.clientId));
          clientName = client?.name ?? null;
        }
        return {
          id: d.id,
          engagementId: d.engagementId ?? null,
          clientId: d.clientId ?? null,
          clientName,
          title: d.title,
          description: d.description ?? null,
          dueDate: d.dueDate,
          status: "overdue",
          priority: d.priority,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        };
      })
  );

  const overdueEngagements = await Promise.all(
    allEngagements
      .filter((e) => e.dueDate && e.dueDate < nowStr && !["completed", "filed"].includes(e.status))
      .map(async (e) => {
        let clientName: string | null = null;
        if (e.clientId) {
          const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, e.clientId));
          clientName = client?.name ?? null;
        }
        return {
          id: e.id,
          clientId: e.clientId,
          clientName,
          title: e.title,
          taxType: e.taxType,
          period: e.period,
          fiscalYear: e.fiscalYear ?? null,
          status: e.status,
          assignedTo: e.assignedTo ?? null,
          assignedToName: null,
          approvedBy: e.approvedBy ?? null,
          approvedByName: null,
          approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
          approvalNotes: e.approvalNotes ?? null,
          dueDate: e.dueDate ?? null,
          notes: e.notes ?? null,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        };
      })
  );

  res.json({ overdueDeadlines, overdueEngagements });
});

router.get("/dashboard/recent-activity", requireAuth, async (req, res): Promise<void> => {
  const logs = await db
    .select()
    .from(auditLogsTable)
    .orderBy(auditLogsTable.createdAt)
    .limit(20);

  const serialized = await Promise.all(
    logs.map(async (log) => {
      let userName: string | null = null;
      if (log.userId) {
        const [user] = await db.select().from(usersTable).where(eq(usersTable.id, log.userId));
        userName = user?.name ?? null;
      }
      return {
        id: log.id,
        userId: log.userId ?? null,
        userName,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId ?? null,
        description: log.description,
        metadata: log.metadata ?? null,
        createdAt: log.createdAt.toISOString(),
      };
    })
  );

  res.json(serialized);
});

router.get("/dashboard/engagement-status", requireAuth, async (req, res): Promise<void> => {
  const engagements = await db.select().from(engagementsTable);

  const statusMap: Record<string, number> = {};
  for (const e of engagements) {
    statusMap[e.status] = (statusMap[e.status] ?? 0) + 1;
  }

  const result = Object.entries(statusMap).map(([status, count]) => ({ status, count }));
  res.json(result);
});

export default router;
