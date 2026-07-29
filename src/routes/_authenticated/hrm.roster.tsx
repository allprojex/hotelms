import { createFileRoute } from "@tanstack/react-router";
import { RosterPage } from "@/components/hrm/roster-page";

export const Route = createFileRoute("/_authenticated/hrm/roster")({
  head: () => ({ meta: [{ title: "Duty Roster · ThesKwoff Hotel" }] }),
  component: RosterPage,
});
