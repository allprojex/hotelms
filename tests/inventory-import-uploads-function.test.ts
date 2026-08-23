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
    expect(source).not.toMatch(
      /up\.target_kind === "inventory" \|\| up\.target_kind === "product"/,
    );
    expect(source).toContain('} else if (up.target_kind === "inventory") {');
  });

  it("re-validates every row server-side via the shared validateInventoryImportBatch, never trusting client-only validation", () => {
    expect(source).toContain(
      'import { validateInventoryImportBatch } from "@/lib/inventory/import-validation";',
    );
    expect(source).toMatch(/const batch = validateInventoryImportBatch\(/);
  });

  it("re-fetches existing SKUs and locations fresh at approve time rather than reusing any stale queue-time snapshot", () => {
    expect(source).toMatch(
      /\(supabase\.from\("inventory_items"\) as any\)\.select\("sku"\)\.eq\("property_id", data\.propertyId\)/,
    );
    expect(source).toMatch(
      /\(supabase\.from\("stock_locations"\) as any\)\.select\("name"\)\.eq\("property_id", data\.propertyId\)/,
    );
  });

  it("calls the WHOLE-BATCH RPC exactly once per approve, not once per row -- this is the actual atomicity fix", () => {
    expect(source).toContain('(context.supabase.rpc as any)("import_inventory_items", {');
    expect(source).not.toContain('"import_inventory_item"'); // the old per-row RPC name, singular, must not be called directly anymore
    expect(source).toContain(
      "_property_id: data.propertyId, _rows: payload, _duplicate_mode: duplicateMode",
    );
  });

  it("sends the whole candidate set as one JSONB array built from the validated rows, not raw payload fields", () => {
    const start = source.indexOf("const payload = candidates.map(");
    const end = source.indexOf(");", start);
    const body = source.slice(start, end);
    for (const field of [
      "name:",
      "sku:",
      "category:",
      "unit:",
      "cost:",
      "sale_price:",
      "reorder_level:",
      "location:",
      "opening_quantity:",
      "expiry_date:",
    ]) {
      expect(body).toContain(field);
    }
  });

  it("a row the RPC reports as skipped (duplicate) is recorded as skipped, not counted as imported", () => {
    expect(source).toMatch(/results\[i\]\?\.skipped/);
  });
});

describe("approveUpload — whole-batch atomicity: an unexpected RPC failure marks every candidate row failed, never partially-imported (client requirement: rollback on failure)", () => {
  it("catches the bulk RPC call in its own try/catch, separate from the per-row loop that follows a success", () => {
    expect(source).toMatch(
      /try \{\s*\n\s*const \{ data: bulkResult, error: bulkError \} = await \(context\.supabase\.rpc as any\)\("import_inventory_items"/,
    );
    expect(source).toContain("} catch (bulkErr: any) {");
  });

  it("on failure, every candidate row (not just the one that triggered it) is marked as an error -- none silently stay pending or get marked imported", () => {
    const start = source.indexOf("} catch (bulkErr: any) {");
    const end = source.indexOf("throw new Error(msg);", start);
    const body = source.slice(start, end);
    expect(body).toMatch(/for \(const \{ r \} of candidates\)/);
    expect(body).toContain('status: "error"');
  });

  it("on failure, the upload itself is finalized as rejected BEFORE rethrowing -- the audit record must say the import failed, never completed", () => {
    const start = source.indexOf("} catch (bulkErr: any) {");
    const throwIdx = source.indexOf("throw new Error(msg);", start);
    const updateIdx = source.indexOf('status: "rejected"', start);
    expect(updateIdx).toBeGreaterThan(start);
    expect(updateIdx).toBeLessThan(throwIdx); // finalized before the rethrow, not after
  });

  it("a whole-batch failure rethrows so the generic imported/errors finalizer at the bottom of the handler never overwrites this rejection with 'imported'", () => {
    const start = source.indexOf("} catch (bulkErr: any) {");
    const body = source.slice(start, start + 1400);
    expect(body).toContain("throw new Error(msg);");
  });
});

describe("approveUpload — an in-file duplicate SKU is filtered out before the atomic call, not sent alongside the row it duplicates", () => {
  it("in-file duplicates are marked skipped_duplicate in the same pass that builds `candidates`, and never appear in the payload sent to the RPC", () => {
    const start = source.indexOf("const candidates: { r: any; v:");
    const rpcCallIdx = source.indexOf('"import_inventory_items"', start);
    const inFileDupIdx = source.indexOf("v.isDuplicateInFile", start);
    expect(inFileDupIdx).toBeGreaterThan(start);
    expect(inFileDupIdx).toBeLessThan(rpcCallIdx);
  });
});

describe("approveUpload — duplicate policy: create / skip / reject, never silent overwrite (test 12)", () => {
  it("reads duplicateMode from the upload's own stored summary, defaulting to skip", () => {
    expect(source).toMatch(
      /const duplicateMode = up\.summary\?\.duplicateMode === "reject" \? "reject" : "skip";/,
    );
  });

  it("reject mode aborts the whole import before the RPC is ever called when any in-property duplicate is found (JS-level fast path; the RPC itself re-checks authoritatively too)", () => {
    const start = source.indexOf(
      'duplicateMode === "reject" && batch.totals.duplicateInProperty > 0',
    );
    expect(start).toBeGreaterThan(-1);
    const rejectBlock = source.slice(start, start + 700);
    expect(rejectBlock).toContain('status: "rejected"');
    expect(rejectBlock).toContain("throw new Error(message)");
    // The JS-level reject pre-check must appear strictly before the bulk RPC call.
    const rpcCallIndex = source.indexOf('"import_inventory_items"');
    expect(start).toBeLessThan(rpcCallIndex);
  });

  it("reject mode is passed through to the RPC too, as the authoritative race-safe check (never mutates zero-vs-nonzero based on a stale client read alone)", () => {
    expect(source).toContain("_duplicate_mode: duplicateMode");
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
