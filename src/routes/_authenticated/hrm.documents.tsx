import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { EmployeeDocumentsPage } from "@/components/hrm/documents-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/documents")({
  head: () => ({ meta: [{ title: pageTitle("Employee Documents") }] }),
  component: () => (
    <HrmWorkspaceShell>
      <EmployeeDocumentsPage />
    </HrmWorkspaceShell>
  ),
});
