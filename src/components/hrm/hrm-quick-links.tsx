import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { HRM_NAV_GROUPS, type HrmNavKey } from "@/lib/hrm/nav-config";
import { useHrmVisibility } from "@/hooks/use-hrm-visibility";
import { usePayrollVisibility } from "@/hooks/use-payroll-visibility";

/**
 * Entry-point grid for the HRM workspace landing page. Grouped and
 * permission-filtered from the same HRM_NAV_GROUPS config as the sidebar
 * and the in-workspace section nav, so entry points never fall out of sync
 * with what a user is actually allowed to open.
 */
export function HrmQuickLinks() {
  const { visibility: hrmVisibility } = useHrmVisibility();
  const { visibility: payrollVisibility } = usePayrollVisibility();
  const visibility: Record<HrmNavKey, boolean> = {
    ...hrmVisibility,
    payroll: Object.values(payrollVisibility).some(Boolean),
  };

  const groups = HRM_NAV_GROUPS.filter((g) => g.label !== "Overview")
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => visibility[item.key]),
    }))
    .filter((group) => group.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <Card key={group.label} className="p-4">
          <h2 className="font-semibold">{group.label}</h2>
          <div className="mt-3 space-y-1">
            {group.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </Link>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
