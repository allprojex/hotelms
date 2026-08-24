import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandMark } from "@/components/brand-mark";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useState } from "react";
import { Search, CalendarDays, Users, MapPin, Sparkles } from "lucide-react";

// Static SSR/pre-hydration fallback only — kept brand-name-neutral (no
// tenant name hardcoded) since no property is known at this stage of the
// booking flow; the live header below resolves the real organisation name
// via useBrandSettings(). Mirrors the auth.tsx login page's precedent for
// a property-agnostic surface.
export const Route = createFileRoute("/book/")({
  head: () => ({
    meta: [
      { title: "Book direct" },
      { name: "description", content: "Reserve rooms directly and unlock our best available rate." },
      { property: "og:title", content: "Book direct" },
      { property: "og:description", content: "Best rate guaranteed on direct bookings." },
    ],
  }),
  component: BookIndex,
});

function BookIndex() {
  const navigate = useNavigate();
  // No property is selected yet at this stage — organisation-wide branding
  // only, exactly like the login page (src/routes/auth.tsx).
  const { data: brand } = useBrandSettings();
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [propertyId, setPropertyId] = useState<string>("");
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(tomorrow);
  const [guests, setGuests] = useState(2);

  const properties = useQuery({
    queryKey: ["public-properties"],
    queryFn: async () => {
      const { data, error } = await supabase.from("properties").select("id,name,slug,address,currency").eq("is_public", true).eq("active", true).order("name");
      if (error) throw error;
      return data;
    },
  });

  const canSearch = propertyId && checkIn && checkOut && checkOut > checkIn;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/book" className="flex items-center gap-2">
            <BrandMark className="h-7 w-auto" />
            <div>
              <div className="font-display text-sm font-semibold">{brand?.app_name || "ThesKwoff Hotel"}</div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Direct Booking</div>
            </div>
          </Link>
          <Link to="/book/manage" className="text-sm text-primary hover:underline">Manage booking</Link>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 py-12 md:py-20">
        <div className="text-center space-y-3 mb-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="h-3 w-3" /> Best rate guaranteed
          </div>
          <h1 className="font-display text-4xl md:text-5xl font-semibold tracking-tight">Book your stay directly</h1>
          <p className="text-muted-foreground max-w-xl mx-auto">Skip the OTA fees. Confirm instantly, manage anytime with your booking code.</p>
        </div>

        <Card className="shadow-lg border-primary/10">
          <CardContent className="p-6">
            <div className="grid gap-4 md:grid-cols-[1.5fr_1fr_1fr_1fr_auto]">
              <div>
                <Label className="text-xs flex items-center gap-1"><MapPin className="h-3 w-3" /> Property</Label>
                <select className="mt-1 flex h-10 w-full rounded-md border bg-background px-3 text-sm" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                  <option value="">Select a hotel…</option>
                  {properties.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs flex items-center gap-1"><CalendarDays className="h-3 w-3" /> Check-in</Label>
                <Input type="date" value={checkIn} min={today} onChange={(e) => setCheckIn(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs flex items-center gap-1"><CalendarDays className="h-3 w-3" /> Check-out</Label>
                <Input type="date" value={checkOut} min={checkIn} onChange={(e) => setCheckOut(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs flex items-center gap-1"><Users className="h-3 w-3" /> Guests</Label>
                <Input type="number" min={1} max={10} value={guests} onChange={(e) => setGuests(Number(e.target.value))} className="mt-1" />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full md:w-auto"
                  disabled={!canSearch}
                  onClick={() => navigate({ to: "/book/results", search: { propertyId, checkIn, checkOut, guests } })}
                >
                  <Search className="h-4 w-4 mr-1" /> Search
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="mt-12 grid gap-4 md:grid-cols-3 text-sm">
          {[
            { title: "Instant confirmation", desc: "No waiting for the OTA to relay your booking." },
            { title: "Flexible modifications", desc: "Change dates or cancel in one click." },
            { title: "Direct guest perks", desc: "Priority upgrades and welcome amenities." },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border bg-card/60 p-4">
              <div className="font-medium">{f.title}</div>
              <div className="text-muted-foreground text-xs mt-1">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
