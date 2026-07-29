import { createFileRoute } from "@tanstack/react-router";
import { StaffAnnouncementsPage } from "@/components/hrm/announcements-page";

export const Route = createFileRoute("/_authenticated/hrm/announcements")({
  head: () => ({ meta: [{ title: "Staff Announcements · ThesKwoff Hotel" }] }),
  component: StaffAnnouncementsPage,
});
