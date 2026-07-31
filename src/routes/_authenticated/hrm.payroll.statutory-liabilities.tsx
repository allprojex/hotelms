import { createFileRoute } from "@tanstack/react-router";
import { StatutoryLiabilitiesPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/statutory-liabilities")({
  head: () => ({ meta: [{ title: "Statutory Liabilities - ThesKwoff Hotel" }] }),
  component: StatutoryLiabilitiesPage,
});
