import { createFileRoute } from "@tanstack/react-router";
import { LeaveManagementPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/leave")({
  head: () => ({ meta: [{ title: "Leave Management · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <LeaveManagementPage />
    </HrmWorkspaceShell>
  ),
});
