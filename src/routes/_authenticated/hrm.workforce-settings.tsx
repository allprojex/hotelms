import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { WorkforceSettingsPage } from "@/components/hrm/workforce-settings-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/workforce-settings")({
  head: () => ({ meta: [{ title: pageTitle("Workforce Settings") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <WorkforceSettingsPage />
    </HrmWorkspaceShell>
  ),
});
