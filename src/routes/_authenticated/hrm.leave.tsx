import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { LeaveManagementPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/leave")({
  head: () => ({ meta: [{ title: pageTitle("Leave Management") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <LeaveManagementPage />
    </HrmWorkspaceShell>
  ),
});
