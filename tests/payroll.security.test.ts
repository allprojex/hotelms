import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260729230000_payroll_configuration_foundation.sql"),
  "utf8",
);
const server = readFileSync(resolve(root, "src/lib/hrm/payroll.functions.ts"), "utf8");
const crypto = readFileSync(resolve(root, "src/lib/hrm/payroll-crypto.server.ts"), "utf8");
const permissions = readFileSync(resolve(root, "src/lib/hrm/permissions.ts"), "utf8");
const sidebar = readFileSync(resolve(root, "src/components/app-sidebar.tsx"), "utf8");

describe("Phase 4A payroll security and integration", () => {
  it("creates only configuration, compensation, payment, rule, and opening-balance tables", () => {
    for (const table of [
      "payroll_settings",
      "payroll_pay_frequencies",
      "payroll_calendar_periods",
      "payroll_salary_structures",
      "payroll_salary_grades",
      "payroll_pay_components",
      "payroll_structure_components",
      "payroll_employee_compensations",
      "payroll_employee_components",
      "payroll_payment_details",
      "payroll_statutory_rule_sets",
      "payroll_opening_import_batches",
      "payroll_opening_balances",
    ])
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    expect(migration).not.toMatch(
      /CREATE TABLE public\.payroll_(runs|payslips|payments|journals)/i,
    );
  });

  it("enforces property-scoped references and row-level security", () => {
    expect(migration).toContain("FOREIGN KEY(property_id,employee_id)");
    expect(migration).toContain("FOREIGN KEY(property_id,salary_structure_id)");
    expect(migration).toContain("FOREIGN KEY(property_id,pay_component_id)");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("has_hrm_permission(auth.uid(),property_id");
    expect(server).toContain("await allow(context, data.propertyId");
  });

  it("prevents effective-date overlaps and destructive history edits", () => {
    expect(migration.match(/EXCLUDE USING gist/g)?.length).toBeGreaterThanOrEqual(8);
    expect(migration).toContain("Historical payroll configuration must be superseded");
    expect(migration).toContain("payroll_calendar_periods_no_overlap");
    expect(migration).toContain("payroll_employee_compensations_no_overlap");
    expect(migration).toContain("payroll_protect_frequency_history");
  });

  it("protects unique codes, primary destinations, and opening imports", () => {
    expect(migration).toContain("payroll_pay_frequencies_code_ci_uniq");
    expect(migration).toContain("payroll_payment_details_primary_uniq");
    expect(migration).toContain("payroll_opening_balances_current_uniq");
    expect(migration).toContain("payroll_supersede_opening_balance");
    expect(migration).toContain(
      "public.payroll_opening_import_batches,public.payroll_opening_balances TO authenticated",
    );
    expect(migration).not.toContain(
      "GRANT SELECT,INSERT,UPDATE ON public.payroll_opening_balances",
    );
  });

  it("encrypts full payment values server-side and returns masking by default", () => {
    expect(crypto).toContain("PAYROLL_FIELD_ENCRYPTION_KEY");
    expect(crypto).toContain("AES-GCM");
    expect(migration).toContain("account_number_ciphertext");
    expect(migration).not.toMatch(/\baccount_number text\b/);
    expect(server).toContain("account_number_last4");
    expect(server).toContain("maskedAccount");
    expect(server).not.toMatch(/console\.(log|debug).*account/i);
  });

  it("requires explicit reveal and verification permissions and audits both", () => {
    expect(server).toContain("HRM_PERMISSIONS.fullPaymentDetailsReveal");
    expect(server).toContain("payroll_payment_detail_reveal");
    expect(server).toContain("HRM_PERMISSIONS.paymentDetailsVerify");
    expect(server).toContain("payroll_payment_detail_verification");
    expect(server).toContain("employee_compensation_sensitive");
  });

  it("keeps statutory rules structured, versioned, and free of hard-coded rates", () => {
    expect(migration).toContain("parameters jsonb");
    expect(migration).toContain("verification_status");
    expect(migration).toContain("UNIQUE(property_id,jurisdiction_code,rule_category,version)");
    expect(server).toContain("validateStructuredRuleParameters");
    expect(server).not.toMatch(/\b(SSNIT|PAYE)\b/);
    expect(server).not.toMatch(/\beval\s*\(/);
  });

  it("adds exactly the completed payroll routes and no processing links", () => {
    for (const path of [
      "/hrm/payroll",
      "/hrm/payroll/settings",
      "/hrm/payroll/calendars",
      "/hrm/payroll/salary-structures",
      "/hrm/payroll/pay-components",
      "/hrm/payroll/compensation",
      "/hrm/payroll/payment-details",
      "/hrm/payroll/statutory-rules",
      "/hrm/payroll/opening-balances",
      "/hrm/payroll/runs",
      "/hrm/payroll/manual-inputs",
    ])
      expect(sidebar).toContain(`to: "${path}"`);
  });

  it("defines all Phase 4A permission boundaries", () => {
    for (const name of [
      "payrollOverviewView",
      "payrollSettingsManage",
      "payCalendarsManage",
      "salaryStructuresManage",
      "payComponentsManage",
      "employeeCompensationManage",
      "sensitiveCompensationView",
      "paymentDetailsManage",
      "fullPaymentDetailsReveal",
      "paymentDetailsVerify",
      "statutoryRulesManage",
      "openingBalancesImport",
      "openingBalancesManage",
    ])
      expect(permissions).toContain(name);
    expect(migration).not.toMatch(/\('manager',.*(compensation|payment_details)/i);
    expect(migration).toContain("WHERE r<>'general_manager' OR m NOT IN");
  });
});
