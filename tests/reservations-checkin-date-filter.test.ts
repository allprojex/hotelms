import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Reservations list page — check-in date filter, added between the existing
// Search and Status controls. Follows this repo's established structural
// (source-text) test convention — no live DB, no component-render harness
// wired into this route's own test suite; asserts against the real route
// source so a regression in the actual shipped code fails this file.

const routePage = readFileSync(
  resolve(__dirname, "../src/routes/_authenticated/reservations.index.tsx"),
  "utf8",
);

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
      /onClick=\{\(\) => \{ setCheckInRange\(undefined\); setDateOpen\(false\); \}\}/,
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

  it("applies the filter as an inclusive gte/lte pair against check_in — never a strict gt/lt, never against created_at, check_out, or a payment/booking date column", () => {
    expect(routePage).toContain('sel = sel.gte("check_in", checkInFrom)');
    expect(routePage).toContain('sel = sel.lte("check_in", checkInTo)');
    expect(routePage).not.toMatch(/\.gt\(\s*"check_in"/);
    expect(routePage).not.toMatch(/\.lt\(\s*"check_in"/);
    expect(routePage).not.toMatch(
      /(gte|lte|gt|lt|eq)\(\s*"(created_at|check_out|received_at|booked_at)"/,
    );
  });

  it("clearing the date (checkInRange undefined) means checkInFrom/checkInTo are both null, so no gte/lte clause is ever added — all dates return", () => {
    const queryFnBody = routePage.match(/queryFn: async \(\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? "";
    expect(queryFnBody).toMatch(/if \(checkInFrom\) sel = sel\.gte/);
    expect(queryFnBody).toMatch(/if \(checkInTo\) sel = sel\.lte/);
  });
});

describe("reservations date filter — timezone safety", () => {
  it("never round-trips a selected date through .toISOString() (UTC conversion, the classic day-shift bug) in an actual statement — only date-fns format() to a plain yyyy-MM-dd key", () => {
    const withoutComments = routePage.replace(/\/\/[^\n]*/g, "");
    expect(withoutComments).not.toMatch(/toISOString\(\)/);
    expect(routePage).toContain('const toDateKey = (d: Date) => format(d, "yyyy-MM-dd");');
  });

  it("sends the filter as a plain date string directly to a DATE column comparison, not a Date object or timestamp", () => {
    expect(routePage).toMatch(/gte\("check_in", checkInFrom\)/);
    expect(routePage).toMatch(/lte\("check_in", checkInTo\)/);
  });
});

describe("reservations date filter — combines with existing filters via AND, without disturbing them", () => {
  it("status and the new date filter are both applied as separate conditions on the SAME scoped Supabase query — combining as AND by construction, and neither resets the other (independent useState)", () => {
    expect(routePage).toContain('if (status !== "all") sel = sel.eq("status", status as any);');
    expect(routePage).toContain('const [status, setStatus] = useState<string>("all");');
    expect(routePage).toContain(
      "const [checkInRange, setCheckInRange] = useState<DateRange | undefined>(undefined);",
    );
  });

  it("search remains its own independent client-side filter over whatever the (status+date)-scoped query already returned — unchanged logic, so it still combines as AND with both server-side filters", () => {
    expect(routePage).toContain(
      "const filtered = (query.data ?? []).filter((r: any) => {\n    if (!q) return true;",
    );
    expect(routePage).toContain('const [q, setQ] = useState("");');
  });

  it("property scoping is applied unconditionally, before any status/date branch, and is never removed or made optional", () => {
    const queryFnBody = routePage.match(/queryFn: async \(\) => \{[\s\S]*?\n {4}\},/)?.[0] ?? "";
    const propIdx = queryFnBody.indexOf('.eq("property_id", propertyId!)');
    const statusIdx = queryFnBody.indexOf('if (status !== "all")');
    const dateIdx = queryFnBody.indexOf("if (checkInFrom)");
    expect(propIdx).toBeGreaterThan(-1);
    expect(propIdx).toBeLessThan(statusIdx);
    expect(propIdx).toBeLessThan(dateIdx);
  });

  it("the query key includes checkInFrom/checkInTo alongside the existing propertyId/status keys, so React Query refetches correctly on every filter change without a second, conflicting source of truth", () => {
    expect(routePage).toContain(
      'queryKey: ["reservations", propertyId, status, checkInFrom, checkInTo]',
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
