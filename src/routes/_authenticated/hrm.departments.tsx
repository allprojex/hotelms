import { createFileRoute } from "@tanstack/react-router";
import { DepartmentsPage } from "@/components/hrm/structure-pages";

export const Route = createFileRoute("/_authenticated/hrm/departments")({
  head: () => ({ meta: [{ title: "Departments · ThesKwoff Hotel" }] }),
  component: DepartmentsPage,
});
