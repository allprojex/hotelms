import { createFileRoute } from "@tanstack/react-router";
import { StatutoryLiabilitiesPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/statutory-liabilities")({
  head: () => ({ meta: [{ title: "Statutory Liabilities - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <StatutoryLiabilitiesPage />
    </HrmWorkspaceShell>
  ),
});
