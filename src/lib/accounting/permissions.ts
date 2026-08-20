import type { AppRole } from "@/hooks/use-user-roles";

/**
 * Phase 6A permission map. Modules/capabilities reuse the app-wide
 * PermissionCapability vocabulary so existing role_permissions rows,
 * resolvePermission() and assertServerPermission() apply unchanged.
 *
 * "Own expense" actions (create/edit/submit/view own, category/vendor/cost-centre
 * read, receipt upload/view) are seeded broadly for operational roles in the
 * Phase 6A migration, since drafting your own expense needs no elevated privilege.
 * Admin-side actions default to no one beyond the seeded accounting-admin roles
 * (super_admin, hotel_owner, general_manager, accountant) and rely on explicit
 * role_permissions grants otherwise.
 */
export const ACCOUNTING_ADMIN_ROLES: readonly AppRole[] = [
  "super_admin",
  "hotel_owner",
  "general_manager",
  "accountant",
];

export const ACCOUNTING_AR_ROLES: readonly AppRole[] = [...ACCOUNTING_ADMIN_ROLES, "front_desk"];

export const AR_PERMISSIONS = {
  customersView: { module: "accounts_receivable", capability: "view" },
  customersManage: { module: "accounts_receivable", capability: "manage_settings" },
  invoicesCreate: { module: "accounts_receivable", capability: "create" },
  // Assigning a stable customer identity to a historical invoice is an
  // administrative reconciliation action, not mere viewing — reuses the
  // same manage_settings capability already gating AR customer create/edit.
  invoicesMapCustomer: { module: "accounts_receivable", capability: "manage_settings" },
  // Distinct module (not "accounts_receivable") so a Permission Matrix
  // override for invoice creation never silently also grants/revokes
  // credit-note creation. Default role set intentionally excludes
  // front_desk, unlike ACCOUNTING_AR_ROLES — create_ar_credit_note() and
  // post_ar_credit_note() (20260819120000_ar_credit_notes_pr1.sql) both
  // hardcode ACCOUNTING_ADMIN_ROLES (super_admin/hotel_owner/
  // general_manager/accountant) in their own has_any_role() check, which
  // an explicit role_permissions override can never widen — only narrow —
  // since the RPC's own check is the true, unconfigurable boundary. This
  // mirrors that boundary exactly for the UI's default-hidden state.
  creditNotesCreate: { module: "ar_credit_notes", capability: "create" },
  creditNotesPost: { module: "ar_credit_notes", capability: "approve" },
} as const;

/**
 * AP has no front_desk involvement anywhere in the schema — suppliers_write,
 * ap_bills_write and ap_payments_write RLS policies all gate on exactly
 * ACCOUNTING_ADMIN_ROLES (super_admin/hotel_owner/general_manager/
 * accountant), never front_desk. Reused as-is rather than defined as a
 * separate broader set, unlike AR's ACCOUNTING_AR_ROLES.
 */
export const ACCOUNTING_AP_ROLES: readonly AppRole[] = ACCOUNTING_ADMIN_ROLES;

export const AP_PERMISSIONS = {
  suppliersView: { module: "accounts_payable", capability: "view" },
  // Assigning a stable supplier identity to a historical bill is an
  // administrative reconciliation action, not mere viewing — mirrors AR's
  // invoicesMapCustomer using the same manage_settings capability.
  billsMapSupplier: { module: "accounts_payable", capability: "manage_settings" },
} as const;

export const EXPENSE_PERMISSIONS = {
  overviewView: { module: "accounting_overview", capability: "view" },

  periodsView: { module: "financial_periods", capability: "view" },
  periodsManage: { module: "financial_periods", capability: "manage_settings" },

  categoriesView: { module: "expense_categories", capability: "view" },
  categoriesManage: { module: "expense_categories", capability: "manage_settings" },

  vendorsView: { module: "vendors", capability: "view" },
  vendorsManage: { module: "vendors", capability: "manage_settings" },

  costCentresView: { module: "cost_centres", capability: "view" },
  costCentresManage: { module: "cost_centres", capability: "manage_settings" },

  expensesView: { module: "expenses", capability: "view" },
  expensesCreate: { module: "expenses", capability: "create" },
  expensesEdit: { module: "expenses", capability: "edit" },
  expensesSubmit: { module: "expense_submission", capability: "create" },
  expensesApprove: { module: "expense_approval", capability: "approve" },
  expensesReject: { module: "expense_rejection", capability: "approve" },
  expensesCancel: { module: "expense_cancellation", capability: "manage_settings" },
  expensesSensitiveView: { module: "expenses_sensitive", capability: "view" },

  receiptsView: { module: "expense_receipts", capability: "view" },
  receiptsUpload: { module: "expense_receipts", capability: "create" },
  receiptsArchive: { module: "expense_receipts", capability: "delete_or_archive" },

  correctionsView: { module: "expense_corrections", capability: "view" },
  correctionsCreate: { module: "expense_corrections", capability: "create" },
  correctionsApprove: { module: "expense_corrections", capability: "approve" },

  reversalsExecute: { module: "expense_reversals", capability: "manage_settings" },

  reportsView: { module: "expense_reports", capability: "view" },
  reportsExport: { module: "expense_reports", capability: "export" },
  reportsPrint: { module: "expense_reports", capability: "print" },
} as const;
