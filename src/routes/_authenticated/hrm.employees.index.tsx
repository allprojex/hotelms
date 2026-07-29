import { createFileRoute } from "@tanstack/react-router";
import { EmployeesPage } from "@/components/hrm/employees-page";

export const Route = createFileRoute("/_authenticated/hrm/employees/")({
  head: () => ({ meta: [{ title: "Employees · ThesKwoff Hotel" }] }),
  component: EmployeesPage,
});
