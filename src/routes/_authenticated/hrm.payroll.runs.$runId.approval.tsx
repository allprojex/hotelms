import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunApprovalPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/$runId/approval")({
  head: () => ({ meta: [{ title: "Payroll Approval Detail - ThesKwoff Hotel" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { runId } = Route.useParams();
  return (
    <HrmWorkspaceShell>
      <PayrollRunApprovalPage runId={runId} />
    </HrmWorkspaceShell>
  );
}
