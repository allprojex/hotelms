import { createFileRoute } from "@tanstack/react-router";
import { PaymentDetailsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-details")({
  head: () => ({ meta: [{ title: "Payroll Payment Details · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PaymentDetailsPage />
    </HrmWorkspaceShell>
  ),
});
