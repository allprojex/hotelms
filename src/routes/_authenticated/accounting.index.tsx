/* eslint-disable @typescript-eslint/no-explicit-any -- Phase 6A tables await generated database types. */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { getAccountingOverview } from "@/lib/accounting/overview.functions";
import { formatMoney, EXPENSE_STATUS_LABELS } from "@/lib/accounting/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Wallet,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Lock,
  Receipt,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/")({
  head: () => ({ meta: [{ title: "Accounting · ThesKwoff Hotel" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <AccountingOverview />
    </AccountingWorkspaceShell>
  ),
});

function fmt(n: number, cur = "GHS") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: cur,
    maximumFractionDigits: 2,
  }).format(n);
}

function AccountingOverview() {
  const propertyId = useActiveProperty();
  const from = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const to = format(endOfMonth(new Date()), "yyyy-MM-dd");

  const pl = useQuery({
    queryKey: ["pl", propertyId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_profit_loss", {
        _property_id: propertyId!,
        _from: from,
        _to: to,
      });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const bs = useQuery({
    queryKey: ["bs", propertyId, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_balance_sheet", {
        _property_id: propertyId!,
        _as_of: to,
      });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const recent = useQuery({
    queryKey: ["recent-je", propertyId],
    queryFn: async () => {
      const { data } = await supabase
        .from("journal_entries")
        .select("id, entry_date, memo, source, currency")
        .eq("property_id", propertyId!)
        .order("entry_date", { ascending: false })
        .limit(6);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const overviewFn = useServerFn(getAccountingOverview);
  const expenseOverview = useQuery({
    queryKey: ["accounting-expense-overview", propertyId],
    queryFn: () => overviewFn({ data: { propertyId: propertyId! } }),
    enabled: !!propertyId,
  });

  const revenue = (pl.data ?? [])
    .filter((r: any) => r.type === "revenue")
    .reduce((s: number, r: any) => s + Number(r.amount), 0);
  const expense = (pl.data ?? [])
    .filter((r: any) => r.type === "expense")
    .reduce((s: number, r: any) => s + Number(r.amount), 0);
  const netIncome = revenue - expense;
  const cash = (bs.data ?? [])
    .filter((r: any) => r.type === "asset" && (r.code === "1000" || r.code === "1010"))
    .reduce((s: number, r: any) => s + Number(r.balance), 0);
  const ar = (bs.data ?? [])
    .filter((r: any) => r.code === "1200")
    .reduce((s: number, r: any) => s + Number(r.balance), 0);
  const ap = (bs.data ?? [])
    .filter((r: any) => r.code === "2000")
    .reduce((s: number, r: any) => s + Number(r.balance), 0);

  if (!propertyId)
    return <div className="p-6 text-muted-foreground">Select a property to view accounting.</div>;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-semibold flex items-center gap-2">
            <Wallet className="h-6 w-6" /> Accounting
          </h1>
          <p className="text-sm text-muted-foreground">
            Current month: {format(new Date(), "MMMM yyyy")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/accounting/journal">Journal</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/accounting/reports">Reports</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Revenue MTD"
          value={fmt(revenue)}
          icon={<ArrowUpRight className="h-4 w-4 text-emerald-500" />}
        />
        <StatCard
          label="Expenses MTD"
          value={fmt(expense)}
          icon={<ArrowDownRight className="h-4 w-4 text-destructive" />}
        />
        <StatCard
          label="Net Income"
          value={fmt(netIncome)}
          highlight={netIncome >= 0 ? "positive" : "negative"}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard label="Cash on hand" value={fmt(cash)} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Working Capital</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Accounts Receivable" value={fmt(ar)} />
            <Row label="Accounts Payable" value={fmt(ap)} />
            <Row label="Net" value={fmt(ar - ap)} bold />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">Recent Journal Entries</CardTitle>
            <Button asChild variant="ghost" size="sm" className="h-6 text-xs">
              <Link to="/accounting/journal">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {(recent.data ?? []).map((e: any) => (
              <div
                key={e.id}
                className="flex items-center justify-between border-b py-1.5 last:border-0"
              >
                <div className="min-w-0">
                  <div className="truncate">{e.memo ?? "(no memo)"}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.entry_date} · {e.source}
                  </div>
                </div>
                <span className="text-xs font-mono text-muted-foreground">{e.currency}</span>
              </div>
            ))}
            {(recent.data ?? []).length === 0 && (
              <div className="text-muted-foreground text-xs">No entries yet.</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <Lock className="h-4 w-4" /> Close of Day
          </CardTitle>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/accounting/night-audit">Night audit</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/accounting/periods">Manage periods</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Lock accounting periods to prevent further posting. Run the night audit to post pending
          transactions and reconcile occupancy and revenue for the business day.
        </CardContent>
      </Card>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-display font-semibold flex items-center gap-2">
            <Receipt className="h-5 w-5" /> Expenses
          </h2>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/accounting/approvals">Approvals</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/accounting/expenses">All expenses</Link>
            </Button>
          </div>
        </div>

        {expenseOverview.isLoading && (
          <p className="text-sm text-muted-foreground">Loading expense overview…</p>
        )}
        {expenseOverview.isError && (
          <p className="text-sm text-destructive">Could not load expense overview.</p>
        )}

        {expenseOverview.data && (
          <div className="space-y-4">
            {expenseOverview.data.openPeriod ? (
              <p className="text-xs text-muted-foreground">
                Open financial period:{" "}
                <span className="font-medium text-foreground">
                  {expenseOverview.data.openPeriod.name ?? expenseOverview.data.openPeriod.code}
                </span>{" "}
                ({expenseOverview.data.openPeriod.start_date} →{" "}
                {expenseOverview.data.openPeriod.end_date})
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No open financial period.{" "}
                <Link to="/accounting/periods" className="underline">
                  Open one
                </Link>
                .
              </p>
            )}

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="Draft" value={String(expenseOverview.data.counts.draft)} />
              <StatCard
                label="Submitted"
                value={String(expenseOverview.data.counts.submitted)}
                icon={<ShieldCheck className="h-4 w-4" />}
              />
              <StatCard
                label="Approved"
                value={String(expenseOverview.data.counts.approved)}
                highlight="positive"
              />
              <StatCard
                label="Rejected"
                value={String(expenseOverview.data.counts.rejected)}
                highlight={expenseOverview.data.counts.rejected > 0 ? "negative" : undefined}
              />
              <StatCard
                label="Missing receipts"
                value={String(expenseOverview.data.counts.missingReceipts)}
                icon={<AlertCircle className="h-4 w-4 text-amber-500" />}
              />
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Approved total (open period)</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-display font-semibold">
                {formatMoney(expenseOverview.data.approvedTotalForPeriod, "GHS")}
              </CardContent>
            </Card>

            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">By category</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  {expenseOverview.data.byCategory.slice(0, 8).map((row: any) => (
                    <Row
                      key={row.label}
                      label={row.label}
                      value={formatMoney(row.total, row.currency)}
                    />
                  ))}
                  {expenseOverview.data.byCategory.length === 0 && (
                    <p className="text-xs text-muted-foreground">No approved expenses yet.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">By cost centre</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  {expenseOverview.data.byCostCentre.slice(0, 8).map((row: any) => (
                    <Row
                      key={row.label}
                      label={row.label}
                      value={formatMoney(row.total, row.currency)}
                    />
                  ))}
                  {expenseOverview.data.byCostCentre.length === 0 && (
                    <p className="text-xs text-muted-foreground">No approved expenses yet.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Recent activity</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  {expenseOverview.data.recentActivity.map((row: any) => (
                    <div
                      key={row.id}
                      className="flex items-center justify-between border-b py-1 last:border-0"
                    >
                      <Link
                        to="/accounting/expenses/$expenseId"
                        params={{ expenseId: row.id }}
                        className="font-mono text-xs hover:underline"
                      >
                        {row.expense_number}
                      </Link>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {EXPENSE_STATUS_LABELS[row.status] ?? row.status}
                        </Badge>
                        <span className="font-mono text-xs">
                          {formatMoney(row.total_amount, row.currency)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {expenseOverview.data.recentActivity.length === 0 && (
                    <p className="text-xs text-muted-foreground">No activity yet.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-sm">Approval queue</CardTitle>
                  <Button asChild variant="ghost" size="sm" className="h-6 text-xs">
                    <Link to="/accounting/approvals">View all</Link>
                  </Button>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  {expenseOverview.data.approvalQueue.map((row: any) => (
                    <div
                      key={row.id}
                      className="flex items-center justify-between border-b py-1 last:border-0"
                    >
                      <span className="text-xs truncate">
                        {row.expense_number} · {row.creator?.full_name ?? "—"}
                      </span>
                      <span className="font-mono text-xs">
                        {formatMoney(row.total_amount, row.currency)}
                      </span>
                    </div>
                  ))}
                  {expenseOverview.data.approvalQueue.length === 0 && (
                    <p className="text-xs text-muted-foreground">Nothing awaiting approval.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  highlight,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  highlight?: "positive" | "negative";
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          {icon}
          {label}
        </div>
        <div
          className={`text-2xl font-display font-semibold mt-1 ${highlight === "negative" ? "text-destructive" : highlight === "positive" ? "text-emerald-600 dark:text-emerald-400" : ""}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between ${bold ? "font-semibold pt-1 border-t" : ""}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
