# Hotel PMS upgrade plan — July 2026

## 1. Baseline status

- Branch/commit: `main` at `f80b8772da28de97e30b7a09906f76c79b5a95c2` (`Refine branded login and admin navigation`).
- Initial working tree: clean; no modified or untracked files.
- Runtime: Node `>=22.12 <23`; TanStack Start/React 19/Vite/Nitro with Supabase.
- Scripts: `dev`, `build`, `build:dev`, `preview`, `start`, `lint`, `format`, `smoke`, `smoke:trial`, `test`.
- Package management is mixed: CI uses Bun with frozen `bun.lock`; Hostinger deployment and offline installation use `npm ci` with `package-lock.json`. Production deployment makes npm/`package-lock.json` authoritative; CI parity must be resolved without deleting either lockfile.
- Validation:
  - `npm exec tsc -- --noEmit`: pass.
  - `npm test`: pass, 8 files / 394 tests.
  - `npm run build`: pass; Node-server Nitro output generated.
  - `npm run smoke`: pass, six public routes; authenticated routes were not exercised.
  - `npm run lint`: fail, 12,968 errors and 9 warnings across 153 files. Most are Prettier/style issues; generated `src/integrations/supabase/types.ts` accounts for 4,047 errors.

## 2. Current architecture

- File-based TanStack routes; authenticated layout checks the Supabase session, mandatory password change, inactivity timeout, session heartbeat, route roles, and active property.
- Supabase is the authoritative data layer. Generated types expose 75 public tables. Migrations are additive and dated; RLS is applied per table.
- Tenant isolation uses `property_id`, `user_roles`, and SQL helpers `can_access_property`, `has_role`, and `has_any_role`. `super_admin` is global; other privileged roles are property-scoped.
- UI authorization uses `ROUTE_ROLE_MAP`, `useUserRoles`, and per-page checks. Server functions repeat authorization through RLS/RPC checks.
- Accounting uses property-scoped accounts, periods, immutable journal entries/lines, posting RPCs, AP/AR, night audit, reporting, and external sync.
- Inventory uses shared item stock by location plus purchase orders, transfers, adjustments, and `apply_stock_delta`; POS close posts stock deductions.
- Audit uses `audit_logs`, `audit_capture`, server-side access checks, device/session context, and a restricted purge RPC.
- Files use Supabase Storage buckets/policies, upload metadata/rows, a file firewall, and admin approval.
- Deployment is a Node/Nitro service behind Nginx on Hostinger; Lovable and GitHub both track `main`.

## 3. Reusable capabilities

- RBAC/property scope: `src/hooks/use-user-roles.ts`, `src/lib/admin/route-permissions.ts`, auth middleware, `user_roles`, `role_permissions`.
- Audit/security: `src/lib/audit.functions.ts`, security event/lockout/session tables and Security Center.
- Reports/exports: analytics RPCs, scheduled CSV/PDF exports, jsPDF/PDF renderer, print HTML, XLSX dependency, accounting CSV reports.
- Channels: channel/mapping/queue/log tables, routes, webhook shell, manual sync UI.
- FX: currencies/rates/history, manual rate UI, conversion RPC, refresh endpoint/scheduler shell.
- Branding: dynamic brand hook, admin brand module, brand-assets storage, CSS tokens.
- Accounting: immutable journals, reversal link, period locks, AP/AR, posting rules, reports, sync.
- Inventory/import: item stock, movement RPCs, data upload staging/approval, duplicate summary, CSV/XLSX parsing UI.
- Analytics/POS: executive hotel/POS revenue RPCs, Recharts dashboard, outlet model, scheduled exports.
- Operations: notifications, recycle bin, backups, printers, public booking, dual staff/admin identity login.

## 4. Gap matrix

| Area | Status | Repository evidence / gap |
|---|---|---|
| Authentication/password | Complete | Staff/admin identifier or email login, approval/status, throttling, forced change, session controls, audit. |
| WebAuthn/biometric/2FA | Missing | OTP UI dependency/settings text only; no credential, challenge, enrollment, recovery, or TOTP implementation. |
| HRM | Missing | User profile has free-text `department` and an `hr` role; no HRM domain tables/routes/workflows. |
| Navigation/theme | Partial | Responsive grouped sidebar and CSS tokens exist; Deep Sea Blue foundation and HRM group are absent. |
| Reporting | Partial | Hotel/accounting/analytics CSV/PDF/print foundations exist; no unified filters, pagination, templates, or all-module coverage. |
| Unified POS executive view | Partial | POS outlets and aggregate POS revenue exist; department/payment/refund/discount/item/staff drill-downs are incomplete. |
| Expenses | Partial | Expense ledger accounts and AP bills exist; no dedicated categorized expense approval/receipt/reversal workflow. |
| Inventory imports | Partial | Staging, duplicate summary, admin approval, CSV/XLSX UI exist; validation is shallow and approval is not transactional/idempotent/rollbackable. |
| Gallery | Missing | Brand assets and room image URL fields are not a gallery/album system. |
| Reservation item distribution | Missing | Shared stock exists, but no reservation issue/return history or transactional issuance RPC. |
| Channel manager | Partial | Mappings, queues, logs, webhooks, and UI exist; current adapter explicitly simulates Booking.com and must not be presented as live. |
| Branding console | Partial | Name, tagline, logos, favicon, primary color, and support contacts exist; templates, typography, navigation colors, social/footer/watermark/background controls are absent. |
| FX | Partial | Manual/history/conversion and provider refresh shell exist; required currency set/source audit/offline policy need verification. Automatic refresh appears incompatible with property-scoped `fx_rates`: inserted rows omit `property_id` and use the wrong conflict key. |
| Executive analytics | Partial | Occupancy, ADR, RevPAR, reservation, room/POS revenue, source and room-type KPIs exist; HRM/payroll/expense/profit/inventory/department drill-downs are absent. |
| Production QA | Needs verification | Typecheck/tests/build/public smoke pass; lint and authenticated smoke fail/are incomplete as noted above. Production schema parity was not queried. |

## 5. Database and migration risks

- Forty-three timestamped migrations include later policy replacements; ordering and production migration parity must be proven before adding dependencies.
- Many foreign keys use `ON DELETE CASCADE`; HR/payroll/financial retention needs stricter archival/reversal rules.
- `apply_stock_delta` does not visibly prevent negative balances; future issue/return flows must enforce this transactionally.
- Upload approval performs row-by-row writes and can partially import before failure.
- `fx_rates` is property-scoped, while automatic refresh is system-scoped and omits `property_id`.
- Generated Supabase types may not prove the deployed schema matches local migrations.
- Existing mock OTA behavior is a production-integrity risk if enabled or labeled as a real integration.

## 6. Backward-compatibility risks

- Route-role changes can hide currently accessible modules or bypass property scope if UI and RLS diverge.
- New enum values, required columns, or uniqueness rules can break Lovable, deployed code, backups, or old records.
- Changing navigation/color tokens may override existing branding and contrast.
- Consolidating exports/imports can alter current filenames, payloads, or scheduled jobs.
- Lockfile convergence can change dependency resolution between CI and Hostinger.

## 7. Security concerns

- No WebAuthn/TOTP credential lifecycle exists; biometric work must store only FIDO2 public credential data.
- Client route guards are defense-in-depth only; every new mutation/export requires server authorization and RLS.
- Upload validation and file scanning must occur before persistence/import, with tenant-scoped storage paths.
- OTA/provider/webhook secrets must remain server-side, encrypted where supported, and excluded from logs.
- Audit export/purge, payroll access, recovery, and credential reset need explicit least-privilege policies.

## 8. Recommended phase order

Keep the requested Phase 1–10 order. In Phase 1, first freeze permission/property-scope conventions, then audit calls, report/export primitives, pagination/filter contracts, error/loading patterns, navigation tokens, feature flags, and migration conventions. Resolve lint scope and npm/Bun CI parity before broad feature work.

## 9. Files likely to change in Phase 1

- `src/lib/admin/permissions.ts`, `src/lib/admin/route-permissions.ts`
- `src/hooks/use-user-roles.ts`, `src/routes/_authenticated/route.tsx`
- `src/lib/audit.functions.ts`, `src/lib/analytics-exports.*`
- `src/lib/admin/pdf-render.server.ts`, `src/lib/admin/print-html.ts`
- New shared report/filter/pagination UI under `src/components/`
- `src/components/app-sidebar.tsx`, `src/styles.css`
- Focused tests under `tests/`
- One additive Supabase migration only if shared permission/audit conventions require schema support

## 10. Phase 1 tests

- Route/role/property matrix, including cross-property and global `super_admin`.
- Server mutation/export denial for unauthenticated, wrong-role, and wrong-property actors.
- Audit success/failure metadata and sensitive-export events.
- Shared date/filter/pagination serialization and boundary cases.
- CSV quoting, XLSX shape, PDF/print rendering, empty/error/loading states.
- Responsive/collapsed/mobile navigation and accessible contrast/keyboard checks.
- Migration dry run against a disposable schema; RLS regression tests.
- Typecheck, scoped lint, complete Vitest suite, production build, public and authenticated smoke.

## 11. Rollback approach

- Use small additive migrations with reversible down scripts documented separately; never rewrite migration history.
- Guard new navigation/routes with feature flags until schema and permissions are deployed.
- Deploy database-compatible code before enabling features; retain old columns/contracts through at least one release.
- Roll back application by deploying the prior known-good commit; reverse data changes only with tested compensating migrations or domain reversals.
- Back up and verify restore before each schema phase.

## 12. Open questions

- Which local migrations are present in production, and are there production-only schema changes?
- Which roles may view/export each HR/payroll/report dataset, and what retention rules apply?
- What are the approved payroll rules, departments, leave policies, holidays, and local statutory requirements?
- Which WebAuthn origins/RP ID, TOTP provider, recovery policy, and administrator approval workflow are required?
- Which POS outlet types map to reception, restaurant, bar, gym, supermarket, and pool?
- Which expense approval limits/categories and reversal rules are required?
- Which OTA providers/contracts, webhook formats, sync SLAs, and secret store will be used?
- Are negative stock, partial returns, room transfers, and complimentary guest items ever allowed?
- Which FX provider/account, supported currencies, refresh cadence, and per-property base-currency policy are approved?
- Should CI standardize on npm or should Hostinger move to Bun after deployment validation?
