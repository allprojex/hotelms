import { createFileRoute } from "@tanstack/react-router";
import { PayrollApprovalsPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/approvals")({
  head: () => ({ meta: [{ title: "Payroll Approvals - ThesKwoff Hotel" }] }),
  component: PayrollApprovalsPage,
});
