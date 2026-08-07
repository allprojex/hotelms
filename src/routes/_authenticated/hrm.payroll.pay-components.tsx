import { createFileRoute } from "@tanstack/react-router";
import { PayComponentsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/pay-components")({
  head: () => ({ meta: [{ title: "Pay Components · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayComponentsPage />
    </HrmWorkspaceShell>
  ),
});
