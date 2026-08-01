import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { ExpenseReportsTab } from "@/components/accounting/expense-reports-tab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Download, BarChart3 } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";

export const Route = createFileRoute("/_authenticated/accounting/reports")({
  head: () => ({ meta: [{ title: "Financial Reports · Accounting" }] }),
  component: ReportsPage,
});

function toCSV(rows: string[][]) {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}
function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
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
              <Button variant="outline" size="sm" onClick={() => download(`pl-${from}-${to}.csv`,
                toCSV([["Code", "Account", "Type", "Amount"], ...(pl.data ?? []).map((r: any) => [r.code, r.name, r.type, fmt(Number(r.amount))])]))}>
                <Download className="h-3 w-3 mr-1" /> CSV
              </Button>
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
              <Button variant="outline" size="sm" onClick={() => download(`bs-${to}.csv`,
                toCSV([["Code", "Account", "Type", "Balance"], ...(bs.data ?? []).map((r: any) => [r.code, r.name, r.type, fmt(Number(r.balance))])]))}>
                <Download className="h-3 w-3 mr-1" /> CSV
              </Button>
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
              <Button variant="outline" size="sm" onClick={() => download(`tb-${from}-${to}.csv`,
                toCSV([["Code", "Account", "Type", "Debit", "Credit"], ...(tb.data ?? []).map((r: any) => [r.code, r.name, r.type, fmt(Number(r.debit_total)), fmt(Number(r.credit_total))])]))}>
                <Download className="h-3 w-3 mr-1" /> CSV
              </Button>
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
