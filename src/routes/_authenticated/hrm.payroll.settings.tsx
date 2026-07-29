import { createFileRoute } from "@tanstack/react-router";
import { PayrollSettingsPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/settings")({
  head: () => ({ meta: [{ title: "Payroll Settings · ThesKwoff Hotel" }] }),
  component: PayrollSettingsPage,
});
