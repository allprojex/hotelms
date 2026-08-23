import { describe, expect, it } from "vitest";
import {
  matchesSearch,
  reservationSearchText,
  guestSearchText,
  roomSearchText,
  menuItemSearchText,
} from "../src/lib/search-filter";

describe("matchesSearch", () => {
  it("returns true for an empty or whitespace-only query (no filter = show everything)", () => {
    expect(matchesSearch("Jane Doe", "")).toBe(true);
    expect(matchesSearch("Jane Doe", "   ")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(matchesSearch("Jane Doe", "jane")).toBe(true);
    expect(matchesSearch("Jane Doe", "JANE")).toBe(true);
    expect(matchesSearch("Jane Doe", "jAnE dOe")).toBe(true);
  });

  it("matches on a partial substring anywhere in the haystack", () => {
    expect(matchesSearch("Jollof Rice Special", "rice")).toBe(true);
    expect(matchesSearch("Jollof Rice Special", "special")).toBe(true);
    expect(matchesSearch("Jollof Rice Special", "of ri")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesSearch("Jollof Rice", "banku")).toBe(false);
  });

  it("trims surrounding whitespace from the query before matching", () => {
    expect(matchesSearch("Jollof Rice", "  rice  ")).toBe(true);
  });
});

describe("entity search-text builders", () => {
  it("reservationSearchText combines code and guest name, skipping missing fields", () => {
    expect(
      reservationSearchText({ code: "R-100", guests: { first_name: "Ama", last_name: "Owusu" } }),
    ).toBe("R-100 Ama Owusu");
    expect(reservationSearchText({ code: "R-100", guests: null })).toBe("R-100");
  });

  it("guestSearchText combines name/email/phone, skipping missing fields", () => {
    expect(
      guestSearchText({
        first_name: "Ama",
        last_name: "Owusu",
        email: "ama@example.com",
        phone: "0551234567",
      }),
    ).toBe("Ama Owusu ama@example.com 0551234567");
    expect(
      guestSearchText({ first_name: "Ama", last_name: "Owusu", email: null, phone: null }),
    ).toBe("Ama Owusu");
  });

  it("roomSearchText returns the room number, or empty string when missing", () => {
    expect(roomSearchText({ number: "204" })).toBe("204");
    expect(roomSearchText({})).toBe("");
  });

  it("menuItemSearchText combines item name and category name", () => {
    expect(
      menuItemSearchText({ name: "Jollof Rice", pos_menu_categories: { name: "Mains" } }),
    ).toBe("Jollof Rice Mains");
    expect(menuItemSearchText({ name: "Jollof Rice", pos_menu_categories: null })).toBe(
      "Jollof Rice",
    );
  });

  it("end-to-end: filtering a list with matchesSearch + a search-text builder behaves case-insensitively and partially", () => {
    const items = [
      { name: "Jollof Rice", pos_menu_categories: { name: "Mains" } },
      { name: "Banku & Tilapia", pos_menu_categories: { name: "Mains" } },
      { name: "Sobolo", pos_menu_categories: { name: "Drinks" } },
    ];
    const filtered = items.filter((i) => matchesSearch(menuItemSearchText(i), "RICE"));
    expect(filtered.map((i) => i.name)).toEqual(["Jollof Rice"]);

    const byCategory = items.filter((i) => matchesSearch(menuItemSearchText(i), "drinks"));
    expect(byCategory.map((i) => i.name)).toEqual(["Sobolo"]);

    // Clearing the query (empty string) restores the full list.
    expect(items.filter((i) => matchesSearch(menuItemSearchText(i), ""))).toHaveLength(3);
  });
});
