import { createFileRoute } from "@tanstack/react-router";
import { SalaryStructuresPage } from "@/components/hrm/payroll-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/salary-structures")({
  head: () => ({ meta: [{ title: "Salary Structures · ThesKwoff Hotel" }] }),
  component: SalaryStructuresPage,
});
