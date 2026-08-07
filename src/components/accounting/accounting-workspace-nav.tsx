import type { CSSProperties, ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  ACCOUNTING_NAV_GROUPS,
  findAccountingGroupForKey,
  resolveActiveAccountingKey,
} from "@/lib/accounting/nav-config";
import { useAccountingVisibility } from "@/hooks/use-accounting-visibility";

const navAccentStyle = { "--nav-accent": "var(--nav-accounting)" } as CSSProperties;

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
 * One nav row. "primary" is the always-visible top-level row (the 7
 * Accounting sections); "secondary" is a drilled-in row of the active
 * section's own child pages, shown only once that section has more than one
 * page — this is what keeps every row short instead of one long list.
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
 * Workspace chrome shown on every Accounting route. Two tiers, each a real
 * routed link so direct URLs, browser back/forward, and keyboard tabbing
 * all work natively — nothing here is a client-side panel switch:
 *
 *   1. Primary row — the 7 major Accounting sections (Overview, Expenses,
 *      Receivables, Payables, General Ledger, Periods & Controls, Reports).
 *      Each button is that section's own page if it only has one, or the
 *      first page of a multi-page section (Expenses -> Expenses).
 *   2. Secondary row — the active section's own pages, shown only when
 *      that section has more than one (so Overview/Receivables/Payables/
 *      Reports, which only have one page each, never grow a redundant
 *      one-item row).
 */
export function AccountingWorkspaceShell({ children }: { children: ReactNode }) {
  const { visibility, loading } = useAccountingVisibility();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });

  const visibleGroups = ACCOUNTING_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visibility[item.key]),
  })).filter((group) => group.items.length > 0);

  const activeKey = resolveActiveAccountingKey(currentPath);
  const activeGroup = findAccountingGroupForKey(activeKey);

  const primaryLinks: RowLink[] = visibleGroups.map((group) => {
    const representative = group.items[0];
    return {
      to: representative.to,
      title: group.label,
      description: representative.description,
      icon: representative.icon,
      active: group.label === activeGroup?.label,
    };
  });

  const activeGroupItems = activeGroup?.items.filter((item) => visibility[item.key]) ?? [];
  const childLinks: RowLink[] =
    activeGroupItems.length > 1
      ? activeGroupItems.map((item) => ({
          to: item.to,
          title: item.title,
          description: item.description,
          icon: item.icon,
          active: item.key === activeKey,
        }))
      : [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {!loading && primaryLinks.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No Accounting sections available for your role.
          </p>
        )}
        <NavRow ariaLabel="Accounting sections" links={primaryLinks} variant="primary" />
        <NavRow
          ariaLabel={`${activeGroup?.label ?? ""} pages`}
          links={childLinks}
          variant="secondary"
        />
      </div>
      {children}
    </div>
  );
}
