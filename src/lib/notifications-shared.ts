import type { QueryClient } from "@tanstack/react-query";

/**
 * Authoritative notification row shape, read from the
 * `notifications_with_read_state` view. `is_read` is the only field that
 * should ever be used to decide unread/read — raw `read_at` is null on
 * broadcast rows even after the current user has read them (their read state
 * lives in `notification_reads` instead).
 */
export interface NotificationRow {
  id: string;
  property_id: string | null;
  user_id: string | null;
  category: string;
  priority: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  effective_read_at: string | null;
  is_read: boolean;
  created_at: string;
}

/** Single source of truth for both the bell badge/dropdown and the full history page. */
export const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;
export const NOTIFICATIONS_HISTORY_QUERY_KEY = ["notif-history"] as const;

export function invalidateNotificationQueries(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
    qc.invalidateQueries({ queryKey: NOTIFICATIONS_HISTORY_QUERY_KEY }),
  ]);
}

export function dedupeNotifications(rows: NotificationRow[]): NotificationRow[] {
  const seen = new Set<string>();
  const out: NotificationRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Unread first, then most recent — keeps unread items from being truncated out of a capped fetch. */
export function sortNotificationsUnreadFirst(rows: NotificationRow[]): NotificationRow[] {
  return [...rows].sort((a, b) => {
    const unreadDiff = Number(a.is_read) - Number(b.is_read);
    if (unreadDiff !== 0) return unreadDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export function countUnread(rows: NotificationRow[]): number {
  return rows.reduce((n, r) => (r.is_read ? n : n + 1), 0);
}

export function prepareNotificationFeed(rows: NotificationRow[]): NotificationRow[] {
  return sortNotificationsUnreadFirst(dedupeNotifications(rows));
}
