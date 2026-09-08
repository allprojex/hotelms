import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { HolidaysPage } from "@/components/hrm/holidays-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/holidays")({
  head: () => ({ meta: [{ title: pageTitle("Holiday Calendar") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <HolidaysPage />
    </HrmWorkspaceShell>
  ),
});
