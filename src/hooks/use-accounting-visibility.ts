import { usePermission } from "@/hooks/use-permission";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useUserRoles, SYNC_ROLES } from "@/hooks/use-user-roles";
import { ACCOUNTING_ADMIN_ROLES, EXPENSE_PERMISSIONS } from "@/lib/accounting/permissions";
import type { AccountingNavKey } from "@/lib/accounting/nav-config";

export type AccountingVisibility = Record<AccountingNavKey, boolean>;

/**
 * Single source of truth for which Accounting sections the signed-in user
 * may see. Shared by the collapsed sidebar entry (visible unconditionally,
 * matching pre-refactor behavior — see below) and the in-workspace section
 * nav (each item gated by its own key) so the two checks can never drift
 * apart.
 *
 * Overview, Chart of Accounts, Journal, Accounts Receivable, Accounts
 * Payable, Night Audit, Posting Rules, FX & Currencies and Reports carry no
 * module/capability permission or role check in the pre-refactor sidebar —
 * they're gated only by the outer /accounting route guard (ACCOUNTING
 * roles in src/lib/admin/route-permissions.ts). They're kept unconditionally
 * true here to preserve that exactly; adding a nav-level gate they never had
 * would be a behavior change, not a consolidation.
 *
 * Financial Periods and the six expense-workspace items reuse the same
 * EXPENSE_PERMISSIONS module/capability pairs and ACCOUNTING_ADMIN_ROLES
 * default the pre-refactor sidebar used. External Sync reuses the same
 * SYNC_ROLES role check the pre-refactor sidebar used via requireRoles.
 */
export function useAccountingVisibility(): {
  visibility: AccountingVisibility;
  loading: boolean;
} {
  const propertyId = useActiveProperty();
  const rolesQ = useUserRoles();
  const roleRows = rolesQ.data ?? [];
  const isSuper = roleRows.some((r) => r.role === "super_admin");
  const canSeeSync =
    isSuper ||
    roleRows.some(
      (r) =>
        SYNC_ROLES.includes(r.role) && (r.property_id === null || r.property_id === propertyId),
    );

  const expenses = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.expensesView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const expenseApprovals = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.expensesApprove,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const expenseCategories = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.categoriesView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const vendors = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.vendorsView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const costCentres = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.costCentresView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const financialPeriods = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.periodsView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });
  const expenseCorrections = usePermission({
    propertyId,
    ...EXPENSE_PERMISSIONS.correctionsView,
    defaultRoles: ACCOUNTING_ADMIN_ROLES,
  });

  const checks = [
    expenses,
    expenseApprovals,
    expenseCategories,
    vendors,
    costCentres,
    financialPeriods,
    expenseCorrections,
  ];

  return {
    visibility: {
      overview: true,
      chartOfAccounts: true,
      journal: true,
      accountsReceivable: true,
      accountsPayable: true,
      nightAudit: true,
      postingRules: true,
      fx: true,
      reports: true,
      externalSync: canSeeSync,
      expenses: expenses.allowed,
      expenseApprovals: expenseApprovals.allowed,
      expenseCategories: expenseCategories.allowed,
      vendors: vendors.allowed,
      costCentres: costCentres.allowed,
      financialPeriods: financialPeriods.allowed,
      expenseCorrections: expenseCorrections.allowed,
    },
    loading: rolesQ.isLoading || checks.some((c) => c.loading),
  };
}
