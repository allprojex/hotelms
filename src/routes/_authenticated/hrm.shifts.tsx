import { createFileRoute } from "@tanstack/react-router";
import { ShiftsPage } from "@/components/hrm/shifts-page";

export const Route = createFileRoute("/_authenticated/hrm/shifts")({
  head: () => ({ meta: [{ title: "Shift Scheduling · ThesKwoff Hotel" }] }),
  component: ShiftsPage,
});
