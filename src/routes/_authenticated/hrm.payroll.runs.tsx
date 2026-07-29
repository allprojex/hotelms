import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunsPage } from "@/components/hrm/payroll-run-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs")({
  head: () => ({ meta: [{ title: "Draft Payroll Runs · ThesKwoff Hotel" }] }),
  component: PayrollRunsPage,
});
