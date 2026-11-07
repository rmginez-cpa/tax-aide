// Notification helpers shared by the navigation badge and the notifications page.

import { useQuery } from "@tanstack/react-query";
import type { UnreadCount } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { isClientRole } from "@/lib/permissions";

/**
 * Query key of GET /api/notifications/unread-count. It starts with "/api/notifications",
 * so invalidateFilingData() and invalidatePrefixes(qc, ["/api/notifications"]) refresh it.
 */
export const UNREAD_COUNT_QUERY_KEY = ["/api/notifications/unread-count"] as const;

/** How often the unread badge polls (it also refetches when the window regains focus). */
export const UNREAD_POLL_MS = 60_000;

/** Unread notification count of the signed-in user; polls every minute and on window focus. */
export function useUnreadNotificationCount(enabled = true): number {
  const { data } = useQuery({
    queryKey: UNREAD_COUNT_QUERY_KEY,
    queryFn: ({ signal }) => apiFetch<UnreadCount>("/notifications/unread-count", { signal }),
    enabled,
    refetchInterval: UNREAD_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  return data?.count ?? 0;
}

/** Badge text for a count: "" for 0, "99+" above 99. */
export function unreadBadgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/**
 * Where a notification leads, or null when there is no page for it (the user stays put).
 * engagement -> the filing; deadline -> the deadlines page (staff only: clients cannot open it);
 * client -> the client's page (staff only).
 */
export function notificationHref(
  n: { relatedType?: string | null; relatedId?: number | null },
  role: string | null | undefined,
): string | null {
  if (n.relatedId == null) return null;
  const staff = !isClientRole(role);
  switch (n.relatedType) {
    case "engagement":
      return `/engagements/${n.relatedId}`;
    case "deadline":
      return staff ? `/deadlines?highlight=${n.relatedId}` : null;
    case "client":
      return staff ? `/clients/${n.relatedId}` : null;
    default:
      return null;
  }
}
