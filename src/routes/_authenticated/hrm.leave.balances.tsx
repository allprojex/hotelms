import { createFileRoute } from "@tanstack/react-router";
import { LeaveBalancesPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/leave/balances")({
  head: () => ({ meta: [{ title: "Leave Balances · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <LeaveBalancesPage />
    </HrmWorkspaceShell>
  ),
});
