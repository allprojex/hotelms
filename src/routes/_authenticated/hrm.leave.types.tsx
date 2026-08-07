import { createFileRoute } from "@tanstack/react-router";
import { LeaveTypesPage } from "@/components/hrm/leave-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";
export const Route = createFileRoute("/_authenticated/hrm/leave/types")({
  head: () => ({ meta: [{ title: "Leave Types · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <LeaveTypesPage />
    </HrmWorkspaceShell>
  ),
});
