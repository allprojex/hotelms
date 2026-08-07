import type { CSSProperties, ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  HRM_NAV_GROUPS,
  PAYROLL_NAV_GROUPS,
  isPayrollPath,
  resolveActiveHrmKey,
  resolveActivePayrollKey,
  type HrmNavKey,
} from "@/lib/hrm/nav-config";
import { useHrmVisibility } from "@/hooks/use-hrm-visibility";
import { usePayrollVisibility } from "@/hooks/use-payroll-visibility";

const navAccentStyle = { "--nav-accent": "var(--nav-hrm)" } as CSSProperties;

function tabClassName(isActive: boolean) {
  return isActive
    ? "nav-tab-3d nav-tab-3d-active nav-accent-border inline-flex items-center gap-1.5 rounded-md border-l-2 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
    : "nav-tab-3d inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground whitespace-nowrap hover:text-foreground";
}

/**
 * Secondary in-workspace navigation shown at the top of every HRM route.
 * Every link is a real route (not a client-side panel switch), so direct
 * URLs, browser back/forward, and keyboard tabbing all work natively.
 *
 * Payroll is one tab here (like Overview/People/Leave/...), not 19 tabs —
 * its own routes get a second nav row (below) only while you're actually
 * inside /hrm/payroll/*, keeping this top row from becoming a long list.
 */
export function HrmWorkspaceShell({ children }: { children: ReactNode }) {
  const { visibility: hrmVisibility, loading: hrmLoading } = useHrmVisibility();
  const { visibility: payrollVisibility, loading: payrollLoading } = usePayrollVisibility();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const activeKey = resolveActiveHrmKey(currentPath);
  const hasAnyPayrollAccess = Object.values(payrollVisibility).some(Boolean);

  const visibility: Record<HrmNavKey, boolean> = {
    ...hrmVisibility,
    payroll: hasAnyPayrollAccess,
  };
  const loading = hrmLoading || payrollLoading;

  const groups = HRM_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visibility[item.key]),
  })).filter((group) => group.items.length > 0);

  const showPayrollWorkspace = isPayrollPath(currentPath) && hasAnyPayrollAccess;
  const payrollActiveKey = showPayrollWorkspace ? resolveActivePayrollKey(currentPath) : null;
  const payrollGroups = showPayrollWorkspace
    ? PAYROLL_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => payrollVisibility[item.key]),
      })).filter((group) => group.items.length > 0)
    : [];

  return (
    <div className="space-y-5">
      <nav
        aria-label="Human Resource Management sections"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 overflow-x-auto pb-1"
        style={navAccentStyle}
      >
        {!loading && groups.length === 0 && (
          <p className="text-xs text-muted-foreground">No HRM sections available for your role.</p>
        )}
        {groups.map((group) => (
          <div
            key={group.label}
            role="group"
            aria-label={group.label}
            className="flex flex-wrap items-center gap-1 border-r border-border/60 pr-3 last:border-r-0 last:pr-0"
          >
            {group.items.map((item) => {
              const isActive = item.key === activeKey;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={isActive ? "page" : undefined}
                  title={item.description}
                  className={tabClassName(isActive)}
                >
                  <item.icon
                    className="h-3.5 w-3.5 shrink-0 nav-accent-icon"
                    style={isActive ? { opacity: 1 } : { opacity: 0.85 }}
                  />
                  {item.title}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      {showPayrollWorkspace && (
        <nav
          aria-label="Payroll sections"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 overflow-x-auto rounded-md border border-border/60 bg-muted/30 p-2"
          style={navAccentStyle}
        >
          {payrollGroups.map((group) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex flex-wrap items-center gap-1 border-r border-border/60 pr-3 last:border-r-0 last:pr-0"
            >
              {group.items.map((item) => {
                const isActive = item.key === payrollActiveKey;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={isActive ? "page" : undefined}
                    title={item.description}
                    className={tabClassName(isActive)}
                  >
                    <item.icon
                      className="h-3.5 w-3.5 shrink-0 nav-accent-icon"
                      style={isActive ? { opacity: 1 } : { opacity: 0.85 }}
                    />
                    {item.title}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      )}
      {children}
    </div>
  );
}
