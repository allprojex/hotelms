import { createFileRoute } from "@tanstack/react-router";
import { PaymentTemplatesPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-templates")({
  head: () => ({ meta: [{ title: "Payment Export Templates - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PaymentTemplatesPage />
    </HrmWorkspaceShell>
  ),
});
