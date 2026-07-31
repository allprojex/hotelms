import { createFileRoute } from "@tanstack/react-router";
import { JournalDraftsPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/journals")({
  head: () => ({ meta: [{ title: "Journal Drafts - ThesKwoff Hotel" }] }),
  component: JournalDraftsPage,
});
