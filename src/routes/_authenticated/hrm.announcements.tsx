import { createFileRoute } from "@tanstack/react-router";
import { StaffAnnouncementsPage } from "@/components/hrm/announcements-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/announcements")({
  head: () => ({ meta: [{ title: "Staff Announcements · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <StaffAnnouncementsPage />
    </HrmWorkspaceShell>
  ),
});
