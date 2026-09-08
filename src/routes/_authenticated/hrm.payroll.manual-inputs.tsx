import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PayrollManualInputsPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/manual-inputs")({
  head: () => ({ meta: [{ title: pageTitle("Manual Payroll Inputs") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollManualInputsPage />
    </HrmWorkspaceShell>
  ),
});
