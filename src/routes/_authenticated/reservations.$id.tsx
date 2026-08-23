import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { format } from "date-fns";
import { toast } from "sonner";
import { LogIn, LogOut, XCircle, Plus, Printer, Undo2, Search } from "lucide-react";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ACCOUNTING_ADMIN_ROLES } from "@/lib/accounting/permissions";
import { matchesSearch, menuItemSearchText } from "@/lib/search-filter";

export const Route = createFileRoute("/_authenticated/reservations/$id")({
  head: () => ({ meta: [{ title: "Reservation" }] }),
  component: ReservationDetail,
});

function ReservationDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [refundReason, setRefundReason] = useState("");

  const res = useQuery({
    queryKey: ["reservation", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("reservations")
        .select("*, guests(*), room_types(*), rooms(*), properties(name,currency)")
        .eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

  const charges = useQuery({
    queryKey: ["charges", id],
    queryFn: async () => (await supabase.from("reservation_charges").select("*").eq("reservation_id", id).order("posted_at")).data,
  });

  const payments = useQuery({
    queryKey: ["payments", id],
    queryFn: async () => (await supabase.from("payments").select("*").eq("reservation_id", id).order("received_at")).data,
  });

  const canRefund = useHasAnyRole([...ACCOUNTING_ADMIN_ROLES], res.data?.property_id ?? null);

  const refundedByIds = Array.from(
    new Set((payments.data ?? []).filter((p: any) => p.reversed_by).map((p: any) => p.reversed_by as string)),
  );
  const refundedByProfiles = useQuery({
    queryKey: ["refunded-by-profiles", refundedByIds.join(",")],
    enabled: refundedByIds.length > 0,
    queryFn: async () => (await supabase.from("profiles").select("id, full_name").in("id", refundedByIds)).data ?? [],
  });
  const refundedByName = (userId: string | null) =>
    (refundedByProfiles.data ?? []).find((p: any) => p.id === userId)?.full_name ?? null;

  const availableRooms = useQuery({
    queryKey: ["avail-rooms", res.data?.property_id, res.data?.room_type_id],
    enabled: !!res.data,
    queryFn: async () => {
      const { data } = await supabase.from("rooms")
        .select("id,number,status")
        .eq("property_id", res.data!.property_id).eq("room_type_id", res.data!.room_type_id)
        .neq("status", "out_of_order").order("number");
      return data;
    },
  });

  if (res.isLoading) return <div className="p-6">Loading…</div>;
  if (res.isError || !res.data) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-destructive">
          Couldn't load this reservation
          {res.error ? `: ${(res.error as Error).message}` : " — it may have been deleted."}
        </p>
        <Button variant="outline" onClick={() => navigate({ to: "/reservations" })}>
          Back to reservations
        </Button>
      </div>
    );
  }
  const r = res.data as any;

  const totalCharges = (charges.data ?? []).reduce((s: number, c: any) => s + Number(c.amount), 0);
  // Refunded (status='void') payments no longer count as cash received —
  // the original row is preserved (never deleted) but excluded from this
  // sum, matching every other place reservation payment totals feed
  // (dashboard.tsx, reports.tsx, insights.functions.ts, pdf.functions.ts —
  // all updated alongside this page in the same PR).
  const totalPaid = (payments.data ?? [])
    .filter((p: any) => p.status !== "void")
    .reduce((s: number, p: any) => s + Number(p.amount), 0);
  const balance = totalCharges - totalPaid;
  const currency = r.properties?.currency ?? "GHS";

  async function assignRoom(roomId: string) {
    const { error } = await supabase.from("reservations").update({ room_id: roomId }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Room assigned");
    qc.invalidateQueries({ queryKey: ["reservation", id] });
  }

  async function checkIn() {
    if (!r.room_id) return toast.error("Assign a room first");
    const { error } = await supabase.from("reservations").update({
      status: "checked_in", checked_in_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return toast.error(error.message);
    await supabase.from("rooms").update({ status: "occupied" }).eq("id", r.room_id);
    toast.success("Guest checked in");
    qc.invalidateQueries();
  }

  async function checkOut() {
    if (balance > 0.01) return toast.error(`Outstanding balance ${balance.toFixed(2)}. Record payment first.`);
    const { error } = await supabase.from("reservations").update({
      status: "checked_out", checked_out_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return toast.error(error.message);
    if (r.room_id) await supabase.from("rooms").update({ status: "available", housekeeping_status: "dirty" }).eq("id", r.room_id);

    // Generate invoice
    const invNumber = `INV-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;
    await supabase.from("invoices").insert({
      reservation_id: id, number: invNumber, subtotal: totalCharges, total: totalCharges, paid: totalPaid,
    });
    toast.success(`Checked out · ${invNumber}`);
    qc.invalidateQueries();
  }

  async function cancel() {
    if (!confirm("Cancel this reservation?")) return;
    await supabase.from("reservations").update({ status: "cancelled" }).eq("id", id);
    toast.success("Reservation cancelled");
    qc.invalidateQueries();
    navigate({ to: "/reservations" });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{r.guests?.first_name} {r.guests?.last_name}</h1>
            <Badge>{r.status.replace("_", " ")}</Badge>
          </div>
          <p className="text-sm text-muted-foreground font-mono">{r.code}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.status === "confirmed" && <Button onClick={checkIn}><LogIn className="h-4 w-4 mr-1" /> Check in</Button>}
          {r.status === "checked_in" && <Button onClick={checkOut}><LogOut className="h-4 w-4 mr-1" /> Check out</Button>}
          {r.status === "checked_out" && <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4 mr-1" /> Print invoice</Button>}
          {["confirmed", "checked_in"].includes(r.status) && <Button variant="outline" onClick={cancel}><XCircle className="h-4 w-4 mr-1" /> Cancel</Button>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Stay</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 text-sm">
            <Info label="Check-in" value={format(new Date(r.check_in), "EEE, MMM d, yyyy")} />
            <Info label="Check-out" value={format(new Date(r.check_out), "EEE, MMM d, yyyy")} />
            <Info label="Guests" value={`${r.adults} adult${r.adults > 1 ? "s" : ""}${r.children > 0 ? `, ${r.children} child` : ""}`} />
            <Info label="Room type" value={r.room_types?.name} />
            <div className="sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Assigned room</Label>
              <div className="mt-1 flex items-center gap-2">
                <Select value={r.room_id ?? ""} onValueChange={assignRoom}>
                  <SelectTrigger className="w-[220px]"><SelectValue placeholder="Assign a room…" /></SelectTrigger>
                  <SelectContent>
                    {availableRooms.data?.map((room) => (
                      <SelectItem key={room.id} value={room.id}>Room {room.number} ({room.status})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {r.notes && <div className="sm:col-span-2"><Info label="Notes" value={r.notes} /></div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Guest</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Info label="Email" value={r.guests?.email ?? "—"} />
            <Info label="Phone" value={r.guests?.phone ?? "—"} />
            <Info label="ID" value={r.guests?.id_number ?? "—"} />
            <Info label="Nationality" value={r.guests?.nationality ?? "—"} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Folio</CardTitle>
          <div className="flex gap-2">
            <AddCharge reservationId={id} propertyId={res.data?.property_id} onDone={() => qc.invalidateQueries({ queryKey: ["charges", id] })} />
            <AddPayment reservationId={id} balance={balance} onDone={() => qc.invalidateQueries({ queryKey: ["payments", id] })} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <div className="border-b px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">Charges</div>
            {(charges.data ?? []).map((c: any) => (
              <div key={c.id} className="flex items-center justify-between px-4 py-2 text-sm border-b last:border-0">
                <div>
                  <div>{c.description}</div>
                  <div className="text-xs text-muted-foreground">{format(new Date(c.posted_at), "PPp")}</div>
                </div>
                <div className="font-medium">{Number(c.amount).toFixed(2)}</div>
              </div>
            ))}
            {charges.data?.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No charges yet.</div>}
          </div>

          <div className="mt-4 rounded-lg border">
            <div className="border-b px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">Payments</div>
            {(payments.data ?? []).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2 text-sm border-b last:border-0">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="capitalize">{p.method.replace("_", " ")}</span>
                    {p.status === "void" && <Badge variant="secondary" className="text-[10px] uppercase">Refunded</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{format(new Date(p.received_at), "PPp")} {p.reference ? `· ${p.reference}` : ""}</div>
                  {p.status === "void" && (
                    <div className="text-[10px] text-destructive mt-0.5">
                      Refunded {p.reversed_at ? format(new Date(p.reversed_at), "PPp") : ""}
                      {refundedByName(p.reversed_by) ? ` by ${refundedByName(p.reversed_by)}` : ""}: {p.reversal_reason}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <div className={`font-medium ${p.status === "void" ? "line-through text-muted-foreground" : ""}`}>
                    -{Number(p.amount).toFixed(2)}
                  </div>
                  {p.status !== "void" && canRefund.allowed && (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => { setRefundReason(""); setRefundTarget(p); }}>
                      <Undo2 className="h-3 w-3 mr-1" /> Refund
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {payments.data?.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No payments yet.</div>}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4 text-right">
            <SummaryLine label="Charges" value={totalCharges} currency={currency} />
            <SummaryLine label="Paid" value={totalPaid} currency={currency} />
            <SummaryLine label="Balance" value={balance} currency={currency} highlight />
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!refundTarget} onOpenChange={(v) => { if (!v) setRefundTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Refund payment</DialogTitle></DialogHeader>
          {refundTarget && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Amount</span><div className="font-mono">{currency} {Number(refundTarget.amount).toFixed(2)}</div></div>
                <div><span className="text-muted-foreground">Method</span><div className="capitalize">{refundTarget.method.replace("_", " ")}</div></div>
                <div><span className="text-muted-foreground">Paid</span><div>{format(new Date(refundTarget.received_at), "PPp")}</div></div>
                {refundTarget.reference && <div><span className="text-muted-foreground">Reference</span><div className="truncate">{refundTarget.reference}</div></div>}
              </div>
              <p className="text-xs text-muted-foreground">
                This is a financial correction: the original payment is preserved and marked refunded — it is never deleted or edited. If this payment was posted to the accounting journal, an offsetting reversal entry is created. This cannot be undone through the UI.
              </p>
              <div>
                <Label>Reason</Label>
                <Textarea rows={3} maxLength={500} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Why is this payment being refunded?" />
                <p className="text-xs text-muted-foreground mt-1">{refundReason.trim().length}/500</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={refundReason.trim().length < 5 || refundReason.trim().length > 500}
              onClick={async () => {
                const { error } = await (supabase.rpc as any)("reverse_reservation_payment", {
                  _id: refundTarget.id, _reason: refundReason.trim(),
                });
                if (error) return toast.error(error.message);
                toast.success("Payment refunded");
                setRefundTarget(null);
                setRefundReason("");
                qc.invalidateQueries({ queryKey: ["payments", id] });
                qc.invalidateQueries({ queryKey: ["reservation", id] });
              }}
            >
              <Undo2 className="h-4 w-4 mr-1" /> Refund payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function SummaryLine({ label, value, currency, highlight }: { label: string; value: number; currency: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${highlight && value > 0.01 ? "text-destructive" : ""}`}>
        {currency} {value.toFixed(2)}
      </div>
    </div>
  );
}

function AddCharge({ reservationId, propertyId, onDone }: { reservationId: string; propertyId?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1" /> Charge</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Post a charge</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Search a product (optional)</Label>
            <ChargeItemPicker
              propertyId={propertyId}
              onPick={(item) => { setDesc(item.name); setAmount(String(item.price)); }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Picking a product fills in the description and amount below — you can still edit either before posting.
            </p>
          </div>
          <div><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          <div><Label>Amount</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button onClick={async () => {
            const { data: u } = await supabase.auth.getUser();
            const { error } = await supabase.from("reservation_charges").insert({
              reservation_id: reservationId, description: desc, amount: Number(amount), posted_by: u.user?.id,
            });
            if (error) return toast.error(error.message);
            toast.success("Charge posted"); onDone(); setOpen(false); setDesc(""); setAmount("");
          }}>Post</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Searchable picker over the property's existing sellable-item catalog
// (pos_menu_items — the same catalog POS Terminal/Menu already search).
// Deliberately does NOT create a new product/rate-item table: charges are
// simple copy-on-select (name -> description, price -> amount) into the
// existing reservation_charges columns, exactly like a manually-typed
// charge — no new source-link column, no live reference back to the
// catalog item. See the design note in the PR description for why a copy
// is safer than a link here (charge history must not retroactively change
// if a catalog price is edited later; reservation_charges has no existing
// source-tracking columns to begin with, and none of the reads of this
// table anywhere in the app expect one).
function ChargeItemPicker({
  propertyId,
  onPick,
}: {
  propertyId?: string;
  onPick: (item: { name: string; price: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const items = useQuery({
    queryKey: ["charge-item-picker", propertyId],
    enabled: open && !!propertyId,
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("pos_menu_items")
        .select("id, name, price, active, pos_menu_categories(name), pos_outlets(name)")
        .eq("property_id", propertyId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const matched = (items.data ?? [])
    .filter((it: any) => matchesSearch(menuItemSearchText(it), query))
    .slice(0, 50);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-start font-normal text-muted-foreground">
          <Search className="h-3.5 w-3.5 mr-2" /> Search products…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search by name or category…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-72">
            {!propertyId && <div className="py-6 text-center text-sm text-muted-foreground">Loading property…</div>}
            {propertyId && items.isLoading && <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>}
            {propertyId && !items.isLoading && matched.length === 0 && <CommandEmpty>No products found.</CommandEmpty>}
            {matched.map((it: any) => (
              <CommandItem
                key={it.id}
                value={`${menuItemSearchText(it)} ${it.id}`}
                onSelect={() => { onPick({ name: it.name, price: Number(it.price) }); setOpen(false); setQuery(""); }}
              >
                <span className="flex-1">{it.name}</span>
                {it.pos_menu_categories?.name && (
                  <span className="text-xs text-muted-foreground mr-2">{it.pos_menu_categories.name}</span>
                )}
                <span className="font-mono text-xs">{Number(it.price).toFixed(2)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AddPayment({ reservationId, balance, onDone }: { reservationId: string; balance: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState(balance > 0 ? balance.toFixed(2) : "");
  const [reference, setReference] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setAmount(balance > 0 ? balance.toFixed(2) : ""); }}>
      <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4 mr-1" /> Payment</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Record payment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="card">Card</SelectItem>
                <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                <SelectItem value="mobile_money">Mobile money</SelectItem>
                <SelectItem value="wallet">Digital wallet</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Amount</Label><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div><Label>Reference (optional)</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button onClick={async () => {
            const { data: u } = await supabase.auth.getUser();
            const { error } = await supabase.from("payments").insert({
              reservation_id: reservationId, method: method as any, amount: Number(amount),
              reference: reference || null, received_by: u.user?.id,
            });
            if (error) return toast.error(error.message);
            toast.success("Payment recorded"); onDone(); setOpen(false);
          }}>Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
