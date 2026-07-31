import { createFileRoute } from "@tanstack/react-router";
import { PayrollCorrectionsPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/corrections")({
  head: () => ({ meta: [{ title: "Payroll Corrections - ThesKwoff Hotel" }] }),
  component: PayrollCorrectionsPage,
});
