import { createFileRoute } from "@tanstack/react-router";
import { WorkforceSettingsPage } from "@/components/hrm/workforce-settings-page";

export const Route = createFileRoute("/_authenticated/hrm/workforce-settings")({
  head: () => ({ meta: [{ title: "Workforce Settings · ThesKwoff Hotel" }] }),
  component: WorkforceSettingsPage,
});
