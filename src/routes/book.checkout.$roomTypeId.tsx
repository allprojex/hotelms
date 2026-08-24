import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BrandMark } from "@/components/brand-mark";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { useState } from "react";
import { RoomTypeGalleryStrip } from "@/components/gallery/room-type-gallery-preview";

const searchSchema = z.object({
  propertyId: z.string().uuid(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z.coerce.number().min(1).max(10),
  rate: z.coerce.number(),
});

// Static SSR/pre-hydration fallback only — kept neutral; the live header
// below resolves the actual selected property's name once its public
// properties row loads (falling back to organisation branding until then).
export const Route = createFileRoute("/book/checkout/$roomTypeId")({
  head: () => ({ meta: [{ title: "Checkout" }] }),
  validateSearch: (s) => searchSchema.parse(s),
  component: Checkout,
});

function Checkout() {
  const { roomTypeId } = Route.useParams();
  const { propertyId, checkIn, checkOut, guests, rate } = Route.useSearch();
  const navigate = useNavigate();
  // Organisation-wide fallback for the moment before the property row
  // (fetched below, scoped to this exact propertyId) has loaded.
  const { data: brand } = useBrandSettings();
  const nights = Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000));
  const total = rate * nights;

  const roomType = useQuery({
    queryKey: ["public-rt", roomTypeId],
    queryFn: async () => {
      const { data } = await supabase.from("room_types").select("id,name").eq("id", roomTypeId).single();
      return data;
    },
  });

  const property = useQuery({
    queryKey: ["public-prop", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("properties").select("id,name,currency").eq("id", propertyId).single();
      return data;
    },
  });

  const [form, setForm] = useState({ first_name: "", last_name: "", email: "", phone: "", address: "", notes: "", agree: false });

  const bookMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("booking_create", {
        _property_id: propertyId,
        _room_type_id: roomTypeId,
        _check_in: checkIn,
        _check_out: checkOut,
        _adults: guests,
        _children: 0,
        _first_name: form.first_name,
        _last_name: form.last_name,
        _email: form.email,
        _phone: form.phone.trim() || (null as unknown as string),
        _address: form.address.trim() || (null as unknown as string),
        _source: "direct",
        _external_ref: null as unknown as string,
        _notes: form.notes.trim() || (null as unknown as string),
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as { reservation_id: string; confirmation_code: string };
    },
    onSuccess: (r) => {
      navigate({ to: "/book/confirmation/$code", params: { code: r.confirmation_code }, search: { email: form.email } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const valid = form.first_name && form.last_name && form.email && form.agree;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/book" className="flex items-center gap-2">
            <BrandMark className="h-7 w-auto" />
            <span className="font-display font-semibold text-sm">
              {property.data?.name || brand?.app_name || "ThesKwoff Hotel"}
            </span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8">
        <Button asChild variant="ghost" size="sm" className="mb-4"><Link to="/book/results" search={{ propertyId, checkIn, checkOut, guests }}><ArrowLeft className="h-4 w-4 mr-1" /> Back to rooms</Link></Button>
        <div className="grid gap-6 md:grid-cols-[1.5fr_1fr]">
          <Card>
            <CardHeader><CardTitle>Guest details</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>First name *</Label><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></div>
                <div><Label>Last name *</Label><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Email *</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              </div>
              <div><Label>Address</Label><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
              <div><Label>Special requests</Label><Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={form.agree} onChange={(e) => setForm({ ...form, agree: e.target.checked })} />
                <span>I agree to the cancellation policy and terms of service. My confirmation code will be shown on the next page — keep it to manage this booking.</span>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div><div className="text-xs text-muted-foreground">Hotel</div><div className="font-medium">{property.data?.name}</div></div>
              <div><div className="text-xs text-muted-foreground">Room</div><div className="font-medium">{roomType.data?.name}</div></div>
              <RoomTypeGalleryStrip roomTypeId={roomTypeId} />
              <div className="grid grid-cols-2 gap-2">
                <div><div className="text-xs text-muted-foreground">Check-in</div><div>{checkIn}</div></div>
                <div><div className="text-xs text-muted-foreground">Check-out</div><div>{checkOut}</div></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><div className="text-xs text-muted-foreground">Nights</div><div>{nights}</div></div>
                <div><div className="text-xs text-muted-foreground">Guests</div><div>{guests}</div></div>
              </div>
              <div className="border-t pt-3 space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground"><span>{property.data?.currency ?? "GHS"} {rate.toFixed(0)} × {nights} nights</span><span>{property.data?.currency ?? "GHS"} {total.toFixed(2)}</span></div>
                <div className="flex justify-between font-display font-semibold text-lg"><span>Total</span><span>{property.data?.currency ?? "GHS"} {total.toFixed(2)}</span></div>
              </div>
              <Button className="w-full" disabled={!valid || bookMut.isPending} onClick={() => bookMut.mutate()}>
                {bookMut.isPending ? "Confirming…" : "Confirm booking"}
              </Button>
              <p className="text-[10px] text-muted-foreground text-center">Payment collected at property. No card charged now.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
