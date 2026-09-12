import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createClientOnlyFn } from "@tanstack/react-start";
import type { DateRange } from "react-day-picker";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import {
  DEFAULT_PAGE_SIZE,
  filterScopeKey,
  pageRange,
  scopedPage,
  totalPages as computeTotalPages,
  type ScopedPage,
} from "@/lib/query-state";
import type { ReportDefinition, ReportFormat } from "@/lib/reports/report-core";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Plus, Search, Calendar as CalendarIcon, Download, Printer } from "lucide-react";
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

type ReservationRow = {
  id: string;
  code: string;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  status: string;
  rate_total: number;
  guest_first_name: string;
  guest_last_name: string;
  guest_email: string | null;
  room_type_name: string;
  room_number: string | null;
};

// jspdf/xlsx are browser-only and heavy -- load them only when an export is
// actually requested, same pattern as ExpenseReportsTab/accounting.reports.
const exportReservationsReport = createClientOnlyFn(
  async (definition: ReportDefinition<ReservationRow>, exportFormat: ReportFormat) => {
    const { exportReport } = await import("@/lib/reports/report-export.client");
    return exportReport(definition, exportFormat);
  },
);

function reservationColumns(): readonly { key: string; label: string; value: (r: ReservationRow) => unknown }[] {
  return [
    { key: "code", label: "Reservation code", value: (r) => r.code },
    { key: "guest", label: "Guest", value: (r) => `${r.guest_first_name} ${r.guest_last_name}`.trim() },
    { key: "email", label: "Email", value: (r) => r.guest_email ?? "" },
    { key: "roomType", label: "Room type", value: (r) => r.room_type_name },
    { key: "room", label: "Room", value: (r) => r.room_number ?? "Unassigned" },
    { key: "checkIn", label: "Check-in", value: (r) => r.check_in },
    { key: "checkOut", label: "Check-out", value: (r) => r.check_out },
    { key: "status", label: "Status", value: (r) => r.status },
    { key: "adults", label: "Adults", value: (r) => r.adults },
    { key: "children", label: "Children", value: (r) => r.children },
    { key: "total", label: "Total", value: (r) => Number(r.rate_total) },
  ];
}

// A safety cap on the export fetch only (never on the paginated list query).
// Current production scale for any one property's reservation history is on
// the order of hundreds of rows -- this gives wide headroom without being
// literally unbounded.
const EXPORT_ROW_CAP = 5000;

function ReservationsList() {
  const propertyId = useActiveProperty();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [checkInRange, setCheckInRange] = useState<DateRange | undefined>(undefined);
  const [dateOpen, setDateOpen] = useState(false);
  // The page is stored together with the filter scope it was chosen in (see
  // scopedPage()) rather than on its own, so a filter change resets it by
  // derivation in the same render -- never one commit later from an effect.
  const [pageState, setPageState] = useState<ScopedPage>({ scope: "", page: 1 });
  // react-day-picker's own range-mode default, once a genuine multi-day
  // range is already selected, EXTENDS `to` from the range's original
  // `from` on every subsequent click — it never starts a fresh selection.
  // (Confirmed directly: clicking a 3rd day after a completed 2-day range
  // produced {from: <the very first day clicked>, to: <the new click>},
  // silently re-including everything back to that first day — the
  // production bug where an old date kept surviving into a new
  // selection.) rangeConfirmed tracks whether the current range is a real,
  // completed multi-day range; once it is, the next click is treated as
  // the first click of an entirely new selection instead of being handed
  // to the library's own extend behavior.
  const [rangeConfirmed, setRangeConfirmed] = useState(false);
  function handleCheckInSelect(newRange: DateRange | undefined, selectedDay: Date) {
    if (rangeConfirmed) {
      setCheckInRange({ from: selectedDay, to: undefined });
      setRangeConfirmed(false);
      return;
    }
    setCheckInRange(newRange);
    setRangeConfirmed(
      !!(newRange?.from && newRange?.to && newRange.from.getTime() !== newRange.to.getTime()),
    );
  }

  const checkInFrom = checkInRange?.from ? toDateKey(checkInRange.from) : null;
  const checkInTo = checkInRange?.to ? toDateKey(checkInRange.to) : checkInFrom;

  // Search is server-side (it must match guest name/email across the whole
  // filtered set, not just whatever page happens to be on screen) -- debounce
  // it so every keystroke doesn't fire its own request.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  // A stale/out-of-range page must never survive a filter change. Resetting
  // from an effect was one commit too late: the render that first saw the new
  // filters still carried the OLD page into the query key, so a single request
  // went out for a range the new result set might not have (PostgREST 416)
  // before the reset landed. Deriving the page from the current filter scope
  // closes that window entirely -- there is no render in which new filters and
  // a stale page coexist.
  const filterScope = filterScopeKey([propertyId, debouncedQ, status, checkInFrom, checkInTo]);
  const page = scopedPage(pageState, filterScope);
  const setPage = (next: number) => setPageState({ scope: filterScope, page: next });

  const filterArgs = {
    _property_id: propertyId!,
    _search: debouncedQ || null,
    _status: status,
    _check_in_from: checkInFrom,
    _check_in_to: checkInTo,
  };

  const query = useQuery({
    queryKey: ["reservations-report", propertyId, debouncedQ, status, checkInFrom, checkInTo, page],
    enabled: !!propertyId,
    queryFn: async () => {
      const { from, to } = pageRange(page, DEFAULT_PAGE_SIZE);
      // search_reservations() predates the generated Supabase types (added
      // in this same change) -- (supabase.rpc as any) matches this repo's
      // established convention for a freshly-added RPC.
      const { data, error, count } = await (supabase.rpc as any)(
        "search_reservations",
        filterArgs,
        { count: "exact" },
      ).range(from, to);
      if (error) throw error;
      return { rows: (data ?? []) as ReservationRow[], total: count ?? 0 };
    },
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pageCount = computeTotalPages(total, DEFAULT_PAGE_SIZE);

  async function fetchAllFiltered(): Promise<ReservationRow[]> {
    const { data, error } = await (supabase.rpc as any)("search_reservations", filterArgs).limit(
      EXPORT_ROW_CAP,
    );
    if (error) throw error;
    return (data ?? []) as ReservationRow[];
  }

  function filterSummary(): string {
    const parts: string[] = [];
    if (debouncedQ) parts.push(`Search: "${debouncedQ}"`);
    if (status !== "all") parts.push(`Status: ${status.replace("_", " ")}`);
    if (checkInFrom) parts.push(checkInTo !== checkInFrom ? `Check-in: ${checkInFrom} to ${checkInTo}` : `Check-in: ${checkInFrom}`);
    return parts.length > 0 ? parts.join(" · ") : "All reservations";
  }

  async function handleExport(exportFormat: ReportFormat) {
    const allRows = await fetchAllFiltered();
    const definition: ReportDefinition<ReservationRow> = {
      title: "Reservations",
      slug: "reservations",
      dateRange: checkInFrom ? { from: checkInFrom, to: checkInTo ?? checkInFrom } : null,
      columns: reservationColumns(),
      rows: allRows,
    };
    // filterSummary() (search/status terms) isn't part of ReportDefinition's
    // shape -- folded into the PDF/print subtitle via the title itself when
    // any filter beyond date range is active, so the exported file still
    // states what it represents without inventing a new definition field.
    if (debouncedQ || status !== "all") {
      definition.title = `Reservations — ${filterSummary()}`;
    }
    await exportReservationsReport(definition, exportFormat);
  }

  if (!propertyId) return <div className="p-6 text-muted-foreground">Select a property.</div>;

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
                    <span className="truncate">{format(checkInRange.from, "MMM d")} – {format(checkInRange.to, "dd/MM/yyyy")}</span>
                  ) : (
                    <span className="truncate">{format(checkInRange.from, "dd/MM/yyyy")}</span>
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
                onSelect={handleCheckInSelect}
                numberOfMonths={1}
                defaultMonth={checkInRange?.from}
              />
              <div className="flex items-center justify-end gap-2 border-t p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!checkInRange?.from}
                  onClick={() => { setCheckInRange(undefined); setRangeConfirmed(false); setDateOpen(false); }}
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
          <Button variant="outline" size="sm" onClick={() => handleExport("csv")}>
            <Download className="h-3 w-3 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("xlsx")}>
            <Download className="h-3 w-3 mr-1" /> XLSX
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("docx")}>
            <Download className="h-3 w-3 mr-1" /> DOCX
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("pdf")}>
            <Download className="h-3 w-3 mr-1" /> PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("print")}>
            <Printer className="h-3 w-3 mr-1" /> Print
          </Button>
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
            {query.isLoading && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {!query.isLoading && rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => (window.location.href = `/reservations/${r.id}`)}>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell>
                  <div className="font-medium">{r.guest_first_name} {r.guest_last_name}</div>
                  <div className="text-xs text-muted-foreground">{r.guest_email}</div>
                </TableCell>
                <TableCell>
                  <div>{r.room_type_name}</div>
                  <div className="text-xs text-muted-foreground">{r.room_number ? `Room ${r.room_number}` : "Unassigned"}</div>
                </TableCell>
                <TableCell>{format(new Date(r.check_in), "dd/MM/yyyy")}</TableCell>
                <TableCell>{format(new Date(r.check_out), "dd/MM/yyyy")}</TableCell>
                <TableCell><Badge variant={STATUS_COLORS[r.status]}>{r.status.replace("_", " ")}</Badge></TableCell>
                <TableCell className="text-right font-medium">{Number(r.rate_total).toFixed(2)}</TableCell>
              </TableRow>
            ))}
            {!query.isLoading && rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No reservations found.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {total > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-muted-foreground">
            {total} reservation{total === 1 ? "" : "s"} · page {page} of {pageCount}
          </p>
          <Pagination className="mx-0 w-auto justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationLink href="#" aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-50" : ""} onClick={(e) => { e.preventDefault(); if (page > 1) setPage(1); }}>
                  First
                </PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  aria-disabled={page <= 1}
                  className={page <= 1 ? "pointer-events-none opacity-50" : ""}
                  onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }}
                />
              </PaginationItem>
              {pageNumbers(page, pageCount).map((entry, i) =>
                entry === "ellipsis" ? (
                  <PaginationItem key={`e${i}`}><span className="px-2 text-muted-foreground">…</span></PaginationItem>
                ) : (
                  <PaginationItem key={entry}>
                    <PaginationLink
                      href="#"
                      isActive={entry === page}
                      onClick={(e) => { e.preventDefault(); setPage(entry); }}
                    >
                      {entry}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  href="#"
                  aria-disabled={page >= pageCount}
                  className={page >= pageCount ? "pointer-events-none opacity-50" : ""}
                  onClick={(e) => { e.preventDefault(); if (page < pageCount) setPage(page + 1); }}
                />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink href="#" aria-disabled={page >= pageCount} className={page >= pageCount ? "pointer-events-none opacity-50" : ""} onClick={(e) => { e.preventDefault(); if (page < pageCount) setPage(pageCount); }}>
                  Last
                </PaginationLink>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}

// A bounded window of page numbers around the current page (max 2 either
// side), always including page 1 and the last page, with an ellipsis where
// the window doesn't reach them -- keeps the control usable regardless of
// how many pages a heavily-filtered or unfiltered report produces.
export function pageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const result: (number | "ellipsis")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) result.push("ellipsis");
  for (let p = start; p <= end; p++) result.push(p);
  if (end < total - 1) result.push("ellipsis");
  result.push(total);
  return result;
}
