import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/fx")({
  head: () => ({ meta: [{ title: "FX & Currencies · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <FxPage />
    </AccountingWorkspaceShell>
  ),
});

function FxPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();

  const property = useQuery({
    queryKey: ["property-full", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("properties").select("id, name, base_currency").eq("id", propertyId!).single();
      return data;
    },
    enabled: !!propertyId,
  });

  const currencies = useQuery({
    queryKey: ["currencies"],
    queryFn: async () => (await supabase.from("currencies").select("*").order("code")).data ?? [],
  });

  const rates = useQuery({
    queryKey: ["fx", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("fx_rates").select("*")
        .eq("property_id", propertyId!).order("as_of_date", { ascending: false }).limit(60);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const [form, setForm] = useState({ from_code: "EUR", to_code: "GHS", rate: "", as_of_date: format(new Date(), "yyyy-MM-dd") });

  const addRate = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fx_rates").insert({
        property_id: propertyId!,
        from_code: form.from_code, to_code: form.to_code,
        rate: parseFloat(form.rate), as_of_date: form.as_of_date,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rate saved");
      setForm({ ...form, rate: "" });
      qc.invalidateQueries({ queryKey: ["fx", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateBase = useMutation({
    mutationFn: async (code: string) => {
      const { error } = await supabase.from("properties").update({ base_currency: code }).eq("id", propertyId!);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Base currency updated");
      qc.invalidateQueries({ queryKey: ["property-full", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><TrendingUp className="h-6 w-6" /> FX & Currencies</h1>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Base reporting currency</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-3">
          <Select value={property.data?.base_currency ?? "GHS"} onValueChange={(v) => updateBase.mutate(v)}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(currencies.data ?? []).map((c: any) => (
                <SelectItem key={c.code} value={c.code}>{c.code} — {c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">All journal entries are converted to this currency for reporting.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Add exchange rate</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
            <div><Label className="text-xs">From</Label>
              <Select value={form.from_code} onValueChange={(v) => setForm({ ...form, from_code: v })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{(currencies.data ?? []).map((c: any) => <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">To</Label>
              <Select value={form.to_code} onValueChange={(v) => setForm({ ...form, to_code: v })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{(currencies.data ?? []).map((c: any) => <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Rate</Label><Input type="number" step="0.0001" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></div>
            <div><Label className="text-xs">As of</Label><Input type="date" value={form.as_of_date} onChange={(e) => setForm({ ...form, as_of_date: e.target.value })} /></div>
            <Button onClick={() => addRate.mutate()} disabled={!form.rate || form.from_code === form.to_code || addRate.isPending}>Add</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent rates</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <div className="grid grid-cols-4 gap-2 py-1 text-xs font-medium border-b">
            <span>Date</span><span>Pair</span><span className="text-right">Rate</span><span></span>
          </div>
          {(rates.data ?? []).map((r: any) => (
            <div key={r.id} className="grid grid-cols-4 gap-2 py-1.5 border-b last:border-0 items-center">
              <span className="font-mono text-xs">{r.as_of_date}</span>
              <span>{r.from_code} → {r.to_code}</span>
              <span className="text-right font-mono">{Number(r.rate).toFixed(6)}</span>
              <Badge variant="outline" className="justify-self-start text-[10px]">{Number(r.rate) === 1 ? "parity" : "manual"}</Badge>
            </div>
          ))}
          {(rates.data ?? []).length === 0 && <div className="text-muted-foreground text-xs py-3">No rates yet. Base currency conversion falls back to 1.0.</div>}
        </CardContent>
      </Card>
    </div>
  );
}
