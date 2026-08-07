import { createFileRoute } from "@tanstack/react-router";
import { PayrollManualInputsPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/manual-inputs")({
  head: () => ({ meta: [{ title: "Manual Payroll Inputs · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollManualInputsPage />
    </HrmWorkspaceShell>
  ),
});
