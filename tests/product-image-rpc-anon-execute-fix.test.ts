import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const fix = readFileSync(
  resolve(root, "supabase/migrations/20260812160000_product_image_rpc_anon_execute_fix.sql"),
  "utf8",
);

describe("product-images RPC anon-execute ACL hotfix", () => {
  it("explicitly revokes anon execute from the rate-limit RPC — REVOKE ALL FROM PUBLIC alone does not remove Supabase's default direct grant to anon", () => {
    expect(fix).toContain(
      "REVOKE EXECUTE ON FUNCTION public.count_recent_product_image_generations() FROM anon;",
    );
  });

  it("explicitly revokes both anon and authenticated execute from the two service_role-only seed functions", () => {
    expect(fix).toContain(
      "REVOKE EXECUTE ON FUNCTION public.seed_product_image_permissions(uuid) FROM anon, authenticated;",
    );
    expect(fix).toContain(
      "REVOKE EXECUTE ON FUNCTION public.seed_product_image_permissions_for_property() FROM anon, authenticated;",
    );
  });

  it("does not re-grant authenticated on the rate-limit RPC here — that grant already exists from the original migration and is left untouched", () => {
    expect(fix).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.count_recent_product_image_generations/);
  });

  it("does not touch any other function's privileges", () => {
    const revokeLines = fix.match(/^REVOKE EXECUTE ON FUNCTION [^\n]+$/gm) ?? [];
    expect(revokeLines).toHaveLength(3);
    for (const line of revokeLines) {
      expect(line).toMatch(
        /count_recent_product_image_generations|seed_product_image_permissions/,
      );
    }
  });
});
