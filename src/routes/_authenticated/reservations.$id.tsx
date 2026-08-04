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
import { format } from "date-fns";
import { toast } from "sonner";
import { LogIn, LogOut, XCircle, Plus, Printer } from "lucide-react";

export const Route = createFileRoute("/_authenticated/reservations/$id")({
  head: () => ({ meta: [{ title: "Reservation" }] }),
  component: ReservationDetail,
});

function ReservationDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();

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
  const totalPaid = (payments.data ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
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
            <AddCharge reservationId={id} onDone={() => qc.invalidateQueries({ queryKey: ["charges", id] })} />
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
                  <div className="capitalize">{p.method.replace("_", " ")}</div>
                  <div className="text-xs text-muted-foreground">{format(new Date(p.received_at), "PPp")} {p.reference ? `· ${p.reference}` : ""}</div>
                </div>
                <div className="font-medium">-{Number(p.amount).toFixed(2)}</div>
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

function AddCharge({ reservationId, onDone }: { reservationId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Plus className="h-4 w-4 mr-1" /> Charge</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Post a charge</DialogTitle></DialogHeader>
        <div className="space-y-3">
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
