import { createFileRoute } from "@tanstack/react-router";
import { LeaveBalancesPage } from "@/components/hrm/leave-pages";
export const Route = createFileRoute("/_authenticated/hrm/leave/balances")({
  head: () => ({ meta: [{ title: "Leave Balances · ThesKwoff Hotel" }] }),
  component: LeaveBalancesPage,
});
