import { createFileRoute } from "@tanstack/react-router";
import { AttendancePage } from "@/components/hrm/attendance-page";

export const Route = createFileRoute("/_authenticated/hrm/attendance")({
  head: () => ({ meta: [{ title: "Attendance · ThesKwoff Hotel" }] }),
  component: AttendancePage,
});
