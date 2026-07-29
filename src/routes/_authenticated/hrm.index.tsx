import { createFileRoute } from "@tanstack/react-router";
import { HrmDashboardPage } from "@/components/hrm/dashboard-page";

export const Route = createFileRoute("/_authenticated/hrm/")({
  head: () => ({ meta: [{ title: "HRM Dashboard · ThesKwoff Hotel" }] }),
  component: HrmDashboardPage,
});
