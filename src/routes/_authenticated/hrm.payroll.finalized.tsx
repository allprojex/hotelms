import { createFileRoute } from "@tanstack/react-router";
import { FinalizedPayrollsPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/finalized")({
  head: () => ({ meta: [{ title: "Finalized Payroll - ThesKwoff Hotel" }] }),
  component: FinalizedPayrollsPage,
});
