import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Reservations list page — check-in date filter, added between the existing
// Search and Status controls. Follows this repo's established structural
// (source-text) test convention — no live DB, no component-render harness
// wired into this route's own test suite; asserts against the real route
// source so a regression in the actual shipped code fails this file.

// Normalize CRLF -> LF: this file can be checked out with either line
// ending on Windows depending on git's autocrlf handling, and the
// multi-line string assertions below embed literal \n.
const routePage = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/reservations.index.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("reservations date filter — control renders in the right place", () => {
  it("adds a Popover+Calendar date control between the Search input and the Status select, without moving either", () => {
    const searchIdx = routePage.indexOf('placeholder="Search by code, guest name, email…"');
    const dateIdx = routePage.indexOf("<Popover open={dateOpen}");
    const statusIdx = routePage.indexOf("<Select value={status} onValueChange={setStatus}>");
    expect(searchIdx).toBeGreaterThan(-1);
    expect(dateIdx).toBeGreaterThan(searchIdx);
    expect(statusIdx).toBeGreaterThan(dateIdx);
  });

  it("defaults to a 'Check-in date' label when nothing is selected", () => {
    expect(routePage).toContain(
      '<span className="truncate text-muted-foreground">Check-in date</span>',
    );
  });

  it("uses the already-installed Calendar/Popover primitives and react-day-picker's DateRange type — no new dependency", () => {
    expect(routePage).toContain('from "@/components/ui/popover"');
    expect(routePage).toContain('from "@/components/ui/calendar"');
    expect(routePage).toContain('from "react-day-picker"');
    expect(routePage).toContain('mode="range"');
  });

  it("provides a Clear action that resets the selection and closes the popover, disabled when nothing is selected", () => {
    expect(routePage).toMatch(/disabled=\{!checkInRange\?\.from\}/);
    expect(routePage).toMatch(
      /onClick=\{\(\) => \{ setCheckInRange\(undefined\); setRangeConfirmed\(false\); setDateOpen\(false\); \}\}/,
    );
  });

  it("does not move or redesign the Search input or the Status select", () => {
    expect(routePage).toContain(
      'placeholder="Search by code, guest name, email…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)}',
    );
    expect(routePage).toContain(
      '<SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>',
    );
  });

  it("uses a responsive width on the date button (full width below the sm breakpoint, fixed 220px at sm and up) rather than a bare fixed width, so the filter row never overflows a narrow viewport — regression pin for the mobile overflow fix", () => {
    expect(routePage).toContain(
      '<Button variant="outline" className="w-full sm:w-[220px] justify-start font-normal">',
    );
    expect(routePage).not.toMatch(/<Button variant="outline" className="w-\[220px\]/);
  });
});

describe("reservations date filter — semantics: inclusive check_in range, never another column", () => {
  it("derives checkInFrom/checkInTo from the selected range, single date collapsing to the same from/to value", () => {
    expect(routePage).toContain(
      "const checkInFrom = checkInRange?.from ? toDateKey(checkInRange.from) : null;",
    );
    expect(routePage).toContain(
      "const checkInTo = checkInRange?.to ? toDateKey(checkInRange.to) : checkInFrom;",
    );
  });

  it("passes checkInFrom/checkInTo straight through to the search_reservations RPC as _check_in_from/_check_in_to — the actual inclusive gte/lte-against-check_in semantics now live in that migration (see tests/reservations-reporting-pagination.test.ts), never reimplemented as a second client-side date filter", () => {
    expect(routePage).toContain("_check_in_from: checkInFrom,");
    expect(routePage).toContain("_check_in_to: checkInTo,");
  });

  it("clearing the date (checkInRange undefined) means checkInFrom/checkInTo are both null, sent straight through as null RPC args — the RPC's own null-check (not a client-side conditional clause) is what makes all dates return", () => {
    expect(routePage).toContain(
      "const checkInFrom = checkInRange?.from ? toDateKey(checkInRange.from) : null;",
    );
    expect(routePage).toContain(
      "const checkInTo = checkInRange?.to ? toDateKey(checkInRange.to) : checkInFrom;",
    );
    expect(routePage).toContain("_check_in_from: checkInFrom,");
    expect(routePage).toContain("_check_in_to: checkInTo,");
  });
});

describe("reservations date filter — timezone safety", () => {
  it("never round-trips a selected date through .toISOString() (UTC conversion, the classic day-shift bug) in an actual statement — only date-fns format() to a plain yyyy-MM-dd key", () => {
    const withoutComments = routePage.replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/toISOString\(\)/);
    expect(routePage).toContain('const toDateKey = (d: Date) => format(d, "yyyy-MM-dd");');
  });

  it("sends the filter as plain date strings (checkInFrom/checkInTo) to the RPC, never a Date object or timestamp", () => {
    expect(routePage).toContain("_check_in_from: checkInFrom,");
    expect(routePage).toContain("_check_in_to: checkInTo,");
  });
});

describe("reservations date filter — combines with existing filters via AND, without disturbing them", () => {
  // Reporting PR2 moved status/date/search filtering from client-side query
  // chaining into the search_reservations RPC (see
  // tests/reservations-reporting-pagination.test.ts for the migration-level
  // AND-semantics proof). What this file still pins is that the CLIENT
  // continues to pass all three as independent, unconditional arguments to
  // that single RPC call -- neither resets the other, and none is dropped.
  it("status and the date filter are both independent useState, both passed unconditionally into the same filterArgs object sent to the RPC — combining as AND inside that one call, and neither resets the other", () => {
    expect(routePage).toContain('const [status, setStatus] = useState<string>("all");');
    expect(routePage).toContain(
      "const [checkInRange, setCheckInRange] = useState<DateRange | undefined>(undefined);",
    );
    const filterArgsBlock = routePage.slice(
      routePage.indexOf("const filterArgs = {"),
      routePage.indexOf("const query = useQuery"),
    );
    expect(filterArgsBlock).toContain("_status: status,");
    expect(filterArgsBlock).toContain("_check_in_from: checkInFrom,");
    expect(filterArgsBlock).toContain("_check_in_to: checkInTo,");
  });

  it("search is now sent to the same RPC/filterArgs as status and date (server-side, not a separate client-side array filter) — still combines as AND with both, now enforced by the single RPC call rather than a second pass over already-fetched rows", () => {
    expect(routePage).not.toMatch(/const filtered = \(query\.data/);
    const filterArgsBlock = routePage.slice(
      routePage.indexOf("const filterArgs = {"),
      routePage.indexOf("const query = useQuery"),
    );
    expect(filterArgsBlock).toContain("_search: debouncedQ || null,");
    expect(routePage).toContain('const [q, setQ] = useState("");');
  });

  it("property scoping (_property_id) is always present in filterArgs, unconditionally — never dropped or made optional for any status/date/search combination", () => {
    const filterArgsBlock = routePage.slice(
      routePage.indexOf("const filterArgs = {"),
      routePage.indexOf("const query = useQuery"),
    );
    expect(filterArgsBlock).toContain("_property_id: propertyId!,");
  });

  it("the query key includes debouncedQ/status/checkInFrom/checkInTo/page alongside propertyId, so React Query refetches correctly on every filter or page change without a second, conflicting source of truth", () => {
    expect(routePage).toContain(
      'queryKey: ["reservations-report", propertyId, debouncedQ, status, checkInFrom, checkInTo, page],',
    );
  });
});

describe("reservations date filter — range-reset fix (stale/incorrect results bug)", () => {
  // Structural pin for the fix committed alongside the real behavioral proof
  // in tests/reservations-checkin-date-filter-range-bug.test.tsx (which
  // exercises the actual react-day-picker Calendar component). This file
  // stays purely structural per this suite's existing convention, but the
  // bug itself was only proven/fixed via the component-level test.
  it("wires the Calendar's onSelect to handleCheckInSelect, not a bare setCheckInRange, so a completed range doesn't silently extend on the next click", () => {
    expect(routePage).toContain("onSelect={handleCheckInSelect}");
    expect(routePage).not.toMatch(/<Calendar[\s\S]*?onSelect=\{setCheckInRange\}/);
  });

  it("tracks rangeConfirmed and resets to a fresh single-day selection (selectedDay, not the stale range) once a completed range is clicked again", () => {
    expect(routePage).toContain("const [rangeConfirmed, setRangeConfirmed] = useState(false);");
    expect(routePage).toContain(
      "function handleCheckInSelect(newRange: DateRange | undefined, selectedDay: Date) {",
    );
    expect(routePage).toContain("if (rangeConfirmed) {");
    expect(routePage).toContain("setCheckInRange({ from: selectedDay, to: undefined });");
    expect(routePage).toContain("setRangeConfirmed(false);");
  });

  it("only marks a range confirmed once from and to are both set and genuinely different days (a real completed range, not a single click)", () => {
    expect(routePage).toContain(
      "!!(newRange?.from && newRange?.to && newRange.from.getTime() !== newRange.to.getTime()),",
    );
  });

  it("Clear also resets rangeConfirmed, so the next click after Clear starts a fresh single date instead of extending a phantom prior range", () => {
    expect(routePage).toMatch(
      /onClick=\{\(\) => \{ setCheckInRange\(undefined\); setRangeConfirmed\(false\); setDateOpen\(false\); \}\}/,
    );
  });
});

describe("reservations date filter — table/columns untouched", () => {
  it("keeps the exact same 7-column table header, unmodified", () => {
    expect(routePage).toContain(
      '<TableHead>Code</TableHead>\n              <TableHead>Guest</TableHead>\n              <TableHead>Room</TableHead>\n              <TableHead>Check-in</TableHead>\n              <TableHead>Check-out</TableHead>\n              <TableHead>Status</TableHead>\n              <TableHead className="text-right">Total</TableHead>',
    );
  });
});
