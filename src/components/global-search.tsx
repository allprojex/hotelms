import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import {
  matchesSearch,
  reservationSearchText,
  guestSearchText,
  roomSearchText,
} from "@/lib/search-filter";

interface ReservationSearchRow {
  id: string;
  code: string;
  guests: { first_name: string | null; last_name: string | null; email: string | null } | null;
  room_types: { name: string | null } | null;
  rooms: { number: string | null } | null;
}

interface GuestSearchRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

interface RoomSearchRow {
  id: string;
  number: string;
  room_types: { name: string | null } | null;
}

// Global "quick jump" search, mounted once in TopBar (so it's reachable from
// every authenticated page via the button or Ctrl/Cmd+K) rather than living
// inside the Dashboard page's own content. Self-contained: reads the active
// property itself via useActiveProperty() (the same hook/events TopBar's own
// property switcher already dispatches), so switching property elsewhere
// automatically rescopes results here too. Reuses the exact same
// property-scoped queries (and queryKeys, so the cache is shared) already
// used by reservations.index.tsx / guests.index.tsx / rooms.index.tsx — no
// new backend/search service, no broadened data access. Rooms have no
// per-room detail route in this app, so room results link to the rooms list
// rather than a fabricated detail page.
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const propertyId = useActiveProperty();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reservations = useQuery({
    queryKey: ["reservations", propertyId, "all"],
    enabled: open && !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservations")
        .select(
          "id, code, check_in, status, guests(first_name,last_name,email), room_types(name), rooms(number)",
        )
        .eq("property_id", propertyId!)
        .order("check_in", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as unknown as ReservationSearchRow[];
    },
  });

  const guests = useQuery({
    queryKey: ["guests", propertyId],
    enabled: open && !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("guests")
        .select("*")
        .eq("property_id", propertyId!)
        .order("last_name")
        .limit(500);
      if (error) throw error;
      return data as unknown as GuestSearchRow[];
    },
  });

  const rooms = useQuery({
    queryKey: ["rooms", propertyId],
    enabled: open && !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("*, room_types(name)")
        .eq("property_id", propertyId!)
        .order("number");
      if (error) throw error;
      return data as unknown as RoomSearchRow[];
    },
  });

  const loading = reservations.isLoading || guests.isLoading || rooms.isLoading;

  const matchedReservations = (reservations.data ?? [])
    .filter((r) => matchesSearch(reservationSearchText(r), q))
    .slice(0, 8);
  const matchedGuests = (guests.data ?? [])
    .filter((g) => matchesSearch(guestSearchText(g), q))
    .slice(0, 8);
  const matchedRooms = (rooms.data ?? [])
    .filter((r) => matchesSearch(roomSearchText(r), q))
    .slice(0, 8);
  const hasResults =
    matchedReservations.length > 0 || matchedGuests.length > 0 || matchedRooms.length > 0;

  const close = () => {
    setOpen(false);
    setQ("");
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground sm:hidden"
        onClick={() => setOpen(true)}
        aria-label="Search"
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        className="hidden gap-2 text-muted-foreground sm:inline-flex"
        onClick={() => setOpen(true)}
      >
        <Search className="h-4 w-4" />
        Search
        <kbd className="ml-2 hidden pointer-events-none select-none items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium md:inline-flex">
          Ctrl K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Search reservations, guests, rooms…"
          value={q}
          onValueChange={setQ}
        />
        <CommandList>
          {!propertyId && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Select a property first.
            </div>
          )}
          {propertyId && !loading && !hasResults && (
            <CommandEmpty>No results for “{q}”.</CommandEmpty>
          )}
          {propertyId && loading && (
            <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
          )}
          {matchedReservations.length > 0 && (
            <CommandGroup heading="Reservations">
              {matchedReservations.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${reservationSearchText(r)} ${r.id}`}
                  onSelect={() => {
                    close();
                    navigate({ to: "/reservations/$id", params: { id: r.id } });
                  }}
                >
                  {r.guests?.first_name} {r.guests?.last_name} — {r.code}
                  {r.rooms?.number ? ` · Room ${r.rooms.number}` : ""}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {matchedGuests.length > 0 && (
            <CommandGroup heading="Guests">
              {matchedGuests.map((g) => (
                <CommandItem
                  key={g.id}
                  value={`${guestSearchText(g)} ${g.id}`}
                  onSelect={() => {
                    close();
                    navigate({ to: "/guests/$id", params: { id: g.id } });
                  }}
                >
                  {g.first_name} {g.last_name}
                  {g.phone ? ` · ${g.phone}` : ""}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {matchedRooms.length > 0 && (
            <CommandGroup heading="Rooms">
              {matchedRooms.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${roomSearchText(r)} ${r.id}`}
                  onSelect={() => {
                    close();
                    navigate({ to: "/rooms" });
                  }}
                >
                  Room {r.number} {r.room_types?.name ? `· ${r.room_types.name}` : ""}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
