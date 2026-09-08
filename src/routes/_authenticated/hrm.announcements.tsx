import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { StaffAnnouncementsPage } from "@/components/hrm/announcements-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/announcements")({
  head: () => ({ meta: [{ title: pageTitle("Staff Announcements") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <StaffAnnouncementsPage />
    </HrmWorkspaceShell>
  ),
});
