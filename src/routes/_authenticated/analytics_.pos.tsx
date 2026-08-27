import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createClientOnlyFn, useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole, EXEC_ROLES } from "@/hooks/use-user-roles";
import { AccessDenied } from "@/components/access-denied";
import { execCurrency, execMoney, execNumber } from "@/lib/analytics-format";
import { staffLabel } from "@/lib/pos-staff-label";
import {
  getPosExecSummary,
  getPosExecByDepartment,
  getPosExecByUser,
  getPosExecTopItems,
  getPosExecSalesByPeriod,
} from "@/lib/pos-analytics.functions";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BarChart3, Download, Printer, Info, RefreshCw } from "lucide-react";
import { format, startOfMonth } from "date-fns";

// Named analytics_.pos so the URL stays /analytics/pos while the route sits
// OUTSIDE the /analytics route. analytics.tsx is a full dashboard component
// with no <Outlet />, so nesting under it would render that page instead of
// this one.
export const Route = createFileRoute("/_authenticated/analytics_/pos")({
  head: () => ({ meta: [{ title: "POS Executive Analytics" }] }),
  component: PosExecutiveAnalytics,
});

// Date-only values are formatted with date-fns, never .toISOString(), so a
// local-midnight Date can't shift a day across timezones.
const dateKey = (d: Date) => format(d, "yyyy-MM-dd");

type Granularity = "day" | "month";

type SummaryRow = {
  operational_sales: number | string;
  operational_sales_net: number | string;
  operational_tax: number | string;
  closed_order_count: number;
  void_order_count: number;
  open_order_count: number;
  open_order_line_value: number | string;
  till_payment_count: number;
  till_payment_amount: number | string;
  cash_amount: number | string;
  card_amount: number | string;
  mobile_money_amount: number | string;
  bank_transfer_amount: number | string;
  wallet_amount: number | string;
  other_amount: number | string;
  folio_posted_count: number;
  folio_posted_amount: number | string;
};

type DeptRow = {
  outlet_id: string;
  outlet_name: string;
  outlet_kind: string;
  operational_sales: number | string;
  order_count: number;
  live_order_count: number;
  open_order_line_value: number | string;
};

type UserRow = {
  user_id: string;
  full_name: string | null;
  orders_created_count: number;
  orders_created_value: number | string;
  till_payments_received_count: number;
  till_payments_received_value: number | string;
};

type ItemRow = {
  menu_item_id: string | null;
  item_name: string;
  total_quantity: number | string;
  total_amount: number | string;
  order_count: number;
};

type PeriodRow = {
  period_start: string;
  operational_sales: number | string;
  order_count: number;
  payments_received_amount: number | string;
};

/** One flattened export row: every section is emitted into this shape. */
type ExportLine = {
  section: string;
  a: string;
  b: string;
  c: unknown;
  d: unknown;
  e: unknown;
};

// jspdf/xlsx are browser-only and heavy — loaded only when an export runs.
const runExport = createClientOnlyFn(
  async (definition: ReportDefinition<ExportLine>, fmt: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, fmt);
  },
);

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{label}</span>
          {hint && (
            <TooltipProvider>
              <UiTooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`About ${label}`}
                    className="inline-flex items-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{hint}</TooltipContent>
              </UiTooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function SectionState({
  loading,
  error,
  empty,
  emptyText,
  children,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (loading) return <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>;
  if (error)
    return (
      <p className="text-sm text-destructive py-6 text-center">
        Could not load this section. {(error as Error)?.message ?? ""}
      </p>
    );
  if (empty) return <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>;
  return <>{children}</>;
}

function PosExecutiveAnalytics() {
  const propertyId = useActiveProperty();
  const { allowed, loading: rolesLoading } = useHasAnyRole(EXEC_ROLES, propertyId);

  const today = new Date();
  const [from, setFrom] = useState(dateKey(startOfMonth(today)));
  const [to, setTo] = useState(dateKey(today));
  const [granularity, setGranularity] = useState<Granularity>("day");

  const summaryFn = useServerFn(getPosExecSummary);
  const deptFn = useServerFn(getPosExecByDepartment);
  const userFn = useServerFn(getPosExecByUser);
  const itemsFn = useServerFn(getPosExecTopItems);
  const periodFn = useServerFn(getPosExecSalesByPeriod);

  const enabled = !!propertyId && allowed && from <= to;
  // Every query key carries the property, so switching properties can never
  // serve Property A's cached rows under Property B's label.
  const args = { propertyId: propertyId!, from, to };

  // pos_orders / pos_payments are NOT in the supabase_realtime publication
  // (only channel_sync_logs is), and adding them would require an
  // ALTER PUBLICATION migration, which is out of scope for this PR. A modest
  // background refetch gives near-live figures without weakening RLS or
  // changing the database contract.
  const LIVE_REFETCH_MS = 60_000;

  const summary = useQuery({
    queryKey: ["pos-exec-summary", args],
    enabled,
    refetchInterval: LIVE_REFETCH_MS,
    queryFn: () => summaryFn({ data: args }) as Promise<SummaryRow | null>,
  });
  const departments = useQuery({
    queryKey: ["pos-exec-departments", args],
    enabled,
    refetchInterval: LIVE_REFETCH_MS,
    queryFn: () => deptFn({ data: args }) as Promise<DeptRow[]>,
  });
  const users = useQuery({
    queryKey: ["pos-exec-users", args],
    enabled,
    queryFn: () => userFn({ data: args }) as Promise<UserRow[]>,
  });
  const topItems = useQuery({
    queryKey: ["pos-exec-top-items", args, 10],
    enabled,
    queryFn: () => itemsFn({ data: { ...args, limit: 10 } }) as Promise<ItemRow[]>,
  });
  const periods = useQuery({
    queryKey: ["pos-exec-periods", args, granularity],
    enabled,
    queryFn: () => periodFn({ data: { ...args, granularity } }) as Promise<PeriodRow[]>,
  });

  const property = useQuery({
    queryKey: ["pos-exec-property", propertyId],
    enabled: !!propertyId,
    queryFn: async () =>
      (
        await supabase
          .from("properties")
          .select("name, base_currency")
          .eq("id", propertyId!)
          .maybeSingle()
      ).data,
  });
  // Money is always rendered in the ACTIVE property's configured currency.
  // Nothing here hardcodes a symbol or code.
  const currency = execCurrency(property.data?.base_currency);
  const propertyName = property.data?.name ?? null;
  const money = (v: unknown) => execMoney(v, currency);

  // Reset the trend granularity when the property changes so a month view
  // from a previous property doesn't linger under a new one.
  useEffect(() => {
    setGranularity("day");
  }, [propertyId]);

  const s = summary.data ?? null;
  const rangeLabel = `${from} → ${to}`;

  const trendData = useMemo(
    () =>
      (periods.data ?? []).map((r) => ({
        period: r.period_start,
        sales: Number(r.operational_sales ?? 0),
        payments: Number(r.payments_received_amount ?? 0),
      })),
    [periods.data],
  );

  const deptChart = useMemo(
    () =>
      (departments.data ?? [])
        .map((d) => ({ name: d.outlet_name, sales: Number(d.operational_sales ?? 0) }))
        .filter((d) => d.sales > 0),
    [departments.data],
  );

  function exportAll(fmt: ReportFormat) {
    // Exports carry the FULL RPC result sets for the selected property and
    // range — never a visually truncated chart slice. Numeric cells stay
    // numeric and a Currency column names the unit, so spreadsheets remain
    // usable while PDF/Print render formatted money.
    const humanReadable = fmt === "pdf" || fmt === "print";
    const m = (v: unknown) => (humanReadable ? money(v) : Number(v ?? 0));

    const rows: ExportLine[] = [];
    if (s) {
      const kv: [string, unknown][] = [
        ["Operational Sales", s.operational_sales],
        ["Net Sales", s.operational_sales_net],
        ["Tax", s.operational_tax],
        ["Till Payments", s.till_payment_amount],
        ["Folio Posted", s.folio_posted_amount],
        ["Live Order Value", s.open_order_line_value],
        ["Cash", s.cash_amount],
        ["Card", s.card_amount],
        ["Mobile Money", s.mobile_money_amount],
        ["Bank Transfer", s.bank_transfer_amount],
        ["Wallet", s.wallet_amount],
        ["Other", s.other_amount],
      ];
      for (const [k, v] of kv)
        rows.push({ section: "Summary", a: k, b: "", c: m(v), d: "", e: "" });
      const counts: [string, unknown][] = [
        ["Closed Orders", s.closed_order_count],
        ["Live Orders", s.open_order_count],
        ["Void Orders", s.void_order_count],
        ["Till Payment Count", s.till_payment_count],
        ["Folio Posted Count", s.folio_posted_count],
      ];
      // Counts never receive a currency symbol.
      for (const [k, v] of counts)
        rows.push({ section: "Summary", a: k, b: "", c: Number(v ?? 0), d: "", e: "" });
    }
    for (const d of departments.data ?? [])
      rows.push({
        section: "Outlet",
        a: d.outlet_name,
        b: d.outlet_kind,
        c: m(d.operational_sales),
        d: Number(d.order_count ?? 0),
        e: m(d.open_order_line_value),
      });
    for (const u of users.data ?? [])
      rows.push({
        section: "Staff",
        a: staffLabel(u),
        b: "",
        c: m(u.orders_created_value),
        d: Number(u.orders_created_count ?? 0),
        e: m(u.till_payments_received_value),
      });
    for (const i of topItems.data ?? [])
      rows.push({
        section: "Item",
        a: i.item_name,
        b: "",
        c: m(i.total_amount),
        d: Number(i.total_quantity ?? 0),
        e: Number(i.order_count ?? 0),
      });
    for (const p of periods.data ?? [])
      rows.push({
        section: granularity === "day" ? "Day" : "Month",
        a: p.period_start,
        b: "",
        c: m(p.operational_sales),
        d: Number(p.order_count ?? 0),
        e: m(p.payments_received_amount),
      });

    const definition: ReportDefinition<ExportLine> = {
      title: `POS Executive Analytics — ${propertyName ?? "Property"}`,
      slug: "pos-executive-analytics",
      propertyName,
      dateRange: { from, to },
      columns: [
        { key: "section", label: "Section", value: (r) => r.section },
        { key: "a", label: "Name", value: (r) => r.a },
        { key: "b", label: "Type", value: (r) => r.b },
        { key: "c", label: "Amount", value: (r) => r.c },
        { key: "d", label: "Count / Quantity", value: (r) => r.d },
        { key: "e", label: "Secondary", value: (r) => r.e },
        { key: "cur", label: "Currency", value: () => currency },
      ],
      rows,
    };
    return runExport(definition, fmt);
  }

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;
  if (rolesLoading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!allowed)
    return (
      <div className="p-4 md:p-6">
        <AccessDenied message="POS executive analytics are restricted to owners, general managers, and accountants for this property." />
      </div>
    );

  const exportsDisabled = summary.isLoading || !!summary.error;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
            <BarChart3 className="h-6 w-6" /> POS Executive Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Operational POS analytics for{" "}
            <span className="font-medium">{propertyName ?? "the selected property"}</span>. These
            are operational point-of-sale figures, not audited General Ledger revenue, and cover
            only outlets belonging to this property.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/analytics">Executive Analytics</Link>
        </Button>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="pos-from" className="text-xs">
              From
            </Label>
            <Input
              id="pos-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8"
            />
          </div>
          <div>
            <Label htmlFor="pos-to" className="text-xs">
              To
            </Label>
            <Input
              id="pos-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom(dateKey(startOfMonth(new Date())));
              setTo(dateKey(new Date()));
            }}
          >
            <RefreshCw className="h-3 w-3 mr-1" /> Reset
          </Button>
          <div className="text-xs text-muted-foreground">
            Showing <span className="font-medium">{rangeLabel}</span> · {currency}
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={exportsDisabled}
              onClick={() => exportAll("csv")}
            >
              <Download className="h-3 w-3 mr-1" /> CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exportsDisabled}
              onClick={() => exportAll("xlsx")}
            >
              <Download className="h-3 w-3 mr-1" /> XLSX
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exportsDisabled}
              onClick={() => exportAll("pdf")}
            >
              <Download className="h-3 w-3 mr-1" /> PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={exportsDisabled}
              onClick={() => exportAll("print")}
            >
              <Printer className="h-3 w-3 mr-1" /> Print
            </Button>
          </div>
        </div>
        {from > to && (
          <p className="text-xs text-destructive mt-2">
            The start date is after the end date — adjust the range to load figures.
          </p>
        )}
      </Card>

      <section aria-labelledby="pos-kpis">
        <h2 id="pos-kpis" className="sr-only">
          Key figures
        </h2>
        <SectionState
          loading={summary.isLoading}
          error={summary.error}
          empty={!s}
          emptyText="No POS figures for this property and period."
        >
          {s && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Kpi
                  label="Operational Sales"
                  value={money(s.operational_sales)}
                  hint="Total of closed POS orders in this period. Operational point-of-sale sales, not General Ledger revenue."
                />
                <Kpi
                  label="Net Sales"
                  value={money(s.operational_sales_net)}
                  hint="Closed-order subtotals, excluding tax."
                />
                <Kpi
                  label="Tax"
                  value={money(s.operational_tax)}
                  hint="Tax recorded on closed orders in this period."
                />
                <Kpi label="Closed Orders" value={execNumber(s.closed_order_count)} />
                <Kpi
                  label="Live Order Value"
                  value={money(s.open_order_line_value)}
                  hint="Current item-line value of open, sent and served POS orders as of the report end date. Not a final tax-inclusive bill."
                />
                <Kpi label="Live Orders" value={execNumber(s.open_order_count)} />
                <Kpi
                  label="Void Orders"
                  value={execNumber(s.void_order_count)}
                  hint="Excluded from all sales, payment and item figures."
                />
                <Kpi
                  label="Till Payments"
                  value={money(s.till_payment_amount)}
                  hint="Money taken at the till. Excludes amounts posted to a guest folio."
                />
                <Kpi
                  label="Folio Posted"
                  value={money(s.folio_posted_amount)}
                  hint="Closed-order value pushed onto a guest folio rather than collected at the till."
                />
              </div>

              <Card className="mt-3">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Payment methods (till only)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
                    <Kpi label="Cash" value={money(s.cash_amount)} />
                    <Kpi label="Card" value={money(s.card_amount)} />
                    <Kpi label="Mobile Money" value={money(s.mobile_money_amount)} />
                    <Kpi label="Bank Transfer" value={money(s.bank_transfer_amount)} />
                    <Kpi label="Wallet" value={money(s.wallet_amount)} />
                    <Kpi label="Other" value={money(s.other_amount)} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    Folio settlements are reported separately above and are deliberately excluded
                    from these method totals.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </SectionState>
      </section>

      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0 flex-wrap gap-2">
          <CardTitle className="text-sm">Sales trend · {rangeLabel}</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="pos-grain" className="text-xs">
              Granularity
            </Label>
            <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
              <SelectTrigger id="pos-grain" className="w-32 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Daily</SelectItem>
                <SelectItem value="month">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <SectionState
            loading={periods.isLoading}
            error={periods.error}
            empty={trendData.length === 0}
            emptyText="No periods in this range."
          >
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis dataKey="period" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip formatter={(v: number) => money(v)} />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="sales"
                    name="Operational Sales"
                    stroke="#0ea5e9"
                    fill="#0ea5e9"
                    fillOpacity={0.2}
                  />
                  <Area
                    type="monotone"
                    dataKey="payments"
                    name="Till Payments Received"
                    stroke="#10b981"
                    fill="#10b981"
                    fillOpacity={0.15}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {/* Text equivalent of the chart for assistive technology. */}
            <div className="overflow-x-auto mt-2">
              <Table>
                <caption className="sr-only">
                  Operational sales and till payments received per {granularity}
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Period</TableHead>
                    <TableHead scope="col" className="text-right">
                      Operational Sales
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Till Payments
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(periods.data ?? []).map((p) => (
                    <TableRow key={p.period_start}>
                      <TableCell className="text-xs">{p.period_start}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {money(p.operational_sales)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {execNumber(p.order_count)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {money(p.payments_received_amount)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Departments / outlets</CardTitle>
        </CardHeader>
        <CardContent>
          <SectionState
            loading={departments.isLoading}
            error={departments.error}
            empty={(departments.data ?? []).length === 0}
            emptyText="This property has no POS outlets."
          >
            {deptChart.length > 0 && (
              <div className="h-56 w-full mb-3">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={deptChart}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="name" fontSize={11} />
                    <YAxis fontSize={11} />
                    <Tooltip formatter={(v: number) => money(v)} />
                    <Bar dataKey="sales" name="Operational Sales" fill="#6366f1" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Outlet</TableHead>
                    <TableHead scope="col">Kind</TableHead>
                    <TableHead scope="col" className="text-right">
                      Operational Sales
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Closed Orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Live Orders
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Live Order Value
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(departments.data ?? []).map((d) => (
                    <TableRow key={d.outlet_id}>
                      <TableCell className="font-medium">{d.outlet_name}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{d.outlet_kind.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {money(d.operational_sales)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {execNumber(d.order_count)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {execNumber(d.live_order_count)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {money(d.open_order_line_value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionState>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Staff activity</CardTitle>
          </CardHeader>
          <CardContent>
            <SectionState
              loading={users.isLoading}
              error={users.error}
              empty={(users.data ?? []).length === 0}
              emptyText="No staff activity recorded for this period."
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">User</TableHead>
                      <TableHead scope="col" className="text-right">
                        Orders Created
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Order Value
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Till Payments Received
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Till Amount Received
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(users.data ?? []).map((u) => (
                      <TableRow key={u.user_id}>
                        <TableCell className="font-medium">{staffLabel(u)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {execNumber(u.orders_created_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {money(u.orders_created_value)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {execNumber(u.till_payments_received_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {money(u.till_payments_received_value)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Orders created and till payments received are two separate measures and are not
                combined into a single &ldquo;sales by user&rdquo; figure. Orders created can read
                zero where POS orders were saved without a recorded creator.
              </p>
            </SectionState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Top items</CardTitle>
          </CardHeader>
          <CardContent>
            <SectionState
              loading={topItems.isLoading}
              error={topItems.error}
              empty={(topItems.data ?? []).length === 0}
              emptyText="No items sold in this period."
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Item</TableHead>
                      <TableHead scope="col" className="text-right">
                        Quantity
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Operational Amount
                      </TableHead>
                      <TableHead scope="col" className="text-right">
                        Orders
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(topItems.data ?? []).map((i, idx) => (
                      <TableRow key={`${i.menu_item_id ?? "x"}-${i.item_name}-${idx}`}>
                        <TableCell className="font-medium">{i.item_name}</TableCell>
                        <TableCell className="text-right font-mono">
                          {execNumber(i.total_quantity)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {money(i.total_amount)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {execNumber(i.order_count)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Item names are the historical names recorded at the time of sale.
              </p>
            </SectionState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
