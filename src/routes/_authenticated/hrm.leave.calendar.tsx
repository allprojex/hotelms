import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { LeaveCalendarPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/leave/calendar")({
  head: () => ({ meta: [{ title: pageTitle("Leave Calendar") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <LeaveCalendarPage />
    </HrmWorkspaceShell>
  ),
});
