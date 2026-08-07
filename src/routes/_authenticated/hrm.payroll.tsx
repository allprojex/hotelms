import { createFileRoute } from "@tanstack/react-router";
import { PayrollOverviewPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll")({
  head: () => ({ meta: [{ title: "Payroll Overview · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollOverviewPage />
    </HrmWorkspaceShell>
  ),
});
