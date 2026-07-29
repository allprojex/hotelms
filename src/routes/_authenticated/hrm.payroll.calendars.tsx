import { createFileRoute } from "@tanstack/react-router";
import { PayCalendarsPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/calendars")({
  head: () => ({ meta: [{ title: "Pay Calendars · ThesKwoff Hotel" }] }),
  component: PayCalendarsPage,
});
