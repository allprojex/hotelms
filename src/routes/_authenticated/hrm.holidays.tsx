import { createFileRoute } from "@tanstack/react-router";
import { HolidaysPage } from "@/components/hrm/holidays-page";

export const Route = createFileRoute("/_authenticated/hrm/holidays")({
  head: () => ({ meta: [{ title: "Holiday Calendar · ThesKwoff Hotel" }] }),
  component: HolidaysPage,
});
