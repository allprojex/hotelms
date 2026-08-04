/**
 * Notification badge/dropdown consistency — regression guards.
 *
 * Root cause of the original bug: reservation/pos/payment notifications are
 * all broadcast rows (user_id IS NULL). The old notifs_update_own RLS policy
 * only allows UPDATE where user_id = auth.uid(), so "mark read" / "mark all
 * read" silently no-op'd on almost every real notification — the unread
 * badge could never clear. Separately, the bell (["notifications"]) and the
 * full history page (["notif-history"]) used disjoint query keys with no
 * cross-invalidation, the dropdown never refreshed on open, and a failed
 * fetch rendered the same "No notifications" empty state as a true empty
 * inbox. These tests assert the fixes stay in place at the source level,
 * matching the style of tests/security.regression.test.ts (no live DB in
 * this suite, so wiring is checked statically rather than executed).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bell = readFileSync(resolve(__dirname, "../src/components/notification-bell.tsx"), "utf8");
const page = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/notifications.tsx"),
  "utf8",
);
const fns = readFileSync(resolve(__dirname, "../src/lib/notifications.functions.ts"), "utf8");
const migration = readFileSync(
  resolve(__dirname, "../supabase/migrations/20260803120000_notification_read_receipts.sql"),
  "utf8",
);

describe("notification-bell.tsx and notifications.tsx share one data source", () => {
  it("both query the authoritative read-state view, not the raw notifications table", () => {
    expect(bell).toContain("notifications_with_read_state");
    expect(page).toContain("notifications_with_read_state");
  });

  it("both derive unread/read state from is_read, never from raw read_at", () => {
    expect(bell).toMatch(/n\.is_read/);
    expect(page).toMatch(/n\.is_read/);
  });

  it("both mutation paths invalidate the shared query-key helper, not a single ad-hoc key", () => {
    expect(bell).toContain("invalidateNotificationQueries(qc)");
    expect(page).toContain("invalidateNotificationQueries(qc)");
  });

  it("the bell's query key and the history page's query key come from the shared module", () => {
    expect(bell).toContain("NOTIFICATIONS_QUERY_KEY");
    expect(page).toContain("NOTIFICATIONS_HISTORY_QUERY_KEY");
  });
});

describe("dropdown refresh and empty/loading/error states", () => {
  it("opening the popover triggers a refetch instead of relying only on the poll interval", () => {
    expect(bell).toMatch(/onOpenChange=\{onOpenChange\}/);
    expect(bell).toMatch(/function onOpenChange\([\s\S]{0,80}q\.refetch\(\)/);
  });

  it("a failed fetch renders a distinct error state, not the empty state", () => {
    expect(bell).toMatch(/q\.isError/);
    expect(bell).toMatch(/Couldn't load notifications/);
    expect(page).toMatch(/list\.isError/);
    expect(page).toMatch(/Couldn't load notifications/);
  });

  it("the empty state only renders once loading and error are both ruled out", () => {
    expect(bell).toMatch(/!q\.isLoading && !q\.isError && list\.length === 0/);
    expect(page).toMatch(/!list\.isLoading && !list\.isError && filtered\.length === 0/);
  });
});

describe("individual notification can be marked read from both surfaces", () => {
  it("the bell dropdown marks a single notification read", () => {
    expect(bell).toMatch(/readOne\(n\.id\)/);
  });

  it("the full history page also exposes a per-row mark-as-read action (parity with the bell)", () => {
    expect(page).toMatch(/readOne\(n\.id\)/);
  });

  it("clicking a linked notification's Open action marks it read, not just the separate checkmark", () => {
    // Previously only the small checkmark icon marked a row read — clicking
    // "Open →" just navigated, so opening a notification never reduced the
    // unread badge.
    expect(bell).toMatch(/<Link[\s\S]{0,120}onClick=\{\(\) => \{[\s\S]{0,60}readOne\(n\.id\)/);
  });

  it("link-less notifications (e.g. system messages) still expose a way to mark read", () => {
    // A notification with no n.link previously rendered nothing in the
    // action slot, making it look un-openable and impossible to clear.
    expect(bell).toMatch(/Mark read/);
  });
});

describe("server functions route through RPCs scoped to the caller, not raw table writes", () => {
  it("markNotificationRead calls the mark_notification_read RPC", () => {
    expect(fns).toMatch(/rpc\(\s*["']mark_notification_read["']/);
  });

  it("markAllNotificationsRead calls the mark_all_notifications_read RPC", () => {
    expect(fns).toMatch(/rpc\(\s*["']mark_all_notifications_read["']/);
  });

  it("no longer updates notifications.read_at directly from the server fn layer", () => {
    // Direct .update({ read_at }) on the notifications table only ever
    // touched user_id = auth.uid() rows — silently skipping every broadcast
    // notification. Routing through the RPCs is what makes broadcast rows
    // markable via the per-user read_receipts table.
    expect(fns).not.toMatch(/\.from\(["']notifications["']\)[\s\S]{0,120}\.update\(/);
  });
});

describe("notification_reads migration — per-user read receipts without weakening RLS", () => {
  it("scopes the read-receipt table to the owning user only", () => {
    expect(migration).toMatch(
      /CREATE POLICY notification_reads_own[\s\S]{0,120}USING \(user_id = auth\.uid\(\)\)/,
    );
    expect(migration).toMatch(/WITH CHECK \(user_id = auth\.uid\(\)\)/);
  });

  it("keeps the personal-notification update policy scoped to auth.uid() (unchanged, not weakened)", () => {
    expect(migration).not.toMatch(/USING \(true\)/);
  });

  it("mark_all_notifications_read only ever writes rows for auth.uid()", () => {
    const fn = migration.slice(migration.indexOf("FUNCTION public.mark_all_notifications_read"));
    expect(fn).toMatch(/WHERE user_id = auth\.uid\(\)/);
    expect(fn).toMatch(/SELECT n\.id, auth\.uid\(\)/);
  });

  it("grants execute only to authenticated, not anon or public", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.mark_all_notifications_read\(\) FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.mark_all_notifications_read\(\) TO authenticated/,
    );
  });

  it("the read-state view runs with security_invoker so it carries no elevated privilege", () => {
    expect(migration).toMatch(
      /notifications_with_read_state[\s\S]{0,80}WITH \(security_invoker = true\)/,
    );
  });
});
