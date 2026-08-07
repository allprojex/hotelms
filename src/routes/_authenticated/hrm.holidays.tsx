import { createFileRoute } from "@tanstack/react-router";
import { HolidaysPage } from "@/components/hrm/holidays-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/holidays")({
  head: () => ({ meta: [{ title: "Holiday Calendar · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <HolidaysPage />
    </HrmWorkspaceShell>
  ),
});
