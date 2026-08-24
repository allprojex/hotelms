-- Incident fix: the entire public booking lifecycle -- booking_lookup,
-- booking_create, booking_cancel, and booking_modify -- has been
-- unreachable by anonymous callers since 2026-07-05, breaking
-- /book/checkout/$roomTypeId, /book/manage, and /book/confirmation/$code
-- for every real guest. booking_lookup's symptom (HTTP 401, Postgres
-- error 42501 "permission denied for function booking_lookup") was the
-- one actually observed live; the other three share the identical root
-- cause and were confirmed via the same live reproduction described below
-- to be equally broken -- restoring only booking_lookup while silently
-- leaving guests unable to create, cancel, or modify a booking would be
-- knowingly incomplete.
--
-- Root cause (confirmed against the full migration history and reproduced
-- byte-for-byte against a local disposable Postgres replaying that exact
-- history):
--   1. All four functions (plus booking_search_availability) were created
--      together in 20260705033256_...sql, each SECURITY DEFINER,
--      search_path pinned, each correctly
--      `GRANT EXECUTE ... TO anon, authenticated` in that same migration.
--   2. 20260705091747_...sql ran a blanket
--      `REVOKE ALL ... FROM PUBLIC, anon, authenticated` over every
--      SECURITY DEFINER function in `public`, then correctly re-granted
--      all five booking-flow RPCs back to `anon, authenticated` in that
--      SAME migration -- no regression yet.
--   3. 20260705105030_...sql ("Part 2: Revoke EXECUTE from anon on public
--      SECURITY DEFINER functions") ran a SECOND, near-identical blanket
--      `REVOKE EXECUTE ... FROM PUBLIC, anon` loop over every SECURITY
--      DEFINER function in `public` again -- an unconditional catalog scan
--      (`FOR r IN SELECT ... WHERE prosecdef = true LOOP REVOKE ... END
--      LOOP`) with no function-specific carve-out, so it revoked all five
--      booking RPCs identically and simultaneously, in one statement --
--      with NO corresponding re-grant anywhere in that file for any of
--      them.
--   4. A week later, 20260712183400_restore_public_booking_availability_
--      grant.sql explicitly restored anon+authenticated EXECUTE on
--      booking_search_availability only -- its own comment even says
--      "Function replacement can reset explicit grants, so keep the
--      intended anon/authenticated access here". The other four never
--      received the equivalent restoration.
--   5. None of the four affected functions were ever redefined again
--      after step 1 (no DROP+CREATE, no CREATE OR REPLACE for any of
--      them -- confirmed by a full-history grep). This migration
--      therefore changes no function body, no RLS, no table for any of
--      the four -- it is a pure grant restoration, mirroring the exact,
--      already-shipped precedent in 20260712183400 for the sibling
--      function that suffered the identical regression.
--
-- Security review (each function body inspected, none re-authored here):
--
--   booking_lookup(text,text): requires an EXACT match on BOTH
--   _confirmation_code AND lower(_email) (AND, not OR), returns at most
--   one row (LIMIT 1), returns no payment-instrument/admin-only fields
--   (rate_total is a total charge amount, not card data), and
--   reservations.confirmation_code carries a UNIQUE constraint -- cannot
--   leak a different property's or guest's booking; a code-only or
--   email-only lookup is structurally impossible.
--
--   booking_create(...): checks room availability (via
--   booking_search_availability, which already scopes to
--   is_public/active properties and room types) BEFORE any insert, and
--   that availability check is itself keyed by the caller-supplied
--   _room_type_id joined against _property_id -- a mismatched
--   property/room-type pair yields no availability row and the function
--   raises before writing anything. status is hardcoded 'confirmed'
--   (never client-supplied); rate_total is computed server-side from the
--   matched rate plan, never accepted as a parameter; the confirmation
--   code is generated from Postgres's own random(), not any
--   caller-supplied or guessable input. No admin/privileged field is
--   accepted. This is the exact RPC public checkout
--   (book.checkout.$roomTypeId.tsx) already calls. Known, pre-existing,
--   non-security limitation carried over unchanged from the original
--   design (not introduced or worsened by this migration): there is no
--   idempotency guard, so a genuine double-submit (e.g. a network retry)
--   creates two separate reservations rather than being deduplicated --
--   worth a future UX fix, not a reason to withhold this grant
--   restoration, since the original 2026-07-05 grant already accepted
--   this exact behavior.
--
--   booking_cancel(text,text) / booking_modify(...): both require the
--   caller to prove knowledge of the reservation's own
--   confirmation_code AND email together (identical two-factor pattern
--   to booking_lookup) before selecting the target row -- neither
--   accepts a reservation id/uuid directly, so one booking can never be
--   used to mutate another, and a guest cannot act on a booking whose
--   code+email they don't already know. booking_modify further rejects
--   any reservation not currently in 'confirmed' status (blocking a
--   modify on an already checked-in/checked-out/cancelled booking),
--   re-checks room availability for the new dates excluding the
--   reservation being modified itself, recomputes rate_total
--   server-side, and only accepts check_in/check_out/adults/children as
--   input (property_id, room_type_id, and guest_id are never
--   modifiable). booking_cancel rejects cancelling a 'checked_in' or
--   'checked_out' reservation; cancelling an already-'cancelled' booking
--   is a harmless idempotent no-op.
--
-- All four were safe for anon use when originally granted in
-- 20260705033256 and remain unchanged today -- this migration restores
-- exactly that original, intended contract for all four, nothing more
-- (no service_role, matching the historical contract exactly).
-- booking_search_availability is deliberately NOT touched here -- its
-- grant is already correct (restored by 20260712183400) and this
-- migration must not re-issue or otherwise disturb it.
REVOKE ALL ON FUNCTION public.booking_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_lookup(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.booking_lookup(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.booking_create(uuid, uuid, date, date, integer, integer, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_create(uuid, uuid, date, date, integer, integer, text, text, text, text, text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.booking_create(uuid, uuid, date, date, integer, integer, text, text, text, text, text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.booking_cancel(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_cancel(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.booking_cancel(text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.booking_modify(text, text, date, date, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_modify(text, text, date, date, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION public.booking_modify(text, text, date, date, integer, integer) TO authenticated;
