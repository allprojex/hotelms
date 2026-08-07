import type { CSSProperties, ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  HRM_NAV_GROUPS,
  PAYROLL_NAV_GROUPS,
  findHrmGroupForKey,
  findPayrollGroupForKey,
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

type RowLink = {
  to: string;
  title: string;
  description: string;
  icon: LucideIcon;
  active: boolean;
};

/**
 * One nav row. "primary" is the always-visible top-level row; "secondary"
 * is a drilled-in row (HRM group children, Payroll's 5 groups, or a
 * Payroll group's own children) that only appears once its parent is
 * active — this is what keeps every row short instead of one long list.
 * Wraps via flex-wrap on narrow screens rather than scrolling horizontally.
 */
function NavRow({
  ariaLabel,
  links,
  variant,
}: {
  ariaLabel: string;
  links: RowLink[];
  variant: "primary" | "secondary";
}) {
  if (links.length === 0) return null;
  return (
    <nav
      aria-label={ariaLabel}
      className={
        variant === "primary"
          ? "flex flex-wrap items-center gap-1.5"
          : "flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 p-2"
      }
      style={navAccentStyle}
    >
      {links.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          aria-current={link.active ? "page" : undefined}
          title={link.description}
          className={tabClassName(link.active)}
        >
          <link.icon
            className="h-3.5 w-3.5 shrink-0 nav-accent-icon"
            style={link.active ? { opacity: 1 } : { opacity: 0.85 }}
          />
          {link.title}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Workspace chrome shown on every HRM (and nested Payroll) route. Three
 * possible tiers, each a real routed link so direct URLs, browser
 * back/forward, and keyboard tabbing all work natively — nothing here is a
 * client-side panel switch:
 *
 *   1. Primary row — the 7 major HRM sections (Overview, People, ...,
 *      Payroll). Each button is that section's own page if it only has
 *      one, or the first page of a multi-page section (People -> Employees).
 *   2a. HRM secondary row — the active section's own pages, shown only when
 *       that section has more than one (so Overview/Communication, which
 *       only have one page each, never grow a redundant one-item row).
 *   2b. Payroll secondary row — Payroll's 5 groups (Overview, Payroll
 *       Setup, ...), shown only while inside /hrm/payroll/*, using the same
 *       one-representative-per-group collapsing as the primary row.
 *   3. Payroll tertiary row — the active Payroll group's own pages, same
 *      single-page collapsing rule as 2a.
 */
export function HrmWorkspaceShell({ children }: { children: ReactNode }) {
  const { visibility: hrmVisibility, loading: hrmLoading } = useHrmVisibility();
  const { visibility: payrollVisibility, loading: payrollLoading } = usePayrollVisibility();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const loading = hrmLoading || payrollLoading;

  const hasAnyPayrollAccess = Object.values(payrollVisibility).some(Boolean);
  const visibility: Record<HrmNavKey, boolean> = { ...hrmVisibility, payroll: hasAnyPayrollAccess };

  const visibleHrmGroups = HRM_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visibility[item.key]),
  })).filter((group) => group.items.length > 0);

  const activeHrmKey = resolveActiveHrmKey(currentPath);
  const activeHrmGroup = findHrmGroupForKey(activeHrmKey);

  const primaryLinks: RowLink[] = visibleHrmGroups.map((group) => {
    const representative = group.items[0];
    return {
      to: representative.to,
      title: group.label,
      description: representative.description,
      icon: representative.icon,
      active: group.label === activeHrmGroup?.label,
    };
  });

  const activeHrmGroupItems = activeHrmGroup?.items.filter((item) => visibility[item.key]) ?? [];
  const hrmChildLinks: RowLink[] =
    activeHrmGroupItems.length > 1
      ? activeHrmGroupItems.map((item) => ({
          to: item.to,
          title: item.title,
          description: item.description,
          icon: item.icon,
          active: item.key === activeHrmKey,
        }))
      : [];

  const showPayrollWorkspace = isPayrollPath(currentPath) && hasAnyPayrollAccess;
  const visiblePayrollGroups = showPayrollWorkspace
    ? PAYROLL_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => payrollVisibility[item.key]),
      })).filter((group) => group.items.length > 0)
    : [];
  const activePayrollKey = showPayrollWorkspace ? resolveActivePayrollKey(currentPath) : null;
  const activePayrollGroup = findPayrollGroupForKey(activePayrollKey);

  const payrollGroupLinks: RowLink[] = visiblePayrollGroups.map((group) => {
    const representative = group.items[0];
    return {
      to: representative.to,
      title: group.label,
      description: representative.description,
      icon: representative.icon,
      active: group.label === activePayrollGroup?.label,
    };
  });

  const activePayrollGroupItems =
    activePayrollGroup?.items.filter((item) => payrollVisibility[item.key]) ?? [];
  const payrollChildLinks: RowLink[] =
    activePayrollGroupItems.length > 1
      ? activePayrollGroupItems.map((item) => ({
          to: item.to,
          title: item.title,
          description: item.description,
          icon: item.icon,
          active: item.key === activePayrollKey,
        }))
      : [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {!loading && primaryLinks.length === 0 && (
          <p className="text-xs text-muted-foreground">No HRM sections available for your role.</p>
        )}
        <NavRow
          ariaLabel="Human Resource Management sections"
          links={primaryLinks}
          variant="primary"
        />
        <NavRow
          ariaLabel={`${activeHrmGroup?.label ?? ""} pages`}
          links={hrmChildLinks}
          variant="secondary"
        />
        {showPayrollWorkspace && (
          <>
            <NavRow ariaLabel="Payroll sections" links={payrollGroupLinks} variant="secondary" />
            <NavRow
              ariaLabel={`${activePayrollGroup?.label ?? ""} pages`}
              links={payrollChildLinks}
              variant="secondary"
            />
          </>
        )}
      </div>
      {children}
    </div>
  );
}
