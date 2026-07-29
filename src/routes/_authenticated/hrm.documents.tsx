import { createFileRoute } from "@tanstack/react-router";
import { EmployeeDocumentsPage } from "@/components/hrm/documents-page";

export const Route = createFileRoute("/_authenticated/hrm/documents")({
  head: () => ({ meta: [{ title: "Employee Documents · ThesKwoff Hotel" }] }),
  component: EmployeeDocumentsPage,
});
