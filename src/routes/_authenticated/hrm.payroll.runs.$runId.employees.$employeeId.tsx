import { createFileRoute } from "@tanstack/react-router";
import { PayrollEmployeeDetailPage } from "@/components/hrm/payroll-run-pages";

export const Route = createFileRoute(
  "/_authenticated/hrm/payroll/runs/$runId/employees/$employeeId",
)({
  head: () => ({ meta: [{ title: "Draft Payroll Employee Detail · ThesKwoff Hotel" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { runId, employeeId } = Route.useParams();
  return <PayrollEmployeeDetailPage runId={runId} employeeId={employeeId} />;
}
