import { createFileRoute } from "@tanstack/react-router";
import { HrmDashboardPage } from "@/components/hrm/dashboard-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/")({
  head: () => ({ meta: [{ title: "HRM Dashboard · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <HrmDashboardPage />
    </HrmWorkspaceShell>
  ),
});
