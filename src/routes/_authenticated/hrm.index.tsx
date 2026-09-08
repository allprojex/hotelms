import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { HrmDashboardPage } from "@/components/hrm/dashboard-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/")({
  head: () => ({ meta: [{ title: pageTitle("HRM Dashboard") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <HrmDashboardPage />
    </HrmWorkspaceShell>
  ),
});
