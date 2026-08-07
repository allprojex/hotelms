import { createFileRoute } from "@tanstack/react-router";
import { EmployeeProfilePage } from "@/components/hrm/employee-profile-page";
import { HrmWorkspaceShell } from "@/components/hrm/hrm-workspace-nav";

export const Route = createFileRoute("/_authenticated/hrm/employees/$employeeId")({
  head: () => ({ meta: [{ title: "Employee Profile · ThesKwoff Hotel" }] }),
  component: EmployeeProfileRoute,
});

function EmployeeProfileRoute() {
  const { employeeId } = Route.useParams();
  return (
    <HrmWorkspaceShell>
      <EmployeeProfilePage employeeId={employeeId} />
    </HrmWorkspaceShell>
  );
}
