import { createFileRoute } from "@tanstack/react-router";
import { TimeClockPage } from "@/components/hrm/time-clock-page";

export const Route = createFileRoute("/_authenticated/hrm/time-clock")({
  head: () => ({ meta: [{ title: "Time Clock · ThesKwoff Hotel" }] }),
  component: TimeClockPage,
});
