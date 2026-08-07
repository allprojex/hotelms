import type { CSSProperties, ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { HRM_NAV_GROUPS, resolveActiveHrmKey } from "@/lib/hrm/nav-config";
import { useHrmVisibility } from "@/hooks/use-hrm-visibility";

/**
 * Secondary in-workspace navigation shown at the top of every HRM route.
 * Every link is a real route (not a client-side panel switch), so direct
 * URLs, browser back/forward, and keyboard tabbing all work natively.
 */
export function HrmWorkspaceShell({ children }: { children: ReactNode }) {
  const { visibility, loading } = useHrmVisibility();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const activeKey = resolveActiveHrmKey(currentPath);

  const groups = HRM_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => visibility[item.key]),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-5">
      <nav
        aria-label="Human Resource Management sections"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 overflow-x-auto pb-1"
        style={{ "--nav-accent": "var(--nav-hrm)" } as CSSProperties}
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
                  className={
                    isActive
                      ? "nav-tab-3d nav-tab-3d-active nav-accent-border inline-flex items-center gap-1.5 rounded-md border-l-2 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap"
                      : "nav-tab-3d inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground whitespace-nowrap hover:text-foreground"
                  }
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
      {children}
    </div>
  );
}
