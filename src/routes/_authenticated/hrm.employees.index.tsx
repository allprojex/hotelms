import { createFileRoute } from "@tanstack/react-router";
import { EmployeesPage } from "@/components/hrm/employees-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/employees/")({
  head: () => ({ meta: [{ title: "Employees · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <EmployeesPage />
    </HrmWorkspaceShell>
  ),
});
