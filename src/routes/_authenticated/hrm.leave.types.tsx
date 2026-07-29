import { createFileRoute } from "@tanstack/react-router";
import { LeaveTypesPage } from "@/components/hrm/leave-pages";
export const Route = createFileRoute("/_authenticated/hrm/leave/types")({
  head: () => ({ meta: [{ title: "Leave Types · ThesKwoff Hotel" }] }),
  component: LeaveTypesPage,
});
