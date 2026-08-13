import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
// Normalizes CRLF -> LF so literal multi-line `.toContain()` assertions
// don't depend on the working tree's checkout line-ending state.
function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const settingsRoute = read(
  resolve(root, "src/routes/_authenticated/inventory.settings.tsx"),
);
const imageField = read(resolve(root, "src/components/inventory/product-image-field.tsx"));

/**
 * PR #25 wired AI product image generation into InventoryModule
 * (src/components/admin/modules/inventory-module.tsx), which only renders
 * from the generic /admin panel. The actual sidebar-linked "Inventory ->
 * Items & Setup" page (/inventory/settings) has its own, completely
 * separate ItemDialog component that was never touched, so the feature was
 * unreachable from the primary Add/Edit Item surface real users navigate
 * to. This file pins the fix: the same ProductImageField integration now
 * exists on both surfaces.
 */
describe("Items & Setup (/inventory/settings) renders the AI product image feature", () => {
  it("imports ProductImageField", () => {
    expect(settingsRoute).toContain(
      'import {\n  ProductImageField,\n  type ProductImageFieldHandle,\n  type ProductImageSelection,\n} from "@/components/inventory/product-image-field";',
    );
  });

  it("renders ProductImageField inside ItemDialog, wired to the same propertyId/itemId/initialImagePath contract used elsewhere", () => {
    const itemDialog = settingsRoute.match(/function ItemDialog\([\s\S]*?\n\}/)?.[0];
    expect(itemDialog).toBeDefined();
    expect(itemDialog).toContain("<ProductImageField");
    expect(itemDialog).toContain("ref={imageFieldRef}");
    expect(itemDialog).toContain("propertyId={propertyId}");
    expect(itemDialog).toContain("itemId={existing?.id ?? null}");
    expect(itemDialog).toContain("initialImagePath={existing?.image_path ?? null}");
    expect(itemDialog).toContain("onChange={setImageSelection}");
  });

  it("remounts ProductImageField on every dialog open (key toggles closed/open), so a cancelled session's AI preview never leaks into the next open", () => {
    const itemDialog = settingsRoute.match(/function ItemDialog\([\s\S]*?\n\}/)?.[0]!;
    expect(itemDialog).toContain('key={open ? (existing?.id ?? "new") : "closed"}');
  });

  it("only adds image_path/image_source/image_updated_at to the save payload when the user made an explicit selection, never unconditionally", () => {
    const saveFn = settingsRoute.match(/async function save\(\)[\s\S]*?\n {2}\}/)?.[0];
    expect(saveFn).toBeDefined();
    expect(saveFn).toMatch(/if\s*\(imageSelection\)\s*\{\s*\n\s*payload\.image_path/);
  });

  it("cleans up a dangling unapplied AI preview after a successful save, keeping the actually-selected/saved image", () => {
    const saveFn = settingsRoute.match(/async function save\(\)[\s\S]*?\n {2}\}/)?.[0]!;
    expect(saveFn).toContain(
      "imageFieldRef.current?.cleanupUnsaved(imageSelection?.path ?? existing?.image_path ?? null);",
    );
    // must run after the write succeeds, not before
    expect(saveFn.indexOf("if (error) return toast.error")).toBeLessThan(
      saveFn.indexOf("cleanupUnsaved"),
    );
  });

  it("drops any unsaved temp image on Cancel/Escape/overlay-close, but never deletes the pre-existing saved image", () => {
    const onOpenChange = settingsRoute.match(/onOpenChange=\{\(v\) => \{[\s\S]*?\n {6}\}\}/)?.[0];
    expect(onOpenChange).toBeDefined();
    expect(onOpenChange).toContain("imageFieldRef.current?.cleanupUnsaved(existing?.image_path ?? null);");
    expect(onOpenChange).toContain("setImageSelection(null);");
  });

  it("still preserves the normal item fields (SKU/name/category/unit/cost/price/reorder) — the fix is additive, not a rewrite", () => {
    for (const field of ["sku", "name", "category_id", "unit", "cost", "sale_price", "reorder_level"]) {
      expect(settingsRoute).toContain(`f.${field}`);
    }
  });

  it("does not introduce a second, divergent permission check — it reuses ProductImageField exactly as-is, so unauthorized-user hiding (usePermission/canManageImages) is inherited unchanged", () => {
    expect(settingsRoute).not.toMatch(/usePermission|PRODUCT_IMAGE_PERMISSIONS|PRODUCT_MANAGEMENT_ROLES/);
    expect(imageField).toContain("usePermission");
    expect(imageField).toMatch(/canManageImages\s*\?/);
  });
});
