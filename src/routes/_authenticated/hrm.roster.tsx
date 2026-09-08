import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { RosterPage } from "@/components/hrm/roster-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/roster")({
  head: () => ({ meta: [{ title: pageTitle("Duty Roster") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <RosterPage />
    </HrmWorkspaceShell>
  ),
});
