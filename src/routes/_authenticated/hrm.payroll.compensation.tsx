import { createFileRoute } from "@tanstack/react-router";
import { EmployeeCompensationPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/compensation")({
  head: () => ({ meta: [{ title: "Employee Compensation · ThesKwoff Hotel" }] }),
  component: EmployeeCompensationPage,
});
