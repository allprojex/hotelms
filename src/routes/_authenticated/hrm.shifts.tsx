import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { ShiftsPage } from "@/components/hrm/shifts-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/shifts")({
  head: () => ({ meta: [{ title: pageTitle("Shift Scheduling") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <ShiftsPage />
    </HrmWorkspaceShell>
  ),
});
