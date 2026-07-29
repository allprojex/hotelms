# Hotel PMS development conventions

## Authorization

- The server and Supabase RLS are authoritative. UI checks only hide or disable controls.
- Permission modules use lower `snake_case`; product keys use `module.capability`.
- Shared capabilities are `view`, `create`, `edit`, `approve`, `delete_or_archive`, `export`, `print`, and `manage_settings`.
- Existing stored actions remain unchanged: `read`, `create`, `update`, `approve`, `delete`, `export`, `print`, and `manage`.
- Use `assertServerPermission` in server functions. Supply legacy default roles in trusted server code, never from client input.
- Explicit `role_permissions` rows override the default for that role. `super_admin` keeps its global override.
- Every request must include the target `propertyId`; never infer authorization from an active-property browser value.

## Audit

- Use `captureAuditEvent` and a lower `snake_case` `sourceModule`.
- Record property, action, resource type/ID, old/new values, correlation ID when available, and success state. Actor and timestamp come from authenticated database context.
- Shared redaction must run before audit writes. Never log passwords, tokens, secrets, credentials, receipt/file contents, or biometric material.
- Export and print of sensitive reports must call `authorizeReportAction`.
- Non-critical audit failures are best effort and must be observable to the caller. Set `required: true` only when the audit is part of the business invariant.
- Future posted financial and approved payroll operations require transactional audit rows in the same database transaction/RPC as posting, approval, reversal, or void.

## Database

- Use UUID primary keys with `gen_random_uuid()`.
- Tenant records require `property_id UUID NOT NULL` unless a documented global record is intentional.
- Use `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` and `updated_at` plus the existing update trigger for mutable records.
- Prefer `archived_at`, `archived_by`, or a constrained status over hard deletion. Approved payroll and posted financial records are immutable and use reversal/void references.
- Approval workflows use explicit status, approver, and approval timestamp. Enforce valid transitions in a transaction/RPC.
- Foreign keys must state intentional delete behavior. Avoid cascading deletion of audit, payroll, posted accounting, and historical movement records.
- Index property plus common filters/order columns; index foreign keys used in joins. Scope uniqueness by property unless values are truly global.
- Enable RLS before grants are useful. Add property-access read policies and least-privilege write policies using existing role helpers.
- New migrations are additive, timestamped, and never edit historical files. Roll back application code first; repair schemas with tested forward-fix migrations rather than history rewrites.

## Reports, filters, and pagination

- Define report columns once and reuse them for CSV, XLSX, PDF, and print.
- Neutralize spreadsheet formulas in all user-supplied string cells.
- Build filenames with `reportFileName`; include property/date metadata and retain headers for empty exports.
- Register report authorization in server code and audit sensitive export/print actions.
- Database-backed lists use `.range(from, to)` from `pageRange` and request an exact/planned count as appropriate.
- Persist only validated search, date, page, page-size, and allow-listed filters in URL parameters. Reset to page 1 when filters or page size change.

## Navigation and feature flags

- Preserve route hierarchy and role visibility. Navigation colors use semantic sidebar tokens; `--nav-brand-background`, `--nav-brand-foreground`, and `--nav-brand-accent` are the permitted branding override points.
- Keyboard focus, active, hover, mobile, and collapsed states must remain available through shared sidebar components.
- Do not create flags for active features. Incomplete future modules may use existing settings storage only when both server access and navigation/routes are disabled by the same property-scoped flag.
