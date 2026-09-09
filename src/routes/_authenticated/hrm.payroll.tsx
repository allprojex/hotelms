import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PayrollOverviewPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
import { ChildRouteOr } from "@/components/child-route-or";

export const Route = createFileRoute("/_authenticated/hrm/payroll")({
  head: () => ({ meta: [{ title: pageTitle("Payroll Overview") }] }),
  component: () => (
    <ChildRouteOr>
      <HrmWorkspaceShell>
        <PayrollOverviewPage />
      </HrmWorkspaceShell>
    </ChildRouteOr>
  ),
});
