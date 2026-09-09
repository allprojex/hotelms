/**
 * Every table this application owns is classified here: it is either backed up
 * or explicitly, and reasonedly, not.
 *
 * BACKUP_TABLES is ordered parents -> children so a restore satisfies foreign
 * keys. Three things about that order and its contents are worth knowing:
 *
 *  - hr_departments.department_head_id points at an employee who is themselves
 *    in that department, so the two tables are mutually dependent. Departments
 *    are restored first and the head reference is filled once employees exist.
 *
 *  - Several tables carry paths into Storage rather than the file itself:
 *    gallery_images, expense_receipts, hr_employee_documents,
 *    payroll_payslips and backup archives themselves. Restoring these rows
 *    restores the references, not the objects — the buckets (gallery-images,
 *    expense-receipts, employee-documents, brand-assets) have to be copied
 *    alongside the archive or those links resolve to nothing.
 *
 *  - payroll_payment_details holds bank and mobile-money details encrypted with
 *    PAYROLL_FIELD_ENCRYPTION_KEY. The ciphertext travels in the archive; a
 *    restore into a deployment holding a different key leaves those fields
 *    unreadable. Treat any archive containing it as sensitive material.
 */
export const BACKUP_TABLES: string[] = [
  // Foundation
  "currencies",
  "properties",
  "profiles",
  "custom_roles",
  "role_permissions",
  "user_roles",
  "system_settings",
  "guest_id_types",
  // Accounting foundation
  "accounts",
  "tax_codes",
  "fx_rates",
  "accounting_periods",
  "posting_rules",
  // Rooms & rates
  "room_types",
  "rooms",
  "rate_plans",
  // Journals — restored before payments and folio charges, which reference an
  // entry when they are reversed
  "journal_entries",
  "journal_lines",
  // Guests & reservations
  "guests",
  "reservations",
  "reservation_charges",
  "payments",
  // Inventory
  "stock_locations",
  "item_categories",
  "inventory_items",
  "item_stock",
  "suppliers",
  "purchase_orders",
  "purchase_order_lines",
  "stock_adjustments",
  "stock_adjustment_lines",
  "stock_transfers",
  "stock_transfer_lines",
  // POS
  "pos_outlets",
  "pos_menu_categories",
  "pos_menu_items",
  "pos_tables",
  "pos_orders",
  "pos_order_items",
  "pos_kots",
  "pos_payments",
  // AP/AR
  "ap_bills",
  "ap_bill_lines",
  "ap_payments",
  "ar_customers",
  "ar_invoices",
  "ar_invoice_lines",
  // Channels
  "channels",
  "channel_room_mappings",
  "channel_rate_mappings",
  "channel_reservations_queue",
  "channel_sync_logs",
  // Night audit / sync / analytics
  "night_audits",
  "accounting_sync_targets",
  "accounting_sync_runs",
  "analytics_export_schedules",
  "analytics_export_runs",
  // Ops history
  "notifications",
  "audit_logs",
  "admin_action_logs",
  "user_sessions",
  "data_uploads",
  "data_upload_rows",
  "invoices",
  // Property branding, printing and shelf labels
  "esl_devices",
  "esl_sync_batches",
  "esl_templates",
  "printers",
  "property_branding",
  "security_settings",
  "print_jobs",
  "printer_routing_rules",
  "esl_labels",
  // Gallery
  "gallery_albums",
  "gallery_images",
  // Receivables completed
  "ar_receipts",
  "ar_credit_notes",
  "ar_receipt_allocations",
  "ar_credit_note_lines",
  // Reservation extensions
  "inventory_stock_batches",
  "reservation_item_distributions",
  "reservation_payment_refunds",
  // HR structure
  "hr_departments",
  "hr_workforce_settings",
  "hr_designations",
  "hr_employees",
  "hr_employee_documents",
  "hr_employee_private",
  // HR time and attendance
  "hr_biometric_devices",
  "hr_shift_templates",
  "hr_biometric_employee_mappings",
  "hr_duty_roster",
  "hr_attendance_events",
  "hr_attendance_summaries",
  "hr_attendance_adjustments",
  // HR leave
  "hr_holidays",
  "hr_leave_types",
  "hr_holiday_departments",
  "hr_leave_balances",
  "hr_leave_requests",
  "hr_leave_approval_history",
  "hr_leave_balance_adjustments",
  // HR communication
  "hr_staff_announcements",
  "hr_announcement_departments",
  "hr_announcement_designations",
  "hr_announcement_employees",
  // Expenses
  "cost_centres",
  "expense_categories",
  "expenses",
  "expense_corrections",
  "expense_receipts",
  "expense_status_history",
  // Payroll configuration
  "payroll_journal_mappings",
  "payroll_pay_components",
  "payroll_pay_frequencies",
  "payroll_payment_export_templates",
  "payroll_statutory_rule_sets",
  "payroll_calendar_periods",
  "payroll_component_calculation_rules",
  "payroll_salary_structures",
  "payroll_settings",
  "payroll_period_close_history",
  "payroll_salary_grades",
  "payroll_structure_components",
  // Payroll employee records
  "payroll_employee_compensations",
  "payroll_manual_inputs",
  // Opening balances name the import batch they arrived in; the batch travels
  // with them so the provenance survives a restore.
  "payroll_opening_import_batches",
  "payroll_opening_balances",
  "payroll_payment_details",
  "payroll_employee_components",
  // Payroll runs
  "payroll_runs",
  "payroll_run_versions",
  "payroll_approval_actions",
  "payroll_run_employees",
  "payroll_calculation_findings",
  "payroll_run_line_items",
  // Finalised payroll and payslips
  "finalized_payrolls",
  "finalized_payroll_employees",
  "payroll_correction_requests",
  "payroll_journal_drafts",
  "payroll_payment_batches",
  "payroll_reversal_requests",
  "payroll_statutory_liability_summaries",
  "finalized_payroll_line_items",
  "payroll_correction_review_history",
  "payroll_journal_draft_lines",
  "payroll_payment_batch_lines",
  "payroll_payslips",
];

/**
 * Deliberately not backed up. Each entry states why, so that a future table is
 * a decision rather than an omission — the accompanying test fails until every
 * table in the schema appears in one list or the other.
 */
export const INTENTIONALLY_NOT_BACKED_UP: Record<string, string> = {
  backup_schedules: "backup configuration — restoring it into a restored database would re-point schedules at the old plan",
  backup_snapshots: "the catalogue of backups; a backup of it is circular and its storage paths belong to the source project",
  webauthn_challenges: "single-use, seconds-long authentication challenges",
  webauthn_credentials: "passkeys are bound to the device and origin that created them; restoring them elsewhere cannot work",
  passkey_enrollments: "follows webauthn_credentials — an enrolment without its credential is meaningless",
  passkey_enrollment_history: "history of enrolments that are themselves not restorable",
  login_attempts: "security telemetry, not business data; retained by its own policy",
  failed_login_attempts: "security telemetry, not business data",
  account_lockouts: "transient security state that must be re-earned, never restored",
  security_events: "security telemetry with its own retention; restoring it would falsify the timeline",
  file_scan_logs: "antivirus scan telemetry for files the archive does not contain",
  esl_pairing_codes: "short-lived device pairing codes",
  notification_reads: "per-user read receipts for notifications; rebuilt naturally, and noisy at scale",
  recycle_bin: "soft-deleted rows already captured in their own tables' backups",
  hr_biometric_normalized_events: "device ingest staging; the attendance events converted from it are backed up instead",
  hr_biometric_processing_logs: "ingest telemetry for the staging table above",
  hr_biometric_import_batches: "ingest batch metadata for the staging table above",
  hr_roster_leave_conflicts: "derived warnings, recomputed from the roster and leave rows that are backed up",
  hr_attendance_calculation_runs: "calculation audit trail for summaries that are backed up",
};
