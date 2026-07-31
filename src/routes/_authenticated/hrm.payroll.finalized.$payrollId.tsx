import { createFileRoute } from "@tanstack/react-router";
import { FinalizedPayrollDetailPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/finalized/$payrollId")({
  head: () => ({ meta: [{ title: "Finalized Payroll Detail - ThesKwoff Hotel" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { payrollId } = Route.useParams();
  return <FinalizedPayrollDetailPage payrollId={payrollId} />;
}
