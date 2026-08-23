import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/brand-mark";
import { ArrowLeft, BedDouble, Users, Sparkles, ImageOff } from "lucide-react";
import { z } from "zod";
import { useMemo } from "react";
import { useRoomTypeCoverImages } from "@/components/gallery/room-type-gallery-preview";

const searchSchema = z.object({
  propertyId: z.string().uuid(),
  checkIn: z.string(),
  checkOut: z.string(),
  guests: z.coerce.number().min(1).max(10).default(1),
});

export const Route = createFileRoute("/book/results")({
  head: () => ({ meta: [{ title: "Available rooms — ThesKwoff Hotel" }] }),
  validateSearch: (s) => searchSchema.parse(s),
  component: BookResults,
});

function BookResults() {
  const { propertyId, checkIn, checkOut, guests } = Route.useSearch();
  const navigate = useNavigate();

  const property = useQuery({
    queryKey: ["public-prop", propertyId],
    queryFn: async () => {
      const { data } = await supabase.from("properties").select("id,name,address,currency").eq("id", propertyId).single();
      return data;
    },
  });

  const nights = Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000));

  const availability = useQuery({
    queryKey: ["availability", propertyId, checkIn, checkOut, guests],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("booking_search_availability", {
        _property_id: propertyId, _check_in: checkIn, _check_out: checkOut, _guests: guests,
      });
      if (error) throw error;
      return data;
    },
  });

  const roomTypeIds = useMemo(
    () => (availability.data ?? []).map((rt) => rt.room_type_id as string),
    [availability.data],
  );
  const covers = useRoomTypeCoverImages(roomTypeIds);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b bg-card/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/book" className="flex items-center gap-2">
            <BrandMark className="h-7 w-auto" />
            <span className="font-display font-semibold text-sm">ThesKwoff Hotel</span>
          </Link>
          <Link to="/book/manage" className="text-sm text-primary hover:underline">Manage booking</Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm"><Link to="/book"><ArrowLeft className="h-4 w-4 mr-1" /> New search</Link></Button>
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">{property.data?.name ?? "Hotel"}</h1>
          <p className="text-sm text-muted-foreground">
            {checkIn} → {checkOut} · {nights} night{nights > 1 ? "s" : ""} · {guests} guest{guests > 1 ? "s" : ""}
          </p>
        </div>

        {availability.isLoading && <div className="text-muted-foreground text-sm">Searching availability…</div>}
        {availability.error && <div className="text-destructive text-sm">{(availability.error as Error).message}</div>}
        {availability.data?.length === 0 && (
          <Card><CardContent className="p-8 text-center space-y-2">
            <div className="text-lg font-medium">No rooms available</div>
            <p className="text-sm text-muted-foreground">Try different dates or fewer guests.</p>
          </CardContent></Card>
        )}

        <div className="space-y-4">
          {availability.data?.map((rt) => {
            const total = Number(rt.best_rate) * nights;
            return (
              <Card key={rt.room_type_id} className="overflow-hidden">
                <div className="grid md:grid-cols-[140px_1fr_auto]">
                  <div className="hidden md:block h-full min-h-[140px] bg-muted">
                    {covers.data?.get(rt.room_type_id) ? (
                      <img
                        src={covers.data.get(rt.room_type_id)!}
                        alt={rt.room_type_name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-muted-foreground">
                        <ImageOff className="h-6 w-6" />
                      </div>
                    )}
                  </div>
                  <CardContent className="p-6 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="font-display text-lg font-semibold flex items-center gap-2"><BedDouble className="h-5 w-5 text-primary" /> {rt.room_type_name}</h3>
                        {rt.description && <p className="text-sm text-muted-foreground mt-1">{rt.description}</p>}
                      </div>
                      <Badge variant="outline">{rt.available_rooms} left</Badge>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><Users className="h-3 w-3" /> Up to {rt.max_occupancy}</span>
                      {Array.isArray(rt.amenities) && (rt.amenities as string[]).slice(0, 4).map((a) => (
                        <span key={String(a)} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1"><Sparkles className="h-3 w-3" /> {String(a)}</span>
                      ))}
                    </div>
                  </CardContent>
                  <div className="p-6 md:border-l md:min-w-[220px] flex flex-col justify-between bg-muted/20">
                    <div>
                      <div className="text-xs text-muted-foreground">From</div>
                      <div className="font-display text-2xl font-semibold">{property.data?.currency ?? "GHS"} {Number(rt.best_rate).toFixed(0)}</div>
                      <div className="text-xs text-muted-foreground">per night · Total {property.data?.currency ?? "GHS"} {total.toFixed(0)}</div>
                    </div>
                    <Button
                      className="mt-4"
                      onClick={() => navigate({ to: "/book/checkout/$roomTypeId", params: { roomTypeId: rt.room_type_id }, search: { propertyId, checkIn, checkOut, guests, rate: Number(rt.best_rate) } })}
                    >
                      Book now
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
