import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { LeaveManagementPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
import { ChildRouteOr } from "@/components/child-route-or";
export const Route = createFileRoute("/_authenticated/hrm/leave")({
  head: () => ({ meta: [{ title: pageTitle("Leave Management") }] }),
  component: () => (
    <ChildRouteOr>
      <HrmWorkspaceShell>
        <LeaveManagementPage />
      </HrmWorkspaceShell>
    </ChildRouteOr>
  ),
});
