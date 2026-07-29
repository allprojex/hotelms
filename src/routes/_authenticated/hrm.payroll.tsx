import { createFileRoute } from "@tanstack/react-router";
import { PayrollOverviewPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll")({
  head: () => ({ meta: [{ title: "Payroll Overview · ThesKwoff Hotel" }] }),
  component: PayrollOverviewPage,
});
