import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { FinalizedPayrollsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
import { ChildRouteOr } from "@/components/child-route-or";

export const Route = createFileRoute("/_authenticated/hrm/payroll/finalized")({
  head: () => ({ meta: [{ title: pageTitle("Finalized Payroll", "-") }] }),
  component: () => (
    <ChildRouteOr>
      <HrmWorkspaceShell>
        <FinalizedPayrollsPage />
      </HrmWorkspaceShell>
    </ChildRouteOr>
  ),
});
