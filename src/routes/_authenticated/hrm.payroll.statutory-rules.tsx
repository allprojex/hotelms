import { createFileRoute } from "@tanstack/react-router";
import { StatutoryRulesPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/statutory-rules")({
  head: () => ({ meta: [{ title: "Statutory Rules · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <StatutoryRulesPage />
    </HrmWorkspaceShell>
  ),
});
