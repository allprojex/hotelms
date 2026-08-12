/**
 * Curated list of app-owned tables to back up.
 * Ordered parents → children so restore satisfies foreign keys.
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
  // Journals
  "journal_entries",
  "journal_lines",
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
];
