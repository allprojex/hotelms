import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunApprovalPage } from "@/components/hrm/payroll-finalization-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/$runId/approval")({
  head: () => ({ meta: [{ title: "Payroll Approval Detail - ThesKwoff Hotel" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { runId } = Route.useParams();
  return <PayrollRunApprovalPage runId={runId} />;
}
