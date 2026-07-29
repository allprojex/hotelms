import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const sidebar = readFileSync("src/components/ui/sidebar.tsx", "utf8");
const appSidebar = readFileSync("src/components/app-sidebar.tsx", "utf8");

describe("navigation foundation", () => {
  it("defines Deep Sea Blue defaults and explicit branding override tokens", () => {
    expect(styles).toContain("--nav-brand-background:");
    expect(styles).toContain("--nav-brand-foreground:");
    expect(styles).toContain("--nav-brand-accent:");
    expect(styles).toContain("--sidebar: var(--nav-brand-background)");
    expect(styles).toContain("--sidebar-ring: var(--nav-brand-accent)");
  });

  it("retains desktop, collapsed, mobile, active, and keyboard focus states", () => {
    expect(sidebar).toContain('data-mobile="true"');
    expect(sidebar).toContain('state: "expanded" | "collapsed"');
    expect(sidebar).toContain("data-[active=true]:bg-sidebar-accent");
    expect(sidebar).toContain("focus-visible:ring-2");
    expect(sidebar).toContain("SIDEBAR_KEYBOARD_SHORTCUT");
  });

  it("retains permission-hidden routes and the established hierarchy", () => {
    expect(appSidebar).toContain(".filter((it) => canSee(it.requireRoles))");
    expect(appSidebar).toContain('label: "Front Office"');
    expect(appSidebar).toContain('label: "Point of Sale"');
    expect(appSidebar).toContain('label: "Administration"');
    expect(appSidebar).not.toContain('label: "HRM"');
  });
});
