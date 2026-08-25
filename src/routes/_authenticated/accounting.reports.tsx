import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createClientOnlyFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { ExpenseReportsTab } from "@/components/accounting/expense-reports-tab";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Download, Printer, BarChart3 } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/reports")({
  head: () => ({ meta: [{ title: "Financial Reports · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <ReportsPage />
    </AccountingWorkspaceShell>
  ),
});

// jspdf/xlsx are browser-only and heavy -- load them only when an export is
// actually requested, exactly like ExpenseReportsTab's exportExpenseReport.
const exportFinancialReport = createClientOnlyFn(
  async (definition: ReportDefinition<any>, exportFormat: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, exportFormat);
  },
);

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ReportsPage() {
  const propertyId = useActiveProperty();
  const [from, setFrom] = useState(format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [to, setTo] = useState(format(endOfMonth(new Date()), "yyyy-MM-dd"));

  const tb = useQuery({
    queryKey: ["tb", propertyId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_trial_balance", { _property_id: propertyId!, _from: from, _to: to });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });
  const pl = useQuery({
    queryKey: ["pl-r", propertyId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_profit_loss", { _property_id: propertyId!, _from: from, _to: to });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });
  const bs = useQuery({
    queryKey: ["bs-r", propertyId, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("report_balance_sheet", { _property_id: propertyId!, _as_of: to });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  const plRev = (pl.data ?? []).filter((r: any) => r.type === "revenue");
  const plExp = (pl.data ?? []).filter((r: any) => r.type === "expense");
  const totalRev = plRev.reduce((s: number, r: any) => s + Number(r.amount), 0);
  const totalExp = plExp.reduce((s: number, r: any) => s + Number(r.amount), 0);

  const bsAssets = (bs.data ?? []).filter((r: any) => r.type === "asset");
  const bsLiab = (bs.data ?? []).filter((r: any) => r.type === "liability");
  const bsEq = (bs.data ?? []).filter((r: any) => r.type === "equity");
  const totalAssets = bsAssets.reduce((s: number, r: any) => s + Number(r.balance), 0);
  const totalLiab = bsLiab.reduce((s: number, r: any) => s + Number(r.balance), 0);
  const totalEq = bsEq.reduce((s: number, r: any) => s + Number(r.balance), 0);

  const tbDr = (tb.data ?? []).reduce((s: number, r: any) => s + Math.max(0, Number(r.balance)), 0);
  const tbCr = (tb.data ?? []).reduce((s: number, r: any) => s + Math.max(0, -Number(r.balance)), 0);

  // Each export uses the exact same query-driven array (pl.data / bs.data /
  // tb.data) the on-screen sections above are built from -- never a second,
  // independently-derived dataset that could drift from what's visible.
  const plDefinition: ReportDefinition<any> = {
    title: "Profit & Loss",
    slug: "profit-loss",
    dateRange: { from, to },
    columns: [
      { key: "code", label: "Code", value: (r: any) => r.code },
      { key: "account", label: "Account", value: (r: any) => r.name },
      { key: "type", label: "Type", value: (r: any) => r.type },
      { key: "amount", label: "Amount", value: (r: any) => fmt(Number(r.amount)) },
    ],
    rows: pl.data ?? [],
  };
  const bsDefinition: ReportDefinition<any> = {
    // Balance Sheet is a point-in-time report ("as of {to}"), not a range --
    // the "as of" date is folded into the title instead of a from/to pair
    // that would misleadingly render as a one-day range.
    title: `Balance Sheet · as of ${to}`,
    slug: "balance-sheet",
    columns: [
      { key: "code", label: "Code", value: (r: any) => r.code },
      { key: "account", label: "Account", value: (r: any) => r.name },
      { key: "type", label: "Type", value: (r: any) => r.type },
      { key: "balance", label: "Balance", value: (r: any) => fmt(Number(r.balance)) },
    ],
    rows: bs.data ?? [],
  };
  const tbDefinition: ReportDefinition<any> = {
    title: "Trial Balance",
    slug: "trial-balance",
    dateRange: { from, to },
    columns: [
      { key: "code", label: "Code", value: (r: any) => r.code },
      { key: "account", label: "Account", value: (r: any) => r.name },
      { key: "type", label: "Type", value: (r: any) => r.type },
      { key: "debit", label: "Debit", value: (r: any) => fmt(Number(r.debit_total)) },
      { key: "credit", label: "Credit", value: (r: any) => fmt(Number(r.credit_total)) },
      { key: "balance", label: "Balance", value: (r: any) => fmt(Number(r.balance)) },
    ],
    rows: tb.data ?? [],
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><BarChart3 className="h-6 w-6" /> Financial Reports</h1>
        <div className="flex items-center gap-2">
          <div><Label className="text-xs">From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8" /></div>
          <div><Label className="text-xs">To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8" /></div>
        </div>
      </div>

      <Tabs defaultValue="pl">
        <TabsList>
          <TabsTrigger value="pl">Profit & Loss</TabsTrigger>
          <TabsTrigger value="bs">Balance Sheet</TabsTrigger>
          <TabsTrigger value="tb">Trial Balance</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
        </TabsList>

        <TabsContent value="pl">
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">P&L · {from} → {to}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(plDefinition, "csv")}>
                  <Download className="h-3 w-3 mr-1" /> CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(plDefinition, "xlsx")}>
                  <Download className="h-3 w-3 mr-1" /> XLSX
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(plDefinition, "pdf")}>
                  <Download className="h-3 w-3 mr-1" /> PDF
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(plDefinition, "print")}>
                  <Printer className="h-3 w-3 mr-1" /> Print
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-sm space-y-4">
              <Section title="Revenue" rows={plRev} total={totalRev} />
              <Section title="Expenses" rows={plExp} total={totalExp} />
              <div className="flex justify-between font-semibold pt-2 border-t-2">
                <span>Net Income</span><span className={`font-mono ${totalRev - totalExp < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}>{fmt(totalRev - totalExp)}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bs">
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Balance Sheet · as of {to}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(bsDefinition, "csv")}>
                  <Download className="h-3 w-3 mr-1" /> CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(bsDefinition, "xlsx")}>
                  <Download className="h-3 w-3 mr-1" /> XLSX
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(bsDefinition, "pdf")}>
                  <Download className="h-3 w-3 mr-1" /> PDF
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(bsDefinition, "print")}>
                  <Printer className="h-3 w-3 mr-1" /> Print
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-sm grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <SectionBS title="Assets" rows={bsAssets} total={totalAssets} />
              </div>
              <div className="space-y-4">
                <SectionBS title="Liabilities" rows={bsLiab} total={totalLiab} />
                <SectionBS title="Equity" rows={bsEq} total={totalEq} />
                <div className="flex justify-between font-semibold pt-2 border-t-2">
                  <span>Total L + E</span><span className="font-mono">{fmt(totalLiab + totalEq)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tb">
          <Card>
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Trial Balance · {from} → {to}</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(tbDefinition, "csv")}>
                  <Download className="h-3 w-3 mr-1" /> CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(tbDefinition, "xlsx")}>
                  <Download className="h-3 w-3 mr-1" /> XLSX
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(tbDefinition, "pdf")}>
                  <Download className="h-3 w-3 mr-1" /> PDF
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportFinancialReport(tbDefinition, "print")}>
                  <Printer className="h-3 w-3 mr-1" /> Print
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="grid grid-cols-[80px_1fr_100px_100px_100px] gap-2 py-1 text-xs font-medium border-b">
                <span>Code</span><span>Account</span><span className="text-right">Debit</span><span className="text-right">Credit</span><span className="text-right">Balance</span>
              </div>
              {(tb.data ?? []).map((r: any) => (
                <div key={r.account_id} className="grid grid-cols-[80px_1fr_100px_100px_100px] gap-2 py-1 border-b last:border-0">
                  <span className="font-mono text-xs">{r.code}</span>
                  <span>{r.name}</span>
                  <span className="text-right font-mono">{fmt(Number(r.debit_total))}</span>
                  <span className="text-right font-mono">{fmt(Number(r.credit_total))}</span>
                  <span className="text-right font-mono">{fmt(Number(r.balance))}</span>
                </div>
              ))}
              <div className="grid grid-cols-[80px_1fr_100px_100px_100px] gap-2 py-2 font-semibold border-t-2">
                <span></span><span>Totals</span>
                <span className="text-right font-mono">{fmt(tbDr)}</span>
                <span className="text-right font-mono">{fmt(tbCr)}</span>
                <span className="text-right font-mono">{fmt(tbDr - tbCr)}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expenses">
          <ExpenseReportsTab propertyId={propertyId} from={from} to={to} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Section({ title, rows, total }: { title: string; rows: any[]; total: number }) {
  return (
    <div>
      <div className="font-medium mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.account_id} className="flex justify-between py-0.5">
          <span className="text-muted-foreground"><span className="font-mono text-xs">{r.code}</span> {r.name}</span>
          <span className="font-mono">{fmt(Number(r.amount))}</span>
        </div>
      ))}
      <div className="flex justify-between font-semibold pt-1 border-t mt-1">
        <span>Total {title}</span><span className="font-mono">{fmt(total)}</span>
      </div>
    </div>
  );
}

function SectionBS({ title, rows, total }: { title: string; rows: any[]; total: number }) {
  return (
    <div>
      <div className="font-medium mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.account_id} className="flex justify-between py-0.5">
          <span className="text-muted-foreground"><span className="font-mono text-xs">{r.code}</span> {r.name}</span>
          <span className="font-mono">{fmt(Number(r.balance))}</span>
        </div>
      ))}
      <div className="flex justify-between font-semibold pt-1 border-t mt-1">
        <span>Total {title}</span><span className="font-mono">{fmt(total)}</span>
      </div>
    </div>
  );
}
