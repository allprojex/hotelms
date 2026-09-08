import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PaymentDetailsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-details")({
  head: () => ({ meta: [{ title: pageTitle("Payroll Payment Details") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PaymentDetailsPage />
    </HrmWorkspaceShell>
  ),
});
