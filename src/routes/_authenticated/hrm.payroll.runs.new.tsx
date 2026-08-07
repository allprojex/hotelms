import { createFileRoute } from "@tanstack/react-router";
import { NewPayrollRunPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/new")({
  head: () => ({ meta: [{ title: "New Draft Payroll Run · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <NewPayrollRunPage />
    </HrmWorkspaceShell>
  ),
});
