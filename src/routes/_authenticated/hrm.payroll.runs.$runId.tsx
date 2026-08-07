import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunDetailPage } from "@/components/hrm/payroll-run-pages";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/$runId")({
  head: () => ({ meta: [{ title: "Draft Payroll Review · ThesKwoff Hotel" }] }),
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
