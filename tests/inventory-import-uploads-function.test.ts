import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-convention tests (no server-function mock harness in this repo --
// see tests/inventory-batch-ui.test.ts's header for the established
// precedent of pinning route/handler-file source against a fixed set of
// safety-critical patterns) for the inventory-import branch added to
// approveUpload() in src/lib/uploads.functions.ts.

const source = readFileSync(resolve(__dirname, "../src/lib/uploads.functions.ts"), "utf8");

describe("approveUpload — double-submit / replay protection (test 17)", () => {
  it("claims the upload atomically (conditional UPDATE on status='pending') instead of a plain select-then-check", () => {
    expect(source).toMatch(
      /\.update\(\{ status: "processing" \}\)\s*\n\s*\.eq\("id", data\.uploadId\)\.eq\("status", "pending"\)/,
    );
    expect(source).not.toMatch(/\.select\("\*"\)\.eq\("id", data\.uploadId\)\.single\(\)/);
  });

  it("a failed claim (already processed by a concurrent request) throws before any row is touched", () => {
    expect(source).toContain("if (!claimed) throw new Error(");
  });
});

describe("approveUpload — product target kind is completely unchanged (test 23: existing behavior preserved)", () => {
  it("still does a plain client-driven insert into inventory_items for 'product', not the new RPC", () => {
    const start = source.indexOf('up.target_kind === "product"');
    const end = source.indexOf('} else if (up.target_kind === "inventory")', start);
    const body = source.slice(start, end);
    expect(body).toContain('await (supabase.from("inventory_items") as any).insert({');
    expect(body).not.toContain("import_inventory_item");
  });
});

describe("approveUpload — inventory target kind uses the guarded atomic RPC (test 2/3/16)", () => {
  it("is a separate branch from 'product', never combined again", () => {
    expect(source).not.toMatch(/up\.target_kind === "inventory" \|\| up\.target_kind === "product"/);
    expect(source).toContain('} else if (up.target_kind === "inventory") {');
  });

  it("re-validates every row server-side via the shared validateInventoryImportBatch, never trusting client-only validation", () => {
    expect(source).toContain('import { validateInventoryImportBatch } from "@/lib/inventory/import-validation";');
    expect(source).toMatch(/const batch = validateInventoryImportBatch\(/);
  });

  it("re-fetches existing SKUs and locations fresh at approve time rather than reusing any stale queue-time snapshot", () => {
    expect(source).toMatch(/\(supabase\.from\("inventory_items"\) as any\)\.select\("sku"\)\.eq\("property_id", data\.propertyId\)/);
    expect(source).toMatch(/\(supabase\.from\("stock_locations"\) as any\)\.select\("name"\)\.eq\("property_id", data\.propertyId\)/);
  });

  it("calls the RPC with all ten parameters mapped from the validated row, not raw payload fields", () => {
    expect(source).toContain('(context.supabase.rpc as any)("import_inventory_item", {');
    for (const p of [
      "_property_id", "_name", "_sku", "_category", "_unit",
      "_cost", "_sale_price", "_reorder_level", "_location_name", "_opening_quantity", "_expiry_date",
    ]) {
      expect(source).toContain(`${p}:`);
    }
  });

  it("a row the RPC reports as skipped (duplicate) is recorded as skipped, not counted as imported", () => {
    expect(source).toMatch(/\(rpcResult as any\)\?\.skipped/);
  });
});

describe("approveUpload — duplicate policy: create / skip / reject, never silent overwrite (test 12)", () => {
  it("reads duplicateMode from the upload's own stored summary, defaulting to skip", () => {
    expect(source).toMatch(/const duplicateMode = up\.summary\?\.duplicateMode === "reject" \? "reject" : "skip";/);
  });

  it("reject mode aborts the whole import before calling the RPC for any row when any in-property duplicate is found", () => {
    const start = source.indexOf('duplicateMode === "reject" && batch.totals.duplicateInProperty > 0');
    expect(start).toBeGreaterThan(-1);
    const rejectBlock = source.slice(start, start + 700);
    expect(rejectBlock).toContain('status: "rejected"');
    expect(rejectBlock).toContain("throw new Error(message)");
    // The reject path must appear strictly before the per-row RPC loop.
    const loopIndex = source.indexOf("for (let i = 0; i < eligibleRows.length; i++)");
    expect(start).toBeLessThan(loopIndex);
  });

  it("never issues an UPDATE against inventory_items in the approve handler (no silent overwrite path exists at all)", () => {
    expect(source).not.toMatch(/supabase\.from\("inventory_items"\)\.update\(/);
  });
});

describe("createUpload — inventory-specific duplicate key is SKU-only, not the generic name/code fallback", () => {
  it("uses r.sku for inventory rows so two different-SKU rows sharing a name are never misflagged as duplicates", () => {
    expect(source).toMatch(
      /data\.targetKind === "inventory"\s*\n\s*\? String\(r\.sku \?\? ""\)\.trim\(\)\.toLowerCase\(\)/,
    );
  });

  it("persists the chosen duplicateMode onto the upload's summary for approveUpload to read later", () => {
    expect(source).toMatch(/duplicateMode: data\.duplicateMode \?\? "skip"/);
  });
});
