import { createFileRoute } from "@tanstack/react-router";
import { EmployeeCompensationPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/compensation")({
  head: () => ({ meta: [{ title: "Employee Compensation · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <EmployeeCompensationPage />
    </HrmWorkspaceShell>
  ),
});
