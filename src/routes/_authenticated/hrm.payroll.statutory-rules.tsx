import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { StatutoryRulesPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/statutory-rules")({
  head: () => ({ meta: [{ title: pageTitle("Statutory Rules") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <StatutoryRulesPage />
    </HrmWorkspaceShell>
  ),
});
