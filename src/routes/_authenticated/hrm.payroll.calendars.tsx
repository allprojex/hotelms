import { createFileRoute } from "@tanstack/react-router";
import { PayCalendarsPage } from "@/components/hrm/payroll-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/calendars")({
  head: () => ({ meta: [{ title: "Pay Calendars · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <PayCalendarsPage />
    </HrmWorkspaceShell>
  ),
});
