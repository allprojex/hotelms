import { createFileRoute } from "@tanstack/react-router";
import { PaymentDetailsPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/payment-details")({
  head: () => ({ meta: [{ title: "Payroll Payment Details · ThesKwoff Hotel" }] }),
  component: PaymentDetailsPage,
});
