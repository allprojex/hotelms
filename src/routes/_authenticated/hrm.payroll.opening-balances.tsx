import { createFileRoute } from "@tanstack/react-router";
import { OpeningBalancesPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/opening-balances")({
  head: () => ({ meta: [{ title: "Payroll Opening Balances · ThesKwoff Hotel" }] }),
  component: OpeningBalancesPage,
});
