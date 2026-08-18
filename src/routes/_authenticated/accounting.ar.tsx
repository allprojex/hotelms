import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { createArReceipt } from "@/lib/accounting/ar-receipts.functions";
import { createArInvoice, listArCustomers } from "@/lib/accounting/ar-customers.functions";
import { ArCustomerManager } from "@/components/accounting/ar-customer-manager";
import { ArHistoricalInvoiceMapping } from "@/components/accounting/ar-historical-invoice-mapping";
import { renderAdminPdf } from "@/lib/admin/pdf.functions";
import { downloadServerPdf } from "@/lib/admin/pdf-docs";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2, FileText, Send, DollarSign, Receipt as ReceiptIcon, Users, Link2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountingWorkspaceShell } from "@/components/accounting/accounting-workspace-nav";
import { formatMoney, isValidCurrencyCode, requireValidCurrencyCode } from "@/lib/accounting/domain";

export const Route = createFileRoute("/_authenticated/accounting/ar")({
  head: () => ({ meta: [{ title: "Accounts Receivable · Accounting" }] }),
  component: () => (
    <AccountingWorkspaceShell>
      <ARPage />
    </AccountingWorkspaceShell>
  ),
});

type Line = { description: string; quantity: string; unit_price: string; tax_rate: string };

function ARPage() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const createReceiptFn = useServerFn(createArReceipt);
  const createInvoiceFn = useServerFn(createArInvoice);
  const listCustomersFn = useServerFn(listArCustomers);
  const renderPdf = useServerFn(renderAdminPdf);
  const [open, setOpen] = useState(false);
  const [customersOpen, setCustomersOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [payMethod, setPayMethod] = useState<"cash" | "card" | "bank_transfer">("bank_transfer");
  const [payReference, setPayReference] = useState("");
  const [payDate, setPayDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [payAllocations, setPayAllocations] = useState<Record<string, string>>({});
  const [payIdempotencyKey, setPayIdempotencyKey] = useState("");
  const [reverseTarget, setReverseTarget] = useState<any>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [form, setForm] = useState({
    bill_to_name: "", bill_to_email: "", bill_to_address: "",
    issue_date: format(new Date(), "yyyy-MM-dd"),
    due_date: format(new Date(Date.now() + 30 * 86400e3), "yyyy-MM-dd"),
    currency: "GHS", notes: "",
  });
  const [lines, setLines] = useState<Line[]>([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);

  const customers = useQuery({
    queryKey: ["ar-customers", propertyId, "active"],
    queryFn: () => listCustomersFn({ data: { propertyId: propertyId! } }),
    enabled: !!propertyId,
  });

  function selectCustomer(id: string) {
    setCustomerId(id);
    const customer = (customers.data ?? []).find((row: any) => row.id === id) as any;
    setForm((current) => ({ ...current, bill_to_name: customer?.name ?? "", bill_to_email: customer?.email ?? "", bill_to_address: customer?.address ?? "" }));
  }

  const invoices = useQuery({
    queryKey: ["ar-invoices", propertyId],
    queryFn: async () => {
      const { data, error } = await supabase.from("ar_invoices").select("*")
        .eq("property_id", propertyId!).order("issue_date", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const aging = useQuery({
    queryKey: ["ar-aging", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("ar_aging").select("*").eq("property_id", propertyId!);
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  const receipts = useQuery({
    queryKey: ["ar-receipts", propertyId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("ar_receipts").select("*")
        .eq("property_id", propertyId!).order("receipt_date", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!propertyId,
  });

  async function printReceipt(id: string) {
    try {
      await downloadServerPdf(renderPdf, "receipt", id, propertyId!);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to render receipt");
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const valid = lines.filter((l) => l.description && parseFloat(l.unit_price) >= 0);
      if (valid.length === 0) throw new Error("Add at least one line");
      if (!customerId) throw new Error("Select an AR customer");
      return createInvoiceFn({ data: {
        propertyId: propertyId!, customerId, issueDate: form.issue_date, dueDate: form.due_date,
        currency: requireValidCurrencyCode(form.currency), notes: form.notes,
        lines: valid.map((line) => ({ description: line.description, quantity: parseFloat(line.quantity), unit_price: parseFloat(line.unit_price), tax_rate: parseFloat(line.tax_rate) })),
      } });
    },
    onSuccess: () => {
      toast.success("Invoice created as draft");
      setOpen(false);
      setCustomerId("");
      setForm((current) => ({ ...current, bill_to_name: "", bill_to_email: "", bill_to_address: "", notes: "" }));
      setLines([{ description: "", quantity: "1", unit_price: "0", tax_rate: "0" }]);
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const post = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("post_ar_invoice", { _id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invoice posted to ledger");
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
      qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverse = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("reverse_ar_invoice", { _id: id, _reason: reason });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invoice reversed — a new offsetting journal entry was posted");
      setReverseTarget(null);
      setReverseReason("");
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
      qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const eligibleInvoices = (invoices.data ?? []).filter(
    (i: any) => i.status === "sent" && Number(i.total) - Number(i.amount_paid) > 0,
  );

  function openReceivePayment() {
    setPayAllocations({});
    setPayReference("");
    setPayDate(format(new Date(), "yyyy-MM-dd"));
    setPayIdempotencyKey(crypto.randomUUID());
    setPayOpen(true);
  }

  function toggleInvoice(inv: any, checked: boolean) {
    setPayAllocations((prev) => {
      const next = { ...prev };
      if (checked) {
        const remaining = Number(inv.total) - Number(inv.amount_paid);
        next[inv.id] = remaining.toFixed(2);
      } else {
        delete next[inv.id];
      }
      return next;
    });
  }

  const receiveTotal = Object.values(payAllocations).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const receiveOverAllocated = eligibleInvoices.some((inv: any) => {
    const amt = parseFloat(payAllocations[inv.id] ?? "");
    if (!(amt > 0)) return false;
    return amt > Number(inv.total) - Number(inv.amount_paid) + 0.0001;
  });

  const receive = useMutation({
    mutationFn: async () => {
      const allocations = Object.entries(payAllocations)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([invoiceId, amt]) => ({ invoiceId, amount: parseFloat(amt) }));
      if (allocations.length === 0) throw new Error("Select at least one invoice and enter an amount");
      return createReceiptFn({
        data: {
          propertyId: propertyId!,
          receiptDate: payDate,
          method: payMethod,
          reference: payReference,
          idempotencyKey: payIdempotencyKey,
          allocations,
        },
      });
    },
    onSuccess: (receipt: any) => {
      toast.success(`Receipt ${receipt.code} posted for ${formatMoney(Number(receipt.amount), receipt.currency)}`);
      setPayOpen(false);
      setPayAllocations({});
      qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] });
      qc.invalidateQueries({ queryKey: ["ar-aging", propertyId] });
      qc.invalidateQueries({ queryKey: ["ar-receipts", propertyId] });
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
        <h1 className="text-2xl font-display font-semibold flex items-center gap-2"><FileText className="h-6 w-6" /> Accounts Receivable</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setCustomersOpen(true)}><Users className="h-4 w-4 mr-1" /> AR customers</Button>
          <Button size="sm" variant="outline" onClick={() => setMappingOpen(true)}><Link2 className="h-4 w-4 mr-1" /> Map historical invoices</Button>
          <Button size="sm" variant="outline" disabled={eligibleInvoices.length === 0} onClick={openReceivePayment}>
            <DollarSign className="h-4 w-4 mr-1" /> Receive payment
          </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> New invoice</Button></DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>New AR invoice</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>AR customer</Label>
                <Select value={customerId} onValueChange={selectCustomer}>
                  <SelectTrigger><SelectValue placeholder="Select a customer account" /></SelectTrigger>
                  <SelectContent>{(customers.data ?? []).map((customer: any) => <SelectItem key={customer.id} value={customer.id}>{customer.account_code} · {customer.name}</SelectItem>)}</SelectContent>
                </Select>
                {(customers.data ?? []).length === 0 && <p className="text-xs text-muted-foreground mt-1">Create an AR customer account before creating an invoice.</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Bill-to snapshot</Label><Input readOnly value={form.bill_to_name} /></div>
                <div><Label>Email snapshot</Label><Input readOnly value={form.bill_to_email} /></div>
                <div><Label>Issue date</Label><Input type="date" value={form.issue_date} onChange={(e) => setForm({ ...form, issue_date: e.target.value })} /></div>
                <div><Label>Due date</Label><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
                <div><Label>Currency</Label><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></div>
              </div>
              <div><Label>Address snapshot</Label><Textarea readOnly rows={2} value={form.bill_to_address} /></div>
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
              <Button disabled={create.isPending || !customerId} onClick={() => create.mutate()}>Create draft</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Card><CardContent className="p-3"><div className="text-xs text-muted-foreground">Outstanding</div><div className="text-lg font-semibold">{formatMoney(outstanding)}</div></CardContent></Card>
        {bucketTotals.map((b) => (
          <Card key={b.bucket}><CardContent className="p-3"><div className="text-xs text-muted-foreground capitalize">{b.bucket}</div><div className="text-lg font-mono">{formatMoney(b.total)}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Invoices</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(invoices.data ?? []).map((i: any) => (
            <div key={i.id} className="flex items-center justify-between px-4 py-2 border-b last:border-0 hover:bg-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-xs text-muted-foreground w-24">{i.code}</span>
                <span className="truncate">{i.bill_to_name}</span>
                <Badge variant="outline" className="text-[10px] uppercase">{i.status}</Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Due {i.due_date}</span>
                <span className="font-mono text-sm" title={!isValidCurrencyCode(i.currency) ? `Stored currency '${i.currency ?? ""}' is invalid; showing GHS` : undefined}>{formatMoney(Number(i.total), i.currency)}</span>
                {i.status === "draft" && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => post.mutate(i.id)}>
                    <Send className="h-3 w-3 mr-1" /> Post
                  </Button>
                )}
                {i.status === "sent" && Number(i.amount_paid) === 0 && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => { setReverseReason(""); setReverseTarget(i); }}>
                    <Undo2 className="h-3 w-3 mr-1" /> Void
                  </Button>
                )}
              </div>
            </div>
          ))}
          {(invoices.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No invoices yet.</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3"><CardTitle className="text-sm">Receipts</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(receipts.data ?? []).map((r: any) => (
            <div key={r.id} className="flex items-center justify-between px-4 py-2 border-b last:border-0 hover:bg-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-xs text-muted-foreground w-24">{r.code}</span>
                <span className="text-xs text-muted-foreground">{r.receipt_date}</span>
                <Badge variant="outline" className="text-[10px] uppercase">{r.method}</Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm" title={!isValidCurrencyCode(r.currency) ? `Stored currency '${r.currency ?? ""}' is invalid; showing GHS` : undefined}>{formatMoney(Number(r.amount), r.currency)}</span>
                <Button size="sm" variant="ghost" className="h-7" title="Print receipt" onClick={() => printReceipt(r.id)}>
                  <ReceiptIcon className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {(receipts.data ?? []).length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No receipts yet.</div>}
        </CardContent>
      </Card>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Receive payment</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div><Label>Receipt date</Label><Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></div>
              <div>
                <Label>Method</Label>
                <Select value={payMethod} onValueChange={(v) => setPayMethod(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Reference</Label><Input value={payReference} onChange={(e) => setPayReference(e.target.value)} /></div>
            </div>

            <div className="border rounded-md max-h-72 overflow-y-auto">
              <div className="grid grid-cols-[24px_1fr_90px_110px] gap-2 p-2 text-xs font-medium bg-muted/50 border-b sticky top-0">
                <div></div><div>Invoice</div><div>Balance</div><div>Apply</div>
              </div>
              {eligibleInvoices.map((inv: any) => {
                const remaining = Number(inv.total) - Number(inv.amount_paid);
                const checked = inv.id in payAllocations;
                return (
                  <div key={inv.id} className="grid grid-cols-[24px_1fr_90px_110px] gap-2 p-2 border-b last:border-0 items-center">
                    <Checkbox checked={checked} onCheckedChange={(c) => toggleInvoice(inv, !!c)} />
                    <div className="min-w-0 truncate text-xs">
                      <span className="font-mono text-muted-foreground mr-1">{inv.code}</span>{inv.bill_to_name}
                    </div>
                    <div className="text-xs font-mono">{formatMoney(remaining, inv.currency)}</div>
                    <Input
                      className="h-8"
                      type="number"
                      disabled={!checked}
                      value={payAllocations[inv.id] ?? ""}
                      onChange={(e) => setPayAllocations((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                    />
                  </div>
                );
              })}
              {eligibleInvoices.length === 0 && (
                <div className="p-4 text-center text-sm text-muted-foreground">No invoices are eligible for payment.</div>
              )}
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Receipt total</span>
              <span className="font-mono font-semibold">{formatMoney(receiveTotal)}</span>
            </div>
            {receiveOverAllocated && (
              <div className="text-xs text-destructive">One or more amounts exceed the invoice's remaining balance.</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button disabled={receive.isPending || receiveTotal <= 0 || receiveOverAllocated} onClick={() => receive.mutate()}>
              <DollarSign className="h-4 w-4 mr-1" /> Post receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!reverseTarget} onOpenChange={(v) => { if (!v) setReverseTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Void / reverse invoice</DialogTitle></DialogHeader>
          {reverseTarget && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Invoice</span><div className="font-mono">{reverseTarget.code}</div></div>
                <div><span className="text-muted-foreground">Customer</span><div className="truncate">{reverseTarget.bill_to_name}</div></div>
                <div><span className="text-muted-foreground">Total</span><div className="font-mono">{formatMoney(Number(reverseTarget.total), reverseTarget.currency)}</div></div>
                <div><span className="text-muted-foreground">Currency</span><div>{reverseTarget.currency}</div></div>
              </div>
              <p className="text-xs text-destructive">
                This posts a new offsetting journal entry that exactly reverses the original posting and sets the invoice to void. The original journal entry is never edited or deleted. This cannot be undone through the UI.
              </p>
              <div>
                <Label>Reason (required, 5–500 characters)</Label>
                <Textarea rows={3} maxLength={500} value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="Why is this invoice being reversed?" />
                <p className="text-xs text-muted-foreground mt-1">{reverseReason.trim().length}/500</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={reverse.isPending || reverseReason.trim().length < 5}
              onClick={() => reverseTarget && reverse.mutate({ id: reverseTarget.id, reason: reverseReason.trim() })}
            >
              <Undo2 className="h-4 w-4 mr-1" /> Reverse invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ArCustomerManager propertyId={propertyId} open={customersOpen} onOpenChange={setCustomersOpen} onChanged={() => qc.invalidateQueries({ queryKey: ["ar-customers", propertyId] })} />
      <ArHistoricalInvoiceMapping
        propertyId={propertyId}
        open={mappingOpen}
        onOpenChange={setMappingOpen}
        onMapped={() => qc.invalidateQueries({ queryKey: ["ar-invoices", propertyId] })}
      />
    </div>
  );
}
