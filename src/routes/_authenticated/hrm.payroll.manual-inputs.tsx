import { createFileRoute } from "@tanstack/react-router";
import { PayrollManualInputsPage } from "@/components/hrm/payroll-run-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/manual-inputs")({
  head: () => ({ meta: [{ title: "Manual Payroll Inputs · ThesKwoff Hotel" }] }),
  component: PayrollManualInputsPage,
});
