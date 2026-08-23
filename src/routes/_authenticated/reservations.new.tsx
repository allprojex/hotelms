import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { differenceInCalendarDays } from "date-fns";
import { toast } from "sonner";
import { RoomTypeGalleryStrip } from "@/components/gallery/room-type-gallery-preview";

export const Route = createFileRoute("/_authenticated/reservations/new")({
  head: () => ({ meta: [{ title: "New reservation" }] }),
  component: NewReservation,
});

function NewReservation() {
  const propertyId = useActiveProperty();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(tomorrow);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [roomTypeId, setRoomTypeId] = useState<string>("");
  const [source, setSource] = useState("direct");
  const [notes, setNotes] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  const roomTypes = useQuery({
    queryKey: ["room-types", propertyId],
    enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("room_types").select("*").eq("property_id", propertyId!).order("base_rate");
      if (error) throw error;
      return data;
    },
  });

  const nights = useMemo(() => Math.max(1, differenceInCalendarDays(new Date(checkOut), new Date(checkIn))), [checkIn, checkOut]);
  const selectedType = roomTypes.data?.find((rt) => rt.id === roomTypeId);
  const rateTotal = selectedType ? Number(selectedType.base_rate) * nights : 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId || !roomTypeId) return;
    setSaving(true);
    try {
      const { data: user } = await supabase.auth.getUser();
      // Create guest
      const { data: guest, error: gErr } = await supabase.from("guests").insert({
        property_id: propertyId, first_name: firstName, last_name: lastName,
        email: email || null, phone: phone || null, created_by: user.user?.id,
      }).select().single();
      if (gErr) throw gErr;

      const { data: res, error: rErr } = await supabase.from("reservations").insert({
        property_id: propertyId, guest_id: guest.id, room_type_id: roomTypeId,
        code: "", // filled by trigger
        check_in: checkIn, check_out: checkOut, adults, children,
        source, notes: notes || null, rate_total: rateTotal, created_by: user.user?.id,
      }).select().single();
      if (rErr) throw rErr;

      // Post initial room charge
      await supabase.from("reservation_charges").insert({
        reservation_id: res.id, description: `Room charge · ${nights} night${nights > 1 ? "s" : ""} · ${selectedType?.name}`,
        amount: rateTotal, posted_by: user.user?.id,
      });

      toast.success(`Reservation ${res.code} created`);
      navigate({ to: "/reservations/$id", params: { id: res.id } });
    } catch (err: any) {
      toast.error(err.message);
    } finally { setSaving(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">New reservation</h1>
      <p className="text-sm text-muted-foreground mb-6">Create a booking or walk-in.</p>

      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Stay details</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Check-in"><Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required /></Field>
            <Field label="Check-out"><Input type="date" value={checkOut} min={checkIn} onChange={(e) => setCheckOut(e.target.value)} required /></Field>
            <Field label="Adults"><Input type="number" min={1} value={adults} onChange={(e) => setAdults(+e.target.value)} required /></Field>
            <Field label="Children"><Input type="number" min={0} value={children} onChange={(e) => setChildren(+e.target.value)} /></Field>
            <Field label="Room type">
              <Select value={roomTypeId} onValueChange={setRoomTypeId}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {roomTypes.data?.map((rt) => (
                    <SelectItem key={rt.id} value={rt.id}>{rt.name} — {Number(rt.base_rate).toFixed(2)}/night</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {roomTypeId && <RoomTypeGalleryStrip roomTypeId={roomTypeId} className="mt-2" />}
            </Field>
            <Field label="Source">
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">Direct</SelectItem>
                  <SelectItem value="walk_in">Walk-in</SelectItem>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="corporate">Corporate</SelectItem>
                  <SelectItem value="ota">OTA</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Guest</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="First name"><Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></Field>
            <Field label="Last name"><Input value={lastName} onChange={(e) => setLastName(e.target.value)} required /></Field>
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <div className="sm:col-span-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-[var(--shadow-elegant)]">
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Total ({nights} night{nights > 1 ? "s" : ""})</div>
              <div className="text-3xl font-semibold">{rateTotal.toFixed(2)}</div>
            </div>
            <Button type="submit" size="lg" disabled={saving || !roomTypeId}>{saving ? "Saving…" : "Create reservation"}</Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}
