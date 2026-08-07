import { createFileRoute } from "@tanstack/react-router";
import { EmployeeDocumentsPage } from "@/components/hrm/documents-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/documents")({
  head: () => ({ meta: [{ title: "Employee Documents · ThesKwoff Hotel" }] }),
  component: () => (
    <HrmWorkspaceShell>
      <EmployeeDocumentsPage />
    </HrmWorkspaceShell>
  ),
});
