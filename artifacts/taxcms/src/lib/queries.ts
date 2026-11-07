// Cache helpers for react-query. Orval keys look like ["/api/engagements", params?]
// or ["/api/engagements/12"]; a few pages also use hand-written keys
// ("dashboard-summary", "clients-list"), which are covered here too.

import type { Query, QueryClient } from "@tanstack/react-query";

/** URL prefixes of every query that shows filing data (engagements, deadlines, documents, ...). */
export const FILING_DATA_PREFIXES = [
  "/api/engagements",
  "/api/deadlines",
  "/api/documents",
  "/api/clients",
  "/api/dashboard",
  "/api/comments",
  "/api/checklist-items",
  "/api/notifications",
] as const;

/** Hand-written (non-URL) query keys that hold the same data: dashboard widgets and the account page's client list. */
const LEGACY_KEY_PREFIXES = ["dashboard-", "clients-list"] as const;

/** True when `key` starts with `prefix` at a path boundary ("/api/clients" matches "/api/clients/3/compliance", not "/api/clientsX"). */
function matchesPrefix(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix)) return false;
  const next = key.charAt(prefix.length);
  return next === "" || next === "/" || next === "?";
}

/** True when a query's key starts with one of the given URL prefixes. */
export function queryKeyStartsWith(query: Pick<Query, "queryKey">, prefixes: readonly string[]): boolean {
  const first = query.queryKey[0];
  return typeof first === "string" && prefixes.some(p => matchesPrefix(first, p));
}

/** True for any query that holds filing data (see FILING_DATA_PREFIXES). */
export function isFilingDataQuery(query: Pick<Query, "queryKey">): boolean {
  const first = query.queryKey[0];
  if (typeof first !== "string") return false;
  return queryKeyStartsWith(query, FILING_DATA_PREFIXES) || LEGACY_KEY_PREFIXES.some(p => first.startsWith(p));
}

/**
 * Refetch everything that can change after a filing action (stage submit/approve,
 * upload, delete, deadline edits...). Call after any mutation: `await invalidateFilingData(queryClient)`.
 */
export function invalidateFilingData(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ predicate: isFilingDataQuery });
}

/** Invalidate queries whose key starts with any of the given URL prefixes, e.g. invalidatePrefixes(qc, ["/api/users"]). */
export function invalidatePrefixes(queryClient: QueryClient, prefixes: readonly string[]): Promise<void> {
  return queryClient.invalidateQueries({ predicate: q => queryKeyStartsWith(q, prefixes) });
}
