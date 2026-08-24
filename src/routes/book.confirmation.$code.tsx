import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { CheckCircle2, Copy } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

// Static SSR/pre-hydration fallback only — kept neutral; the live header
// below resolves the actual booked property's name from the same
// booking_lookup row rendered in the "Hotel" details field further down,
// so the two can never disagree once the lookup resolves.
export const Route = createFileRoute("/book/confirmation/$code")({
  head: () => ({ meta: [{ title: "Booking confirmed" }] }),
  validateSearch: (s) => z.object({ email: z.string().email() }).parse(s),
  component: Confirmation,
});

function Confirmation() {
  const { code } = Route.useParams();
  const { email } = Route.useSearch();
  // Organisation-wide fallback until the booking lookup below resolves the
  // actual booked property.
  const { data: brand } = useBrandSettings();

  const booking = useQuery({
    queryKey: ["booking-lookup", code, email],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("booking_lookup", { _confirmation_code: code, _email: email });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
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

      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <CardContent className="p-8 text-center space-y-6">
            <CheckCircle2 className="mx-auto h-14 w-14 text-primary" />
            <div>
              <h1 className="font-display text-2xl font-semibold">Booking confirmed</h1>
              <p className="text-sm text-muted-foreground mt-1">A confirmation record has been created. Save your code below.</p>
            </div>
            <div className="mx-auto max-w-sm rounded-lg border bg-muted/30 p-4">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Confirmation code</div>
              <div className="flex items-center justify-center gap-2 mt-1">
                <div className="font-mono text-2xl font-semibold tracking-wider">{code}</div>
                <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(code); toast.success("Copied"); }}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {booking.data && (
              <div className="text-sm space-y-1 text-left mx-auto max-w-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Guest</span><span>{booking.data.guest_first_name} {booking.data.guest_last_name}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Hotel</span><span>{booking.data.property_name}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Room</span><span>{booking.data.room_type_name}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Stay</span><span>{booking.data.check_in} → {booking.data.check_out}</span></div>
                <div className="flex justify-between border-t pt-2 mt-2 font-medium"><span>Total</span><span>{Number(booking.data.rate_total).toFixed(2)}</span></div>
              </div>
            )}
            <div className="flex gap-2 justify-center">
              <Button asChild variant="outline"><Link to="/book">New search</Link></Button>
              <Button asChild><Link to="/book/manage" search={{ code, email }}>Manage booking</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
