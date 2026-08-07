import { createFileRoute } from "@tanstack/react-router";
import { AttendancePage } from "@/components/hrm/attendance-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/attendance")({
  head: () => ({ meta: [{ title: "Attendance · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <AttendancePage />
    </HrmWorkspaceShell>
  ),
});
