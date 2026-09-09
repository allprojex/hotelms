import { Outlet, useChildMatches } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Renders the nested route when one is matched, and this route's own page when
 * none is.
 *
 * The file-based router nests `a.b.tsx` under `a.tsx` automatically, and a
 * parent that never renders an `<Outlet />` swallows every child: the URL
 * changes, the child route resolves, and the parent's own page is what stays on
 * screen. That is what made every page under /hrm/payroll, /hrm/leave,
 * /accounting/expenses, /admin/esl and /admin/security unreachable.
 *
 * Wrapping the parent's content in this component fixes that without splitting
 * each parent into a layout plus an index route, so the route tree — and every
 * existing link and redirect — stays exactly as it is.
 */
export function ChildRouteOr({ children }: { children: ReactNode }) {
  const childMatches = useChildMatches();
  return childMatches.length > 0 ? <Outlet /> : <>{children}</>;
}
