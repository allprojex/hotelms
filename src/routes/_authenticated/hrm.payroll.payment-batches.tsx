import { createFileRoute } from "@tanstack/react-router";
import { PaymentBatchesPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-batches")({
  head: () => ({ meta: [{ title: "Payment Preparation - ThesKwoff Hotel" }] }),
  component: PaymentBatchesPage,
});
