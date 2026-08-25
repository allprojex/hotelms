// @vitest-environment jsdom
//
// PRODUCTION BUG: openPrintView() called window.open("", "_blank",
// "noopener,width=1024,height=768"). Including "noopener" in the FEATURES
// STRING of window.open() makes the call itself return null -- the caller
// is deliberately given no reference to a window it has no opener link to.
// That's fatal here: this helper needs the returned Window to write the
// report HTML into it and (via the popup's own inline script) call print().
// With window.open() returning null, `if (!w) return` fired every time and
// the popup stayed blank -- confirmed live in production for the Expenses,
// P&L, Balance Sheet, and Trial Balance reports.
//
// The fix drops "noopener" from the features string and instead severs the
// back-reference AFTER obtaining the handle (`w.opener = null`), which
// achieves the same defensive goal without breaking the return value.
//
// This file proves the fix behaviorally, not by grepping for the absence of
// the word "noopener": the mock below faithfully reproduces the real
// browser contract (return null when "noopener" appears in the features
// string, return a usable window object otherwise) and exercises the real,
// shipped openPrintView() against it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPrintView } from "@/lib/admin/print-html";

function makeFakeOpen() {
  const fakeWindow = {
    document: { write: vi.fn(), close: vi.fn() },
    opener: { real: "the-original-opening-page" },
  } as unknown as Window;
  const openSpy = vi.fn((_url?: string, _target?: string, features?: string) => {
    if (features && /(?:^|,)\s*noopener\s*(?:,|$)/i.test(features)) return null;
    return fakeWindow;
  });
  return { openSpy, fakeWindow: fakeWindow as unknown as { document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }; opener: unknown } };
}

describe("openPrintView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("obtains a usable popup window and writes the report into it, against a mock that faithfully returns null for noopener exactly like real browsers", () => {
    const { openSpy, fakeWindow } = makeFakeOpen();
    window.open = openSpy as unknown as typeof window.open;

    openPrintView({
      title: "Trial Balance",
      subtitle: "2026-08-01 to 2026-08-31",
      bodyHtml: "<table><tbody><tr><td>1000</td></tr></tbody></table>",
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [, , features] = openSpy.mock.calls[0];
    expect(features).not.toMatch(/noopener/i);

    expect(fakeWindow.document.write).toHaveBeenCalledTimes(1);
    const written = fakeWindow.document.write.mock.calls[0][0] as string;
    expect(written).toContain("Trial Balance");
    expect(written).toContain("2026-08-01 to 2026-08-31");
    expect(written).toContain("<table><tbody><tr><td>1000</td></tr></tbody></table>");
    expect(fakeWindow.document.close).toHaveBeenCalledTimes(1);
  });

  it("triggers print() via the popup's own load handler -- the generated HTML contains the call that fires once the browser parses it", () => {
    const { openSpy, fakeWindow } = makeFakeOpen();
    window.open = openSpy as unknown as typeof window.open;

    openPrintView({ title: "P&L", bodyHtml: "<table></table>" });

    const written = fakeWindow.document.write.mock.calls[0][0] as string;
    expect(written).toMatch(/addEventListener\('load'.*window\.print\(\)/);
  });

  it("severs the back-reference to the opener AFTER obtaining the handle, not through the (broken) features string", () => {
    const { openSpy, fakeWindow } = makeFakeOpen();
    window.open = openSpy as unknown as typeof window.open;

    expect(fakeWindow.opener).not.toBeNull();
    openPrintView({ title: "T", bodyHtml: "<p>x</p>" });
    expect(fakeWindow.opener).toBeNull();
  });

  it("escapes a malicious title/subtitle before writing them into the popup -- existing XSS protection is untouched by this fix", () => {
    const { openSpy, fakeWindow } = makeFakeOpen();
    window.open = openSpy as unknown as typeof window.open;

    openPrintView({
      title: "<img src=x onerror=alert(1)>",
      subtitle: '"><script>alert(2)</script>',
      bodyHtml: "<table></table>",
    });

    const written = fakeWindow.document.write.mock.calls[0][0] as string;
    expect(written).not.toContain("<img src=x onerror=alert(1)>");
    expect(written).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(written).not.toContain("<script>alert(2)</script>");
  });

  it("fails safely, without throwing, when the popup is blocked and window.open returns null", () => {
    window.open = vi.fn(() => null) as unknown as typeof window.open;
    expect(() => openPrintView({ title: "T", bodyHtml: "<p>x</p>" })).not.toThrow();
  });

  it("regression proof: the mock's own contract shows exactly why the shipped bug broke every report — a features string containing noopener returns null, so the previous \"noopener,width=1024,height=768\" call would have made every assertion above fail with zero document.write calls", () => {
    const { openSpy, fakeWindow } = makeFakeOpen();
    expect(openSpy("", "_blank", "noopener,width=1024,height=768")).toBeNull();
    expect(openSpy("", "_blank", "width=1024,height=768")).toBe(fakeWindow);
  });
});
