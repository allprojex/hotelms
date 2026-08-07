import { createFileRoute } from "@tanstack/react-router";
import { JournalDraftsPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/journals")({
  head: () => ({ meta: [{ title: "Journal Drafts - ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <JournalDraftsPage />
    </HrmWorkspaceShell>
  ),
});
