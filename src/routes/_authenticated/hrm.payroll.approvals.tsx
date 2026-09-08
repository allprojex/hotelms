import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PayrollApprovalsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/approvals")({
  head: () => ({ meta: [{ title: pageTitle("Payroll Approvals", "-") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollApprovalsPage />
    </HrmWorkspaceShell>
  ),
});
