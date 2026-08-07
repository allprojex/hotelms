import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataQueryState } from "@/components/shared/data-query-controls";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHrmVisibility } from "@/hooks/use-hrm-visibility";
import { getHrmDashboard } from "@/lib/hrm/hrm.functions";
import { HrmPageHeader, KpiCard } from "@/components/hrm/shared";
import { HrmQuickLinks } from "@/components/hrm/hrm-quick-links";

type DashboardData = {
  activeCount: number;
  inactiveCount: number;
  byDepartment: { name: string; count: number }[];
  byDesignation: { name: string; count: number }[];
  recentEmployees: {
    id: string;
    first_name: string;
    last_name: string;
    employee_number: string;
    hire_date: string;
    profileCompleteness: number;
  }[];
  incompleteEmployees: { id: string }[];
  recentDocuments: { id: string; title: string; file_name: string }[];
  activeAnnouncements: { id: string; title: string; priority: string }[];
};

export function HrmDashboardPage() {
  const propertyId = useActiveProperty();
  const { visibility } = useHrmVisibility();
  const fetchDashboard = useServerFn(getHrmDashboard);
  const query = useQuery({
    queryKey: ["hrm-dashboard", propertyId],
    enabled: !!propertyId && visibility.dashboard,
    queryFn: async () =>
      (await fetchDashboard({ data: { propertyId: propertyId! } })) as DashboardData,
  });
  const data = query.data;
  const empty =
    !data ||
    (data.activeCount === 0 && data.inactiveCount === 0 && data.activeAnnouncements.length === 0);

  return (
    <div className="space-y-5">
      <HrmPageHeader
        title="HRM Dashboard"
        description="Property-scoped employee, document, and announcement overview."
      />
      {visibility.dashboard && (
        <DataQueryState
          loading={query.isLoading}
          error={query.error}
          empty={empty}
          emptyTitle="No HRM data yet"
          emptyDescription="Create a department and employee to populate this dashboard."
        >
          {data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard label="Active employees" value={data.activeCount} />
                <KpiCard label="Inactive or archived" value={data.inactiveCount} />
                <KpiCard label="Incomplete profiles" value={data.incompleteEmployees.length} />
                <KpiCard label="Active announcements" value={data.activeAnnouncements.length} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <HrmChart title="Employees by department" rows={data.byDepartment} />
                <HrmChart title="Employees by designation" rows={data.byDesignation} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <h2 className="font-semibold">Recent employees</h2>
                  <div className="mt-3 space-y-2">
                    {data.recentEmployees.map((employee) => (
                      <div
                        key={employee.id}
                        className="flex items-center justify-between rounded-md border p-3"
                      >
                        <div>
                          <p className="font-medium">
                            {employee.first_name} {employee.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {employee.employee_number} · {employee.hire_date}
                          </p>
                        </div>
                        <Badge variant="outline">{employee.profileCompleteness}% complete</Badge>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card className="p-4">
                  <h2 className="font-semibold">Recent documents and announcements</h2>
                  <div className="mt-3 space-y-2">
                    {data.recentDocuments.map((document) => (
                      <div key={document.id} className="rounded-md border p-3 text-sm">
                        <p className="font-medium">{document.title}</p>
                        <p className="text-xs text-muted-foreground">{document.file_name}</p>
                      </div>
                    ))}
                    {data.activeAnnouncements.map((announcement) => (
                      <div key={announcement.id} className="rounded-md border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">{announcement.title}</p>
                          <Badge>{announcement.priority}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </>
          )}
        </DataQueryState>
      )}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">HRM workspace</h2>
        <HrmQuickLinks />
      </div>
    </div>
  );
}

function HrmChart({ title, rows }: { title: string; rows: { name: string; count: unknown }[] }) {
  const data = rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  return (
    <Card className="p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-3 h-64" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" fill="var(--nav-brand-accent)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
