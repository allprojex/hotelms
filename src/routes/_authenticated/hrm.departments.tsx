import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { DepartmentsPage } from "@/components/hrm/structure-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/departments")({
  head: () => ({ meta: [{ title: pageTitle("Departments") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <DepartmentsPage />
    </HrmWorkspaceShell>
  ),
});
