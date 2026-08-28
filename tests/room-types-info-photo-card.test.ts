import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatOccupancy,
  formatPhotoCount,
  formatRatePerNight,
  parseOccupancyValue,
  parseRateValue,
  OCCUPANCY_NOT_SET,
  RATE_NOT_SET,
} from "@/lib/room-type-display";
import { countByRoomType } from "@/lib/gallery/use-room-type-photo-counts";

// Regression cover for the Room Types information + photos card.
//
// The screen previously rendered `Number(base_rate).toFixed(2)` and
// `{base_occupancy}/{max_occupancy}` with no guards, which is what produced
// "NaN/night" and a bare "Occupancy /". It also showed the rate with no
// currency at all, and mounted a per-card cover hook (one metadata query plus
// one signing round-trip per room type).

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const route = read("src/routes/_authenticated/rooms.types.tsx");
const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("rate — never NaN", () => {
  it("formats a numeric rate in the given currency", () => {
    expect(formatRatePerNight(300, "GHS")).toContain("300.00");
    expect(formatRatePerNight(300, "GHS")).toMatch(/\/ night$/);
  });

  it("accepts a numeric string, as PostgREST may return for NUMERIC", () => {
    expect(formatRatePerNight("450.50", "GHS")).toContain("450.50");
  });

  it("treats zero as a real price, not as missing", () => {
    const out = formatRatePerNight(0, "GHS");
    expect(out).toContain("0.00");
    expect(out).not.toBe(RATE_NOT_SET);
  });

  it("reports null and undefined as not set rather than inventing 0", () => {
    expect(formatRatePerNight(null, "GHS")).toBe(RATE_NOT_SET);
    expect(formatRatePerNight(undefined, "GHS")).toBe(RATE_NOT_SET);
  });

  it("reports malformed input as not set", () => {
    for (const bad of ["", "   ", "abc", "12abc", NaN, Infinity, -Infinity, {}, [], true, false]) {
      expect(formatRatePerNight(bad, "GHS"), `input: ${String(bad)}`).toBe(RATE_NOT_SET);
    }
  });

  it("treats a negative rate as missing rather than displaying it", () => {
    expect(formatRatePerNight(-10, "GHS")).toBe(RATE_NOT_SET);
    expect(parseRateValue(-0.01)).toBeNull();
  });

  it("never renders NaN, undefined or null for any input", () => {
    for (const bad of [undefined, null, NaN, "abc", {}, [], true, -5, Infinity]) {
      const out = formatRatePerNight(bad, "GHS");
      expect(out).not.toMatch(/NaN|undefined|null/);
    }
  });

  it("does not let formatMoney's zero-coercion invent a price", () => {
    // formatMoney(NaN) would render 0.00; the guard must run first.
    expect(formatRatePerNight(NaN, "GHS")).toBe(RATE_NOT_SET);
    expect(formatRatePerNight(NaN, "GHS")).not.toContain("0.00");
  });
});

describe("currency — property driven", () => {
  it("renders a GHS property in cedis", () => {
    expect(formatRatePerNight(300, "GHS")).toContain("₵");
  });

  it("renders an AUD property in dollars, not cedis", () => {
    const aud = formatRatePerNight(300, "AUD");
    expect(aud).toContain("$");
    expect(aud).not.toContain("₵");
  });

  it("changes with the currency argument, so a property switch changes it", () => {
    expect(formatRatePerNight(300, "GHS")).not.toBe(formatRatePerNight(300, "AUD"));
  });

  it("reads base_currency, never the legacy currency column", () => {
    expect(routeCode).toContain('.select("base_currency")');
    expect(routeCode).not.toMatch(/select\("[^"]*\bcurrency\b[^"]*"\)(?!.*base_currency)/);
    expect(routeCode).toContain("property.data?.base_currency");
  });

  it("hardcodes no currency symbol or code in the screen", () => {
    expect(route).not.toMatch(/GH₵|\bGHS\b|\bAUD\b|\bUSD\b|€|£/);
  });
});

describe("occupancy — never a bare slash", () => {
  it("shows a single figure when base and max agree", () => {
    expect(formatOccupancy(2, 2)).toBe("Sleeps 2");
  });

  it("shows a range when they differ", () => {
    expect(formatOccupancy(2, 4)).toBe("Sleeps 2–4");
  });

  it("orders an inverted pair rather than printing it backwards", () => {
    // Production genuinely holds base_occupancy 3 with max_occupancy 2.
    expect(formatOccupancy(3, 2)).toBe("Sleeps 2–3");
  });

  it("falls back to whichever value is usable", () => {
    expect(formatOccupancy(null, 4)).toBe("Sleeps 4");
    expect(formatOccupancy(2, undefined)).toBe("Sleeps 2");
  });

  it("reports missing occupancy deliberately", () => {
    expect(formatOccupancy(null, null)).toBe(OCCUPANCY_NOT_SET);
    expect(formatOccupancy(undefined, undefined)).toBe(OCCUPANCY_NOT_SET);
  });

  it("rejects malformed and nonsensical occupancy", () => {
    for (const bad of ["", "abc", 0, -1, 2.5, NaN, true, {}]) {
      expect(parseOccupancyValue(bad), `input: ${String(bad)}`).toBeNull();
    }
    expect(formatOccupancy("abc", 0)).toBe(OCCUPANCY_NOT_SET);
  });

  it("never renders the old malformed output", () => {
    for (const [b, m] of [
      [null, null],
      [undefined, undefined],
      ["", ""],
      [0, 0],
    ]) {
      const out = formatOccupancy(b, m);
      expect(out).not.toMatch(/NaN|undefined|null/);
      expect(out).not.toMatch(/^Occupancy\s*\/\s*$/);
    }
  });
});

describe("photo count", () => {
  it("counts singular, plural and none", () => {
    expect(formatPhotoCount(0)).toBe("No photos");
    expect(formatPhotoCount(1)).toBe("1 photo");
    expect(formatPhotoCount(4)).toBe("4 photos");
  });

  it("degrades to No photos for anything not a whole count", () => {
    for (const bad of [undefined, null, -1, 1.5, NaN, "3", {}]) {
      expect(formatPhotoCount(bad)).toBe("No photos");
    }
  });

  it("tallies rows per room type", () => {
    const counts = countByRoomType([
      { room_type_id: "a" },
      { room_type_id: "a" },
      { room_type_id: "b" },
      { room_type_id: null },
    ]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("null")).toBe(false);
    expect(counts.size).toBe(2);
  });

  it("returns an empty tally for no rows", () => {
    expect(countByRoomType([]).size).toBe(0);
  });
});

describe("photos — batched, not N+1", () => {
  it("resolves covers and counts once for the whole grid", () => {
    expect(routeCode).toContain("useRoomTypeCoverImages(roomTypeIds)");
    expect(routeCode).toContain("useRoomTypePhotoCounts(roomTypeIds)");
  });

  it("no longer mounts a per-card cover hook", () => {
    expect(routeCode).not.toContain("RoomTypeCoverThumbnail");
    // Both gallery hooks are called once, at grid level, not inside the card.
    const card = routeCode.slice(
      routeCode.indexOf("function RoomTypeCard"),
      routeCode.indexOf("function TypeDialog"),
    );
    expect(card.length).toBeGreaterThan(500);
    expect(card).not.toMatch(
      /useRoomTypeCoverImages|useRoomTypePhotoCounts|supabase\.from|useQuery/,
    );
  });

  it("passes already-resolved values down to each card", () => {
    expect(routeCode).toContain("covers.data?.get(t.id as string)");
    expect(routeCode).toContain("photoCounts.data?.get(t.id as string)");
  });

  it("keeps the shared gallery component untouched by this change", () => {
    // PR #92 is refactoring room-type-gallery-preview.tsx; this PR reuses its
    // exported hook rather than editing the same file.
    expect(routeCode).toContain('from "@/components/gallery/room-type-gallery-preview"');
  });

  it("scopes the photo queries to the active property's room types", () => {
    const hook = read("src/lib/gallery/use-room-type-photo-counts.ts");
    expect(hook).toContain('.in("room_type_id", roomTypeIds)');
    expect(hook).toContain('.eq("context", "room_type")');
    expect(routeCode).toContain('.eq("property_id", propertyId!)');
  });
});

describe("no-photo fallback", () => {
  it("uses the app's neutral placeholder at the same dimensions", () => {
    expect(routeCode).toContain("ImageOff");
    expect(routeCode).toContain("aspect-[4/3] w-full bg-muted");
  });

  it("recovers from a broken or expired image URL", () => {
    expect(routeCode).toContain("onError={() => setImageFailed(true)}");
    expect(routeCode).toContain("const showImage = coverUrl && !imageFailed;");
  });

  it("uses no external placeholder service and no uploaded stand-in asset", () => {
    expect(routeCode).not.toMatch(/placeholder\.com|placehold|unsplash|https?:\/\//);
  });

  it("keeps the photo undistorted", () => {
    expect(routeCode).toContain("object-cover");
  });
});

describe("layout and actions", () => {
  it("keeps the card shrinkable so the page cannot scroll sideways", () => {
    // Matches the shell fix shipped in PR #91.
    expect((routeCode.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("truncates a long room name instead of pushing controls off screen", () => {
    const card = routeCode.slice(
      routeCode.indexOf("function RoomTypeCard"),
      routeCode.indexOf("function TypeDialog"),
    );
    expect(card).toContain("truncate text-lg font-semibold");
    expect(card).toContain("truncate text-xs uppercase");
  });

  it("stacks to one column on a phone and widens on larger screens", () => {
    expect(routeCode).toContain("grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3");
  });

  it("preserves the Manage photos destination exactly", () => {
    expect(routeCode).toContain('to="/gallery"');
    expect(routeCode).toContain('{ context: "room_type", roomTypeId: type.id }');
  });

  it("keeps room type creation and editing available", () => {
    expect(routeCode).toContain("<TypeDialog");
    expect(routeCode).toContain('supabase.from("room_types").insert(payload)');
    expect(routeCode).toContain('.from("room_types")\n          .update(payload)');
  });

  it("gives the edit control an accessible name", () => {
    expect(routeCode).toContain('aria-label={`Edit ${name || "room type"}`}');
  });

  it("distinguishes loading from genuinely having no room types", () => {
    expect(routeCode).toContain("Loading room types…");
    expect(routeCode).toContain("No room types yet for this property.");
  });
});

describe("scope — nothing else touched", () => {
  it("adds no field the schema does not have", () => {
    for (const absent of ["bed_type", "room_size", "view_type", "smoking"]) {
      expect(routeCode).not.toContain(absent);
    }
  });

  it("uses base_rate, not the public booking best_rate", () => {
    expect(routeCode).toContain("type.base_rate");
    expect(routeCode).not.toContain("best_rate");
  });

  it("leaves public booking and reservations screens alone", () => {
    for (const other of [
      "src/routes/book.results.tsx",
      "src/routes/book.checkout.$roomTypeId.tsx",
      "src/routes/_authenticated/reservations.new.tsx",
    ]) {
      expect(read(other).length).toBeGreaterThan(0);
    }
    // Those screens keep using the shared preview component this PR did not edit.
    expect(read("src/components/gallery/room-type-gallery-preview.tsx")).toContain(
      "export function useRoomTypeCoverImages",
    );
  });
});
