import { Router, type Request, type Response } from "express";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { requireManager } from "../middlewares/auth";
import { addDays, manilaToday } from "../lib/dates";
import { logAudit } from "../lib/audit";

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const EXPORT_MAX_ROWS = 10_000;
const MAX_TEXT_FILTER = 200;

// ── Query parsing ─────────────────────────────────────────────────────────────

/** First string value of a query param (Express gives arrays for repeated keys). */
function param(req: Request, name: string): string | undefined {
  const v = req.query[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

function positiveInt(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A real YYYY-MM-DD calendar date. */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Start of a Manila calendar day as an instant (Manila is UTC+8 all year, no DST). */
function manilaDayStart(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00+08:00`);
}

/** Escapes LIKE wildcards so `q` matches literally (Postgres' default escape character is backslash). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Filters = { conditions: SQL[] } | { error: string };

/**
 * Builds the WHERE conditions shared by the list and the CSV export.
 * Params: engagementId / clientId (entity shortcuts, as before), userId, action,
 * entityType, from / to (inclusive Asia/Manila dates, YYYY-MM-DD) and q
 * (case-insensitive substring of the description).
 */
function parseFilters(req: Request): Filters {
  const conditions: SQL[] = [];

  const entityShortcut = (name: string, entityType: string): string | null => {
    const raw = param(req, name);
    if (raw == null) return null;
    const id = positiveInt(raw);
    if (id == null) return `${name} must be a positive integer`;
    conditions.push(eq(auditLogsTable.entityType, entityType), eq(auditLogsTable.entityId, id));
    return null;
  };
  const shortcutError = entityShortcut("engagementId", "engagement") ?? entityShortcut("clientId", "client");
  if (shortcutError) return { error: shortcutError };

  const userIdRaw = param(req, "userId");
  if (userIdRaw != null) {
    const userId = positiveInt(userIdRaw);
    if (userId == null) return { error: "userId must be a positive integer" };
    conditions.push(eq(auditLogsTable.userId, userId));
  }

  const action = param(req, "action");
  if (action != null) {
    if (action.length > 64) return { error: "action is too long" };
    conditions.push(eq(auditLogsTable.action, action));
  }

  const entityType = param(req, "entityType");
  if (entityType != null) {
    if (entityType.length > 64) return { error: "entityType is too long" };
    conditions.push(eq(auditLogsTable.entityType, entityType));
  }

  const from = param(req, "from");
  if (from != null) {
    if (!isIsoDate(from)) return { error: "from must be a date (YYYY-MM-DD)" };
    conditions.push(gte(auditLogsTable.createdAt, manilaDayStart(from)));
  }
  const to = param(req, "to");
  if (to != null) {
    if (!isIsoDate(to)) return { error: "to must be a date (YYYY-MM-DD)" };
    // Inclusive: everything before the start of the next Manila day.
    conditions.push(lt(auditLogsTable.createdAt, manilaDayStart(addDays(to, 1))));
  }

  const q = param(req, "q");
  if (q != null) {
    if (q.length > MAX_TEXT_FILTER) return { error: `q must be at most ${MAX_TEXT_FILTER} characters` };
    conditions.push(ilike(auditLogsTable.description, `%${escapeLike(q)}%`));
  }

  return { conditions };
}

function whereOf(conditions: SQL[]): SQL | undefined {
  return conditions.length ? and(...conditions) : undefined;
}

async function countMatching(where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLogsTable).where(where);
  return Number(row?.n ?? 0);
}

async function userNamesFor(logs: { userId: number | null }[]): Promise<Map<number, string>> {
  const userIds = [...new Set(logs.map((l) => l.userId).filter((id): id is number => id != null))];
  if (!userIds.length) return new Map();
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Integer query param clamped to [min, max]; missing or malformed -> fallback. */
function intParam(req: Request, name: string, fallback: number, min: number, max: number): number {
  const raw = param(req, name);
  if (raw == null) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function sendFilterError(res: Response, error: string): void {
  res.status(400).json({ error });
}

// ── GET /api/audit-logs ──────────────────────────────────────────────────────
// The audit trail is for managers and super admins only.
// Paginated with offset/limit (default 50, max 500); the number of matching rows
// is returned in the X-Total-Count header. The body stays a plain array.
router.get("/audit-logs", requireManager, async (req, res): Promise<void> => {
  const filters = parseFilters(req);
  if ("error" in filters) {
    sendFilterError(res, filters.error);
    return;
  }

  const limitRaw = intParam(req, "limit", DEFAULT_LIMIT, 0, MAX_LIMIT);
  const limit = limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
  const offset = intParam(req, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const where = whereOf(filters.conditions);

  const [logs, total] = await Promise.all([
    db
      .select()
      .from(auditLogsTable)
      .where(where)
      .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
      .limit(limit)
      .offset(offset),
    countMatching(where),
  ]);
  const userNames = await userNamesFor(logs);

  res.setHeader("X-Total-Count", String(total));
  res.append("Access-Control-Expose-Headers", "X-Total-Count");
  res.json(logs.map((log) => ({
    id: log.id,
    userId: log.userId ?? null,
    userName: log.userId != null ? userNames.get(log.userId) ?? null : null,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId ?? null,
    description: log.description,
    metadata: log.metadata ?? null,
    createdAt: log.createdAt.toISOString(),
  })));
});

// ── GET /api/audit-logs/filters ──────────────────────────────────────────────
// Values for the audit page's filter dropdowns: the users, actions and entity
// types that actually occur in the log.
router.get("/audit-logs/filters", requireManager, async (_req, res): Promise<void> => {
  const [userRows, actionRows, entityRows] = await Promise.all([
    db
      .selectDistinct({ id: auditLogsTable.userId, name: usersTable.name })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(usersTable.id, auditLogsTable.userId))
      .where(isNotNull(auditLogsTable.userId)),
    db.selectDistinct({ v: auditLogsTable.action }).from(auditLogsTable).orderBy(asc(auditLogsTable.action)),
    db.selectDistinct({ v: auditLogsTable.entityType }).from(auditLogsTable).orderBy(asc(auditLogsTable.entityType)),
  ]);

  const users = userRows
    .filter((u): u is { id: number; name: string | null } => u.id != null)
    .map((u) => ({ id: u.id, name: u.name ?? `User #${u.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  res.json({
    users,
    actions: actionRows.map((r) => r.v),
    entityTypes: entityRows.map((r) => r.v),
  });
});

// ── GET /api/audit-logs/export.csv ───────────────────────────────────────────
// Same filters as the list, newest first, at most 10,000 rows (X-Total-Count has
// the full match count; X-Export-Truncated: true when rows were left out).

/** RFC 4180 field: quoted when it contains a comma, quote or line break; quotes doubled. */
function csvField(value: unknown): string {
  let s = value == null ? "" : String(value);
  // Spreadsheet formula injection: a cell starting with = + - @ (or tab / CR) would be
  // evaluated by Excel/Sheets, so prefix it with an apostrophe.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const manilaParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** "YYYY-MM-DD HH:mm:ss" in Asia/Manila. */
function manilaTimestamp(d: Date): string {
  const p = Object.fromEntries(manilaParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const CSV_HEADER = [
  "ID",
  "Timestamp (Asia/Manila)",
  "Timestamp (UTC)",
  "User ID",
  "User",
  "Action",
  "Entity Type",
  "Entity ID",
  "Description",
  "Metadata",
];

router.get("/audit-logs/export.csv", requireManager, async (req, res): Promise<void> => {
  const filters = parseFilters(req);
  if ("error" in filters) {
    sendFilterError(res, filters.error);
    return;
  }
  const where = whereOf(filters.conditions);

  const [logs, total] = await Promise.all([
    db
      .select()
      .from(auditLogsTable)
      .where(where)
      .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
      .limit(EXPORT_MAX_ROWS),
    countMatching(where),
  ]);
  const userNames = await userNamesFor(logs);

  const lines = [CSV_HEADER.map(csvField).join(",")];
  for (const log of logs) {
    lines.push([
      log.id,
      manilaTimestamp(log.createdAt),
      log.createdAt.toISOString(),
      log.userId,
      log.userId != null ? userNames.get(log.userId) ?? "" : "",
      log.action,
      log.entityType,
      log.entityId,
      log.description,
      log.metadata,
    ].map(csvField).join(","));
  }

  await logAudit({
    userId: req.session.userId,
    action: "export",
    entityType: "audit_log",
    description: `Exported ${logs.length} audit log entr${logs.length === 1 ? "y" : "ies"} to CSV`,
    metadata: { rows: logs.length, total, query: req.query },
  });

  const truncated = total > logs.length;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="audit-log-${manilaToday()}.csv"`);
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
  res.append("Access-Control-Expose-Headers", "X-Total-Count, X-Export-Truncated, Content-Disposition");
  // UTF-8 BOM so Excel reads names like "Peña" correctly; CRLF line endings per RFC 4180.
  res.send(`﻿${lines.join("\r\n")}\r\n`);
});

export default router;
