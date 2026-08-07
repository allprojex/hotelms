import { createFileRoute } from "@tanstack/react-router";
import { PayrollCorrectionsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/corrections")({
  head: () => ({ meta: [{ title: "Payroll Corrections - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayrollCorrectionsPage />
    </HrmWorkspaceShell>
  ),
});
