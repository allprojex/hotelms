import { createFileRoute } from "@tanstack/react-router";
import { PayrollRunDetailPage } from "@/components/hrm/payroll-run-pages";

export const Route = createFileRoute("/_authenticated/hrm/payroll/runs/$runId")({
  head: () => ({ meta: [{ title: "Draft Payroll Review · ThesKwoff Hotel" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { runId } = Route.useParams();
  return <PayrollRunDetailPage runId={runId} />;
}
