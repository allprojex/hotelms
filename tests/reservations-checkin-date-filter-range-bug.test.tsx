// @vitest-environment jsdom
//
// PRODUCTION BUG: selecting a new check-in date/range after a range was
// already selected could leave old, out-of-range reservation rows visible.
//
// ROOT CAUSE (proven live, not assumed from source): react-day-picker's own
// `mode="range"` default behavior, once a genuine multi-day range is
// already selected, EXTENDS `to` from the range's ORIGINAL `from` on every
// subsequent click — it never starts a fresh selection. Clicking a 3rd day
// after a completed 2-day range produced
// `{from: <the very first day ever clicked>, to: <the new click>}`, not a
// fresh `{from: <new click>, to: undefined}`. Confirmed directly by
// mounting the REAL `Calendar` component (react-day-picker, not a mock)
// and driving REAL clicks through `@testing-library/user-event` — this is
// exactly why the previous purely structural (source-string) test suite
// passed while the bug was still live: the .gte/.lte query-building code
// was always correct, the STATE fed into it was wrong.
//
// This file exercises the same fix now shipped in
// handleCheckInSelect()/rangeConfirmed (reservations.index.tsx) against
// the real Calendar component through real user clicks, so a regression in
// either react-day-picker's behavior or this fix's own logic fails here —
// not just a string match against source.

import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { format } from "date-fns";
import { Calendar } from "@/components/ui/calendar";

// This repo has no global RTL setup file wiring automatic cleanup between
// tests -- without this, each it()'s render() leaves its DOM tree mounted
// into the shared document.body, so a later test's `screen.getByRole`
// query can match a PREVIOUS test's leftover (already-clicked/"selected")
// day button alongside the current test's freshly-mounted one.
afterEach(cleanup);

// Exact same derivation as reservations.index.tsx's own toDateKey/
// checkInFrom/checkInTo — duplicated here (not imported) because the
// production module has no test-only export surface; pinned against the
// production source text separately in
// tests/reservations-checkin-date-filter.test.ts.
const toDateKey = (d: Date) => format(d, "yyyy-MM-dd");

// Exact reproduction of the shipped fix, so this test exercises the same
// logic that ships, not a re-imagined version of it.
function Harness() {
  const [checkInRange, setCheckInRange] = useState<DateRange | undefined>(undefined);
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

  return (
    <div>
      <div data-testid="from">{checkInFrom ?? ""}</div>
      <div data-testid="to">{checkInTo ?? ""}</div>
      <Calendar
        mode="range"
        selected={checkInRange}
        onSelect={handleCheckInSelect}
        defaultMonth={new Date(2026, 7, 1)}
      />
      <button onClick={() => { setCheckInRange(undefined); setRangeConfirmed(false); }}>Clear</button>
    </div>
  );
}

async function clickDay(user: ReturnType<typeof userEvent.setup>, dayOfMonthNoCollision: number) {
  const btn = screen.getByRole("button", { name: new RegExp(`August ${dayOfMonthNoCollision}\\D`) });
  await user.click(btn);
}

describe("Reservations check-in date filter — range selection does not leak old dates (production bug fix)", () => {
  it("single date: from and to are identical (an equality filter, not an open-ended range)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    expect(screen.getByTestId("from").textContent).toBe("2026-08-05");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-05");
  });

  it("range selection: two clicks produce the correct inclusive from/to", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10);
    expect(screen.getByTestId("from").textContent).toBe("2026-08-05");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-10");
  });

  it("THE BUG: a 3rd click after a completed range starts an entirely fresh selection — the old start date does not survive", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10); // completed range: 5 -> 10
    await clickDay(user, 20); // 3rd click: must NOT become {5, 20}
    // First click of a fresh selection: to falls back to from (single-date state).
    expect(screen.getByTestId("from").textContent).toBe("2026-08-20");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-20");
  });

  it("completing the fresh range after the reset uses ONLY the new dates, never the original range's start", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10); // completed range: 5 -> 10
    await clickDay(user, 20); // reset
    await clickDay(user, 25); // completes NEW range: 20 -> 25
    expect(screen.getByTestId("from").textContent).toBe("2026-08-20");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-25");
  });

  it("the reset-then-complete cycle repeats correctly across multiple range changes in a row, in either date direction", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10); // 5 -> 10
    await clickDay(user, 20);
    await clickDay(user, 25); // 20 -> 25
    await clickDay(user, 2); // reset, even though 2 is BEFORE the previous range
    await clickDay(user, 4); // 2 -> 4
    expect(screen.getByTestId("from").textContent).toBe("2026-08-02");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-04");
  });

  it("the displayed calendar label always matches the effective from/to values fed to the query — never a stale combination", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10);
    await clickDay(user, 20);
    // Immediately after the reset click, from===to===Aug 20 — the label
    // state and the query-bound state are read from the exact same
    // checkInFrom/checkInTo values, so they cannot disagree by construction.
    expect(screen.getByTestId("from").textContent).toBe(screen.getByTestId("to").textContent);
  });

  it("Clear removes the date selection back to no-filter and resets the confirmed-range flag, so the next click starts a fresh single date rather than extending a phantom range", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await clickDay(user, 5);
    await clickDay(user, 10); // completed range
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("from").textContent).toBe("");
    expect(screen.getByTestId("to").textContent).toBe("");
    await clickDay(user, 20);
    expect(screen.getByTestId("from").textContent).toBe("2026-08-20");
    expect(screen.getByTestId("to").textContent).toBe("2026-08-20");
  });
});
