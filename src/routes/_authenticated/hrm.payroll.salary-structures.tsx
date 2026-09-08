import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { SalaryStructuresPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/salary-structures")({
  head: () => ({ meta: [{ title: pageTitle("Salary Structures") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <SalaryStructuresPage />
    </HrmWorkspaceShell>
  ),
});
