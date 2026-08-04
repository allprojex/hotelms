import { describe, expect, it } from "vitest";
import {
  NOTIFICATIONS_HISTORY_QUERY_KEY,
  NOTIFICATIONS_QUERY_KEY,
  countUnread,
  dedupeNotifications,
  invalidateNotificationQueries,
  prepareNotificationFeed,
  sortNotificationsUnreadFirst,
  type NotificationRow,
} from "@/lib/notifications-shared";

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n-1",
    property_id: "prop-1",
    user_id: null,
    category: "reservation",
    priority: "normal",
    title: "Title",
    body: null,
    link: null,
    metadata: {},
    read_at: null,
    effective_read_at: null,
    is_read: false,
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("notifications.client — badge/dropdown share one authoritative source", () => {
  it("counts unread using is_read, not the raw read_at column", () => {
    // Broadcast rows are read via a per-user receipt (effective_read_at), so
    // read_at itself stays null even after the current user has read it.
    const rows = [
      row({ id: "a", is_read: false, read_at: null }),
      row({ id: "b", is_read: true, read_at: null, effective_read_at: "2026-08-01T01:00:00.000Z" }),
      row({ id: "c", is_read: true, read_at: "2026-08-01T01:00:00.000Z" }),
    ];
    expect(countUnread(rows)).toBe(1);
  });

  it("dedupes rows by id so a realtime push overlapping a poll can't double-count", () => {
    const rows = [row({ id: "a" }), row({ id: "a" }), row({ id: "b" })];
    expect(dedupeNotifications(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sorts unread first, then most recent, so unread can't be truncated out of a capped fetch", () => {
    const rows = [
      row({ id: "old-unread", is_read: false, created_at: "2026-01-01T00:00:00.000Z" }),
      row({ id: "new-read", is_read: true, created_at: "2026-08-01T00:00:00.000Z" }),
      row({ id: "new-unread", is_read: false, created_at: "2026-08-02T00:00:00.000Z" }),
    ];
    const sorted = sortNotificationsUnreadFirst(rows);
    expect(sorted.map((r) => r.id)).toEqual(["new-unread", "old-unread", "new-read"]);
  });

  it("prepareNotificationFeed composes dedupe + sort into the single feed both badge and dropdown read", () => {
    const rows = [
      row({ id: "read", is_read: true, created_at: "2026-08-01T00:00:00.000Z" }),
      row({ id: "unread", is_read: false, created_at: "2026-07-01T00:00:00.000Z" }),
      row({ id: "unread" }), // duplicate id, e.g. overlapping poll/realtime payloads
    ];
    const feed = prepareNotificationFeed(rows);
    expect(feed.map((r) => r.id)).toEqual(["unread", "read"]);
    expect(countUnread(feed)).toBe(1);
  });

  it("invalidates both the bell and the full-history query keys together", async () => {
    const invalidated: unknown[] = [];
    const qc = {
      invalidateQueries: (opts: { queryKey: unknown }) => {
        invalidated.push(opts.queryKey);
        return Promise.resolve();
      },
    };
    await invalidateNotificationQueries(qc as any);
    expect(invalidated).toContainEqual(NOTIFICATIONS_QUERY_KEY);
    expect(invalidated).toContainEqual(NOTIFICATIONS_HISTORY_QUERY_KEY);
  });
});
