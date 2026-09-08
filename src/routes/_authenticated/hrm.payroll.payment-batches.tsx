import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PaymentBatchesPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-batches")({
  head: () => ({ meta: [{ title: pageTitle("Payment Preparation", "-") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PaymentBatchesPage />
    </HrmWorkspaceShell>
  ),
});
