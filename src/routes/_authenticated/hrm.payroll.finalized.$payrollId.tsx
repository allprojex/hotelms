import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { FinalizedPayrollDetailPage } from "@/components/hrm/payroll-finalization-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/finalized/$payrollId")({
  head: () => ({ meta: [{ title: pageTitle("Finalized Payroll Detail", "-") }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { payrollId } = Route.useParams();
  return (
    <HrmWorkspaceShell>
      <FinalizedPayrollDetailPage payrollId={payrollId} />
    </HrmWorkspaceShell>
  );
}
