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
import { LogIn, LogOut, XCircle, Plus, Printer, Undo2, Search, Package, RotateCcw, Wrench } from "lucide-react";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ACCOUNTING_ADMIN_ROLES } from "@/lib/accounting/permissions";
import { matchesSearch, menuItemSearchText, inventoryItemSearchText } from "@/lib/search-filter";

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

      <ItemDistributionSection reservation={r} />

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
              onPick={(item) => { setDesc(item.name); setAmount(item.price.toFixed(2)); }}
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
                <div className="flex-1 min-w-0">
                  <div className="truncate">{it.name}</div>
                  {(it.pos_outlets?.name || it.pos_menu_categories?.name) && (
                    <div className="text-xs text-muted-foreground truncate">
                      {[it.pos_outlets?.name, it.pos_menu_categories?.name].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
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

// Mirrors item_stock_write's own role set (front_desk/cashier/
// housekeeping_supervisor already have direct item_stock access today),
// broadened with housekeeping and storekeeper -- the staff who actually
// hand out or collect room consumables in this app's own role vocabulary.
// This is UI-side gating only (hides actions a user can't perform); the
// RPCs re-check the identical roles server-side, which is what's actually
// authoritative.
const ISSUE_RETURN_ROLES = [
  "super_admin", "hotel_owner", "general_manager", "front_desk",
  "housekeeping_supervisor", "housekeeping", "storekeeper",
] as const;
// Deliberately narrower and identical to stock_adjustments/apply_adjustment's
// own existing role set -- adjustments are a supervisory correction action
// in this codebase's established convention, not a front-line action.
const ADJUST_ROLES = ["super_admin", "hotel_owner", "general_manager", "housekeeping_supervisor"] as const;

// Computes how much of an 'issue' row is still outstanding (issued but not
// yet returned/written off), from the full distributions list already
// fetched for this reservation -- mirrors the exact formula the
// return/adjust RPCs compute authoritatively server-side under a row lock;
// this client-side copy is for display/gating only, never trusted as the
// real check.
function outstandingFor(issueRow: any, allRows: any[]): number {
  const related = allRows.filter((d) => d.related_distribution_id === issueRow.id);
  const deducted = related.filter((d) => d.action === "adjustment" && d.stock_direction === "deduct")
    .reduce((s, d) => s + Number(d.quantity), 0);
  const returned = related.filter((d) => d.action === "return").reduce((s, d) => s + Number(d.quantity), 0);
  const restoredOrWrittenOff = related
    .filter((d) => d.action === "adjustment" && (d.stock_direction === "restore" || d.stock_direction === "none"))
    .reduce((s, d) => s + Number(d.quantity), 0);
  return Number(issueRow.quantity) + deducted - returned - restoredOrWrittenOff;
}

// Placement note: the client's own wording says "Under New Reservations",
// but distribution is operationally a check-in-time activity (you can't
// hand a guest room items before they've checked in) and there is no
// separate Check-In page in this app -- check-in is a status transition on
// this same reservation detail page. This Card lives here, after Folio,
// gated the same way Check-out/Cancel already are (on r.status), so it
// sits alongside every other reservation-lifecycle action rather than
// living on the pre-stay New Reservation form where nothing could be
// issued yet anyway.
function ItemDistributionSection({ reservation: r }: { reservation: any }) {
  const qc = useQueryClient();
  const propertyId = r.property_id as string;
  const [issueOpen, setIssueOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<any>(null);
  const [adjustTarget, setAdjustTarget] = useState<any>(null);

  const canIssueReturn = useHasAnyRole([...ISSUE_RETURN_ROLES], propertyId);
  const canAdjust = useHasAnyRole([...ADJUST_ROLES], propertyId);

  const distributions = useQuery({
    queryKey: ["reservation-item-distributions", r.id],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("reservation_item_distributions")
        .select("*, inventory_items(name, sku), stock_locations(name)")
        .eq("reservation_id", r.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const actorIds = Array.from(new Set((distributions.data ?? []).map((d: any) => d.actor_id).filter(Boolean)));
  const actorProfiles = useQuery({
    queryKey: ["reservation-item-distribution-actors", actorIds.join(",")],
    enabled: actorIds.length > 0,
    queryFn: async () => (await supabase.from("profiles").select("id, full_name").in("id", actorIds)).data ?? [],
  });
  const actorName = (userId: string | null) =>
    (actorProfiles.data ?? []).find((p: any) => p.id === userId)?.full_name ?? "—";

  const rows = distributions.data ?? [];
  const issueRows = rows.filter((d) => d.action === "issue");

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["reservation-item-distributions", r.id] });
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Room Items</CardTitle>
        {r.status === "checked_in" && canIssueReturn.allowed && (
          <Button size="sm" onClick={() => setIssueOpen(true)}>
            <Package className="h-4 w-4 mr-1" /> Issue item
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">History</div>
          {rows.map((d: any) => {
            const outstanding = d.action === "issue" ? outstandingFor(d, rows) : null;
            return (
              <div key={d.id} className="flex items-center justify-between px-4 py-2 text-sm border-b last:border-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={d.action === "issue" ? "default" : d.action === "return" ? "secondary" : "outline"} className="text-[10px] uppercase">
                      {d.action}{d.action === "adjustment" && d.stock_direction ? ` · ${d.stock_direction}` : ""}
                    </Badge>
                    <span className="font-medium">{d.inventory_items?.name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground font-mono">{d.inventory_items?.sku}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {Number(d.quantity).toFixed(2)} · {d.stock_locations?.name ?? "—"} · {actorName(d.actor_id)} · {format(new Date(d.created_at), "PPp")}
                  </div>
                  {d.reason && <div className="text-xs text-muted-foreground mt-0.5">{d.reason}</div>}
                  {d.action === "issue" && outstanding !== null && (
                    <div className="text-xs mt-0.5">{outstanding > 0 ? `${outstanding.toFixed(2)} still out` : "Fully returned"}</div>
                  )}
                </div>
                {d.action === "issue" && outstanding !== null && outstanding > 0 && (
                  <div className="flex items-center gap-1 shrink-0">
                    {canIssueReturn.allowed && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setReturnTarget(d)}>
                        <RotateCcw className="h-3 w-3 mr-1" /> Return
                      </Button>
                    )}
                    {canAdjust.allowed && (
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setAdjustTarget(d)}>
                        <Wrench className="h-3 w-3 mr-1" /> Adjust
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No items issued yet.</div>}
        </div>
      </CardContent>

      <IssueItemDialog open={issueOpen} onOpenChange={setIssueOpen} reservationId={r.id} propertyId={propertyId} onDone={invalidate} />
      <ReturnItemDialog target={returnTarget} onOpenChange={(v) => !v && setReturnTarget(null)} outstanding={returnTarget ? outstandingFor(returnTarget, rows) : 0} onDone={invalidate} />
      <AdjustItemDialog target={adjustTarget} onOpenChange={(v) => !v && setAdjustTarget(null)} outstanding={adjustTarget ? outstandingFor(adjustTarget, rows) : 0} onDone={invalidate} />
    </Card>
  );
}

function IssueItemDialog({
  open, onOpenChange, reservationId, propertyId, onDone,
}: { open: boolean; onOpenChange: (v: boolean) => void; reservationId: string; propertyId: string; onDone: () => void }) {
  const [item, setItem] = useState<{ id: string; name: string; sku: string | null } | null>(null);
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  // Generated once per open dialog "session", not per click: every Issue
  // click while this same dialog stays open (a double-click that beats the
  // busy-state disable, a network-layer retry, a lost-response retry)
  // reuses this SAME id, so the server-side idempotency check collapses
  // them into one event. Only regenerated on close (reset()) -- a
  // deliberately reopened dialog is a genuinely new action and gets a
  // fresh id.
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  const locations = useQuery({
    queryKey: ["dist-locations", propertyId],
    enabled: open && !!propertyId,
    queryFn: async () => (await supabase.from("stock_locations").select("id, name").eq("property_id", propertyId).order("name")).data ?? [],
  });

  const available = useQuery({
    queryKey: ["dist-available", item?.id, locationId],
    enabled: !!item && !!locationId,
    queryFn: async () => {
      const { data } = await (supabase.from as any)("item_stock").select("quantity")
        .eq("item_id", item!.id).eq("location_id", locationId).maybeSingle();
      return data?.quantity != null ? Number(data.quantity) : 0;
    },
  });

  function reset() {
    setItem(null); setLocationId(""); setQuantity("1"); setNotes(""); setRequestId(crypto.randomUUID());
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Issue room item</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Item</Label>
            <ItemDistributionPicker propertyId={propertyId} onPick={setItem} />
            {item && <p className="text-xs text-muted-foreground mt-1">Selected: {item.name} {item.sku ? `(${item.sku})` : ""}</p>}
          </div>
          <div>
            <Label>Stock location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger><SelectValue placeholder="Select a location…" /></SelectTrigger>
              <SelectContent>
                {(locations.data ?? []).map((l: any) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {item && locationId && (
              <p className="text-xs text-muted-foreground mt-1">Available: {available.data ?? 0}</p>
            )}
          </div>
          <div><Label>Quantity</Label><Input type="number" min="0" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
          <div><Label>Notes (optional)</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button
            disabled={busy || !item || !locationId || Number(quantity) <= 0}
            onClick={async () => {
              setBusy(true);
              const { error } = await (supabase.rpc as any)("issue_reservation_item", {
                _reservation_id: reservationId, _inventory_item_id: item!.id, _location_id: locationId,
                _quantity: Number(quantity), _request_id: requestId, _notes: notes || null,
              });
              setBusy(false);
              if (error) return toast.error(error.message);
              toast.success("Item issued");
              onDone(); onOpenChange(false); reset();
            }}
          >
            {busy ? "Issuing…" : "Issue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Searchable picker over the property's active inventory catalog, mirroring
// ChargeItemPicker's exact Command/Popover shape above (including the same
// cmdk pitfall it already fixed once: shouldFilter={false} plus a
// human-searchable CommandItem.value built from the same text the pre-filter
// already used, never an opaque id alone -- an opaque value previously
// caused cmdk's own internal filtering to hide every result regardless of
// query, see PR #52.
function ItemDistributionPicker({
  propertyId,
  onPick,
}: {
  propertyId?: string;
  onPick: (item: { id: string; name: string; sku: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const items = useQuery({
    queryKey: ["item-distribution-picker", propertyId],
    enabled: open && !!propertyId,
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("inventory_items")
        .select("id, name, sku, unit, item_categories(name)")
        .eq("property_id", propertyId)
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const matched = (items.data ?? [])
    .filter((it: any) => matchesSearch(inventoryItemSearchText(it), query))
    .slice(0, 50);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-start font-normal text-muted-foreground">
          <Search className="h-3.5 w-3.5 mr-2" /> Search items by name, SKU, or category…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-72">
            {!propertyId && <div className="py-6 text-center text-sm text-muted-foreground">Loading property…</div>}
            {propertyId && items.isLoading && <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>}
            {propertyId && !items.isLoading && matched.length === 0 && <CommandEmpty>No items found.</CommandEmpty>}
            {matched.map((it: any) => (
              <CommandItem
                key={it.id}
                value={`${inventoryItemSearchText(it)} ${it.id}`}
                onSelect={() => { onPick({ id: it.id, name: it.name, sku: it.sku ?? null }); setOpen(false); setQuery(""); }}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate">{it.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {[it.sku, it.item_categories?.name].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ReturnItemDialog({
  target, onOpenChange, outstanding, onDone,
}: { target: any; onOpenChange: (v: boolean) => void; outstanding: number; onDone: () => void }) {
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  // Same one-id-per-open-session lifecycle as IssueItemDialog's requestId.
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  return (
    <Dialog open={!!target} onOpenChange={(v) => { onOpenChange(v); if (!v) { setQuantity(""); setNotes(""); setRequestId(crypto.randomUUID()); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Return item</DialogTitle></DialogHeader>
        {target && (
          <div className="space-y-3">
            <p className="text-sm">{target.inventory_items?.name} — outstanding: {outstanding.toFixed(2)}</p>
            <div><Label>Quantity to return</Label><Input type="number" min="0" step="0.001" max={outstanding} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
            <div><Label>Notes (optional)</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={busy || !target || Number(quantity) <= 0 || Number(quantity) > outstanding}
            onClick={async () => {
              setBusy(true);
              const { error } = await (supabase.rpc as any)("return_reservation_item", {
                _distribution_id: target.id, _quantity: Number(quantity), _request_id: requestId, _notes: notes || null,
              });
              setBusy(false);
              if (error) return toast.error(error.message);
              toast.success("Item returned");
              onDone(); onOpenChange(false); setQuantity(""); setNotes(""); setRequestId(crypto.randomUUID());
            }}
          >
            {busy ? "Returning…" : "Return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustItemDialog({
  target, onOpenChange, outstanding, onDone,
}: { target: any; onOpenChange: (v: boolean) => void; outstanding: number; onDone: () => void }) {
  const [quantity, setQuantity] = useState("");
  const [direction, setDirection] = useState<"restore" | "deduct" | "none">("none");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Same one-id-per-open-session lifecycle as IssueItemDialog's requestId.
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());

  return (
    <Dialog open={!!target} onOpenChange={(v) => { onOpenChange(v); if (!v) { setQuantity(""); setReason(""); setDirection("none"); setRequestId(crypto.randomUUID()); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Adjust distribution</DialogTitle></DialogHeader>
        {target && (
          <div className="space-y-3">
            <p className="text-sm">{target.inventory_items?.name} — outstanding: {outstanding.toFixed(2)}</p>
            <div>
              <Label>Type</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Damaged / lost (no stock returned)</SelectItem>
                  <SelectItem value="restore">Correction — less was actually issued (stock restored)</SelectItem>
                  <SelectItem value="deduct">Correction — more was actually issued (stock deducted further)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Quantity</Label><Input type="number" min="0" step="0.001" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
            <div><Label>Reason (required)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being adjusted?" /></div>
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={busy || !target || Number(quantity) <= 0 || reason.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              const { error } = await (supabase.rpc as any)("adjust_reservation_item_distribution", {
                _distribution_id: target.id, _quantity: Number(quantity), _stock_direction: direction, _reason: reason.trim(), _request_id: requestId,
              });
              setBusy(false);
              if (error) return toast.error(error.message);
              toast.success("Adjustment recorded");
              onDone(); onOpenChange(false); setQuantity(""); setReason(""); setDirection("none"); setRequestId(crypto.randomUUID());
            }}
          >
            {busy ? "Saving…" : "Save adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
