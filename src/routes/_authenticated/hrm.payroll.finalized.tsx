import { createFileRoute } from "@tanstack/react-router";
import { FinalizedPayrollsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/finalized")({
  head: () => ({ meta: [{ title: "Finalized Payroll - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <FinalizedPayrollsPage />
    </HrmWorkspaceShell>
  ),
});
