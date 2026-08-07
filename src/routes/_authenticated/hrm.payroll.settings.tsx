import { createFileRoute } from "@tanstack/react-router";
import { PayrollSettingsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/settings")({
  head: () => ({ meta: [{ title: "Payroll Settings · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollSettingsPage />
    </HrmWorkspaceShell>
  ),
});
