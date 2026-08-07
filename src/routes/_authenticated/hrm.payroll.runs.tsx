import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunsPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs")({
  head: () => ({ meta: [{ title: "Draft Payroll Runs · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollRunsPage />
    </HrmWorkspaceShell>
  ),
});
