import { and, asc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { db, deadlinesTable } from "@workspace/db";

export type DeadlineRow = typeof deadlinesTable.$inferSelect;

const key = (clientId: number, title: string) => `${clientId}\u0000${title}`;

/**
 * The open (not completed) deadlines matching `where`, one row per filing.
 *
 * A deadline title embeds its period, so rows of one client that share a title
 * are copies of the same filing (older generate runs left duplicates). Such a
 * filing is open only when none of its copies is completed, and it counts once:
 * the engagement-linked copy, else the lowest id. Deadlines with no client are
 * kept as they are. Every status other than "completed" ("pending", "overdue")
 * is open. Ordered by due date, then id.
 *
 * `where` should only narrow by client: date windows are applied by the caller
 * to the returned rows, so a copy outside the window cannot hide a duplicate.
 */
export async function openDeadlines(where: SQL | undefined): Promise<DeadlineRow[]> {
  const rows = await db
    .select()
    .from(deadlinesTable)
    .where(and(ne(deadlinesTable.status, "completed"), where))
    .orderBy(asc(deadlinesTable.dueDate), asc(deadlinesTable.id));

  const keyed = rows.filter((r) => r.clientId != null);
  if (keyed.length === 0) return rows;

  const clientIds = [...new Set(keyed.map((r) => r.clientId!))];
  const titles = [...new Set(keyed.map((r) => r.title))];
  const completed = await db
    .select({ clientId: deadlinesTable.clientId, title: deadlinesTable.title })
    .from(deadlinesTable)
    .where(
      and(
        eq(deadlinesTable.status, "completed"),
        inArray(deadlinesTable.clientId, clientIds),
        inArray(deadlinesTable.title, titles),
      ),
    );
  const filed = new Set(completed.map((c) => key(c.clientId!, c.title)));

  const best = new Map<string, DeadlineRow>();
  const result: DeadlineRow[] = [];
  for (const row of rows) {
    if (row.clientId == null) {
      result.push(row);
      continue;
    }
    const k = key(row.clientId, row.title);
    if (filed.has(k)) continue;
    const current = best.get(k);
    const linked = row.engagementId != null;
    const currentLinked = current?.engagementId != null;
    if (!current || (linked && !currentLinked) || (linked === currentLinked && row.id < current.id)) {
      best.set(k, row);
    }
  }
  result.push(...best.values());
  return result.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id));
}
