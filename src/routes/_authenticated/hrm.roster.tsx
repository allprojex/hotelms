import { createFileRoute } from "@tanstack/react-router";
import { RosterPage } from "@/components/hrm/roster-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/roster")({
  head: () => ({ meta: [{ title: "Duty Roster · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <RosterPage />
    </HrmWorkspaceShell>
  ),
});
