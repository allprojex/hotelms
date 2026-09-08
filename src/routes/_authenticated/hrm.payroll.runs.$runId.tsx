import { pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunDetailPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/$runId")({
  head: () => ({ meta: [{ title: pageTitle("Draft Payroll Review") }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { runId } = Route.useParams();
  return (
    <HrmWorkspaceShell>
      <PayrollRunDetailPage runId={runId} />
    </HrmWorkspaceShell>
  );
}
