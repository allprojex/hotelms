
-- Fix: broadcast notifications (user_id IS NULL, created by the reservation/pos/
-- payment/announcement triggers) could never be marked read. The existing
-- notifs_update_own policy only allows UPDATE where user_id = auth.uid(), which
-- a shared broadcast row never satisfies, and updating read_at on a broadcast
-- row directly would incorrectly mark it read for every recipient at once.
-- This adds a per-user read-receipt table so each user has an independent
-- read state for rows they don't own, without touching notification history
-- or weakening any existing RLS check.

CREATE TABLE IF NOT EXISTS public.notification_reads (
  notification_id UUID NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON public.notification_reads(user_id);

GRANT SELECT, INSERT, DELETE ON public.notification_reads TO authenticated;
GRANT ALL ON public.notification_reads TO service_role;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_reads_own ON public.notification_reads
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Re-affirm SELECT on notifications: previously a row with user_id IS NULL AND
-- property_id IS NULL (system-wide, super_admin-only per notifs_insert_admin)
-- matched neither branch of notifs_read and was unreadable by anyone,
-- including its author. Widen read access only for that already-legitimate,
-- already-insertable case; ownership/property scoping is unchanged.
DROP POLICY IF EXISTS notifs_read ON public.notifications;
CREATE POLICY notifs_read ON public.notifications FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (user_id IS NULL AND property_id IS NOT NULL AND public.can_access_property(auth.uid(), property_id))
    OR (user_id IS NULL AND property_id IS NULL)
  );

-- Authoritative read-state view: the single source both the badge and the
-- dropdown/history page must query. security_invoker=true means it carries no
-- privilege of its own — the caller's RLS on notifications/notification_reads
-- applies exactly as if they queried the base tables directly.
CREATE OR REPLACE VIEW public.notifications_with_read_state
WITH (security_invoker = true) AS
SELECT
  n.id, n.property_id, n.user_id, n.category, n.priority, n.title, n.body,
  n.link, n.metadata, n.read_at, n.created_at,
  CASE WHEN n.user_id IS NOT NULL THEN n.read_at IS NOT NULL ELSE nr.read_at IS NOT NULL END AS is_read,
  CASE WHEN n.user_id IS NOT NULL THEN n.read_at ELSE nr.read_at END AS effective_read_at
FROM public.notifications n
LEFT JOIN public.notification_reads nr
  ON nr.notification_id = n.id AND nr.user_id = auth.uid();

GRANT SELECT ON public.notifications_with_read_state TO authenticated;

-- Mark one notification read. SECURITY INVOKER (default): runs under the
-- caller's own RLS, so it can only ever touch rows already visible to them.
CREATE OR REPLACE FUNCTION public.mark_notification_read(_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE _owner UUID; _prop UUID;
BEGIN
  SELECT user_id, property_id INTO _owner, _prop FROM public.notifications WHERE id = _id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _owner IS NOT NULL THEN
    UPDATE public.notifications SET read_at = now() WHERE id = _id AND user_id = auth.uid();
  ELSE
    IF _prop IS NOT NULL AND NOT public.can_access_property(auth.uid(), _prop) THEN
      RETURN;
    END IF;
    INSERT INTO public.notification_reads (notification_id, user_id)
    VALUES (_id, auth.uid())
    ON CONFLICT (notification_id, user_id) DO NOTHING;
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.mark_notification_unread(_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE _owner UUID;
BEGIN
  SELECT user_id INTO _owner FROM public.notifications WHERE id = _id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF _owner IS NOT NULL THEN
    UPDATE public.notifications SET read_at = NULL WHERE id = _id AND user_id = auth.uid();
  ELSE
    DELETE FROM public.notification_reads WHERE notification_id = _id AND user_id = auth.uid();
  END IF;
END; $$;

-- Mark every notification visible to the caller as read: personal rows update
-- read_at directly, broadcast rows for the caller's accessible properties get
-- a read receipt. Scoped entirely to auth.uid() — never touches other users.
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.notifications
  SET read_at = now()
  WHERE user_id = auth.uid() AND read_at IS NULL;

  INSERT INTO public.notification_reads (notification_id, user_id)
  SELECT n.id, auth.uid()
  FROM public.notifications n
  WHERE n.user_id IS NULL
    AND (n.property_id IS NULL OR public.can_access_property(auth.uid(), n.property_id))
    AND NOT EXISTS (
      SELECT 1 FROM public.notification_reads nr
      WHERE nr.notification_id = n.id AND nr.user_id = auth.uid()
    )
  ON CONFLICT (notification_id, user_id) DO NOTHING;
END; $$;

REVOKE ALL ON FUNCTION public.mark_notification_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_notification_unread(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_all_notifications_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notification_unread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;
