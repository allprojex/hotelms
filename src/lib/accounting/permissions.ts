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
