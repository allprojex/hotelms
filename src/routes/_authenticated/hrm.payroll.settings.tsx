import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PayrollSettingsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/settings")({
  head: () => ({ meta: [{ title: pageTitle("Payroll Settings") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollSettingsPage />
    </HrmWorkspaceShell>
  ),
});
