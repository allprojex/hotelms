import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Broadcast notifications (user_id IS NULL, created by the reservation/pos/
// payment/announcement triggers) are shared rows visible to every recipient,
// so they can't be marked read by updating read_at on the row itself — that
// would mark it read for everyone. mark_notification_read/mark_all... route
// personal rows to read_at and broadcast rows to a per-user read receipt
// (notification_reads), entirely within the caller's own RLS scope.

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => {
    if (!d.id) throw new Error("id required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "mark_notification_read" as never,
      { _id: data.id } as never,
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.rpc("mark_all_notifications_read" as never);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markNotificationUnread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => {
    if (!d.id) throw new Error("id required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc(
      "mark_notification_unread" as never,
      { _id: data.id } as never,
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
