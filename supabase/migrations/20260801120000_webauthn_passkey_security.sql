-- Phase 5: authentication security & WebAuthn/FIDO2 passkey login.
-- Additive only. Complements Supabase Auth password login; nothing prior is dropped or renamed.
-- Stores only standards-compliant WebAuthn credential metadata (credential id, public key,
-- sign count, transports, attachment, backup flags, friendly name, timestamps).
-- Never stores fingerprint/face images, biometric templates, device PINs or private keys —
-- private keys stay on the user's authenticator; the browser/OS never exposes raw biometrics
-- to this application.

-- ============ GENERIC ROLE-PERMISSION HELPER (non-HRM modules) ============
-- Mirrors has_hrm_permission's shape for the core role_permissions table so Phase 5
-- modules can be gated the same way as every other non-HRM permission in the app.
CREATE OR REPLACE FUNCTION public.has_permission(
  _user_id uuid,
  _property_id uuid,
  _module text,
  _action text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    LEFT JOIN LATERAL (
      SELECT candidate.allowed
      FROM public.role_permissions candidate
      WHERE candidate.role = ur.role
        AND candidate.custom_role_id IS NULL
        AND (candidate.property_id IS NULL OR candidate.property_id = _property_id)
        AND candidate.module = _module
        AND candidate.action = _action
      ORDER BY (candidate.property_id = _property_id) DESC
      LIMIT 1
    ) rp ON true
    WHERE ur.user_id = _user_id
      AND (ur.property_id IS NULL OR ur.property_id = _property_id)
      AND (
        ur.role = 'super_admin'
        OR COALESCE(rp.allowed, false)
      )
  )
$$;
REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text, text) TO authenticated, service_role;

-- ============ PROFILE / PROPERTY POLICY COLUMNS ============
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS two_factor_reset_at timestamptz,
  ADD COLUMN IF NOT EXISTS two_factor_reset_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.security_settings
  ADD COLUMN IF NOT EXISTS passkey_policy text NOT NULL DEFAULT 'optional'
    CHECK (passkey_policy IN ('disabled','optional','encouraged','required')),
  ADD COLUMN IF NOT EXISTS two_factor_policy text NOT NULL DEFAULT 'disabled'
    CHECK (two_factor_policy IN ('disabled','optional','required')),
  ADD COLUMN IF NOT EXISTS two_factor_required_roles text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS step_up_max_age_minutes int NOT NULL DEFAULT 15
    CHECK (step_up_max_age_minutes BETWEEN 1 AND 1440);
COMMENT ON COLUMN public.security_settings.two_factor_policy IS
  'Phase 5 policy foundation only. TOTP is not implemented; passkeys are the supported strong factor.';

-- ============ ENROLLMENT APPROVAL ============
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'passkey_enrollment_status') THEN
    CREATE TYPE public.passkey_enrollment_status AS ENUM
      ('not_requested','pending','approved','rejected','revoked');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.passkey_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_id uuid,
  status public.passkey_enrollment_status NOT NULL DEFAULT 'not_requested',
  enrollment_allowed boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  rejection_reason text,
  revoked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, user_id),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, employee_id) REFERENCES public.hr_employees(property_id, id) ON DELETE SET NULL,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),
  CHECK (status <> 'revoked' OR revocation_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS passkey_enrollments_property_status_idx
  ON public.passkey_enrollments(property_id, status);
CREATE TRIGGER trg_passkey_enrollments_updated BEFORE UPDATE ON public.passkey_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Immutable, append-only decision trail. Never updated or deleted.
CREATE TABLE IF NOT EXISTS public.passkey_enrollment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('requested','approved','rejected','revoked','reset')),
  reason text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, enrollment_id) REFERENCES public.passkey_enrollments(property_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS passkey_enrollment_history_lookup_idx
  ON public.passkey_enrollment_history(property_id, user_id, created_at DESC);

-- ============ WEBAUTHN CREDENTIALS ============
-- Standards-compliant metadata only. No fingerprint/face images, templates, PINs or private keys.
CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  public_key text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  credential_type text NOT NULL DEFAULT 'public-key',
  authenticator_attachment text CHECK (authenticator_attachment IN ('platform','cross-platform')),
  backup_eligible boolean NOT NULL DEFAULT false,
  backup_state boolean NOT NULL DEFAULT false,
  aaguid text,
  device_name text NOT NULL DEFAULT 'Passkey' CHECK (char_length(trim(device_name)) BETWEEN 1 AND 80),
  user_verified boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  disabled_reason text,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  revocation_reason text,
  UNIQUE (credential_id),
  UNIQUE (property_id, id)
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx
  ON public.webauthn_credentials(property_id, user_id);
COMMENT ON TABLE public.webauthn_credentials IS
  'Standards-compliant WebAuthn credential metadata only. No biometric templates, images, PINs or private keys are ever stored.';
COMMENT ON COLUMN public.webauthn_credentials.public_key IS
  'Public COSE key only. The matching private key never leaves the authenticator/device.';

-- ============ CHALLENGES ============
-- Server-side single-use challenge store. Raw challenge bytes are never persisted:
-- only a sha256 hash is stored, so a database read alone cannot replay a ceremony.
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_type text NOT NULL CHECK (challenge_type IN ('registration','authentication')),
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  challenge_hash text NOT NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_ip_hash text,
  request_user_agent text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated boolean NOT NULL DEFAULT false,
  UNIQUE (challenge_hash)
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_user_idx
  ON public.webauthn_challenges(user_id, challenge_type, expires_at);
COMMENT ON TABLE public.webauthn_challenges IS
  'Single-use ceremony challenges. Stores only a hash of the challenge and safe request metadata — never the raw challenge, and never fully exposed to any client role.';

-- ============ RLS ============
ALTER TABLE public.passkey_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passkey_enrollment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

-- All mutations happen through SECURITY DEFINER RPCs below; authenticated clients get
-- read-only, ownership/permission-scoped SELECT and nothing else.
REVOKE ALL ON public.passkey_enrollments FROM authenticated;
REVOKE ALL ON public.passkey_enrollment_history FROM authenticated;
REVOKE ALL ON public.webauthn_credentials FROM authenticated;
REVOKE ALL ON public.webauthn_challenges FROM authenticated, anon;
GRANT SELECT ON public.passkey_enrollments TO authenticated;
GRANT SELECT ON public.passkey_enrollment_history TO authenticated;
GRANT SELECT ON public.webauthn_credentials TO authenticated;
GRANT ALL ON public.passkey_enrollments, public.passkey_enrollment_history,
  public.webauthn_credentials, public.webauthn_challenges TO service_role;

CREATE POLICY passkey_enrollments_read ON public.passkey_enrollments FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_security_admin(auth.uid())
    OR public.has_permission(auth.uid(), property_id, 'security_passkey_enrollment', 'read')
  );

CREATE POLICY passkey_enrollment_history_read ON public.passkey_enrollment_history FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_security_admin(auth.uid())
    OR public.has_permission(auth.uid(), property_id, 'security_passkey_enrollment', 'read')
  );

CREATE POLICY webauthn_credentials_read ON public.webauthn_credentials FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_security_admin(auth.uid())
    OR public.has_permission(auth.uid(), property_id, 'security_passkey_credentials', 'read')
  );
-- webauthn_challenges: no SELECT policy for authenticated/anon at all — fully opaque.

-- ============ ENROLLMENT REQUEST (self-service) ============
CREATE OR REPLACE FUNCTION public.passkey_request_enrollment(_property_id uuid)
RETURNS public.passkey_enrollments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.passkey_enrollments%ROWTYPE; emp uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = actor AND status = 'active') THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  IF NOT public.can_access_property(actor, _property_id) THEN
    RAISE EXCEPTION 'Not authorized for this property';
  END IF;

  SELECT id INTO emp FROM public.hr_employees
    WHERE property_id = _property_id AND staff_user_id = actor AND archived_at IS NULL
    LIMIT 1;

  SELECT * INTO row FROM public.passkey_enrollments
    WHERE property_id = _property_id AND user_id = actor FOR UPDATE;

  IF row.id IS NULL THEN
    INSERT INTO public.passkey_enrollments(property_id, user_id, employee_id, status, requested_at)
    VALUES (_property_id, actor, emp, 'pending', now())
    RETURNING * INTO row;
    INSERT INTO public.passkey_enrollment_history(property_id, enrollment_id, user_id, action, actor_id)
      VALUES (_property_id, row.id, actor, 'requested', actor);
  ELSIF row.status = 'revoked' THEN
    RAISE EXCEPTION 'Enrollment was revoked. Ask an administrator to reset it before requesting again.';
  ELSIF row.status IN ('not_requested','rejected') THEN
    UPDATE public.passkey_enrollments
      SET status = 'pending', requested_at = now(), employee_id = COALESCE(emp, employee_id)
      WHERE id = row.id RETURNING * INTO row;
    INSERT INTO public.passkey_enrollment_history(property_id, enrollment_id, user_id, action, actor_id)
      VALUES (_property_id, row.id, actor, 'requested', actor);
  END IF;
  -- 'pending' and 'approved' are idempotent no-ops here.

  PERFORM public.notify(_property_id, NULL, 'security', 'normal',
    'Passkey enrollment requested',
    'A staff member requested approval to enroll a passkey.',
    '/admin/security/passkeys', jsonb_build_object('enrollmentId', row.id));
  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_request_enrollment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_request_enrollment(uuid) TO authenticated;

-- ============ ENROLLMENT DECISION (admin) ============
CREATE OR REPLACE FUNCTION public.passkey_enrollment_decide(
  _property_id uuid, _target_user_id uuid, _decision text, _reason text DEFAULT NULL
)
RETURNS public.passkey_enrollments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); row public.passkey_enrollments%ROWTYPE;
  required_action text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _decision NOT IN ('approved','rejected','revoked','reset') THEN
    RAISE EXCEPTION 'Unsupported enrollment decision';
  END IF;
  IF actor = _target_user_id THEN
    RAISE EXCEPTION 'Enrollment cannot be self-approved';
  END IF;

  required_action := CASE WHEN _decision IN ('approved','rejected') THEN 'approve' ELSE 'manage' END;
  IF NOT (
    public.is_security_admin(actor)
    OR public.has_permission(actor, _property_id, 'security_passkey_enrollment', required_action)
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF _decision IN ('rejected','revoked','reset') AND char_length(trim(COALESCE(_reason,''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;

  SELECT * INTO row FROM public.passkey_enrollments
    WHERE property_id = _property_id AND user_id = _target_user_id FOR UPDATE;
  IF row.id IS NULL THEN
    IF _decision <> 'approved' THEN RAISE EXCEPTION 'No enrollment request found'; END IF;
    INSERT INTO public.passkey_enrollments(property_id, user_id, status)
      VALUES (_property_id, _target_user_id, 'not_requested') RETURNING * INTO row;
  END IF;

  IF row.status::text = _decision THEN
    RETURN row; -- idempotent no-op; finalized history is never overwritten
  END IF;

  IF _decision = 'approved' THEN
    UPDATE public.passkey_enrollments SET
      status = 'approved', enrollment_allowed = true,
      approved_by = actor, approved_at = now()
      WHERE id = row.id RETURNING * INTO row;
  ELSIF _decision = 'rejected' THEN
    UPDATE public.passkey_enrollments SET
      status = 'rejected', enrollment_allowed = false,
      rejected_by = actor, rejected_at = now(), rejection_reason = _reason
      WHERE id = row.id RETURNING * INTO row;
  ELSIF _decision = 'revoked' THEN
    UPDATE public.passkey_enrollments SET
      status = 'revoked', enrollment_allowed = false,
      revoked_by = actor, revoked_at = now(), revocation_reason = _reason
      WHERE id = row.id RETURNING * INTO row;
    UPDATE public.webauthn_credentials SET
      revoked_at = now(), revoked_by = actor,
      revocation_reason = 'Enrollment revoked: ' || _reason
      WHERE property_id = _property_id AND user_id = _target_user_id AND revoked_at IS NULL;
  ELSIF _decision = 'reset' THEN
    UPDATE public.passkey_enrollments SET
      status = 'not_requested', enrollment_allowed = false, requested_at = NULL,
      approved_by = NULL, approved_at = NULL,
      rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL,
      revoked_by = NULL, revoked_at = NULL, revocation_reason = NULL
      WHERE id = row.id RETURNING * INTO row;
    UPDATE public.webauthn_credentials SET
      revoked_at = now(), revoked_by = actor,
      revocation_reason = 'Enrollment reset: ' || _reason
      WHERE property_id = _property_id AND user_id = _target_user_id AND revoked_at IS NULL;
  END IF;

  INSERT INTO public.passkey_enrollment_history(property_id, enrollment_id, user_id, action, reason, actor_id)
    VALUES (_property_id, row.id, _target_user_id, _decision, _reason, actor);

  PERFORM public.notify(_property_id, _target_user_id, 'security', 'high',
    'Passkey enrollment ' || _decision,
    CASE _decision
      WHEN 'approved' THEN 'Your passkey enrollment request was approved. You may now register a passkey.'
      WHEN 'rejected' THEN 'Your passkey enrollment request was declined by an administrator.'
      WHEN 'revoked' THEN 'Your passkey enrollment was revoked and any registered passkeys were disabled.'
      ELSE 'Your passkey enrollment was reset by an administrator. Any registered passkeys were disabled and you must request approval again.'
    END,
    '/security/passkeys', jsonb_build_object('decision', _decision));

  RETURN row;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_enrollment_decide(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_enrollment_decide(uuid, uuid, text, text) TO authenticated;

-- ============ REGISTRATION CEREMONY (post-login; auth.uid()-scoped) ============
CREATE OR REPLACE FUNCTION public.passkey_registration_challenge_create(
  _property_id uuid, _challenge_hash text, _ttl_seconds int DEFAULT 120,
  _request_ip_hash text DEFAULT NULL, _request_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); enrollment public.passkey_enrollments%ROWTYPE; new_id uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _ttl_seconds NOT BETWEEN 30 AND 300 THEN RAISE EXCEPTION 'Invalid challenge lifetime'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = actor AND status = 'active') THEN
    RAISE EXCEPTION 'Account is not active';
  END IF;
  IF NOT public.can_access_property(actor, _property_id) THEN
    RAISE EXCEPTION 'Not authorized for this property';
  END IF;

  SELECT * INTO enrollment FROM public.passkey_enrollments
    WHERE property_id = _property_id AND user_id = actor;
  IF enrollment.id IS NULL OR enrollment.status <> 'approved' OR NOT enrollment.enrollment_allowed THEN
    RAISE EXCEPTION 'Passkey enrollment has not been approved for this account';
  END IF;

  DELETE FROM public.webauthn_challenges
    WHERE user_id = actor AND challenge_type = 'registration' AND expires_at < now();

  INSERT INTO public.webauthn_challenges(
    challenge_type, property_id, user_id, challenge_hash, expires_at, request_ip_hash, request_user_agent
  ) VALUES (
    'registration', _property_id, actor, _challenge_hash, now() + (_ttl_seconds || ' seconds')::interval,
    _request_ip_hash, _request_user_agent
  ) RETURNING id INTO new_id;

  RETURN new_id;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_registration_challenge_create(uuid, text, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_registration_challenge_create(uuid, text, int, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.passkey_registration_complete(
  _challenge_id uuid, _challenge_hash text, _credential_id text, _public_key text,
  _sign_count bigint, _transports text[], _attachment text, _credential_type text,
  _backup_eligible boolean, _backup_state boolean, _aaguid text, _device_name text,
  _user_verified boolean
)
RETURNS public.webauthn_credentials
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); challenge public.webauthn_challenges%ROWTYPE;
  enrollment public.passkey_enrollments%ROWTYPE; cred public.webauthn_credentials%ROWTYPE;
  safe_name text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO challenge FROM public.webauthn_challenges
    WHERE id = _challenge_id AND challenge_type = 'registration' FOR UPDATE;
  IF challenge.id IS NULL OR challenge.used_at IS NOT NULL OR challenge.invalidated
     OR challenge.expires_at < now() OR challenge.challenge_hash <> _challenge_hash
     OR challenge.user_id <> actor THEN
    RAISE EXCEPTION 'Registration challenge is invalid or expired';
  END IF;
  UPDATE public.webauthn_challenges SET used_at = now() WHERE id = challenge.id;

  SELECT * INTO enrollment FROM public.passkey_enrollments
    WHERE property_id = challenge.property_id AND user_id = actor;
  IF enrollment.id IS NULL OR enrollment.status <> 'approved' OR NOT enrollment.enrollment_allowed THEN
    RAISE EXCEPTION 'Passkey enrollment is no longer approved';
  END IF;

  IF EXISTS (SELECT 1 FROM public.webauthn_credentials WHERE credential_id = _credential_id) THEN
    RAISE EXCEPTION 'This authenticator is already registered';
  END IF;
  IF _credential_type <> 'public-key' THEN
    RAISE EXCEPTION 'Unsupported credential type';
  END IF;

  safe_name := NULLIF(trim(COALESCE(_device_name, '')), '');
  IF safe_name IS NULL OR char_length(safe_name) > 80 THEN safe_name := 'Passkey'; END IF;

  INSERT INTO public.webauthn_credentials(
    property_id, user_id, credential_id, public_key, sign_count, transports, credential_type,
    authenticator_attachment, backup_eligible, backup_state, aaguid, device_name, user_verified
  ) VALUES (
    challenge.property_id, actor, _credential_id, _public_key, GREATEST(_sign_count, 0), COALESCE(_transports, '{}'),
    _credential_type, NULLIF(_attachment, ''), COALESCE(_backup_eligible, false), COALESCE(_backup_state, false),
    _aaguid, safe_name, COALESCE(_user_verified, true)
  ) RETURNING * INTO cred;

  PERFORM public.notify(challenge.property_id, actor, 'security', 'normal',
    'Passkey added', 'A new passkey ("' || safe_name || '") was registered on your account.',
    '/security/passkeys', jsonb_build_object());

  RETURN cred;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_registration_complete(
  uuid, text, text, text, bigint, text[], text, text, boolean, boolean, text, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_registration_complete(
  uuid, text, text, text, bigint, text[], text, text, boolean, boolean, text, text, boolean
) TO authenticated;

-- ============ CREDENTIAL SELF-SERVICE ============
CREATE OR REPLACE FUNCTION public.passkey_credential_rename(_credential_id uuid, _name text)
RETURNS public.webauthn_credentials
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); cred public.webauthn_credentials%ROWTYPE; safe_name text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  safe_name := trim(COALESCE(_name, ''));
  IF char_length(safe_name) < 1 OR char_length(safe_name) > 80 THEN
    RAISE EXCEPTION 'Device name must be between 1 and 80 characters';
  END IF;

  SELECT * INTO cred FROM public.webauthn_credentials
    WHERE id = _credential_id AND user_id = actor FOR UPDATE;
  IF cred.id IS NULL THEN RAISE EXCEPTION 'Credential not found'; END IF;
  IF cred.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'This passkey has been revoked'; END IF;

  UPDATE public.webauthn_credentials SET device_name = safe_name WHERE id = cred.id RETURNING * INTO cred;
  PERFORM public.notify(cred.property_id, actor, 'security', 'normal',
    'Passkey renamed', 'One of your passkeys was renamed to "' || safe_name || '".',
    '/security/passkeys', jsonb_build_object());
  RETURN cred;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_credential_rename(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_credential_rename(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.passkey_credential_revoke_self(_credential_id uuid)
RETURNS public.webauthn_credentials
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); cred public.webauthn_credentials%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO cred FROM public.webauthn_credentials
    WHERE id = _credential_id AND user_id = actor FOR UPDATE;
  IF cred.id IS NULL THEN RAISE EXCEPTION 'Credential not found'; END IF;
  IF cred.revoked_at IS NOT NULL THEN RETURN cred; END IF; -- idempotent

  UPDATE public.webauthn_credentials SET
    revoked_at = now(), revoked_by = actor, revocation_reason = 'Revoked by owner'
    WHERE id = cred.id RETURNING * INTO cred;
  PERFORM public.notify(cred.property_id, actor, 'security', 'normal',
    'Passkey revoked', 'One of your passkeys ("' || cred.device_name || '") was revoked. Password sign-in remains available.',
    '/security/passkeys', jsonb_build_object());
  RETURN cred;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_credential_revoke_self(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_credential_revoke_self(uuid) TO authenticated;

-- ============ ADMIN CREDENTIAL CONTROLS ============
CREATE OR REPLACE FUNCTION public.passkey_admin_credential_action(
  _property_id uuid, _target_user_id uuid, _credential_id uuid, _action text, _reason text
)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid(); affected int;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _action NOT IN ('disable','revoke','revoke_all') THEN RAISE EXCEPTION 'Unsupported credential action'; END IF;
  IF char_length(trim(COALESCE(_reason,''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;
  IF NOT (
    public.is_security_admin(actor)
    OR public.has_permission(actor, _property_id, 'security_passkey_credentials', 'manage')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF _action = 'disable' THEN
    UPDATE public.webauthn_credentials SET disabled_at = now(), disabled_by = actor, disabled_reason = _reason
      WHERE id = _credential_id AND property_id = _property_id AND user_id = _target_user_id
        AND revoked_at IS NULL AND disabled_at IS NULL;
  ELSIF _action = 'revoke' THEN
    UPDATE public.webauthn_credentials SET revoked_at = now(), revoked_by = actor, revocation_reason = _reason
      WHERE id = _credential_id AND property_id = _property_id AND user_id = _target_user_id AND revoked_at IS NULL;
  ELSE
    UPDATE public.webauthn_credentials SET revoked_at = now(), revoked_by = actor, revocation_reason = _reason
      WHERE property_id = _property_id AND user_id = _target_user_id AND revoked_at IS NULL;
  END IF;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected > 0 THEN
    PERFORM public.notify(_property_id, _target_user_id, 'security', 'high',
      'Passkey security action', 'An administrator ' ||
      CASE _action WHEN 'disable' THEN 'disabled a passkey' WHEN 'revoke' THEN 'revoked a passkey'
        ELSE 'revoked all of your passkeys' END || ' on your account. Password sign-in remains available.',
      '/security/passkeys', jsonb_build_object('action', _action));
  END IF;
  RETURN affected;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_admin_credential_action(uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_admin_credential_action(uuid, uuid, uuid, text, text) TO authenticated;

-- ============ 2FA POLICY FOUNDATION (admin reset) ============
CREATE OR REPLACE FUNCTION public.two_factor_admin_reset(_property_id uuid, _target_user_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor uuid := auth.uid();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF char_length(trim(COALESCE(_reason,''))) < 5 THEN
    RAISE EXCEPTION 'A reason of at least 5 characters is required';
  END IF;
  IF NOT (
    public.is_security_admin(actor)
    OR public.has_permission(actor, _property_id, 'security_2fa', 'manage')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.profiles SET
    two_factor_enabled = false, two_factor_reset_at = now(), two_factor_reset_by = actor
    WHERE id = _target_user_id;

  PERFORM public.notify(_property_id, _target_user_id, 'security', 'high',
    'Two-factor authentication reset', 'An administrator reset your two-factor authentication status.',
    '/security/passkeys', jsonb_build_object());
END; $$;
REVOKE ALL ON FUNCTION public.two_factor_admin_reset(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.two_factor_admin_reset(uuid, uuid, text) TO authenticated;

-- ============ PRE-LOGIN ACCOUNT RESOLUTION (service_role only) ============
-- Resolves a login identifier (username/Staff ID/Admin ID, or email) to a profile without
-- exposing the auth schema over PostgREST. Mirrors identifierSignIn's dual lookup.
CREATE OR REPLACE FUNCTION public.find_login_profile(_identifier text)
RETURNS TABLE(id uuid, status public.profile_status, must_change_password boolean, account_type public.auth_account_type)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.status, p.must_change_password, p.account_type
  FROM public.profiles p
  WHERE p.identifier_normalized = lower(trim(_identifier))
  UNION ALL
  SELECT p.id, p.status, p.must_change_password, p.account_type
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(u.email) = lower(trim(_identifier))
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles p2 WHERE p2.identifier_normalized = lower(trim(_identifier))
    )
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.find_login_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_login_profile(text) TO service_role;

-- ============ AUTHENTICATION CEREMONY (pre-login; service_role only) ============
-- Trust boundary: these two functions are the ONLY Phase 5 database entry points reachable
-- before a session exists. They are granted to service_role alone — never to `authenticated`
-- or `anon` — because account resolution and anti-enumeration handling happen in trusted
-- server code (supabaseAdmin) before either is called. auth.uid() is unavailable at this
-- stage, so identity is passed explicitly by the already-trusted caller.
CREATE OR REPLACE FUNCTION public.passkey_authentication_challenge_create(
  _target_user_id uuid, _property_id uuid, _challenge_hash text, _ttl_seconds int DEFAULT 120,
  _request_ip_hash text DEFAULT NULL, _request_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  IF _ttl_seconds NOT BETWEEN 30 AND 300 THEN RAISE EXCEPTION 'Invalid challenge lifetime'; END IF;
  IF _target_user_id IS NOT NULL THEN
    DELETE FROM public.webauthn_challenges
      WHERE user_id = _target_user_id AND challenge_type = 'authentication' AND expires_at < now();
  END IF;
  INSERT INTO public.webauthn_challenges(
    challenge_type, property_id, user_id, challenge_hash, expires_at, request_ip_hash, request_user_agent
  ) VALUES (
    'authentication', _property_id, _target_user_id, _challenge_hash,
    now() + (_ttl_seconds || ' seconds')::interval, _request_ip_hash, _request_user_agent
  ) RETURNING id INTO new_id;
  RETURN new_id;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_authentication_challenge_create(uuid, uuid, text, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_authentication_challenge_create(uuid, uuid, text, int, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.passkey_authentication_complete(
  _challenge_id uuid, _challenge_hash text, _credential_id text, _new_sign_count bigint
)
RETURNS TABLE(out_user_id uuid, out_property_id uuid, out_credential_id uuid, out_device_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE challenge public.webauthn_challenges%ROWTYPE; cred public.webauthn_credentials%ROWTYPE;
  enrollment public.passkey_enrollments%ROWTYPE; profile_status public.profile_status;
  employee_row public.hr_employees%ROWTYPE;
BEGIN
  SELECT * INTO challenge FROM public.webauthn_challenges
    WHERE id = _challenge_id AND challenge_type = 'authentication' FOR UPDATE;
  IF challenge.id IS NULL OR challenge.used_at IS NOT NULL OR challenge.invalidated
     OR challenge.expires_at < now() OR challenge.challenge_hash <> _challenge_hash
     OR challenge.user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication failed';
  END IF;
  UPDATE public.webauthn_challenges SET used_at = now() WHERE id = challenge.id;

  SELECT * INTO cred FROM public.webauthn_credentials
    WHERE credential_id = _credential_id AND user_id = challenge.user_id FOR UPDATE;
  IF cred.id IS NULL OR cred.revoked_at IS NOT NULL OR cred.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Authentication failed';
  END IF;

  SELECT * INTO enrollment FROM public.passkey_enrollments
    WHERE property_id = cred.property_id AND user_id = cred.user_id;
  IF enrollment.id IS NULL OR enrollment.status <> 'approved' OR NOT enrollment.enrollment_allowed THEN
    RAISE EXCEPTION 'Authentication failed';
  END IF;

  SELECT status INTO profile_status FROM public.profiles WHERE id = cred.user_id;
  IF profile_status IS NULL OR profile_status <> 'active' THEN
    RAISE EXCEPTION 'Authentication failed';
  END IF;

  SELECT * INTO employee_row FROM public.hr_employees
    WHERE property_id = cred.property_id AND staff_user_id = cred.user_id AND archived_at IS NULL
    LIMIT 1;
  IF employee_row.id IS NOT NULL AND employee_row.employment_status NOT IN ('active','probation') THEN
    RAISE EXCEPTION 'Authentication failed';
  END IF;

  IF _new_sign_count > 0 AND cred.sign_count > 0 AND _new_sign_count <= cred.sign_count THEN
    INSERT INTO public.security_events(property_id, user_id, event_type, severity, metadata)
      VALUES (cred.property_id, cred.user_id, 'suspicious_ip', 'high',
        jsonb_build_object('reason', 'non_monotonic_sign_count', 'credentialRowId', cred.id));
    RAISE EXCEPTION 'Authentication failed';
  END IF;

  UPDATE public.webauthn_credentials SET
    sign_count = GREATEST(_new_sign_count, cred.sign_count), last_used_at = now()
    WHERE id = cred.id;

  RETURN QUERY SELECT cred.user_id, cred.property_id, cred.id, cred.device_name;
END; $$;
REVOKE ALL ON FUNCTION public.passkey_authentication_complete(uuid, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passkey_authentication_complete(uuid, text, text, bigint) TO service_role;

-- ============ SEED: OWN-PASSKEY PERMISSIONS FOR ALL EXISTING PROPERTIES/ROLES ============
CREATE OR REPLACE FUNCTION public.seed_passkey_permissions(_property_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('security_passkeys_own','read'), ('security_passkeys_own','create'),
    ('security_passkeys_own','update'), ('security_passkeys_own','delete')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES
    ('super_admin'),('hotel_owner'),('general_manager'),('hr'),('manager'),
    ('front_desk'),('reservations'),('cashier'),('accountant'),
    ('housekeeping_supervisor'),('housekeeping'),('maintenance'),('kitchen'),
    ('restaurant_manager'),('waiter'),('storekeeper'),('guest_relations'),
    ('security'),('auditor')
  ) role(role_name)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_permissions(property_id, role, module, action, allowed)
  SELECT _property_id, role_name::public.app_role, module_name, action_name, true
  FROM (VALUES
    ('security_passkey_enrollment','read'), ('security_passkey_enrollment','approve'),
    ('security_passkey_enrollment','manage'),
    ('security_passkey_credentials','read'), ('security_passkey_credentials','manage'),
    ('security_auth_settings','read'), ('security_auth_settings','manage'),
    ('security_2fa','read'), ('security_2fa','manage'),
    ('security_audit','read')
  ) permission(module_name, action_name)
  CROSS JOIN (VALUES ('super_admin'),('hotel_owner'),('general_manager')) role(role_name)
  ON CONFLICT DO NOTHING;
END; $$;
SELECT public.seed_passkey_permissions(id) FROM public.properties;
REVOKE ALL ON FUNCTION public.seed_passkey_permissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_passkey_permissions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.seed_passkey_permissions_for_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN PERFORM public.seed_passkey_permissions(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER properties_seed_passkey_permissions AFTER INSERT ON public.properties
FOR EACH ROW EXECUTE FUNCTION public.seed_passkey_permissions_for_property();
REVOKE ALL ON FUNCTION public.seed_passkey_permissions_for_property() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_passkey_permissions_for_property() TO service_role;
