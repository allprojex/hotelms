import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatMoney, safeCurrencyCode } from "@/lib/accounting/domain";

// UI wiring for Reservation Discounts Phase 1. The financial behaviour is
// proven behaviourally against a real Postgres in reservation-discounts.test.ts;
// this file pins the things that live only in the page: which currency source
// it reads, which roles it offers the action to, and that the client never
// becomes the enforcement point.

const root = resolve(__dirname, "..");
const page = readFileSync(
  resolve(root, "src/routes/_authenticated/reservations.$id.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("currency source", () => {
  it("reads the property's base_currency, not the legacy currency column", () => {
    expect(page).toContain("safeCurrencyCode(r.properties?.base_currency)");
    expect(page).not.toContain('r.properties?.currency ?? "GHS"');
    expect(page).toContain("properties(name,currency,base_currency)");
  });

  it("formats money through the shared helper, never a hand-rolled string", () => {
    expect(page).toContain("formatMoney(value, currency)");
    expect(page).not.toContain("{currency} {value.toFixed(2)}");
  });

  it("hardcodes no currency anywhere in the discount UI", () => {
    const dialog = page.slice(
      page.indexOf("function AddDiscount("),
      page.indexOf("function SummaryLine("),
    );
    expect(dialog).not.toMatch(/GHS|AUD|GH₵|\$\d/);
    // The label is derived from the resolved property currency.
    expect(dialog).toContain("Amount ({currency})");
    expect(dialog).toContain("Percentage (%)");
  });

  it("derives both currencies correctly through the shared formatter", () => {
    expect(formatMoney(1000, safeCurrencyCode("GHS"))).toBe("GH₵1,000.00");
    expect(formatMoney(1000, safeCurrencyCode("AUD"))).toBe("$1,000.00");
    expect(safeCurrencyCode(undefined)).toBe("GHS"); // safe fallback, not a hardcode
  });
});

describe("discount action placement and gating", () => {
  it("lives inside the Folio card beside the existing actions — no new tab", () => {
    const folio = page.slice(page.indexOf('<CardTitle className="text-base">Folio</CardTitle>'));
    const actions = folio.slice(0, folio.indexOf("</CardHeader>"));
    expect(actions).toContain("<AddCharge");
    expect(actions).toContain("<AddDiscount");
    expect(actions).toContain("<AddPayment");
    expect(page).not.toMatch(/<Tabs[\s>]/);
  });

  it("offers the action only to the three approved roles", () => {
    expect(page).toContain(
      'const DISCOUNT_ROLES = ["super_admin", "hotel_owner", "general_manager"] as const;',
    );
    const dialog = page.slice(
      page.indexOf("function AddDiscount("),
      page.indexOf("function SummaryLine("),
    );
    expect(dialog).toContain('module: "reservation_discounts"');
    expect(dialog).toContain("defaultRoles: DISCOUNT_ROLES");
    expect(dialog).not.toContain("front_desk");
  });

  it("hides the action on states the server rejects", () => {
    const dialog = page.slice(
      page.indexOf("function AddDiscount("),
      page.indexOf("function SummaryLine("),
    );
    expect(dialog).toContain('status === "confirmed" || status === "checked_in"');
    expect(dialog).toContain("if (!canDiscount.allowed || !statusAllowed) return null;");
  });
});

describe("the dialog previews the real calculation", () => {
  const dialog = page.slice(
    page.indexOf("function AddDiscount("),
    page.indexOf("function SummaryLine("),
  );

  it("shows eligible room amount, discount and resulting amount before confirming", () => {
    expect(dialog).toContain("Eligible room amount");
    expect(dialog).toContain("Resulting room amount");
    expect(dialog).toContain("Outstanding balance after");
  });

  it("takes the percentage basis from the room value, never the folio total", () => {
    expect(page).toContain("const eligibleRoomAmount = Number(r.rate_total ?? 0);");
    expect(dialog).toContain("eligibleRoomAmount * Math.min(entered, 100)");
    expect(dialog).not.toContain("totalCharges *");
  });

  it("requires a reason before the action is enabled", () => {
    expect(dialog).toContain('reason.trim() === ""');
    expect(dialog).toContain("disabled={busy || blocked}");
  });

  it("mirrors — but does not replace — the server guards", () => {
    expect(dialog).toContain("overBasis");
    expect(dialog).toContain("overOutstanding");
    expect(dialog).toContain("overPercent");
    // The call still goes to the transactional RPC, not to table writes.
    expect(dialog).toContain('"apply_reservation_discount"');
    expect(dialog).not.toContain('from("reservation_discounts").insert');
    expect(dialog).not.toContain('from("reservation_charges").insert');
  });

  it("sends one request id per dialog session so a double submit applies once", () => {
    expect(dialog).toContain("useState<string>(() => crypto.randomUUID())");
    expect(dialog).toContain("_request_id: requestId");
    // Regenerated only on close, never between the click and the call.
    const onClick = dialog.slice(dialog.indexOf("onClick={async () => {"));
    expect(onClick.slice(0, onClick.indexOf("apply_reservation_discount"))).not.toContain(
      "setRequestId(crypto.randomUUID())",
    );
    expect(dialog).toContain("setRequestId(crypto.randomUUID())");
  });
});

describe("folio summary distinguishes the four figures", () => {
  it("shows Charges, Discounts, Paid and Balance separately", () => {
    expect(page).toContain('<SummaryLine label="Charges" value={grossCharges}');
    expect(page).toContain('<SummaryLine label="Discounts" value={totalDiscount}');
    expect(page).toContain('<SummaryLine label="Paid" value={totalPaid}');
    expect(page).toContain('<SummaryLine label="Balance" value={balance}');
  });

  it("shows the gross, so the discount is a visible reduction rather than a netted-away number", () => {
    expect(page).toContain("const grossCharges = totalCharges + totalDiscount;");
    expect(page).toContain('d.status === "active"');
  });

  it("renders the discount as a signed negative value", () => {
    expect(page).toContain("negative && value > 0 ? `-${formatMoney(value, currency)}`");
  });
});
