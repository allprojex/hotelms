import { createFileRoute } from "@tanstack/react-router";
import { PayslipsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payslips")({
  head: () => ({ meta: [{ title: "Payslips - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayslipsPage />
    </HrmWorkspaceShell>
  ),
});
