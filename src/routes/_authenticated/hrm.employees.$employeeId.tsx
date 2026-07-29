import { createFileRoute } from "@tanstack/react-router";
import { EmployeeProfilePage } from "@/components/hrm/employee-profile-page";

export const Route = createFileRoute("/_authenticated/hrm/employees/$employeeId")({
  head: () => ({ meta: [{ title: "Employee Profile · ThesKwoff Hotel" }] }),
  component: EmployeeProfileRoute,
});

function EmployeeProfileRoute() {
  const { employeeId } = Route.useParams();
  return <EmployeeProfilePage employeeId={employeeId} />;
}
