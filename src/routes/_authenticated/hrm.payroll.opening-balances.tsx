import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { OpeningBalancesPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/opening-balances")({
  head: () => ({ meta: [{ title: pageTitle("Payroll Opening Balances") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <OpeningBalancesPage />
    </HrmWorkspaceShell>
  ),
});
