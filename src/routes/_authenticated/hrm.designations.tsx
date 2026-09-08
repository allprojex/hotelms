import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { DesignationsPage } from "@/components/hrm/structure-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/designations")({
  head: () => ({ meta: [{ title: pageTitle("Designations") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <DesignationsPage />
    </HrmWorkspaceShell>
  ),
});
