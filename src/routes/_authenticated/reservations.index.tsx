import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Search, Calendar as CalendarIcon } from "lucide-react";
import { format } from "date-fns";

// DATE column, not a timestamp — always compare/send plain "yyyy-MM-dd"
// strings (from the Calendar's local-midnight Date objects via date-fns
// format(), never .toISOString()) so this can't drift a day across
// timezones the way a UTC round-trip would.
const toDateKey = (d: Date) => format(d, "yyyy-MM-dd");

export const Route = createFileRoute("/_authenticated/reservations/")({
  head: () => ({ meta: [{ title: "Reservations" }] }),
  component: ReservationsList,
});

const STATUS_COLORS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  confirmed: "secondary",
  checked_in: "default",
  checked_out: "outline",
  cancelled: "destructive",
  no_show: "destructive",
};

function ReservationsList() {
  const propertyId = useActiveProperty();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [checkInRange, setCheckInRange] = useState<DateRange | undefined>(undefined);
  const [dateOpen, setDateOpen] = useState(false);

  const checkInFrom = checkInRange?.from ? toDateKey(checkInRange.from) : null;
  const checkInTo = checkInRange?.to ? toDateKey(checkInRange.to) : checkInFrom;

  const query = useQuery({
    queryKey: ["reservations", propertyId, status, checkInFrom, checkInTo],
    enabled: !!propertyId,
    queryFn: async () => {
      let sel = supabase.from("reservations")
        .select("id, code, check_in, check_out, adults, children, status, rate_total, guests(first_name,last_name,email), room_types(name), rooms(number)")
        .eq("property_id", propertyId!)
        .order("check_in", { ascending: false })
        .limit(200);
      if (status !== "all") sel = sel.eq("status", status as any);
      // check_in is a DATE column — gte/lte against plain "yyyy-MM-dd"
      // strings compares dates directly, inclusive on both ends, with no
      // timezone interpretation. A single selected date (checkInFrom set,
      // no explicit "to") uses the same value for both bounds.
      if (checkInFrom) sel = sel.gte("check_in", checkInFrom);
      if (checkInTo) sel = sel.lte("check_in", checkInTo);
      const { data, error } = await sel;
      if (error) throw error;
      return data;
    },
  });

  const filtered = (query.data ?? []).filter((r: any) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return r.code.toLowerCase().includes(s)
      || `${r.guests?.first_name ?? ""} ${r.guests?.last_name ?? ""}`.toLowerCase().includes(s)
      || (r.guests?.email ?? "").toLowerCase().includes(s);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reservations</h1>
          <p className="text-sm text-muted-foreground">Manage stays, walk-ins and check-ins.</p>
        </div>
        <Button asChild><Link to="/reservations/new"><Plus className="h-4 w-4 mr-1" /> New reservation</Link></Button>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by code, guest name, email…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full sm:w-[220px] justify-start font-normal">
                <CalendarIcon className="h-4 w-4 mr-2 shrink-0" />
                {checkInRange?.from ? (
                  checkInRange.to && checkInTo !== checkInFrom ? (
                    <span className="truncate">{format(checkInRange.from, "MMM d")} – {format(checkInRange.to, "MMM d, yyyy")}</span>
                  ) : (
                    <span className="truncate">{format(checkInRange.from, "MMM d, yyyy")}</span>
                  )
                ) : (
                  <span className="truncate text-muted-foreground">Check-in date</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={checkInRange}
                onSelect={setCheckInRange}
                numberOfMonths={1}
                defaultMonth={checkInRange?.from}
              />
              <div className="flex items-center justify-end gap-2 border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!checkInRange?.from}
                  onClick={() => { setCheckInRange(undefined); setDateOpen(false); }}
                >
                  Clear
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="checked_in">Checked in</SelectItem>
              <SelectItem value="checked_out">Checked out</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="no_show">No-show</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Guest</TableHead>
              <TableHead>Room</TableHead>
              <TableHead>Check-in</TableHead>
              <TableHead>Check-out</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r: any) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => (window.location.href = `/reservations/${r.id}`)}>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell>
                  <div className="font-medium">{r.guests?.first_name} {r.guests?.last_name}</div>
                  <div className="text-xs text-muted-foreground">{r.guests?.email}</div>
                </TableCell>
                <TableCell>
                  <div>{r.room_types?.name}</div>
                  <div className="text-xs text-muted-foreground">{r.rooms?.number ? `Room ${r.rooms.number}` : "Unassigned"}</div>
                </TableCell>
                <TableCell>{format(new Date(r.check_in), "MMM d, yyyy")}</TableCell>
                <TableCell>{format(new Date(r.check_out), "MMM d, yyyy")}</TableCell>
                <TableCell><Badge variant={STATUS_COLORS[r.status]}>{r.status.replace("_", " ")}</Badge></TableCell>
                <TableCell className="text-right font-medium">{Number(r.rate_total).toFixed(2)}</TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No reservations found.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
