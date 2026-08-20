-- Property-level branding overrides (Hotel PMS Branding Phase 1).
--
-- Approved design (per BRANDING PARITY AUDIT + approval):
--   1. system_settings remains the organisation-wide/global branding
--      default. It is NOT replaced — this migration only tightens its
--      color validation and adds secondary_color.
--   2. A new property_branding table carries OPTIONAL, nullable overrides,
--      one row per property. Any unset column falls back to the global
--      system_settings value, which itself falls back to the client-side
--      DEFAULTS already in use-brand-settings.ts. Existing properties with
--      no row here are completely unaffected — the effective-branding
--      resolver behaves identically to today's global-only behaviour.
--   3. Writes to property_branding require super_admin, hotel_owner, or
--      general_manager scoped to that exact property (mirroring the
--      existing has_any_role()/RLS convention used throughout this
--      codebase's accounting module) — accountant and front_desk are
--      deliberately excluded. Writes to the global system_settings row
--      remain super_admin-only, unchanged.
--   4. favicon_url and the browser/document title are deliberately NOT
--      part of property_branding in this phase — per the approved
--      decision, browser/application identity stays organisation-wide
--      only and does not switch when the active property changes. Only
--      logo, display name, colors, and support contact are property-
--      overridable.
--   5. get_effective_branding(_property_id) is a new, separate
--      SECURITY DEFINER function alongside get_brand_settings() — the
--      latter still serves the pre-auth login page and every other
--      property-agnostic caller unchanged (same query, same grants,
--      same behaviour — only its return row type grew by one column,
--      requiring the explicit DROP+recreate documented at PART A; see
--      that section for why CREATE OR REPLACE cannot do this). Property
--      selection happens client-side, post-authentication, via
--      localStorage (src/lib/property-store.ts) — never before sign-in
--      — so get_brand_settings() remains the only branding source the
--      login page ever needs. get_effective_branding() is for the
--      authenticated, property-aware application and documents.
--   6. property_branding.updated_by is set server-side by a BEFORE
--      trigger (PART D) — never trusted from the client payload.
--   7. brand-assets uploads use a property-scoped path
--      (`property/<property_id>/<kind>/<file>`) for property overrides
--      and an organisation-scoped path (`organisation/<kind>/<file>`)
--      for global branding, with storage RLS (PART E) deriving the
--      authorization boundary from the path itself — not from client
--      intent — mirroring the existing 'uploads' bucket's own
--      per-property RLS precedent.

-- ============================================================
-- PART A0 — pre-existing bug fix: system_settings has never had an
-- UPDATE grant for `authenticated`
-- ============================================================
-- Every migration touching system_settings was audited: the only grant
-- ever issued to `authenticated` is `GRANT SELECT` (20260705105030). No
-- migration has ever issued GRANT UPDATE (or INSERT), and no blanket
-- `ALTER DEFAULT PRIVILEGES`/schema-wide grant exists anywhere in this
-- repo's migration history. That means the existing brand-module.tsx
-- save flow (`supabase.from("system_settings").update(...)`) has been
-- failing at the PostgREST/grant layer for every caller, including
-- super_admin, regardless of the RLS policy already correctly
-- restricting it to super_admin. RLS narrows an existing grant; it
-- cannot substitute for a missing one. Fixed here, since this migration
-- is completing this exact feature and the row-level policy
-- (system_settings_write, super_admin-only) already provides the actual
-- authorization boundary — this grant only makes that policy reachable.
GRANT UPDATE ON public.system_settings TO authenticated;

-- ============================================================
-- PART A — system_settings: validate colors, add secondary_color
-- ============================================================

-- primary_color has shipped since 20260706182349 with no format
-- constraint. Existing values are free text (including CSS color
-- functions like oklch(...), per the admin UI's own placeholder text),
-- so this migration does NOT retroactively force every existing value
-- into strict #rrggbb — that would risk breaking a already-configured,
-- non-hex value. Instead: relax to allow either a bare #rrggbb hex OR
-- any non-empty value being treated as a general CSS color (unchanged
-- behavior), and add secondary_color with the same permissive shape.
-- This keeps existing production data valid while giving the new admin
-- UI a real, enforced #rrggbb path when using the new color pickers.
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS secondary_color text;

-- Both colors: if set, must be blank-trimmed non-empty. No stricter DB
-- CHECK is added here since primary_color already carries production
-- values that aren't strict hex (oklch(...) etc. are valid CSS and are
-- explicitly supported by the existing admin UI's own placeholder). Hex
-- format is validated at the application layer (both admin UI input
-- masks and the new property_branding table's stricter CHECK below,
-- which is a new column with no legacy data to preserve).
ALTER TABLE public.system_settings
  DROP CONSTRAINT IF EXISTS system_settings_primary_color_not_blank,
  ADD CONSTRAINT system_settings_primary_color_not_blank
    CHECK (primary_color IS NULL OR btrim(primary_color) <> ''),
  DROP CONSTRAINT IF EXISTS system_settings_secondary_color_not_blank,
  ADD CONSTRAINT system_settings_secondary_color_not_blank
    CHECK (secondary_color IS NULL OR btrim(secondary_color) <> '');

-- Extend the existing get_brand_settings() RPC to also return
-- secondary_color, so it stays available to property-agnostic contexts
-- (the pre-auth login page, and any authenticated view before a property
-- is selected) without introducing a second global-read RPC.
--
-- This CANNOT be done via CREATE OR REPLACE FUNCTION: Postgres treats a
-- RETURNS TABLE function's OUT-parameter row type as fixed for OR
-- REPLACE purposes — only the body/volatility/etc. may change, not the
-- column list, even by appending a column at the end. Production's
-- get_brand_settings() carries its ORIGINAL 9-column signature from
-- 20260706223717 (app_name, app_short_name, tagline, logo_url,
-- logo_dark_url, favicon_url, primary_color, support_email,
-- support_phone) — confirmed by the production failure this migration
-- previously caused (42P13: cannot change return type of existing
-- function). Adding secondary_color therefore requires an explicit DROP
-- + recreate. Verified safe: no view or other function body anywhere in
-- this repo's migration history calls get_brand_settings() (grepped the
-- full migration history), so DROP FUNCTION (deliberately without
-- CASCADE) has no dependent to silently take down — every real caller
-- (use-brand-settings.ts, the public health check) is an
-- application-level PostgREST RPC call that re-resolves cleanly once the
-- schema cache reloads after this migration commits.
DROP FUNCTION IF EXISTS public.get_brand_settings();

CREATE FUNCTION public.get_brand_settings()
RETURNS TABLE (
  app_name text,
  app_short_name text,
  tagline text,
  logo_url text,
  logo_dark_url text,
  favicon_url text,
  primary_color text,
  secondary_color text,
  support_email text,
  support_phone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.app_name,
    s.app_short_name,
    s.tagline,
    s.logo_url,
    s.logo_dark_url,
    s.favicon_url,
    s.primary_color,
    s.secondary_color,
    s.support_email,
    s.support_phone
  FROM public.system_settings s
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_brand_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_brand_settings() TO anon, authenticated, service_role;

-- ============================================================
-- PART B — property_branding (optional per-property overrides)
-- ============================================================

CREATE TABLE public.property_branding (
  property_id UUID PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  display_name TEXT,
  logo_url TEXT,
  logo_dark_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  support_email TEXT,
  support_phone TEXT,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT property_branding_display_name_not_blank CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  -- Strict #rrggbb for the new property-level color pickers — no legacy
  -- data to preserve on this new table, so this can be enforced from day
  -- one rather than mirroring system_settings' permissive carve-out.
  CONSTRAINT property_branding_primary_color_hex
    CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT property_branding_secondary_color_hex
    CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9a-fA-F]{6}$')
);

-- SELECT, INSERT, and UPDATE are all granted — the client writes via a
-- plain upsert() (no dedicated write RPC for this table), and, exactly as
-- documented in PART A0 above for system_settings, RLS narrows an
-- existing grant, it cannot substitute for a missing one. No DELETE grant:
-- there is no row-delete UI/workflow for property branding — clearing a
-- field is an UPDATE to NULL (falls back to the organisation default),
-- never a row deletion.
GRANT SELECT, INSERT, UPDATE ON public.property_branding TO authenticated;
GRANT ALL ON public.property_branding TO service_role;
ALTER TABLE public.property_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "property_branding read" ON public.property_branding FOR SELECT TO authenticated
  USING (public.can_access_property(auth.uid(), property_id));

-- Write access: super_admin (any property), or hotel_owner/general_manager
-- scoped to this exact property. accountant and front_desk are
-- deliberately excluded — branding is neither an accounting nor a
-- front-of-house concern. Mirrors has_any_role()'s own semantics exactly
-- (super_admin bypasses the property match; everyone else needs an exact
-- property_id match) rather than reintroducing that logic ad hoc.
CREATE POLICY "property_branding write" ON public.property_branding FOR ALL TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], property_id))
  WITH CHECK (public.has_any_role(auth.uid(), ARRAY['super_admin','hotel_owner','general_manager']::app_role[], property_id));

CREATE TRIGGER trg_property_branding_updated BEFORE UPDATE ON public.property_branding
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ============================================================
-- PART C — get_effective_branding(): resolved read model
-- ============================================================
-- Property override -> global system_settings -> NULL (client-side
-- DEFAULTS in use-brand-settings.ts fill the final gap, exactly as
-- get_brand_settings() already relies on today). Property access is
-- enforced inside the function itself (can_access_property), returning
-- zero rows for a property the caller cannot access — the client then
-- falls back to DEFAULTS exactly as it already does when get_brand_settings()
-- returns nothing, rather than raising and leaking whether a property id
-- exists. favicon_url is intentionally NOT included: browser/application
-- identity stays organisation-wide only in this phase (see header note 4).
CREATE OR REPLACE FUNCTION public.get_effective_branding(_property_id UUID)
RETURNS TABLE (
  property_id UUID,
  effective_name TEXT,
  org_app_name TEXT,
  tagline TEXT,
  logo_url TEXT,
  logo_dark_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  support_email TEXT,
  support_phone TEXT,
  has_property_override BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    _property_id,
    COALESCE(pb.display_name, ss.app_short_name, ss.app_name),
    ss.app_name,
    ss.tagline,
    COALESCE(pb.logo_url, ss.logo_url),
    COALESCE(pb.logo_dark_url, ss.logo_dark_url),
    COALESCE(pb.primary_color, ss.primary_color),
    COALESCE(pb.secondary_color, ss.secondary_color),
    COALESCE(pb.support_email, ss.support_email),
    COALESCE(pb.support_phone, ss.support_phone),
    (pb.property_id IS NOT NULL)
  FROM public.system_settings ss
  LEFT JOIN public.property_branding pb ON pb.property_id = _property_id
  WHERE public.can_access_property(auth.uid(), _property_id)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_effective_branding(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_effective_branding(uuid) TO authenticated, service_role;

-- ============================================================
-- PART D — updated_by: server-set audit attribution
-- ============================================================
-- The client must never be trusted to self-report who made a change.
-- auth.uid() resolves the actual calling user from the request-scoped
-- JWT claim GUC that PostgREST sets for the duration of the request —
-- this is the same mechanism every RLS policy in this codebase already
-- relies on, and it works identically inside a plain (non-SECURITY
-- DEFINER) BEFORE trigger, since it reads the request's GUC rather than
-- anything about the trigger's own executing role. This trigger
-- unconditionally overwrites NEW.updated_by, so any client-supplied
-- value in the upsert payload is discarded rather than trusted.
CREATE OR REPLACE FUNCTION public.tg_property_branding_set_updated_by()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_branding_updated_by ON public.property_branding;
CREATE TRIGGER trg_property_branding_updated_by
  BEFORE INSERT OR UPDATE ON public.property_branding
  FOR EACH ROW EXECUTE FUNCTION public.tg_property_branding_set_updated_by();

-- ============================================================
-- PART E — property-scoped brand-assets storage authorization
-- ============================================================
-- Prior state (20260706182349): brand_assets_insert/_update/_delete
-- restrict ALL writes to the whole bucket to super_admin, with no path
-- structure. That's correct for organisation-wide branding but left
-- hotel_owner/general_manager unable to upload a property logo, even
-- though property_branding's own RLS (PART B above) already authorizes
-- them to edit that property's row — a real gap found during release
-- review. Fixed here with a new `property/<property_id>/<kind>/<file>`
-- path convention and additive, narrowly-scoped policies, mirroring the
-- exact precedent already shipped for the 'uploads' bucket
-- (20260705230448_scope_uploads_storage_rls.sql: same
-- storage.foldername()-derived property id, same
-- has_any_role(..., ARRAY['super_admin','hotel_owner','general_manager'], _property_id)
-- boundary used by property_branding itself) rather than inventing a
-- new authorization pattern.
--
-- This section does NOT touch, replace, or weaken the existing
-- bucket-wide super_admin policies — they continue to cover both the
-- legacy flat-path objects (`logo/...`, `favicon/...`) and the new
-- `organisation/<kind>/<file>` convention the organisation editor now
-- uses for new uploads, so organisation branding stays exactly as
-- super_admin-only as before, and a hotel_owner/general_manager's new
-- property-scoped grant below only ever matches paths starting with
-- `property/`, structurally excluding it from ever touching an
-- `organisation/...` or legacy-path object. No existing object needs to
-- move and no signed URL is invalidated: signed-URL validity does not
-- depend on the INSERT/UPDATE/DELETE policies changed here, and the
-- read policy (`brand_assets_read`) is untouched.
CREATE POLICY "brand_assets_property_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = 'property'
    AND public.has_any_role(
          auth.uid(),
          ARRAY['super_admin','hotel_owner','general_manager']::app_role[],
          ((storage.foldername(name))[2])::uuid
        )
  );

CREATE POLICY "brand_assets_property_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = 'property'
    AND public.has_any_role(
          auth.uid(),
          ARRAY['super_admin','hotel_owner','general_manager']::app_role[],
          ((storage.foldername(name))[2])::uuid
        )
  )
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = 'property'
    AND public.has_any_role(
          auth.uid(),
          ARRAY['super_admin','hotel_owner','general_manager']::app_role[],
          ((storage.foldername(name))[2])::uuid
        )
  );

CREATE POLICY "brand_assets_property_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'brand-assets'
    AND (storage.foldername(name))[1] = 'property'
    AND public.has_any_role(
          auth.uid(),
          ARRAY['super_admin','hotel_owner','general_manager']::app_role[],
          ((storage.foldername(name))[2])::uuid
        )
  );
