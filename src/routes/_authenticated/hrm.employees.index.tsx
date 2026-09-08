import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { EmployeesPage } from "@/components/hrm/employees-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/employees/")({
  head: () => ({ meta: [{ title: pageTitle("Employees") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <EmployeesPage />
    </HrmWorkspaceShell>
  ),
});
