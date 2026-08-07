import { usePermission } from "@/hooks/use-permission";
import { useActiveProperty } from "@/hooks/use-active-property";
import { HRM_ADMIN_ROLES, PAYROLL_SENSITIVE_ROLES } from "@/lib/hrm/permissions";
import type { PayrollNavKey } from "@/lib/hrm/nav-config";

export type PayrollVisibility = Record<PayrollNavKey, boolean>;

/**
 * Single source of truth for which Payroll sections the signed-in user may
 * see. Mirrors useHrmVisibility's shape and is kept separate from it so
 * Payroll's 19 checks don't run on every HRM page that has nothing to do
 * with Payroll. Module/capability/defaultRoles pairs are copied verbatim
 * from the pre-refactor sidebar — including payrollCorrections using the
 * "create" capability, not "view" like every other entry here.
 */
export function usePayrollVisibility(): { visibility: PayrollVisibility; loading: boolean } {
  const propertyId = useActiveProperty();
  const payrollOverview = usePermission({
    propertyId,
    module: "payroll_overview",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payrollSettings = usePermission({
    propertyId,
    module: "payroll_settings",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payCalendars = usePermission({
    propertyId,
    module: "pay_calendars",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const salaryStructures = usePermission({
    propertyId,
    module: "salary_structures",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const payComponents = usePermission({
    propertyId,
    module: "pay_components",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const statutoryRules = usePermission({
    propertyId,
    module: "statutory_rules",
    capability: "view",
    defaultRoles: HRM_ADMIN_ROLES,
  });
  const employeeCompensation = usePermission({
    propertyId,
    module: "employee_compensation_sensitive",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentDetails = usePermission({
    propertyId,
    module: "payment_details",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const openingBalances = usePermission({
    propertyId,
    module: "opening_balances",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollRuns = usePermission({
    propertyId,
    module: "payroll_runs",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollManualInputs = usePermission({
    propertyId,
    module: "payroll_manual_inputs",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollApprovals = usePermission({
    propertyId,
    module: "payroll_approvals",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const finalizedPayroll = usePermission({
    propertyId,
    module: "finalized_payroll",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payrollCorrections = usePermission({
    propertyId,
    module: "payroll_corrections",
    capability: "create",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const payslips = usePermission({
    propertyId,
    module: "payslips",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentBatches = usePermission({
    propertyId,
    module: "payroll_payment_batches",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const paymentTemplates = usePermission({
    propertyId,
    module: "payroll_payment_templates",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const statutoryLiabilities = usePermission({
    propertyId,
    module: "payroll_statutory_liabilities",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });
  const journalDrafts = usePermission({
    propertyId,
    module: "payroll_journal_drafts",
    capability: "view",
    defaultRoles: PAYROLL_SENSITIVE_ROLES,
  });

  const checks = [
    payrollOverview,
    payrollSettings,
    payCalendars,
    salaryStructures,
    payComponents,
    statutoryRules,
    employeeCompensation,
    paymentDetails,
    openingBalances,
    payrollRuns,
    payrollManualInputs,
    payrollApprovals,
    finalizedPayroll,
    payrollCorrections,
    payslips,
    paymentBatches,
    paymentTemplates,
    statutoryLiabilities,
    journalDrafts,
  ];

  return {
    visibility: {
      payrollOverview: payrollOverview.allowed,
      payrollSettings: payrollSettings.allowed,
      payCalendars: payCalendars.allowed,
      salaryStructures: salaryStructures.allowed,
      payComponents: payComponents.allowed,
      statutoryRules: statutoryRules.allowed,
      employeeCompensation: employeeCompensation.allowed,
      paymentDetails: paymentDetails.allowed,
      openingBalances: openingBalances.allowed,
      payrollRuns: payrollRuns.allowed,
      payrollManualInputs: payrollManualInputs.allowed,
      payrollApprovals: payrollApprovals.allowed,
      finalizedPayroll: finalizedPayroll.allowed,
      payrollCorrections: payrollCorrections.allowed,
      payslips: payslips.allowed,
      paymentBatches: paymentBatches.allowed,
      paymentTemplates: paymentTemplates.allowed,
      statutoryLiabilities: statutoryLiabilities.allowed,
      journalDrafts: journalDrafts.allowed,
    },
    loading: checks.some((c) => c.loading),
  };
}
