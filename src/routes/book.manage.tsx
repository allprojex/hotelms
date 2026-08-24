import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/brand-mark";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

// Static SSR/pre-hydration fallback only — kept neutral; this page can
// service a lookup for any property (no property is known until a
// confirmation-code + email lookup succeeds), so the live header below
// resolves the booked property's name once found, falling back to
// organisation branding until then.
export const Route = createFileRoute("/book/manage")({
  head: () => ({ meta: [{ title: "Manage booking" }] }),
  validateSearch: (s) => z.object({ code: z.string().optional(), email: z.string().optional() }).parse(s),
  component: Manage,
});

function Manage() {
  const initial = Route.useSearch();
  const qc = useQueryClient();
  // Organisation-wide fallback until a lookup resolves a specific booking's
  // property (see booking.data?.property_name below).
  const { data: brand } = useBrandSettings();
  const [code, setCode] = useState(initial.code ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [submitted, setSubmitted] = useState(!!(initial.code && initial.email));

  const booking = useQuery({
    queryKey: ["manage-lookup", code, email],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("booking_lookup", { _confirmation_code: code, _email: email });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Booking not found. Check your code and email.");
      return row;
    },
    enabled: submitted,
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ check_in: "", check_out: "", adults: 1, children: 0 });

  const modifyMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("booking_modify", {
        _confirmation_code: code, _email: email,
        _check_in: edit.check_in, _check_out: edit.check_out,
        _adults: edit.adults, _children: edit.children,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Booking updated");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["manage-lookup", code, email] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelMut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("booking_cancel", { _confirmation_code: code, _email: email });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Booking cancelled");
      qc.invalidateQueries({ queryKey: ["manage-lookup", code, email] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/book" className="flex items-center gap-2">
            <BrandMark className="h-7 w-auto" />
            <span className="font-display font-semibold text-sm">
              {booking.data?.property_name || brand?.app_name || "ThesKwoff Hotel"}
            </span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-4 py-10">
        <Card>
          <CardHeader><CardTitle>Manage your booking</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Confirmation code</Label><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="BK-XXXXXXXX" /></div>
              <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            </div>
            <Button onClick={() => setSubmitted(true)} disabled={!code || !email}>Look up</Button>

            {booking.error && <div className="text-sm text-destructive">{(booking.error as Error).message}</div>}
            {booking.data && (
              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{booking.data.property_name}</div>
                    <div className="text-sm text-muted-foreground">{booking.data.room_type_name}</div>
                  </div>
                  <Badge variant="outline">{booking.data.status}</Badge>
                </div>
                <div className="text-sm grid grid-cols-2 gap-2">
                  <div><div className="text-xs text-muted-foreground">Check-in</div><div>{booking.data.check_in}</div></div>
                  <div><div className="text-xs text-muted-foreground">Check-out</div><div>{booking.data.check_out}</div></div>
                  <div><div className="text-xs text-muted-foreground">Guests</div><div>{booking.data.adults} adults · {booking.data.children} children</div></div>
                  <div><div className="text-xs text-muted-foreground">Total</div><div>{Number(booking.data.rate_total).toFixed(2)}</div></div>
                </div>

                {booking.data.status === "confirmed" && !editing && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setEdit({ check_in: booking.data.check_in, check_out: booking.data.check_out, adults: booking.data.adults, children: booking.data.children }); setEditing(true); }}>Modify</Button>
                    <Button size="sm" variant="destructive" onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}>Cancel booking</Button>
                  </div>
                )}

                {editing && (
                  <div className="border rounded-md p-3 space-y-3 bg-muted/20">
                    <div className="grid grid-cols-2 gap-3">
                      <div><Label>Check-in</Label><Input type="date" value={edit.check_in} onChange={(e) => setEdit({ ...edit, check_in: e.target.value })} /></div>
                      <div><Label>Check-out</Label><Input type="date" value={edit.check_out} onChange={(e) => setEdit({ ...edit, check_out: e.target.value })} /></div>
                      <div><Label>Adults</Label><Input type="number" min={1} value={edit.adults} onChange={(e) => setEdit({ ...edit, adults: Number(e.target.value) })} /></div>
                      <div><Label>Children</Label><Input type="number" min={0} value={edit.children} onChange={(e) => setEdit({ ...edit, children: Number(e.target.value) })} /></div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => modifyMut.mutate()} disabled={modifyMut.isPending}>Save changes</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
