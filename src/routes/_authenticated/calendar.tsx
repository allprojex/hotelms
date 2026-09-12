import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { addDays, format, differenceInCalendarDays } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/calendar")({
  head: () => ({ meta: [{ title: "Availability calendar" }] }),
  component: CalendarPage,
});

const DAYS = 14;

function CalendarPage() {
  const propertyId = useActiveProperty();
  const [start, setStart] = useState(() => new Date());

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);

  const rooms = useQuery({
    queryKey: ["rooms-cal", propertyId],
    enabled: !!propertyId,
    queryFn: async () => (await supabase.from("rooms").select("id,number,room_types(name)").eq("property_id", propertyId!).order("number")).data,
  });

  const reservations = useQuery({
    queryKey: ["res-cal", propertyId, start.toISOString().slice(0, 10)],
    enabled: !!propertyId,
    queryFn: async () => {
      const endStr = addDays(start, DAYS).toISOString().slice(0, 10);
      const startStr = start.toISOString().slice(0, 10);
      const { data } = await supabase.from("reservations")
        .select("id,code,check_in,check_out,room_id,status,guests(first_name,last_name)")
        .eq("property_id", propertyId!)
        .not("room_id", "is", null)
        .in("status", ["confirmed", "checked_in"])
        .lt("check_in", endStr)
        .gt("check_out", startStr);
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Availability</h1>
          <p className="text-sm text-muted-foreground">14-day window · {format(start, "MMM d")} – {format(addDays(start, DAYS - 1), "dd/MM/yyyy")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setStart(addDays(start, -7))}><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => setStart(new Date())}>Today</Button>
          <Button variant="outline" size="sm" onClick={() => setStart(addDays(start, 7))}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <Card className="overflow-auto">
        <div className="min-w-max">
          <div className="grid sticky top-0 bg-card border-b" style={{ gridTemplateColumns: `160px repeat(${DAYS}, 60px)` }}>
            <div className="px-3 py-2 text-xs font-semibold uppercase text-muted-foreground border-r">Room</div>
            {days.map((d) => (
              <div key={d.toISOString()} className="px-1 py-2 text-center text-[10px] border-r last:border-r-0">
                <div className="text-muted-foreground">{format(d, "EEE")}</div>
                <div className="font-semibold">{format(d, "d")}</div>
              </div>
            ))}
          </div>
          {rooms.data?.map((room: any) => (
            <div key={room.id} className="grid border-b" style={{ gridTemplateColumns: `160px repeat(${DAYS}, 60px)` }}>
              <div className="px-3 py-3 border-r">
                <div className="font-medium text-sm">Room {room.number}</div>
                <div className="text-[10px] text-muted-foreground">{room.room_types?.name}</div>
              </div>
              <div className="col-span-full relative grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 60px)`, gridColumn: `2 / span ${DAYS}` }}>
                {days.map((d, i) => <div key={i} className="border-r last:border-r-0 h-14" />)}
                {(reservations.data ?? []).filter((r: any) => r.room_id === room.id).map((r: any) => {
                  const ci = new Date(r.check_in);
                  const co = new Date(r.check_out);
                  const startOffset = Math.max(0, differenceInCalendarDays(ci, start));
                  const endOffset = Math.min(DAYS, differenceInCalendarDays(co, start));
                  const width = endOffset - startOffset;
                  if (width <= 0) return null;
                  return (
                    <a key={r.id} href={`/reservations/${r.id}`}
                      className={`absolute top-1 bottom-1 rounded-md px-2 py-1 text-[11px] font-medium truncate cursor-pointer ${
                        r.status === "checked_in" ? "bg-primary text-primary-foreground" : "bg-primary/20 text-foreground border border-primary/40"
                      }`}
                      style={{ left: `${startOffset * 60 + 2}px`, width: `${width * 60 - 4}px` }}>
                      {r.guests?.first_name} {r.guests?.last_name}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
