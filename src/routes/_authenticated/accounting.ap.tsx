import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, Truck, Send, DollarSign } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";

export const Route = createFileRoute("/_authenticated/accounting/ap")({
  head: () => ({ meta: [{ title: "Accounts Payable · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <APPage />
    </AccountingWorkspaceShell>
  ),
});

type Line = { description: string; quantity: string; unit_price: string; tax_rate: string };
function fmt(n: number, c = "GHS") { return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n); }

function APPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [payFor, setPayFor] = useState<any | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"cash" | "card" | "bank_transfer">("bank_transfer");
  const [form, setForm] = useState({
    supplier_name: "", reference: "",
    bill_date: format(new Date(), "yyyy-MM-dd"),
    due_date: format(new Date(Date.now() + 30 * 86400e3), "yyyy-MM-dd"),
    currency: "GHS", notes: "",
  });
  const [lines, setLines] = useState<Line[]>([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);

  const bills = useQuery({
    queryKey: ["ap-bills", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ap_bills").select("*")
        .eq("property_id", propertyId!).order("bill_date", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const aging = useQuery({
    queryKey: ["ap-aging", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("ap_aging").select("*").eq("property_id", propertyId!);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const suppliers = useQuery({
    queryKey: ["suppliers-min", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("suppliers").select("id, name").eq("property_id", propertyId!).order("name");
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const create = useMutation({
    mutationFn: async () => {
      const valid = lines.filter((l) => l.description);
      if (valid.length === 0) throw new Error("Add at least one line");
      const sub = valid.reduce((s, l) => s + parseFloat(l.quantity) * parseFloat(l.unit_price), 0);
      const tax = valid.reduce((s, l) => s + parseFloat(l.quantity) * parseFloat(l.unit_price) * parseFloat(l.tax_rate) / 100, 0);
      const { data: bill, error } = await supabase.from("ap_bills").insert({
        property_id: propertyId!, ...form,
        subtotal: sub, tax, total: sub + tax, status: "draft",
      } as any).select().single();
      if (error) throw error;
      const { error: lerr } = await supabase.from("ap_bill_lines").insert(
        valid.map((l) => ({
          bill_id: bill.id, description: l.description,
          quantity: parseFloat(l.quantity), unit_price: parseFloat(l.unit_price), tax_rate: parseFloat(l.tax_rate),
        }))
      );
      if (lerr) throw lerr;
    },
    onSuccess: () => {
      toast.success("Bill created as draft");
      setOpen(false);
      setLines([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);
      qc.invalidateQueries({ queryKey: ["ap-bills", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const post = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_ap_bill", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Bill posted to ledger");
      qc.invalidateQueries({ queryKey: ["ap-bills", propertyId] });
      qc.invalidateQueries({ queryKey: ["ap-aging", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pay = useMutation({
    mutationFn: async () => {
      if (!payFor) return;
      const { error } = await supabase.from("ap_payments").insert({
        property_id: propertyId!, bill_id: payFor.id,
        amount: parseFloat(payAmount), method: payMethod,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Payment recorded");
      setPayFor(null); setPayAmount("");
      qc.invalidateQueries({ queryKey: ["ap-bills", propertyId] });
      qc.invalidateQueries({ queryKey: ["ap-aging", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
  const bucketTotals = buckets.map((b) => ({
    bucket: b,
    total: (aging.data ?? []).filter((r: any) => r.bucket === b).reduce((s: number, r: any) => s + Number(r.balance), 0),
  }));
  const outstanding = (aging.data ?? []).reduce((s: number, r: any) => s + Math.max(0, Number(r.balance)), 0);

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><Truck className="h-6 w-6" /> Accounts Payable</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New bill</Button></DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>New supplier bill</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Supplier</Label>
                  {(suppliers.data ?? []).length > 0 ? (
                    <Select value={form.supplier_name} onValueChange={(v) => setForm({ ...form, supplier_name: v })}>
                      <SelectTrigger><SelectValue placeholder="Select supplier…" /></SelectTrigger>
                      <SelectContent>{(suppliers.data ?? []).map((s: any) => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Input value={form.supplier_name} onChange={(e) => setForm({ ...form, supplier_name: e.target.value })} />
                  )}
                </div>
                <div><Label>Reference / Invoice #</Label><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></div>
                <div><Label>Bill date</Label><Input type="date" value={form.bill_date} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} /></div>
                <div><Label>Due date</Label><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
                <div><Label>Currency</Label><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
              </div>
              <div className="border rounded-md">
                <div className="grid grid-cols-[2fr_60px_100px_70px_32px] gap-2 p-2 text-xs font-medium bg-muted/50 border-b">
                  <div>Description</div><div>Qty</div><div>Price</div><div>Tax %</div><div></div>
                </div>
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[2fr_60px_100px_70px_32px] gap-2 p-2 border-b last:border-0">
                    <Input className="h-8" value={l.description} onChange={(e) => { const c=[...lines]; c[i].description=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.quantity} onChange={(e) => { const c=[...lines]; c[i].quantity=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.unit_price} onChange={(e) => { const c=[...lines]; c[i].unit_price=e.target.value; setLines(c); }} />
                    <Input className="h-8" type="number" value={l.tax_rate} onChange={(e) => { const c=[...lines]; c[i].tax_rate=e.target.value; setLines(c); }} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLines(lines.filter((_,j)=>j!==i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" className="h-7 m-2" onClick={() => setLines([...lines, { description: "", quantity: "1", unit_price: "0", tax_rate: "0" }])}>+ Line</Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>Create draft</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Outstanding</div><div className="text-lg font-semibold">{fmt(outstanding)}</div></CardContent></Card>
        {bucketTotals.map((b) => (
          <Card key={b.bucket}><CardContent className="p-3"><div className="text-xs text-muted-foreground capitalize">{b.bucket}</div><div className="text-lg font-mono">{fmt(b.total)}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Bills</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(bills.data ?? []).map((b: any) => {
            const balance = Number(b.total) - Number(b.amount_paid);
            return (
              <div key={b.id} className="flex items-center justify-between px-4 py-2 border-b last:border-0 hover:bg-muted/30">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground w-24">{b.code}</span>
                  <span className="truncate">{b.supplier_name}</span>
                  <Badge variant="outline" className="text-[10px] uppercase">{b.status}</Badge>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">Due {b.due_date}</span>
                  <span className="font-mono text-sm">{fmt(Number(b.total), b.currency)}</span>
                  {b.status === "draft" && (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => post.mutate(b.id)}><Send className="h-3 w-3 mr-1" /> Post</Button>
                  )}
                  {b.status === "open" && balance > 0 && (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => { setPayFor(b); setPayAmount(balance.toFixed(2)); }}><DollarSign className="h-3 w-3 mr-1" /> Pay</Button>
                  )}
                </div>
              </div>
            );
          })}
          {(bills.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No bills yet.</div>}
        </CardContent>
      </Card>

      <Dialog open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record payment · {payFor?.code}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Amount</Label><Input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></div>
            <div><Label>Method</Label>
              <Select value={payMethod} onValueChange={(v) => setPayMethod(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>Cancel</Button>
            <Button disabled={pay.isPending || !payAmount} onClick={() => pay.mutate()}>Record payment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
