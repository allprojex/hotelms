import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression cover for the residual document-level horizontal overflow left
// after PR #88.
//
// PR #88 clamped the authenticated shell column (`flex min-w-0 flex-1
// flex-col` in _authenticated/route.tsx), which removed all POS-specific
// overflow: measured on production at 336bb7d, /analytics/pos and /dashboard
// both reported documentElement.scrollWidth 440 against clientWidth 360 --
// identical, so nothing was POS's fault any more.
//
// The remaining 80px (375px) / 65px (390px) came from the top bar itself. The
// row is a flex item with the default min-width:auto, and the property
// switcher is a fixed 220px control, so the row measured 404px inside a 360px
// viewport on EVERY authenticated page. Hiding <main> entirely still produced
// scrollWidth 440, which proves the header alone caused it. Setting
// min-width:0 on the row, the property group and the trigger took the
// document from 440 to 360 and reverting restored 440.

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
const topbar = read("src/components/top-bar.tsx");
// The comments explain the fix and name the classes involved, so strip them
// before asserting on what the markup actually applies.
const topbarCode = topbar.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const shell = read("src/routes/_authenticated/route.tsx");

describe("top bar — narrow-viewport shrinkability", () => {
  it("lets the top bar row shrink below its content width", () => {
    expect(topbar).toContain('className="flex min-w-0 flex-1 items-center justify-between gap-3"');
  });

  it("lets the property group shrink", () => {
    expect(topbar).toContain('className="flex min-w-0 items-center gap-3"');
  });

  it("lets the property switcher give ground", () => {
    expect(topbar).toContain('className="h-8 w-[220px] min-w-0"');
  });

  it("keeps 220px as the switcher's preferred width rather than removing it", () => {
    // The fix must not shrink the control on desktop, where there is room.
    expect(topbar).toMatch(/w-\[220px\]/);
  });

  it("relies on the existing shadcn truncation rather than adding its own", () => {
    // SelectTrigger already ships [&>span]:line-clamp-1, which is what makes
    // a long property name ellipsize once the trigger is allowed to shrink.
    expect(topbarCode).not.toMatch(/truncate|text-ellipsis|line-clamp/);
  });

  it("solves it by shrinking, not by hiding or clipping the page", () => {
    expect(topbarCode).not.toMatch(/overflow-hidden|overflow-x-hidden/);
    // No breakpoint-hiding of header controls -- they stay reachable on a phone.
    expect(topbar).not.toMatch(/\bhidden\s+(sm|md|lg|xl):(flex|block|inline|grid)/);
  });

  it("keeps every header control mounted", () => {
    for (const control of ["GlobalSearch", "SelectTrigger"]) {
      expect(topbar).toContain(control);
    }
  });
});

describe("authenticated shell — PR #88's clamp is still present", () => {
  it("keeps the shell column shrinkable", () => {
    // Without this, the top-bar change alone cannot help: the column's
    // min-width:auto would still stretch the document.
    expect(shell).toContain("flex min-w-0 flex-1 flex-col");
  });

  it("needs no min-w-0 on <main> itself", () => {
    // Measured: main's width already equalled clientWidth at 375/390/768/
    // 1024/1440, so <main> was never the blocker and is left untouched.
    expect(shell).toContain('<main className="flex-1 p-4 sm:p-6">');
  });
});
